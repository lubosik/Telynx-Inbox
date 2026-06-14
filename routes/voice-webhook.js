const router = require('express').Router();
const { supabase } = require('../db');
const { broadcast } = require('../lib/broadcaster');
const { normalisePhone } = require('../lib/phone');
const { sendPushToAll } = require('../push-notify');
const { answerCall, speakOnCall, transferCall, playAudioOnCall, stopAudioOnCall } = require('../lib/telnyx-api');

// Warm jazz hold music — CC-BY Jason Shaw (audionautix.com), public Cloudflare CDN
const HOLD_MUSIC_URL = 'https://audionautix.com/Music/CloserToJazz.mp3';

const pendingCalls = require('../lib/pending-calls');

router.post('/', async (req, res) => {
  res.sendStatus(200);

  try {
    const raw = req.body;
    const body = Buffer.isBuffer(raw)
      ? JSON.parse(raw.toString() || '{}')
      : (raw || {});
    const event = body?.data;
    if (!event) return;

    const { event_type, payload } = event;
    const callControlId = payload?.call_control_id;
    const from = payload?.from;
    const to = payload?.to;
    // Telnyx Call Control sends "incoming"/"outgoing"; normalise to "inbound"/"outbound"
    const rawDir = payload?.direction;
    const direction = rawDir === 'incoming' ? 'inbound'
                    : rawDir === 'outgoing' ? 'outbound'
                    : rawDir;

    const contactPhone = normalisePhone(direction === 'inbound' ? from : to)
      || (direction === 'inbound' ? from : to);

    console.log(`[VOICE-WEBHOOK] ${event_type} | call=${callControlId?.slice(-8)} | dir=${direction} | phone=...${contactPhone?.slice(-4)}`);

    switch (event_type) {

      // ── Inbound call arrives ─────────────────────────────────────────────
      case 'call.initiated': {
        if (direction !== 'inbound') {
          // Log outbound/transfer legs but don't try to answer them
          await supabase.from('call_logs').upsert({
            call_control_id: callControlId,
            call_leg_id: payload?.call_leg_id,
            call_session_id: payload?.call_session_id,
            direction,
            contact_phone: contactPhone,
            from_number: from,
            to_number: to,
            status: 'initiated',
            started_at: payload?.start_time || new Date().toISOString()
          }, { onConflict: 'call_control_id' }).catch(() => {});
          break;
        }

        // ANSWER FIRST — before any DB work, to avoid timeout
        await answerCall(callControlId);
        console.log(`[VOICE-WEBHOOK] Answered inbound call from ...${contactPhone?.slice(-4)}`);

        const sipTarget = `sip:${process.env.TELNYX_SIP_USERNAME}@sip.telnyx.com`;
        pendingCalls.set(callControlId, { contactPhone, sipTarget, stage: 1, transferTimer: null, clientReady: false });

        // Speak greeting, then music starts on call.speak.ended
        await speakOnCall(callControlId, "Please hold, we're connecting your call.")
          .catch(err => console.error('[VOICE-WEBHOOK] Speak failed:', err.message));

        // DB write + push happen in parallel after call is answered
        const { data: contact } = await supabase
          .from('sms_contacts')
          .select('first_name, last_name, name')
          .eq('phone', contactPhone)
          .maybeSingle();

        const callerName = contact
          ? `${contact.first_name || ''} ${contact.last_name || ''}`.trim() || contact.name
          : null;

        await Promise.all([
          supabase.from('call_logs').upsert({
            call_control_id: callControlId,
            call_leg_id: payload?.call_leg_id,
            call_session_id: payload?.call_session_id,
            direction: 'inbound',
            contact_phone: contactPhone,
            from_number: from,
            to_number: to,
            status: 'initiated',
            started_at: payload?.start_time || new Date().toISOString()
          }, { onConflict: 'call_control_id' }),
          sendPushToAll({
            type: 'incoming_call',
            title: 'Incoming Call',
            body: `${callerName || contactPhone} is calling`,
            url: '/?call=incoming',
            caller_phone: contactPhone,
            caller_name: callerName || null
          })
        ]).catch(err => console.error('[VOICE-WEBHOOK] DB/push error:', err.message));

        broadcast({
          type: 'call_update',
          event: 'initiated',
          call_control_id: callControlId,
          direction: 'inbound',
          contact_phone: contactPhone
        });
        break;
      }

      // ── Greeting speak done — start hold music, schedule SIP transfer ────
      case 'call.speak.ended': {
        const pending = pendingCalls.get(callControlId);
        if (!pending || pending.stage !== 1) break;

        pending.stage = 2;

        // If app already signalled ready during the speak, transfer now — no music needed
        if (pending.clientReady) {
          pendingCalls.delete(callControlId);
          console.log(`[VOICE-WEBHOOK] Client was ready during speak — transferring immediately for ...${pending.contactPhone?.slice(-4)}`);
          await transferCall(callControlId, pending.sipTarget, process.env.TELNYX_PHONE_NUMBER)
            .catch(err => console.error('[VOICE-WEBHOOK] Immediate transfer failed:', err.message));
          break;
        }

        // Otherwise start hold music and wait up to 15s for sip-ready or fallback timer
        await playAudioOnCall(callControlId, HOLD_MUSIC_URL)
          .catch(err => console.error('[VOICE-WEBHOOK] Hold music failed:', err.message));

        pending.transferTimer = setTimeout(async () => {
          const p = pendingCalls.get(callControlId);
          if (!p) return;
          pendingCalls.delete(callControlId);
          console.log(`[VOICE-WEBHOOK] Fallback timer — stopping music + transferring for ...${p.contactPhone?.slice(-4)}`);
          await stopAudioOnCall(callControlId).catch(() => {});
          await transferCall(callControlId, p.sipTarget, process.env.TELNYX_PHONE_NUMBER)
            .catch(err => console.error('[VOICE-WEBHOOK] Fallback transfer failed:', err.message));
        }, 15000);
        break;
      }

      // ── Call answered ────────────────────────────────────────────────────
      case 'call.answered':
        await supabase.from('call_logs')
          .update({ status: 'answered', answered_at: new Date().toISOString() })
          .eq('call_control_id', callControlId);

        broadcast({
          type: 'call_update',
          event: 'answered',
          call_control_id: callControlId,
          contact_phone: contactPhone
        });
        break;

      // ── Call ended ───────────────────────────────────────────────────────
      case 'call.hangup': {
        const pending = pendingCalls.get(callControlId);
        if (pending?.transferTimer) clearTimeout(pending.transferTimer);
        if (pending?.stage === 2) stopAudioOnCall(callControlId).catch(() => {});
        pendingCalls.delete(callControlId);

        const { data: log } = await supabase
          .from('call_logs')
          .select('answered_at, direction, contact_phone')
          .eq('call_control_id', callControlId)
          .maybeSingle();

        const wasAnswered = !!(log?.answered_at);
        const wasInbound = (log?.direction || direction) === 'inbound';
        const duration = wasAnswered
          ? Math.floor((Date.now() - new Date(log.answered_at).getTime()) / 1000)
          : 0;
        const finalStatus = wasAnswered ? 'completed' : wasInbound ? 'missed' : 'failed';

        await supabase.from('call_logs')
          .update({ status: finalStatus, duration_seconds: duration, ended_at: new Date().toISOString() })
          .eq('call_control_id', callControlId);

        broadcast({
          type: 'call_update',
          event: 'hangup',
          call_control_id: callControlId,
          contact_phone: contactPhone,
          status: finalStatus,
          duration
        });

        if (finalStatus === 'missed') {
          const missedPhone = log?.contact_phone || contactPhone;

          const { data: contact } = await supabase
            .from('sms_contacts')
            .select('first_name, last_name, name')
            .eq('phone', missedPhone)
            .maybeSingle();

          const callerName = contact
            ? `${contact.first_name || ''} ${contact.last_name || ''}`.trim() || contact.name
            : null;

          await sendPushToAll({
            type: 'missed_call',
            title: 'Missed Call',
            body: `Missed call from ${callerName || missedPhone || from}`,
            url: '/?tab=voice',
            caller_phone: missedPhone,
            caller_name: callerName || null
          });
        }
        break;
      }

      // ── Recording saved ──────────────────────────────────────────────────
      case 'call.recording.saved':
        await supabase.from('call_logs')
          .update({
            recording_id: payload?.recording_id,
            recording_url_mp3: payload?.recording_urls?.mp3,
            recording_url_wav: payload?.recording_urls?.wav
          })
          .eq('call_control_id', callControlId);

        broadcast({
          type: 'call_recording_saved',
          call_control_id: callControlId,
          recording_url: payload?.recording_urls?.mp3
        });
        break;
    }

  } catch (err) {
    console.error('[VOICE-WEBHOOK] Unhandled error:', err.message, err.stack?.split('\n')[1]);
  }
});

module.exports = router;
