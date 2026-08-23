'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TRUSTED_SOURCE,
  recordCampaignDeliveryResult,
  terminalResult
} = require('../lib/campaigns/delivery-receipts');

const SILENT = { warn() {}, error() {}, log() {} };

function fakeClient({ owned = { id: 'r-1' }, lookupError = null, rpcError = null } = {}) {
  const calls = [];
  return {
    calls,
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => {
          calls.push({ name: 'lookup' });
          return { data: owned, error: lookupError };
        }
      };
    },
    rpc(name, args) {
      calls.push({ name, args });
      return Promise.resolve({ data: null, error: rpcError });
    }
  };
}

test('only terminal outcomes are results; progress is not', () => {
  assert.equal(terminalResult('delivered'), 'delivered');
  assert.equal(terminalResult('DELIVERED'), 'delivered');
  assert.equal(terminalResult('failed'), 'failed');
  assert.equal(terminalResult('undelivered'), 'failed');
  for (const value of ['sent', 'queued', 'sending', '', null, undefined, 'unknown']) {
    assert.equal(terminalResult(value), null, String(value));
  }
});

test('an ordinary order confirmation is left completely alone', async () => {
  const client = fakeClient({ owned: null });
  const outcome = await recordCampaignDeliveryResult({
    client, providerMessageId: 'msg-order-1', status: 'delivered', signatureValid: true, log: SILENT
  });

  assert.deepEqual(outcome, { recorded: false, reason: 'not_a_campaign_message' });
  assert.equal(client.calls.some(c => c.name === 'record_sms_campaign_provider_result'), false,
    'no service-role RPC for a message that is not a campaign message');
});

test('a progress event never reaches the database at all', async () => {
  const client = fakeClient();
  for (const status of ['sent', 'queued']) {
    const outcome = await recordCampaignDeliveryResult({
      client, providerMessageId: 'msg-1', status, log: SILENT
    });
    assert.deepEqual(outcome, { recorded: false, reason: 'not_terminal' }, status);
  }
  assert.equal(client.calls.length, 0);
});

test('a signed delivery is recorded as trusted evidence', async () => {
  const client = fakeClient();
  const outcome = await recordCampaignDeliveryResult({
    client,
    providerMessageId: 'msg-1',
    status: 'delivered',
    occurredAt: new Date('2026-08-23T10:05:00.000Z'),
    eventId: 'evt-9',
    signatureValid: true,
    log: SILENT
  });

  assert.deepEqual(outcome, { recorded: true, result: 'delivered', trusted: true });
  const rpc = client.calls.find(c => c.name === 'record_sms_campaign_provider_result');
  assert.equal(rpc.args.p_result, 'delivered');
  assert.equal(rpc.args.p_trust_source, TRUSTED_SOURCE);
  assert.equal(rpc.args.p_provider_event_id, 'evt-9');
  assert.equal(rpc.args.p_occurred_at, '2026-08-23T10:05:00.000Z');
});

test('an unsigned delivery updates the recipient but carries no trust', async () => {
  const client = fakeClient();
  const outcome = await recordCampaignDeliveryResult({
    client, providerMessageId: 'msg-1', status: 'delivered', signatureValid: false, log: SILENT
  });

  assert.equal(outcome.recorded, true);
  assert.equal(outcome.trusted, false);
  const rpc = client.calls.find(c => c.name === 'record_sms_campaign_provider_result');
  assert.equal(rpc.args.p_trust_source, null,
    'an unverified webhook must never become revenue evidence');
});

test('a failure carries its provider error code', async () => {
  const client = fakeClient();
  await recordCampaignDeliveryResult({
    client, providerMessageId: 'msg-1', status: 'undelivered',
    errorCode: '40010', signatureValid: true, log: SILENT
  });

  const rpc = client.calls.find(c => c.name === 'record_sms_campaign_provider_result');
  assert.equal(rpc.args.p_result, 'failed');
  assert.equal(rpc.args.p_error_code, '40010');
});

test('every expected fence is reported, not thrown', async () => {
  for (const fence of [
    'campaign_recipient_not_found',
    'campaign_provider_result_fence_failed',
    'campaign_provider_result_time_invalid',
    'campaign_provider_result_invalid'
  ]) {
    const client = fakeClient({ rpcError: { message: `${fence} (P0001)` } });
    const outcome = await recordCampaignDeliveryResult({
      client, providerMessageId: 'msg-1', status: 'delivered', log: SILENT
    });
    assert.deepEqual(outcome, { recorded: false, reason: fence }, fence);
  }
});

test('nothing here can throw into the webhook', async () => {
  const exploding = {
    from() { throw new Error('database is on fire'); },
    rpc() { throw new Error('database is on fire'); }
  };
  const outcome = await recordCampaignDeliveryResult({
    client: exploding, providerMessageId: 'msg-1', status: 'delivered', log: SILENT
  });
  assert.deepEqual(outcome, { recorded: false, reason: 'unexpected_error' });

  const brokenLookup = fakeClient({ lookupError: { code: 'PGRST301' } });
  const second = await recordCampaignDeliveryResult({
    client: brokenLookup, providerMessageId: 'msg-1', status: 'delivered', log: SILENT
  });
  assert.deepEqual(second, { recorded: false, reason: 'lookup_failed' });
});
