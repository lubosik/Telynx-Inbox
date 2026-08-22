'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const DISQUALIFYING_STATUSES = new Set(['cancelled', 'failed', 'refunded', 'trash']);

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function qualifyingPurchaseTimes(purchases) {
  const unique = new Set();
  for (const purchase of purchases || []) {
    const value = typeof purchase === 'string' || purchase instanceof Date
      ? purchase
      : purchase?.paidAt || purchase?.datePaid || purchase?.date_paid_gmt || purchase?.createdAt;
    const status = String(purchase?.status || '').toLowerCase();
    const refunded = Number(purchase?.refundedAmount ?? purchase?.refunded_amount ?? 0);
    const total = Number(purchase?.total ?? purchase?.amount ?? 0);
    const time = value instanceof Date ? value.getTime() : Date.parse(value);
    if (!Number.isFinite(time) || DISQUALIFYING_STATUSES.has(status)) continue;
    if (refunded > 0 && (total <= 0 || refunded >= total)) continue;
    unique.add(time);
  }
  return [...unique].sort((a, b) => a - b);
}

function intervalDays(times, { minimumDays = 3, maximumDays = 365 } = {}) {
  const intervals = [];
  for (let index = 1; index < times.length; index += 1) {
    const days = (times[index] - times[index - 1]) / DAY_MS;
    if (days >= minimumDays && days <= maximumDays) intervals.push(days);
  }
  return intervals;
}

function cadenceFromIntervals(intervals, {
  minimumIntervals = 3,
  maximumRelativeMAD = 0.4,
  highConfidenceRelativeMAD = 0.25
} = {}) {
  const observed = (intervals || []).map(Number).filter(value => Number.isFinite(value) && value > 0);
  if (observed.length < minimumIntervals) {
    return { reliable: false, confidence: 'none', reason: 'insufficient_intervals', intervalCount: observed.length };
  }
  const medianDays = median(observed);
  const madDays = median(observed.map(value => Math.abs(value - medianDays)));
  const relativeMAD = medianDays > 0 ? madDays / medianDays : Number.POSITIVE_INFINITY;
  const outlierCount = observed.filter(value => value < medianDays * 0.5 || value > medianDays * 1.75).length;
  const outlierFraction = outlierCount / observed.length;
  if (!Number.isFinite(relativeMAD) || relativeMAD > maximumRelativeMAD || outlierFraction > 0.25) {
    return {
      reliable: false,
      confidence: 'none',
      reason: 'cadence_too_variable',
      intervalCount: observed.length,
      medianDays,
      madDays,
      relativeMAD,
      outlierCount,
      outlierFraction
    };
  }
  return {
    reliable: true,
    confidence: relativeMAD <= highConfidenceRelativeMAD && outlierCount === 0 ? 'high' : 'moderate',
    reason: 'cadence_supported',
    intervalCount: observed.length,
    medianDays,
    madDays,
    relativeMAD,
    outlierCount,
    outlierFraction
  };
}

function calculateReorderCadence({
  purchases = [],
  productCadence = null,
  now = new Date(),
  productAvailable = true,
  alreadyContactedForLastPurchase = false,
  personalPolicy = {},
  productPolicy = {}
} = {}) {
  const times = qualifyingPurchaseTimes(purchases);
  const intervals = intervalDays(times, personalPolicy);
  let cadence = cadenceFromIntervals(intervals, { minimumIntervals: 3, ...personalPolicy });
  let source = 'personal';

  if (!cadence.reliable) {
    if (cadence.reason === 'cadence_too_variable') {
      return {
        eligible: false,
        state: 'no_reliable_cadence',
        source: 'none',
        reason: 'cadence_too_variable',
        purchaseCount: times.length,
        intervalCount: intervals.length
      };
    }
    const aggregateIntervals = Array.isArray(productCadence) ? productCadence : productCadence?.intervals || [];
    const uniqueCustomers = Number(productCadence?.uniqueCustomers || 0);
    const aggregate = cadenceFromIntervals(aggregateIntervals, { minimumIntervals: 20, ...productPolicy });
    if (aggregate.reliable && uniqueCustomers >= Number(productPolicy.minimumCustomers || 10)) {
      cadence = aggregate;
      source = 'product';
    } else {
      return {
        eligible: false,
        state: 'no_reliable_cadence',
        source: 'none',
        reason: 'insufficient_personal_and_product_evidence',
        purchaseCount: times.length,
        intervalCount: intervals.length
      };
    }
  }

  if (times.length === 0) {
    return { eligible: false, state: 'no_purchase', source: 'none', reason: 'purchase_history_missing' };
  }
  if (!productAvailable) {
    return { eligible: false, state: 'suppressed', source, reason: 'product_unavailable', cadence };
  }
  if (alreadyContactedForLastPurchase) {
    return { eligible: false, state: 'contacted', source, reason: 'opportunity_already_contacted', cadence };
  }

  const nowTime = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowTime)) throw new Error('now must be a valid date.');
  const lastPurchaseTime = times.at(-1);
  const uncertaintyDays = Math.max(3, Math.ceil((cadence.madDays || 0) * 1.4826));
  const expectedTime = lastPurchaseTime + cadence.medianDays * DAY_MS;
  const lowerTime = expectedTime - uncertaintyDays * DAY_MS;
  const upperTime = expectedTime + uncertaintyDays * DAY_MS;
  const state = nowTime < lowerTime ? 'not_due' : nowTime < expectedTime ? 'approaching' : nowTime <= upperTime ? 'due' : 'overdue';

  return {
    eligible: state === 'due' || state === 'overdue',
    state,
    source,
    reason: state === 'due' || state === 'overdue' ? 'reorder_window_reached' : 'reorder_window_not_reached',
    purchaseCount: times.length,
    cadence,
    lastPurchaseAt: new Date(lastPurchaseTime).toISOString(),
    expectedAt: new Date(expectedTime).toISOString(),
    expectedRange: {
      start: new Date(lowerTime).toISOString(),
      end: new Date(upperTime).toISOString()
    },
    cycleKey: `${new Date(lastPurchaseTime).toISOString()}:${Math.round(cadence.medianDays * 100)}`
  };
}

module.exports = {
  DAY_MS,
  cadenceFromIntervals,
  calculateReorderCadence,
  intervalDays,
  median,
  qualifyingPurchaseTimes
};
