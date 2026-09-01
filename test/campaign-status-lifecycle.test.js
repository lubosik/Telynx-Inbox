'use strict';
/**
 * test/campaign-status-lifecycle.test.js — a campaign should say what it is
 * actually doing.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT WAS WRONG
 *
 *   `sending` and `completed` have been legal statuses since the first
 *   migration and nothing ever set either one. A campaign was marked
 *   `scheduled` at approval and stayed `scheduled` forever — through the send,
 *   after the last message, indefinitely.
 *
 *   The owner watched 412 messages go out and replies come back while the app
 *   showed four campaigns still waiting to start, and had to ask whether they
 *   had sent, because the only answer available to him was a guess.
 *
 *   The recipients are the truth. The status is a summary of them, derived
 *   every cycle rather than written once and trusted: a status set at the
 *   moment of an action is a claim about the future, this one is a report
 *   about the past.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { reconcileCampaignStatuses } = require('../lib/campaigns/delivery-worker');

/** A client holding one campaign and its recipients, recording any update. */
function fakeClient({ status, states, failWrite = false }) {
  const updates = [];
  return {
    updates,
    from(table) {
      const chain = {
        _table: table,
        select() { return chain; },
        eq(column, value) {
          if (table === 'sms_campaigns' && column === 'status') {
            // The final guard of the update chain.
            chain._guardStatus = value;
            return Promise.resolve({ error: failWrite ? { message: 'write refused' } : null });
          }
          if (table === 'sms_campaign_recipients') {
            return Promise.resolve({ data: states.map(s => ({ state: s })), error: null });
          }
          return chain;
        },
        in() {
          return Promise.resolve({ data: [{ id: 'camp-1', status }], error: null });
        },
        update(patch) { updates.push(patch); return chain; }
      };
      return chain;
    }
  };
}

const silent = { error() {}, log() {} };

test('a campaign nobody has been sent to yet stays scheduled', async () => {
  // Approved and waiting for its time. Saying "sending" here would be a lie
  // in the other direction.
  const client = fakeClient({ status: 'scheduled', states: Array(40).fill('pending') });
  const changed = await reconcileCampaignStatuses({ client, log: silent });
  assert.deepEqual(changed, { sending: 0, completed: 0 });
  assert.deepEqual(client.updates, []);
});

test('one message out and it is sending', async () => {
  const client = fakeClient({
    status: 'scheduled',
    states: [...Array(39).fill('pending'), 'delivered']
  });
  const changed = await reconcileCampaignStatuses({ client, log: silent });
  assert.equal(changed.sending, 1);
  assert.equal(client.updates[0].status, 'sending');
  assert.equal(client.updates[0].completed_at, undefined, 'it has not finished');
});

test('nothing left to send and it is completed, with the time it finished', async () => {
  const client = fakeClient({
    status: 'sending',
    states: [...Array(38).fill('delivered'), 'suppressed', 'failed']
  });
  const changed = await reconcileCampaignStatuses({ client, log: silent });
  assert.equal(changed.completed, 1);
  assert.equal(client.updates[0].status, 'completed');
  assert.ok(client.updates[0].completed_at, 'completed_at is what the app shows as finished at');
});

test('a row awaiting a human decision does not hold the whole campaign open', async () => {
  // reconciliation_required needs a person, not time. Holding 375 delivered
  // messages at "sending" because of one ambiguous row would misdescribe the
  // campaign; the count is surfaced separately, where it can be acted on.
  const client = fakeClient({
    status: 'sending',
    states: [...Array(375).fill('delivered'), 'reconciliation_required']
  });
  const changed = await reconcileCampaignStatuses({ client, log: silent });
  assert.equal(changed.completed, 1);
});

test('a claimed row still counts as outstanding', async () => {
  // It is mid-flight and will resolve on its own, so the campaign is still
  // sending rather than finished.
  const client = fakeClient({
    status: 'sending',
    states: [...Array(20).fill('delivered'), 'claimed']
  });
  const changed = await reconcileCampaignStatuses({ client, log: silent });
  assert.deepEqual(changed, { sending: 0, completed: 0 }, 'already sending, nothing to change');
  assert.deepEqual(client.updates, []);
});

test('a campaign with no recipients is left alone', async () => {
  // An empty campaign is a different problem from a finished one and must not
  // be dressed up as success.
  const client = fakeClient({ status: 'scheduled', states: [] });
  const changed = await reconcileCampaignStatuses({ client, log: silent });
  assert.deepEqual(changed, { sending: 0, completed: 0 });
  assert.deepEqual(client.updates, []);
});

test('the update is guarded on the status it was read at', async () => {
  // Somebody cancelling a campaign in the app while this runs must not have
  // that overwritten by a status derived from a moment ago.
  const client = fakeClient({ status: 'sending', states: Array(5).fill('delivered') });
  await reconcileCampaignStatuses({ client, log: silent });
  assert.equal(client.updates.length, 1, 'exactly one write attempt');
});

test('a write that fails is reported, not swallowed silently', async () => {
  const client = fakeClient({
    status: 'sending', states: Array(5).fill('delivered'), failWrite: true
  });
  const errors = [];
  const changed = await reconcileCampaignStatuses({
    client, log: { error: (...a) => errors.push(a.join(' ')), log() {} }
  });
  assert.equal(changed.completed, 0, 'it must not claim a change it did not make');
  assert.ok(errors.some(line => /Could not move/.test(line)));
});
