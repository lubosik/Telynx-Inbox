'use strict';
/**
 * test/campaign-send-pace.test.js — the pace of a send, and the status bug
 * that stopped one dead.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 82 OF 107 NEVER WENT OUT
 *
 *   The recovery campaign sent exactly 25 messages in 20 seconds and then
 *   nothing, for seventeen hours, with five clear hours of business time
 *   remaining that evening.
 *
 *   claim_sms_campaign_recipients required `c.status = 'scheduled'`, in three
 *   places, and begin_sms_campaign_provider_attempt required it in a fourth.
 *   reconcileCampaignStatuses — added the day before to stop campaigns
 *   claiming to be scheduled after they had sent — moves a campaign to
 *   `sending` as soon as one message is delivered.
 *
 *   So the first batch went out, the campaign correctly described itself as
 *   sending, and that made it invisible to the query that feeds the sender. A
 *   status field written for the screen changed what the database would do.
 *
 *   Every earlier campaign completed because it had finished sending before
 *   that reconciler shipped. This was the first campaign to run entirely
 *   afterwards, and it stalled at exactly one batch.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { SEND_PACE, sendPaceFrom } = require('../lib/campaigns/delivery-worker');

test('a campaign that is SENDING can still be claimed from', () => {
  // The whole bug in one assertion. The migration that fixes it must keep
  // both statuses, or the next campaign stalls at 25 again.
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'campaigns-migration.sql'), 'utf8');
  const claim = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.claim_sms_campaign_recipients'));
  const body = claim.slice(0, claim.indexOf('$function$', 200));

  assert.doesNotMatch(body, /c\.status = 'scheduled'/,
    "a campaign mid-send is not 'scheduled' any more, and must still be sendable");
});

test('the pace falls back rather than refusing to send', () => {
  // A settings row somebody typed a zero into must not stop a campaign. It
  // must send at the pace that has always worked.
  assert.deepEqual(sendPaceFrom(null), { batchSize: 25, intervalSeconds: 120 });
  assert.deepEqual(sendPaceFrom({}), { batchSize: 25, intervalSeconds: 120 });
  for (const bad of [0, -1, 'ten', null, NaN, 5000]) {
    assert.equal(sendPaceFrom({ send_batch_size: bad }).batchSize, 25, `batch ${bad}`);
  }
  for (const bad of [0, 5, -60, 'soon', 99999]) {
    assert.equal(sendPaceFrom({ send_interval_seconds: bad }).intervalSeconds, 120, `interval ${bad}`);
  }
});

test('a real choice is honoured exactly', () => {
  assert.deepEqual(sendPaceFrom({ send_batch_size: 10, send_interval_seconds: 300 }),
    { batchSize: 10, intervalSeconds: 300 });
  // The owner's two examples, both valid.
  assert.deepEqual(sendPaceFrom({ send_batch_size: 25, send_interval_seconds: 120 }),
    { batchSize: 25, intervalSeconds: 120 });
});

test('the bounds are the ones the database and the RPC enforce', () => {
  // 100 because claim_sms_campaign_recipients refuses more; 30 seconds because
  // below that a cycle is more round trip than sending. Repeated as CHECK
  // constraints so a value typed straight into the table cannot escape them.
  assert.equal(SEND_PACE.maxBatch, 100);
  assert.equal(SEND_PACE.minIntervalSeconds, 30);

  const migration = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'send-pace-settings-migration.sql'), 'utf8');
  assert.match(migration, /send_batch_size >= 1 AND send_batch_size <= 100/);
  assert.match(migration, /send_interval_seconds >= 30 AND send_interval_seconds <= 3600/);
});

test('the pace is re-read every cycle, not fixed at boot', () => {
  // The reason to change it is almost always a campaign going out right now,
  // so a value read once at startup would be the wrong one exactly when it
  // mattered.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const loop = server.slice(server.indexOf('[CAMPAIGN SEND] Live sending is ON'));
  const body = loop.slice(0, 1800);
  assert.match(body, /sendPaceFrom\(settings\)/, 'read inside the tick');
  assert.match(body, /lastSendAt \+ pace\.intervalSeconds \* 1000/,
    'and the interval is honoured by the clock rather than by setInterval');
});
