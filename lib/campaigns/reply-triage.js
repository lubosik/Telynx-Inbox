'use strict';
/**
 * lib/campaigns/reply-triage.js — read what a customer actually said, decide
 * whether it needs a person, and draft the reply for them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS REPLACES, AND WHY IT NEEDED REPLACING
 *
 *   Reply handling was a substring list. `NEGATIVE_MARKERS` in
 *   check-in-reply.js held about forty phrases, and a reply either matched one
 *   or did not. Match, no code. No match, send the code. It never composed a
 *   reply to anything.
 *
 *   So "the vial cracked in transit" matched nothing, earned a cheerful 15%
 *   off, and the actual problem sat unread. And "cheers mate, all sorted"
 *   contains "sorted" and nothing else, so it worked by luck rather than by
 *   understanding.
 *
 *   Three different things were also reading inbound text and disagreeing:
 *   this keyword list, the keyword list in lib/analytics/sentiment.js, and the
 *   LLM in intelligence.js. That is the same fault as the check-in dedupe and
 *   the length check: several components answering one question, and whichever
 *   is consulted first winning.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT IT WILL AND WILL NOT DO ON ITS OWN
 *
 *   AUTO-SENDS exactly one thing: the fixed discount-code message, and only
 *   for a reply classified `happy` with high confidence. That message is one
 *   sentence, written by a person, reviewed once, and never varies except for
 *   the name and the code.
 *
 *   EVERYTHING ELSE IS DRAFTED, NEVER SENT. A problem, a question, a buying
 *   signal, or anything the model is unsure about becomes a row a human reads
 *   and sends with one tap.
 *
 *   Nothing the model composes reaches a customer without somebody reading it.
 *   That is not caution for its own sake: this is a peptide seller, the model
 *   that drafts is capable of writing a health claim or a compound name, and
 *   the cost of one bad automated reply is a customer and possibly a carrier
 *   complaint. The leverage is in the reading and the drafting, which is most
 *   of the work; the sending is the cheap part and it stays human.
 *
 * IT FAILS SAFE IN THE ONLY DIRECTION THAT MATTERS
 *
 *   Model unavailable, malformed answer, timeout, low confidence: the result
 *   is `needsHuman`, never an auto-send. The keyword list survives as a
 *   FALLBACK for exactly one decision, whether a reply is obviously unhappy,
 *   because an outage must not turn "it arrived broken" into a coupon.
 *
 * EVERY DRAFT IS VALIDATED BEFORE IT IS STORED
 *
 *   A drafted reply goes through validateCopy at draft time, not at send time,
 *   so a human is never shown a suggestion they cannot actually send. A draft
 *   that fails is dropped and the row still says a person is needed, which is
 *   the honest outcome: the model had nothing usable to offer.
 */

const { privateCompletion } = require('../openrouter-private');
const { validateCopy } = require('./copy-validator');
const { RULES } = require('./copy-rules');

/** What a reply can be. Deliberately few, and each routes somewhere different. */
const INTENTS = Object.freeze([
  'happy',          // said it went well, nothing needed
  'problem',        // something is wrong: damage, delivery, a reaction
  'question',       // wants to know something
  'buying_signal',  // wants to order, or asks how to
  'opt_out_intent', // wants to be left alone, without texting STOP
  'unclear'         // the model could not tell
]);

/** Only this one may auto-send, and only above the confidence floor. */
const AUTO_SEND_INTENT = 'happy';

/**
 * How sure the model must be before the only automated action fires.
 *
 * High on purpose. The cost of a wrong `happy` is a discount answering a
 * complaint; the cost of a wrong `needsHuman` is somebody reading a message
 * they did not need to.
 */
const AUTO_SEND_CONFIDENCE = 0.85;

/** Suggestion rows this module writes, so the inbox can find them. */
const SUGGESTION_TYPE = 'reply_draft';

const SYSTEM_PROMPT = `You triage inbound SMS replies for a US e-commerce store.

The customer was asked "how did it go?" about a recent order and has replied.
Classify their reply and, unless they are simply happy, draft a short reply for
a human to review.

Return ONLY a JSON object, no markdown, no backticks:
{
  "intent": "happy" | "problem" | "question" | "buying_signal" | "opt_out_intent" | "unclear",
  "confidence": 0.0 to 1.0,
  "summary": "one short sentence for the person who will read this",
  "draft_reply": "a reply for a human to send, or null if none is needed"
}

RULES FOR draft_reply, and they are absolute:
- Never name a compound or a drug. Never say retatrutide, tirzepatide,
  semaglutide, GLP-1 or any brand of those. The shop calls its products RT, TZ
  and SM and you must do the same.
- Never give health, dosing or medical advice, and never suggest human use.
- Never promise a refund, a replacement, a delivery date or a discount. Say
  that somebody will sort it out.
- Never invent an order number, a tracking number, a price or a date.
- Plain sentences. No emoji, no exclamation marks, no capitals except STOP.
- Under 140 characters, because an opt-out line is added afterwards.
- If the reply is simply positive and needs nothing, set draft_reply to null.`;

/** The keyword fallback, used only when the model cannot be reached. */
const OBVIOUSLY_UNHAPPY = Object.freeze([
  'broken', 'damaged', 'leaking', 'leaked', 'melted', 'refund', 'money back',
  'never arrived', 'not arrived', "didn't arrive", 'didnt arrive', 'missing',
  'wrong item', 'wrong order', 'terrible', 'awful', 'scam', 'fake', 'reaction',
  'unwell', 'sick', 'rash', 'hospital', 'doctor', 'lawyer', 'chargeback',
  'complaint', 'not happy', 'disappointed', 'stop sending', 'not interested'
]);

