'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cadenceFromIntervals,
  calculateReorderCadence,
  median,
  qualifyingPurchaseTimes
} = require('../lib/campaigns/reorder-cadence');
const { qualifyWinback } = require('../lib/campaigns/winback');

test('median cadence is resistant to an outlying interval', () => {
  assert.equal(median([29, 30, 31, 120]), 30.5);
  const cadence = cadenceFromIntervals([29, 30, 31, 120]);
  assert.equal(cadence.reliable, true);
  assert.equal(cadence.medianDays, 30.5);
  assert.equal(cadence.confidence, 'moderate');
  assert.equal(cadence.outlierCount, 1);
});

test('refunded, cancelled and duplicate purchase events do not create cadence evidence', () => {
  const times = qualifyingPurchaseTimes([
    { paidAt: '2026-01-01T00:00:00Z', status: 'completed', total: 100 },
    { paidAt: '2026-01-01T00:00:00Z', status: 'completed', total: 100 },
    { paidAt: '2026-02-01T00:00:00Z', status: 'refunded', total: 100 },
    { paidAt: '2026-03-01T00:00:00Z', status: 'completed', total: 100, refundedAmount: 100 },
    { paidAt: '2026-04-01T00:00:00Z', status: 'cancelled', total: 100 }
  ]);
  assert.equal(times.length, 1);
});

test('consistent personal purchase history creates a due reorder candidate', () => {
  const result = calculateReorderCadence({
    purchases: [
      '2026-04-01T00:00:00Z',
      '2026-05-01T00:00:00Z',
      '2026-05-31T00:00:00Z',
      '2026-06-30T00:00:00Z'
    ],
    now: '2026-07-30T00:00:00Z'
  });
  assert.equal(result.eligible, true);
  assert.equal(result.source, 'personal');
  assert.equal(result.cadence.confidence, 'high');
  assert.equal(result.state, 'due');
});

test('sparse or highly variable history does not pretend to know a personal cadence', () => {
  const sparse = calculateReorderCadence({
    purchases: ['2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'],
    now: '2026-04-01T00:00:00Z'
  });
  assert.equal(sparse.eligible, false);
  assert.equal(sparse.state, 'no_reliable_cadence');

  const variable = calculateReorderCadence({
    purchases: [
      '2026-01-01T00:00:00Z',
      '2026-01-06T00:00:00Z',
      '2026-04-06T00:00:00Z',
      '2026-04-16T00:00:00Z'
    ],
    now: '2026-08-01T00:00:00Z'
  });
  assert.equal(variable.eligible, false);
  assert.equal(variable.reason, 'cadence_too_variable');
});

test('variable personal history is negative evidence and cannot be overwritten by aggregate product cadence', () => {
  const result = calculateReorderCadence({
    purchases: [
      '2026-01-01T00:00:00Z',
      '2026-01-06T00:00:00Z',
      '2026-04-06T00:00:00Z',
      '2026-04-16T00:00:00Z'
    ],
    productCadence: {
      intervals: Array.from({ length: 20 }, (_, index) => 29 + (index % 3)),
      uniqueCustomers: 12
    },
    now: '2026-08-01T00:00:00Z'
  });
  assert.equal(result.source, 'none');
  assert.equal(result.reason, 'cadence_too_variable');
});

test('product cadence is used only with enough aggregate intervals and customers', () => {
  const productIntervals = Array.from({ length: 20 }, (_, index) => 29 + (index % 3));
  const result = calculateReorderCadence({
    purchases: ['2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z'],
    productCadence: { intervals: productIntervals, uniqueCustomers: 12 },
    now: '2026-08-01T00:00:00Z'
  });
  assert.equal(result.source, 'product');
  assert.equal(result.eligible, true);

  const weak = calculateReorderCadence({
    purchases: ['2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z'],
    productCadence: { intervals: productIntervals, uniqueCustomers: 3 },
    now: '2026-08-01T00:00:00Z'
  });
  assert.equal(weak.source, 'none');
  assert.equal(weak.eligible, false);
});

test('a product becoming unavailable or a contacted cycle suppresses reorder', () => {
  const purchases = ['2026-04-01T00:00:00Z', '2026-05-01T00:00:00Z', '2026-05-31T00:00:00Z', '2026-06-30T00:00:00Z'];
  assert.equal(calculateReorderCadence({ purchases, now: '2026-08-01', productAvailable: false }).reason, 'product_unavailable');
  assert.equal(calculateReorderCadence({ purchases, now: '2026-08-01', alreadyContactedForLastPurchase: true }).reason, 'opportunity_already_contacted');
});

test('win-back requires repeat history and lapse relative to a reliable cadence', () => {
  const result = qualifyWinback({
    cadence: { reliable: true, medianDays: 30 },
    lastPurchaseAt: '2026-04-01T00:00:00Z',
    lifetimePurchaseCount: 5,
    now: '2026-08-22T00:00:00Z'
  });
  assert.equal(result.qualifies, true);

  const tooSoon = qualifyWinback({
    cadence: { reliable: true, medianDays: 30 },
    lastPurchaseAt: '2026-07-20T00:00:00Z',
    lifetimePurchaseCount: 5,
    now: '2026-08-22T00:00:00Z'
  });
  assert.equal(tooSoon.qualifies, false);
  assert.ok(tooSoon.reasons.includes('not_lapsed_beyond_cadence'));
});

