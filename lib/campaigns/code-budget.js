'use strict';
/**
 * lib/campaigns/code-budget.js — how many discount codes one person may ever
 * be given, and who may be given one at all.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 *
 *   Two separate paths mint codes and neither knew about the other:
 *
 *     1. campaign approval, for any campaign whose copy uses {{code}}
 *     2. the check-in reply handler, which sent 15% to anybody who answered
 *
 *   So a customer could take a win-back code in September, reply to a check-in
 *   in October and get a second one, and nothing anywhere would notice. On a
 *   catalogue with a $169 median order that is not a rounding error, and worse
 *   than the margin is what it teaches: a customer who receives a code every
 *   time they interact learns to wait for one, and the discount stops being a
 *   recovery tool and becomes the price.
 *
 *   The owner's rule, in their words: "we can only send one code, we can't be
 *   sending a code every single time".
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * TWO RULES, AND THEY ARE DIFFERENT KINDS OF RULE
 *
 *   ONE CODE PER PERSON PER WINDOW is about not training a habit. It applies
 *   to everybody and is the reason this module is consulted before any mint.
 *
 *   REGULARS GET NO CODE AT ALL is about not paying people who already buy.
 *   Somebody on their third order has demonstrated the habit the discount was
 *   meant to create, so a code to them is pure margin given away. Again the
 *   owner's framing: past three orders it is "just a check-in, without any
 *   coupon codes".
 *
 * WHAT COUNTS AS HAVING BEEN GIVEN A CODE
 *
 *   Both paths, because a rule that only sees one of them is not a rule:
 *
 *     * `sms_campaign_recipients.issued_coupon_code`, written at approval, but
 *       ONLY where the message actually went out. A code minted for a campaign
 *       that was then cancelled reached nobody and must not block a real one.
 *     * `sms_sent_log` rows with the check-in reply flow type.
 *
 *   ISSUED, not redeemed. Somebody holding an unused code still holds a code,
 *   and giving them a second one is exactly the thing being prevented.
 *
 * IT FAILS CLOSED
 *
 *   A read that errors returns "already has one" rather than "go ahead". The
 *   cost of being wrong in one direction is a customer who did not get a
 *   discount they might have enjoyed; in the other it is margin given away and
 *   a habit taught. Those are not comparable.
 */

const { normalisePhone } = require('../phone');

/**
 * One code per person per six months.
 *
 * Matches the win-back's own dedupe window, deliberately: the win-back is the
 * campaign whose whole purpose is the code, so a person becoming eligible for
 * a second win-back and becoming eligible for a second code should be the same
 * moment rather than two rules that drift apart.
 */
const CODE_WINDOW_DAYS = 180;

/**
 * Paid orders at which somebody stops being offered codes.
 *
 * Three. At two orders the habit is not established, and the second-order
 * nudge already carries no code for its own reasons. At three the customer is
 * a regular and a discount is margin given to somebody who was buying anyway.
 */
const REGULAR_ORDER_COUNT = 3;

/** Orders that never became money and must not make somebody a "regular". */
const UNPAID_STATUSES = new Set(['cancelled', 'failed', 'refunded', 'trash', 'pending']);

/** The check-in reply handler's flow type, duplicated to avoid a require cycle. */
const REPLY_CODE_FLOW_TYPE = 'checkin-reply-code';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How many paid orders somebody has.
 *
 * Counted here rather than read from a cohort, because the cohorts are
 * recomputed daily and a code decision has to reflect the order that landed an
 * hour ago.
 */
async function paidOrderCount({ client, phone }) {
  const { data, error } = await client
    .from('sms_orders')
    .select('status')
    .eq('contact_phone', phone);
  if (error) throw new Error(`Reading orders failed: ${error.message}`);
  return (data || []).filter(row => !UNPAID_STATUSES.has(String(row.status || '').toLowerCase())).length;
}

