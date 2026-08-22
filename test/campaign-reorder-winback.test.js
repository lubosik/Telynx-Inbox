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
