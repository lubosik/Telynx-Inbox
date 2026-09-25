'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  TARGET_MODEL, configuration, designVoice, downloadAudio, listDesignedVoices,
  safeAudioURL, speak
} = require('../lib/assistant/qwen-voice');
const { createCartRecoveryService, RECOVERY_VOICE_PREVIEW_TEXT } = require('../lib/cart-recovery/service');
const { PROFILES } = require('../scripts/design-qwen-recovery-voices');

const ROOT = path.join(__dirname, '..');
const ENV = { DASHSCOPE_API_KEY: 'test-key-never-log', DASHSCOPE_WORKSPACE_ID: 'ws-test123',
  QWEN_VOICE_CATALOGUE_ENABLED: 'true' };

test('Qwen configuration derives the fixed Singapore workspace host and fails closed', () => {
  assert.equal(configuration(ENV).origin, 'https://ws-test123.ap-southeast-1.maas.aliyuncs.com');
  assert.throws(() => configuration({ DASHSCOPE_API_KEY: 'x', DASHSCOPE_WORKSPACE_ID: 'https://evil.example' }),
    error => error.code === 'QWEN_WORKSPACE_INVALID');
  assert.throws(() => configuration({ DASHSCOPE_WORKSPACE_ID: 'ws-test123' }),
    error => error.code === 'QWEN_VOICE_NOT_CONFIGURED');
});

