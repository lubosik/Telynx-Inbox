'use strict';
/**
 * lib/campaigns/second-order.js — the people who came back once and then
 * stopped, who until now belonged to nothing.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BLIND SPOT THIS FILLS
 *
 *   Measured live: 538 buyers have one order, 161 have exactly two, 123 have
 *   three or more.
 *
 *   The 538 are covered by the one-time cohorts. The 123 are covered by
 *   reorder and win-back, both of which need a RELIABLE CADENCE, and
 *   reorder-cadence.js needs two intervals for that, which means three orders.
 *
 *   The 161 in the middle were in no cohort at all. They are worth $61,553
 *   lifetime, a median of $324.78 each, and they are the most valuable group
 *   in the customer base per person after the regulars.
 *
 *   They are also exactly who the win-back is designed to CREATE. A one-time
 *   buyer who takes the 15% and orders again becomes a two-order buyer, which
 *   until now meant falling straight out of every segment that could reach
 *   them. The recovery campaign fed a blind spot.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS DOES NOT USE calculateReorderCadence
 *
 *   It cannot, and the refusal is correct. Two orders give ONE interval, and
 *   reorder-cadence.js explains at length why one interval is not weak
 *   evidence but vacuous evidence: the median of a single value is that value,
 *   so the deviation is 0, so the consistency test passes unconditionally and
 *   every two-order customer comes back "high confidence" on evidence that
 *   cannot fail.
 *
 *   So this file does not claim a rhythm. It uses the one gap as a PRIOR, not
 *   as a cadence, and says so in its evidence. The distinction matters because
 *   the reorder flow tells a customer the business knows their pattern, and
 *   this one must never do that on a single observation.
 *
 * THE TIMING, AND THE FALLBACK
 *
 *   Each person's own gap between order one and order two is one real fact
 *   about them. Weak, but theirs. So the nudge fires when they pass it.
 *
 *   When that gap is not usable, the fallback is 34 days: the measured median
 *   across all 284 repeat buyers in this database, with a 25th percentile of
 *   16 days and a 75th of 64. A gap outside those bounds is treated as noise
 *   rather than signal, because a customer whose two orders were three days
 *   apart was buying twice in one week, not establishing a fortnightly habit.
 *
 * IT CARRIES NO DISCOUNT, DELIBERATELY
 *
 *   These people came back once already without being paid to. Offering a code
 *   here spends margin on the group least likely to need it and teaches the
 *   best-converting customers in the business that waiting is cheaper. The
 *   win-back discounts because those customers have demonstrably stopped; this
 *   one does not, because these have demonstrably not.
 */

const { normalisePhone } = require('../phone');

/** Orders that never became money and must not count toward a rhythm. */
const DISQUALIFYING_STATUSES = new Set(['cancelled', 'failed', 'refunded', 'trash', 'pending']);

/**
 * Measured on the live database, 2026-08-29, across 284 repeat buyers.
 *
 * Re-derive these rather than adjust them by feel; they are observations, and
 * the whole point of the fallback is that it is this shop's real behaviour and
 * not a number somebody liked.
 */
