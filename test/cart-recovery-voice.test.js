'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { listAccountVoices } = require('../lib/assistant/voice');
const { PREFERRED_US_VOICE_IDS, curatedRecoveryVoices } = require('../lib/cart-recovery/recovery-voices');
const { attributionDecision, attributionPayload } = require('../lib/cart-recovery/attribution');
const { createCartRecoveryService, normalizeEvent } = require('../lib/cart-recovery/service');
const { createVoiceEventHandler, decodeClientState } = require('../lib/cart-recovery/voice-events');
const { cleanupVoiceAudio, prepareVoiceAudio, signedVoiceAudioURL, storagePath } = require('../lib/cart-recovery/voice-audio-cache');
const {
  amdBranch,
  applyCurrentVoiceConsent,
  insideCallingWindow,
  isSpokenOptOut,
  productPhrase,
  renderVoiceScripts,
  voiceConfiguration
} = require('../lib/cart-recovery/voice');
const {
  createOutboundCall,
  playAudioOnCall,
  speakPremiumOnCall,
  startTranscription
} = require('../lib/telnyx-api');
const { decodeVerifiedTelnyxEvent } = require('../lib/telnyx-webhook-claim');

const NOW = new Date('2026-09-15T14:00:00.000Z');
const RECOVERY_ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';

const VOICE_ENV = {
  LUKO_WP_STORE_ID: 'vici',
  LUKO_WP_URL: 'https://vicipeptides.com',
  LUKO_WP_SIGNING_SECRET: 'voice-test-secret-that-is-long-enough-123456',
  TELNYX_API_KEY: 'KEY_TEST',
  TELNYX_PHONE_NUMBER: '+12125550100',
  TELNYX_CONNECTION_ID: 'connection-1',
  ELEVENLABS_API_KEY: 'XI_TEST',
  ELEVENLABS_VIN_VOICE_ID: 'vin-voice',
  ELEVENLABS_MODEL: 'eleven_turbo_v2_5',
  TELNYX_ELEVENLABS_API_KEY_REF: 'elevenlabs-key-ref',
  VICI_LIVE_TRANSFER_NUMBER: '+12125550199',
  VICI_VOICE_OPT_OUT_TOLL_FREE_NUMBER: '+18005550100'
};

function connectorEvent(consent = {}) {
  return {
    event_id: 'cart-event-voice-1',
    event_type: 'cart.updated',
    occurred_at: NOW.toISOString(),
    store: 'vici',
    customer: {
      wordpress_user_id: 42,
      first_name: 'Maya',
      email: 'maya@example.com',
      phone: '+12125550123'
    },
    consent: {
      granted: true,
      phone: '+12125550123',
      disclosure: 'Combined SMS and AI voice disclosure.',
      version: 'vici_marketing_sms_voice_v1',
      source: 'vici_registration',
      occurred_at: NOW.toISOString(),
      privacy_url: 'https://vicipeptides.com/privacy-policy/',
      terms_url: 'https://vicipeptides.com/terms/',
      ...consent
    },
    cart: {
      external_cart_id: 'cart-voice-12345',
      version: 1,
      currency: 'USD',
      total: '120.00',
      last_activity_at: NOW.toISOString(),
      expires_at: '2026-09-22T14:00:00.000Z',
      recovery_url: `https://vicipeptides.com/r/${'v'.repeat(43)}`,
      items: [{ product_id: 9, quantity: 1, product_name: 'RT', product_url: 'https://vicipeptides.com/product/rt/' }]
    }
  };
}

function response(body = {}) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

test('voice copy is safe, personalized, singular only for one item, and rejects unsafe template edits', () => {
  assert.equal(productPhrase([{ product_name: 'RT_10MG', product_id: 9 }]), 'RT 10MG');
  assert.equal(productPhrase([{ product_name: 'RT' }, { product_name: 'BPC-157' }]), 'the items');
  assert.equal(productPhrase([{ product_name: 'Internal name', product_id: 9 }], { 9: 'RT' }), 'RT');

  const scripts = renderVoiceScripts({
    firstName: 'Maya Jones',
    items: [{ product_name: 'RT' }],
    tollFreeNumber: '+18005550100'
  });
  assert.match(scripts.human, /^Hi Maya, this is an automated message/);
  assert.match(scripts.human, /You left RT in your cart/);
  assert.match(scripts.human, /sent you a text earlier/i);
  assert.match(scripts.human, /say "stop" or press 9/i);
  assert.match(scripts.human, /customer care team, press 1/i);
  assert.ok(scripts.human.indexOf('still interested') < scripts.human.indexOf('press 1'),
    'transfer and opt-out controls belong after the recovery message');
  assert.match(scripts.voicemail, /\+18005550100/);
  assert.doesNotMatch(scripts.voicemail, /press 9/);

  assert.throws(() => renderVoiceScripts({
    firstName: 'Maya', items: [{ product_name: 'RT' }], tollFreeNumber: '+18005550100',
    humanTemplate: 'Hi {{first_name}}, your cart is waiting.'
  }), { code: 'INVALID_VOICE_HUMAN_TEMPLATE' });
  assert.throws(() => renderVoiceScripts({
    firstName: 'Maya', items: [{ product_name: 'RT' }], tollFreeNumber: '',
  }), { code: 'VOICE_OPT_OUT_NUMBER_REQUIRED' });
});

test('spoken opt-out and AMD routing are deterministic and do not match ordinary conversation', () => {
  for (const phrase of ['stop', 'please stop calling me', "don't call me", 'remove me', 'no more calls']) {
    assert.equal(isSpokenOptOut(phrase), true, phrase);
  }
  assert.equal(isSpokenOptOut('I can stop by the shop tomorrow'), true,
    'the required standalone STOP keyword remains a deterministic opt-out');
  assert.equal(isSpokenOptOut('I am still interested'), false);
  assert.equal(amdBranch('human_business'), 'human');
  assert.equal(amdBranch('machine_end_beep'), 'machine');
  assert.equal(amdBranch('fax_detected'), 'undeliverable');
  assert.equal(amdBranch('not_a_sure_result'), 'unknown');
});

test('calling windows use the customer timezone, include the start, and exclude the end', () => {
  assert.equal(insideCallingWindow({ now: new Date('2026-09-15T13:00:00Z'), timeZone: 'America/New_York', start: '09:00', end: '20:00' }), true);
  assert.equal(insideCallingWindow({ now: new Date('2026-09-16T00:00:00Z'), timeZone: 'America/New_York', start: '09:00', end: '20:00' }), false);
  assert.equal(insideCallingWindow({ now: NOW, timeZone: 'Not/A_Timezone' }), false);
  assert.equal(insideCallingWindow({ now: NOW, timeZone: 'America/New_York', start: '20:00', end: '09:00' }), false,
    'overnight windows fail closed rather than calling at an ambiguous time');
});

