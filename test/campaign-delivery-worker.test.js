'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deliverBatch,
  liveSendEnabled,
  recoverExpiredClaims
} = require('../lib/campaigns/delivery-worker');

const SILENT = { error() {}, warn() {}, log() {} };
const ON = { CAMPAIGNS_LIVE_SEND_ENABLED: 'true' };

/**
 * A fake Supabase client that records every RPC and replies from a script.
 * Each handler is (args) => ({ data }) or ({ error: { message } }).
 */
function fakeClient(handlers = {}) {
  const calls = [];
  return {
    calls,
    rpc(name, args) {
      calls.push({ name, args });
      const handler = handlers[name];
      if (!handler) return Promise.resolve({ data: null, error: null });
      return Promise.resolve(handler(args, calls));
    }
  };
}

function recipient(overrides = {}) {
  return {
    id: 'r-1',
    workspace_id: 'vici',
    contact_phone: '+15550001111',
    rendered_message: 'Your BPC-157 is back in stock.',
    claim_token: 'claim-1',
    ...overrides
  };
}

function baseHandlers({ claimed = [recipient()], ...rest } = {}) {
  return {
    release_expired_sms_campaign_claims: () => ({ data: 0 }),
    claim_sms_campaign_recipients: () => ({ data: claimed }),
    begin_sms_campaign_provider_attempt: () => ({
      data: { ...claimed[0], provider_idempotency_key: 'campaign-recipient:r-1' }
    }),
    record_sms_campaign_provider_acceptance: () => ({ data: {} }),
    ...rest
  };
}

// ── The brake ───────────────────────────────────────────────────────────────

test('nothing is claimed and nothing is sent while live send is off', async () => {
  const client = fakeClient(baseHandlers());
  let sends = 0;

  for (const value of [undefined, '', 'false', 'TRUE', '1', 'yes', 'True']) {
    const summary = await deliverBatch({
      client,
      send: async () => { sends += 1; return { messageId: 'm' }; },
      env: value === undefined ? {} : { CAMPAIGNS_LIVE_SEND_ENABLED: value },
      log: SILENT
    });
    assert.equal(summary.enabled, false, `"${value}" must not enable sending`);
    assert.equal(summary.reason, 'live_send_disabled');
  }

  assert.equal(sends, 0, 'the provider was never called');
  assert.equal(client.calls.length, 0, 'the database was never even asked for work');
});

test('only the exact string "true" enables sending', () => {
  assert.equal(liveSendEnabled({ CAMPAIGNS_LIVE_SEND_ENABLED: 'true' }), true);
  for (const value of ['True', 'TRUE', '1', 'yes', '', undefined]) {
    assert.equal(liveSendEnabled({ CAMPAIGNS_LIVE_SEND_ENABLED: value }), false, String(value));
  }
});

// ── The happy path ──────────────────────────────────────────────────────────

test('an accepted send is recorded against the recipient with the database key', async () => {
  const client = fakeClient(baseHandlers());
  const sent = [];

  const summary = await deliverBatch({
    client,
    send: async (phone, text) => { sent.push({ phone, text }); return { messageId: 'msg-99' }; },
    env: ON,
    now: () => new Date('2026-08-23T10:00:00.000Z'),
    log: SILENT
  });

  assert.deepEqual(summary.accepted === 1 && summary.uncertain === 0 && summary.skipped === 0, true);
  assert.deepEqual(sent, [{ phone: '+15550001111', text: 'Your BPC-157 is back in stock.' }]);

  const acceptance = client.calls.find(c => c.name === 'record_sms_campaign_provider_acceptance');
  assert.equal(acceptance.args.p_provider_message_id, 'msg-99');
  assert.equal(acceptance.args.p_provider_idempotency_key, 'campaign-recipient:r-1',
    'the key comes from the database, never from this worker');
  assert.equal(acceptance.args.p_claim_token, 'claim-1');
});

test('recovery runs before any claim, so abandoned rows are resolved first', async () => {
  const client = fakeClient(baseHandlers({ claimed: [] }));
  await deliverBatch({ client, send: async () => ({ messageId: 'x' }), env: ON, log: SILENT });

  const order = client.calls.map(c => c.name);
  assert.equal(order[0], 'release_expired_sms_campaign_claims');
  assert.equal(order[1], 'claim_sms_campaign_recipients');
});

// ── The rule that matters ───────────────────────────────────────────────────

test('an uncertain provider call is never retried and never marked failed', async () => {
  const client = fakeClient(baseHandlers());
  // Counting the provider calls is the whole test. An earlier version asserted
  // only on the RPCs, which a retrying worker still satisfies when the retry
  // also fails — it passed against a deliberately broken worker. Count sends.
  let sends = 0;

  const summary = await deliverBatch({
    client,
    send: async () => { sends += 1; throw new Error('socket hang up'); },
    env: ON,
    log: SILENT
  });

  assert.equal(sends, 1, 'the provider was called exactly once, never retried');
  assert.equal(summary.uncertain, 1);
  assert.equal(summary.accepted, 0);
  assert.deepEqual(summary.reasons, { provider_call_uncertain: 1 });

  const names = client.calls.map(c => c.name);
  assert.equal(names.filter(n => n === 'begin_sms_campaign_provider_attempt').length, 1,
    'the attempt was not restarted');
  assert.equal(names.includes('record_sms_campaign_provider_acceptance'), false);
  assert.equal(names.includes('record_sms_campaign_provider_result'), false,
    'the worker must not invent a delivery result it cannot know');
});

