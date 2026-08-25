'use strict';
/**
 * test/opt-out-suppression.test.js
 *
 * A STOP has always been honoured: markOptedOut writes a sentinel and the send
 * path refuses anybody holding one. What is under test here is everything that
 * was NOT happening, and one thing that must never start.
 *
 * The must-never: recording consent for 903 people makes the opt-out path the
 * load-bearing one. Before the backfill, a bug here was invisible, because
 * nobody was eligible anyway. After it, a swallowed failure is somebody being
 * messaged after asking to be left alone.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { suppressOptOut } = require('../lib/opt-out-suppression');

const PHONE = '+15551234567';
const NOW = () => new Date('2026-08-25T12:00:00.000Z');

/** A Supabase double that records every write and can be told to fail one. */
function db({ existingSuppression = null, failOn = null } = {}) {
  const writes = [];
  const make = (table) => {
    const state = { table, filters: {} };
    const builder = {
      select() { return builder; },
      eq(column, value) { state.filters[column] = value; return builder; },
      async maybeSingle() {
        if (failOn === `${table}:read`) return { data: null, error: { message: 'read failed' } };
        return { data: existingSuppression, error: null };
      },
      async insert(row) {
        writes.push({ table, row });
        if (failOn === `${table}:insert`) return { error: { message: 'insert failed', code: 'XXFAIL' } };
        if (failOn === `${table}:duplicate`) return { error: { message: 'dupe', code: '23505' } };
        return { error: null };
      }
    };
    return builder;
  };
  return { writes, from: make };
}

test('a STOP lands on the do-not-contact list AND in the consent trail', () => {
  // Two independent bars, plus the sentinel that already existed. The point is
  // not redundancy for its own sake: the suppression row is what the operator
  // can SEE, and the consent event is what outranks the opt-in the backfill
  // wrote for this same person.
  const client = db();
  return suppressOptOut(PHONE, { client, now: NOW }).then(outcome => {
    assert.deepEqual(outcome, { suppressed: true, consentRecorded: true });
    assert.deepEqual(client.writes.map(w => w.table),
      ['sms_campaign_suppressions', 'sms_consent_events']);
  });
});

test('the suppression says they asked, not that somebody blocked them', async () => {
  const client = db();
  await suppressOptOut(PHONE, { client, now: NOW });
  const row = client.writes.find(w => w.table === 'sms_campaign_suppressions').row;
  // 'manual_block' would be a lie, and the difference is the whole
  // justification for the row six months from now.
  assert.equal(row.reason_code, 'compliance_hold');
  assert.equal(row.source, 'sms_stop');
  assert.match(row.evidence_ref, /Texted STOP/);
  assert.equal(row.active, true);
});

test('THE OPT-OUT OUTRANKS THE BACKFILLED OPT-IN, which is the whole point', async () => {
  const client = db();
  await suppressOptOut(PHONE, { client, now: NOW });
  const row = client.writes.find(w => w.table === 'sms_consent_events').row;
  assert.equal(row.event_type, 'opt_out');
  // Consent precedence is by occurred_at DESC. The backfill stamps opt-ins
  // with the account creation date, always in the past, so a STOP recorded at
  // the current time cannot be outranked by it. If this were ever backdated,
  // an opt-out could sort BELOW an opt-in and the person would be messaged.
  assert.equal(row.occurred_at, NOW().toISOString());
  assert.ok(Date.parse(row.occurred_at) > Date.parse('2026-01-01'),
    'an opt-out must never be stamped in the distant past');
});

test('a second STOP from the same person writes no second suppression', async () => {
  const client = db({ existingSuppression: { id: 'existing' } });
  const outcome = await suppressOptOut(PHONE, { client, now: NOW });
  assert.equal(outcome.suppressed, true);
  assert.equal(client.writes.filter(w => w.table === 'sms_campaign_suppressions').length, 0,
    'they meant the same thing twice');
});

test('a retried webhook is deduped by day, not silently doubled', async () => {
  const client = db();
  await suppressOptOut(PHONE, { client, now: NOW });
  const row = client.writes.find(w => w.table === 'sms_consent_events').row;
  assert.equal(row.dedupe_key, `optout:${PHONE}:2026-08-25`);
});

test('the unique-violation from that dedupe counts as success, not failure', async () => {
  const client = db({ failOn: 'sms_consent_events:duplicate' });
  const outcome = await suppressOptOut(PHONE, { client, now: NOW });
  // 23505 means the row is already there, which is the outcome that was wanted.
  assert.equal(outcome.consentRecorded, true);
});

test('IT NEVER THROWS, because the STOP is already honoured by the time it runs', async () => {
  // The caller has written the sentinel and cancelled the queue. Throwing here
  // would abort the rest of the webhook to complain about bookkeeping.
  for (const failure of ['sms_campaign_suppressions:insert',
                         'sms_campaign_suppressions:read',
                         'sms_consent_events:insert']) {
    const client = db({ failOn: failure });
    const outcome = await suppressOptOut(PHONE, { client, now: NOW });
    assert.equal(typeof outcome.suppressed, 'boolean', `${failure} must not throw`);
  }
});

test('one half failing does not take the other half down with it', async () => {
  const client = db({ failOn: 'sms_campaign_suppressions:insert' });
  const outcome = await suppressOptOut(PHONE, { client, now: NOW });
  assert.equal(outcome.suppressed, false);
  // The consent withdrawal still got recorded, and that is the one the send
  // path reads. Two dependent writes would have lost it.
  assert.equal(outcome.consentRecorded, true);
});

test('a malformed number is refused before it reaches the database', async () => {
  for (const bad of ['', null, undefined, 'STOP', '5551234567', '+0123456789']) {
    const client = db();
    const outcome = await suppressOptOut(bad, { client, now: NOW });
    assert.deepEqual(outcome, { suppressed: false, consentRecorded: false });
    assert.deepEqual(client.writes, [], `${bad} must not reach the table`);
  }
});

test('the webhook calls it, after honouring the STOP and never before', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'webhook.js'), 'utf8');
  const stop = source.slice(source.indexOf('isOptOutRequest(text'));
  const markAt = stop.indexOf('markOptedOut(fromPhone)');
  const cancelAt = stop.indexOf('cancelScheduledForCustomer(fromPhone)');
  const suppressAt = stop.indexOf('suppressOptOut(fromPhone)');
  assert.ok(markAt >= 0 && cancelAt >= 0 && suppressAt >= 0);
  // Order matters. The sentinel and the queue cancellation are what actually
  // stop messages going out; the list and the trail are the record of it.
  assert.ok(markAt < suppressAt, 'suppress the customer before recording it');
  assert.ok(cancelAt < suppressAt, 'cancel the queue before recording it');
});
