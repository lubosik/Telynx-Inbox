'use strict';
/**
 * lib/campaigns/check-in.js — the 21-day post-purchase check-in, as a weekly
 * batch that goes through the ordinary campaign approval.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A WEEKLY BATCH AND NOT A PER-ORDER TIMER
 *
 *   The obvious build is a timer per order: 21 days after somebody buys, send
 *   them a message. It was rejected for one reason.
 *
 *   A check-in is PROMOTIONAL. Whatever it says, its purpose is another order.
 *   The only complete permission gate in this system is a SQL claim function
 *   in scripts/campaigns-migration.sql: the consent predicate, quiet-hours
 *   arithmetic in the business time zone, a per-phone advisory lock and a
 *   durable frequency reservation, all in one transaction. It operates on
 *   APPROVED CAMPAIGN RECIPIENTS.
 *
 *   A per-order timer cannot use it, so a per-order timer means a second gate
 *   written in JavaScript. Two definitions of "may we message this person" is
 *   a compliance incident waiting for the day they disagree, and until that
 *   day it looks exactly like a working feature.
 *
 *   So the check-in is a campaign. Once a week the sweep collects everybody
 *   whose 21-day mark fell in the last seven days, builds one draft, and asks
 *   for approval. The whole gate applies for free, the approval record still
 *   says who authorised messaging whom, and the message lands between day 21
 *   and day 28 rather than exactly on day 21. That imprecision is the entire
 *   cost.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT THE DATA SUPPORTS, WHICH IS NOT WHAT IT LOOKS LIKE
 *
 *   `sms_orders.status` holds FULFILMENT states, not WooCommerce states. The
 *   real distribution is shipped 642, delivered 608, cancelled 252, failed 83,
 *   completed 47. An earlier version of this file qualified on `completed`
 *   alone, which would have skipped 97% of real orders while looking correct.
 *
 *   `shipped_at` and `delivered_at` are NULL on all 1688 rows: the status is
 *   tracked, the timestamp is not. Delivery date is therefore unavailable and
 *   the clock runs from the ORDER date, which is what was asked for anyway.
 *
 *   Measured live, one week's batch is about 40 people.
 *
 * THE FIRST MESSAGE CARRIES NO OFFER, AND THAT IS THE POINT
 *
 *   It asks whether the order was alright. Nothing else. Two reasons.
 *
 *   Commercially, a reply is a far better signal than a send, so the discount
 *   is spent on people who answered rather than on all forty.
 *
 *   For compliance, this business's 10DLC campaign registers CUSTOMER_CARE
 *   alongside MARKETING, and a genuine post-purchase satisfaction question
 *   carrying no offer sits under customer care. The code then goes out from
 *   lib/campaigns/check-in-reply.js as a REPLY TO AN INBOUND MESSAGE, which is
 *   the safest footing available. Putting the offer in message one throws both
 *   of those away.
 *
 * WHAT IT MUST NEVER SAY
 *
 *   It does not say the customer is due, does not reference a schedule, and
 *   does not imply anybody has been watching them. copy-rules.js bans "you are
 *   due" outright, and for this catalogue the line between a shopkeeper who
 *   remembers you and a system that tracks you is worth more than the extra
 *   conversion a nudge would buy.
 */

const { normalisePhone } = require('../phone');

/** The owner's figure. Roughly the product cycle. */
const CHECK_IN_DAYS = 21;

/** How wide one sweep is. Must match how often the sweep actually runs. */
const BATCH_WINDOW_DAYS = 7;

/** Marks a campaign as a check-in, for the reply handler and for reporting. */
const WORKFLOW_CATEGORY = 'checkin_21d';

/**
 * Fulfilment states meaning the customer actually received something.
 *
 * `processing` and `on-hold` are out because the order has not gone;
 * `cancelled`, `failed`, `refunded` and `trash` because asking somebody how
 * they are getting on with an order that never arrived is worse than silence.
 */
const QUALIFYING_STATUSES = new Set(['shipped', 'delivered', 'completed']);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The message. No offer, by design; see the header.
 *
 * Sized against the WORST case, a 12-character first name beside a
 * 12-character product code, so the app's own copy check passes when this is
 * edited rather than flagging a template that merely fits today's audience.
 */
const TEMPLATE = 'It\'s Vin from Vici. Hi {{first_name}}, you picked up {{last_product}} a few '
  + 'weeks back. How did it go? Reply STOP to opt out.';

