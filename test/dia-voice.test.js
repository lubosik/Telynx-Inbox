'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  MODEL_ID, MODEL_REVISION, configuration, endpointURL, listDiaVoices,
  retryDelayValue, safeText, speak, validMP3
} = require('../lib/assistant/dia-voice');
const { createCartRecoveryService, RECOVERY_VOICE_PREVIEW_TEXT } = require('../lib/cart-recovery/service');

const ROOT = path.join(__dirname, '..');
const ENV = {
  DIA_VOICE_CATALOGUE_ENABLED: 'true',
  DIA_TTS_ENDPOINT: 'https://dia.internal.example/v1/audio/speech',
  DIA_TTS_API_KEY: 'test-only-key-at-least-32-characters',
  DIA_VOICE_PROFILE_ID: 'dia_vici_sunny_v1',
  DIA_VOICE_NAME: 'Dia Sunny',
  DIA_MODEL_ID: MODEL_ID,
  DIA_MODEL_REVISION: MODEL_REVISION
};
const MP3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]);
const HEALTHY = () => new Response('{"status":"ready"}', {
  status: 200, headers: { 'content-type': 'application/json' }
});

test('Dia configuration is pinned, private-endpoint-shaped, and fails closed', () => {
  const config = configuration(ENV);
  assert.equal(config.endpoint.href, ENV.DIA_TTS_ENDPOINT);
  assert.equal(config.modelID, MODEL_ID);
  assert.equal(config.modelRevision, MODEL_REVISION);
  assert.equal(endpointURL('http://dia.example/v1/audio/speech'), null);
  assert.equal(endpointURL('https://127.0.0.1/v1/audio/speech'), null);
  assert.equal(endpointURL('https://user:pass@dia.example/speech'), null);
  assert.throws(() => configuration({ ...ENV, DIA_TTS_API_KEY: '' }), error => error.code === 'DIA_KEY_MISSING');
  assert.throws(() => configuration({ ...ENV, DIA_MODEL_REVISION: 'main' }), error => error.code === 'DIA_MODEL_INVALID');
});

test('Dia strips customer-controlled speaker and nonverbal syntax', () => {
  assert.equal(safeText('[S2] RT (laughs) [S1]\n is waiting (SIGHs).'), 'RT is waiting .');
  assert.equal(safeText('  Hello\tthere  '), 'Hello there');
  assert.equal(safeText('x'.repeat(1_500)).length, 1_200);
});

test('Dia catalogue exposes only the configured immutable synthetic profile', async () => {
  const voices = await listDiaVoices({ env: ENV });
  assert.equal(voices.length, 1);
  assert.equal(voices[0].id, 'dia_vici_sunny_v1');
  assert.equal(voices[0].provider, 'dia');
  assert.equal(voices[0].modelId, `${MODEL_ID}@${MODEL_REVISION}`);
  assert.equal(voices[0].syntheticDesign, true);
  assert.equal(voices[0].professionalClone, false);
});

test('Dia synthesis authenticates, pins the model revision, and returns a bounded MP3', async () => {
  let request;
  const result = await speak({
    text: '[S2] Hi Alex (laughs), your RT is still in the cart.',
    voiceID: 'dia_vici_sunny_v1',
    modelID: `${MODEL_ID}@${MODEL_REVISION}`,
    env: ENV,
    fetchImpl: async (url, options) => {
      if (options.method === 'GET') return HEALTHY();
      request = { url, options };
      return new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }
  });
  assert.equal(request.url, ENV.DIA_TTS_ENDPOINT);
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers.Authorization, `Bearer ${ENV.DIA_TTS_API_KEY}`);
  const body = JSON.parse(request.options.body);
  assert.deepEqual(body, {
    model: MODEL_ID,
    model_revision: MODEL_REVISION,
    voice: 'dia_vici_sunny_v1',
    input: 'Hi Alex , your RT is still in the cart.',
    response_format: 'mp3'
  });
  assert.equal(result.contentType, 'audio/mpeg');
  assert.equal(validMP3(result.audio), true);
});

test('Dia keeps a sleeping Space awake with bounded health probes before synthesis', async () => {
  let attempts = 0;
  let waits = 0;
  let synthesisAttempts = 0;
  const result = await speak({
    text: 'Hi Alex, your RT is still in the cart.',
    voiceID: 'dia_vici_sunny_v1',
    env: { ...ENV, DIA_WAKE_RETRY_MS: '500' },
    waitImpl: async milliseconds => {
      assert.equal(milliseconds, 500);
      waits += 1;
    },
    fetchImpl: async (url, options) => {
      attempts += 1;
      if (options.method === 'GET') {
        return attempts < 3
          ? new Response('', { status: 503, headers: { 'content-type': 'text/plain' } })
          : HEALTHY();
      }
      synthesisAttempts += 1;
      return new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }
  });
  assert.equal(attempts, 4);
  assert.equal(waits, 2);
  assert.equal(synthesisAttempts, 1);
  assert.equal(validMP3(result.audio), true);
  assert.equal(retryDelayValue('999999'), 15_000);
});