/**
 * Decide whether one person may be given a code.
 *
 * Returns a reason on refusal, always, because "no code" with no explanation
 * is indistinguishable from a bug when somebody asks why a customer did not
 * get one.
 */
async function mayIssueCode({
  client,
  phone: rawPhone,
  now = new Date(),
  windowDays = CODE_WINDOW_DAYS,
  regularOrderCount = REGULAR_ORDER_COUNT
}) {
  const phone = normalisePhone(rawPhone);
  if (!phone) return { allowed: false, reason: 'invalid_phone' };

  try {
    const orders = await paidOrderCount({ client, phone });
    if (orders >= regularOrderCount) {
      return { allowed: false, reason: 'regular_customer', orderCount: orders };
    }

    const since = new Date(now.getTime() - windowDays * DAY_MS).toISOString();

    // Path 1: a campaign code, but only where the message actually went.
    const { data: campaignCodes, error: campaignError } = await client
      .from('sms_campaign_recipients')
      .select('issued_coupon_code, sent_at')
      .eq('contact_phone', phone)
      .not('issued_coupon_code', 'is', null)
      .not('sent_at', 'is', null)
      .gte('sent_at', since)
      .limit(1);
    // The column arrives with scripts/coupon-attribution-migration.sql. Before
    // that there are no recorded campaign codes to find, which is true rather
    // than an error, so this one case does not fail closed.
    if (campaignError && campaignError.code !== '42703' && campaignError.code !== 'PGRST204') {
      throw new Error(`Reading issued codes failed: ${campaignError.message}`);
    }
    if (campaignCodes?.length) {
      return { allowed: false, reason: 'already_had_a_code', at: campaignCodes[0].sent_at };
    }

    // Path 2: a code sent as a reply to a check-in.
    // `sent_at`, not `created_at`. sms_sent_log has no created_at column, and
    // asking for one fails the whole check, which fails closed, which locked
    // every single customer out of every code. Caught only by running it
    // against the real database.
    const { data: replyCodes, error: replyError } = await client
      .from('sms_sent_log')
      .select('sent_at')
      .eq('phone', phone)
      .eq('flow_type', REPLY_CODE_FLOW_TYPE)
      .gte('sent_at', since)
      .limit(1);
    if (replyError) throw new Error(`Reading the send log failed: ${replyError.message}`);
    if (replyCodes?.length) {
      return { allowed: false, reason: 'already_had_a_code', at: replyCodes[0].sent_at };
    }

    return { allowed: true, orderCount: orders };
  } catch (error) {
    // Fails closed. A missed discount costs one order's uplift; a duplicate
    // costs margin and teaches the customer to wait for the next one.
    return { allowed: false, reason: 'budget_check_failed', error: error.message };
  }
}

/**
 * The same decision for a whole audience, in one pass.
 *
 * Used at approval, where asking per recipient would be hundreds of round
 * trips. Returns the phones that may be given a code and, separately, why each
 * refusal happened, so the campaign can report it rather than quietly shrink.
 */
async function filterEligibleForCode({
  client,
  phones,
  now = new Date(),
  windowDays = CODE_WINDOW_DAYS,
  regularOrderCount = REGULAR_ORDER_COUNT
}) {
  const unique = [...new Set((phones || []).map(normalisePhone).filter(Boolean))];
  const allowed = [];
  const refused = [];
  for (const phone of unique) {
    const verdict = await mayIssueCode({ client, phone, now, windowDays, regularOrderCount });
    if (verdict.allowed) allowed.push(phone);
    else refused.push({ phone, reason: verdict.reason });
  }
  return { allowed, refused };
}

module.exports = {
  CODE_WINDOW_DAYS,
  REGULAR_ORDER_COUNT,
  REPLY_CODE_FLOW_TYPE,
  UNPAID_STATUSES,
  filterEligibleForCode,
  mayIssueCode,
  paidOrderCount
};
