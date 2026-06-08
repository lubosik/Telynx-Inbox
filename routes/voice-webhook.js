const router = require('express').Router();
const { supabase } = require('../db');
const { broadcast } = require('../lib/broadcaster');

// POST /webhooks/voice
// Receives Telnyx call control webhook events.
// Always responds 200 immediately — Telnyx retries on non-200.
router.post('/', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = JSON.parse(req.body?.toString() || '{}');
    const event = body?.data;
    if (!event) return;

    const { event_type, payload } = event;
    const callControlId = payload?.call_control_id;
    const from = payload?.from;
    const to = payload?.to;
    const direction = payload?.direction;

    // Contact phone is the customer side, not our number
    const contactPhone = direction === 'inbound' ? from : to;

    console.log(`[VOICE-WEBHOOK] ${event_type} | call=${callControlId?.slice(-8)} | phone=...${contactPhone?.slice(-4)}`);

    switch (event_type) {

      case 'call.initiated':
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
        break;

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

      case 'call.hangup': {
        const { data: log } = await supabase
          .from('call_logs')
          .select('answered_at, status')
          .eq('call_control_id', callControlId)
          .maybeSingle();

        const wasAnswered = log?.answered_at !== null;
        const duration = wasAnswered
          ? Math.floor((Date.now() - new Date(log.answered_at).getTime()) / 1000)
          : 0;

        const finalStatus = wasAnswered ? 'completed' :
          (direction === 'inbound' ? 'missed' : 'failed');

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
        break;
      }

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