test('Dia synthesis rejects unauthorized profiles and malformed provider responses', async () => {
  await assert.rejects(speak({ text: 'Hello.', voiceID: 'arbitrary_clone', env: ENV }),
    error => error.code === 'DIA_PROFILE_INVALID');
  await assert.rejects(speak({ text: 'Hello.', voiceID: 'dia_vici_sunny_v1', env: ENV,
    fetchImpl: async (_url, options) => options.method === 'GET' ? HEALTHY()
      : new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }) }),
  error => error.code === 'DIA_AUDIO_INVALID');
  await assert.rejects(speak({ text: 'Hello.', voiceID: 'dia_vici_sunny_v1', env: ENV,
    fetchImpl: async (_url, options) => options.method === 'GET' ? HEALTHY()
      : new Response('', { status: 401, headers: { 'content-type': 'text/plain' } }) }),
  error => error.code === 'DIA_KEY_REJECTED');
});

test('recovery voice service dispatches preview and saves immutable Dia metadata', async () => {
  const [diaVoice] = await listDiaVoices({ env: ENV });
  let synthesis;
  let saved;
  const client = { from(table) {
    assert.equal(table, 'luko_cart_recovery_settings');
    return { upsert(patch) {
      saved = patch;
      return { select() { return { async single() { return { data: patch, error: null }; } }; } };
    } };
  } };
  const service = createCartRecoveryService({
    client,
    env: ENV,
    listDiaVoices: async () => [diaVoice],
    synthesizeDiaSpeech: async input => {
      synthesis = input;
      return { audio: MP3, contentType: 'audio/mpeg' };
    }
  });
  const catalogue = await service.listRecoveryVoices();
  assert.deepEqual(catalogue.voices, [diaVoice]);
  const preview = await service.previewRecoveryVoice({ voiceID: diaVoice.id });
  assert.equal(synthesis.text, RECOVERY_VOICE_PREVIEW_TEXT);
  assert.equal(synthesis.modelID, `${MODEL_ID}@${MODEL_REVISION}`);
  assert.equal(preview.voice.provider, 'dia');
  await service.updateSettings({ input: { voiceEnabled: false, voiceId: diaVoice.id }, actor: { id: 1 } });
  assert.equal(saved.voice_provider, 'dia');
  assert.equal(saved.voice_model_id, `${MODEL_ID}@${MODEL_REVISION}`);
});

test('Dia remains hidden until explicitly enabled and fully configured', async () => {
  const service = createCartRecoveryService({
    client: {},
    env: { DIA_TTS_ENDPOINT: ENV.DIA_TTS_ENDPOINT, DIA_TTS_API_KEY: ENV.DIA_TTS_API_KEY },
    listVoices: async () => [],
    listDiaVoices: async () => { throw new Error('Dia catalogue should not be called'); }
  });
  const catalogue = await service.listRecoveryVoices();
  assert.deepEqual(catalogue.voices, []);
});

test('migration, GPU service, and iOS client preserve provider and long preview behavior', () => {
  const migration = fs.readFileSync(path.join(ROOT, 'scripts/dia-voice-provider-migration.sql'), 'utf8');
  const python = fs.readFileSync(path.join(ROOT, 'services/dia-tts/app.py'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(ROOT, 'services/dia-tts/Dockerfile'), 'utf8');
  const models = fs.readFileSync(path.join(ROOT, 'ios/ViciInbox/Core/MobileModels.swift'), 'utf8');
  const api = fs.readFileSync(path.join(ROOT, 'ios/ViciInbox/Core/APIClient.swift'), 'utf8');
  assert.match(migration, /DROP CONSTRAINT IF EXISTS luko_cart_recovery_settings_voice_provider_check/);
  assert.match(migration, /'elevenlabs','qwen','dia'/);
  assert.match(migration, /does not enable automation/);
  assert.match(python, new RegExp(MODEL_REVISION));
  assert.match(python, /CONTROL_PATTERN/);
  assert.match(python, /PRODUCTION_SEEDS = \(1057, 2467, 6151\)/);
  assert.match(python, /_passes_speech_shape/);
  assert.doesNotMatch(python, /\/internal\/candidate/);
  assert.match(python, /async with runtime\.lock/);
  assert.match(dockerfile, /876125e461a03b157ec905b0fe8b57a0f8b9e7a0/);
  assert.match(models, /if provider == "dia" \{ return "Dia voice" \}/);
  assert.match(api, /timeout: 510/);
});