test('current combined voice consent resolves only an unknown GHL observation', () => {
  assert.deepEqual(applyCurrentVoiceConsent({ eligible: false, phone: '+12125550123', reason: 'dnd_unknown' }), {
    eligible: true, phone: '+12125550123', reason: 'eligible_with_current_voice_consent'
  });
  for (const reason of [
    'dnd', 'opted_out', 'authoritative_suppression', 'internal_or_test_identity',
    'eligibility_check_failed', 'consent_not_recorded'
  ]) {
    assert.equal(applyCurrentVoiceConsent({ eligible: false, reason }).eligible, false, reason);
  }
  assert.equal(applyCurrentVoiceConsent({ eligible: true, reason: 'eligible' }).eligible, true);
});

test('voice provider configuration fails closed and creates the Telnyx ElevenLabs voice identifier', () => {
  const valid = voiceConfiguration(VOICE_ENV, {});
  assert.equal(valid.valid, true);
  assert.equal(valid.telnyxVoice, 'ElevenLabs.eleven_turbo_v2_5.vin-voice');

  const invalid = voiceConfiguration({ ...VOICE_ENV, TELNYX_API_KEY: '', TELNYX_CONNECTION_ID: '',
    VICI_LIVE_TRANSFER_NUMBER: VOICE_ENV.TELNYX_PHONE_NUMBER }, {});
  assert.deepEqual(invalid.errors.sort(), ['telnyx_api_key_missing', 'telnyx_connection_missing', 'transfer_loop']);

  const inboxTransfer = voiceConfiguration({
    ...VOICE_ENV,
    VICI_LIVE_TRANSFER_NUMBER: '',
    TELNYX_IOS_SIP_USERNAME: 'vici-ios-agent',
    TELNYX_IOS_SIP_PASSWORD: 'test-password'
  }, { voice_human_answer_mode: 'PRERECORDED' });
  assert.equal(inboxTransfer.valid, true);
  assert.equal(inboxTransfer.transferNumber, 'sip:vici-ios-agent@sip.telnyx.com');

  const noTransfer = voiceConfiguration({
    ...VOICE_ENV,
    VICI_LIVE_TRANSFER_NUMBER: '',
    TELNYX_IOS_SIP_USERNAME: '', TELNYX_IOS_SIP_PASSWORD: '',
    TELNYX_SIP_USERNAME: '', TELNYX_SIP_PASSWORD: ''
  }, { voice_human_answer_mode: 'PRERECORDED' });
  assert.ok(noTransfer.errors.includes('transfer_number_missing'));
});

test('settings readiness includes the separate production provider approval gate', async () => {
  const settingsRow = {
    voice_enabled: true,
    voice_id: 'vin-voice',
    voice_model_id: 'eleven_turbo_v2_5',
    voice_human_answer_mode: 'DISABLED',
    voice_compliance_approved: true,
    voice_human_timing_approved: false
  };
  function settingsClient() {
    return {
      from(table) {
        assert.equal(table, 'luko_cart_recovery_settings');
        const query = {
          select() { return query; },
          eq() { return query; },
          async maybeSingle() { return { data: settingsRow, error: null }; }
        };
        return query;
      }
    };
  }

  const blocked = await createCartRecoveryService({ client: settingsClient(), env: VOICE_ENV }).getSettings();
  assert.equal(blocked.settings.voiceConfigurationReady, true);
  assert.equal(blocked.settings.voiceProductionReady, false);
  assert.ok(blocked.settings.voiceBlockers.includes('provider_approval_missing'));

  const approved = await createCartRecoveryService({
    client: settingsClient(), env: { ...VOICE_ENV, LUKO_VOICE_PROVIDER_APPROVED: 'true',
      VICI_VOICE_OPT_OUT_HANDLER_VERIFIED: 'true', CART_RECOVERY_VOICE_ENABLED: 'true', VOICE_DRY_RUN: 'false' }
  }).getSettings();
  assert.equal(approved.settings.voiceProductionReady, true);
  assert.doesNotMatch(approved.settings.voiceBlockers.join(','), /provider_approval_missing/);
});

test('voice choice saves without a toll-free number but production remains locked', async () => {
  let saved;
  const client = { from(table) {
    assert.equal(table, 'luko_cart_recovery_settings');
    return { upsert(patch) {
      saved = patch;
      return { select() { return { async single() { return { data: patch, error: null }; } }; } };
    } };
  } };
  const id = PREFERRED_US_VOICE_IDS[0];
  const service = createCartRecoveryService({ client, env: { ...VOICE_ENV,
    VICI_VOICE_OPT_OUT_TOLL_FREE_NUMBER: '' },
    listVoices: async () => [{ id, name: 'Mark', accent: 'american', category: 'professional',
      gender: 'male', language: 'en', professionalClone: true, verified: true }] });
  const result = await service.updateSettings({ input: {
    voiceEnabled: true, voiceId: id, voiceHumanAnswerMode: 'DISABLED'
  }, actor: { id: 1 } });
  assert.equal(saved.voice_enabled, true);
  assert.equal(saved.voice_id, id);
  assert.equal(saved.voice_opt_out_toll_free_number, null);
  assert.equal(result.settings.voiceProductionReady, false);
  assert.ok(result.settings.voiceBlockers.includes('toll_free_opt_out_missing'));
  assert.ok(result.settings.voiceBlockers.includes('toll_free_opt_out_handler_unverified'));
  assert.ok(result.settings.voiceBlockers.includes('provider_approval_missing'));
});

test('the Vin picker contains only the owner-approved Gracie Social professional clone', () => {
  const catalog = PREFERRED_US_VOICE_IDS.map((id, index) => ({ id, accent: 'american',
    gender: 'female', language: 'en', professionalClone: true, verified: true,
    category: 'professional', sharingStatus: 'copied' }));
  catalog.push({ id: 'british-voice', accent: 'british', gender: 'male', verified: true,
    category: 'professional', sharingStatus: 'copied' });
  catalog.push({ id: 'generated-voice', accent: 'american', gender: 'female', verified: true,
    category: 'generated', sharingStatus: null });
  catalog.push({ id: 'private-clone', accent: 'american', gender: 'female', verified: true,
    category: 'cloned', sharingStatus: null });
  catalog.push({ id: 'unverified-voice', accent: 'american', gender: 'male', verified: false,
    category: 'professional', sharingStatus: 'copied' });
  const shown = curatedRecoveryVoices(catalog);
  assert.deepEqual(shown.map(voice => voice.id), PREFERRED_US_VOICE_IDS);
  assert.deepEqual(PREFERRED_US_VOICE_IDS, ['T7eLpgAAhoXHlrNajG8v']);

  for (const rejected of [
    { category: 'premade', sharingStatus: null },
    { category: 'generated', sharingStatus: null },
    { category: 'cloned', sharingStatus: null },
    { category: 'professional', professionalClone: false },
    { category: 'professional', language: 'es' }
  ]) {
    const changed = catalog.map(voice => voice.id === PREFERRED_US_VOICE_IDS[0]
      ? { ...voice, ...rejected } : voice);
    assert.equal(curatedRecoveryVoices(changed).some(voice => voice.id === PREFERRED_US_VOICE_IDS[0]), false);
  }
});

