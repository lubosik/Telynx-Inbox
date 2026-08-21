const router = require('express').Router();
const { supabase } = require('../db');
const { selectIn } = require('../lib/fetch-all-rows');
const { isNativeIOSClient } = require('../lib/client-platform');
const { getIOSVoiceCredentials } = require('../lib/voice-credentials');
const { normalisePhone } = require('../lib/phone');
const { isInternalSIPLog, answeredAtFromDuration } = require('../lib/call-status');
const { countUnseenMissedCalls, markMissedCallsSeen } = require('../lib/missed-calls');
const {
  archiveCallRecording,
  privateCallLog,
  signedRecordingURL
} = require('../lib/private-recordings');
const { logAudit, logAuditSafely } = require('../lib/audit/log');

// GET /api/voice/token — returns SIP credentials to the native iOS app only.
// Protected by requireAuth at mount point in server.js
router.get('/token', async (req, res) => {
  try {
    if (!isNativeIOSClient(req.get('user-agent'), req.get('x-vici-client'))) {
      return res.status(403).json({
        error: 'Browser calling is disabled; use Vici Inbox on iPhone.'
      });
    }

    // SIP credentials must never be cached by a browser, proxy, or the app's
    // URL cache. The iOS app keeps the current value securely in Keychain.
    res.set('Cache-Control', 'no-store');
    const credentials = getIOSVoiceCredentials();

    // Audit that SIP credentials were handed out, and which credential it was.
    // The password is NEVER part of this row, and `password` is not on the
    // allowlist for this event type in lib/audit/redact.js, so it could not be
    // written even if a future edit passed it in here by mistake.
    await logAudit({
      eventType: 'security.voice_credentials.issued',
      req,
      entityId: credentials.login || null,
      summary: `Issued SIP credentials for ${credentials.login || 'unknown login'} to the iPhone app`,
      metadata: {
        login: credentials.login || null,
        dedicated_ios_pair: Boolean(credentials.usingDedicatedIOSCredential),
        client: req.get('x-vici-client') || null
      }
    });

    res.json({
      login: credentials.login,
      password: credentials.password,
      callerNumber: process.env.TELNYX_PHONE_NUMBER
    });
  } catch (err) {
    console.error('[VOICE] Token error:', err.message);
    res.status(500).json({ error: 'Could not get voice credentials' });
  }
});

// GET /api/voice/logs?phone=&page=1
router.get('/logs', async (req, res) => {
  const { phone, page = 1 } = req.query;
  const limit = 50;
  const offset = (parseInt(page) - 1) * limit;

  let query = supabase
    .from('call_logs')
    .select('*')
    .order('started_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (phone) query = query.eq('contact_phone', decodeURIComponent(phone));

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // The transfer to sip:USERNAME is an implementation detail, not a second
  // person-facing call. Keep it in the database for diagnostics but never show
  // it as a failed call in History.
  const logs = (data || []).filter(log => !isInternalSIPLog(log));
  const phones = [...new Set(logs.map(log => log.contact_phone).filter(Boolean))];
  let names = new Map();
  if (phones.length) {
    // Chunked: `.in()` puts every value in the URL, and a long list overflows
    // the HTTP header limit. See lib/fetch-all-rows.js.
    let contacts = [];
    let contactsError = null;
    try {
      contacts = await selectIn(supabase, 'sms_contacts', 'phone, first_name, last_name, name', 'phone', phones);
    } catch (err) {
      contactsError = err;
    }
    if (contactsError) console.warn('[VOICE] Call-history contact lookup failed:', contactsError.message);
    names = new Map((contacts || []).map(contact => {
      const fullName = `${contact.first_name || ''} ${contact.last_name || ''}`.trim() || contact.name || null;
      return [contact.phone, fullName];
    }));
  }

  res.set('Cache-Control', 'no-store');
  res.json(logs.map(log => privateCallLog({
    ...log,
    contact_name: names.get(log.contact_phone) || null
  })));
});

// GET /api/voice/missed-count — outstanding missed calls for the app badge
router.get('/missed-count', async (_req, res) => {
  res.json({ count: await countUnseenMissedCalls() });
});

// POST /api/voice/logs/seen — the operator opened call history, so the missed
// calls in it are no longer new. Registered before /logs/:id so the literal
// path is never mistaken for a record id.
router.post('/logs/seen', async (_req, res) => {
  const { marked, ok } = await markMissedCallsSeen();
  // A failure here only means the badge did not clear server-side; the app
  // keeps its own record of what has been seen, so report the outcome rather
  // than failing the request.
  res.json({ marked, ok, count: await countUnseenMissedCalls() });
});

// GET /api/voice/recordings/:id — authenticated, short-lived playback.
// The database/API never returns Telnyx's temporary S3 link or the private
// Storage object path. A signed URL is minted only when playback is requested.
router.get('/recordings/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid call log id' });
  const { data: log, error } = await supabase
    .from('call_logs')
    .select('id, recording_id, recording_storage_path, recording_deleted_at')
    .eq('id', req.params.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'Could not load recording' });
  if (!log || log.recording_deleted_at) return res.status(404).json({ error: 'Recording not found' });

  let storagePath = log.recording_storage_path;
  if (!storagePath && log.recording_id) {
    try {
      const archived = await archiveCallRecording(log.recording_id);
      const { error: updateError } = await supabase.from('call_logs').update(archived).eq('id', log.id);
      if (updateError) throw new Error(updateError.message);
      storagePath = archived.recording_storage_path;
    } catch (archiveError) {
      console.error(`[RECORDING] On-demand archive failed for log ${log.id}: ${archiveError.message}`);
    }
  }
  if (!storagePath) return res.status(404).json({ error: 'Recording is not privately archived yet' });

  try {
    const signedURL = await signedRecordingURL(storagePath);

    // Who listened to a customer recording is a compliance question, so this is
    // visibility 'audit' and stays out of the main feed. The signed URL itself
    // is never recorded: it would outlive its own short expiry inside a table
    // that cannot be deleted from.
    await logAudit({
      eventType: 'recording.played',
      req,
      entityId: log.id,
      summary: `Played the call recording for call log ${log.id}`,
      metadata: { call_log_id: log.id, recording_archived: true }
    });

    res.set('Cache-Control', 'no-store, private');
    return res.redirect(302, signedURL);
  } catch (signError) {
    console.error(`[RECORDING] Signed playback failed for log ${log.id}: ${signError.message}`);
    return res.status(500).json({ error: 'Could not open recording' });
  }
});

