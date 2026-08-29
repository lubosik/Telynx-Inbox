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
  'happy',          // affirmatively positive about the order
  'acknowledged',   // polite and non-committal, and genuinely ambiguous
  'problem',        // something is wrong: damage, delivery, a reaction
  'question',       // wants to know something
  'buying_signal',  // wants to order, or asks how to
  'opt_out_intent', // wants to be left alone, without texting STOP
  'unclear'         // the model could not tell
]);

/**
 * Only this one may auto-send, and only above the confidence floor.
 *
 * `acknowledged` exists precisely so it is NOT this. "All good thanks" is two
 * readings at once: the order was fine and they would happily buy again, or
 * they are politely declining and would like to be left alone. A model reads
 * that as positive and is confidently right about the words and possibly wrong
 * about the person, and confidence cannot fix an ambiguity that is genuinely
 * in the message.
 *
 * So a bare pleasantry gets a human and a draft, and only somebody who said
 * something affirmatively good about the order gets a discount automatically.
 */
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
  "intent": "happy" | "acknowledged" | "problem" | "question" | "buying_signal" | "opt_out_intent" | "unclear",
  "confidence": 0.0 to 1.0,
  "summary": "one short sentence for the person who will read this",
  "draft_reply": "a reply for a human to send, or null if none is needed"
}

TELLING happy FROM acknowledged, WHICH MATTERS MORE THAN ANYTHING ELSE HERE:
- "happy" means they said something affirmatively GOOD about the order. "It was
  great", "really pleased with it", "arrived fast and works well".
- "acknowledged" means polite and non-committal, and you cannot tell whether
  they are pleased or politely declining. "All good thanks", "ok", "fine",
  "yeah cheers", "no worries". These read as positive and often are not; "all
  good thanks" is as likely to mean "I am fine, leave it" as "it was good".
- When in doubt between the two, choose "acknowledged". Never stretch to
  "happy".

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

/**
 * A second, much narrower call: the one warm clause that opens the code message.
 *
 * ── WHY THE MODEL WRITES ONLY THIS, AND NOT THE WHOLE REPLY ─────────────────
 *
 * The fixed reply said "Glad to hear it" to everybody, which reads as a form
 * letter to somebody who just told you something specific. Making the whole
 * message generated would fix that and open a hole: the commercial sentence,
 * the code and the opt-out line are the parts that must never vary, and they
 * would be regenerated on every send.
 *
 * So the model writes the opening clause and nothing else. The system composes
 * the rest. The generated surface is one short sentence, the discount wording
 * is identical every time, and the whole thing is still validated.
 *
 * ── THE RULE THAT MATTERS MOST ─────────────────────────────────────────────
 *
 * NEVER AFFIRM WHAT THEY CLAIMED. A customer writing "lost 10lbs, amazing"
 * answered with "great to hear about the 10lbs" is the business endorsing a
 * health outcome from a research compound, which is the exact claim the FTC
 * guidance behind copy-rules.js is about. The validator will not catch it:
 * "great to hear" contains no banned term. Only the prompt can, so it says so
 * three ways, and there is a test that feeds it exactly that message.
 */
const ACKNOWLEDGEMENT_PROMPT = `Write ONE short clause thanking a customer for replying about their order.

You will be given what they said. Reply with ONLY the clause, no quotes, no
JSON, nothing else.

ABSOLUTE RULES:
- NEVER repeat, affirm, agree with or congratulate any result, effect, outcome
  or health change they mention. If they say something worked, or that they
  lost weight, or that they feel different, DO NOT acknowledge that specific
  thing. Thank them for getting back to you instead.
- Never mention a compound or drug name. Never give advice of any kind.
- Do not mention a discount, a code, an offer or a price. That is added after.
- Do not greet them by name and do not sign off. That is added too.
- No emoji, no exclamation marks, no capitals.
- Under 60 characters. Shorter is better.

WHAT YOU MAY BE WARM ABOUT: delivery, speed, packaging, the ordering itself,
or simply that they replied. Those are not claims about anybody's body and you
should use them when they are there, because a specific clause reads like a
person and a generic one reads like a form.

Good: "Glad it turned up quickly." / "Good to hear the packing held up."
Good: "Thanks for getting back to me."
Bad: "Great that you lost 10lbs." / "Glad it is working for you."
Bad: "Pleased it helped." / "Good to hear you feel better."`;

/**
 * A customer describing something that happened in their body.
 *
 * Not a complaint, and often the opposite: "my joints feel better", "lost
 * 10lbs", "so much more energy". It still goes to a person rather than
 * auto-answering with a discount.
 *
 * Two reasons. A business that answers an efficacy testimonial with money is
 * soliciting more of them, and for a research-compound seller a file of
 * customer-reported effects is exactly the evidence a regulator would read as
 * marketing for human use. And the mirror case, a customer reporting a bad
 * effect, is a safety signal that must never be handled by a template.
 *
 * The clause writer already refuses to affirm these. This decides they are not
 * automated at all.
 */
const BODILY_EFFECT_MARKERS = Object.freeze([
  'lost', 'lbs', 'pounds', 'kg', 'weight', 'appetite', 'energy', 'sleep',
  'joints', 'pain', 'sore', 'skin', 'hair', 'feel', 'feeling', 'felt',
  'stomach', 'nausea', 'headache', 'mood', 'muscle', 'strength', 'recovery',
  'bloating', 'cravings', 'works', 'working', 'worked'
]);