/** The same question for somebody whose product has no approved code. */
const TEMPLATE_NO_PRODUCT = 'It\'s Vin from Vici. Hi {{first_name}}, you ordered from us a few weeks '
  + 'back. How did it go? Reply here any time. Reply STOP to opt out.';

/**
 * When an order's check-in falls due, or null if it never does.
 *
 * Pure, so the schedule can be reasoned about without a database or a clock.
 */
function checkInDueAt(order, { days = CHECK_IN_DAYS } = {}) {
  const status = String(order?.status || '').toLowerCase();
  if (!QUALIFYING_STATUSES.has(status)) return null;

  // Order date. Delivery date would be better and is not recorded anywhere.
  const placedRaw = order?.created_at || order?.date_paid || order?.paidAt;
  const placedAt = placedRaw instanceof Date ? placedRaw.getTime() : Date.parse(placedRaw);
  if (!Number.isFinite(placedAt)) return null;

  return new Date(placedAt + days * DAY_MS).toISOString();
}

/**
 * Whether an order came due inside the sweep window ending now.
 *
 * A window rather than a single day because the sweep is weekly: anything that
 * came due since the last sweep has to be picked up by this one, or it is
 * missed permanently.
 */
function dueInWindow(order, { now = new Date(), days = CHECK_IN_DAYS, windowDays = BATCH_WINDOW_DAYS } = {}) {
  const dueAt = checkInDueAt(order, { days });
  if (!dueAt) return false;
  const due = Date.parse(dueAt);
  const end = now instanceof Date ? now.getTime() : Date.parse(now);
  return due <= end && due > end - windowDays * DAY_MS;
}

/**
 * Everybody owed a check-in in this sweep, ONE ENTRY PER PERSON.
 *
 * Per person and not per order: somebody who ordered three times in the
 * qualifying week would otherwise appear three times and receive three
 * identical questions. The most recent qualifying order wins, being the one
 * they are most likely to be thinking about.
 */
function selectDue(orders, { now = new Date(), days = CHECK_IN_DAYS, windowDays = BATCH_WINDOW_DAYS } = {}) {
  const byPhone = new Map();
  for (const order of orders || []) {
    if (!dueInWindow(order, { now, days, windowDays })) continue;
    const phone = normalisePhone(order?.contact_phone || order?.phone);
    if (!phone) continue;
    const held = byPhone.get(phone);
    if (!held || Date.parse(order.created_at) > Date.parse(held.created_at)) {
      byPhone.set(phone, order);
    }
  }
  return [...byPhone.entries()].map(([phone, order]) => ({ phone, order }));
}

/**
 * The people due in this sweep, by order date. NOTHING ELSE.
 *
 * ── IT NO LONGER EXCLUDES ANYBODY, AND THAT IS THE FIX ──────────────────────
 *
 * This used to subtract everyone who had ever been in a check-in campaign, and
 * that exclusion had NO DATE FILTER. So being asked once meant never being
 * asked again: a customer who got a check-in for their March order would never
 * get one for their September order, which is the opposite of a campaign whose
 * whole premise is "three weeks after an order, every order".
 *
 * Measured when it was found: 41 people due this week, 40 of them silently
 * removed, permanently, because they appeared in a draft built the same day.
 *
 * The dedupe now lives in ONE place, `alreadyReached` in audience-builder.js,
 * which windows it against the recipe's own `dedupeDays`. Two components
 * deciding "has this person been contacted" is how the answer starts depending
 * on which one you ask.
 */
async function dueForCheckIn({
  client,
  now = new Date(),
  days = CHECK_IN_DAYS,
  windowDays = BATCH_WINDOW_DAYS
}) {
  const orders = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client
      .from('sms_orders')
      .select('contact_phone, status, created_at, items')
      .range(from, from + 999);
    if (error) throw new Error(`Reading orders failed: ${error.message}`);
    orders.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  const due = selectDue(orders, { now, days, windowDays });
  return { due, alreadyAsked: 0, considered: due.length };
}

module.exports = {
  BATCH_WINDOW_DAYS,
  CHECK_IN_DAYS,
  QUALIFYING_STATUSES,
  TEMPLATE,
  TEMPLATE_NO_PRODUCT,
  WORKFLOW_CATEGORY,
  checkInDueAt,
  dueForCheckIn,
  dueInWindow,
  selectDue
};
