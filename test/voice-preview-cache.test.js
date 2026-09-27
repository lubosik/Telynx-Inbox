'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createVoicePreview,
  previewStoragePath,
  readVoicePreview
} = require('../lib/cart-recovery/voice-preview-cache');

const MP3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]);

test('voice preview paths are stable and invalidate when model or copy changes', () => {
  const common = { provider: 'dia', voiceID: 'dia_vici_sunny_v1', modelID: 'model@revision' };
  const first = previewStoragePath({ ...common, text: 'Hello.' });
  assert.equal(first, previewStoragePath({ ...common, text: 'Hello.' }));
  assert.notEqual(first, previewStoragePath({ ...common, text: 'Different.' }));
  assert.notEqual(first, previewStoragePath({ ...common, modelID: 'model@next', text: 'Hello.' }));
  assert.match(first, /^voice-previews\/v1\/dia\/dia_vici_sunny_v1\/[a-f0-9]{24}\.mp3$/);
});

test('a generated preview is privately persisted and then served from cache', async () => {
  let uploaded;
  let syntheses = 0;
  const bucket = {
    async download() { return { data: null, error: { message: 'not found' } }; },
    async upload(path, audio, options) {
      uploaded = { path, audio, options };
      return { error: null };
    }
  };
  const client = { storage: { from(name) { assert.equal(name, 'call-recordings'); return bucket; } } };
  const input = {
    client, provider: 'dia', voiceID: 'dia_test_cache', modelID: 'model@revision', text: 'Hello.',
    synthesize: async () => {
      syntheses += 1;
      return { audio: MP3, contentType: 'audio/mpeg' };
    }
  };
  const created = await createVoicePreview(input);
  assert.equal(syntheses, 1);
  assert.deepEqual(created.audio, MP3);
  assert.equal(uploaded.options.upsert, true);
  assert.equal(uploaded.options.cacheControl, '31536000');
  assert.match(uploaded.path, /^voice-previews\/v1\/dia\/dia_test_cache\//);

  const cached = await readVoicePreview(input);
  assert.deepEqual(cached.audio, MP3);
  assert.equal(cached.cached, true);
  assert.equal(syntheses, 1);
});
