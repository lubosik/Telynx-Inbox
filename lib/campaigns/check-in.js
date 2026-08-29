'use strict';
/**
 * lib/campaigns/check-in.js — WHEN the 21-day check-in is due.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOT WIRED YET, ON PURPOSE. READ THIS BEFORE CONNECTING IT.
 *
 *   This module computes and queues the DUE DATE. It does not send anything
 *   and nothing calls it. The sending half is blocked on a design decision the
 *   owner has to make, described at the bottom of this comment.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE PROBLEM THAT STOPPED THE OBVIOUS IMPLEMENTATION
 *
 *   A check-in is PROMOTIONAL. The queue it would naturally ride on,
 *   `sms_scheduled` drained by `processScheduledQueue()` in flows/utils.js, is
 *   TRANSACTIONAL. Its send path checks exactly two things: has this person
 *   sent STOP, and has this exact message already gone. That is the complete
 *   and correct list for "your order has shipped", which a customer is owed
 *   regardless of marketing consent.
 *
 *   It is nowhere near the list for "want to order another one". That needs
 *   promotional consent, quiet hours, the rolling frequency caps and the
 *   do-not-contact list. Sending a check-in down the transactional path would
 *   deliver marketing at 3am to people with no marketing consent, and every
 *   log line would say it worked.
 *
 *   The first draft of this file answered that by re-implementing the gate in
 *   JavaScript. That was worse. The authoritative gate is a SQL claim function
 *   in scripts/campaigns-migration.sql: it holds the consent predicate, the
 *   quiet-hours arithmetic in the business time zone, an advisory lock per
 *   phone and a durable frequency reservation, all inside one transaction. A
 *   second gate in JS would be two definitions of "may we message this
 *   person", and the day they disagree is a compliance incident that looks
 *   like a working feature. So it was deleted rather than finished.
 *
 * THE DECISION THAT IS ACTUALLY OPEN
 *
 *   Reusing the real gate means the check-in must arrive as campaign
 *   recipients, and campaign recipients are frozen by an approval that records
 *   who authorised the exact audience. That collides with "fires automatically
 *   21 days after every order", because nobody approves a message that has not
 *   been composed yet for a customer who has not ordered yet.
 *
 *   The two honest resolutions:
 *
 *   1. WEEKLY BATCH. Once a week the cycle gathers everybody whose 21-day mark
 *      falls in the coming week into one campaign draft and asks for approval.
 *      Keeps every existing guarantee, reuses the whole gate, and the owner
 *      approves one thing a week instead of nothing. The check-in lands within
 *      a few days of day 21 rather than exactly on it.
 *
 *   2. STANDING APPROVAL. A check-in campaign approved once, into which
 *      recipients flow as they come due. Fires on the day. Requires
 *      deliberately weakening the frozen-audience guarantee, which is the
 *      thing that currently records who authorised messaging whom, so it needs
 *      its own approval concept rather than a quiet reinterpretation of the
 *      existing one.
 *
 *   Option 1 needs no new safety machinery. Option 2 is what the owner
 *   described and is a bigger change than it sounds.
 *
 * WHY 21 DAYS, AND WHY IT IS FIXED
 *
 *   The owner's figure, roughly the cycle of the products. Deliberately NOT
 *   derived from the customer's own rhythm: `calculateReorderCadence` needs
 *   three orders before it states a rhythm at all, which excludes the 504
 *   people who have bought exactly once, who are precisely who a first
 *   check-in is for.
 *
 * WHY IT CARRIES NO DISCOUNT
 *
 *   Asked and decided. It teaches customers that waiting is cheaper. It spends
 *   margin on people who were reordering anyway, the same argument
 *   BUYER-COHORTS.md makes against discounting one_time_first_month. And a
 *   "check-in" that is transparently an advert earns a STOP, which costs that
 *   customer permanently rather than for one message. The discount belongs in
 *   the win-back, where the people have already shown they are not coming back
 *   on their own.
 *
 * WHAT IT SAYS, AND WHAT IT MUST NEVER SAY
 *
 *   It asks whether the order was alright and leaves the door open. It does
 *   not say the customer is due, does not reference a schedule, and does not
 *   imply anybody has been watching them. `copy-rules.js` bans "you are due"
 *   outright, and the phrasing here is an offer to help rather than a claim
 *   about somebody's own consumption. That is the line between a shopkeeper
 *   and a surveillance system, and for this catalogue it matters more than
 *   usual.
 */

const { normalisePhone } = require('../phone');

/** The owner's figure. Roughly the product cycle. */
const CHECK_IN_DAYS = 21;

/** One flow type, so the queue's own (order_id, flow_type) dedupe applies. */
const FLOW_TYPE = 'checkin-21d';

