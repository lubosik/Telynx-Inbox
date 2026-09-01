'use strict';
/**
 * lib/campaigns/checkin-variants.js — the bank of hand-written 21-day check-in
 * messages, and the rule that decides which one a given person receives.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE POLICY THIS FILE EXISTS TO ENFORCE
 *
 *   CONTEXT SHAPES SELECTION AND TONE. IT IS NEVER QUOTED BACK AT THE
 *   CUSTOMER.
 *
 *   lib/campaigns/check-in.js already commits to this in its header: the
 *   check-in "does not say the customer is due, does not reference a schedule,
 *   and does not imply anybody has been watching them", because for this
 *   catalogue the line between a shopkeeper who remembers you and a system
 *   that tracks you is worth more than the extra conversion a nudge would buy.
 *
 *   This file is where that promise is most at risk, because it is the first
 *   place in the system that holds a rich profile and writes copy. So the rule
 *   is spelled out as a property of the BANK rather than as an intention:
 *
 *     - No variant names an order count, a date, a spend, a rhythm, an SKU
 *       list, or anything a customer said to us.
 *     - The only merge fields any variant uses are {{first_name}} and
 *       {{last_product}}, and {{last_product}} renders the shop's own approved
 *       product label, which is a thing the customer chose off a shelf rather
 *       than a fact we observed about them.
 *     - Everything else the profile knows is spent on CHOOSING which of these
 *       messages to send and never on what the message says.
 *
 *   Concretely, none of these may ever appear here: "you mentioned", "last
 *   time you said", "I know you've been", "since you've ordered X times",
 *   "your third order", "you usually reorder around now". test/
 *   campaign-checkin-variants.test.js asserts the whole bank against that
 *   list, so a future variant cannot slip one in.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY SIX MESSAGES AND NOT ONE MODEL CALL
 *
 *   Measured on the live data, 69% of contacts with any SMS have never sent an
 *   inbound message. For those people a per-person generated check-in would
 *   have nothing to work from but first name, last product and days elapsed,
 *   all three of which are already merge fields. The model would restate the
 *   template in different words at the cost of one call, one compliance risk
 *   and one message a human has to read.
 *
 *   A bank of pre-approved variants fixes "generic" and "repeated" for 100% of
 *   the audience at zero marginal cost, and it ships without an LLM anywhere
 *   near the send path.
 *
 * WHY THE OPENER IS IDENTICAL ON EVERY VARIANT
 *
 *   Every message opens "It's Vin from Vici. Hi {{first_name}}," and not the
 *   win-back's "Hi {{first_name}}, it's Vin from Vici.".
 *
 *   Both pass checkBrandPrefix, but only the first passes UNCONDITIONALLY. The
 *   greeting-first shape relies on the greeting exception in the validator,
 *   which needs a comma between the greeting and the brand; if {{first_name}}
 *   renders empty, `tidy()` collapses "Hi ," to "Hi. " and the brand lands at
 *   character 9, past the six-character limit. The rendered message then fails
 *   brand_identifies_sender_first and that person is dropped.
 *
 *   render-recipients.js happens to drop them one step earlier, because a
 *   missing merge field already excludes a recipient. That is a property of
 *   the caller, not of this bank, and a bank whose compliance depends on what
 *   the caller does with it is a bank that breaks the first time somebody
 *   renders it somewhere else. Brand-first costs nothing and removes the
 *   coupling entirely.
 *
 * WHAT IS DELIBERATELY NOT A SELECTION INPUT
 *
 *   `reorder_interval_days`, `reorder_due_at` and `days_since_last_order` are
 *   on the profile and are not read here. A check-in fires 21 days after an
 *   order whatever somebody's rhythm is, so cadence could only change the
 *   WORDING, and wording that varies with how overdue somebody is is the first
 *   step towards "you are due" — which copy-rules.js bans outright as a dosing
 *   and treatment-continuity term.
 */

const { FIELDS } = require('./merge-fields');

