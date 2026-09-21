'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createVoiceOptOutHandler, decodeState, encodeState, enteredUSPhone,
  isOptOutDestination, SUCCESS_PROMPT
} = require('../lib/voice-opt-out-handler');
const { answerCall, gatherUsingSpeak } = require('../lib/telnyx-api');
const { digestTelnyxEvent } = require('../lib/telnyx-webhook-claim');

const TF = '+18666450593';

function event(type, overrides = {}) {
  return {
    id: overrides.id || `event-${type}`,
    event_type: type,
    occurred_at: '2026-09-21T12:00:00.000Z',
    payload: {
      call_control_id: 'call-1', from: '+13055550123', to: TF, direction: 'incoming',
      ...overrides.payload
    }
  };
}

function harness({ insertError = null, consentError = null } = {}) {
  const actions = [];
  const rows = [];
  const rpcs = [];
  const client = {
    from(table) {
      assert.equal(table, 'luko_voice_suppressions');
      return { insert: async row => { rows.push(row); return { error: insertError }; } };
    },
    async rpc(name, args) { rpcs.push({ name, args }); return { error: consentError }; }
  };
  const commands = {
    answer: async (cid, options) => actions.push({ kind: 'answer', cid, options }),
    gather: async (cid, text, options) => actions.push({ kind: 'gather', cid, text, options }),
    speak: async (cid, text, options) => actions.push({ kind: 'speak', cid, text, options }),
    hangup: async cid => actions.push({ kind: 'hangup', cid })
  };
  return {
    handler: createVoiceOptOutHandler({ client, env: { VICI_VOICE_OPT_OUT_TOLL_FREE_NUMBER: TF }, commands }),
    actions, rows, rpcs
  };
}

test('the configured destination and state token identify only the opt-out flow', () => {
  assert.equal(isOptOutDestination({ to: TF, direction: 'incoming' }, { VICI_VOICE_OPT_OUT_TOLL_FREE_NUMBER: TF }), true);
  assert.equal(isOptOutDestination({ to: TF, direction: 'outgoing' }, { VICI_VOICE_OPT_OUT_TOLL_FREE_NUMBER: TF }), false);
  assert.equal(isOptOutDestination({ to: '+13055550184', direction: 'incoming' }, { VICI_VOICE_OPT_OUT_TOLL_FREE_NUMBER: TF }), false);
  assert.deepEqual(decodeState(encodeState('menu')), { kind: 'vici_voice_opt_out', phase: 'menu' });
  assert.equal(decodeState('not-base64'), null);
  assert.equal(enteredUSPhone('3055550123'), '+13055550123');
  assert.equal(enteredUSPhone('1055550123'), null);
});

test('an inbound toll-free call is answered and receives the DTMF menu', async () => {
  const h = harness();
  assert.deepEqual(await h.handler.handle(event('call.initiated')), { handled: true });
  await h.handler.handle(event('call.answered'));
  assert.equal(h.actions[0].kind, 'answer');
  assert.equal(decodeState(h.actions[0].options.clientState).phase, 'answer');
  assert.match(h.actions[0].options.commandId, /^[a-f0-9]{32}$/);
  assert.equal(h.actions[1].kind, 'gather');
  assert.equal(h.actions[1].options.validDigits, '29');
  assert.equal(decodeState(h.actions[1].options.clientState).phase, 'menu');
});

test('the Telnyx answer command carries opt-out state into subsequent webhooks', async () => {
  let request;
  await answerCall('call/with/slashes', {
    clientState: encodeState('answer'), commandId: 'answer-command-1'
  }, {
    env: { TELNYX_API_KEY: 'test-key' },
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return { ok: true, json: async () => ({ data: { result: 'ok' } }) };
    }
  });
  assert.match(request.url, /calls\/call%2Fwith%2Fslashes\/actions\/answer$/);
  assert.equal(request.body.command_id, 'answer-command-1');
  assert.equal(decodeState(request.body.client_state).phase, 'answer');
});

test('pressing 9 durably suppresses the caller before confirming success', async () => {
  const h = harness();
  await h.handler.handle(event('call.gather.ended', { payload: {
    status: 'valid', digits: '9', client_state: encodeState('menu')
  } }));
  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0].contact_phone, '+13055550123');
  assert.equal(h.rows[0].reason_code, 'provider_opt_out');
  assert.equal(h.rpcs[0].name, 'record_luko_voice_consent');
  assert.equal(h.rpcs[0].args.p_event.voice_marketing_consent, false);
  assert.equal(h.rpcs[0].args.p_event.ai_voice_consent, false);
  assert.equal(h.actions[0].kind, 'speak');
  assert.equal(h.actions[0].text, SUCCESS_PROMPT);
});

test('pressing 2 collects a different ten digit number and suppresses it', async () => {
  const h = harness();
  await h.handler.handle(event('call.gather.ended', { payload: {
    status: 'valid', digits: '2', client_state: encodeState('menu')
  } }));
  assert.equal(h.actions[0].kind, 'gather');
  assert.equal(h.actions[0].options.minimumDigits, 10);
  await h.handler.handle(event('call.gather.ended', { id: 'number-event', payload: {
    status: 'valid', digits: '5615550199', client_state: encodeState('number')
  } }));
  assert.equal(h.rows[0].contact_phone, '+15615550199');
});

