'use strict';

/**
 * Private call-recording storage.
 *
 * Telnyx recording links expire after a few minutes. We retrieve each link
 * from Telnyx's authenticated Recordings API, copy the audio into a private
 * Supabase bucket, and expose it only through an authenticated app route that
 * creates a very short-lived signed URL.
 */

const { supabase } = require('../db');

const BUCKET = 'call-recordings';
const MAX_RECORDING_BYTES = 100 * 1024 * 1024;
const DEFAULT_SIGNED_URL_SECONDS = 60;
const DEFAULT_RETENTION_DAYS = 30;

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function retentionDays(env = process.env) {
  return boundedInteger(env.CALL_RECORDING_RETENTION_DAYS, DEFAULT_RETENTION_DAYS, 1, 3650);
}

function signedURLSeconds(env = process.env) {
  return boundedInteger(env.CALL_RECORDING_SIGNED_URL_SECONDS, DEFAULT_SIGNED_URL_SECONDS, 30, 300);
}

function validRecordingID(value) {
  return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,200}$/.test(value);
}

async function responseBuffer(response, maxBytes = MAX_RECORDING_BYTES) {
  const declared = Number.parseInt(response.headers?.get?.('content-length') || '', 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`recording exceeds ${maxBytes} byte limit`);
  }

  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error(`recording exceeds ${maxBytes} byte limit`);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`recording exceeds ${maxBytes} byte limit`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function telnyxRecording(recordingID, { fetchImpl = global.fetch, env = process.env } = {}) {
  if (!validRecordingID(recordingID)) throw new Error('invalid recording id');
  if (!env.TELNYX_API_KEY) throw new Error('TELNYX_API_KEY is not configured');

  const response = await fetchImpl(
    `https://api.telnyx.com/v2/recordings/${encodeURIComponent(recordingID)}`,
    {
      headers: { Authorization: `Bearer ${env.TELNYX_API_KEY}` },
      signal: AbortSignal.timeout(15_000)
    }
  );
  if (!response.ok) throw new Error(`Telnyx recording lookup failed (${response.status})`);
  const json = await response.json();
  return json?.data || null;
}

function preferredDownload(recording) {
  const mp3 = recording?.download_urls?.mp3 || recording?.recording_urls?.mp3;
  const wav = recording?.download_urls?.wav || recording?.recording_urls?.wav;
  const url = mp3 || wav;
  if (!url) throw new Error('Telnyx recording has no download URL');

  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Telnyx returned an invalid recording URL'); }
  if (parsed.protocol !== 'https:') throw new Error('Telnyx recording URL must use HTTPS');

  return mp3
    ? { url, extension: 'mp3', contentType: 'audio/mpeg' }
    : { url, extension: 'wav', contentType: 'audio/wav' };
}

async function archiveCallRecording(recordingID, {
  client = supabase,
  fetchImpl = global.fetch,
  env = process.env,
  recording = null
} = {}) {
  const metadata = recording || await telnyxRecording(recordingID, { fetchImpl, env });
  const download = preferredDownload(metadata);
  const response = await fetchImpl(download.url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`recording download failed (${response.status})`);

  const audio = await responseBuffer(response);
  const storagePath = `recordings/${recordingID}.${download.extension}`;
  const { error } = await client.storage.from(BUCKET).upload(storagePath, audio, {
    contentType: download.contentType,
    cacheControl: '0',
    upsert: true
  });
  if (error) throw new Error(`private recording upload failed: ${error.message}`);

  const archivedAt = new Date();
  const expiresAt = new Date(archivedAt.getTime() + retentionDays(env) * 24 * 60 * 60 * 1000);
  return {
    recording_storage_path: storagePath,
    recording_content_type: download.contentType,
    recording_archived_at: archivedAt.toISOString(),
    recording_expires_at: expiresAt.toISOString(),
    recording_deleted_at: null,
    recording_url_mp3: null,
    recording_url_wav: null
  };
}