const OBSERVED = Object.freeze({
  measuredOn: '2026-08-29',
  repeatBuyersMeasured: 284,
  /** Median days between order one and order two. */
  medianFirstToSecondDays: 34,
  /** A gap below this is two orders in one burst, not a rhythm. */
  plausibleMinimumDays: 16,
  /** A gap above this says little about when a third order is due. */
  plausibleMaximumDays: 64
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The copy.
 *
 * No offer, no claim about the customer's consumption, and no suggestion that
 * anybody has been watching them. It offers help and gets out of the way,
 * which is the only honest register for a message whose entire evidence base
 * is "you bought this twice".
 *
 * Sized against the worst case: a 12-character first name beside a
 * 12-character product code.
 */
const TEMPLATE = 'It\'s Vin from Vici. Hi {{first_name}}, been a while since your '
  + '{{last_product}} order. Want more sent out? Just say the word. Reply STOP to opt out.';

const TEMPLATE_NO_PRODUCT = 'It\'s Vin from Vici. Hi {{first_name}}, been a while since your last order. '
  + 'Want more sent out? Just say the word. Reply STOP to opt out.';

/** Paid order times for one person, ascending, deduplicated. */
function paidOrderTimes(orders) {
  const times = new Set();
  for (const order of orders || []) {
    if (DISQUALIFYING_STATUSES.has(String(order?.status || '').toLowerCase())) continue;
    const time = Date.parse(order?.created_at);
    if (Number.isFinite(time)) times.add(time);
  }
  return [...times].sort((a, b) => a - b);
}

/**
 * How long to wait after somebody's second order, and on what basis.
 *
 * Returns the basis alongside the number, because a segment that cannot say
 * WHY somebody is in it is a segment nobody can review. `personal_gap` means
 * their own observed interval; `observed_median` means the fallback.
 */
function expectedGapDays(times, observed = OBSERVED) {
  if (times.length < 2) return null;
  const gap = (times[1] - times[0]) / DAY_MS;
  if (gap >= observed.plausibleMinimumDays && gap <= observed.plausibleMaximumDays) {
    return { days: gap, basis: 'personal_gap' };
  }
  // Outside the plausible band their own gap says little, so fall back to what
  // this shop's repeat buyers actually do.
  return { days: observed.medianFirstToSecondDays, basis: 'observed_median' };
}

/**
 * Whether one person is due a third-order nudge, and the evidence for it.
 *
 * Pure. Everything it needs is the order list and the clock.
 */
function qualifySecondOrder({ orders, now = new Date(), observed = OBSERVED } = {}) {
  const times = paidOrderTimes(orders);
  const nowTime = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowTime)) throw new Error('now must be a valid date.');

  if (times.length !== 2) {
    return { qualifies: false, reason: times.length < 2 ? 'fewer_than_two_orders' : 'three_or_more_orders' };
  }

  const gap = expectedGapDays(times, observed);
  const secondOrderAt = times[1];
  const dueAt = secondOrderAt + gap.days * DAY_MS;
  const daysSinceSecond = (nowTime - secondOrderAt) / DAY_MS;

  if (nowTime < dueAt) {
    return {
      qualifies: false, reason: 'not_yet_due',
      dueAt: new Date(dueAt).toISOString(), daysSinceSecond, basis: gap.basis
    };
  }

  return {
    qualifies: true,
    daysSinceSecond,
    expectedGapDays: gap.days,
    // Named so nothing downstream mistakes one interval for a measured rhythm.
    basis: gap.basis,
    secondOrderAt: new Date(secondOrderAt).toISOString(),
    dueAt: new Date(dueAt).toISOString(),
    evidence: {
      orderCount: 2,
      measuredOn: observed.measuredOn,
      repeatBuyersMeasured: observed.repeatBuyersMeasured,
      note: 'Two orders give one interval, which is a prior and not a cadence.'
    }
  };
}

/**
 * Everybody due a third-order nudge.
 *
 * Groups orders by person first, so a customer's order count is decided once
 * and cannot disagree with the interval computed from the same rows.
 */
function selectDue(orders, { now = new Date(), observed = OBSERVED } = {}) {
  const byPhone = new Map();
  for (const order of orders || []) {
    const phone = normalisePhone(order?.contact_phone);
    if (!phone) continue;
    if (!byPhone.has(phone)) byPhone.set(phone, []);
    byPhone.get(phone).push(order);
  }

  const due = [];
  for (const [phone, rows] of byPhone) {
    const verdict = qualifySecondOrder({ orders: rows, now, observed });
    if (verdict.qualifies) due.push({ phone, ...verdict });
  }
  return due;
}

/** Read every order and return the people due. */
async function dueForSecondOrder({ client, now = new Date(), observed = OBSERVED }) {
  const orders = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client
      .from('sms_orders')
      .select('contact_phone, status, created_at, total, items')
      .range(from, from + 999);
    if (error) throw new Error(`Reading orders failed: ${error.message}`);
    orders.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return selectDue(orders, { now, observed });
}

module.exports = {
  DISQUALIFYING_STATUSES,
  OBSERVED,
  TEMPLATE,
  TEMPLATE_NO_PRODUCT,
  dueForSecondOrder,
  expectedGapDays,
  paidOrderTimes,
  qualifySecondOrder,
  selectDue
};
