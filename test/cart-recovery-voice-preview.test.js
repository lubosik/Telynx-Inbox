'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createCartRecoveryService,
  RECOVERY_VOICE_PREVIEW_TEXT
} = require('../lib/cart-recovery/service');
const { ROUTE_POLICY } = require('../lib/route-policy');

const ROOT = path.join(__dirname, '..');

function previewService({ voices, synthesizeSpeech } = {}) {
  return createCartRecoveryService({
    client: {},
    env: { ELEVENLABS_API_KEY: 'XI_TEST' },
    listVoices: async () => voices || [],
    synthesizeSpeech: synthesizeSpeech || (async () => ({
      audio: Buffer.from('ID3-preview-audio'), contentType: 'audio/mpeg'
    }))
  });
}

test('recovery voice preview authorizes the voice and synthesizes the fixed safe sample', async () => {
  let request;
  const service = previewService({
    voices: [
      { id: 'voice-verified-123', name: 'Vin', verified: true },
      { id: 'voice-unverified-1', name: 'Draft', verified: false }
    ],
    synthesizeSpeech: async input => {
      request = input;
      return { audio: Buffer.from('ID3-preview-audio'), contentType: 'audio/mpeg' };
    }
  });

  const result = await service.previewRecoveryVoice({ voiceID: 'voice-verified-123' });
  assert.equal(request.voiceID, 'voice-verified-123');
  assert.equal(request.text, RECOVERY_VOICE_PREVIEW_TEXT);
  assert.doesNotMatch(request.text, /customer|first_name|phone|order number/i);
  assert.equal(result.contentType, 'audio/mpeg');
  assert.ok(Buffer.isBuffer(result.audio));
  assert.deepEqual(result.voice, { id: 'voice-verified-123', name: 'Vin' });
});

test('recovery voice preview rejects malformed and unauthorized voices before synthesis', async () => {
  let syntheses = 0;
  const service = previewService({
    voices: [
      { id: 'voice-verified-123', name: 'Vin', verified: true },
      { id: 'voice-unverified-1', name: 'Draft', verified: false }
    ],
    synthesizeSpeech: async () => {
      syntheses += 1;
      return { audio: Buffer.from('audio'), contentType: 'audio/mpeg' };
    }
  });

  await assert.rejects(service.previewRecoveryVoice({ voiceID: '../voice' }),
    error => error.code === 'INVALID_RECOVERY_VOICE' && error.status === 400);
  await assert.rejects(service.previewRecoveryVoice({ voiceID: 'voice-unverified-1' }),
    error => error.code === 'INVALID_RECOVERY_VOICE' && error.status === 404);
  assert.equal(syntheses, 0);
});

test('empty preview audio fails clearly instead of returning a silent success', async () => {
  const service = previewService({
    voices: [{ id: 'voice-verified-123', name: 'Vin', verified: true }],
    synthesizeSpeech: async () => ({ audio: Buffer.alloc(0), contentType: 'audio/mpeg' })
  });
  await assert.rejects(service.previewRecoveryVoice({ voiceID: 'voice-verified-123' }),
    error => error.code === 'RECOVERY_VOICE_PREVIEW_FAILED' && error.status === 502);
});

test('preview route is permissioned and iOS plays authenticated bytes through spoken audio', () => {
  assert.ok(ROUTE_POLICY.some(entry => entry.method === 'POST'
    && entry.path === '/api/cart-recovery/voices/:voiceId/preview'
    && entry.permission === 'automation.read' && entry.audit === true));

  const api = fs.readFileSync(path.join(ROOT, 'ios/ViciInbox/Core/APIClient.swift'), 'utf8');
  const view = fs.readFileSync(path.join(ROOT, 'ios/ViciInbox/UI/WorkspaceViews.swift'), 'utf8');
  assert.match(api, /func previewCartRecoveryVoice\(id: String\) async throws -> Data/);
  assert.match(api, /\/api\/cart-recovery\/voices\/\\\(encodedPathSegment\(id\)\)\/preview/);
  assert.match(view, /APIClient\.shared\.previewCartRecoveryVoice\(id: voice\.id\)/);
  assert.match(view, /AVAudioPlayer\(data: data\)/);
  assert.match(view, /setCategory\(\.playback, mode: \.spokenAudio/);
  assert.doesNotMatch(view, /AVPlayer\(url:/,
    'recovery previews must not depend on ElevenLabs preview URL MIME metadata');
  assert.match(view, /That preview could not be played/,
    'a failed preview must explain itself instead of ending silently');
});
