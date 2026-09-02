'use strict';
/**
 * lib/profiles/narrative-writer.js — the half of a client profile that a query
 * cannot answer.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE RULE THAT MAKES THIS WORTH THE MONEY
 *
 *   The narrative may contain NOTHING a query could already return.
 *
 *   How many orders, how much they spent, what they bought, when they last
 *   bought, how often they buy, whether they have ever replied — every one of
 *   those is a column in this same row, computed exactly, refreshed on every
 *   webhook. A sentence restating any of them is a lossy copy of a number we
 *   already hold, produced at the cost of a model call, and it is worse than
 *   nothing because the next thing to read it will treat it as independent
 *   evidence. Two answers to one question is the recurring production fault in
 *   this repository; a paraphrase is the most expensive way to create one.
 *
 *   What is left is the part only prose holds: what they asked about, what was
 *   never resolved, how they write, what they seem to weigh when they choose.
 *   That is the entire remit.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THRESHOLD, AND WHY IT IS NOT LOWER
 *
 *   Measured on production: of 809 contacts with any SMS at all, 559 have
 *   NEVER sent an inbound message, 102 have sent exactly one, 89 have sent two
 *   to four, and 59 have sent five or more.
 *
 *   For the 559, the only text a model could read is our own outbound
 *   templates. It would summarise them fluently, in the second person, and
 *   produce a confident account of a conversation that did not happen. At one
 *   and two inbounds the corpus is "ok", "thanks", "how much" — real, but
 *   already fully captured by `has_replied_ever` and `engagement_tier`, and
 *   containing no question, no unresolved thread and no manner of speaking.
 *
 *   So: `inbound_message_count >= 3` (PROFILE_NARRATIVE_MIN_INBOUND), plus a
 *   second, deterministic substance gate — at least one inbound message that
 *   is an actual sentence rather than an acknowledgement. Three "yes"es clear
 *   the count and contain nothing; the substance gate is what stops us paying
 *   a model to discover that.
 *
 *   ── ORDER HISTORY DOES NOT EARN A NARRATIVE ON ITS OWN ───────────────────
 *
 *   The brief invited an argument for narrating a silent buyer with a strong
 *   purchase pattern. The answer is no, and it falls straight out of the rule
 *   above rather than out of caution: an order row is ENTIRELY queryable.
 *   SKUs, dates, totals, cadence, the lot — all of it is already a column, and
 *   several of those columns are more precise than any sentence about them.
 *   A narrative built only from orders could therefore contain nothing legal
 *   under the rule, which means it would contain nothing. There is no
 *   prose-only residue in a purchase; there is in a conversation. That is the
 *   whole distinction, and it is why the gate counts inbound messages and not
 *   orders.
 *
 *   Orders still reach the prompt — but only as a list of product codes, and
 *   only so the model can tell what "has mine shipped yet" refers to. They are
 *   context for reading the conversation, never subject matter.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO ASSERTIONS THAT THROW RATHER THAN STORE
 *
 *   (a) No identifier shapes. This text is PERSISTED and is meant to be fed
 *       back into later prompts, so a leaked phone number or order id is not
 *       one leak, it is a leak that compounds every time the profile is read.
 *
 *   (b) No customer-stated health outcome, ever, in either direction. This
 *       shop sells research peptides. A stored sentence saying somebody lost
 *       weight is a health claim sitting in a database waiting for somebody to
 *       paste it into a message, and `copy-rules.js` bans exactly that
 *       sentence on the way out. The marker list is `BODILY_EFFECT_MARKERS`
 *       from reply-triage.js — imported, not re-typed, because two lists of
 *       banned health words drift apart and the weaker one wins.
 *
 *   The same marker list is rendered INTO the prompt as banned vocabulary, so
 *   the generator and the checker are working from one list. That is the
 *   difference between an assertion that fires constantly and one that almost
 *   never does.
 *
 *   A failed assertion never shows the offending text — only the check ids,
 *   the same discipline copy-writer.js uses for a rejected draft. Printing the
 *   leak into a log is still storing the leak.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SOLE-WRITER RULE
 *
 *   This file owns the six `narrative_*` columns and nothing else. It does not
 *   touch a deterministic column and it does not touch the eleven legacy ones
 *   owned by intelligence.js. It UPDATEs, never upserts: an upsert on a
 *   contact with no profile row would create one carrying nothing but
 *   narrative fields and NOT NULL defaults, which reads downstream as a real
 *   silent zero-order customer. An update on a missing row changes nothing,
 *   which is the correct outcome.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT narrative_source_fingerprint MEANS
 *
 *   "The message snapshot this contact was last ASSESSED against" — not "last
 *   summarised". A contact who was read and found to have nothing worth
 *   storing gets the fingerprint, a null summary and confidence `none`, so the
 *   next sweep skips them for free instead of re-reading their messages
 *   forever. It is prefixed with NARRATIVE_VERSION, so changing the prompt,
 *   the threshold or the substance rule invalidates every fingerprint at once
 *   and everybody is reassessed. That is the same job profile_version does for
 *   the deterministic half, done without adding a seventh column.
 */