function privateCallLog(log) {
  if (!log) return null;
  const {
    recording_id: _recordingID,
    recording_storage_path: storagePath,
    recording_content_type: _contentType,
    recording_url_mp3: _legacyMP3,
    recording_url_wav: _legacyWAV,
    ...safe
  } = log;
  const available = Boolean(storagePath && !log.recording_deleted_at);
  const playbackURL = available ? `/api/voice/recordings/${encodeURIComponent(String(log.id))}` : null;
  return {
    ...safe,
    recording_available: available,
    recording_url_mp3: playbackURL,
    recording_url_wav: null,
    recording_url: playbackURL
  };
}

async function signedRecordingURL(storagePath, { client = supabase, env = process.env } = {}) {
  if (typeof storagePath !== 'string'
      || !/^recordings\/[A-Za-z0-9:_-]{1,200}\.(?:mp3|wav)$/.test(storagePath)) {
    throw new Error('invalid private recording path');
  }
  const { data, error } = await client.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, signedURLSeconds(env), { download: false });
  if (error || !data?.signedUrl) throw new Error(error?.message || 'could not sign recording URL');
  return data.signedUrl;
}

async function deleteTelnyxRecording(recordingID, { fetchImpl = global.fetch, env = process.env } = {}) {
  if (!recordingID) return;
  if (!validRecordingID(recordingID)) throw new Error('invalid recording id');
  const response = await fetchImpl(
    `https://api.telnyx.com/v2/recordings/${encodeURIComponent(recordingID)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${env.TELNYX_API_KEY}` },
      signal: AbortSignal.timeout(15_000)
    }
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`Telnyx recording deletion failed (${response.status})`);
  }
}

async function purgeExpiredRecordings({
  client = supabase,
  fetchImpl = global.fetch,
  env = process.env,
  now = new Date(),
  dryRun = false
} = {}) {
  const { data: rows, error } = await client
    .from('call_logs')
    .select('id, recording_id, recording_storage_path, recording_expires_at')
    .lte('recording_expires_at', now.toISOString())
    .is('recording_deleted_at', null)
    .limit(100);
  if (error) throw new Error(`recording retention lookup failed: ${error.message}`);
  if (dryRun) return { found: rows?.length || 0, deleted: 0, failed: 0 };

  let deleted = 0;
  let failed = 0;
  for (const row of rows || []) {
    try {
      if (row.recording_storage_path) {
        const { error: removeError } = await client.storage.from(BUCKET).remove([row.recording_storage_path]);
        if (removeError) throw new Error(removeError.message);
      }
      await deleteTelnyxRecording(row.recording_id, { fetchImpl, env });
      const { error: updateError } = await client.from('call_logs').update({
        recording_storage_path: null,
        recording_url_mp3: null,
        recording_url_wav: null,
        recording_deleted_at: now.toISOString()
      }).eq('id', row.id);
      if (updateError) throw new Error(updateError.message);
      deleted++;
    } catch (err) {
      failed++;
      console.error(`[RECORDING] Retention delete failed for log ${row.id}: ${err.message}`);
    }
  }
  return { found: rows?.length || 0, deleted, failed };
}

function startRecordingRetentionJob(options = {}) {
  const env = options.env || process.env;
  if (String(env.CALL_RECORDING_RETENTION_ENFORCED).toLowerCase() !== 'true') {
    console.log('[RECORDING] Retention deletion is staged but not enabled.');
    return null;
  }
  const run = () => purgeExpiredRecordings({ ...options, dryRun: false })
    .then(result => console.log(`[RECORDING] Retention: ${result.deleted}/${result.found} deleted, ${result.failed} failed`))
    .catch(err => console.error('[RECORDING] Retention job failed:', err.message));
  const initial = setTimeout(run, 60_000);
  const interval = setInterval(run, 24 * 60 * 60 * 1000);
  return { initial, interval };
}

module.exports = {
  BUCKET,
  archiveCallRecording,
  privateCallLog,
  purgeExpiredRecordings,
  signedRecordingURL,
  startRecordingRetentionJob,
  validRecordingID
};
