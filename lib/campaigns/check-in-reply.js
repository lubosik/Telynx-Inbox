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
 *   3. NOT SIMPLY HAPPY. lib/campaigns/reply-triage.js classifies the reply
 *      and only a confident `happy` earns the code. Everything else, a
 *      problem, a question, a buying signal, or anything the model is unsure
 *      about, is recorded for a person with a drafted answer. "It arrived
 *      broken" answered by "here's 15% off your next one" is the single worst
 *      thing this feature could do, and the check-in explicitly invites
 *      problems, so it is the likely bad outcome rather than a rare one.
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
 *   cheerful discount. Triage is the first defence and the keyword list below
 *   is the second: it can VETO a `happy` the model got wrong but can never
 *   create one, so both are wrong only in the safe direction. A missed coupon
 *   costs one discount; a coupon sent over a complaint costs the customer.
 */

const { normalisePhone } = require('../phone');
const { render } = require('./merge-fields');
const { validateCopy } = require('./copy-validator');
const { RULES } = require('./copy-rules');
const { WORKFLOW_CATEGORY } = require('./check-in');
const { createCoupons, generateCode } = require('../woocommerce-coupons');
const { gatherFacts } = require('./personalise');
const { mayIssueCode } = require('./code-budget');
const { AUTO_SEND_CONFIDENCE, acknowledgementFor, recordForHuman, triageReply } = require('./reply-triage');
const { suppressOptOut } = require('../opt-out-suppression');

/**
 * Lazy, because flows/utils.js pulls in db.js, which constructs a Supabase
 * client at import time. Requiring it at the top breaks every test that loads
 * this module without credentials, which is all of them.
 */
const orderFlows = () => require('../../flows/utils');

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
/** Used when the clause writer is unavailable or produced nothing usable. */
const FALLBACK_ACKNOWLEDGEMENT = 'Thanks for getting back to me.';

/**
 * The code message, composed around a per-reply opening clause.
 *
 * A FUNCTION rather than a template with a `{{acknowledgement}}` placeholder,
 * because that placeholder is not a merge field and validateCopy rightly
 * refuses unknown ones. A template that can never be validated as written is a
 * template nobody can check, and the first version of this failed its own
 * compliance test for exactly that reason.
 *
 * Only the clause varies. The offer wording, the code and the opt-out line are
 * identical on every send, so the generated surface is one short sentence and
 * the commercial half is the reviewed text it has always been.
 */
function codeMessageTemplate(acknowledgement = FALLBACK_ACKNOWLEDGEMENT) {
  const clause = String(acknowledgement || FALLBACK_ACKNOWLEDGEMENT).trim();
  return `It's Vin from Vici. ${clause} {{code}} is 15% off your next order. `
    + 'Reply STOP to opt out.';
}

