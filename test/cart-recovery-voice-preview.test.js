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
const { PREFERRED_US_VOICE_IDS } = require('../lib/cart-recovery/recovery-voices');

const ROOT = path.join(__dirname, '..');
const VIN_ID = PREFERRED_US_VOICE_IDS[0];

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
      { id: VIN_ID, name: 'Mark', accent: 'american', verified: true,
        category: 'professional', language: 'en', professionalClone: true, sharingStatus: 'copied' },
      { id: 'voice-unverified-1', name: 'Draft', accent: 'american', verified: false }
    ],
    synthesizeSpeech: async input => {
      request = input;
      return { audio: Buffer.from('ID3-preview-audio'), contentType: 'audio/mpeg' };
    }
  });

  const result = await service.previewRecoveryVoice({ voiceID: VIN_ID });
  assert.equal(request.voiceID, VIN_ID);
  assert.equal(request.text, RECOVERY_VOICE_PREVIEW_TEXT);
  assert.doesNotMatch(request.text, /customer|first_name|phone|order number/i);
  assert.equal(result.contentType, 'audio/mpeg');
  assert.ok(Buffer.isBuffer(result.audio));
  assert.deepEqual(result.voice, { id: VIN_ID, name: 'Mark', provider: 'elevenlabs' });
});

test('recovery voice preview rejects malformed and unauthorized voices before synthesis', async () => {
  let syntheses = 0;
  const service = previewService({
    voices: [
      { id: VIN_ID, name: 'Mark', accent: 'american', verified: true,
        category: 'professional', language: 'en', professionalClone: true, sharingStatus: 'copied' },
      { id: 'voice-unverified-1', name: 'Draft', accent: 'american', verified: false }
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
    voices: [{ id: VIN_ID, name: 'Mark', accent: 'american', verified: true,
      category: 'professional', language: 'en', professionalClone: true, sharingStatus: 'copied' }],
    synthesizeSpeech: async () => ({ audio: Buffer.alloc(0), contentType: 'audio/mpeg' })
  });
  await assert.rejects(service.previewRecoveryVoice({ voiceID: VIN_ID }),
    error => error.code === 'RECOVERY_VOICE_PREVIEW_FAILED' && error.status === 502);
});

test('delivered voicemail can be replayed from its saved script without recording the customer call', async () => {
  const journeyID = '11111111-1111-4111-8111-111111111111';
  const attempt = { id: '22222222-2222-4222-8222-222222222222', voice_id: VIN_ID,
    voice_model_id: 'eleven_turbo_v2_5', rendered_human_text: 'Human message',
    rendered_voicemail_text: 'Hi Alex, call +18005550123 to stop future calls.',
    human_message_played_at: null, voicemail_played_at: '2026-09-18T14:00:00Z', dry_run: false };
  const client = { from(table) {
    assert.equal(table, 'luko_cart_voice_attempts');
    const q = { select() { return q; }, eq() { return q; }, order() { return q; },
      limit() { return q; }, async maybeSingle() { return { data: attempt, error: null }; } };
    return q;
  } };
  let synthesis;
  const service = createCartRecoveryService({ client, env: { ELEVENLABS_API_KEY: 'XI_TEST' },
    listVoices: async () => [{ id: VIN_ID, accent: 'american', gender: 'male', verified: true,
      category: 'professional', language: 'en', professionalClone: true, sharingStatus: 'copied' }],
    synthesizeSpeech: async input => {
      synthesis = input;
      return { audio: Buffer.from('ID3-voicemail-preview'), contentType: 'audio/mpeg' };
    } });
  const result = await service.previewRecoveryAttempt({ journeyId: journeyID, branch: 'voicemail' });
  assert.equal(synthesis.text, attempt.rendered_voicemail_text);
  assert.equal(synthesis.voiceID, VIN_ID);
  assert.equal(synthesis.env.ELEVENLABS_MODEL, attempt.voice_model_id);
  assert.equal(result.branch, 'voicemail');
  assert.ok(Buffer.isBuffer(result.audio));
  await assert.rejects(service.previewRecoveryAttempt({ journeyId: journeyID, branch: 'human' }),
    error => error.status === 404);
});

test('preview route is permissioned and iOS plays authenticated bytes through spoken audio', () => {
  assert.ok(ROUTE_POLICY.some(entry => entry.method === 'POST'
    && entry.path === '/api/cart-recovery/voices/:voiceId/preview'
    && entry.permission === 'automation.read' && entry.audit === true));
  assert.ok(ROUTE_POLICY.some(entry => entry.method === 'POST'
    && entry.path === '/api/cart-recovery/journeys/:id/voice-attempt/preview'
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
  assert.match(view, /not a recording of the customer call/);
});
