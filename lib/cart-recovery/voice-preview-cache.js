'use strict';

const crypto = require('node:crypto');

// Preview clips contain no customer data, but keeping them in the existing
// private audio bucket means they never become public bearer URLs. The API
// remains the only playback boundary and still enforces automation.read.
const BUCKET = 'call-recordings';
const CACHE_VERSION = 'v1';
const memory = new Map();
const inFlight = new Map();

function cleanPart(value) {
  const part = String(value || '').trim().toLowerCase();
  return /^[a-z0-9_-]{1,128}$/.test(part) ? part : '';
}

function previewStoragePath({ provider, voiceID, modelID, text } = {}) {
  const safeProvider = cleanPart(provider);
  const safeVoice = cleanPart(voiceID);
  if (!safeProvider || !safeVoice) throw new Error('Invalid recovery voice preview identity.');
  const digest = crypto.createHash('sha256')
    .update(`${CACHE_VERSION}\0${String(modelID || '')}\0${String(text || '')}`)
    .digest('hex').slice(0, 24);
  return `voice-previews/${CACHE_VERSION}/${safeProvider}/${safeVoice}/${digest}.mp3`;
}

function validAudio(value) {
  return Buffer.isBuffer(value) && value.length >= 4
    && (value.subarray(0, 3).toString('ascii') === 'ID3'
      || (value[0] === 0xff && (value[1] & 0xe0) === 0xe0));
}

async function readVoicePreview({ client, provider, voiceID, modelID, text } = {}) {
  if (!client?.storage?.from) return null;
  const path = previewStoragePath({ provider, voiceID, modelID, text });
  if (memory.has(path)) return { audio: memory.get(path), contentType: 'audio/mpeg', cached: true };
  const { data, error } = await client.storage.from(BUCKET).download(path);
  if (error || !data) return null;
  const audio = Buffer.from(await data.arrayBuffer());
  if (!validAudio(audio)) return null;
  memory.set(path, audio);
  return { audio, contentType: 'audio/mpeg', cached: true };
}

async function createVoicePreview({ client, provider, voiceID, modelID, text, synthesize } = {}) {
  if (typeof synthesize !== 'function') throw new Error('Recovery voice preview synthesis is unavailable.');
  const path = previewStoragePath({ provider, voiceID, modelID, text });
  if (inFlight.has(path)) return inFlight.get(path);
  const work = (async () => {
    const existing = await readVoicePreview({ client, provider, voiceID, modelID, text });
    if (existing) return existing;
    const result = await synthesize();
    if (!validAudio(result?.audio)) throw new Error('Recovery voice preview generation returned invalid audio.');
    if (client?.storage?.from) {
      const { error } = await client.storage.from(BUCKET).upload(path, result.audio, {
        contentType: result.contentType || 'audio/mpeg',
        cacheControl: '31536000',
        upsert: true
      });
      if (error) throw new Error(`Recovery voice preview cache failed: ${error.message}`);
    }
    memory.set(path, result.audio);
    return { audio: result.audio, contentType: result.contentType || 'audio/mpeg', cached: false };
  })().finally(() => inFlight.delete(path));
  inFlight.set(path, work);
  return work;
}

function prepareVoicePreview(input = {}) {
  const path = previewStoragePath(input);
  if (!inFlight.has(path)) {
    // The rejection is deliberately consumed here. This is a best-effort
    // warm-up after a bounded API response, never a detached unhandled promise.
    createVoicePreview(input).catch(() => {});
  }
}

module.exports = {
  BUCKET,
  CACHE_VERSION,
  createVoicePreview,
  prepareVoicePreview,
  previewStoragePath,
  readVoicePreview,
  validAudio
};