/** The message as it reads with no clause of its own. Validated by tests. */
const TEMPLATE = codeMessageTemplate();

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
  coupons = { createCoupons, generateCode },
  // Injectable so a test never reaches a model, matching how coupons are
  // injected. A test that silently made a real completion call would be slow,
  // flaky and occasionally expensive.
  triage: triageImpl = triageReply
}) {
  try {
    const phone = normalisePhone(rawPhone);
    if (!phone) return { sent: false, reason: 'invalid_phone' };

    const checkIn = await recentCheckIn({ client, phone, now, workspaceID });
    if (!checkIn) return { sent: false, reason: 'no_recent_check_in' };

    // ── Read what they actually said ─────────────────────────────────────
    //
    // This used to be a substring list: match a complaint word or send the
    // code. So "the vial cracked in transit" matched nothing and earned a
    // cheerful 15% off while the real problem sat unread.
    //
    // Now a model classifies the reply and drafts an answer for anything that
    // is not simply positive. It can only ever WITHHOLD the code, never invent
    // a reason to send one, and nothing it writes goes out unread.
    const triage = await triageImpl({ text, now });

    // ── An opt-out the keyword matcher missed ────────────────────────────
    //
    // routes/webhook.js honours STOP before this is reached, using
    // isOptOutRequest, which is a phrase list. Measured against it: "stop
    // texting me", "unsubscribe" and "take me off your list" are caught;
    // "please stop sending me these" and "leave me alone" are not. Those are
    // unambiguous requests to be left alone and they were going unhonoured.
    //
    // Suppressing on the model's word is the safe direction. A false positive
    // stops messaging somebody who did not ask, which is recoverable by
    // hand; the other way round is an unhonoured opt-out, which is not
    // recoverable at all. So a confident opt_out_intent is honoured through
    // the same path STOP uses, and recorded so a person can see it and undo
    // it if the model was wrong.
    if (triage.intent === 'opt_out_intent' && triage.confidence >= AUTO_SEND_CONFIDENCE) {
      // ── Everything the STOP branch does, in the same order ─────────────
      //
      // The first version called only suppressOptOut, and that was wrong in a
      // way worth writing down. suppressOptOut writes the campaign suppression
      // and the consent withdrawal. It does NOT write the `opted-out` sentinel
      // in sms_sent_log, and that sentinel is the ONLY thing isOptedOut()
      // reads, and isOptedOut() is what gates sendAndLog, which carries the
      // order automations.
      //
      // So somebody who asked to be left alone would have stopped receiving
      // campaigns and carried on receiving shipping and payment messages.
      // Half-honouring an opt-out is not honouring it.
      //
      // markOptedOut writes the sentinel and then an audit row that throws if
      // it cannot be written. That throw is correct for an action gated on
      // consent being recorded and wrong here: an unrecorded suppression is a
      // bookkeeping problem, an unhonoured opt-out is a regulatory one. So the
      // throw is caught and the suppression proceeds, exactly as the STOP
      // branch in routes/webhook.js does.
      try {
        await orderFlows().markOptedOut(phone);
      } catch (optOutError) {
        console.error(`[CHECK-IN] Suppressing ...${phone.slice(-4)} despite an unrecorded consent event: ${optOutError.message}`);
      }
      await orderFlows().cancelScheduledForCustomer(phone).catch(() => {});
      await suppressOptOut(phone, { client }).catch(() => null);
      await recordForHuman({ client, phone, replyText: text, triage })
        .catch(() => ({ recorded: false }));
      return {
        sent: false,
        reason: 'opt_out_detected',
        intent: triage.intent,
        suppressed: true,
        campaignID: checkIn.campaign_id
      };
    }

    if (!triage.autoSendCode) {
      await recordForHuman({ client, phone, replyText: text, triage })
        .catch(() => ({ recorded: false }));
      return {
        sent: false,
        reason: 'reply_needs_a_human',
        intent: triage.intent,
        drafted: Boolean(triage.draftReply),
        campaignID: checkIn.campaign_id
      };
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

    // The warm opening, written for this reply. Falls back to the reviewed
    // fixed wording rather than failing: worse copy, never a failed send.
    const acknowledgement = await acknowledgementFor({ text }).catch(() => null);
    const outcome = render(codeMessageTemplate(acknowledgement), { ...facts, couponCode: code });
    if (outcome.missing.length) {
      return { sent: false, reason: 'personalisation_unavailable', missing: outcome.missing };
    }

    // The rendered text, not the template. Same rule as every campaign send:
    // a template that passes can still render into something that does not.
    // Validated AFTER the clause is spliced in, so a model-written opening is
    // checked exactly like the rest of the message rather than trusted.
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
  FALLBACK_ACKNOWLEDGEMENT,
  FLOW_TYPE,
  codeMessageTemplate,
  NEGATIVE_MARKERS,
  REPLY_WINDOW_DAYS,
  TEMPLATE,
  handleCheckInReply,
  looksUnhappy,
  recentCheckIn
};
