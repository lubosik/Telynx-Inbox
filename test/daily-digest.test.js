'use strict';
/**
 * The four materiality gates, the two day-one edge cases, and the circuit
 * breaker.
 *
 * These are the rules that decide whether the owner's phone lights up. Getting
 * them wrong in either direction kills the feature: too loose and it is
 * disabled within a week, too tight and he misses the one day that mattered.
 * Every threshold in lib/notifications/daily-digest.js is argued in that file's
 * header; this file proves the argument is what the code does.
 *
 * The numbers below are the real ones. `one_time_buyers` holds about five
 * hundred people and the same-product reorder engine finds single digits out of
 * 781 buyers, so the fixtures use those shapes rather than round invented ones.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CIRCUIT_BREAKER_FRACTION,
  DEFAULT_CRITICAL_SEGMENTS,
  MAX_NAMED_SEGMENTS,
  crossedRoundThreshold,
  directionOf,
  headlineHash,
  materialityThresholds,
  noveltyVerdict,
  prepareDailyDigest,
  segmentMateriality
} = require('../lib/notifications/daily-digest');

const OWNER = { id: 1, role: 'owner', isActive: true, canManageCampaigns: true };
const ADMIN = { id: 2, role: 'admin', isActive: true, canManageCampaigns: true };
const AGENT = { id: 3, role: 'agent', isActive: true, canManageCampaigns: true };
const NO_CAMPAIGNS = { id: 5, role: 'admin', isActive: true, canManageCampaigns: false };

const THRESHOLDS = materialityThresholds({});

function segment(overrides = {}) {
  return {
    key: 'one_time_buyers',
    name: 'Bought once and never came back',
    previousCount: 504,
    memberCount: 504,
    joinedCount: 0,
    leftCount: 0,
    ...overrides
  };
}

function digest(overrides = {}) {
  return prepareDailyDigest({
    users: [OWNER],
    segments: [],
    localDay: '2026-08-24',
    generatedAt: new Date('2026-08-24T07:30:00.000Z'),
    ...overrides
  });
}

// ── Gate 2: material ────────────────────────────────────────────────────────

test('the thresholds are the conjunction of an absolute and a relative test', () => {
  assert.equal(THRESHOLDS.absoluteFloor, 3);
  assert.equal(THRESHOLDS.relativeFloor, 0.10);
});

test('three people out of five hundred is noise and does not fire', () => {
  // Absolute-only would pass this, which is exactly why the relative test is
  // conjoined. 504 to 507 is not news about a business.
  const verdict = segmentMateriality(
    segment({ memberCount: 507, joinedCount: 3 }), THRESHOLDS);
  assert.equal(verdict.material, false);
  assert.equal(verdict.reason, 'below_threshold');
  assert.equal(verdict.required, 51, 'ten per cent of 504, rounded up');
});

test('one person out of three is thirty-three per cent and still does not fire', () => {
  // Relative-only would pass this. It is one person.
  const verdict = segmentMateriality(segment({
    key: 'one_time_multi_product', previousCount: 3, memberCount: 4, joinedCount: 1
  }), THRESHOLDS);
  assert.equal(verdict.material, false);
  assert.equal(verdict.reason, 'below_threshold');
  assert.equal(verdict.required, 3, 'the absolute floor governs a tiny segment');
});

test('a real shift in a large cohort does fire', () => {
  const verdict = segmentMateriality(
    segment({ memberCount: 444, leftCount: 60 }), THRESHOLDS);
  assert.equal(verdict.material, true);
  assert.equal(verdict.reason, 'threshold');
  assert.equal(verdict.direction, 'down');
});

test('a revenue critical list fires on a single arrival', () => {
  // The same-product reorder engine finds about nine people out of 781 buyers.
  // One arrival there is the most actionable thing that will happen this month.
  for (const key of DEFAULT_CRITICAL_SEGMENTS) {
    const verdict = segmentMateriality({
      key, previousCount: 9, memberCount: 10, joinedCount: 1, leftCount: 0
    }, THRESHOLDS);
    assert.equal(verdict.material, true, `${key} must fire on one`);
    assert.equal(verdict.critical, true);
  }
  // And the exception is narrow: an ordinary cohort of nine does not.
  assert.equal(segmentMateriality({
    key: 'one_time_slipping', previousCount: 9, memberCount: 10, joinedCount: 1
  }, THRESHOLDS).material, false);
});

test('empty to populated and populated to empty bypass the threshold', () => {
  // Zero to two people is not two people. It is a list that has started
  // working, and the reverse is usually something broken upstream.
  assert.equal(segmentMateriality(
    segment({ previousCount: 0, memberCount: 2, joinedCount: 2 }), THRESHOLDS).reason,
    'became_populated');
  assert.equal(segmentMateriality(
    segment({ previousCount: 40, memberCount: 0, leftCount: 40 }), THRESHOLDS).reason,
    'became_empty');
});

test('net zero churn is not push worthy', () => {
  // Sixty in and sixty out of the same list leaves the same list. Interesting
  // in the app; not a reason to interrupt somebody.
  const verdict = segmentMateriality(
    segment({ memberCount: 504, joinedCount: 60, leftCount: 60 }), THRESHOLDS);
  assert.equal(verdict.material, false);
  assert.equal(verdict.reason, 'net_zero_churn');
});

test('the existing per-segment setting acts as a lower bound and cannot be undercut', () => {
  // Raising SEGMENT_CHANGE_NOTIFICATION_MIN_DELTA must raise the digest too, so
  // the two settings can never make the daily summary louder than the
  // interactive push it summarises.
  const raised = materialityThresholds({
    SEGMENT_CHANGE_NOTIFICATION_MIN_DELTA: '25', DAILY_DIGEST_MIN_DELTA: '3'
  });
  assert.equal(raised.absoluteFloor, 25);
  const lowered = materialityThresholds({
    SEGMENT_CHANGE_NOTIFICATION_MIN_DELTA: '1', DAILY_DIGEST_MIN_DELTA: '3'
  });
  assert.equal(lowered.absoluteFloor, 3);
});

// ── Gate 3: novel ───────────────────────────────────────────────────────────

test('the headline hash is segment plus direction and never the count', () => {
  const monday = [{ key: 'reorder_due', direction: 'up' }];
  const tuesday = [{ key: 'reorder_due', direction: 'up' }];
  assert.equal(headlineHash(monday), headlineHash(tuesday),
    'the same claim with a different number is the same claim');
  assert.notEqual(headlineHash(monday), headlineHash([{ key: 'reorder_due', direction: 'down' }]));
  // Order must not change the hash, or a reordered list would look novel.
  const a = [{ key: 'a', direction: 'up' }, { key: 'b', direction: 'down' }];
  assert.equal(headlineHash(a), headlineHash([...a].reverse()));
});

test('a slow trend stops firing after the first day', () => {
  // 12 to 15 crosses no round number, so only the repeat rule is under test.
  const material = [{ key: 'reorder_due', direction: 'up', previousCount: 12, memberCount: 15 }];
  const first = noveltyVerdict({ material, recentHashes: [] });
  assert.equal(first.novel, true);
  const second = noveltyVerdict({ material, recentHashes: [first.hash] });
  assert.equal(second.novel, false);
  assert.equal(second.reason, 'same_claim_as_recent_day');
});

test('a reversal and a round threshold both re-open the gate', () => {
  const hash = headlineHash([{ key: 'reorder_due', direction: 'up' }]);
  assert.equal(noveltyVerdict({
    material: [{
      key: 'reorder_due', direction: 'up', previousCount: 12, memberCount: 13,
      reversedDirection: true
    }],
    recentHashes: [hash]
  }).reason, 'direction_reversed');

  assert.equal(noveltyVerdict({
    material: [{ key: 'reorder_due', direction: 'up', previousCount: 8, memberCount: 11 }],
    recentHashes: [hash]
  }).reason, 'crossed_round_threshold');
});

test('crossing a round number is detected in both directions and not re-detected', () => {
  assert.equal(crossedRoundThreshold(8, 11), true);
  assert.equal(crossedRoundThreshold(11, 8), true);
  assert.equal(crossedRoundThreshold(11, 14), false);
  assert.equal(crossedRoundThreshold(48, 52), true);
});

test('directions are named from the movement, not from the net', () => {
  assert.equal(directionOf(3, 0), 'up');
  assert.equal(directionOf(0, 3), 'down');
  assert.equal(directionOf(3, 3), 'mixed');
  assert.equal(directionOf(0, 0), 'flat');
});

// ── Gate 4: attributable ────────────────────────────────────────────────────

test('too many segments to name is suppressed rather than made vague', () => {
  const many = Array.from({ length: MAX_NAMED_SEGMENTS + 1 }, (_, index) => segment({
    key: `k${index}`, name: `Segment ${index}`,
    previousCount: 10, memberCount: 20, joinedCount: 10
  }));
  // Padded with quiet segments so the circuit breaker does not fire first.
  const quiet = Array.from({ length: 8 }, (_, index) => segment({ key: `q${index}` }));
  const result = digest({ segments: [...many, ...quiet] });
  assert.equal(result.send, false);
  assert.equal(result.reason, 'too_diffuse');
});

test('the body names every segment it reports, with no and-others branch', () => {
  const result = digest({
    segments: [
      segment({ key: 'a', name: 'Due to reorder, best timing', previousCount: 9, memberCount: 20, joinedCount: 11 }),
      segment({ key: 'b', name: 'Good customers who have stopped', previousCount: 30, memberCount: 20, leftCount: 10 }),
      ...Array.from({ length: 8 }, (_, i) => segment({ key: `q${i}` }))
    ]
  });
  assert.equal(result.send, true);
  assert.match(result.body, /Due to reorder, best timing/);
  assert.match(result.body, /Good customers who have stopped/);
  assert.equal(/other/.test(result.body), false, 'no vague remainder is ever printed');
});

// ── Silence ─────────────────────────────────────────────────────────────────

test('a quiet day sends nothing at all, not an all-quiet push', () => {
  const result = digest({ segments: [segment(), segment({ key: 'reorder_due' })] });
  assert.equal(result.send, false);
  assert.equal(result.reason, 'nothing_material');
  assert.deepEqual(result.notifications, []);
  assert.equal(result.title, null);
  assert.equal(result.body, null);
});

test('cold start is silent, so the first digest is never 487 people moving', () => {
  const result = digest({
    coldStart: true,
    segments: [segment({ previousCount: 0, memberCount: 504, joinedCount: 504, baseline: true })]
  });
  assert.equal(result.send, false);
  assert.equal(result.reason, 'cold_start');
});

test('a segment that has never been computed is a baseline, not an arrival', () => {
  const verdict = segmentMateriality(
    segment({ previousCount: 0, memberCount: 504, joinedCount: 504, baseline: true }), THRESHOLDS);
  assert.equal(verdict.material, false);
  assert.equal(verdict.reason, 'baseline');
});

test('a bulk import is suppressed and never reported as customer behaviour', () => {
  const result = digest({
    customerCount: 1400,
    previousCustomerCount: 900,
    segments: [segment({ memberCount: 900, joinedCount: 396 })]
  });
  assert.equal(result.send, false);
  assert.equal(result.reason, 'bulk_change_detected');

  // A normal day's growth is not an import.
  const normal = digest({
    customerCount: 912,
    previousCustomerCount: 900,
    segments: [segment({ memberCount: 444, leftCount: 60 })]
  });
  assert.equal(normal.send, true);
});

test('the circuit breaker suppresses a run where most segments moved', () => {
  const twelve = Array.from({ length: 12 }, (_, index) => segment({
    key: `k${index}`, name: `Segment ${index}`,
    previousCount: 50, memberCount: 100, joinedCount: 50
  }));
  const result = digest({ segments: twelve });
  assert.equal(result.send, false);
  assert.equal(result.reason, 'circuit_breaker');
  assert.equal(result.materialCount, 12);
  assert.ok(CIRCUIT_BREAKER_FRACTION === 0.5);
});

// ── What it says when it does send ──────────────────────────────────────────

test('a failed recompute is always said and never rounded down to all quiet', () => {
  const result = digest({
    segments: [segment()],
    failures: [{ key: 'winback_qualified', name: 'Good customers who have stopped', code: 'SEGMENT_RULES_INVALID' }]
  });
  assert.equal(result.send, true);
  assert.match(result.body, /could not be rechecked/);
  assert.equal(result.notifications[0].payload.failedSegmentCount, 1);
});

test('a novelty repeat is still sent when a proposal or a failure is attached', () => {
  const material = [{ key: 'one_time_buyers', direction: 'down' }];
  const hash = headlineHash(material);
  const segments = [segment({ memberCount: 444, leftCount: 60 })];

  assert.equal(digest({ segments, recentHashes: [hash] }).reason, 'not_novel');
  assert.equal(digest({ segments, recentHashes: [hash], proposalsDrafted: 2 }).send, true);
  assert.equal(digest({
    segments, recentHashes: [hash],
    failures: [{ key: 'x', name: 'X', code: 'BOOM' }]
  }).send, true);
});

test('the payload carries active, a high relevance score and no badge', () => {
  const result = digest({ segments: [segment({ memberCount: 444, leftCount: 60 })] });
  const aps = result.notifications[0].payload.aps;
  assert.equal(aps['interruption-level'], 'active',
    'a summary of yesterday must never break through Focus');
  assert.equal(aps['relevance-score'], 0.9);
  assert.equal(aps['thread-id'], 'segment-digest');
  assert.equal(aps.category, 'SEGMENT_DIGEST');
  assert.equal(aps.badge, undefined,
    'the badge means unread messages plus missed calls and a digest must not overwrite it');
});

test('the collapse id is per person per day, so two people never share a banner', () => {
  const result = digest({
    users: [OWNER, ADMIN],
    segments: [segment({ memberCount: 444, leftCount: 60 })]
  });
  assert.deepEqual(
    result.notifications.map(row => row.collapseID),
    ['digest-1-2026-08-24', 'digest-2-2026-08-24']
  );
});

test('only active Owners and Admins who can manage campaigns receive it', () => {
  const result = digest({
    users: [OWNER, ADMIN, AGENT, NO_CAMPAIGNS, { ...ADMIN, id: 9, isActive: false }],
    segments: [segment({ memberCount: 444, leftCount: 60 })]
  });
  assert.deepEqual(result.notifications.map(row => row.userID), ['1', '2']);
});

test('nobody eligible means silence rather than an orphaned preparation', () => {
  const result = digest({
    users: [AGENT], segments: [segment({ memberCount: 444, leftCount: 60 })]
  });
  assert.equal(result.send, false);
  assert.equal(result.reason, 'no_eligible_recipients');
});

// ── Copy ────────────────────────────────────────────────────────────────────

test('no digest copy contains an em dash or any customer identity', () => {
  const result = digest({
    segments: [segment({ memberCount: 444, leftCount: 60 })],
    proposalsDrafted: 2,
    failures: [{ key: 'x', name: 'X', code: 'BOOM' }]
  });
  for (const text of [result.title, result.body]) {
    assert.equal(text.includes('—'), false, `em dash in: ${text}`);
    assert.equal(text.includes('–'), false, `en dash in: ${text}`);
    // A phone number or an email address in a notification body is an App
    // Review 4.5.4 problem as well as a privacy one, and the recipient could be
    // anywhere when it lands.
    assert.equal(/\+?\d[\d\s().-]{7,}/.test(text), false, `phone-shaped run in: ${text}`);
    assert.equal(/@/.test(text), false, `address-shaped text in: ${text}`);
  }
});

test('an em dash smuggled into a segment name is refused rather than delivered', () => {
  assert.throws(
    () => digest({
      segments: [segment({ name: 'Bought once — never came back', memberCount: 444, leftCount: 60 })]
    }),
    /must not contain an em dash/
  );
});

test('an invalid clock throws rather than being silently coerced', () => {
  assert.throws(() => prepareDailyDigest({ generatedAt: 'nope' }), /valid date/);
});
