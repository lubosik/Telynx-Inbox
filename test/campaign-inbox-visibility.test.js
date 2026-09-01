'use strict';
/**
 * test/campaign-inbox-visibility.test.js — a campaign message belongs in the
 * inbox, next to the reply it causes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT WAS WRONG
 *
 *   Campaign messages went out through the provider and were never written to
 *   sms_messages. The inbox therefore showed the REPLIES and not the messages
 *   that caused them: somebody answering "stop" appeared as a person texting
 *   the business out of nowhere.
 *
 *   Half a conversation is worse than none, because it reads as a complete
 *   one. The owner watched a "Stop" and a "thx!!" arrive with no visible
 *   cause while 74 campaign messages were in flight.
 *
 *   campaign_id and campaign_recipient_id had been columns on sms_messages
 *   the whole time. Nothing ever filled them in — measured on production, 0
 *   rows carried a campaign id.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { deliverBatch } = require('../lib/campaigns/delivery-worker');

const ENV = { CAMPAIGNS_LIVE_SEND_ENABLED: 'true' };

/**
 * A client that answers the send path and records what was written.
 *
 * `inboxFails` makes the sms_messages insert return an error, so the test can
 * check that a cosmetic failure does not damage a real send.
 */
function fakeClient({ recipients = [], inboxFails = false } = {}) {
  const writes = { messages: [], contacts: [] };
  return {
    writes,
    rpc(name, args) {
      if (name === 'claim_sms_campaign_recipients') {
        return Promise.resolve({ data: recipients, error: null });
      }
      if (name === 'begin_sms_campaign_provider_attempt') {
        return Promise.resolve({
          data: [{ provider_idempotency_key: `idem-${args.p_recipient_id}` }], error: null
        });
      }
      if (name === 'record_sms_campaign_provider_acceptance') {
        return Promise.resolve({ data: [{}], error: null });
      }
      if (name === 'release_expired_sms_campaign_claims') {
        return Promise.resolve({ data: 0, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from(table) {
      const chain = {
        insert(row) {
          if (table === 'sms_messages') {
            writes.messages.push(row);
            return Promise.resolve({ error: inboxFails ? { message: 'insert exploded' } : null });
          }
          return Promise.resolve({ error: null });
        },
        update(patch) { chain._patch = patch; return chain; },
        eq() {
          if (table === 'sms_contacts') writes.contacts.push(chain._patch);
          return Promise.resolve({ error: null });
        }
      };
      return chain;
    }
  };
}

const RECIPIENT = {
  id: 'rec-1',
  campaign_id: 'camp-1',
  contact_phone: '+15551110001',
  rendered_message: "Hi Adrian, it's Vin from Vici. Here's a code for 20% off: SMS20. Reply STOP to opt out.",
  claim_token: 'tok-1'
};

test('a sent campaign message is written to the inbox', async () => {
  const client = fakeClient({ recipients: [RECIPIENT] });
  const summary = await deliverBatch({
    client, env: ENV,
    send: async () => ({ messageId: 'prov-1' }),
    log: { error() {} }
  });

  assert.equal(summary.accepted, 1);
  assert.equal(client.writes.messages.length, 1, 'the message must appear in the inbox');

  const row = client.writes.messages[0];
  assert.equal(row.direction, 'outbound');
  assert.equal(row.contact_phone, RECIPIENT.contact_phone);
  assert.equal(row.body, RECIPIENT.rendered_message, 'the inbox shows what was actually sent');
  assert.equal(row.telnyx_message_id, 'prov-1', 'so a delivery receipt can find it later');

  // The columns that were on the table all along and never filled in.
  assert.equal(row.campaign_id, 'camp-1');
  assert.equal(row.campaign_recipient_id, 'rec-1');
});

test('the thread sorts to the top, like every other outbound message', async () => {
  // Without this a campaign just sent sits wherever that contact last happened
  // to talk to the business, which for a win-back audience is months ago.
  const client = fakeClient({ recipients: [RECIPIENT] });
  await deliverBatch({ client, env: ENV, send: async () => ({ messageId: 'prov-1' }), log: { error() {} } });

  assert.equal(client.writes.contacts.length, 1);
  assert.ok(client.writes.contacts[0].last_seen, 'last_seen must be touched');
});

test('a failed inbox write does not damage a real send', async () => {
  // The message is already gone and its acceptance already recorded against
  // the recipient, which is the row that decides whether anybody is texted
  // twice. This write only affects what a person sees, so throwing would
  // abandon the rest of the batch and change nothing about what was sent.
  const client = fakeClient({ recipients: [RECIPIENT], inboxFails: true });
  const logged = [];
  const summary = await deliverBatch({
    client, env: ENV,
    send: async () => ({ messageId: 'prov-1' }),
    log: { error: (...args) => logged.push(args.join(' ')) }
  });

  assert.equal(summary.accepted, 1, 'the send still counts as accepted');
  assert.equal(summary.reasons.inbox_write_failed, 1, 'and the miss is counted');
  assert.ok(
    logged.some(line => /did not reach the inbox/.test(line)),
    'and said out loud, because the reply will look unprompted'
  );
});

test('nothing is written to the inbox when nothing was sent', async () => {
  // A provider call that never confirmed must not leave a message in the
  // inbox implying it did.
  const client = fakeClient({ recipients: [RECIPIENT] });
  const summary = await deliverBatch({
    client, env: ENV,
    send: async () => { throw new Error('timeout'); },
    log: { error() {} }
  });

  assert.equal(summary.uncertain, 1);
  assert.deepEqual(client.writes.messages, [], 'an unconfirmed send is not a conversation');
});