const { fetchAllRows } = require('../fetch-all-rows');
const { PROFILE_TABLE, readChunked } = require('./profile-builder');
const { PAID_STATUSES } = require('../campaigns/segment-facts');
const { BODILY_EFFECT_MARKERS, mentionsBodilyEffect } = require('../campaigns/reply-triage');
const { BUSINESS } = require('../campaigns/copy-craft');
const { createLlmRunner } = require('../llm-runner');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Bumped whenever the prompt, the enums, the threshold or the substance rule
 * change. It rides in the fingerprint rather than in a column of its own,
 * because the question it answers — "was this assessed under the current
 * rules?" — is the same question the fingerprint answers about the messages.
 */
// 2: the prompt now forbids naming the SUBJECT of a health question, not only
// asserting an outcome. Version 1 produced "asked about product effects
// (sleepiness)" — a health claim stored as if it were a conversation topic,
// which the marker list did not catch and no word list ever would. Bumping
// this reassesses everybody already written under the looser rule.
const NARRATIVE_VERSION = 2;

/** Hard ceiling on what is stored. The prompt asks for 320, leaving headroom. */
const NARRATIVE_MAX_CHARS = 400;
const NARRATIVE_TARGET_CHARS = 320;

/** Below this, a summary is not a summary. See NARRATIVE_EMPTY. */
const NARRATIVE_MIN_CHARS = 40;

const DEFAULT_MIN_INBOUND = 3;
const DEFAULT_COOLDOWN_DAYS = 7;

/** Newest N messages, oldest-first, each clipped. Bounds the prompt cost. */
const MAX_PROMPT_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 280;
const MAX_PROMPT_PRODUCTS = 6;

/**
 * A CLOSED vocabulary, not free text.
 *
 * Free-text topics become a taxonomy nobody owns: downstream code starts
 * branching on strings the model invented, and the strings drift release by
 * release. A closed list also means topics cannot leak — there is no path by
 * which a phone number becomes a topic — which is why the assertions below
 * only have to police the prose.
 *
 * These are conversation subjects, deliberately NOT product names. Which
 * products somebody bought is `top_skus`, exactly, already.
 */
const NARRATIVE_TOPICS = Object.freeze([
  'shipping', 'delivery_problem', 'order_status', 'payment_problem', 'pricing',
  'discount', 'product_choice', 'usage_question', 'stock_availability',
  'reorder_intent', 'account_details', 'complaint', 'praise', 'wants_to_stop',
  'other'
]);

/** How they write, not how they feel. A fixed enum so a segment can use it. */
const NARRATIVE_TONES = Object.freeze([
  'brief', 'warm', 'transactional', 'impatient', 'chatty', 'unclear'
]);

const NARRATIVE_CONFIDENCE = Object.freeze(['high', 'low', 'none']);

/** The six columns this file owns. Nothing outside it may write these. */
const NARRATIVE_COLUMNS = Object.freeze([
  'narrative_summary', 'narrative_topics', 'narrative_tone',
  'narrative_confidence', 'narrative_built_at', 'narrative_source_fingerprint'
]);

/**
 * Utterances that clear the inbound COUNT and carry no content.
 *
 * Taken from what the live corpus actually contains at one and two inbounds.
 * A contact whose every message is on this list has told us they engage —
 * which `engagement_tier` already records — and nothing else.
 */
const ACKNOWLEDGEMENTS = new Set([
  'ok', 'okay', 'k', 'kk', 'yes', 'yep', 'yeah', 'ya', 'no', 'nope', 'y', 'n',
  'thanks', 'thank you', 'thx', 'ty', 'cheers', 'sure', 'got it', 'gotcha',
  'received', 'cool', 'great', 'perfect', 'awesome', 'nice', 'good', 'done',
  'stop', 'unsubscribe', 'yes please', 'no thanks', 'will do', 'sounds good'
]);

/** A message shorter than this is an utterance, not a sentence. */
const SUBSTANTIVE_MIN_CHARS = 12;

class NarrativeWriterError extends Error {
  constructor(message, code, failedChecks) {
    super(message);
    this.name = 'NarrativeWriterError';
    this.code = code || 'NARRATIVE_FAILED';
    if (failedChecks) this.failedChecks = failedChecks;
  }
}

// ── Settings ───────────────────────────────────────────────────────────────

