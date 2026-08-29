'use strict';
/**
 * lib/campaigns/check-in-reply.js — someone answered the check-in, so send
 * them the code.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS ALLOWED TO SEND WITHOUT A CAMPAIGN APPROVAL
 *
 *   Everything else that reaches a customer for commercial reasons goes
 *   through an approved campaign, because a person must authorise the exact
 *   audience and the exact words. This does not, and the difference is real
 *   rather than convenient: this is a REPLY TO AN INBOUND MESSAGE. The
 *   customer wrote first, seconds ago, in a conversation the business started
 *   by asking them a question.
 *
 *   That is the safest footing in messaging. It is also why the check-in
 *   itself carries no offer: splitting it this way means the broadcast half is
 *   a customer-care question, and the commercial half is a one-to-one answer
 *   to somebody who just spoke.
 *
 *   The words are fixed in this file and reviewed here rather than per send,
 *   which is the trade. There is exactly one message and it never varies
 *   except for the name and the code.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE FIVE REFUSALS, AND WHY EACH ONE EXISTS
 *
 *   1. NO RECENT CHECK-IN. Only somebody the check-in actually reached, within
 *      REPLY_WINDOW_DAYS. Without this, every inbound message in the inbox
 *      becomes a discount trigger, including "where is my order".
 *
 *   2. ALREADY SENT. One code per person per check-in, enforced through
 *      sms_sent_log's unique index rather than by looking first, so two
 *      replies arriving together cannot both win.
 *
 *   3. UNHAPPY. A complaint gets a person, not a coupon. "It arrived broken"
 *      answered by "here's 15% off your next one" is the single worst thing
 *      this feature could do, and it is the most likely bad outcome because
 *      the check-in explicitly invites problems. Anything that looks like a
 *      complaint is flagged for a human and nothing is sent.
 *
 *   4. OPTED OUT. STOP is honoured upstream in routes/webhook.js before this
 *      is reached, so this is a second belt: consent can have been withdrawn
 *      between the check-in and the reply.
 *
 *   5. OUT OF CODE BUDGET. See lib/campaigns/code-budget.js. This path used to
 *      hand 15% to anybody who answered, so a customer could take a win-back
 *      code and then earn a second one for saying "all good thanks", and a
 *      three-order regular got one for the same. One code per person per six
 *      months, and none at all past three orders.
 *
 * THE MOST LIKELY WAY THIS GOES WRONG
 *
 *   Not a bug. It is the customer who replies "no it was terrible" and gets a
 *   cheerful discount. NEGATIVE_MARKERS below is a blunt instrument and will
 *   miss phrasings; it is deliberately biased toward withholding, because a
 *   missed coupon costs one discount and a coupon sent over a complaint costs
 *   the customer.
 */

const { normalisePhone } = require('../phone');
const { render } = require('./merge-fields');
const { validateCopy } = require('./copy-validator');
const { RULES } = require('./copy-rules');
const { WORKFLOW_CATEGORY } = require('./check-in');
const { createCoupons, generateCode } = require('../woocommerce-coupons');
const { gatherFacts } = require('./personalise');
const { mayIssueCode } = require('./code-budget');

/** How long after a check-in a reply still earns the code. */
const REPLY_WINDOW_DAYS = 7;

/** What the code is worth. Matches the win-back. */
const DISCOUNT_PERCENT = 15;

/** How long the code lives. */
const CODE_EXPIRY_DAYS = 30;

/** Recognises the send in sms_sent_log, and makes it idempotent. */
const FLOW_TYPE = 'checkin-reply-code';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The reply. Deliberately short and deliberately warm.
 *
 * No product name and no order date: they just told us how it went, so
 * repeating their own purchase back at them reads as a form letter rather than
 * an answer. Sized against a 12-character name and a 16-character code.
 */
const TEMPLATE = 'It\'s Vin from Vici. Glad to hear it {{first_name}}. {{code}} is 15% off '
  + 'your next order, on me. Reply STOP to opt out.';

/**
 * Phrases that mean "do not send this person a discount right now".
 *
 * Substring matching on lowercased text, so it catches "wasn't great" inside a
 * longer sentence. Biased toward withholding: see the header.
 */
const NEGATIVE_MARKERS = Object.freeze([
  'not good', 'no good', 'not great', "wasn't great", 'wasnt great', 'not happy',
  'unhappy', 'disappointed', 'disappointing', 'terrible', 'awful', 'rubbish',
  'useless', 'waste', 'broken', 'damaged', 'leaking', 'leaked', 'melted',
  'never arrived', 'not arrived', "didn't arrive", 'didnt arrive', 'no delivery',
  'missing', 'wrong item', 'wrong product', 'wrong order', 'refund', 'money back',
  'complaint', 'complain', 'scam', 'fake', 'reaction', 'unwell', 'sick', 'rash',
  'hospital', 'doctor', 'side effect', 'lawyer', 'chargeback', 'dispute',
  'cancel my', 'stop sending', 'leave me alone', 'not interested', 'no thanks',
  'do not contact', "don't contact"
]);

/** Reads as a complaint, or as anything a discount should not answer. */
function looksUnhappy(text) {
  const lower = String(text || '').toLowerCase();
  return NEGATIVE_MARKERS.some(marker => lower.includes(marker));
}

/**
 * The most recent check-in that reached this person inside the reply window.
 *
 * Reads `sent_at` and not merely membership, because somebody who was in the
 * audience but suppressed at send time never received a question and so has
 * not answered one.
 */
