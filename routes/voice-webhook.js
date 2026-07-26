const router = require('express').Router();
const { supabase } = require('../db');
const { broadcast } = require('../lib/broadcaster');
const { normalisePhone } = require('../lib/phone');
const { sendPushToAll } = require('../push-notify');
const { answerCall, speakOnCall, transferCall, recordCall } = require('../lib/telnyx-api');

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

// ─── Caller identity carried between webhook events ──────────────────────────
// The contact lookup happens on call.initiated but the transfer happens on a
// later event (call.speak.ended), so the resolved name is held here rather than
// re-queried. Entries are dropped on hangup; the 10-minute sweep is a safety
// net for calls that never produce one.
const inFlightCalls = new Map();

const MAX_IN_FLIGHT = 200;

function rememberCall(cid, info) {
  if (!cid) return;
  inFlightCalls.delete(cid);                       // keep insertion order = age order
  inFlightCalls.set(cid, { ...info, at: Date.now() });

  // Drop anything past its useful life, then hard-cap oldest-first so a burst
  // of calls inside the expiry window can't grow the map without bound.
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of inFlightCalls) {
    if (v.at >= cutoff) break;                     // insertion-ordered, so the rest are newer
    inFlightCalls.delete(k);
  }
  while (inFlightCalls.size > MAX_IN_FLIGHT) {
    inFlightCalls.delete(inFlightCalls.keys().next().value);
  }
}

async function lookupCallerName(phone) {
  if (!phone) return null;
  try {
    const { data } = await supabase.from('sms_contacts')
      .select('first_name, last_name, name').eq('phone', phone).maybeSingle();
    if (!data) return null;
    return `${data.first_name || ''} ${data.last_name || ''}`.trim() || data.name || null;
  } catch (_) { return null; }
}

/**
 * Caller identity for the transfer leg, falling back to the DB when the
 * in-memory entry is missing (e.g. the process restarted mid-call).
 */
async function resolveCallerIdentity(cid) {
  const cached = inFlightCalls.get(cid);
  if (cached?.phone) return { phone: cached.phone, callerName: cached.callerName };

  try {
    const { data } = await supabase.from('call_logs')
      .select('contact_phone').eq('call_control_id', cid).maybeSingle();
    const phone = data?.contact_phone || null;
    return { phone, callerName: await lookupCallerName(phone) };
  } catch (_) {
    return { phone: null, callerName: null };
  }
}

/**
 * Transfers to the operator's SIP endpoint, presenting the customer's number
 * and (when known) their saved contact name.
 *
 * The caller's own number is used as `from` so the iPhone's Recents entry dials
 * the customer back rather than our own line. Which business the call came in
 * on is conveyed by the app itself on the CallKit screen.
 */
// The caller's name is cosmetic; connecting the call is not. On a cache miss
// the lookup hits the DB, and a hung (rather than failing) query would leave the
// customer in dead air — so it is capped hard and the transfer proceeds without
// a name. Cache hits do no I/O and never reach this.
const IDENTITY_LOOKUP_TIMEOUT_MS = 1500;

function resolveCallerIdentityCapped(cid) {
  return Promise.race([
    resolveCallerIdentity(cid),
    new Promise(resolve => setTimeout(() => {
      console.warn('[VOICE] caller identity lookup timed out — transferring without a name');
      resolve({ phone: null, callerName: null });
    }, IDENTITY_LOOKUP_TIMEOUT_MS))
  ]).catch(() => ({ phone: null, callerName: null }));
}

async function transferToOperator(cid) {
  const sipTarget = `sip:${process.env.TELNYX_SIP_USERNAME}@sip.telnyx.com`;
  const { phone, callerName } = await resolveCallerIdentityCapped(cid);

  // Telnyx requires `from` in +E.164. A malformed caller number would fail the
  // whole transfer and drop the call, so anything that doesn't validate falls
  // back to our own number — the previous behaviour.
  const isE164 = typeof phone === 'string' && /^\+[1-9]\d{7,14}$/.test(phone);
  const fromNumber = isE164 ? phone : process.env.TELNYX_PHONE_NUMBER;
  if (phone && !isE164) {
    console.warn(`[VOICE] caller number ${phone} is not E.164 — using business number as from`);
  }

  await transferCall(cid, sipTarget, fromNumber, callerName);
  console.log(`[VOICE] Transfer initiated to ${sipTarget} as ${callerName || fromNumber}`);
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

        // Caller name lookup — reused by the push, the SSE broadcast, and the
        // SIP transfer's display name.
        const callerName = await lookupCallerName(contactPhone);
        rememberCall(cid, { phone: contactPhone, callerName });

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
          try { await transferToOperator(cid); }
          catch (te) { console.error('[VOICE] Immediate transfer failed:', te.message); }
        }
        break;
      }

      // When greeting finishes, start recording then transfer to SIP
      case 'call.speak.ended': {
        console.log('[VOICE] Greeting ended — starting recording + transferring to SIP');

        // Auto-record every call — non-blocking so transfer isn't delayed
        recordCall(cid)
          .then(() => console.log('[VOICE] Recording started'))
          .catch(e => console.error('[VOICE] Auto-record failed (non-fatal):', e.message));

        try {
          await transferToOperator(cid);
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
        inFlightCalls.delete(cid);
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
          const missedName = await lookupCallerName(missedPhone);
          sendPushToAll({ type: 'missed_call', title: 'Missed Call', body: `Missed call from ${missedName || missedPhone || from}`, url: '/?tab=voice', caller_phone: missedPhone, caller_name: missedName }).catch(() => {});
        }
        break;
      }

      case 'call.recording.saved':
        console.log('[VOICE] Recording saved for cid=...'+cid?.slice(-6));
        await dbUpdate({
          recording_id: payload?.recording_id,
          recording_url_mp3: payload?.recording_urls?.mp3,
          recording_url_wav: payload?.recording_urls?.wav
        }, cid);
        broadcast({ type: 'call_recording_saved', call_control_id: cid });
        break;
    }

  } catch (err) {
    console.error('[VOICE] Unhandled error:', err.message, err.stack?.split('\n')[1]);
  }
});

module.exports = router;
