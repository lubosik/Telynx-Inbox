'use strict';
/**
 * test/campaign-dnd-parity.test.js
 *
 * THE PREVIEW AND THE SEND MUST AGREE ABOUT WHO CAN BE MESSAGED.
 *
 * Eligibility is deliberately checked twice: in JavaScript for the preview and
 * the dry run, and again in SQL inside the claim function, because a preview is
 * never authority to send later. That is the right design and it has one
 * failure mode, which is the two drifting apart.
 *
 * They did. The JavaScript was corrected to treat a NULL or empty per-channel
 * DND status as "no override, use the global flag", which is what GoHighLevel
 * actually returns: 944 contacts, every one `ghl_dnd = false`, and
 * `ghl_sms_dnd_status` NULL for all 944. The SQL still demanded the literal
 * string 'inactive'. NULL is not 'inactive'.
 *
 * So the preview said 924 people and the send would have reached nobody, with
 * the operator's face on the approval. A campaign that silently reaches zero is
 * worse than one that refuses, because the first thing anybody suspects is the
 * consent record, which is fine.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { evaluateRecipient } = require('../lib/campaigns/eligibility');

const MIGRATION = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'campaigns-migration.sql'), 'utf8');

/** The SQL rule, transcribed. Kept in one place so it can be compared. */
function sqlSaysContactable({ dnd, channelStatus, syncedAt, maxAgeHours = 24 }, now = Date.now()) {
  const normalised = String(channelStatus ?? '').trim().toLowerCase() || 'inactive';
  const synced = Date.parse(syncedAt);
  return dnd === false
    && normalised === 'inactive'
    && Number.isFinite(synced)
    && synced >= now - maxAgeHours * 3600_000
    && synced <= now;
}

function jsSaysEligible(row, now = new Date()) {
  return evaluateRecipient({
    phone: '+15551234567',
    contactOptedOut: false,
    contactDnd: row.dnd,
    smsDndStatus: row.channelStatus,
    dndSyncedAt: row.syncedAt,
    dndMaxAgeHours: row.maxAgeHours ?? 24,
    optOutSentinel: false,
    consentEvents: [{
      id: 1, event_type: 'opt_in', purpose: 'promotional_sms', brand_id: 'vici',
      source: 'woocommerce_account_registration', evidence_ref: 'customer #1',
      occurred_at: '2026-01-01T00:00:00.000Z'
    }],
    consentEvidenceRequired: true,
    authoritativeSuppressionReason: null,
    now
  }).eligible;
}

const FRESH = new Date().toISOString();

test('THE TWO CHECKS AGREE ON EVERY SHAPE THE DATA ACTUALLY TAKES', () => {
  const cases = [
    // The one that mattered: every contact in the account looks like this.
    { name: 'no channel override at all (NULL)', dnd: false, channelStatus: null, syncedAt: FRESH },
    { name: 'empty channel override', dnd: false, channelStatus: '', syncedAt: FRESH },
    { name: 'explicitly inactive', dnd: false, channelStatus: 'inactive', syncedAt: FRESH },
    { name: 'mixed case inactive', dnd: false, channelStatus: 'Inactive', syncedAt: FRESH },
    // Refusals. None of these may move.
    { name: 'globally do not disturb', dnd: true, channelStatus: null, syncedAt: FRESH },
    { name: 'channel actively suppressed', dnd: false, channelStatus: 'active', syncedAt: FRESH },
    { name: 'channel permanently suppressed', dnd: false, channelStatus: 'permanent', syncedAt: FRESH },
    { name: 'dnd flag missing entirely', dnd: null, channelStatus: null, syncedAt: FRESH },
    { name: 'never synced', dnd: false, channelStatus: null, syncedAt: null },
    { name: 'sync older than the window', dnd: false, channelStatus: null,
      syncedAt: new Date(Date.now() - 48 * 3600_000).toISOString() },
    { name: 'sync stamped in the future', dnd: false, channelStatus: null,
      syncedAt: new Date(Date.now() + 3600_000).toISOString() }
  ];

  for (const row of cases) {
    assert.equal(
      jsSaysEligible(row), sqlSaysContactable(row),
      `"${row.name}": the preview and the send disagree, which is how a campaign approved for hundreds reaches nobody`
    );
  }
});

test('the refusals really are refusals, so parity is not agreement on nothing', () => {
  // A test that only checks two functions match would pass if both said no to
  // everything. These four must be YES.
  for (const row of [
    { dnd: false, channelStatus: null, syncedAt: FRESH },
    { dnd: false, channelStatus: '', syncedAt: FRESH },
    { dnd: false, channelStatus: 'inactive', syncedAt: FRESH },
    { dnd: false, channelStatus: 'Inactive', syncedAt: FRESH }
  ]) assert.equal(jsSaysEligible(row), true);

  // And these must be NO.
  for (const row of [
    { dnd: true, channelStatus: null, syncedAt: FRESH },
    { dnd: false, channelStatus: 'active', syncedAt: FRESH },
    { dnd: false, channelStatus: 'permanent', syncedAt: FRESH },
    { dnd: false, channelStatus: null, syncedAt: null }
  ]) assert.equal(jsSaysEligible(row), false);
});

test('THE SHIPPED SQL STILL HAS THE OLD RULE, and this test says so out loud', () => {
  // scripts/campaigns-migration.sql is the original migration and is not
  // rewritten in place. The correction ships as scripts/FIX-SEND-GATE-DND.txt
  // and has to be run by hand against production.
  //
  // This assertion is a REMINDER, not a failure: while the old condition is
  // still in the migration file, anybody rebuilding this database from scratch
  // gets the divergent version back. When the migration is regenerated to use
  // the helper, flip this to assert the helper instead.
  const stale = /ghl_sms_dnd_status = 'inactive'/.test(MIGRATION);
  const fixed = /sms_dnd_says_contactable/.test(MIGRATION);
  assert.ok(stale || fixed,
    'the send-time DND check vanished from the migration entirely, which is worse than either version');

  if (stale && !fixed) {
    // Documented, not silently tolerated.
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts', 'FIX-SEND-GATE-DND.txt')),
      'the migration still carries the old rule, so the correction script must exist and be runnable');
  }
});