test('win-back cooldown and customer-experience state block repeated promotion', () => {
  const result = qualifyWinback({
    cadence: { reliable: true, medianDays: 30 },
    lastPurchaseAt: '2026-01-01T00:00:00Z',
    lifetimePurchaseCount: 5,
    lastWinbackContactAt: '2026-08-01T00:00:00Z',
    unresolvedComplaint: true,
    now: '2026-08-22T00:00:00Z'
  });
  assert.equal(result.qualifies, false);
  assert.ok(result.reasons.includes('winback_cooldown_active'));
  assert.ok(result.reasons.includes('customer_experience_block'));
});

test('invalid cadence cannot qualify a win-back even after a long lapse', () => {
  const result = qualifyWinback({
    cadence: { reliable: true, medianDays: 0 },
    lastPurchaseAt: '2025-01-01T00:00:00Z',
    lifetimePurchaseCount: 10,
    now: '2026-08-22T00:00:00Z'
  });
  assert.equal(result.qualifies, false);
  assert.ok(result.reasons.includes('reliable_cadence_required'));
});

// ── The floor under the consistency test ────────────────────────────────────
//
// These pin the reason the personal minimum is two intervals and not one. The
// old default was three, which meant a customer needed four orders before
// anything looked at their rhythm at all: on the live database that was 42 of
// 788 buyers, with the other 746 never examined rather than examined and found
// wanting.
//
// Lowering it to two is safe. Lowering it to one is not, and the difference is
// arithmetic rather than taste, so it is enforced rather than documented.

test('one interval cannot be a cadence, whatever the caller asks for', () => {
  // The median of a single value is that value, so the deviation is 0, so the
  // MAD is 0, so relativeMAD is 0 for EVERY input. Nothing can fail this test,
  // which is exactly why it must not be allowed to run.
  for (const gap of [3, 7, 30, 120, 364]) {
    const cadence = cadenceFromIntervals([gap], { minimumIntervals: 1 });
    assert.equal(cadence.reliable, false,
      `a single ${gap} day gap is one observation, not a rhythm`);
    assert.equal(cadence.reason, 'insufficient_intervals');
    assert.equal(cadence.confidence, 'none');
  }
});

test('the one-interval floor cannot be argued down by policy', () => {
  // personalPolicy is spread over the defaults, so without a clamp any caller
  // could reintroduce the vacuous case. 0 and negatives are covered because
  // "fewer than one" is the same mistake with a worse number.
  for (const minimumIntervals of [1, 0, -5, 0.5, NaN, null]) {
    const cadence = cadenceFromIntervals([30], { minimumIntervals });
    assert.equal(cadence.reliable, false,
      `minimumIntervals=${minimumIntervals} must not admit a single interval`);
  }
});

test('two intervals are enough to judge, and the judgement can still fail', () => {
  // The whole justification for lowering the floor: at two intervals the test
  // discriminates. If these three collapsed to the same verdict, two intervals
  // would be as vacuous as one and the floor would belong at three.
  assert.equal(cadenceFromIntervals([30, 32]).reliable, true, 'consistent gaps are a cadence');
  assert.equal(cadenceFromIntervals([30, 60]).reliable, true, 'a wider but bounded spread survives');
  assert.equal(cadenceFromIntervals([30, 120]).reliable, false, 'a fourfold disagreement is not a rhythm');
  assert.equal(cadenceFromIntervals([30, 120]).reason, 'cadence_too_variable');
});

test('high confidence still needs three intervals, so its meaning has not moved', () => {
  // Two tight gaps are worth acting on, but they are two observations. Anything
  // downstream that treats `high` as a stronger claim keeps the bar it had
  // before the floor was lowered.
  const two = cadenceFromIntervals([30, 31]);
  assert.equal(two.reliable, true);
  assert.equal(two.confidence, 'moderate', 'two observations cannot be high confidence');

  const three = cadenceFromIntervals([30, 31, 30]);
  assert.equal(three.confidence, 'high', 'three tight intervals still reach high');
});

test('three orders now produce a personal cadence, where four were needed before', () => {
  const day = 24 * 60 * 60 * 1000;
  const start = Date.parse('2026-01-01T00:00:00Z');
  const purchases = [0, 30, 60].map(offset => ({
    status: 'completed', total: 100, paidAt: new Date(start + offset * day).toISOString()
  }));
  const result = calculateReorderCadence({
    purchases, now: new Date(start + 95 * day), productAvailable: true
  });
  assert.equal(result.state !== 'no_reliable_cadence', true,
    'three orders with a steady gap must now be readable');
  assert.equal(result.source, 'personal');
});

test('two orders still produce nothing, and say why', () => {
  const day = 24 * 60 * 60 * 1000;
  const start = Date.parse('2026-01-01T00:00:00Z');
  const purchases = [0, 30].map(offset => ({
    status: 'completed', total: 100, paidAt: new Date(start + offset * day).toISOString()
  }));
  const result = calculateReorderCadence({
    purchases, now: new Date(start + 65 * day), productAvailable: true
  });
  assert.equal(result.eligible, false);
  assert.equal(result.state, 'no_reliable_cadence');
  assert.equal(result.intervalCount, 1);
});