test('combined registration grants voice only with both explicit flags and the exact consent version', () => {
  const explicit = normalizeEvent(connectorEvent({ voice_marketing_consent: true, ai_voice_consent: true }), VOICE_ENV, NOW);
  assert.equal(explicit.consent.sms_consent, true);
  assert.equal(explicit.consent.voice_marketing_consent, true);
  assert.equal(explicit.consent.ai_voice_consent, true);

  const smsOnly = normalizeEvent(connectorEvent({ voice_marketing_consent: false, ai_voice_consent: false }), VOICE_ENV, NOW);
  assert.equal(smsOnly.consent.granted, true);
  assert.equal(smsOnly.consent.voice_marketing_consent, false);
  assert.equal(smsOnly.consent.ai_voice_consent, false);

  const oldVersion = normalizeEvent(connectorEvent({
    version: 'vici_sms_marketing_v1', voice_marketing_consent: true, ai_voice_consent: true
  }), VOICE_ENV, NOW);
  assert.equal(oldVersion.consent.sms_consent, true);
  assert.equal(oldVersion.consent.voice_marketing_consent, false);
  assert.equal(oldVersion.consent.ai_voice_consent, false);
});

test('voice worker blocks a claimed call when current durable voice consent is absent', async () => {
  const calls = [];
  const client = {
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === 'claim_luko_cart_voice_calls') return { data: [{
        id: RECOVERY_ID, voice_claim_token: '33333333-3333-4333-8333-333333333333',
        contact_phone: '+12125550123'
      }], error: null };
      return { data: true, error: null };
    },
    from(table) {
      assert.equal(table, 'luko_voice_consent_events');
      const query = {
        select() { return query; }, eq() { return query; }, order() { return query; },
        async limit() { return { data: [], error: null }; }
      };
      return query;
    }
  };
  const service = createCartRecoveryService({
    client,
    env: { ...VOICE_ENV, CART_RECOVERY_VOICE_ENABLED: 'true' },
    now: () => NOW,
    loadSettings: async () => ({ voice_enabled: true })
  });
  const result = await service.runVoiceDue();
  assert.equal(result.claimed, 1);
  assert.equal(result.blocked, 1);
  assert.ok(calls.some(call => call.name === 'defer_luko_cart_voice_call'
    && call.args.p_status === 'BLOCKED_NO_CONSENT'
    && call.args.p_reason === 'voice_consent_not_current'));
  assert.equal(calls.some(call => call.name === 'begin_luko_cart_voice_call'), false);
});

test('voice worker accepts an unknown GHL observation only after current combined voice consent', async () => {
  const calls = [];
  const claim = '33333333-3333-4333-8333-333333333333';
  const client = {
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === 'claim_luko_cart_voice_calls') return { data: [{
        id: RECOVERY_ID, voice_claim_token: claim, contact_phone: '+12125550123',
        external_cart_id: 'cart-voice-12345', event_version: 1
      }], error: null };
      return { data: true, error: null };
    },
    from(table) {
      const query = {
        select() { return query; }, eq() { return query; }, order() { return query; }, gte() { return query; },
        async limit() { return { data: table === 'luko_voice_consent_events' ? [{
          id: 9, event_type: 'opt_in', voice_marketing_consent: true,
          ai_voice_consent: true, consent_version: 'vici_marketing_sms_voice_v1',
          occurred_at: NOW.toISOString()
        }] : [], error: null }; }
      };
      return query;
    }
  };
  const service = createCartRecoveryService({
    client,
    env: { ...VOICE_ENV, CART_RECOVERY_VOICE_ENABLED: 'true' },
    now: () => NOW,
    loadSettings: async () => ({ voice_enabled: true }),
    evaluateRecipient: async () => ({ eligible: false, phone: '+12125550123', reason: 'dnd_unknown' }),
    fetch: async () => ({ ok: false })
  });
  const result = await service.runVoiceDue();
  assert.equal(result.blocked, 0);
  assert.equal(result.deferred, 1);
  assert.equal(calls.some(call => call.name === 'defer_luko_cart_voice_call'
    && call.args.p_status === 'BLOCKED_SUPPRESSED'), false);
  assert.ok(calls.some(call => call.name === 'defer_luko_cart_voice_call'
    && call.args.p_status === 'CANCELLED_CART_CHANGED'));
});

test('voice worker never dials when immutable audio cannot be staged', async () => {
  const calls = [];
  let attemptPatch;
  let dials = 0;
  const claim = '33333333-3333-4333-8333-333333333333';
  const cart = {
    id: RECOVERY_ID,
    voice_claim_token: claim,
    contact_phone: '+12125550123',
    customer_first_name: 'Maya',
    customer_timezone: 'America/New_York',
    external_cart_id: 'cart-voice-12345',
    event_version: 1,
    cart_items: [{ product_id: 1, product_name: 'GHK', quantity: 1 }]
  };
  const client = {
    storage: { from() { return { async remove() { return { error: null }; } }; } },
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === 'claim_luko_cart_voice_calls') return { data: [cart], error: null };
      if (name === 'begin_luko_cart_voice_call') {
        return { data: { allowed: true, dry_run: false, attempt_id: ATTEMPT_ID }, error: null };
      }
      return { data: true, error: null };
    },
    from(table) {
      if (table === 'luko_voice_consent_events') {
        const query = { select() { return query; }, eq() { return query; }, order() { return query; },
          async limit() { return { data: [{ id: 9, event_type: 'opt_in',
            voice_marketing_consent: true, ai_voice_consent: true,
            consent_version: 'vici_marketing_sms_voice_v1', occurred_at: NOW.toISOString() }], error: null }; } };
        return query;
      }
      if (table === 'luko_cart_recovery_replies') {
        const query = { select() { return query; }, eq() { return query; }, gte() { return query; },
          async limit() { return { data: [], error: null }; } };
        return query;
      }
      if (table === 'luko_cart_voice_attempts') {
        return { update(values) { attemptPatch = values; return {
          async eq() { return { data: null, error: null }; }
        }; } };
      }
      throw new Error(`Unexpected table ${table}`);
    }
  };
  const env = {
    ...VOICE_ENV,
    APP_URL: 'https://luko.example',
    CART_RECOVERY_VOICE_ENABLED: 'true',
    VOICE_DRY_RUN: 'false',
    LUKO_VOICE_PROVIDER_APPROVED: 'true',
    VICI_VOICE_OPT_OUT_HANDLER_VERIFIED: 'true'
  };
  const settings = {
    voice_enabled: true,
    voice_id: 'vin-voice',
    voice_model_id: 'eleven_turbo_v2_5',
    voice_human_answer_mode: 'DISABLED',
    voice_compliance_approved: true,
    voice_calling_window_start: '09:00',
    voice_calling_window_end: '20:00',
    voice_default_timezone: 'America/New_York'
  };
  const service = createCartRecoveryService({
    client,
    env,
    now: () => NOW,
    loadSettings: async () => settings,
    evaluateRecipient: async () => ({ eligible: true, phone: cart.contact_phone }),
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      return response({ request_id: request.request_id, eligible: true,
        current_voice_consent: true, external_cart_id: cart.external_cart_id,
        version: cart.event_version, order_id: null, items: [{ product_id: 1 }] });
    },
    stageVoiceAudio: async () => { throw Object.assign(new Error('provider unavailable'), { code: 'VOICE_FAILED' }); },
    dial: async () => { dials += 1; return { data: { call_control_id: 'must-not-dial' } }; }
  });

  const result = await service.runVoiceDue();
  assert.equal(dials, 0);
  assert.equal(result.initiated, 0);
  assert.equal(result.uncertain, 1);
  assert.equal(attemptPatch.state, 'FAILED');
  assert.equal(attemptPatch.failure_code, 'voice_audio_staging_failed');
  assert.ok(calls.some(call => call.name === 'defer_luko_cart_voice_call'
    && call.args.p_status === 'FAILED'
    && call.args.p_reason === 'voice_audio_staging_failed'));
});