// GET /api/voice/logs/:id
router.get('/logs/:id', async (req, res) => {
  const { data } = await supabase
    .from('call_logs')
    .select('*')
    .eq('id', req.params.id)
    .single();
  res.set('Cache-Control', 'no-store');
  res.json(privateCallLog(data));
});

// POST /api/voice/logs — client-side fallback when Telnyx webhook doesn't fire
router.post('/logs', async (req, res) => {
  const { call_control_id, direction, contact_phone, from_number, to_number,
          duration_seconds, status, started_at, ended_at, source } = req.body;

  if (!contact_phone) return res.status(400).json({ error: 'contact_phone required' });

  // The iPhone knows whether WebRTC actually reached ACTIVE. Reconcile that
  // outcome onto the server-created inbound row so History represents one
  // logical call and does not confuse the backend greeting with a human answer.
  if (source === 'ios' && direction === 'inbound') {
    const phone = normalisePhone(contact_phone) || contact_phone;
    const clientStartedMs = Date.parse(started_at || '');
    const anchorMs = Number.isFinite(clientStartedMs) ? clientStartedMs : Date.now();
    const lower = new Date(anchorMs - 2 * 60 * 1000).toISOString();
    const upper = new Date(anchorMs + 2 * 60 * 1000).toISOString();
    const { data: candidates, error: lookupError } = await supabase
      .from('call_logs')
      .select('call_control_id, started_at')
      .eq('direction', 'inbound')
      .eq('contact_phone', phone)
      .gte('started_at', lower)
      .lte('started_at', upper)
      .order('started_at', { ascending: false })
      .limit(5);

    if (lookupError) {
      console.warn('[VOICE] Native call reconciliation lookup failed:', lookupError.message);
    } else if (candidates?.length) {
      const match = candidates.reduce((closest, candidate) => {
        if (!Number.isFinite(clientStartedMs)) return closest || candidate;
        const distance = Math.abs(Date.parse(candidate.started_at) - clientStartedMs);
        return !closest || distance < closest.distance ? { ...candidate, distance } : closest;
      }, null);
      const finalEndedAt = ended_at || new Date().toISOString();
      const connected = status === 'completed' && Number(duration_seconds) > 0;
      const { error: updateError } = await supabase.from('call_logs').update({
        status: connected ? 'completed' : 'missed',
        duration_seconds: connected ? Math.floor(Number(duration_seconds)) : 0,
        answered_at: connected ? answeredAtFromDuration(finalEndedAt, duration_seconds) : null,
        ended_at: finalEndedAt
      }).eq('call_control_id', match.call_control_id);
      if (updateError) return res.status(500).json({ error: updateError.message });
      return res.json({ ok: true, reconciled: true });
    }
  }

  const { error } = await supabase.from('call_logs').upsert({
    call_control_id: call_control_id || `client-${Date.now()}`,
    direction: direction || 'outbound',
    contact_phone,
    from_number: from_number || null,
    to_number: to_number || null,
    duration_seconds: duration_seconds || 0,
    status: status || 'completed',
    started_at: started_at || new Date().toISOString(),
    ended_at: ended_at || new Date().toISOString(),
    answered_at: duration_seconds > 0
      ? answeredAtFromDuration(ended_at || new Date().toISOString(), duration_seconds)
      : null
  }, { onConflict: 'call_control_id' });

  if (error) {
    console.error('[VOICE] Log save error:', error.message);
    return res.status(500).json({ error: error.message });
  }
  res.json({ ok: true });
});

