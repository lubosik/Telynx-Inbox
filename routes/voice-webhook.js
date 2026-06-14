const router = require('express').Router();
const { supabase } = require('../db');
const { broadcast } = require('../lib/broadcaster');
const { normalisePhone } = require('../lib/phone');
const { sendPushToAll } = require('../push-notify');
const { answerCall, speakOnCall, transferCall } = require('../lib/telnyx-api');

// ─── Supabase v2 helpers — query builder is NOT a native Promise, no .catch() ──
async function dbUpsert(values, options = {}) {
  try {
    const { error } = await supabase.from('call_logs').upsert(values, options);
    if (error) console.error('[VOICE] DB upsert error:', error.message);
  } catch (e) { console.error('[VOICE] DB upsert threw:', e.message); }
}
async function dbUpdate(values, callControlId) {
  try {
    const { error } = await supabase.from('call_logs').update(values).eq('call_control_id', callControlId);
    if (error) console.error('[VOICE] DB update error:', error.message);
  } catch (e) { console.error('[VOICE] DB update threw:', e.message); }
}

router.post('/', async (req, res) => {
  res.sendStatus(200);
  console.log('[VOICE] Webhook received');

  try {
    const raw = req.body;
    let body;
    try {
      body = Buffer.isBuffer(raw)
        ? JSON.parse(raw.toString() || '{}')
        : (typeof raw === 'object' ? raw : JSON.parse(String(raw) || '{}'));
    } catch (e) {
      console.error('[VOICE] Parse error:', e.message);
      return;
    }

    const event = body?.data;
    if (!event) return;

    const { event_type, payload } = event;
    const cid = payload?.call_control_id;
    const from = payload?.from;
    const to = payload?.to;

    const rawDir = payload?.direction;
    const direction = rawDir === 'incoming' ? 'inbound'
                    : rawDir === 'outgoing' ? 'outbound'
                    : rawDir;
    const contactPhone = normalisePhone(direction === 'inbound' ? from : to)
      || (direction === 'inbound' ? from : to);

    console.log(`[VOICE] ${event_type} dir=${direction} cid=...${cid?.slice(-6)} phone=...${contactPhone?.slice(-4)}`);

    switch (event_type) {

      case 'call.initiated': {
        // Write DB row first so call.answered has a row to update
        await dbUpsert({
          call_control_id: cid,
          call_leg_id: payload?.call_leg_id,
          call_session_id: payload?.call_session_id,
          direction: direction || 'inbound',
          contact_phone: contactPhone,
          from_number: from,
          to_number: to,
          status: 'initiated',
          started_at: payload?.start_time || new Date().toISOString()
        }, { onConflict: 'call_control_id' });

        if (direction !== 'inbound') break;

        // Caller name lookup
        let callerName = null;
        try {
          const { data } = await supabase.from('sms_contacts')
            .select('first_name, last_name, name').eq('phone', contactPhone).maybeSingle();
          if (data) callerName = `${data.first_name || ''} ${data.last_name || ''}`.trim() || data.name || null;
        } catch (_) {}

        // Push notification — fires BEFORE answerCall so user always gets notified
        sendPushToAll({
          type: 'incoming_call',
          title: 'Incoming Call',
          body: `${callerName || contactPhone} is calling`,
          url: '/?call=incoming',
          caller_phone: contactPhone,
          caller_name: callerName
        }).catch(e => console.error('[VOICE] Push error:', e.message));

        broadcast({ type: 'call_update', event: 'initiated', call_control_id: cid, direction: 'inbound', contact_phone: contactPhone });

        // Answer the call
        try {
          await answerCall(cid);
          console.log('[VOICE] Call answered OK');
        } catch (e) {
          console.error('[VOICE] answerCall failed:', e.message);
          await dbUpdate({ status: 'failed', ended_at: new Date().toISOString() }, cid);
          break;
        }

        // Speak greeting, then transfer on speak.ended
        try {
          await speakOnCall(cid, "Please hold, we're connecting your call.");
          console.log('[VOICE] Greeting started');
        } catch (e) {
          console.error('[VOICE] speakOnCall failed:', e.message);
          // If speak fails, transfer immediately
          const sipTarget = `sip:${process.env.TELNYX_SIP_USERNAME}@sip.telnyx.com`;
          try { await transferCall(cid, sipTarget, process.env.TELNYX_PHONE_NUMBER); }
          catch (te) { console.error('[VOICE] Immediate transfer failed:', te.message); }
        }
        break;
      }

      // When greeting finishes, transfer to Dom's SIP
      case 'call.speak.ended': {
        console.log('[VOICE] Greeting ended — transferring to SIP');
        const sipTarget = `sip:${process.env.TELNYX_SIP_USERNAME}@sip.telnyx.com`;
        try {
          await transferCall(cid, sipTarget, process.env.TELNYX_PHONE_NUMBER);
          console.log('[VOICE] Transfer initiated to', sipTarget);
        } catch (e) {
          console.error('[VOICE] Transfer failed:', e.message);
        }
        break;
      }

      case 'call.answered':
        console.log('[VOICE] call.answered');
        await dbUpdate({ status: 'answered', answered_at: new Date().toISOString() }, cid);
        broadcast({ type: 'call_update', event: 'answered', call_control_id: cid });
        break;

      case 'call.hangup': {
        let log = null;
        try {
          const { data } = await supabase.from('call_logs')
            .select('answered_at, direction, contact_phone').eq('call_control_id', cid).maybeSingle();
          log = data;
        } catch (_) {}

        const wasAnswered = !!(log?.answered_at);
        const wasInbound = (log?.direction || direction) === 'inbound';
        const duration = wasAnswered ? Math.floor((Date.now() - new Date(log.answered_at).getTime()) / 1000) : 0;
        const finalStatus = wasAnswered ? 'completed' : wasInbound ? 'missed' : 'failed';

        console.log(`[VOICE] call.hangup — ${finalStatus} (${duration}s)`);
        await dbUpdate({ status: finalStatus, duration_seconds: duration, ended_at: new Date().toISOString() }, cid);
        broadcast({ type: 'call_update', event: 'hangup', call_control_id: cid, status: finalStatus, duration });

        if (finalStatus === 'missed') {
          const missedPhone = log?.contact_phone || contactPhone;
          let missedName = null;
          try {
            const { data: mc } = await supabase.from('sms_contacts')
              .select('first_name, last_name, name').eq('phone', missedPhone).maybeSingle();
            if (mc) missedName = `${mc.first_name || ''} ${mc.last_name || ''}`.trim() || mc.name || null;
          } catch (_) {}
          sendPushToAll({ type: 'missed_call', title: 'Missed Call', body: `Missed call from ${missedName || missedPhone || from}`, url: '/?tab=voice', caller_phone: missedPhone, caller_name: missedName }).catch(() => {});
        }
        break;
      }

      case 'call.recording.saved':
        await dbUpdate({
          recording_id: payload?.recording_id,
          recording_url_mp3: payload?.recording_urls?.mp3,
          recording_url_wav: payload?.recording_urls?.wav
        }, cid);
        break;
    }

  } catch (err) {
    console.error('[VOICE] Unhandled error:', err.message, err.stack?.split('\n')[1]);
  }
});

module.exports = router;
