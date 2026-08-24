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

/**
 * The fewest intervals at which the consistency test below means anything.
 *
 * At ONE interval it is arithmetically vacuous, not merely weak. The median of
 * a single value is that value, so the deviation from it is 0, so the MAD is 0,
 * so relativeMAD is 0 for every possible input. It clears
 * `highConfidenceRelativeMAD` unconditionally and there are no outliers to
 * count. Every two-order customer therefore comes back `reliable: true,
 * confidence: 'high'` — including somebody whose two orders were three days
 * apart, who would be described as a high-confidence three-day buyer.
 *
 * Measured on the live database: at one interval, 218 of 269 people qualify and
 * 201 of them are labelled high confidence, all on evidence that cannot fail.
 * That is not coverage, it is a confidence generator, and it would put a
 * fabricated purchase rhythm behind messages sent to real customers.
 *
 * Two intervals can disagree, so the test does work: [30, 60] is downgraded and
 * [30, 120] is rejected. That is the floor, and it is not configurable.
 */
const ABSOLUTE_MINIMUM_INTERVALS = 2;

/**
 * How many intervals are needed before `high` is available at all.
 *
 * Two consistent gaps are real evidence and are worth acting on, but they are
 * two observations. Reserving the top label for three keeps `high` meaning what
 * it meant before this floor was lowered, so nothing downstream that trusts it
 * has quietly had its bar moved.
 */
const HIGH_CONFIDENCE_MINIMUM_INTERVALS = 3;

function cadenceFromIntervals(intervals, {
  minimumIntervals = ABSOLUTE_MINIMUM_INTERVALS,
  maximumRelativeMAD = 0.4,
  highConfidenceRelativeMAD = 0.25
} = {}) {
  // A caller asking for 1, or for nonsense, gets the floor. Callers asking for
  // more (the product-level aggregate asks for 20) are left alone.
  const requiredIntervals = Number.isFinite(minimumIntervals)
    ? Math.max(ABSOLUTE_MINIMUM_INTERVALS, Math.trunc(minimumIntervals))
    : ABSOLUTE_MINIMUM_INTERVALS;
  const observed = (intervals || []).map(Number).filter(value => Number.isFinite(value) && value > 0);
  if (observed.length < requiredIntervals) {
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
  const tightEnoughForHigh = relativeMAD <= highConfidenceRelativeMAD && outlierCount === 0;
  return {
    reliable: true,
    confidence: tightEnoughForHigh && observed.length >= HIGH_CONFIDENCE_MINIMUM_INTERVALS
      ? 'high'
      : 'moderate',
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
  // Two intervals, so three orders. At three intervals (four orders) this saw
  // 42 of 788 buyers and called 17 of them reliable; the other 746 were not
  // judged unreliable, they were never looked at. Two intervals reaches 110 and
  // calls 59 reliable, on a test that can still fail. One interval is refused
  // by ABSOLUTE_MINIMUM_INTERVALS above, whatever a caller passes.
  let cadence = cadenceFromIntervals(intervals, {
    minimumIntervals: ABSOLUTE_MINIMUM_INTERVALS,
    ...personalPolicy
  });
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
  ABSOLUTE_MINIMUM_INTERVALS,
  DAY_MS,
  HIGH_CONFIDENCE_MINIMUM_INTERVALS,
  cadenceFromIntervals,
  calculateReorderCadence,
  intervalDays,
  median,
  qualifyingPurchaseTimes
};
