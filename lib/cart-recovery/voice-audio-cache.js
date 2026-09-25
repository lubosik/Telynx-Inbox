'use strict';

// Reuse the existing private audio bucket. Its MIME policy already permits
// MP3/WAV and, unlike the public MMS bucket, staged customer-specific speech
// is never publicly addressable.
const BUCKET = 'call-recordings';
const BRANCHES = new Set(['human', 'voicemail']);
const SIGNED_URL_SECONDS = 300;

function validAttemptID(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function storagePath(attemptID, branch) {
  if (!validAttemptID(attemptID) || !BRANCHES.has(branch)) throw new Error('Invalid recovery voice audio identity.');
  return `voice-recovery/${attemptID}/${branch}.mp3`;
}

async function prepareVoiceAudio({ client, attemptID, scripts, provider = 'elevenlabs', voiceID, modelID,
  synthesize, env = process.env, fetchImpl = global.fetch } = {}) {
  if (!client?.storage?.from || typeof synthesize !== 'function') return { ready: false, reason: 'storage_unavailable' };
  const [human, voicemail] = await Promise.all([
    synthesize({ text: scripts.human, provider, voiceID, modelID, env: { ...env, ELEVENLABS_MODEL: modelID }, fetchImpl }),
    synthesize({ text: scripts.voicemail, provider, voiceID, modelID, env: { ...env, ELEVENLABS_MODEL: modelID }, fetchImpl })
  ]);
  if (!Buffer.isBuffer(human?.audio) || !human.audio.length || !Buffer.isBuffer(voicemail?.audio) || !voicemail.audio.length) {
    throw new Error('Recovery voice audio generation returned no audio.');
  }
  const bucket = client.storage.from(BUCKET);
  const paths = [storagePath(attemptID, 'human'), storagePath(attemptID, 'voicemail')];
  const uploads = await Promise.all([
    bucket.upload(paths[0], human.audio, { contentType: human.contentType || 'audio/mpeg', cacheControl: '300', upsert: false }),
    bucket.upload(paths[1], voicemail.audio, { contentType: voicemail.contentType || 'audio/mpeg', cacheControl: '300', upsert: false })
  ]);
  const error = uploads.find(result => result?.error)?.error;
  if (error) {
    await bucket.remove(paths).catch(() => {});
    throw new Error(`Recovery voice audio upload failed: ${error.message}`);
  }
  return { ready: true };
}

async function signedVoiceAudioURL({ client, attemptID, branch } = {}) {
  if (!client?.storage?.from) return null;
  try {
    const { data, error } = await client.storage.from(BUCKET)
      .createSignedUrl(storagePath(attemptID, branch), SIGNED_URL_SECONDS, { download: false });
    return error ? null : data?.signedUrl || null;
  } catch { return null; }
}

async function cleanupVoiceAudio({ client, attemptID } = {}) {
  if (!client?.storage?.from || !validAttemptID(attemptID)) return false;
  const { error } = await client.storage.from(BUCKET).remove([
    storagePath(attemptID, 'human'), storagePath(attemptID, 'voicemail')
  ]);
  return !error;
}

module.exports = {
  BUCKET,
  cleanupVoiceAudio,
  prepareVoiceAudio,
  signedVoiceAudioURL,
  storagePath
};