test('Telnyx voice commands send premium AMD, native ElevenLabs speech, and inbound-only transcription shapes', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return response({ data: { call_control_id: 'call-1' } });
  };
  const options = { env: VOICE_ENV, fetchImpl };
  await createOutboundCall({
    to: '+12125550123', from: '+12125550100', connectionId: 'connection-1',
    webhookUrl: 'https://luko.example/webhooks/voice', amdMode: 'premium_ios_call_screening_detection',
    clientState: 'opaque-state', commandId: 'command-1'
  }, options);
  await speakPremiumOnCall('call/control', 'Hello Maya', {
    voice: 'ElevenLabs.eleven_turbo_v2_5.vin-voice', apiKeyRef: 'elevenlabs-key-ref', commandId: 'command-2'
  }, options);
  await playAudioOnCall('call/control', 'https://audio.example/human.mp3', {
    loop: 1, commandId: 'command-play'
  }, options);
  await startTranscription('call/control', 'command-3', options);

  assert.equal(calls[0].url, 'https://api.telnyx.com/v2/calls');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer KEY_TEST');
  assert.equal(calls[0].body.answering_machine_detection, 'premium_ios_call_screening_detection');
  assert.equal(calls[0].body.client_state, 'opaque-state');
  assert.equal(calls[1].url, 'https://api.telnyx.com/v2/calls/call%2Fcontrol/actions/speak');
  assert.deepEqual(calls[1].body.voice_settings, { api_key_ref: 'elevenlabs-key-ref' });
  assert.equal(calls[1].body.voice, 'ElevenLabs.eleven_turbo_v2_5.vin-voice');
  assert.equal(calls[1].body.payload_type, 'text');
  assert.equal(calls[2].url, 'https://api.telnyx.com/v2/calls/call%2Fcontrol/actions/playback_start');
  assert.equal(calls[2].body.audio_url, 'https://audio.example/human.mp3');
  assert.equal(calls[2].body.loop, 1);
  assert.equal(calls[2].body.command_id, 'command-play');
  assert.equal(calls[3].body.transcription_tracks, 'inbound');
  assert.equal(calls[3].body.transcription_engine, 'B');
});

test('ElevenLabs recovery catalogue is account-scoped and retains verification evidence', async () => {
  let request;
  const voices = await listAccountVoices({
    env: { ELEVENLABS_API_KEY: 'XI_TEST' },
    fetchImpl: async (url, init) => {
      request = { url, init };
      return response({ voices: [
        { voice_id: 'verified-1', name: 'Vin', category: 'professional', preview_url: 'https://cdn.example/vin.mp3',
          labels: { accent: 'american', language: 'en' }, voice_verification: { is_verified: true } },
        { voice_id: 'premade-1', name: 'Daniel', category: 'premade' },
        { voice_id: 'professional-1', name: 'Mark', category: 'professional',
          labels: { accent: 'american', gender: 'male', language: 'en' },
          sharing: { status: 'copied', original_voice_id: 'professional-1', public_owner_id: 'owner-1' },
          voice_verification: { requires_verification: false, is_verified: false } },
        { voice_id: 'unverified-1', name: 'Draft', category: 'cloned', voice_verification: { is_verified: false } },
        { voice_id: 'bad-copy-1', name: 'Bad copy', category: 'professional',
          sharing: { status: 'copied', original_voice_id: 'different', public_owner_id: 'owner-2' },
          voice_verification: { requires_verification: false, is_verified: false } },
        { voice_id: '', name: 'Malformed' }
      ] });
    }
  });
  assert.match(request.url, /\/v1\/voices$/);
  assert.equal(request.init.headers['xi-api-key'], 'XI_TEST');
  assert.deepEqual(voices.map(voice => [voice.id, voice.verified]), [
    ['verified-1', true], ['premade-1', false], ['professional-1', true],
    ['unverified-1', false], ['bad-copy-1', false]
  ]);
  assert.equal(voices.find(voice => voice.id === 'professional-1').sharingStatus, 'copied');
  assert.equal(voices.find(voice => voice.id === 'professional-1').professionalClone, true);
  assert.equal(voices.find(voice => voice.id === 'bad-copy-1').professionalClone, false);
});