async function recentCheckIn({ client, phone, now = new Date(), workspaceID = 'vici' }) {
  const { data: campaigns, error } = await client
    .from('sms_campaigns')
    .select('id, title')
    .eq('workspace_id', workspaceID)
    .eq('workflow_category', WORKFLOW_CATEGORY);
  if (error || !campaigns?.length) return null;

  const since = new Date(now.getTime() - REPLY_WINDOW_DAYS * DAY_MS).toISOString();
  const { data } = await client
    .from('sms_campaign_recipients')
    .select('campaign_id, contact_phone, sent_at')
    .eq('contact_phone', phone)
    .in('campaign_id', campaigns.map(row => row.id)) // bounded: one row per weekly sweep
    .not('sent_at', 'is', null)
    .gte('sent_at', since)
    .order('sent_at', { ascending: false })
    .limit(1);

  return data?.[0] || null;
}

/**
 * Handle one inbound message. Returns what it did and why.
 *
 * Never throws at the caller. This runs inside the Telnyx inbound webhook,
 * whose job is to return 200 and record the customer's message; a failure to
 * send a discount must never turn into a retried webhook or a lost message.
 */
async function handleCheckInReply({
  client,
  phone: rawPhone,
  text,
  now = new Date(),
  workspaceID = 'vici',
  sendSMS,
  coupons = { createCoupons, generateCode }
}) {
  try {
    const phone = normalisePhone(rawPhone);
    if (!phone) return { sent: false, reason: 'invalid_phone' };

    const checkIn = await recentCheckIn({ client, phone, now, workspaceID });
    if (!checkIn) return { sent: false, reason: 'no_recent_check_in' };

    if (looksUnhappy(text)) {
      // A person, not a coupon. The inbox already has the message; this only
      // makes sure nothing cheerful is sent on top of it.
      return { sent: false, reason: 'reply_needs_a_human', campaignID: checkIn.campaign_id };
    }

    const { data: contact } = await client
      .from('sms_contacts').select('opted_out').eq('phone', phone).maybeSingle();
    if (contact?.opted_out) return { sent: false, reason: 'opted_out' };

    // Idempotency BEFORE minting: a second reply must not produce a second code.
    const { data: already } = await client
      .from('sms_sent_log').select('id')
      .eq('phone', phone).eq('flow_type', FLOW_TYPE)
      .eq('order_id', String(checkIn.campaign_id))
      .maybeSingle();
    if (already) return { sent: false, reason: 'code_already_sent' };

    // ── The code budget, which this path used to ignore entirely ─────────
    //
    // It sent 15% to anybody who replied. So a customer could take a win-back
    // code in September, answer a check-in in October, and receive a second
    // one, with nothing anywhere noticing. And a three-order regular, who has
    // already demonstrated the habit the discount exists to create, got one
    // for saying "all good thanks".
    //
    // Both are now refused here rather than in the caller, because this is the
    // last point before minting and a rule enforced anywhere else can be
    // bypassed by a new caller.
    const budget = await mayIssueCode({ client, phone, now });
    if (!budget.allowed) {
      return { sent: false, reason: budget.reason, campaignID: checkIn.campaign_id };
    }

    const facts = (await gatherFacts({ client, phones: [phone] })).get(phone) || {};

    const code = coupons.generateCode({ prefix: 'vin', seed: `${checkIn.campaign_id}:${phone}:reply` });
    const expiresAt = new Date(now.getTime() + CODE_EXPIRY_DAYS * DAY_MS).toISOString().slice(0, 10);
    const minted = await coupons.createCoupons({
      coupons: [{ code, percentOff: DISCOUNT_PERCENT, expiresAt, usageLimit: 1 }]
    });
    const failure = (minted?.failed || []).find(row => row.code === code && row.duplicate !== true);
    if (failure) return { sent: false, reason: 'coupon_not_created', error: failure.error };

    const outcome = render(TEMPLATE, { ...facts, couponCode: code });
    if (outcome.missing.length) {
      return { sent: false, reason: 'personalisation_unavailable', missing: outcome.missing };
    }

    // The rendered text, not the template. Same rule as every campaign send:
    // a template that passes can still render into something that does not.
    const verdict = validateCopy(outcome.text, {
      brandName: RULES.brand.defaultName,
      approvedProductCodes: [...RULES.defaultApprovedProductCodes, code]
    });
    if (!verdict.ok) {
      return { sent: false, reason: 'rendered_message_not_compliant', failedChecks: (verdict.failures || []).map(f => f.check) };
    }

    const result = await sendSMS(phone, outcome.text);

    // The unique index on (order_id, flow_type, phone) is the real guard
    // against a double send, so a conflict here means somebody else won the
    // race and that is a success, not an error.
    await client.from('sms_sent_log').insert({
      order_id: String(checkIn.campaign_id),
      flow_type: FLOW_TYPE,
      phone,
      message_body: outcome.text,
      telnyx_message_id: result?.messageId || null
    });

    return { sent: true, phone, code, campaignID: checkIn.campaign_id, message: outcome.text };
  } catch (error) {
    // Swallowed on purpose; see the doc comment.
    return { sent: false, reason: 'handler_failed', error: error.message };
  }
}

module.exports = {
  CODE_EXPIRY_DAYS,
  DISCOUNT_PERCENT,
  FLOW_TYPE,
  NEGATIVE_MARKERS,
  REPLY_WINDOW_DAYS,
  TEMPLATE,
  handleCheckInReply,
  looksUnhappy,
  recentCheckIn
};
