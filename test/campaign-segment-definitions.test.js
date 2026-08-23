'use strict';
/**
 * The automatic segment catalogue.
 *
 * The point of these tests is that a segment is a VIEW onto the existing
 * deterministic engine and never a second opinion. So the expected membership
 * is derived by calling lib/campaigns/reorder-cadence.js and
 * lib/campaigns/winback.js directly, and asserted to match what the segment
 * produced. If somebody reimplements the arithmetic inside a definition, these
 * fail.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { calculateReorderCadence } = require('../lib/campaigns/reorder-cadence');
const { qualifyWinback } = require('../lib/campaigns/winback');
const {
  SEGMENT_DEFINITION_KEYS,
  SEGMENT_RULE_VERSION,
  computeSegmentMembers,
  segmentCatalogue,
  segmentDefinition
} = require('../lib/campaigns/segment-definitions');

const DAY = 86400000;
const NOW = new Date('2026-08-23T12:00:00.000Z');

/** Orders every `intervalDays` days, the most recent `sinceDays` ago. */
function purchases(count, intervalDays, sinceDays, jitter = []) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const back = sinceDays + (count - 1 - index) * intervalDays + (jitter[index] || 0);
    rows.push({ status: 'completed', total: 100, createdAt: new Date(NOW.getTime() - back * DAY).toISOString() });
  }
  return rows;
}

function reorderCandidate(phone, options = {}) {
  return {
    phone,
    contactID: 11,
    productID: 900,
    variationID: 0,
    productName: 'Test peptide',
    productAvailable: true,
    alreadyContactedForLastPurchase: false,
    productCadence: { intervals: [], uniqueCustomers: 0 },
    ...options
  };
}

test('the catalogue is a closed, stable set of keys', () => {
  assert.deepEqual(SEGMENT_DEFINITION_KEYS, [
    'reorder_approaching', 'reorder_due', 'reorder_due_high_confidence', 'winback_qualified'
  ]);
  for (const entry of segmentCatalogue()) {
    assert.equal(entry.ruleVersion, SEGMENT_RULE_VERSION);
    assert.ok(entry.name && entry.description && entry.detector);
    // A segment key is stored on live rows. Renaming one orphans a segment, so
    // the key and the catalogue entry must always agree.
    assert.equal(segmentDefinition(entry.key).key, entry.key);
  }
  assert.equal(segmentDefinition('does_not_exist'), null);
  assert.throws(() => computeSegmentMembers('does_not_exist', {}), /Unknown segment definition/);
});

test('reorder_due_high_confidence agrees exactly with calculateReorderCadence', () => {
  // Rock steady 30 day cadence, last order 32 days ago: due, high confidence.
  const steady = reorderCandidate('+15550000001', { purchases: purchases(5, 30, 32) });
  // Same cadence but only 5 days since the last order: not due.
  const early = reorderCandidate('+15550000002', { purchases: purchases(5, 30, 5) });
  // Wobbly history: no reliable cadence at all.
  const wobbly = reorderCandidate('+15550000003', { purchases: purchases(5, 30, 32, [0, 40, -20, 55, 0]) });
  // Only two intervals: insufficient personal evidence, and no product fallback.
  const sparse = reorderCandidate('+15550000004', { purchases: purchases(3, 30, 32) });

  const input = { reorderCandidates: [steady, early, wobbly, sparse] };
  const members = computeSegmentMembers('reorder_due_high_confidence', input, { now: NOW });

  const expected = input.reorderCandidates.filter(candidate => {
    const result = calculateReorderCadence({
      purchases: candidate.purchases,
      productCadence: candidate.productCadence,
      now: NOW,
      productAvailable: true
    });
    return result.eligible === true && result.cadence?.confidence === 'high';
  }).map(candidate => candidate.phone);

  assert.deepEqual(members.map(row => row.contactPhone), expected);
  assert.deepEqual(expected, ['+15550000001'], 'the fixture must actually exercise the filter');
});

test('a member row carries the facts that put them there', () => {
  const candidate = reorderCandidate('+15550000001', { purchases: purchases(5, 30, 32) });
  const [member] = computeSegmentMembers(
    'reorder_due_high_confidence', { reorderCandidates: [candidate] }, { now: NOW }
  );

  // The brief names these four explicitly: an operator taps a person and must
  // see why the engine chose them.
  assert.equal(member.inclusionEvidence.medianIntervalDays, 30);
  assert.equal(member.inclusionEvidence.intervalsObserved, 4);
  assert.equal(member.inclusionEvidence.confidence, 'high');
  assert.equal(
    member.inclusionEvidence.lastOrderAt,
    new Date(NOW.getTime() - 32 * DAY).toISOString()
  );

  assert.equal(member.inclusionEvidence.detector, 'reorder');
  assert.equal(member.inclusionEvidence.cadenceSource, 'personal');
  // 32 days on a 30 day median with zero MAD: inside the three day minimum
  // uncertainty band, so 'due' rather than 'overdue'.
  assert.equal(member.inclusionEvidence.state, 'due');
  assert.equal(member.inclusionEvidence.ruleVersion, SEGMENT_RULE_VERSION);
  assert.equal(member.inclusionEvidence.segmentKey, 'reorder_due_high_confidence');
  assert.equal(member.inclusionEvidence.productID, 900);
  assert.ok(member.inclusionEvidence.expectedRange.start);
  assert.ok(member.inclusionEvidence.cycleKey, 'the cycle key is what stops a daily re-detection');
});