function memoryVoiceClient() {
  const state = {
    attempt: {
      id: ATTEMPT_ID, recovery_id: RECOVERY_ID, state: 'ANSWERED', human_answer_mode: 'PRERECORDED',
      rendered_human_text: 'Human message', rendered_voicemail_text: 'Voicemail message',
      answered_at: '2026-09-15T13:59:59.000Z'
    },
    recovery: { id: RECOVERY_ID, contact_phone: '+12125550123', wordpress_user_id: '42', voice_status: 'ANSWERED' },
    settings: { voice_id: 'vin-voice', voice_model_id: 'eleven_turbo_v2_5',
      voice_transfer_number: '+12125550199', voice_opt_out_toll_free_number: '+18005550100' },
    suppressions: [], rpcs: [], updates: []
  };

  function tableRow(table) {
    if (table === 'luko_cart_voice_attempts') return state.attempt;
    if (table === 'luko_cart_recoveries') return state.recovery;
    if (table === 'luko_cart_recovery_settings') return state.settings;
    return null;
  }

  const client = {
    state,
    async rpc(name, args) {
      state.rpcs.push({ name, args });
      return { data: true, error: null };
    },
    from(table) {
      const query = {
        values: null, expectedColumn: null, expectedValues: null,
        select() { return query; },
        update(values) { query.values = values; return query; },
        eq() { return query; },
        in(column, values) {
          query.expectedColumn = column;
          query.expectedValues = values;
          return query;
        },
        async maybeSingle() {
          const target = tableRow(table);
          if (!query.values) return { data: target ? { ...target } : null, error: null };
          if (query.expectedValues && !query.expectedValues.includes(target?.[query.expectedColumn])) {
            return { data: null, error: null };
          }
          Object.assign(target, query.values);
          state.updates.push({ table, values: query.values });
          return { data: { id: target.id }, error: null };
        },
        async insert(values) { state.suppressions.push(values); return { data: values, error: null }; },
        then(resolve, reject) {
          try {
            if (query.values) {
              const target = tableRow(table);
              Object.assign(target, query.values);
              state.updates.push({ table, values: query.values });
            }
            return Promise.resolve(resolve({ data: null, error: null }));
          } catch (error) { return Promise.resolve(reject(error)); }
        }
      };
      return query;
    }
  };
  return client;
}

function attachVoiceAudioStorage(client) {
  const removed = [];
  client.storage = {
    from(bucket) {
      assert.equal(bucket, 'call-recordings');
      return {
        async createSignedUrl(file) {
          return { data: { signedUrl: `https://audio.example/${file}` }, error: null };
        },
        async remove(files) { removed.push(...files); return { data: files, error: null }; }
      };
    }
  };
  return removed;
}

function voiceEvent(eventType, payload = {}, id = `event-${eventType}`) {
  return {
    id,
    event_type: eventType,
    occurred_at: NOW.toISOString(),
    payload: { call_control_id: 'call-control-1', ...payload }
  };
}

test('pre-generated voice audio is stored privately, signed briefly, and cleaned up', async () => {
  const uploaded = [];
  const removed = [];
  const client = { storage: { from(bucket) {
    assert.equal(bucket, 'call-recordings');
    return {
      async upload(file, audio, options) {
        uploaded.push({ file, audio: audio.toString(), options });
        return { data: { path: file }, error: null };
      },
      async createSignedUrl(file, seconds) {
        assert.equal(seconds, 300);
        return { data: { signedUrl: `https://signed.example/${file}` }, error: null };
      },
      async remove(files) { removed.push(...files); return { data: files, error: null }; }
    };
  } } };
  const synthesize = async ({ text }) => ({ audio: Buffer.from(text), contentType: 'audio/mpeg' });
  const result = await prepareVoiceAudio({ client, attemptID: ATTEMPT_ID,
    scripts: { human: 'Human audio', voicemail: 'Voicemail audio' },
    voiceID: 'vin', modelID: 'eleven_turbo_v2_5', synthesize });
  assert.deepEqual(result, { ready: true });
  assert.deepEqual(uploaded.map(entry => entry.file), [
    storagePath(ATTEMPT_ID, 'human'), storagePath(ATTEMPT_ID, 'voicemail')
  ]);
  assert.match(await signedVoiceAudioURL({ client, attemptID: ATTEMPT_ID, branch: 'human' }),
    /human\.mp3$/);
  assert.equal(await cleanupVoiceAudio({ client, attemptID: ATTEMPT_ID }), true);
  assert.deepEqual(removed, [storagePath(ATTEMPT_ID, 'human'), storagePath(ATTEMPT_ID, 'voicemail')]);
  assert.throws(() => storagePath('../unsafe', 'human'));
});

test('answered humans hear cached audio immediately without waiting for AMD or synthesis', async () => {
  const client = memoryVoiceClient();
  client.state.attempt.state = 'INITIATED';
  client.state.attempt.answered_at = null;
  client.state.recovery.voice_status = 'INITIATED';
  attachVoiceAudioStorage(client);
  const calls = [];
  const handler = createVoiceEventHandler({ client, env: VOICE_ENV, now: () => NOW,
    api: {
      play: async (...args) => calls.push(['play', ...args]),
      speak: async (...args) => calls.push(['speak', ...args]),
      transcribe: async (...args) => calls.push(['transcribe', ...args]),
      hangup: async (...args) => calls.push(['hangup', ...args]),
      stopAudio: async (...args) => calls.push(['stopAudio', ...args]),
      transfer: async (...args) => calls.push(['transfer', ...args])
    } });

  await handler.handle(voiceEvent('call.answered', {}, 'answered-fast'));
  assert.equal(client.state.attempt.state, 'HUMAN_MESSAGE_PLAYING');
  assert.deepEqual(calls.map(call => call[0]).sort(), ['play', 'transcribe']);
  assert.match(calls.find(call => call[0] === 'play')[2], /human\.mp3/);

  const started = voiceEvent('call.playback.started', {}, 'playback-fast');
  started.occurred_at = new Date(NOW.getTime() + 400).toISOString();
  await handler.handle(started);
  assert.equal(client.state.attempt.human_answer_first_audio_latency_ms, 400);
  assert.ok(client.state.attempt.human_answer_first_audio_latency_ms <= 500,
    'pre-generated human audio must begin within the requested half-second target');
  await handler.handle(voiceEvent('call.machine.premium.detection.ended', { result: 'human_business' }, 'human-fast'));
  assert.equal(client.state.attempt.state, 'HUMAN_MESSAGE_PLAYING');
  assert.equal(client.state.attempt.amd_result, 'human_business');
  assert.equal(calls.filter(call => call[0] === 'play').length, 1, 'AMD must not restart cached audio');
  assert.equal(calls.filter(call => call[0] === 'speak').length, 0);
  await handler.handle(voiceEvent('call.playback.ended', {}, 'playback-ended-fast'));
  assert.equal(client.state.attempt.state, 'HUMAN_MESSAGE_PLAYED');
});