/**
 * Order states that earn a check-in.
 *
 * `completed` only. `processing` means paid but not yet shipped, so counting
 * 21 days from payment would reach some customers a fortnight after payment
 * but only days after delivery. Asking whether somebody is getting on with
 * something that arrived last week reads as though nobody is paying attention.
 */
const QUALIFYING_STATUSES = new Set(['completed']);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The message, once the sending half exists.
 *
 * Written to render through the campaign merge fields, so `{{last_product}}`
 * is the APPROVED CODE and never the compound name, and somebody whose product
 * cannot be named safely falls to the second template rather than receiving a
 * sentence with a hole in it.
 */
// Both are sized against the WORST case, not the average: a 12-character
// first name beside a 12-character product code. The friendlier first draft
// read well at "Hi Jess, you picked up RT" and billed as two segments for
// anybody called Christopher, which is the mistake worth catching once rather
// than per send.
const TEMPLATE = 'Vin from Vici. Hi {{first_name}}, you picked up {{last_product}} a few weeks '
  + 'back. All good with it? Reply STOP to opt out.';

/** The same message for somebody whose product has no approved code. */
const TEMPLATE_NO_PRODUCT = 'Vin from Vici. Hi {{first_name}}, you ordered from us a few weeks '
  + 'back. All good with it? Reply here any time. Reply STOP to opt out.';

/**
 * When an order's check-in falls due, or null if it never does.
 *
 * Pure, so the schedule can be reasoned about and tested without a database or
 * a clock.
 */
function checkInDueAt(order, { days = CHECK_IN_DAYS } = {}) {
  const status = String(order?.status || '').toLowerCase();
  if (!QUALIFYING_STATUSES.has(status)) return null;

  const paidRaw = order?.date_paid || order?.date_paid_gmt || order?.paidAt || order?.created_at;
  const paidAt = paidRaw instanceof Date ? paidRaw.getTime() : Date.parse(paidRaw);
  if (!Number.isFinite(paidAt)) return null;

  return new Date(paidAt + days * DAY_MS).toISOString();
}

/**
 * Queue the due date for one order.
 *
 * Writes a PENDING row and nothing else.
 *
 * These rows are SAFE TO ACCUMULATE only because flows/utils.js explicitly
 * excludes `checkin-21d` from the transactional queue. That exclusion is not
 * incidental and must not be removed: without it, `processScheduledQueue`
 * selects every pending row whose send_at has passed, hands `message_body`
 * straight to sendAndLog, and this module writes that column as null on
 * purpose. The first draft of this comment claimed the rows were harmless
 * because nothing claimed the flow type. That was wrong; the queue claims
 * everything. test/campaign-check-in.test.js now pins the exclusion.
 *
 * Idempotent through the queue's unique (order_id, flow_type), so a redelivered
 * WooCommerce webhook cannot produce a second check-in. Returns what it did
 * rather than throwing, because the caller is a webhook handler whose job is to
 * return 200: a check-in that failed to schedule must never become a retried
 * order webhook.
 */
async function scheduleCheckIn({ client, order, now = new Date(), days = CHECK_IN_DAYS }) {
  const phone = normalisePhone(order?.phone || order?.billing?.phone);
  if (!phone) return { scheduled: false, reason: 'no_phone' };

  const dueAt = checkInDueAt(order, { days });
  if (!dueAt) return { scheduled: false, reason: 'order_not_eligible' };

  // A backfilled or very old order would schedule a check-in in the past, and
  // a queue reading "due" would fire it at once. For a six-month-old order
  // that means checking in about something long forgotten.
  if (Date.parse(dueAt) <= now.getTime()) return { scheduled: false, reason: 'due_date_already_passed' };

  const orderID = String(order?.id || order?.woo_order_id || '');
  if (!orderID) return { scheduled: false, reason: 'no_order_id' };

  const { error } = await client.from('sms_scheduled').upsert({
    order_id: orderID,
    phone,
    flow_type: FLOW_TYPE,
    // Deliberately null. The body is rendered when it is sent, not now:
    // 21 days is long enough for the copy rules, the catalogue or the
    // customer's own name to change, and a body written today would never see
    // the per-recipient validation that rendering performs.
    message_body: null,
    send_at: dueAt,
    status: 'pending'
  }, { onConflict: 'order_id,flow_type', ignoreDuplicates: true });

  if (error) return { scheduled: false, reason: 'insert_failed', error: error.message };
  return { scheduled: true, sendAt: dueAt, phone, orderID };
}

module.exports = {
  CHECK_IN_DAYS,
  FLOW_TYPE,
  QUALIFYING_STATUSES,
  TEMPLATE,
  TEMPLATE_NO_PRODUCT,
  checkInDueAt,
  scheduleCheckIn
};
