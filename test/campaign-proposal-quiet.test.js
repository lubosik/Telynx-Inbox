'use strict';
/**
 * test/campaign-proposal-quiet.test.js — nothing to say means say nothing.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 *
 *   Fixing the opportunity contract turned the automatic proposal path from
 *   "rejects all six findings every day" into "drafts all six findings every
 *   day". That is the intended behaviour for the DRAFTS — a pending proposal
 *   should track its cohort's numbers — and it very nearly turned into a
 *   notification every single morning.
 *
 *   The daily digest bypasses its own novelty gate whenever a proposal was
 *   drafted, on the reasoning that "a new proposal is news on its own however
 *   familiar the segment movement beside it is". Sound, but only if "drafted"
 *   means NEW. It was wired to `saved`, which counts the upsert, and the
 *   upsert refreshes every pending proposal daily. So the owner would have
 *   been told "6 campaign proposals are waiting for review" every day, about
 *   the same six proposals, until he turned notifications off.
 *
 *   The owner asked for exactly this: if there is nothing worth reviewing or
 *   proposing, it should not force anything.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createProposalService } = require('../lib/campaigns/proposal-service');
const { prepareDailyDigest } = require('../lib/notifications/daily-digest');

/** A Supabase-shaped stub holding proposal rows in memory. */
function fakeDb(rows = []) {
  const store = [...rows];
  return {
    store,
    from() {
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        in(_column, keys) {
          return Promise.resolve({
            data: store.filter(row => keys.includes(row.proposal_key)), error: null
          });
        },
        upsert(written) {
          for (const row of written) {
            const at = store.findIndex(existing => existing.proposal_key === row.proposal_key);
            if (at >= 0) store[at] = { ...store[at], ...row };
            else store.push({ ...row, status: 'proposed' });
          }
          chain._written = written;
          return chain;
        },
        select_() { return chain; }
      };
      // upsert(...).select(...) resolves to the written rows.
      chain.select = (...args) => (chain._written
        ? Promise.resolve({ data: chain._written.map(row => ({ ...row, status: 'proposed' })), error: null })
        : chain);
      return chain;
    }
  };
}

function proposal(key) {
  return {
    proposalKey: key,
    opportunityId: 'one_time_lapsed',
    opportunityKind: 'repeat_purchase',
    opportunityTitle: 'Bought once, and the usual return time has passed',
    mechanismId: key.split(':')[1],
    title: 'A proposal',
    // The real shape assertSurfaceable demands: validated, with the record of
    // which checks ran. A proposal whose copy never passed the validator is
    // never surfaced, and saveBatch enforces that before it writes anything.
    copy: {
      text: 'Vin from Vici. Hello. Reply STOP to opt out.',
      validated: true,
      failedChecks: []
    },
    audience: { segmentKey: 'one_time_lapsed', size: 278 },
    contractVersion: 'v1'
  };
}

test('a proposal is new once, and refreshed thereafter', async () => {
  const db = fakeDb();
  const service = createProposalService({ client: db, workspaceID: 'vici' });
  const batch = [proposal('one_time_lapsed:a'), proposal('one_time_lapsed:b')];

  const first = await service.saveBatch(batch, { model: 'stub' });
  assert.equal(first.created.length, 2, 'both are new on the first day');

  const second = await service.saveBatch(batch, { model: 'stub' });
  assert.equal(second.created.length, 0, 'neither is new on the second day');
  assert.equal(second.saved.length, 2, 'but both are still refreshed');

  const third = await service.saveBatch([...batch, proposal('one_time_lapsed:c')], { model: 'stub' });
  assert.equal(third.created.length, 1, 'only the genuinely new one counts');
});

test('a proposal a human decided is never regenerated', async () => {
  const db = fakeDb([
    { proposal_key: 'one_time_lapsed:a', status: 'dismissed' },
    { proposal_key: 'one_time_lapsed:b', status: 'accepted' }
  ]);
  const service = createProposalService({ client: db, workspaceID: 'vici' });
  const out = await service.saveBatch(
    [proposal('one_time_lapsed:a'), proposal('one_time_lapsed:b')], { model: 'stub' }
  );
  assert.equal(out.created.length, 0);
  assert.equal(out.saved.length, 0);
  assert.deepEqual(out.skipped.map(row => row.reason).sort(), ['already_accepted', 'already_dismissed']);
});

// ── The digest ─────────────────────────────────────────────────────────────

const QUIET_INPUT = {
  segments: [],
  users: [{ id: 1, isActive: true, role: 'owner', canManageCampaigns: true }],
  recentHashes: [],
  coldStart: false
};

test('no movement and no new proposal says nothing at all', () => {
  const digest = prepareDailyDigest({ ...QUIET_INPUT, proposalsDrafted: 0 });
  assert.equal(digest.send, false, 'a quiet day must be silent');
  assert.equal(digest.reason, 'nothing_material');
});

test('the same proposals a second day do not push again', () => {
  // THE REGRESSION THIS FILE IS FOR. With proposalsDrafted wired to `saved`,
  // this was 6 every morning and the novelty gate was bypassed every morning.
  //
  // Movement big enough to be material, so the digest reaches the NOVELTY gate
  // rather than stopping earlier at "nothing_material" — the point is to prove
  // that gate is reached and applied, not merely that some gate fired.
  const movement = [{
    key: 'one_time_lapsed', name: 'Lapsed',
    joinedCount: 45, leftCount: 0, memberCount: 278, previousCount: 233
  }];

  const dayOne = prepareDailyDigest({ ...QUIET_INPUT, segments: movement, proposalsDrafted: 1 });
  assert.equal(dayOne.send, true, 'day one is news: new proposals and real movement');

  const dayTwo = prepareDailyDigest({
    ...QUIET_INPUT, segments: movement,
    recentHashes: [dayOne.headlineHash],
    // The refreshed-but-not-new case. This is the number that used to be 6.
    proposalsDrafted: 0
  });
  assert.equal(dayTwo.send, false, 'the same claim on a later day is not news');
  assert.equal(dayTwo.reason, 'not_novel',
    'it must be the novelty gate that stops it, which is the gate the drafted '
    + 'count used to bypass');
});

test('refreshed proposals alone, with no movement at all, stay silent', () => {
  // The commonest day once this is running: six pending proposals refreshed,
  // nothing joined or left, nothing to report.
  const digest = prepareDailyDigest({ ...QUIET_INPUT, proposalsDrafted: 0 });
  assert.equal(digest.send, false);
  assert.equal(digest.reason, 'nothing_material');
});

test('a genuinely new proposal is still worth a notification', () => {
  const digest = prepareDailyDigest({ ...QUIET_INPUT, proposalsDrafted: 2 });
  assert.equal(digest.send, true, 'new proposals are news the day they appear');
  assert.match(digest.body, /2 campaign proposals are waiting for review/);
});

test('the cycle reports created, not saved, to the digest', () => {
  // Structural: the two numbers are both on the summary and only one of them
  // is news. Wiring the wrong one back in is a one-word edit with a daily
  // notification as its symptom.
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'daily-cycle.js'), 'utf8');
  assert.match(source, /proposalsDrafted:\s*Number\(cycleSummary\.proposals\?\.created \|\| 0\)/,
    'the digest must be told about NEW proposals, never about refreshed ones');
});