test('a machine answer stops provisional audio and plays the full voicemail only after its greeting', async () => {
  const client = memoryVoiceClient();
  client.state.attempt.state = 'INITIATED';
  client.state.attempt.answered_at = null;
  client.state.recovery.voice_status = 'INITIATED';
  attachVoiceAudioStorage(client);
  const calls = [];
  const handler = createVoiceEventHandler({ client, env: VOICE_ENV, now: () => NOW,
    schedule: () => {},
    api: {
      play: async (...args) => calls.push(['play', ...args]),
      speak: async (...args) => calls.push(['speak', ...args]),
      transcribe: async (...args) => calls.push(['transcribe', ...args]),
      hangup: async (...args) => calls.push(['hangup', ...args]),
      stopAudio: async (...args) => calls.push(['stopAudio', ...args]),
      transfer: async (...args) => calls.push(['transfer', ...args])
    } });

  await handler.handle(voiceEvent('call.answered', {}, 'machine-answer'));
  await handler.handle(voiceEvent('call.machine.premium.detection.ended', { result: 'machine' }, 'machine-detected'));
  assert.equal(client.state.attempt.state, 'MACHINE_DETECTED');
  assert.equal(calls.filter(call => call[0] === 'stopAudio').length, 1);
  assert.equal(calls.filter(call => call[0] === 'play').length, 1);
  await handler.handle(voiceEvent('call.machine.premium.greeting.ended', {}, 'machine-greeting'));
  assert.equal(client.state.attempt.state, 'VOICEMAIL_PLAYING');
  const plays = calls.filter(call => call[0] === 'play');
  assert.equal(plays.length, 2);
  assert.match(plays[1][2], /voicemail\.mp3/);
  assert.equal(calls.filter(call => call[0] === 'speak').length, 0,
    'the beep path must play cached audio immediately without live synthesis');
});

test('voice event handler starts staged audio only after AMD decides human and never invokes recording', async () => {
  const client = memoryVoiceClient();
  attachVoiceAudioStorage(client);
  const calls = [];
  const handler = createVoiceEventHandler({
    client, env: VOICE_ENV, now: () => NOW,
    api: {
      play: async (...args) => {
        assert.equal(client.state.attempt.state, 'HUMAN_MESSAGE_PLAYING',
          'the branch must be durable before Telnyx can emit playback webhooks');
        assert.equal(client.state.recovery.voice_status, 'HUMAN_MESSAGE_PLAYING');
        calls.push(['play', ...args]);
      },
      transcribe: async (...args) => calls.push(['transcribe', ...args]),
      hangup: async (...args) => calls.push(['hangup', ...args]),
      stopAudio: async (...args) => calls.push(['stopAudio', ...args]),
      transfer: async (...args) => calls.push(['transfer', ...args])
    }
  });
  const result = await handler.handle(voiceEvent('call.machine.premium.detection.ended', { result: 'human' }));
  assert.deepEqual(result, { handled: true });
  assert.deepEqual(calls.map(call => call[0]), ['transcribe', 'play']);
  assert.match(calls[1][2], /human\.mp3/);
  assert.equal(client.state.attempt.state, 'HUMAN_MESSAGE_PLAYING');
  assert.equal(client.state.rpcs.some(call => call.name === 'append_luko_cart_recovery_timeline'
    && call.args.p_event_type === 'VOICE_HUMAN_DETECTED'), true);
});

test('voicemail playback waits for greeting end and spoken STOP suppresses without persisting transcript', async () => {
  const client = memoryVoiceClient();
  attachVoiceAudioStorage(client);
  const calls = [];
  const handler = createVoiceEventHandler({
    client, env: VOICE_ENV, now: () => NOW,
    api: {
      play: async (...args) => calls.push(['play', ...args]),
      transcribe: async (...args) => calls.push(['transcribe', ...args]),
      hangup: async (...args) => calls.push(['hangup', ...args]),
      stopAudio: async (...args) => calls.push(['stopAudio', ...args]),
      transfer: async (...args) => calls.push(['transfer', ...args])
    }
  });
  await handler.handle(voiceEvent('call.machine.premium.detection.ended', { result: 'machine' }));
  assert.equal(calls.length, 0, 'machine classification alone must not speak over the greeting');
  await handler.handle(voiceEvent('call.machine.premium.greeting.ended', { result: 'greeting ended' }));
  assert.equal(calls[0][0], 'play');
  assert.match(calls[0][2], /voicemail\.mp3/);

  await handler.handle(voiceEvent('call.transcription', {
    transcription_data: { is_final: true, transcript: 'Please stop calling me' }
  }, 'event-spoken-stop'));
  assert.equal(client.state.suppressions.length, 1);
  assert.equal(client.state.suppressions[0].reason_code, 'spoken_stop');
  const consent = client.state.rpcs.find(call => call.name === 'record_luko_voice_consent');
  assert.equal(consent.args.p_event.voice_marketing_consent, false);
  assert.equal(consent.args.p_event.ai_voice_consent, false);
  assert.equal(JSON.stringify(client.state), JSON.stringify(client.state).replace(/Please stop calling me/g, ''),
    'the raw transcription must not be persisted in state, timeline, or consent evidence');
  assert.deepEqual(calls.slice(-2).map(call => call[0]), ['stopAudio', 'hangup']);
});

test('premium greeting-ended may arrive before machine detection without losing the voicemail', async () => {
  const client = memoryVoiceClient();
  attachVoiceAudioStorage(client);
  const calls = [];
  const handler = createVoiceEventHandler({ client, env: VOICE_ENV, now: () => NOW,
    schedule: () => {},
    api: {
      play: async (...args) => calls.push(['play', ...args]), transcribe: async () => {},
      hangup: async () => {}, stopAudio: async () => {}, transfer: async () => {}
    } });

  await handler.handle(voiceEvent('call.machine.premium.greeting.ended', {}, 'greeting-first'));
  assert.equal(client.state.attempt.state, 'GREETING_END_DETECTED');
  assert.equal(calls.length, 0, 'classification still controls the branch');
  await handler.handle(voiceEvent('call.machine.premium.detection.ended', { result: 'machine' }, 'machine-second'));
  assert.equal(client.state.attempt.state, 'VOICEMAIL_PLAYING');
  assert.equal(calls.filter(call => call[0] === 'play').length, 1);
});

test('machine detection uses a single durable fallback when a carrier omits greeting-ended', async () => {
  const client = memoryVoiceClient();
  attachVoiceAudioStorage(client);
  const calls = [];
  let fallback;
  let fallbackDelay;
  const handler = createVoiceEventHandler({ client, env: VOICE_ENV, now: () => NOW,
    schedule: (callback, delay) => { fallback = callback; fallbackDelay = delay; },
    api: {
      play: async (...args) => calls.push(['play', ...args]), transcribe: async () => {},
      hangup: async () => {}, stopAudio: async () => {}, transfer: async () => {}
    } });

  await handler.handle(voiceEvent('call.machine.premium.detection.ended', { result: 'machine' }, 'machine-no-greeting'));
  assert.equal(client.state.attempt.state, 'MACHINE_DETECTED');
  assert.equal(calls.length, 0);
  assert.equal(typeof fallback, 'function');
  assert.equal(fallbackDelay, 8000,
    'the fallback must play before short carrier mailboxes disconnect when greeting-ended is omitted');
  await fallback();
  assert.equal(client.state.attempt.state, 'VOICEMAIL_PLAYING');
  assert.equal(calls.filter(call => call[0] === 'play').length, 1);
  await fallback();
  assert.equal(calls.filter(call => call[0] === 'play').length, 1, 'the state transition prevents replay');
});