test('Qwen catalogue is account-scoped and exposes only English Vici VoiceDesign assets', async () => {
  let request;
  const voices = await listDesignedVoices({ env: ENV, fetchImpl: async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ output: { voice_list: [
      { voice: 'qwen-tts-vd-vici_miami-voice-20260925183830381-1347', language: 'en', target_model: TARGET_MODEL,
        voice_prompt: 'A highly realistic young adult American female voice.' },
      { voice: 'other_voice', language: 'en', target_model: TARGET_MODEL },
      { voice: 'qwen-tts-vd-vici_wrong-voice-20260925183830381-1347', language: 'zh', target_model: TARGET_MODEL },
      { voice: 'qwen-tts-vd-vici_old-voice-20260925183830381-1347', language: 'en', target_model: 'different-model' }
    ] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  assert.equal(request.url, 'https://ws-test123.ap-southeast-1.maas.aliyuncs.com/api/v1/services/audio/tts/customization');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key-never-log');
  assert.deepEqual(JSON.parse(request.options.body).input, { action: 'list', page_size: 100, page_index: 0 });
  assert.equal(voices.length, 1);
  assert.equal(voices[0].provider, 'qwen');
  assert.equal(voices[0].name, 'Maya Social');
  assert.equal(voices[0].verified, true);
  assert.equal(voices[0].syntheticDesign, true);
});

test('Qwen VoiceDesign sends the approved request shape and parses its WAV preview', async () => {
  let body;
  const result = await designVoice({
    preferredName: 'vici_miami',
    voicePrompt: 'A realistic young adult American female voice.',
    previewText: 'Hello from Vici.', env: ENV,
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response(JSON.stringify({ output: {
        voice: 'qwen-tts-vd-vici_miami-voice-20260925183830381-1347', target_model: TARGET_MODEL,
        preview_audio: { data: Buffer.from('RIFF-test').toString('base64') }
      } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  assert.equal(body.model, 'qwen-voice-design');
  assert.equal(body.input.action, 'create');
  assert.equal(body.input.language, 'en');
  assert.equal(body.input.target_model, TARGET_MODEL);
  assert.equal(result.audio.toString(), 'RIFF-test');
  assert.equal(result.contentType, 'audio/wav');
});

test('Qwen synthesis downloads only bounded audio from an Alibaba HTTPS location', async () => {
  const calls = [];
  const result = await speak({ text: 'Hello from Vin.',
    voiceID: 'qwen-tts-vd-vici_miami-voice-20260925183830381-1347', env: ENV,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.includes('/multimodal-generation/')) {
        return new Response(JSON.stringify({ output: { audio: {
          url: 'https://dashscope-result-sgp.oss-ap-southeast-1.aliyuncs.com/signed/audio.wav'
        } } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(Buffer.from('RIFF-speech'), { status: 200,
        headers: { 'content-type': 'audio/wav', 'content-length': '11' } });
    } });
  assert.equal(JSON.parse(calls[0].options.body).model, TARGET_MODEL);
  assert.deepEqual(JSON.parse(calls[0].options.body).input,
    { text: 'Hello from Vin.', voice: 'qwen-tts-vd-vici_miami-voice-20260925183830381-1347' });
  assert.equal(calls[1].options.redirect, 'error');
  assert.equal(result.audio.toString(), 'RIFF-speech');
  assert.equal(result.characters, 15);
});

test('Qwen audio location validation rejects arbitrary hosts and oversized responses', async () => {
  assert.equal(safeAudioURL('https://169.254.169.254/metadata'), null);
  assert.equal(safeAudioURL('http://example.aliyuncs.com/audio.wav'), null);
  assert.equal(safeAudioURL('https://safe.aliyuncs.com/audio.wav'), null);
  assert.equal(safeAudioURL('http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio.wav'),
    'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio.wav');
  await assert.rejects(downloadAudio('https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio.wav', {
    fetchImpl: async () => new Response('x', { status: 200,
      headers: { 'content-type': 'audio/wav', 'content-length': String(20 * 1024 * 1024) } })
  }), error => error.code === 'QWEN_AUDIO_DOWNLOAD_FAILED');
});

test('recovery catalogue previews Qwen through the Qwen provider and saves immutable provider metadata', async () => {
  const qwenVoice = { id: 'qwen-tts-vd-vici_miami-voice-20260925183830381-1347', name: 'Maya Social', provider: 'qwen',
    providerLabel: 'Qwen VoiceDesign', modelId: TARGET_MODEL, accent: 'american', gender: 'female',
    language: 'en', category: 'designed', verified: true, syntheticDesign: true };
  let synthesis;
  let saved;
  const client = { from(table) {
    assert.equal(table, 'luko_cart_recovery_settings');
    return { upsert(patch) {
      saved = patch;
      return { select() { return { async single() { return { data: patch, error: null }; } }; } };
    } };
  } };
  const service = createCartRecoveryService({ client, env: ENV,
    listQwenVoices: async () => [qwenVoice],
    synthesizeQwenSpeech: async input => {
      synthesis = input;
      return { audio: Buffer.from('RIFF-preview'), contentType: 'audio/wav' };
    } });
  const catalogue = await service.listRecoveryVoices();
  assert.deepEqual(catalogue.voices, [qwenVoice]);
  const preview = await service.previewRecoveryVoice({ voiceID: qwenVoice.id });
  assert.equal(synthesis.text, RECOVERY_VOICE_PREVIEW_TEXT);
  assert.equal(synthesis.modelID, TARGET_MODEL);
  assert.equal(preview.contentType, 'audio/wav');
  assert.equal(preview.voice.provider, 'qwen');
  await service.updateSettings({ input: { voiceEnabled: false, voiceId: qwenVoice.id }, actor: { id: 1 } });
  assert.equal(saved.voice_provider, 'qwen');
  assert.equal(saved.voice_model_id, TARGET_MODEL);
});

test('the Qwen pilot is fixed, gated, non-customer-facing, and migration/UI are provider-aware', () => {
  assert.equal(PROFILES.length, 6);
  assert.equal(new Set(PROFILES.map(profile => profile.preferredName)).size, PROFILES.length);
  assert.ok(PROFILES.every(profile => profile.preferredName.startsWith('vici_')));
  const script = fs.readFileSync(path.join(ROOT, 'scripts/design-qwen-recovery-voices.js'), 'utf8');
  assert.match(script, /QWEN_VOICE_DESIGN_CONFIRM/);
  assert.doesNotMatch(script, /createOutboundCall|sendMessage|TELNYX_API_KEY/);
  const migration = fs.readFileSync(path.join(ROOT, 'scripts/qwen-voice-provider-migration.sql'), 'utf8');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS voice_provider/);
  assert.match(migration, /v_voice_provider,p_attempt->>'voice_id'/);
  assert.match(migration, /does not create a\s+-- voice, place a call/i);
  const models = fs.readFileSync(path.join(ROOT, 'ios/ViciInbox/Core/MobileModels.swift'), 'utf8');
  const view = fs.readFileSync(path.join(ROOT, 'ios/ViciInbox/UI/WorkspaceViews.swift'), 'utf8');
  assert.match(models, /var voiceProvider: String/);
  assert.match(models, /let syntheticDesign: Bool\?/);
  assert.match(view, /Designed voice/);
});

test('Qwen designed voices stay out of the production picker unless explicitly re-enabled', async () => {
  const service = createCartRecoveryService({
    client: {},
    env: { DASHSCOPE_API_KEY: 'configured', DASHSCOPE_WORKSPACE_ID: 'ws-test123' },
    listVoices: async () => [],
    listQwenVoices: async () => { throw new Error('Qwen catalogue should not be called'); }
  });
  const catalogue = await service.listRecoveryVoices();
  assert.deepEqual(catalogue.voices, []);
  assert.deepEqual(catalogue.providerWarnings, []);
});