function mentionsBodilyEffect(text) {
  const lower = ` ${String(text || '').toLowerCase()} `;
  return BODILY_EFFECT_MARKERS.some(marker => lower.includes(` ${marker}`));
}

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
      bodilyEffect: mentionsBodilyEffect(body),
      reason: 'triage_unavailable',
      triagedAt: now.toISOString()
    };
  }

  // Belt and braces: the keyword list can veto a `happy` the model got wrong,
  // but can never create one. Wrong in the safe direction only.
  const unhappy = looksObviouslyUnhappy(body);
  const bodilyEffect = mentionsBodilyEffect(body);
  const autoSendCode = verdict.intent === AUTO_SEND_INTENT
    && verdict.confidence >= AUTO_SEND_CONFIDENCE
    && !unhappy
    && !bodilyEffect;

  // A happy reply normally needs no drafted answer, because the code message
  // IS the answer. But one held back for a bodily effect does: a person has to
  // reply to it and should not start from nothing.
  const draft = verdict.intent === AUTO_SEND_INTENT && !bodilyEffect && !unhappy
    ? null
    : finishDraft(verdict.draftReply);

  return {
    intent: verdict.intent,
    confidence: verdict.confidence,
    summary: verdict.summary,
    autoSendCode,
    needsHuman: !autoSendCode,
    obviouslyUnhappy: unhappy,
    bodilyEffect,
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

/**
 * The warm opening for the code message, or null to use the fixed one.
 *
 * Falls back rather than fails: an unreachable model, an over-long clause or
 * anything that smells like an endorsement means the customer gets the plain
 * reviewed wording, which is worse copy and perfectly safe.
 */
async function acknowledgementFor({
  text,
  completion = privateCompletion,
  env = process.env
}) {
  const body = String(text || '').trim();
  if (!body) return null;
  try {
    const result = await completion({
      messages: [
        { role: 'system', content: ACKNOWLEDGEMENT_PROMPT },
        { role: 'user', content: body }
      ],
      maxTokens: 40,
      temperature: 0.3,
      timeoutMs: 6000,
      title: 'Vici reply acknowledgement',
      env
    });
    const clause = String(result?.content || '')
      .replace(/[\r\n"'`]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // 60 leaves room: the fixed remainder of the code message is 72
    // characters and a coupon code is at most 16, so 160 - 72 - 16 = 72 is the
    // true ceiling. Sixty keeps a margin and keeps the clause a clause.
    if (!clause || clause.length > 60) return null;
    // It must be a plain clause. Anything with a code, a percentage, a link or
    // an opt-out line is the model reaching past what it was asked for.
    if (/%|http|STOP|\{\{|\d{2,}/.test(clause)) return null;
    return clause.endsWith('.') ? clause : `${clause}.`;
  } catch {
    return null;
  }
}

/**
 * Triage an inbound message that is NOT a reply to a check-in, and draft an
 * answer for a person.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT CANNOT SEND ANYTHING, AND THAT IS STRUCTURAL RATHER THAN A PROMISE
 *
 *   This function has no coupon client, no sendSMS, and no path to either. The
 *   discount lives entirely in handleCheckInReply, which requires a check-in
 *   the customer actually received in the last seven days before it will do
 *   anything at all.
 *
 *   That separation matters more than it looks. Widening triage to every
 *   inbound message means a stranger texting "all good thanks" out of nowhere
 *   gets read by the model; if the code path were shared, it would also get
 *   fifteen percent off. Keeping the two functions apart makes that
 *   impossible rather than merely unlikely.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT IT IS FOR
 *
 *   Nine inbound messages a day, and reading the real ones is sobering: "should
 *   I put 2 mL of", "can I text this number", "I had gotten KPV and GHKCU from
 *   another company". Those need a considered answer from a person, and the
 *   slow part is composing it, not sending it. So the model reads every one
 *   and leaves a draft beside it.
 *
 * WHAT IT SKIPS
 *
 *   A bare thanks. "Thank you!" is a quarter of the inbox by volume and needs
 *   no reply at all; drafting one would bury the messages that do behind a
 *   wall of suggestions nobody wants. Classified, recorded as needing nothing,
 *   and no draft written.
 */
async function draftReplyForInbound({
  client,
  phone,
  text,
  now = new Date(),
  triage: triageImpl = triageReply
}) {
  try {
    const verdict = await triageImpl({ text, now });

    // A pleasantry needs no answer. Recording a draft for every "thank you"
    // buries the messages that do need one.
    const needsNothing = verdict.intent === 'acknowledged' && !verdict.draftReply;
    if (needsNothing) return { drafted: false, intent: verdict.intent, reason: 'no_reply_needed' };

    // An opt-out is handled by the caller, which owns suppression. Drafting a
    // cheerful answer to somebody asking to be left alone is the wrong move.
    if (verdict.intent === 'opt_out_intent') {
      return { drafted: false, intent: verdict.intent, reason: 'opt_out_handled_elsewhere' };
    }

    const recorded = await recordForHuman({ client, phone, replyText: text, triage: verdict });
    return {
      drafted: Boolean(verdict.draftReply),
      recorded: recorded.recorded === true,
      intent: verdict.intent,
      bodilyEffect: verdict.bodilyEffect === true,
      obviouslyUnhappy: verdict.obviouslyUnhappy === true
    };
  } catch (error) {
    // Runs inside the inbound webhook. A failed draft must never become a
    // retried webhook or a lost customer message.
    return { drafted: false, reason: 'draft_failed', error: error.message };
  }
}

module.exports = {
  ACKNOWLEDGEMENT_PROMPT,
  draftReplyForInbound,
  BODILY_EFFECT_MARKERS,
  acknowledgementFor,
  mentionsBodilyEffect,
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