test('overlapping greeting and playback-ended events cannot replay or change the voicemail branch', async () => {
  const client = memoryVoiceClient();
  attachVoiceAudioStorage(client);
  const calls = [];
  const handler = createVoiceEventHandler({ client, env: VOICE_ENV, now: () => NOW,
    api: {
      play: async (...args) => calls.push(['play', ...args]), transcribe: async () => {},
      hangup: async (...args) => calls.push(['hangup', ...args]), stopAudio: async () => {}, transfer: async () => {}
    } });

  await handler.handle(voiceEvent('call.machine.premium.detection.ended', { result: 'machine' }, 'machine-1'));
  await Promise.all([
    handler.handle(voiceEvent('call.machine.greeting.ended', {}, 'greeting-1')),
    handler.handle(voiceEvent('call.machine.greeting.ended', {}, 'greeting-2'))
  ]);
  assert.equal(calls.filter(call => call[0] === 'play').length, 1);
  assert.equal(client.state.attempt.state, 'VOICEMAIL_PLAYING');

  await Promise.all([
    handler.handle(voiceEvent('call.playback.ended', {}, 'playback-ended-1')),
    handler.handle(voiceEvent('call.playback.ended', {}, 'playback-ended-2'))
  ]);
  assert.equal(client.state.attempt.state, 'VOICEMAIL_PLAYED');
  assert.equal(calls.filter(call => call[0] === 'hangup').length, 1);
  assert.equal(client.state.rpcs.filter(call => call.name === 'append_luko_cart_recovery_timeline'
    && call.args.p_event_type === 'VOICE_VOICEMAIL_PLAYED').length, 1);
});

test('provider speech and transcription failures are persisted and fail closed', async () => {
  const speakClient = memoryVoiceClient();
  const speakCalls = [];
  const speakHandler = createVoiceEventHandler({ client: speakClient, env: VOICE_ENV, now: () => NOW,
    api: {
      speak: async () => { throw new Error('provider unavailable'); }, transcribe: async () => {},
      hangup: async (...args) => speakCalls.push(['hangup', ...args]), stopAudio: async () => {}, transfer: async () => {}
    } });
  await speakHandler.handle(voiceEvent('call.machine.premium.detection.ended', { result: 'human' }, 'human-speak-fail'));
  assert.equal(speakClient.state.attempt.state, 'FAILED');
  assert.equal(speakClient.state.attempt.failure_code, 'voice_speak_failed');
  assert.equal(speakClient.state.recovery.voice_status, 'FAILED');
  assert.equal(speakCalls.filter(call => call[0] === 'hangup').length, 1);

  const transcriptionClient = memoryVoiceClient();
  let spoke = false;
  const transcriptionHandler = createVoiceEventHandler({ client: transcriptionClient, env: VOICE_ENV, now: () => NOW,
    api: {
      speak: async () => { spoke = true; }, transcribe: async () => { throw new Error('transcription unavailable'); },
      hangup: async () => {}, stopAudio: async () => {}, transfer: async () => {}
    } });
  await transcriptionHandler.handle(voiceEvent('call.machine.premium.detection.ended', { result: 'human' }, 'transcription-fail'));
  assert.equal(spoke, false, 'prerecorded human speech must not start without the spoken opt-out listener');
  assert.equal(transcriptionClient.state.attempt.state, 'FAILED');
  assert.equal(transcriptionClient.state.attempt.failure_code, 'voice_transcription_failed');
  assert.equal(transcriptionClient.state.recovery.voice_status, 'FAILED');
});

test('only final spoken opt-out transcripts suppress and raw transcript text is never retained', async () => {
  const client = memoryVoiceClient();
  const handler = createVoiceEventHandler({ client, env: VOICE_ENV, now: () => NOW,
    api: { speak: async () => {}, transcribe: async () => {}, hangup: async () => {},
      stopAudio: async () => {}, transfer: async () => {} } });
  await handler.handle(voiceEvent('call.transcription', {
    transcription_data: { is_final: false, transcript: 'stop' }
  }, 'partial-stop'));
  assert.equal(client.state.suppressions.length, 0);
  assert.doesNotMatch(JSON.stringify(client.state), /partial-stop.*transcript|"transcript"/);
});

test('DTMF 9 creates a durable opt-out while 1 requests transfer to customer care', async () => {
  const client = memoryVoiceClient();
  const calls = [];
  const handler = createVoiceEventHandler({
    client, env: VOICE_ENV, now: () => NOW,
    api: {
      speak: async () => {}, transcribe: async () => {},
      hangup: async (...args) => calls.push(['hangup', ...args]),
      stopAudio: async (...args) => calls.push(['stopAudio', ...args]),
      transfer: async (...args) => calls.push(['transfer', ...args])
    }
  });
  await handler.handle(voiceEvent('call.dtmf.received', { digit: '9' }, 'event-dtmf-9'));
  assert.equal(client.state.suppressions[0].reason_code, 'dtmf_9');
  assert.equal(client.state.attempt.state, 'VOICE_OPT_OUT_DTMF');

  const transferClient = memoryVoiceClient();
  const transferCalls = [];
  const transferHandler = createVoiceEventHandler({ client: transferClient, env: VOICE_ENV, now: () => NOW,
    api: { speak: async () => {}, transcribe: async () => {}, hangup: async () => {},
      stopAudio: async (...args) => transferCalls.push(['stopAudio', ...args]),
      transfer: async (...args) => transferCalls.push(['transfer', ...args]) } });
  await transferHandler.handle(voiceEvent('call.dtmf.received', { digit: '1' }, 'event-dtmf-one'));
  assert.deepEqual(transferCalls.map(call => call[0]), ['stopAudio', 'transfer']);
  assert.equal(transferCalls[1][2], '+12125550199');
  assert.equal(transferClient.state.attempt.state, 'TRANSFER_INITIATED');
});

test('voice client state is opaque, validated, and rejects unrelated base64 payloads', () => {
  const encoded = Buffer.from(JSON.stringify({ kind: 'cart_recovery_voice', attempt_id: ATTEMPT_ID })).toString('base64');
  assert.equal(decodeClientState(encoded).attempt_id, ATTEMPT_ID);
  assert.equal(decodeClientState(Buffer.from(JSON.stringify({ kind: 'other' })).toString('base64')), null);
  assert.equal(decodeClientState('not-base64-json'), null);
});

test('recovery client state fails closed when its attempt cannot be resolved', async () => {
  const encoded = Buffer.from(JSON.stringify({
    kind: 'cart_recovery_voice', attempt_id: ATTEMPT_ID
  })).toString('base64');
  const client = {
    async rpc() { return { data: true, error: null }; },
    from() {
      const query = {
        select() { return query; }, eq() { return query; },
        async maybeSingle() { return { data: null, error: null }; }
      };
      return query;
    }
  };
  const handler = createVoiceEventHandler({ client, env: VOICE_ENV, now: () => NOW });
  await assert.rejects(() => handler.handle(voiceEvent('call.speak.ended', {
    client_state: encoded
  }, 'orphaned-recovery-event')), { code: 'VOICE_RECOVERY_ATTEMPT_NOT_FOUND' });
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../lib/cart-recovery/voice-events.js'), 'utf8'),
    /recordCall|record_start/);
});

