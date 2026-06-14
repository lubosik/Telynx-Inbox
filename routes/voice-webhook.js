const router = require('express').Router();
const { supabase } = require('../db');
const { broadcast } = require('../lib/broadcaster');
const { normalisePhone } = require('../lib/phone');
const { sendPushToAll } = require('../push-notify');
const { answerCall, speakOnCall, transferCall, playAudioOnCall, stopAudioOnCall } = require('../lib/telnyx-api');
const pendingCalls = require('../lib/pending-calls');

const HOLD_MUSIC_URL = 'https://audionautix.com/Music/CloserToJazz.mp3';

// Supabase v2 query builders are NOT native Promises — no .catch().
// Always use try/catch or destructure { error } from await.
async function dbUpsert(table, values, options) {
  try { await supabase.from(table).upsert(values, options); } catch (e) { console.error(`[VOICE] DB upsert ${table}:`, e.message); }
}
async function dbUpdate(table, values, matchCol, matchVal) {
  try { await supabase.from(table).update(values).eq(matchCol, matchVal); } catch (e) { console.error(`[VOICE] DB update ${table}:`, e.message); }
}

router.post('/', async (req, res) => {
  res.sendStatus(200);

  // Log immediately so Railway shows if Telnyx webhook is arriving
  console.log(`[VOICE] Webhook hit — bodyType=${Buffer.isBuffer(req.body) ? `Buffer(${req.body.length})` : typeof req.body}`);

  try {
    const raw = req.body;
    let body;
    try {
      body = Buffer.isBuffer(raw)
        ? JSON.parse(raw.toString() || '{}')
        : (typeof raw === 'object' ? raw : JSON.parse(String(raw) || '{}'));
    } catch (parseErr) {
      console.error('[VOICE] Body parse error:', parseErr.message);
      return;
    }

    const event = body?.data;
    if (!event) return;

    const { event_type, payload } = event;
    const callControlId = payload?.call_control_id;
    const from = payload?.from;
    const to = payload?.to;

    const rawDir = payload?.direction;
    const direction = rawDir === 'incoming' ? 'inbound'
                    : rawDir === 'outgoing' ? 'outbound'
                    : rawDir;

    const contactPhone = normalisePhone(direction === 'inbound' ? from : to)
      || (direction === 'inbound' ? from : to);

    console.log(`[VOICE] ${event_type} | dir=${direction} | cid=...${callControlId?.slice(-8)} | phone=...${contactPhone?.slice(-4)}`);

    switch (event_type) {

      case 'call.initiated': {
        const isInbound = direction === 'inbound';

        // Write DB row FIRST — fixes race where call.answered arrives before the row exists
        await dbUpsert('call_logs', {
          call_control_id: callControlId,
          call_leg_id: payload?.call_leg_id,
          call_session_id: payload?.call_session_id,
          direction: direction || (isInbound ? 'inbound' : 'outbound'),
          contact_phone: contactPhone,
          from_number: from,
          to_number: to,
          status: 'initiated',
          started_at: payload?.start_time || new Date().toISOString()
        }, { onConflict: 'call_control_id' });

        if (!isInbound) break;

        // Look up caller name
        let callerName = null;
        try {
          const { data: contact } = await supabase
            .from('sms_contacts')
            .select('first_name, last_name, name')
            .eq('phone', contactPhone)
            .maybeSingle();
          if (contact) {
            callerName = `${contact.first_name || ''} ${contact.last_name || ''}`.trim() || contact.name || null;
          }
        } catch (e) {
          console.error('[VOICE] Contact lookup error:', e.message);
        }

        // Push BEFORE answering — user gets notified even if answer fails
        sendPushToAll({
          type: 'incoming_call',
          title: 'Incoming Call',
          body: `${callerName || contactPhone} is calling`,
          url: '/?call=incoming',
          caller_phone: contactPhone,
          caller_name: callerName
        }).catch(e => console.error('[VOICE] Push error:', e.message));

        broadcast({ type: 'call_update', event: 'initiated', call_control_id: callControlId, direction: 'inbound', contact_phone: contactPhone });

        // Answer the call
        try {
          await answerCall(callControlId);
          console.log(`[VOICE] Answered ...${contactPhone?.slice(-4)}`);
        } catch (e) {
          console.error('[VOICE] answerCall FAILED:', e.message);
          await dbUpdate('call_logs', { status: 'failed', ended_at: new Date().toISOString() }, 'call_control_id', callControlId);
          break;
        }

        // Register pending and speak greeting
        const sipTarget = `sip:${process.env.TELNYX_SIP_USERNAME}@sip.telnyx.com`;
        pendingCalls.set(callControlId, { contactPhone, sipTarget, stage: 1, transferTimer: null, clientReady: false });

        try {
          await speakOnCall(callControlId, "Please hold, we're connecting your call.");
        } catch (e) {
          console.error('[VOICE] speakOnCall FAILED:', e.message);
        }
        break;
      }

      case 'call.speak.ended': {
        const pending = pendingCalls.get(callControlId);
        if (!pending || pending.stage !== 1) break;

        pending.stage = 2;

        if (pending.clientReady) {
          pendingCalls.delete(callControlId);
          console.log(`[VOICE] Client ready — immediate transfer`);
          try { await transferCall(callControlId, pending.sipTarget, process.env.TELNYX_PHONE_NUMBER); }
          catch (e) { console.error('[VOICE] Immediate transfer failed:', e.message); }
          break;
        }

        try { await playAudioOnCall(callControlId, HOLD_MUSIC_URL); }
        catch (e) { console.error('[VOICE] Hold music failed:', e.message); }

        pending.transferTimer = setTimeout(async () => {
          const p = pendingCalls.get(callControlId);
          if (!p) return;
          pendingCalls.delete(callControlId);
          console.log(`[VOICE] Fallback timer — transferring`);
          try { await stopAudioOnCall(callControlId); } catch (_) {}
          try { await transferCall(callControlId, p.sipTarget, process.env.TELNYX_PHONE_NUMBER); }
          catch (e) { console.error('[VOICE] Fallback transfer failed:', e.message); }
        }, 15000);
        break;
      }

      case 'call.answered':
        console.log(`[VOICE] call.answered for ...${callControlId?.slice(-8)}`);
        await dbUpdate('call_logs', { status: 'answered', answered_at: new Date().toISOString() }, 'call_control_id', callControlId);
        broadcast({ type: 'call_update', event: 'answered', call_control_id: callControlId });
        break;

      case 'call.hangup': {
        const pending = pendingCalls.get(callControlId);
        if (pending?.transferTimer) clearTimeout(pending.transferTimer);
        if (pending?.stage === 2) { try { await stopAudioOnCall(callControlId); } catch (_) {} }
        pendingCalls.delete(callControlId);

        let log = null;
        try {
          const { data } = await supabase.from('call_logs').select('answered_at, direction, contact_phone').eq('call_control_id', callControlId).maybeSingle();
          log = data;
        } catch (e) { console.error('[VOICE] Hangup log lookup error:', e.message); }

        const wasAnswered = !!(log?.answered_at);
        const wasInbound = (log?.direction || direction) === 'inbound';
        const duration = wasAnswered ? Math.floor((Date.now() - new Date(log.answered_at).getTime()) / 1000) : 0;
        const finalStatus = wasAnswered ? 'completed' : wasInbound ? 'missed' : 'failed';

        console.log(`[VOICE] call.hangup — status=${finalStatus} duration=${duration}s`);
        await dbUpdate('call_logs', { status: finalStatus, duration_seconds: duration, ended_at: new Date().toISOString() }, 'call_control_id', callControlId);
        broadcast({ type: 'call_update', event: 'hangup', call_control_id: callControlId, status: finalStatus, duration });

        if (finalStatus === 'missed') {
          const missedPhone = log?.contact_phone || contactPhone;
          let missedName = null;
          try {
            const { data: mc } = await supabase.from('sms_contacts').select('first_name, last_name, name').eq('phone', missedPhone).maybeSingle();
            if (mc) missedName = `${mc.first_name || ''} ${mc.last_name || ''}`.trim() || mc.name || null;
          } catch (_) {}
          sendPushToAll({ type: 'missed_call', title: 'Missed Call', body: `Missed call from ${missedName || missedPhone || from}`, url: '/?tab=voice', caller_phone: missedPhone, caller_name: missedName }).catch(() => {});
        }
        break;
      }

      case 'call.recording.saved':
        await dbUpdate('call_logs', {
          recording_id: payload?.recording_id,
          recording_url_mp3: payload?.recording_urls?.mp3,
          recording_url_wav: payload?.recording_urls?.wav
        }, 'call_control_id', callControlId);
        broadcast({ type: 'call_recording_saved', call_control_id: callControlId, recording_url: payload?.recording_urls?.mp3 });
        break;
    }

  } catch (err) {
    console.error('[VOICE] Unhandled error:', err.message, err.stack?.split('\n')[1]);
  }
});

module.exports = router;