test('reorder_due is a superset of the high-confidence segment', () => {
  const steady = reorderCandidate('+15550000001', { purchases: purchases(6, 30, 32) });
  // Mild variability: reliable but only moderate confidence.
  const moderate = reorderCandidate('+15550000005', { purchases: purchases(6, 30, 34, [0, 7, -6, 7, -7, 0]) });
  const input = { reorderCandidates: [steady, moderate] };

  const due = computeSegmentMembers('reorder_due', input, { now: NOW }).map(row => row.contactPhone);
  const high = computeSegmentMembers('reorder_due_high_confidence', input, { now: NOW })
    .map(row => row.contactPhone);

  for (const phone of high) assert.ok(due.includes(phone), `${phone} is high confidence but not due`);
  assert.ok(due.length >= high.length);
  assert.ok(due.includes('+15550000001'));
});

test('reorder_approaching holds people who are not yet due', () => {
  // 30 day cadence, 27 days elapsed: inside the lower band but before expected.
  const approaching = reorderCandidate('+15550000006', { purchases: purchases(6, 30, 28) });
  const members = computeSegmentMembers(
    'reorder_approaching', { reorderCandidates: [approaching] }, { now: NOW }
  );
  assert.deepEqual(members.map(row => row.contactPhone), ['+15550000006']);
  assert.equal(members[0].inclusionEvidence.state, 'approaching');

  // And they are deliberately NOT in the due segment.
  const due = computeSegmentMembers('reorder_due', { reorderCandidates: [approaching] }, { now: NOW });
  assert.deepEqual(due, []);
});

test('winback_qualified agrees exactly with qualifyWinback', () => {
  const lapsed = {
    phone: '+15550000010',
    contactID: 3,
    productID: 900,
    variationID: 0,
    productAvailable: true,
    cadence: { reliable: true, confidence: 'high', medianDays: 30, intervalCount: 5 },
    lastPurchaseAt: new Date(NOW.getTime() - 200 * DAY).toISOString(),
    lifetimePurchaseCount: 6,
    lastWinbackContactAt: null
  };
  const recentlyContacted = { ...lapsed, phone: '+15550000011', lastWinbackContactAt: new Date(NOW.getTime() - 10 * DAY).toISOString() };
  const notLapsed = { ...lapsed, phone: '+15550000012', lastPurchaseAt: new Date(NOW.getTime() - 20 * DAY).toISOString() };
  const tooFewOrders = { ...lapsed, phone: '+15550000013', lifetimePurchaseCount: 1 };

  const input = { winbackCandidates: [lapsed, recentlyContacted, notLapsed, tooFewOrders] };
  const members = computeSegmentMembers('winback_qualified', input, { now: NOW });

  const expected = input.winbackCandidates.filter(candidate => qualifyWinback({
    cadence: candidate.cadence,
    lastPurchaseAt: candidate.lastPurchaseAt,
    lifetimePurchaseCount: candidate.lifetimePurchaseCount,
    now: NOW,
    lastWinbackContactAt: candidate.lastWinbackContactAt,
    productAvailable: true
  }).qualifies).map(candidate => candidate.phone);

  assert.deepEqual(members.map(row => row.contactPhone), expected);
  assert.deepEqual(expected, ['+15550000010'], 'the fixture must actually exercise every rejection path');

  const evidence = members[0].inclusionEvidence;
  assert.equal(evidence.detector, 'winback');
  assert.equal(evidence.medianIntervalDays, 30);
  assert.equal(evidence.lifetimePurchaseCount, 6);
  assert.equal(evidence.daysSinceLastOrder, 200);
  assert.ok(evidence.eligibleAt);
});

test('one person owning several products becomes one member, with the extras counted', () => {
  const base = { purchases: purchases(5, 30, 32) };
  const input = {
    reorderCandidates: [
      reorderCandidate('+15550000001', { ...base, productID: 900 }),
      reorderCandidate('+15550000001', { ...base, productID: 901 }),
      reorderCandidate('+15550000002', { ...base, productID: 900 })
    ]
  };
  const members = computeSegmentMembers('reorder_due_high_confidence', input, { now: NOW });
  assert.deepEqual(members.map(row => row.contactPhone), ['+15550000001', '+15550000002']);
  assert.equal(members[0].inclusionEvidence.additionalMatches, 1);
  assert.equal(members[1].inclusionEvidence.additionalMatches, 0);
  // Deterministic: the retained evidence is the lowest product id, not whichever
  // row the database happened to return first.
  assert.equal(members[0].inclusionEvidence.productID, 900);
});

test('the same input at the same instant always produces the same output', () => {
  const input = {
    reorderCandidates: [
      reorderCandidate('+15550000002', { purchases: purchases(5, 30, 32) }),
      reorderCandidate('+15550000001', { purchases: purchases(5, 30, 32) })
    ]
  };
  const first = computeSegmentMembers('reorder_due', input, { now: NOW });
  const second = computeSegmentMembers('reorder_due', input, { now: NOW });
  assert.deepEqual(first, second);
  assert.deepEqual(first.map(row => row.contactPhone), ['+15550000001', '+15550000002']);
});

test('an unavailable product or an already contacted cycle removes the person', () => {
  const base = reorderCandidate('+15550000001', { purchases: purchases(5, 30, 32) });
  assert.equal(
    computeSegmentMembers('reorder_due', { reorderCandidates: [base] }, { now: NOW }).length, 1
  );
  assert.equal(
    computeSegmentMembers('reorder_due', {
      reorderCandidates: [{ ...base, productAvailable: false }]
    }, { now: NOW }).length, 0
  );
  assert.equal(
    computeSegmentMembers('reorder_due', {
      reorderCandidates: [{ ...base, alreadyContactedForLastPurchase: true }]
    }, { now: NOW }).length, 0
  );
});

test('an invalid now is refused rather than producing a segment of everybody', () => {
  assert.throws(
    () => computeSegmentMembers('reorder_due', { reorderCandidates: [] }, { now: 'not a date' }),
    /now must be a valid date/
  );
});