test('voice webhooks require Ed25519 verification and a durable claim before recovery handling', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const wire = { data: {
    id: 'voice-event-1', event_type: 'call.answered', occurred_at: NOW.toISOString(),
    payload: { call_control_id: 'call-control-1' }
  } };
  const raw = Buffer.from(JSON.stringify(wire));
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  const signature = crypto.sign(null, Buffer.concat([Buffer.from(`${timestamp}|`), raw]), privateKey).toString('base64');
  const publicPEM = publicKey.export({ format: 'pem', type: 'spki' });
  const event = decodeVerifiedTelnyxEvent(raw, {
    'telnyx-timestamp': timestamp, 'telnyx-signature-ed25519': signature
  }, publicPEM, { now: NOW.getTime(), requirePayloadID: false });
  assert.equal(event.id, 'voice-event-1');
  assert.throws(() => decodeVerifiedTelnyxEvent(Buffer.from(`${raw} `), {
    'telnyx-timestamp': timestamp, 'telnyx-signature-ed25519': signature
  }, publicPEM, { now: NOW.getTime(), requirePayloadID: false }), { status: 403 });

  const route = fs.readFileSync(path.join(__dirname, '../routes/voice-webhook.js'), 'utf8');
  const verifyAt = route.indexOf('decodeVerifiedTelnyxEvent');
  const claimAt = route.indexOf("supabase.rpc('claim_telnyx_voice_event'", verifyAt);
  const recoveryAt = route.indexOf('recoveryVoice.handle(event)', claimAt);
  const legacySwitchAt = route.indexOf('switch (event_type)', recoveryAt);
  assert.ok(verifyAt >= 0 && claimAt > verifyAt && recoveryAt > claimAt && legacySwitchAt > recoveryAt);
  assert.match(route, /if \(!claim\?\.claimed\) return res\.sendStatus\(200\)/);
  assert.match(route, /if \(recovery\.handled\)[\s\S]*finish_telnyx_voice_event[\s\S]*return res\.sendStatus\(200\)/);
  assert.match(route, /if \(!res\.headersSent\) return res\.sendStatus\(503\)/,
    'failed recovery events must remain redeliverable instead of being acknowledged early');
});

test('connected voice transfer is one STRONG recovered order and a voice touch alone is only secondary evidence', () => {
  const baseCart = {
    id: RECOVERY_ID,
    workspace_id: 'vici',
    external_cart_id: 'cart-voice-12345',
    last_activity_at: '2026-09-15T12:00:00.000Z',
    recovery_expires_at: '2026-09-22T12:00:00.000Z',
    cart_total: 120,
    voice_started_at: '2026-09-15T13:00:00.000Z',
    voice_transfer_connected_at: '2026-09-15T13:30:00.000Z',
    voice_call_control_id: 'call-control-1'
  };
  const order = {
    order_id: '14821', status: 'processing', paid_at: '2026-09-15T14:00:00.000Z',
    total: 118, discount_total: 2, refunded_amount: 0, currency: 'USD', attribution_valid: true
  };
  const direct = attributionDecision(baseCart, order);
  assert.equal(direct.attribution_method, 'voice_transfer_assisted');
  assert.equal(direct.attribution_strength, 'strong');
  assert.equal(direct.recovery_channel, 'voice');
  assert.equal(direct.voice_call_control_id, 'call-control-1');
  assert.equal(direct.secondary_signals.voice_touch, true);
  assert.equal(direct.secondary_signals.voice_transfer_connected, true);
  const payload = attributionPayload(direct);
  assert.equal(payload.originating_action_type, 'voice_transfer_assisted');
  assert.equal(payload.confidence_level, 'strong');

  assert.equal(attributionDecision({ ...baseCart, voice_transfer_connected_at: null }, order), null,
    'a dial or voicemail by itself must not claim recovered revenue');
});

test('voice migration is additive, off by default, suppression-aware, idempotent, and service-role only', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../scripts/cart-recovery-voice-migration.sql'), 'utf8');
  assert.match(sql, /voice_enabled boolean NOT NULL DEFAULT false/i);
  assert.match(sql, /voice_marketing_consent boolean NOT NULL DEFAULT false/i);
  assert.match(sql, /ai_voice_consent boolean NOT NULL DEFAULT false/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.luko_voice_consent_events/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.luko_voice_suppressions/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.luko_cart_voice_attempts/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.telnyx_voice_webhook_events/i);
  assert.match(sql, /to_regclass\('public\.luko_cart_recovered_orders'\)/i,
    'voice migration must refuse to run before revenue attribution exists');
  assert.match(sql, /UNIQUE\(workspace_id,dedupe_key\)/i);
  assert.match(sql, /voice_consent_dedupe_key_reused/i);
  assert.match(sql, /ORDER BY occurred_at DESC,id DESC LIMIT 1/i,
    'late or replayed consent evidence must not override the latest durable event');
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM public\.luko_voice_suppressions/i);
  assert.match(sql, /voice_attempt_count<s\.voice_max_attempts/i);
  assert.match(sql, /status='FAILED'[\s\S]*last_claimed_at<now\(\)-interval '5 minutes'/i,
    'failed and abandoned webhook claims remain safely retryable');
  assert.match(sql, /delivery_count<10/i, 'webhook retries must remain bounded');
  assert.match(sql, /ADD CONSTRAINT luko_cart_recovered_orders_attribution_method_check[\s\S]*'voice_transfer_assisted'/i);
  assert.match(sql, /ADD CONSTRAINT luko_cart_recovered_orders_recovery_channel_check[\s\S]*'voice'/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.persist_luko_cart_recovered_order\(p_decision jsonb\)/i);
  assert.match(sql, /v_method='voice_transfer_assisted'[\s\S]*voice_transfer_connected_at IS NULL[\s\S]*voice_call_control_id/i);
  assert.match(sql, /ON CONFLICT\(workspace_id,order_id\) DO UPDATE/i,
    'the persisted order remains the idempotency boundary for revenue');
  assert.match(sql, /SECURITY DEFINER SET search_path=''/i);
  assert.match(sql, /REVOKE ALL ON public\.luko_voice_consent_events[\s\S]*FROM public,anon,authenticated/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.record_luko_voice_consent[\s\S]*TO service_role/i);
  assert.doesNotMatch(sql, /recording_url|audio_url|transcript text/i,
    'recovery calls must not persist recordings or raw transcripts');
});