/**
 * The three things a check-in can be, as separate ideas rather than as
 * synonyms of each other. copy-craft.js: "vary the candidates by APPROACH, not
 * by synonym. Three messages that differ only in whether they say hi or hey
 * are one message."
 *
 *   how_it_went  an open question. Costs the reader a sentence to answer, and
 *                gets the most useful reply from somebody who talks to us.
 *   arrived_ok   a closed question about the parcel. Answerable with one word,
 *                which is the lowest bar available, and it is a service
 *                question rather than an invitation to chat.
 *   open_door    no question at all. Says the shop is reachable and stops.
 *                For a first-time buyer who may not yet know what to ask, an
 *                unanswered question reads as pressure and an open door does
 *                not.
 */
const ANGLES = Object.freeze(['how_it_went', 'arrived_ok', 'open_door']);

/**
 * The bank.
 *
 * `named` variants use {{last_product}} and are only offered to somebody whose
 * last product has an approved label. `plain` variants are offered to
 * everybody, which is what guarantees the no-repeat rule always has somewhere
 * to go.
 *
 * `named_how_it_went` and `plain_how_it_went` are byte-identical to the copy
 * currently shipping in recipes.js. Keeping them means this change adds five
 * ways to be different rather than replacing the one message that has already
 * been reviewed and sent. A test asserts that equality so the two cannot
 * drift apart silently.
 */
const VARIANTS = Object.freeze({
  named_how_it_went: Object.freeze({
    key: 'named_how_it_went',
    angle: 'how_it_went',
    requiresProduct: true,
    description: 'Names what they bought and asks an open question. The incumbent copy.',
    template: 'It\'s Vin from Vici. Hi {{first_name}}, you picked up {{last_product}} a few '
      + 'weeks back. How did it go? Reply STOP to opt out.'
  }),

  plain_how_it_went: Object.freeze({
    key: 'plain_how_it_went',
    angle: 'how_it_went',
    requiresProduct: false,
    description: 'The open question without naming the product. The incumbent copy.',
    template: 'It\'s Vin from Vici. Hi {{first_name}}, you ordered from us a few weeks '
      + 'back. How did it go? Reply here any time. Reply STOP to opt out.'
  }),

  named_arrived_ok: Object.freeze({
    key: 'named_arrived_ok',
    angle: 'arrived_ok',
    requiresProduct: true,
    description: 'Asks only whether the parcel landed. One word answers it.',
    template: 'It\'s Vin from Vici. Hi {{first_name}}, making sure your {{last_product}} '
      + 'order reached you alright. A yes or no is plenty. Reply STOP to opt out.'
  }),

  plain_arrived_ok: Object.freeze({
    key: 'plain_arrived_ok',
    angle: 'arrived_ok',
    requiresProduct: false,
    description: 'The parcel question without naming the product.',
    template: 'It\'s Vin from Vici. Hi {{first_name}}, making sure the order you placed a few '
      + 'weeks back reached you alright. A yes or no is plenty. Reply STOP to opt out.'
  }),

  named_open_door: Object.freeze({
    key: 'named_open_door',
    angle: 'open_door',
    requiresProduct: true,
    description: 'Names the product, asks nothing, and says the shop is reachable.',
    // Trimmed to "Anything you want to ask" from a longer clause so that even
    // a 12-character name beside the 16-character product label lands inside
    // 160 septets, which is one segment rather than two. Every variant in this
    // bank costs one segment at its worst case; the cap is 306 and staying
    // well under it is a real saving across a weekly batch.
    template: 'It\'s Vin from Vici. Hi {{first_name}}, your {{last_product}} order went out a '
      + 'few weeks back. Anything you want to ask, I\'m right here. Reply STOP to opt out.'
  }),

  plain_open_door: Object.freeze({
    key: 'plain_open_door',
    angle: 'open_door',
    requiresProduct: false,
    description: 'Asks nothing and says the shop is reachable.',
    template: 'It\'s Vin from Vici. Hi {{first_name}}, your order went out a few weeks back. '
      + 'Anything you want to ask, I\'m right here. Reply STOP to opt out.'
  })
});

