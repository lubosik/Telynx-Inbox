'use strict';
/**
 * lib/campaigns/checkin-offer-policy.js — when a positive check-in reply
 * should carry a discount, and when it should just be a conversation.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RULE, IN THE OWNER'S WORDS
 *
 *   "If we can see that they've ordered and haven't ordered again, but we've
 *    checked in with them, we can give them the code. If they order with the
 *    code, the next check-in will just be from that conversation history: how
 *    did everything go. If they haven't ordered, if it's been past their
 *    normal reorder date twice, then we can offer it to them. Just so we don't
 *    spam them with codes."
 *
 *   Both halves collapse into ONE question, which is why this file is short:
 *
 *      has enough time passed since their LAST ORDER that they are properly
 *      lapsed rather than simply between orders?
 *
 *   Somebody who redeemed a code has a recent order, so they fail that test
 *   and their next check-in is conversation only — exactly as asked, with no
 *   special case for it. Somebody who ignored a code keeps ageing until they
 *   pass it. One measurement, both behaviours.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT REPLACED THE OLD RULE, AND WHY
 *
 *   `mayIssueCode` refused anybody with three or more paid orders
 *   (`regular_customer`) and anybody who had had any code in 180 days. On the
 *   day this was written that silently refused three of the four genuinely
 *   happy replies to a check-in, including the customer who wrote "I love the
 *   Reta! Started it on the 10th and down 6lbs".
 *
 *   Refusing your best customers is a defensible policy — they would probably
 *   reorder anyway — but it is the opposite of what was asked for, and it was
 *   happening invisibly. Order COUNT is not what makes an offer wasteful.
 *   Sending one to somebody who just ordered is.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * "THEIR NORMAL REORDER DATE" IS UNKNOWN FOR MOST PEOPLE
 *
 *   Measured on this database: 843 customers with a paid order. 554 have
 *   exactly one, 166 have two, 123 have three or more. calculateReorderCadence
 *   needs two intervals — three orders — and treats a variable history as no
 *   answer, so it produces a usable rhythm for 57 people. For 786 of 843 there
 *   is no personal reorder date to be past twice.
 *
 *   So a shop-wide fallback carries almost all of the traffic, and it is
 *   measured rather than picked: across 493 observed reorder gaps the median
 *   is 35 days (p25 17, p75 62, p90 91). A personal cadence is used whenever
 *   one exists, because it is better evidence about that person; the median
 *   stands in when it does not.
 */

const { calculateReorderCadence } = require('./reorder-cadence');

/**
 * The shop's median reorder gap, in days.
 *
 * Measured, not assumed: 493 observed gaps between consecutive paid orders,
 * bounded to 3-365 days to exclude duplicate submissions and year-long
 * dormancy. Re-measure this when the catalogue changes materially; a number
 * this load-bearing should not quietly age.
 */
const DEFAULT_REORDER_DAYS = 35;

/** How many reorder intervals must pass before an offer is warranted. */
const LAPSE_MULTIPLE = 2;

const PAID_STATUSES = new Set(['processing', 'completed', 'shipped', 'delivered']);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The interval to judge this person against, and where it came from.
 *
 * Returned rather than logged, because a refusal that says "we expect you back
 * every 35 days" is answerable and one that says "not yet" is not.
 */
function reorderIntervalFor(orders, now) {
  const cadence = calculateReorderCadence({
    purchases: (orders || []).map(order => ({
      paidAt: order.created_at,
      status: order.status
    })),
    now
  });
  // The rhythm lives on `.cadence`, not on the top-level result. The outer
  // object answers "should we contact them now", which is a different question
  // from "how often do they buy" — a customer mid-cycle comes back
  // `eligible: false, reason: 'reorder_window_not_reached'` while carrying a
  // perfectly good median. Reading the outer shape silently sent every one of
  // them to the shop median instead of their own number.
  const personal = cadence?.cadence;
  if (personal?.reliable && Number.isFinite(personal.medianDays) && personal.medianDays > 0) {
    return { days: personal.medianDays, source: 'personal' };
  }
  return { days: DEFAULT_REORDER_DAYS, source: 'shop_median' };
}

/**
 * Decide whether this positive check-in reply should carry a code.
 *
 * Pure apart from the two reads, and every refusal names itself, so the
 * operator can see why a happy customer got a plain thank-you.
 */
async function mayOfferCheckInCode({
  client,
  phone,
  now = new Date(),
  lapseMultiple = LAPSE_MULTIPLE
} = {}) {
  if (!client || !phone) return { allowed: false, reason: 'invalid_request' };

  try {
    const { data: orders, error: orderError } = await client
      .from('sms_orders')
      .select('created_at,status')
      .eq('contact_phone', phone)
      .order('created_at', { ascending: false });
    if (orderError) throw new Error(orderError.message);

    const paid = (orders || []).filter(o => PAID_STATUSES.has(String(o.status || '').toLowerCase()));
    if (!paid.length) {
      // A check-in only goes to somebody who ordered, so this should be
      // unreachable. If it happens, something upstream is wrong and an offer
      // is not the way to find out.
      return { allowed: false, reason: 'never_ordered' };
    }

    const lastOrderAt = Date.parse(paid[0].created_at);
    const daysSinceLastOrder = (now.getTime() - lastOrderAt) / DAY_MS;
    const interval = reorderIntervalFor(paid, now);
    const lapseAfterDays = interval.days * lapseMultiple;

    // Has this person ever been offered a code at all? The first offer needs
    // no waiting: they ordered once, they have not come back, and we are
    // already in a conversation with them. That is the whole case for it.
    const { data: priorCodes, error: codeError } = await client
      .from('sms_sent_log')
      .select('sent_at')
      .eq('phone', phone)
      .in('flow_type', ['checkin-reply-code', 'campaign'])
      .order('sent_at', { ascending: false })
      .limit(1);
    if (codeError) throw new Error(codeError.message);

    const context = {
      daysSinceLastOrder: Math.round(daysSinceLastOrder),
      reorderIntervalDays: interval.days,
      intervalSource: interval.source,
      lapseAfterDays: Math.round(lapseAfterDays),
      orderCount: paid.length
    };

    if (!priorCodes?.length) {
      return { allowed: true, reason: 'first_offer', ...context };
    }

    if (daysSinceLastOrder >= lapseAfterDays) {
      return { allowed: true, reason: 'lapsed_past_two_intervals', ...context };
    }

    // They have had a code and are still inside their normal buying rhythm.
    // If they used it, their last order is recent and this check-in is a
    // conversation rather than another discount. If they ignored it, they will
    // qualify on their own once enough time passes.
    return {
      allowed: false,
      reason: 'within_normal_reorder_cycle',
      lastCodeAt: priorCodes[0].sent_at,
      ...context
    };
  } catch (error) {
    // Fail closed. An unreadable history is not evidence that somebody is
    // lapsed, and a discount sent on a database error is not recoverable.
    return { allowed: false, reason: 'offer_check_failed', error: error.message };
  }
}

module.exports = {
  DEFAULT_REORDER_DAYS,
  LAPSE_MULTIPLE,
  mayOfferCheckInCode,
  reorderIntervalFor
};