function flagOn(raw) {
  return String(raw ?? '') === 'true';
}

function positiveInt(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.trunc(value);
}

function narrativeSettings(env = process.env) {
  return {
    enabled: flagOn(env.PROFILE_NARRATIVE_ENABLED),
    minInbound: Math.max(1, positiveInt(env.PROFILE_NARRATIVE_MIN_INBOUND, DEFAULT_MIN_INBOUND)),
    cooldownDays: positiveInt(env.PROFILE_NARRATIVE_COOLDOWN_DAYS, DEFAULT_COOLDOWN_DAYS)
  };
}

// ── Pure helpers ───────────────────────────────────────────────────────────

function normalise(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function isInbound(message) {
  return String(message?.direction || '').toLowerCase() === 'inbound';
}

/**
 * Does this message contain a sentence, or is it an utterance?
 *
 * Both halves matter. The acknowledgement list catches "thanks", which is long
 * enough to pass a length test; the length test catches "k thx" and "ok cool",
 * which no list will ever be long enough to enumerate.
 */
function isSubstantive(body) {
  const text = normalise(body).toLowerCase().replace(/[.!?,]+$/g, '');
  if (!text) return false;
  if (ACKNOWLEDGEMENTS.has(text)) return false;
  return text.length >= SUBSTANTIVE_MIN_CHARS;
}

function substantiveInboundCount(messages = []) {
  let count = 0;
  for (const message of messages) {
    if (isInbound(message) && isSubstantive(message.body)) count += 1;
  }
  return count;
}

/**
 * `n<version>:<the deterministic builder's messages fingerprint>`.
 *
 * The fingerprint VALUE has one owner — profile-builder.js, which recomputes
 * it on every order webhook and every inbound SMS. This file records which of
 * those snapshots it assessed rather than computing a second answer to "have
 * this contact's messages changed", because two answers to that question is
 * how a narrative ends up permanently stale or permanently rebuilding.
 */
function narrativeFingerprint(messagesFingerprint) {
  return `n${NARRATIVE_VERSION}:${messagesFingerprint || ''}`;
}

// ── The gate ───────────────────────────────────────────────────────────────

/**
 * Should this contact's narrative be rebuilt? Decided entirely from the
 * profile row, so the 80% who fail cost no message read and no model call.
 *
 * @returns {{ build: boolean, reason: string }}
 */
function narrativeGate({ profile, now = new Date(), env = process.env } = {}) {
  const settings = narrativeSettings(env);
  if (!settings.enabled) return { build: false, reason: 'disabled' };
  if (!profile) return { build: false, reason: 'no_profile' };

  // A profile the deterministic builder has never touched carries NOT NULL
  // defaults — zero orders, zero inbound, tier `silent` — which are
  // indistinguishable from a real silent customer. `deterministic_built_at` is
  // the only discriminator, and the migration's partial indexes rely on the
  // same fact.
  if (!profile.deterministic_built_at || !profile.messages_fingerprint) {
    return { build: false, reason: 'not_built' };
  }

  const inbound = Number(profile.inbound_message_count) || 0;
  if (inbound < settings.minInbound) return { build: false, reason: 'below_threshold' };

  const fingerprint = narrativeFingerprint(profile.messages_fingerprint);
  if (profile.narrative_source_fingerprint === fingerprint) {
    return { build: false, reason: 'unchanged' };
  }

  // ── A VERSION BUMP OUTRANKS THE COOLDOWN ────────────────────────────────
  //
  // The cooldown answers "has enough time passed to be worth spending again on
  // the same rules". A version bump means the rules themselves changed, so the
  // question it is guarding is no longer the one being asked.
  //
  // Found the hard way: version 1 stored "asked about product effects
  // (sleepiness)", a health claim recorded as a conversation topic. The prompt
  // was corrected and the version bumped, and nothing rebuilt — the cooldown
  // held every one of them for seven days. A safety fix that cannot be applied
  // for a week is not a fix, and the rows carrying the problem are exactly the
  // ones a cooldown would protect longest.
  const storedVersion = String(profile.narrative_source_fingerprint || '').split(':')[0];
  const rulesChanged = storedVersion !== `n${NARRATIVE_VERSION}`;

  const builtAt = Date.parse(profile.narrative_built_at);
  if (!rulesChanged && Number.isFinite(builtAt)) {
    const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
    if (Number.isFinite(nowMs) && nowMs - builtAt < settings.cooldownDays * DAY_MS) {
      return { build: false, reason: 'cooldown' };
    }
  }

  return { build: true, reason: 'eligible' };
}

// ── The prompt ─────────────────────────────────────────────────────────────

/**
 * The banned health vocabulary, rendered from the SAME list the assertion
 * checks. Telling the model what the checker will reject is the difference
 * between a guard that fires on most calls and one that almost never does.
 */
const BANNED_WORDS_LINE = [...BODILY_EFFECT_MARKERS].join(', ');

const SYSTEM_PROMPT = [
  'You are reading one customer\'s text messages with a small shop and writing a short',
  'private note for the shop\'s own staff. The note is never shown to the customer, never',
  'sent to anybody, and never quoted back at them.',
  '',
  `THE SHOP: ${BUSINESS.name}, ${BUSINESS.what}.`,
  `WHO THIS CUSTOMER IS: one of ${BUSINESS.customers}.`,
  '',
  'WHAT YOU HAVE, AND WHAT YOU DO NOT',
  'You have this customer\'s inbound messages and the shop\'s outbound messages, oldest',
  'first. You have a short list of product codes they have bought, given ONLY so you can',
  'tell what a message like "has mine shipped" is about.',
  'You do NOT have their name, phone number, email, address, order numbers, order dates,',
  'what they spent, or how many orders they placed. Do not guess at any of it and do not',
  'refer to it.',
  '',
  'THE RULE THAT DECIDES WHETHER THIS NOTE IS WORTH ANYTHING',
  'Everything countable is already stored exactly, in database columns: order count, spend,',
  'products, dates, how often they buy, whether they have ever replied. A note repeating any',
  'of those is a worse copy of a number the shop can already read, and it will be trusted as',
  'if it were new evidence. Write ONLY what a column cannot hold:',
  '  - what they actually asked about',
  '  - what was left unanswered or unresolved',
  '  - how they write: short or talkative, formal or casual, patient or impatient',
  '  - what they appear to weigh when they choose',
  '',
  'NEVER WRITE',
  '  - any phone number, email address, street address, or order number',
  '  - any number of four digits or more, including a year',
  '  - the customer\'s name, even if they signed a message with it',
  '  - anything about the customer\'s body, health, symptoms, results or how a product',
  '    affected them, INCLUDING something they said themselves. Avoid these words entirely:',
  `    ${BANNED_WORDS_LINE}.`,
  '  - the SUBJECT of a health question, even when you are only recording that they asked.',
  '    "Asked how to use it" is fine. "Asked about product effects (sleepiness)" is not:',
  '    naming the effect stores the health claim just as surely as asserting it, and this',
  '    note is re-fed into later prompts, so it would be repeated by something that never',
  '    saw the original message. Record the KIND of question, never its subject.',
  '  - anything the customer did not actually say. If they barely said anything, say so and',
  '    set "material" to false. An invented conversation is the worst possible outcome here.',
  '',
  'ANSWER WITH ONE JSON OBJECT AND NOTHING ELSE',
  '{',
  '  "material": true or false — false when there is genuinely nothing a column does not',
  '               already hold, in which case leave "summary" empty,',
  `  "summary": plain prose, at most ${NARRATIVE_TARGET_CHARS} characters, no name, no numbers,`,
  '  "topics": up to three from this exact list, or an empty list:',
  `             ${NARRATIVE_TOPICS.join(', ')},`,
  `  "tone": exactly one of: ${NARRATIVE_TONES.join(', ')},`,
  '  "confidence": "high" only when they wrote enough for you to be sure, otherwise "low"',
  '}'
].join('\n');

/** Product codes only. No dates, no totals, no quantities, no order ids. */
function promptProducts(orders = []) {
  const codes = new Set();
  for (const order of orders) {
    if (!PAID_STATUSES.has(String(order?.status || '').toLowerCase())) continue;
    for (const item of order.items || []) {
      const sku = normalise(item?.sku).toUpperCase();
      if (sku) codes.add(sku);
      if (codes.size >= MAX_PROMPT_PRODUCTS) break;
    }
    if (codes.size >= MAX_PROMPT_PRODUCTS) break;
  }
  return [...codes];
}

/**
 * The transcript, oldest first, newest MAX_PROMPT_MESSAGES only.
 *
 * Truncated from the END of the list rather than the start: what somebody
 * asked last week is what is still unresolved, and a two-year-old exchange
 * about a delivery that arrived is not what this note is for.
 */
function promptTranscript(messages = []) {
  const ordered = [...messages]
    .filter(message => normalise(message?.body))
    .sort((a, b) => (Date.parse(a?.created_at) || 0) - (Date.parse(b?.created_at) || 0))
    .slice(-MAX_PROMPT_MESSAGES);

  return ordered.map(message => {
    const speaker = isInbound(message) ? 'Customer' : 'Shop';
    const body = normalise(message.body).slice(0, MAX_MESSAGE_CHARS);
    return `${speaker}: ${body}`;
  }).join('\n');
}

function buildNarrativeMessages({ messages = [], orders = [] } = {}) {
  const products = promptProducts(orders);
  const inbound = messages.filter(isInbound).length;
  const user = [
    products.length
      ? `Product codes this customer has bought (context only, never mention them): ${products.join(', ')}`
      : 'No product codes are available for this customer.',
    `The customer wrote ${inbound} of the messages below. The rest are the shop's.`,
    '',
    'Conversation, oldest first:',
    promptTranscript(messages)
  ].join('\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user }
  ];
}

// ── Parsing ────────────────────────────────────────────────────────────────

/**
 * The object, or null. Same shape of forgiveness as reply-triage's
 * parseVerdict: models wrap JSON in prose often enough that refusing the whole
 * answer over a code fence is a needless retry we are not allowed to make.
 */
function parseNarrative(content) {
  const text = String(content || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const topics = Array.isArray(parsed.topics)
    ? [...new Set(parsed.topics
      .map(topic => String(topic || '').trim().toLowerCase())
      // Anything outside the closed list is dropped rather than kept or
      // thrown over. A hallucinated topic is noise, not a leak, and losing
      // the whole narrative over one bad word would waste the call.
      .filter(topic => NARRATIVE_TOPICS.includes(topic)))].slice(0, 3)
    : [];

  const tone = NARRATIVE_TONES.includes(String(parsed.tone || '').toLowerCase())
    ? String(parsed.tone).toLowerCase()
    : 'unclear';

  return {
    material: parsed.material !== false,
    summary: normalise(parsed.summary),
    topics,
    tone,
    confidence: String(parsed.confidence || '').toLowerCase() === 'high' ? 'high' : 'low'
  };
}

// ── The two assertions ─────────────────────────────────────────────────────

/**
 * Identifier shapes.
 *
 * These are NOT the tokeniser's regexes from openrouter-private.js, and the
 * duplication is deliberate: that file decides what may LEAVE this process,
 * this one decides what may be STORED. They happen to look similar today and
 * they answer different questions — one of them is allowed to be conservative
 * about false positives and the other is not — so coupling them would mean a
 * change made for one reason silently altering the other.
 */
const IDENTIFIER_CHECKS = Object.freeze([
  // The boundary restores private tokens before returning, and throws if any
  // are unresolved. Checked again here because this file may be handed a
  // different completion function, and a stored `[[PRIVATE_3]]` is a pointer
  // to a value we promised not to keep.
  ['private_token', /\[\[PRIVATE_\d+\]\]/],
  ['email', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ['phone_number', /\+?\d[\d(). -]{6,}\d/],
  ['street_address', /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|boulevard|blvd|court|ct|way|place|pl)\b/i],
  // Order numbers, customer ids, years. Any run of four or more digits in a
  // note this short is either an identifier or a fact a column already holds
  // exactly, and neither belongs here. Product strengths ("10mg", "250") stay
  // under the bar.
  ['long_number', /\b\d{4,}\b/]
]);

/**
 * Throw rather than store.
 *
 * The message names the FAILED CHECKS and never the text. Logging the leak to
 * prove the leak happened is still writing the leak somewhere it is kept.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {string[]} [options.names] values that must not appear — the
 *   contact's name as `sms_contacts` holds it. Names are the one identifier
 *   with no recognisable shape, so the only way to catch one is to know it.
 */
function assertNarrativeSafe(text, { names = [] } = {}) {
  const value = String(text || '');
  const failed = [];

  for (const [check, pattern] of IDENTIFIER_CHECKS) {
    if (pattern.test(value)) failed.push(check);
  }

  const lower = value.toLowerCase();
  for (const name of names) {
    const candidate = normalise(name).toLowerCase();
    // Two characters is not a name, it is a substring of half the dictionary.
    if (candidate.length < 3) continue;
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`).test(lower)) { failed.push('customer_name'); break; }
  }

  // Assertion (b). The list is reply-triage's, imported rather than re-typed,
  // and the same list is in the prompt as banned vocabulary.
  if (mentionsBodilyEffect(value)) failed.push('health_claim');

  if (failed.length) {
    throw new NarrativeWriterError(
      `Narrative failed ${failed.length} safety check(s): ${failed.join(', ')}. Nothing was stored.`,
      'NARRATIVE_UNSAFE',
      failed
    );
  }
  return true;
}

// ── Composition ────────────────────────────────────────────────────────────

/**
 * The payload for a contact we assessed and found nothing worth storing.
 *
 * Not an absence of a write. Writing the fingerprint with a null summary and
 * confidence `none` is what stops the next sweep re-reading, re-prompting and
 * re-discovering the same nothing — repeatedly, forever, at full price.
 */
function noMaterialPayload({ messagesFingerprint, now }) {
  return {
    narrative_summary: null,
    narrative_topics: [],
    narrative_tone: null,
    narrative_confidence: 'none',
    narrative_built_at: new Date(now).toISOString(),
    narrative_source_fingerprint: narrativeFingerprint(messagesFingerprint)
  };
}

/**
 * One contact's narrative payload. Makes exactly one model call, or none.
 *
 * Throws on an unsafe or unusable result — never returns one, and never
 * partially stores one. The caller records the failure and moves on; the
 * contact keeps their old fingerprint, so the next run retries them. That
 * retry is deliberate for a SAFETY failure: a leak that silently marked itself
 * complete would be invisible.
 *
 * @param {object}   input
 * @param {object}   input.profile   the deterministic profile row
 * @param {Array}    input.messages  every sms_messages row for this contact
 * @param {Array}    input.orders    every sms_orders row for this contact
 * @param {string[]} [input.names]   names to assert out of the result
 * @param {function} input.run       an llm-runner `run`. Required: there is no
 *                                   default, so nothing here can make an
 *                                   unbudgeted, unretried, unlimited call.
 */
async function composeNarrative({
  profile,
  messages = [],
  orders = [],
  names = [],
  run,
  now = new Date(),
  env = process.env
}) {
  if (typeof run !== 'function') {
    throw new NarrativeWriterError('composeNarrative needs an llm-runner run().', 'NARRATIVE_NO_RUNNER');
  }
  if (!profile?.contact_phone) {
    throw new NarrativeWriterError('composeNarrative needs a profile row.', 'NARRATIVE_NO_PROFILE');
  }

  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const fingerprint = profile.messages_fingerprint;

  // The substance gate, before any spend. Three "thanks" clear the count and
  // contain nothing; discovering that from a model costs a call and returns an
  // invented conversation about half the time.
  const substantive = substantiveInboundCount(messages);
  if (substantive < 1) {
    return {
      payload: noMaterialPayload({ messagesFingerprint: fingerprint, now: nowMs }),
      reason: 'no_material',
      called: false
    };
  }

  const result = await run({
    messages: buildNarrativeMessages({ messages, orders }),
    maxTokens: 400,
    temperature: 0.2,
    // Longer than the 10s default: this is a background sweep with real
    // transcripts in it, and a timeout here costs a retry rather than a page
    // load. The runner's abort-retry covers the rest.
    timeoutMs: 20_000,
    title: 'Vici client narrative',
    env
  });

  const parsed = parseNarrative(result?.content);
  if (!parsed) {
    // Deterministic: the same prompt produces the same unparseable answer, so
    // this must NOT be retried. The runner refuses to retry it for us; this
    // just makes the reason explicit at the call site.
    throw new NarrativeWriterError('The model did not answer with usable JSON.', 'NARRATIVE_UNPARSEABLE');
  }

  if (!parsed.material || parsed.summary.length < NARRATIVE_MIN_CHARS) {
    return {
      payload: noMaterialPayload({ messagesFingerprint: fingerprint, now: nowMs }),
      reason: parsed.material ? 'summary_too_thin' : 'no_material',
      called: true
    };
  }

  if (parsed.summary.length > NARRATIVE_MAX_CHARS) {
    // Rejected, not truncated. Cutting at 400 characters stores a sentence
    // that stops mid-clause, and a half-sentence about a customer is read as
    // if it were whole.
    throw new NarrativeWriterError(
      `The summary was ${parsed.summary.length} characters; the ceiling is ${NARRATIVE_MAX_CHARS}.`,
      'NARRATIVE_TOO_LONG'
    );
  }

  assertNarrativeSafe(parsed.summary, { names });

  return {
    payload: {
      narrative_summary: parsed.summary,
      narrative_topics: parsed.topics,
      narrative_tone: parsed.tone,
      // The model's own confidence is capped by the evidence. One sentence is
      // not enough to be sure about how somebody communicates, whatever the
      // model says, and `high` on a thin transcript is exactly the overclaim
      // that gets a narrative believed over a column.
      narrative_confidence: parsed.confidence === 'high' && substantive >= 2 ? 'high' : 'low',
      narrative_built_at: new Date(nowMs).toISOString(),
      narrative_source_fingerprint: narrativeFingerprint(fingerprint)
    },
    reason: 'written',
    called: true
  };
}

// ── Reads ──────────────────────────────────────────────────────────────────

/**
 * Candidate profile rows.
 *
 * `.gte()` on a single value, not `.in()` on a list, so there is no URL to
 * overflow — and paged through fetchAllRows, because 809 message-bearing
 * contacts is under the 1000-row silent cap today and the whole point of a
 * profile table is that it grows.
 */
async function narrativeCandidates({ client, phones = null, env = process.env }) {
  const columns = [
    'contact_phone', 'deterministic_built_at', 'messages_fingerprint',
    'inbound_message_count', ...NARRATIVE_COLUMNS
  ].join(', ');

  if (phones) {
    return readChunked(client, PROFILE_TABLE, columns, 'contact_phone',
      [...new Set(phones.filter(Boolean))], { orderBy: 'contact_phone', thenBy: null });
  }

  const { minInbound } = narrativeSettings(env);
  return fetchAllRows(client, PROFILE_TABLE, columns, {
    orderBy: 'contact_phone',
    ascending: true,
    thenBy: null,
    filter: query => query.gte('inbound_message_count', minInbound)
  });
}

function groupBy(rows, key) {
  const grouped = new Map();
  for (const row of rows || []) {
    const value = row?.[key];
    if (!value) continue;
    const held = grouped.get(value);
    if (held) held.push(row); else grouped.set(value, [row]);
  }
  return grouped;
}

/** Names, so the assertion can catch the one identifier with no shape. */
function namesFor(contact) {
  if (!contact) return [];
  return [contact.first_name, contact.last_name, contact.name]
    .map(value => normalise(value))
    .filter(value => value.length >= 3);
}

// ── Write ──────────────────────────────────────────────────────────────────

/**
 * UPDATE, never upsert. See the sole-writer note in the header: an upsert on a
 * contact with no profile row invents one that reads as a real silent
 * customer, and the engagement_tier index is built to serve exactly that
 * query.
 */
async function storeNarrative({ client, phone, payload }) {
  const { error } = await client
    .from(PROFILE_TABLE)
    .update(payload)
    .eq('contact_phone', phone);
  if (error) {
    const message = String(error.message || error);
    if (/does not exist|schema cache/i.test(message)) {
      throw new NarrativeWriterError(
        `${PROFILE_TABLE} is missing the narrative columns — run ` +
        `scripts/contact-profiles-narrative-migration.sql. (${message})`,
        'NARRATIVE_COLUMNS_MISSING'
      );
    }
    throw new NarrativeWriterError(message, 'NARRATIVE_WRITE_FAILED');
  }
}

/**
 * Run `worker` over `items`, at most `size` at a time.
 *
 * The runner's semaphore is the real limit on model calls; this exists so the
 * loop actually offers it more than one call at a time. A sequential loop
 * would make LLM_MAX_CONCURRENCY decorative.
 */
async function pool(items, size, worker) {
  const width = Math.max(1, Math.trunc(size) || 1);
  let cursor = 0;
  async function drain() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, drain));
}

// ── The entry point ────────────────────────────────────────────────────────

/**
 * Build narratives for the contacts that qualify.
 *
 * Resumable and idempotent: every contact who was assessed carries a
 * fingerprint, so a second run skips them without a read of their messages,
 * and a run that dies at contact 60 leaves 60 stored narratives the next run
 * does not pay for again.
 *
 * NOT WIRED TO ANYTHING. There is no interval, no webhook and no route calling
 * this; the caller that owns a schedule owns starting it.
 *
 * @param {object}   options
 * @param {object}   options.client
 * @param {string[]} [options.phones]     null means every eligible contact
 * @param {object}   [options.runner]     an llm-runner; one is created if absent
 * @param {number}   [options.limit]      stop after this many model calls
 * @param {number}   [options.batchSize]  contacts per read batch
 * @param {function} [options.onProgress]
 * @param {function} [options.shouldStop] return true to stop cleanly (SIGINT)
 * @param {boolean}  [options.dryRun]     gate only: no model call, no write
 */
async function refreshNarratives({
  client,
  phones = null,
  runner = null,
  now = new Date(),
  env = process.env,
  limit = null,
  batchSize = 100,
  onProgress = null,
  shouldStop = null,
  dryRun = false
} = {}) {
  if (!client) throw new NarrativeWriterError('refreshNarratives needs a Supabase client.', 'NARRATIVE_NO_CLIENT');

  const settings = narrativeSettings(env);
  const summary = {
    enabled: settings.enabled,
    considered: 0,
    eligible: 0,
    written: 0,
    noMaterial: 0,
    skipped: {},
    failed: [],
    stopped: false,
    reason: null,
    llm: null
  };

  const skip = (reason) => { summary.skipped[reason] = (summary.skipped[reason] || 0) + 1; };

  if (!settings.enabled) {
    summary.reason = 'disabled';
    return summary;
  }

  const candidates = await narrativeCandidates({ client, phones, env });
  summary.considered = candidates.length;

  const eligible = [];
  for (const profile of candidates) {
    const gate = narrativeGate({ profile, now, env });
    if (gate.build) eligible.push(profile); else skip(gate.reason);
  }
  summary.eligible = eligible.length;

  if (dryRun) {
    summary.reason = 'dry_run';
    return summary;
  }

  const llm = runner || createLlmRunner({ env, label: 'narrative' });
  const concurrency = llm.limits().concurrency;
  const size = Math.max(1, Math.trunc(batchSize) || 100);
  let calls = 0;

  for (let index = 0; index < eligible.length; index += size) {
    if (summary.stopped) break;
    if (typeof shouldStop === 'function' && shouldStop()) {
      summary.stopped = true;
      summary.reason = 'stopped';
      break;
    }

    const batch = eligible.slice(index, index + size);
    const batchPhones = batch.map(profile => profile.contact_phone);

    let messages;
    let orders;
    let contacts;
    try {
      [messages, orders, contacts] = await Promise.all([
        readChunked(client, 'sms_messages', 'contact_phone, direction, body, created_at',
          'contact_phone', batchPhones),
        readChunked(client, 'sms_orders', 'contact_phone, status, created_at, items',
          'contact_phone', batchPhones),
        readChunked(client, 'sms_contacts', 'phone, name, first_name, last_name',
          'phone', batchPhones, { orderBy: 'phone', thenBy: null })
      ]);
    } catch (error) {
      // One unreadable batch must not abandon the rest. No fingerprint was
      // written, so the next run retries this batch for free.
      summary.failed.push({ phone: `batch:${index}`, error: error.message });
      continue;
    }

    const messagesByPhone = groupBy(messages, 'contact_phone');
    const ordersByPhone = groupBy(orders, 'contact_phone');
    const contactByPhone = new Map((contacts || []).map(row => [row.phone, row]));

    await pool(batch, concurrency, async (profile) => {
      if (summary.stopped) return;
      if (limit !== null && calls >= limit) {
        summary.stopped = true;
        summary.reason = 'limit_reached';
        return;
      }

      const phone = profile.contact_phone;
      try {
        const outcome = await composeNarrative({
          profile,
          messages: messagesByPhone.get(phone) || [],
          orders: ordersByPhone.get(phone) || [],
          names: namesFor(contactByPhone.get(phone)),
          run: llm.run,
          now,
          env
        });
        if (outcome.called) calls += 1;

        await storeNarrative({ client, phone, payload: outcome.payload });
        if (outcome.payload.narrative_summary) summary.written += 1;
        else summary.noMaterial += 1;
      } catch (error) {
        // A spent budget means every remaining contact would fail the same
        // way. Stop the run cleanly rather than logging the same refusal a
        // hundred times and calling it a hundred failures.
        if (error?.code === 'LLM_RUN_BUDGET_EXHAUSTED' || error?.code === 'LLM_DAILY_BUDGET_EXHAUSTED') {
          summary.stopped = true;
          summary.reason = error.code === 'LLM_RUN_BUDGET_EXHAUSTED' ? 'run_budget_exhausted' : 'daily_budget_exhausted';
          return;
        }
        if (error?.code === 'LLM_KILL_SWITCH') {
          summary.stopped = true;
          summary.reason = 'kill_switch';
          return;
        }
        if (error?.code === 'NARRATIVE_COLUMNS_MISSING') {
          summary.stopped = true;
          summary.reason = 'columns_missing';
          summary.failed.push({ phone, error: error.message });
          return;
        }
        summary.failed.push({
          phone,
          error: error.message,
          code: error.code || null,
          // Check ids only. The rejected text is never carried out of here.
          ...(error.failedChecks ? { failedChecks: error.failedChecks } : {})
        });
      }
    });

    if (typeof onProgress === 'function') {
      onProgress({ ...summary, failed: summary.failed.length, llm: llm.stats() });
    }
  }

  summary.llm = llm.stats();
  if (!summary.reason) summary.reason = 'complete';
  return summary;
}

module.exports = {
  ACKNOWLEDGEMENTS,
  IDENTIFIER_CHECKS,
  MAX_MESSAGE_CHARS,
  MAX_PROMPT_MESSAGES,
  NARRATIVE_COLUMNS,
  NARRATIVE_CONFIDENCE,
  NARRATIVE_MAX_CHARS,
  NARRATIVE_MIN_CHARS,
  NARRATIVE_TONES,
  NARRATIVE_TOPICS,
  NARRATIVE_VERSION,
  NarrativeWriterError,
  SUBSTANTIVE_MIN_CHARS,
  SYSTEM_PROMPT,
  assertNarrativeSafe,
  buildNarrativeMessages,
  composeNarrative,
  isSubstantive,
  narrativeCandidates,
  narrativeFingerprint,
  narrativeGate,
  narrativeSettings,
  parseNarrative,
  refreshNarratives,
  storeNarrative,
  substantiveInboundCount
};