test('a send that succeeds on an invisible retry is still caught', async () => {
  // The failure mode the test above missed: a worker that retries and gets a
  // message id the second time looks completely healthy from the RPC trace.
  const client = fakeClient(baseHandlers());
  let sends = 0;

  await deliverBatch({
    client,
    send: async () => {
      sends += 1;
      if (sends === 1) throw new Error('socket hang up');
      return { messageId: 'msg-on-retry' };
    },
    env: ON,
    log: SILENT
  });

  assert.equal(sends, 1, 'one uncertain call must not become two messages to one person');
});

test('a provider reply with no message id counts as uncertain, not as success', async () => {
  const client = fakeClient(baseHandlers());
  const summary = await deliverBatch({
    client, send: async () => ({ status: 'queued' }), env: ON, log: SILENT
  });

  assert.equal(summary.accepted, 0);
  assert.equal(summary.uncertain, 1);
  assert.equal(client.calls.some(c => c.name === 'record_sms_campaign_provider_acceptance'), false);
});

test('a message that was sent but could not be recorded is left for reconciliation', async () => {
  const client = fakeClient(baseHandlers({
    record_sms_campaign_provider_acceptance: () => ({ error: { message: 'connection reset' } })
  }));
  let sends = 0;

  const summary = await deliverBatch({
    client,
    send: async () => { sends += 1; return { messageId: 'msg-1' }; },
    env: ON,
    log: SILENT
  });

  assert.equal(sends, 1, 'sent exactly once');
  assert.equal(summary.accepted, 0);
  assert.equal(summary.uncertain, 1);
  assert.deepEqual(summary.reasons, { acceptance_not_recorded: 1 });
});

// ── Fences are normal, not faults ───────────────────────────────────────────

test('a recipient who became ineligible between claim and send is skipped quietly', async () => {
  for (const fence of [
    'campaign_recipient_no_longer_eligible',
    'campaign_claim_fence_failed',
    'campaign_live_send_disabled',
    'campaign_claim_reservation_missing'
  ]) {
    const client = fakeClient(baseHandlers({
      begin_sms_campaign_provider_attempt: () => ({ error: { message: `${fence} (P0001)` } })
    }));
    let sends = 0;

    const summary = await deliverBatch({
      client, send: async () => { sends += 1; return { messageId: 'm' }; }, env: ON, log: SILENT
    });

    assert.equal(sends, 0, `${fence}: the provider must not be called`);
    assert.equal(summary.skipped, 1, fence);
    assert.deepEqual(summary.reasons, { [fence]: 1 }, fence);
  }
});

test('a recipient with no frozen message is skipped without calling the provider', async () => {
  for (const value of [null, '', '   ']) {
    const client = fakeClient(baseHandlers({ claimed: [recipient({ rendered_message: value })] }));
    let sends = 0;

    const summary = await deliverBatch({
      client, send: async () => { sends += 1; return { messageId: 'm' }; }, env: ON, log: SILENT
    });

    assert.equal(sends, 0);
    assert.equal(summary.skipped, 1);
    assert.deepEqual(summary.reasons, { rendered_message_empty: 1 });
    assert.equal(client.calls.some(c => c.name === 'begin_sms_campaign_provider_attempt'), false);
  }
});

// ── One bad recipient does not stop the batch ───────────────────────────────

test('a failure on one recipient does not prevent the rest of the batch', async () => {
  const claimed = [
    recipient({ id: 'r-1', contact_phone: '+15550001111' }),
    recipient({ id: 'r-2', contact_phone: '+15550002222' }),
    recipient({ id: 'r-3', contact_phone: '+15550003333' })
  ];
  const client = fakeClient(baseHandlers({
    claimed,
    begin_sms_campaign_provider_attempt: (args) => ({
      data: { provider_idempotency_key: `campaign-recipient:${args.p_recipient_id}` }
    })
  }));

  const sent = [];
  const summary = await deliverBatch({
    client,
    send: async (phone) => {
      if (phone.endsWith('2222')) throw new Error('timeout');
      sent.push(phone);
      return { messageId: `msg-${phone.slice(-4)}` };
    },
    env: ON,
    log: SILENT
  });

  assert.equal(summary.claimed, 3);
  assert.equal(summary.accepted, 2);
  assert.equal(summary.uncertain, 1);
  assert.deepEqual(sent, ['+15550001111', '+15550003333']);
});

// ── Recovery ────────────────────────────────────────────────────────────────

test('claim recovery reports how many rows it resolved and raises a real fault', async () => {
  const ok = fakeClient({ release_expired_sms_campaign_claims: () => ({ data: 4 }) });
  assert.equal(await recoverExpiredClaims({ client: ok }), 4);

  const broken = fakeClient({
    release_expired_sms_campaign_claims: () => ({ error: { message: 'permission denied' } })
  });
  await assert.rejects(() => recoverExpiredClaims({ client: broken }),
    (error) => error.code === 'CAMPAIGN_CLAIM_RECOVERY_FAILED');
});

test('the batch and lease sent to the database stay inside what it accepts', async () => {
  const client = fakeClient(baseHandlers({ claimed: [] }));
  await deliverBatch({ client, send: async () => ({ messageId: 'm' }), env: ON, log: SILENT });

  const claim = client.calls.find(c => c.name === 'claim_sms_campaign_recipients');
  assert.ok(claim.args.p_limit >= 1 && claim.args.p_limit <= 100, 'claim RPC rejects outside 1..100');
  assert.ok(claim.args.p_lease_seconds >= 30 && claim.args.p_lease_seconds <= 300,
    'begin_provider_attempt rejects a lease outside 30..300');
});