function looksObviouslyUnhappy(text) {
  const lower = String(text || '').toLowerCase();
  return OBVIOUSLY_UNHAPPY.some(marker => lower.includes(marker));
}

/** The model answers with JSON, sometimes wrapped. Take the object or nothing. */
function parseVerdict(content) {
  const text = String(content || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!INTENTS.includes(parsed?.intent)) return null;
    const confidence = Number(parsed.confidence);
    return {
      intent: parsed.intent,
      confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0,
      summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 300) : '',
      draftReply: typeof parsed.draft_reply === 'string' && parsed.draft_reply.trim()
        ? parsed.draft_reply.trim()
        : null
    };
  } catch {
    return null;
  }
}

/**
 * A drafted reply, finished and checked, or null.
 *
 * The opt-out suffix is appended here rather than asked of the model, because
 * it must be EXACT and a model that paraphrases it produces copy the validator
 * refuses for a reason nobody reading the draft would understand.
 */
function finishDraft(draftReply, brandName = RULES.brand.defaultName) {
  if (!draftReply) return null;
  const body = draftReply.replace(/\s+/g, ' ').trim();
  if (!body) return null;

  const prefixed = body.startsWith(brandName) || body.startsWith(`It's ${brandName}`)
    ? body
    : `It's ${brandName}. ${body}`;
  const text = prefixed.endsWith(RULES.optOut.exactSuffix)
    ? prefixed
    : `${prefixed} ${RULES.optOut.exactSuffix}`;

  const verdict = validateCopy(text, {
    brandName,
    approvedProductCodes: RULES.defaultApprovedProductCodes
  });
  // Dropped rather than shown. A suggestion a human cannot send is worse than
  // no suggestion: they read it, tap send, and get an error they did not cause.
  if (!verdict.ok) {
    return { rejected: true, failedChecks: (verdict.failures || []).map(f => f.check) };
  }
  return { text };
}

/**
 * Triage one reply.
 *
 * Returns what should happen, never does it. The caller decides, which keeps
 * the auto-send decision in one readable place rather than buried behind a
 * model call.
 */
async function triageReply({
  text,
  now = new Date(),
  completion = privateCompletion,
  env = process.env
}) {
  const body = String(text || '').trim();
  if (!body) return { intent: 'unclear', confidence: 0, needsHuman: true, autoSendCode: false, reason: 'empty_reply' };

  let verdict = null;
  try {
    const result = await completion({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: body }
      ],
      maxTokens: 300,
      temperature: 0,
      timeoutMs: 8000,
      title: 'Vici reply triage',
      env
    });
    verdict = parseVerdict(result?.content);
  } catch {
    verdict = null;
  }

  if (!verdict) {
    // The model is unavailable or answered with nonsense. Everything goes to a
    // human, and the keyword list decides only one thing: whether this is
    // obviously a complaint, so an outage cannot turn one into a coupon.
    return {
      intent: 'unclear',
      confidence: 0,
      needsHuman: true,
      autoSendCode: false,
      obviouslyUnhappy: looksObviouslyUnhappy(body),
      reason: 'triage_unavailable',
      triagedAt: now.toISOString()
    };
  }

  // Belt and braces: the keyword list can veto a `happy` the model got wrong,
  // but can never create one. Wrong in the safe direction only.
  const unhappy = looksObviouslyUnhappy(body);
  const autoSendCode = verdict.intent === AUTO_SEND_INTENT
    && verdict.confidence >= AUTO_SEND_CONFIDENCE
    && !unhappy;

  const draft = verdict.intent === AUTO_SEND_INTENT ? null : finishDraft(verdict.draftReply);

  return {
    intent: verdict.intent,
    confidence: verdict.confidence,
    summary: verdict.summary,
    autoSendCode,
    needsHuman: !autoSendCode,
    obviouslyUnhappy: unhappy,
    draftReply: draft?.text || null,
    draftRejected: draft?.rejected === true,
    draftFailedChecks: draft?.failedChecks || null,
    triagedAt: now.toISOString()
  };
}

/**
 * Record a triaged reply for a human to act on.
 *
 * Reuses `sms_campaign_suggestions` rather than adding a table: the shape is
 * already contact + type + text + suggested message + status, the lifecycle is
 * already pending-then-sent-or-dismissed, and the send route already validates
 * copy before sending. A parallel table would be a second answer to "what
 * should we say to this person".
 */
async function recordForHuman({ client, phone, replyText, triage }) {
  const summary = triage.summary
    || (triage.reason === 'triage_unavailable'
      ? 'Automatic triage was unavailable, so this reply has not been read.'
      : 'This reply needs a person.');

  const { data, error } = await client.from('sms_campaign_suggestions').insert({
    contact_phone: phone,
    suggestion_type: SUGGESTION_TYPE,
    suggestion_text: `${triage.intent}${triage.obviouslyUnhappy ? ' (reads as a complaint)' : ''}: ${summary}`,
    suggested_message: triage.draftReply,
    status: 'pending'
  }).select('id').maybeSingle();

  if (error) return { recorded: false, error: error.message };
  return { recorded: true, id: data?.id || null, hasDraft: Boolean(triage.draftReply) };
}

module.exports = {
  AUTO_SEND_CONFIDENCE,
  AUTO_SEND_INTENT,
  INTENTS,
  OBVIOUSLY_UNHAPPY,
  SUGGESTION_TYPE,
  SYSTEM_PROMPT,
  finishDraft,
  looksObviouslyUnhappy,
  parseVerdict,
  recordForHuman,
  triageReply
};