const VARIANT_KEYS = Object.freeze(Object.keys(VARIANTS));

/**
 * Which angle suits which kind of buyer, most-suitable first.
 *
 * The three bases are the only three things the contract permits selection to
 * turn on beyond product availability: first-time versus repeat buyer, and
 * engagement tier. There is no fourth ordering and no scoring function,
 * because a score is a coin flip a reviewer cannot audit.
 */
const ANGLE_PREFERENCE = Object.freeze({
  // Ordered once, in one place, and asserted to be a permutation of ANGLES by
  // a test. A basis that silently dropped an angle would shrink the candidate
  // list and make a repeat possible again.
  first_order: Object.freeze(['open_door', 'arrived_ok', 'how_it_went']),
  conversational: Object.freeze(['how_it_went', 'open_door', 'arrived_ok']),
  quiet: Object.freeze(['arrived_ok', 'how_it_went', 'open_door'])
});

/** Tiers whose owner has said enough that an open question is worth asking. */
const CONVERSATIONAL_TIERS = new Set(['talker', 'regular']);

/** The four tiers the contract defines. Anything else is not a tier. */
const KNOWN_TIERS = new Set(['silent', 'flicker', 'talker', 'regular']);

/**
 * The engagement tier to use, from a profile that may be missing it.
 *
 * `engagement_tier` is the stored answer and wins whenever it is one of the
 * four known values. `has_replied_ever` is only consulted when the tier is
 * absent or unrecognised, which happens for a profile written before this
 * column existed or by a partial build. It maps to `flicker` rather than
 * anything stronger: knowing somebody replied at least once says nothing about
 * whether they replied five times.
 */
function engagementTierFor(profile) {
  const stored = String(profile?.engagement_tier || '').toLowerCase();
  if (KNOWN_TIERS.has(stored)) return stored;
  return profile?.has_replied_ever === true ? 'flicker' : 'silent';
}

/**
 * Which of the three preference orders applies to this person.
 *
 * Order of precedence matters and is deliberate. A first-time buyer gets the
 * first-order treatment whatever their tier, because "you have bought from us
 * once and may not know what to ask" is a bigger fact about how to talk to
 * somebody than "you have sent us two messages".
 *
 * A null or non-integer `order_count` is NOT treated as a first order. An
 * unknown count is a sparse profile, not evidence of a first purchase, and
 * guessing would give a ten-order regular the beginner's message.
 */
function selectionBasisFor(profile) {
  const orderCount = Number.isInteger(profile?.order_count) ? profile.order_count : null;
  if (orderCount !== null && orderCount <= 1) return 'first_order';
  return CONVERSATIONAL_TIERS.has(engagementTierFor(profile)) ? 'conversational' : 'quiet';
}

/**
 * The approved product label for this person, or an empty string.
 *
 * Delegated to the merge field itself rather than reimplemented. This decides
 * whether a `named` variant is offered, and the renderer decides whether
 * {{last_product}} produces anything; if those two ever disagree, a named
 * variant is selected, renders empty, and that person is silently excluded at
 * send time. One function answers the question.
 *
 * Note the argument shape: the field renders `lastProductName || lastProductSku`
 * as a single value, so a product whose NAME is unapproved renders empty even
 * when its SKU would have been fine. Calling the field is what keeps this
 * module honest about that.
 */
function approvedProductLabelFor(profile) {
  try {
    return String(FIELDS.last_product.render({
      lastProductName: profile?.last_product_name,
      lastProductSku: profile?.last_product_sku
    }) || '');
  } catch {
    // A field that throws is a bug in merge-fields.js, but the correct
    // behaviour here is still "no product", which routes this person to copy
    // that does not need one rather than dropping them.
    return '';
  }
}

/**
 * Every variant this person could receive, best first.
 *
 * Named variants come before plain ones because naming what somebody bought is
 * the difference between a message and a mail merge. Plain variants stay in
 * the list behind them rather than being filtered out, and that is what makes
 * the no-repeat rule total: the plain family alone is three messages, so there
 * is always a second choice no matter what was sent last time.
 *
 * @param {object} profile
 * @returns {string[]} variant keys, length 3 or 6, never empty
 */
