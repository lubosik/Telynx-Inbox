const router = require('express').Router();
const { supabase } = require('../db');
const { broadcast } = require('../lib/broadcaster');
const { normalisePhone } = require('../lib/phone');
const { sendPushToAll } = require('../push-notify');
const { answerCall, speakOnCall, transferCall } = require('../lib/telnyx-api');

// In-memory store for inbound calls in the hold/speak phase.
// Structure: callControlId -> { contactPhone, sipTarget, stage, transferTimer }
// stage 1 = first speak playing
// stage 2 = second speak playing
// stage 3 = waiting 8s before transfer
const pendingCalls = new Map();

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

    console.log(`[VOICE-WEBHOOK] ${event_type} | call=${callControlId?.slice(-8)} | phone=...${contactPhone?.slice(-4)}`);

    switch (event_type) {

      // ── Inbound call arrives ─────────────────────────────────────────────
      case 'call.initiated': {
        // Always log to Supabase
        await supabase.from('call_logs').upsert({
          call_control_id: callControlId,
          call_leg_id: payload?.call_leg_id,
          call_session_id: payload?.call_session_id,
          direction: direction || 'inbound',
          contact_phone: contactPhone,
          from_number: from,
          to_number: to,
          status: 'initiated',
          started_at: payload?.start_time || new Date().toISOString()
        }, { onConflict: 'call_control_id' });

        broadcast({
          type: 'call_update',
          event: 'initiated',
          call_control_id: callControlId,
          direction,
          contact_phone: contactPhone
        });

        // Only apply hold flow for inbound calls
        if (direction !== 'inbound') break;

        // 1. Answer immediately — prevents Telnyx dropping the call
        await answerCall(callControlId);

        // 2. Look up contact name for the push body
        const { data: contact } = await supabase
          .from('sms_contacts')
          .select('first_name, last_name, name')
          .eq('phone', contactPhone)
          .maybeSingle();

        const callerName = contact
          ? `${contact.first_name || ''} ${contact.last_name || ''}`.trim() || contact.name
          : null;
        const callerDisplay = callerName || contactPhone;

        // 3. Register this call as pending (stage 1 = first speak in progress)
        const sipTarget = `sip:${process.env.TELNYX_SIP_USERNAME}@sip.telnyx.com`;
        pendingCalls.set(callControlId, {
          contactPhone,
          sipTarget,
          stage: 1,
          transferTimer: null
        });

        // 4. Send incoming_call push + start first hold speak in parallel
        await Promise.all([
          sendPushToAll({
            type: 'incoming_call',
            title: 'Incoming Call',
            body: `${callerDisplay} is calling`,
            url: '/?call=incoming',
            caller_phone: contactPhone,
            caller_name: callerName || null
          }),
          speakOnCall(callControlId, "Please hold, we're connecting your call.")
        ]);

        console.log(`[VOICE-WEBHOOK] Inbound answered + push sent for ...${contactPhone?.slice(-4)}`);
        break;
      }

      // ── Hold speak finished — chain second speak, then schedule transfer ─
      case 'call.speak.ended': {
        const pending = pendingCalls.get(callControlId);
        if (!pending) break; // Caller hung up during speak

        if (pending.stage === 1) {
          pending.stage = 2;
          // Second speak buys ~4 more seconds while Dom's WebRTC connects
          await speakOnCall(callControlId, 'One moment please, almost there.')
            .catch(err => console.error('[VOICE-WEBHOOK] Speak 2 failed:', err.message));

        } else if (pending.stage === 2) {
          pending.stage = 3;
          // Wait 8 more seconds (total ~15s from call start), then transfer to Dom's SIP
          pending.transferTimer = setTimeout(async () => {
            const p = pendingCalls.get(callControlId);
            if (!p) return; // Already cleaned up (caller hung up)
            pendingCalls.delete(callControlId);
            console.log(`[VOICE-WEBHOOK] Transferring call to SIP for ...${p.contactPhone?.slice(-4)}`);
            await transferCall(callControlId, p.sipTarget, process.env.TELNYX_PHONE_NUMBER)
              .catch(err => console.error('[VOICE-WEBHOOK] Transfer failed:', err.message));
          }, 8000);
        }
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
        // Cancel transfer timer if caller hung up during the hold phase
        const pending = pendingCalls.get(callControlId);
        if (pending?.transferTimer) clearTimeout(pending.transferTimer);
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
            body: `You missed a call from ${callerName || missedPhone || from}`,
            url: '/?tab=voice',
            caller_phone: missedPhone,
            caller_name: callerName || null
          });

          console.log(`[VOICE-WEBHOOK] Missed call from ...${contactPhone?.slice(-4)} — push sent`);
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
    console.error('[VOICE-WEBHOOK] Error:', err.message);
  }
});

module.exports = router;