// POST /api/voice/recording/start
router.post('/recording/start', async (req, res) => {
  const { call_control_id } = req.body;
  if (!call_control_id) return res.status(400).json({ error: 'call_control_id required' });

  try {
    const response = await fetch(
      `https://api.telnyx.com/v2/calls/${call_control_id}/actions/record_start`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ format: 'mp3', channels: 'dual', play_beep: true })
      }
    );
    if (!response.ok) {
      const err = await response.json();
      return res.status(400).json({ error: err?.errors?.[0]?.detail || 'Recording start failed' });
    }
    await logAudit({
      eventType: 'call.recording.started',
      req,
      entityId: call_control_id,
      summary: `Started recording call ${call_control_id}`,
      metadata: { call_control_id }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/voice/recording/stop
router.post('/recording/stop', async (req, res) => {
  const { call_control_id } = req.body;
  if (!call_control_id) return res.status(400).json({ error: 'call_control_id required' });

  try {
    await fetch(
      `https://api.telnyx.com/v2/calls/${call_control_id}/actions/record_stop`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      }
    );
    await logAudit({
      eventType: 'call.recording.stopped',
      req,
      entityId: call_control_id,
      summary: `Stopped recording call ${call_control_id}`,
      metadata: { call_control_id }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/voice/backfill-recordings — pull all recordings from Telnyx and match to call_logs
//
// `lib/route-policy.js` marks this route `audit: true`. That flag was inert:
// nothing in the enforcer reads it and this handler wrote no audit row, so the
// policy table asserted coverage the code did not provide. A decorative flag is
// worse than a missing one, because the next reader trusts it.
//
// It is instrumented rather than de-flagged because the flag was right. This is
// an admin action that enumerates EVERY recording in the Telnyx account and
// writes storage paths onto call_logs. Two rows, triggered and completed/failed,
// matching routes/sync.js — that pairing is what makes "these recordings
// appeared overnight, who ran what?" answerable.
//
// logAuditSafely, not logAudit: an audit write must never break the operation
// it describes. Both calls sit inside the try, and the triggered row is awaited
// before the work starts so the record exists even if the backfill then dies.
const RECORDING_BACKFILL_SYNC_TYPE = 'call_recordings_backfill';

router.post('/backfill-recordings', async (req, res) => {
  const startedAt = Date.now();
  try {
    await logAuditSafely({
      eventType: 'settings.sync.triggered',
      req,
      entityId: RECORDING_BACKFILL_SYNC_TYPE,
      summary: 'Started the call-recording backfill from Telnyx',
      metadata: { sync_type: RECORDING_BACKFILL_SYNC_TYPE, source: 'api' }
    });

    const { backfillRecordings } = require('../scripts/backfill-recordings');
    const result = await backfillRecordings();

    await logAuditSafely({
      eventType: 'settings.sync.completed',
      req,
      entityId: RECORDING_BACKFILL_SYNC_TYPE,
      summary: `Call-recording backfill finished in ${Date.now() - startedAt}ms: ` +
        `${result?.matched ?? 0} of ${result?.total ?? 0} Telnyx recordings matched, ${result?.updated ?? 0} call logs updated`,
      metadata: {
        sync_type: RECORDING_BACKFILL_SYNC_TYPE,
        duration_ms: Date.now() - startedAt,
        // `fixed` and `skipped` are the two count keys on the allowlist for
        // this event type in lib/audit/redact.js. `updated` is what was fixed;
        // everything the backfill saw and did not match was skipped.
        fixed: result?.updated ?? 0,
        skipped: Math.max(0, (result?.total ?? 0) - (result?.matched ?? 0))
      }
    });

    res.json(result);
  } catch (err) {
    console.error('[VOICE] Backfill recordings error:', err.message);
    await logAuditSafely({
      eventType: 'settings.sync.failed',
      req,
      entityId: RECORDING_BACKFILL_SYNC_TYPE,
      summary: `Call-recording backfill failed after ${Date.now() - startedAt}ms`,
      metadata: {
        sync_type: RECORDING_BACKFILL_SYNC_TYPE,
        duration_ms: Date.now() - startedAt,
        error_code: err?.code || 'unknown'
      }
    });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