function candidateKeysFor(profile) {
  const order = ANGLE_PREFERENCE[selectionBasisFor(profile)];
  const hasProduct = approvedProductLabelFor(profile) !== '';
  const named = hasProduct
    ? order.map(angle => `named_${angle}`)
    : [];
  return [...named, ...order.map(angle => `plain_${angle}`)];
}

/**
 * Pick the check-in message for one person.
 *
 * ── IT ROTATES, RATHER THAN TAKING THE FIRST THING THAT IS NOT A REPEAT ────
 *
 *   Both satisfy the contract's stated rule, which is only "never return
 *   lastVariant when another eligible variant exists". Taking the first
 *   non-matching candidate satisfies it by alternating between the top two
 *   messages forever, so somebody's third check-in is word for word their
 *   first. The definition of done asks for more than that: "nobody receives
 *   wording they have received before."
 *
 *   Advancing one place past the previous variant instead means a person with
 *   a nameable product cycles through six different messages before any of
 *   them comes round again, and a person without one cycles through three.
 *   Since the check-in only fires three weeks after an order, six cycles is
 *   most of a year.
 *
 *   The cost is that the preference order stops being "the message this person
 *   always gets" and becomes "the message this person gets FIRST", which is
 *   the one that matters most and the only one chosen with no history to go
 *   on. After that, variety is worth more than a soft ranking between six
 *   messages that are all appropriate for everybody.
 *
 * Deterministic by construction: the candidate list is a pure function of the
 * profile, and the position within it is a pure function of `lastVariant`.
 * There is no randomness, no clock and no tie-break, so the same profile and
 * the same `lastVariant` always produce the same key. A reviewer can work out
 * what somebody will receive by reading this file, and a test can pin it.
 *
 * `lastVariant` defaults to `profile.last_checkin_variant`, which is the
 * column that records what this person was actually sent. Passing the argument
 * overrides it; passing an explicit `null` means "ignore what they had
 * before". The default exists because the failure mode of a caller forgetting
 * to pass it is a silent repeat, which is the exact thing this phase was built
 * to stop.
 *
 * @param {object}  options
 * @param {object}  options.profile      a profile row. Any field may be null.
 * @param {string}  [options.lastVariant] the key this person last received.
 * @returns {{key: string, template: string, reason: string}}
 */
function selectCheckInVariant({ profile, lastVariant } = {}) {
  const candidates = candidateKeysFor(profile);
  const previous = lastVariant === undefined
    ? (profile?.last_checkin_variant || null)
    : lastVariant;
  const previousKey = previous ? String(previous) : null;

  // -1 covers three real cases and treats them identically, which is correct:
  // a first-ever check-in, a legacy label from before this bank existed, and a
  // variant that was eligible last time but is not now because the profile
  // changed. None of them is a reason to skip the best-suited message.
  const previousIndex = candidates.indexOf(previousKey);
  const chosen = previousIndex === -1
    ? candidates[0]
    // The modulo returns `previousKey` itself only when the list holds exactly
    // one candidate, which cannot happen while the plain family has three
    // members. A test asserts that length rather than this branch, because the
    // invariant is what keeps it unreachable.
    : candidates[(previousIndex + 1) % candidates.length];

  const reason = [
    selectionBasisFor(profile),
    approvedProductLabelFor(profile) === '' ? 'no_product' : null,
    // Reported off the rotation and not off "did the key change", because the
    // last step of a full cycle rotates back to the first choice and that is
    // still the previous variant having moved us, not a fresh selection.
    previousIndex === -1 ? null : 'avoided_last_variant'
  ].filter(Boolean).join('+');

  return { key: chosen, template: VARIANTS[chosen].template, reason };
}

module.exports = {
  ANGLES,
  ANGLE_PREFERENCE,
  VARIANTS,
  VARIANT_KEYS,
  approvedProductLabelFor,
  candidateKeysFor,
  engagementTierFor,
  selectCheckInVariant,
  selectionBasisFor
};
