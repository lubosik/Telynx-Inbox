'use strict';
/**
 * test/campaign-reply-events.test.js — a campaign should know when somebody
 * answered it.
 *
 * Campaign analytics reported `replies: 0` and `optOuts: 0` for a send where
 * ten people had texted STOP. Not approximately wrong: categorically wrong,
 * and exactly the number somebody would use to decide whether to run the
 * campaign again.
 *
 * Nothing was broken in the analytics. It reads sms_campaign_recipient_events
 * for customer.replied and recipient.opted_out, and only the provider ever
 * wrote there — 831 rows, every one a provider event. The inbound webhook
 * handled a reply for the inbox and for suppression, then dropped it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { looksLikeOptOut, recordCampaignReplyEvents } = require('../lib/campaigns/reply-events');

function fakeClient({ recipient = null, writeError = null } = {}) {
  const written = [];
  return {
    written,
    from(table) {
      const chain = {
        select() { return chain; }, eq() { return chain; },
        not() { return chain; }, gte() { return chain; },
        order() { return chain; },
        limit() { return Promise.resolve({ data: recipient ? [recipient] : [], error: null }); },
        upsert(rows) { written.push(...rows); return Promise.resolve({ error: writeError }); }
      };
      return chain;
    }
  };
}

const RECIPIENT = { id: 'rec-1', campaign_id: 'camp-1', sent_at: '2026-09-01T18:00:00Z' };
const silent = { error() {} };

test('a plain reply is recorded against the campaign that caused it', async () => {
  const client = fakeClient({ recipient: RECIPIENT });
  const out = await recordCampaignReplyEvents({
    client, phone: '+15551110001', body: 'Thanks!', occurredAt: '2026-09-01T18:05:00Z', log: silent
  });
  assert.deepEqual(out, { matched: true, replied: true, optedOut: false });
  assert.equal(client.written.length, 1);
  assert.equal(client.written[0].event_type, 'customer.replied');
  assert.equal(client.written[0].campaign_id, 'camp-1');
  assert.equal(client.written[0].trusted, true, 'analytics ignores an untrusted event');
});

test('STOP is recorded as both a reply and an opt-out', async () => {
  for (const body of ['STOP', 'stop', ' Stop ', 'unsubscribe', 'STOP.', 'opt out']) {
    const client = fakeClient({ recipient: RECIPIENT });
    const out = await recordCampaignReplyEvents({
      client, phone: '+15551110001', body, occurredAt: '2026-09-01T18:05:00Z', log: silent
    });
    assert.equal(out.optedOut, true, `"${body}" should count as an opt-out`);
    const types = client.written.map(r => r.event_type);
    assert.deepEqual(types, ['customer.replied', 'recipient.opted_out']);
  }
});

test('a complaint is not a keyword', async () => {
  // This decides a compliance number. "stop sending me so many of these" is
  // somebody annoyed, not somebody using the opt-out mechanism, and counting
  // it as one would misreport both figures.
  for (const body of ['stop sending me so many of these', 'please stop the emails', 'nonstop']) {
    assert.equal(looksLikeOptOut(body), false, `"${body}" must not count`);
  }
});

test('a reply from someone in no recent campaign is recorded nowhere', async () => {
  // It is a conversation, not a campaign metric.
  const client = fakeClient({ recipient: null });
  const out = await recordCampaignReplyEvents({
    client, phone: '+15559999999', body: 'hello', log: silent
  });
  assert.deepEqual(out, { matched: false, replied: false, optedOut: false });
  assert.deepEqual(client.written, []);
});

test('one person leaving is one opt-out, however many times they say it', async () => {
  // Somebody texting STOP three times is one person leaving. Counting three
  // would overstate what the campaign cost.
  const client = fakeClient({ recipient: RECIPIENT });
  await recordCampaignReplyEvents({
    client, phone: '+15551110001', body: 'STOP', occurredAt: '2026-09-01T18:05:00Z', log: silent
  });
  const optOut = client.written.find(r => r.event_type === 'recipient.opted_out');
  assert.equal(optOut.dedupe_key, 'optout:rec-1', 'keyed on the person, not the moment');
});

test('a failed write never throws into the webhook', async () => {
  // The reply is already in the inbox and the opt-out already honoured by the
  // suppression sentinel. Failing the webhook would risk the provider retrying
  // a message whose real work is done.
  const client = fakeClient({ recipient: RECIPIENT, writeError: { message: 'no constraint' } });
  const errors = [];
  const out = await recordCampaignReplyEvents({
    client, phone: '+15551110001', body: 'STOP',
    log: { error: (...a) => errors.push(a.join(' ')) }
  });
  assert.equal(out.replied, false, 'it must not claim a write it did not make');
  assert.ok(errors.some(l => /only the campaign numbers are affected/.test(l)));
});