test('a missing caller ID falls back to collecting the number', async () => {
  const h = harness();
  await h.handler.handle(event('call.gather.ended', { payload: {
    from: 'anonymous', status: 'valid', digits: '9', client_state: encodeState('menu')
  } }));
  assert.equal(h.rows.length, 0);
  assert.equal(h.actions[0].kind, 'gather');
  assert.equal(decodeState(h.actions[0].options.clientState).phase, 'number');
});

test('a database failure never plays a false success confirmation', async () => {
  const h = harness({ insertError: { code: 'DB_DOWN', message: 'unavailable' } });
  await assert.rejects(h.handler.handle(event('call.gather.ended', { payload: {
    status: 'valid', digits: '9', client_state: encodeState('menu')
  } })), error => error?.code === 'DB_DOWN' && error?.message === 'unavailable');
  assert.equal(h.actions.length, 0);
});

test('duplicate suppression is accepted but consent revocation is still recorded', async () => {
  const h = harness({ insertError: { code: '23505', message: 'duplicate' } });
  await h.handler.handle(event('call.gather.ended', { payload: {
    status: 'valid', digits: '9', client_state: encodeState('menu')
  } }));
  assert.equal(h.rpcs.length, 1);
  assert.equal(h.actions[0].kind, 'speak');
});

test('the goodbye completion hangs up and unrelated calls remain untouched', async () => {
  const h = harness();
  await h.handler.handle(event('call.speak.ended', { payload: { client_state: encodeState('goodbye') } }));
  assert.equal(h.actions[0].kind, 'hangup');
  const ordinary = event('call.initiated', { payload: { to: '+13055550184' } });
  assert.deepEqual(await h.handler.handle(ordinary), { handled: false });
});

test('a goodbye/hangup race is idempotent but other provider failures remain retryable', async () => {
  const ended = harness();
  ended.handler = createVoiceOptOutHandler({
    client: { from: () => ({ insert: async () => ({ error: null }) }), rpc: async () => ({ error: null }) },
    env: { VICI_VOICE_OPT_OUT_TOLL_FREE_NUMBER: TF },
    commands: { hangup: async () => { throw new Error('Telnyx returned 422: code 90018, Call has already ended'); } }
  });
  await assert.doesNotReject(ended.handler.handle(event('call.speak.ended', {
    payload: { client_state: encodeState('goodbye') }
  })));

  const failed = createVoiceOptOutHandler({
    client: {}, env: { VICI_VOICE_OPT_OUT_TOLL_FREE_NUMBER: TF },
    commands: { hangup: async () => { throw new Error('Telnyx unavailable'); } }
  });
  await assert.rejects(failed.handle(event('call.speak.ended', {
    payload: { client_state: encodeState('goodbye') }
  })), /Telnyx unavailable/);
});

test('voice retry digests ignore transport metadata and object key order', () => {
  const first = { id: 'evt-1', event_type: 'call.answered', payload: { to: TF, from: '+13055550123' } };
  const reordered = { payload: { from: '+13055550123', to: TF }, event_type: 'call.answered', id: 'evt-1' };
  assert.equal(digestTelnyxEvent(first), digestTelnyxEvent(reordered));
  assert.notEqual(digestTelnyxEvent(first), digestTelnyxEvent({ ...first, event_type: 'call.hangup' }));
});

test('the Telnyx gather command uses the documented DTMF contract and carries state', async () => {
  let request;
  await gatherUsingSpeak('call/with/slashes', 'Press 9.', {
    validDigits: '9', minimumDigits: 1, maximumDigits: 1,
    clientState: encodeState('menu'), commandId: 'command-1'
  }, {
    env: { TELNYX_API_KEY: 'test-key' },
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return { ok: true, json: async () => ({ data: { result: 'ok' } }) };
    }
  });
  assert.match(request.url, /calls\/call%2Fwith%2Fslashes\/actions\/gather_using_speak$/);
  assert.equal(request.body.valid_digits, '9');
  assert.equal(request.body.minimum_digits, 1);
  assert.equal(request.body.maximum_digits, 1);
  assert.equal(request.body.command_id, 'command-1');
  assert.equal(decodeState(request.body.client_state).phase, 'menu');
});

test('the public webhook persists a toll-free opt-out before acknowledging Telnyx', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/voice-webhook.js'), 'utf8');
  const handle = source.indexOf('await voiceOptOut.handle(event)');
  const durable = source.indexOf("'finish_telnyx_voice_event'", handle);
  const acknowledge = source.indexOf('return res.sendStatus(200)', durable);
  const legacyFastAck = source.indexOf('res.sendStatus(200)', acknowledge + 1);
  assert.ok(handle >= 0 && durable > handle && acknowledge > durable);
  assert.ok(legacyFastAck > acknowledge, 'the opt-out path must complete before the legacy fast acknowledgement');
});
