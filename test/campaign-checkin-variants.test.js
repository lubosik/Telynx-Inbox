'use strict';
/**
 * test/campaign-checkin-variants.test.js — the check-in variant bank, and the
 * two promises it has to keep.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PROMISE ONE: NOBODY GETS THE SAME WORDING TWICE
 *
 *   Until this bank existed, every person in an automatic check-in
 *   received the identical sentence, every week, forever. The no-repeat rule
 *   is the whole point of Phase 2, so it is tested as an exhaustive property
 *   over every profile shape crossed with every possible previous variant
 *   rather than on one happy path.
 *
 * PROMISE TWO: CONTEXT SHAPES SELECTION, AND IS NEVER QUOTED
 *
 *   lib/campaigns/check-in.js commits in its header to never implying anybody
 *   has been watching the customer, and the owner chose to keep that over the
 *   extra conversion that "you mentioned last month..." would buy. This is the
 *   first place in the system that holds a rich profile AND writes copy, so it
 *   is the place that promise breaks if it is going to. The scan below is
 *   deliberately structural — no digits at all, only two merge fields, an
 *   explicit phrase blacklist — because a reviewer reading six nice messages
 *   will not catch the seventh one somebody adds in six months.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY WORST-CASE VALIDATION IS ITS OWN SECTION
 *
 *   A template that fits with "Ana" and breaks with "Konstantinos" is a
 *   template that silently drops people at send time: render-recipients.js
 *   validates the RENDERED text per person and excludes anybody whose message
 *   fails. Validating the template as written proves nothing about the people
 *   with the longest names, who are exactly the ones it breaks for. Every
 *   variant is therefore checked three ways: as written, at symbolic worst
 *   case via `worstCase`, and as a real rendered message for a 12-character
 *   first name beside the 16-character product label.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ANGLES, ANGLE_PREFERENCE, VARIANTS, VARIANT_KEYS,
  approvedProductLabelFor, candidateKeysFor, engagementTierFor,
  selectCheckInVariant, selectionBasisFor
} = require('../lib/campaigns/checkin-variants');
const { validateCopy, septetLength } = require('../lib/campaigns/copy-validator');
const { RULES } = require('../lib/campaigns/copy-rules');
const { fieldsUsed, render, worstCase } = require('../lib/campaigns/merge-fields');
const { RECIPES } = require('../lib/campaigns/recipes');

/**
 * The longest first name the merge field permits is 12 characters and the
 * longest approved product label is 16 ("BPC-157 + TB-500"). Together they are
 * the most expensive person in the audience, and every variant has to survive
 * being sent to them.
 */
const WORST_CASE_FACTS = Object.freeze({
  contactName: 'Konstantinos Papadopoulos',
  lastProductName: 'BPC-157 + TB-500'
});

/**
 * Profiles covering every branch the selector has, plus the sparse shapes a
 * partially built profile actually produces. A profile row is written by
 * another workstream and any column may be null, so "null" is a real input
 * here rather than a defensive afterthought.
 */
const PROFILE_SHAPES = Object.freeze({
  first_time_with_product: {
    order_count: 1, engagement_tier: 'silent', has_replied_ever: false,
    last_product_name: 'BPC-157', last_product_sku: 'BC10'
  },
  first_time_no_product: {
    order_count: 1, engagement_tier: 'flicker', has_replied_ever: true,
    last_product_name: 'Retatrutide - 20mg', last_product_sku: 'P-RT10'
  },
  repeat_talker: {
    order_count: 4, engagement_tier: 'talker', has_replied_ever: true,
    last_product_name: 'Melanotan II', last_product_sku: 'MT1'
  },
  repeat_regular_no_product: {
    order_count: 9, engagement_tier: 'regular', has_replied_ever: true,
    last_product_name: null, last_product_sku: null
  },
  repeat_silent: {
    order_count: 3, engagement_tier: 'silent', has_replied_ever: false,
    last_product_name: 'TB-500', last_product_sku: 'BT10'
  },
  repeat_flicker_no_product: {
    order_count: 2, engagement_tier: 'flicker', has_replied_ever: true,
    last_product_name: null, last_product_sku: null
  },
  entirely_sparse: {},
  null_everywhere: {
    order_count: null, engagement_tier: null, has_replied_ever: null,
    last_product_name: null, last_product_sku: null, last_checkin_variant: null
  }
});

const EVERY_PROFILE = Object.entries(PROFILE_SHAPES);

// ── The bank itself ────────────────────────────────────────────────────────

test('the bank holds at least four variants and every key matches its entry', () => {
  // This asserted five, and it did its job: removing the `arrived_ok` angle
  // failed here first, which is exactly the "notice that you are shrinking the
  // no-repeat headroom" the original comment asked for. The headroom was
  // shrunk deliberately — the shop owner asked for the yes-or-no question to
  // stop going out — so the number is restated at the new floor rather than
  // deleted. Two angles in a named and a plain form is four.
  assert.ok(VARIANT_KEYS.length >= 4, `expected 4 or more variants, found ${VARIANT_KEYS.length}`);
  for (const key of VARIANT_KEYS) {
    assert.equal(VARIANTS[key].key, key, 'a variant whose key disagrees with its map entry would be selected under one name and recorded under another');
  }
});

test('every variant starts with the customer and asks a direct question', () => {
  for (const key of VARIANT_KEYS) {
    const template = VARIANTS[key].template;
    assert.ok(template.startsWith('Hi {{first_name}}, it\'s Vin from Vici.'), key);
    assert.ok(template.includes('?'), `${key} must invite a reply`);
    assert.doesNotMatch(template, /I['’]m right here/i);
  }
});

for (const key of VARIANT_KEYS) {
  test(`${key} passes validateCopy exactly as written`, () => {
    // The floor. A variant that fails here could never be sent to anybody.
    const verdict = validateCopy(VARIANTS[key].template);
    assert.equal(verdict.ok, true, JSON.stringify(verdict.failures, null, 2));
  });

  test(`${key} passes validateCopy at worst-case merge expansion`, () => {
    // `validateCopy` runs `checkRenderedLength` internally, which measures
    // `worstCase(template)`. Asserting the number here as well means a failure
    // reports HOW far over it is rather than just that something failed, and
    // it pins the margin so a future edit that eats all the slack is visible.
    const expanded = worstCase(VARIANTS[key].template);
    const septets = septetLength(expanded);
    assert.ok(
      septets <= RULES.length.maxSeptets,
      `${key} expands to ${septets} septets, over the ${RULES.length.maxSeptets} cap`
    );
    const verdict = validateCopy(VARIANTS[key].template);
    assert.ok(
      !verdict.failedChecks.includes('length_within_one_segment'),
      JSON.stringify(verdict.failures, null, 2)
    );
  });

  test(`${key} renders and validates for the longest person in the audience`, () => {
    // The check that actually matters, because this is the string that reaches
    // a phone. A 12-character first name beside the 16-character product
    // label, run through the real renderer and validated as a finished
    // message with no variables left in it.
    const outcome = render(VARIANTS[key].template, WORST_CASE_FACTS);
    assert.deepEqual(outcome.missing, [], 'nothing may fall back for a fully populated person');
    const verdict = validateCopy(outcome.text);
    assert.equal(verdict.ok, true, `${outcome.text}\n${JSON.stringify(verdict.failures, null, 2)}`);
  });

  test(`${key} costs one SMS segment even at worst case`, () => {
    // Not a compliance rule, a cost one. The cap is 306 septets, two
    // concatenated segments, and every variant here fits 160. Recording it
    // means somebody who doubles the price of the daily batch does it on
    // purpose rather than by adding a clause.
    const septets = septetLength(worstCase(VARIANTS[key].template));
    assert.ok(
      septets <= RULES.length.septetsPerSingleSegment,
      `${key} is ${septets} septets at worst case, over one segment`
    );
  });

  test(`${key} ends in exactly the opt-out sentence`, () => {
    // 10DLC invariant. Checked separately from validateCopy so that a change
    // to the validator cannot quietly stop enforcing it here.
    assert.ok(
      VARIANTS[key].template.endsWith(RULES.optOut.exactSuffix),
      `${key} must end with "${RULES.optOut.exactSuffix}"`
    );
    // And nowhere else, so the message cannot end with the sentence twice.
    const occurrences = VARIANTS[key].template.split(RULES.optOut.exactSuffix).length - 1;
    assert.equal(occurrences, 1);
  });

  test(`${key} refuses to fake a greeting when the first name is missing`, () => {
    // The owner wants every check-in to start with the customer's name. A
    // missing name must therefore exclude the recipient rather than become
    // "Hi there" or a visibly broken mail merge.
    const nameless = render(VARIANTS[key].template, { lastProductName: 'BPC-157 + TB-500' });
    assert.ok(nameless.missing.includes('first_name'));
  });
}

// ── The policy: context shapes selection and is never quoted ───────────────

/**
 * Phrasings that would break the promise in check-in.js's header. Each one
 * either quotes something the customer said or narrates the shop observing
 * them. Written out here rather than described, so the assertion is mechanical.
 */
const FORBIDDEN_PHRASINGS = Object.freeze([
  'you mentioned', 'you said', 'you told', 'you asked',
  'last time you', 'i know you', 'i noticed', 'we noticed',
  'since you have ordered', "since you've ordered",
  'you usually', 'you normally', 'you always',
  'your second order', 'your third order', 'times now',
  'our records', 'your account', 'we have been', "we've been",
  'you are due', "you're due", 'as always', 'welcome back'
]);

test('no variant quotes anything the customer said or did back at them', () => {
  // The single most likely way this feature goes wrong, per PROFILES-PLAN.md.
  // The owner chose "context shapes selection and tone, never quoted" over
  // "reference what they said", and this is where that choice is enforced.
  for (const key of VARIANT_KEYS) {
    const lower = VARIANTS[key].template.toLowerCase();
    for (const phrase of FORBIDDEN_PHRASINGS) {
      assert.ok(!lower.includes(phrase), `${key} contains the forbidden phrasing "${phrase}"`);
    }
  }
});

test('no variant contains a digit anywhere', () => {
  // Structural, and stronger than a phrase list. An order count, a date, a
  // spend, a quantity or a rhythm all arrive as digits, so a bank with no
  // digits in it cannot be quoting any of them. It also removes the whole
  // character-substitution surface: a token mixing letters with digits is
  // itself a carrier violation under copy-rules.js.
  for (const key of VARIANT_KEYS) {
    assert.ok(!/\d/.test(VARIANTS[key].template), `${key} contains a digit`);
  }
});

test('only first_name and last_product are used, and nothing else exists to use', () => {
  // {{order_count}} would say "since you've ordered four times".
  // {{last_order_date}} would date the purchase. {{code}} would put an offer in
  // a message whose entire compliance footing is that it carries none: the
  // check-in registers under CUSTOMER_CARE precisely because it does not sell.
  // {{product_link}} would make it a shop-now message. All four are refused
  // here rather than left to a reviewer's eye.
  const allowed = new Set(['first_name', 'last_product']);
  for (const key of VARIANT_KEYS) {
    for (const field of fieldsUsed(VARIANTS[key].template)) {
      assert.ok(allowed.has(field), `${key} uses {{${field}}}, which this bank does not permit`);
    }
  }
});

test('named variants use the product field and plain ones never do', () => {
  // The split exists because {{last_product}} renders empty for any product
  // with no approved label, and an empty merge field excludes that recipient.
  // A "plain" variant that quietly used the field would drop exactly the
  // people it was written to rescue.
  for (const key of VARIANT_KEYS) {
    const uses = fieldsUsed(VARIANTS[key].template).includes('last_product');
    assert.equal(uses, VARIANTS[key].requiresProduct, `${key} disagrees with its requiresProduct flag`);
    assert.equal(key.startsWith('named_'), VARIANTS[key].requiresProduct, `${key} is named inconsistently with its flag`);
  }
});

test('the two incumbent messages survive into the bank byte-identical', () => {
  // This change adds five ways to be different; it does not retire the one
  // message that has already been reviewed, approved and sent. Asserting
  // equality against recipes.js means the shipped copy and the bank cannot
  // drift into two slightly different answers to "what does a check-in say".
  assert.equal(VARIANTS.named_how_it_went.template, RECIPES.checkin_21_day.copy.named);
  assert.equal(VARIANTS.plain_how_it_went.template, RECIPES.checkin_21_day.copy.plain);
});

// ── Selection ──────────────────────────────────────────────────────────────

test('every preference order is a full permutation of the angles', () => {
  // A basis that dropped an angle would shorten the candidate list, and the
  // no-repeat guarantee is exactly "the list is longer than one". This is the
  // invariant that keeps that true, checked at the source rather than
  // inferred from the six variants.
  for (const [basis, order] of Object.entries(ANGLE_PREFERENCE)) {
    assert.deepEqual([...order].sort(), [...ANGLES].sort(), `${basis} is not a permutation of the angles`);
  }
});

test('every profile shape yields at least two candidates, none duplicated', () => {
  // The structural reason a repeat is impossible. With two or more candidates
  // and only one excluded key, `find` always has something to return, so the
  // `|| candidates[0]` fallback in the selector stays unreachable.
  //
  // Two rather than three because an angle was removed. The guarantee holds,
  // but the margin is now exactly one: somebody with no resolvable product has
  // two messages available, so a third check-in must reuse one of them. That
  // is a real cost of dropping the angle and it is written down here so the
  // next person to touch this knows the floor is the floor.
  for (const [name, profile] of EVERY_PROFILE) {
    const candidates = candidateKeysFor(profile);
    assert.ok(candidates.length >= 2, `${name} produced only ${candidates.length} candidates`);
    assert.equal(new Set(candidates).size, candidates.length, `${name} produced a duplicate candidate`);
    for (const key of candidates) {
      assert.ok(VARIANTS[key], `${name} produced the unknown candidate "${key}"`);
    }
  }
  // Including the shapes that are not objects at all.
  assert.ok(candidateKeysFor(null).length >= 2);
  assert.ok(candidateKeysFor(undefined).length >= 2);
});

test('selection never returns the variant this person last received', () => {
  // The exhaustive form of the promise: every profile shape crossed with every
  // key the profile could be carrying. A happy-path test would pass while the
  // one combination that repeats sits in production for a year.
  for (const [name, profile] of EVERY_PROFILE) {
    for (const lastVariant of VARIANT_KEYS) {
      const chosen = selectCheckInVariant({ profile, lastVariant });
      assert.notEqual(chosen.key, lastVariant, `${name} re-issued ${lastVariant}`);
      assert.equal(chosen.template, VARIANTS[chosen.key].template);
    }
  }
});

test('selection is deterministic across repeated calls and equal profiles', () => {
  // No randomness anywhere: a reviewer has to be able to work out what
  // somebody will receive by reading the file, and a test cannot pin a coin
  // flip. Two structurally equal profiles must also agree, which rules out
  // anything keyed on object identity or insertion order.
  for (const [name, profile] of EVERY_PROFILE) {
    const first = selectCheckInVariant({ profile, lastVariant: null });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.deepEqual(selectCheckInVariant({ profile, lastVariant: null }), first, `${name} varied between calls`);
    }
    const clone = JSON.parse(JSON.stringify(profile));
    assert.deepEqual(selectCheckInVariant({ profile: clone, lastVariant: null }), first, `${name} varied for an equal profile`);
  }
});

test('selection does not depend on the clock', () => {
  // Nothing here reads a date, and this is how that stays true. A selector
  // that drifted with time would make the previous test pass and still send
  // somebody the same message next Tuesday.
  const profile = PROFILE_SHAPES.repeat_talker;
  const before = selectCheckInVariant({ profile, lastVariant: null });
  const realNow = Date.now;
  try {
    Date.now = () => 0;
    assert.deepEqual(selectCheckInVariant({ profile, lastVariant: null }), before);
  } finally {
    Date.now = realNow;
  }
});

test('a first-time buyer gets the concise journey question', () => {
  // A first order is a bigger fact about how to talk to somebody than their
  // engagement tier, so it wins outright. The question is broad and easy to
  // answer without pretending we know their goal.
  const profile = PROFILE_SHAPES.first_time_with_product;
  assert.equal(selectionBasisFor(profile), 'first_order');
  const chosen = selectCheckInVariant({ profile, lastVariant: null });
  assert.equal(chosen.key, 'named_journey');
  assert.equal(chosen.reason, 'first_order');
});

test('somebody who talks to us gets the open question', () => {
  // The open question earns the most useful reply from the people who
  // actually reply. Measured live, that is 148 contacts of 809.
  const profile = PROFILE_SHAPES.repeat_talker;
  assert.equal(selectionBasisFor(profile), 'conversational');
  assert.equal(selectCheckInVariant({ profile, lastVariant: null }).key, 'named_how_it_went');
});

test('a repeat buyer who has never replied gets the concise journey question', () => {
  // The lowest-friction open question goes first for a quiet repeat buyer. It
  // names the product when safe and never quotes their private history.
  const profile = PROFILE_SHAPES.repeat_silent;
  assert.equal(selectionBasisFor(profile), 'quiet');
  assert.equal(selectCheckInVariant({ profile, lastVariant: null }).key, 'named_journey');
});

test('one order is a first order and two orders is not', () => {
  // The boundary, tested explicitly. It decides which of two entirely
  // different preference orders applies, so an off-by-one here changes what
  // every repeat customer in the batch receives.
  assert.equal(selectionBasisFor({ order_count: 1, engagement_tier: 'regular' }), 'first_order');
  assert.equal(selectionBasisFor({ order_count: 2, engagement_tier: 'regular' }), 'conversational');
  // Zero should be unreachable in a check-in, which only goes to people who
  // ordered. If it happens, treating them as new is the harmless reading.
  assert.equal(selectionBasisFor({ order_count: 0 }), 'first_order');
});

test('an unknown order count is not treated as a first order', () => {
  // A sparse profile is missing evidence, not evidence of a first purchase.
  // Guessing "first order" would hand a ten-order regular the beginner's
  // message, which is the visible failure; the safe reading falls through to
  // the engagement tier instead.
  assert.equal(selectionBasisFor({ order_count: null, engagement_tier: 'regular' }), 'conversational');
  assert.equal(selectionBasisFor({ engagement_tier: 'silent' }), 'quiet');
  assert.equal(selectionBasisFor({ order_count: '1', engagement_tier: 'silent' }), 'quiet',
    'a string is not an integer, and coercing one would make "" behave like a first order');
  assert.equal(selectionBasisFor({ order_count: 2.5, engagement_tier: 'silent' }), 'quiet');
});

test('engagement tier falls back to has_replied_ever, and no further', () => {
  // A profile written before the tier column existed, or by a partial build,
  // still has to route somewhere sensible. `has_replied_ever` maps to flicker
  // rather than talker: knowing somebody replied once says nothing about
  // whether they replied five times, and claiming otherwise would give a
  // near-silent customer the open question.
  assert.equal(engagementTierFor({ engagement_tier: 'regular' }), 'regular');
  assert.equal(engagementTierFor({ engagement_tier: 'REGULAR' }), 'regular');
  assert.equal(engagementTierFor({ has_replied_ever: true }), 'flicker');
  assert.equal(engagementTierFor({ has_replied_ever: false }), 'silent');
  assert.equal(engagementTierFor({ engagement_tier: 'chatty', has_replied_ever: true }), 'flicker',
    'an unrecognised tier is not a tier');
  assert.equal(engagementTierFor(null), 'silent');
  assert.equal(engagementTierFor({}), 'silent');
});

// ── Product availability ───────────────────────────────────────────────────

test('a product with no approved label routes the person to plain copy only', () => {
  // {{last_product}} renders empty for anything the catalogue cannot name
  // safely, and an empty merge field excludes that recipient at send time.
  // Measured on the live win-back audience, that was 155 people of 376, so
  // this is 41% of a campaign rather than an edge case.
  const profile = PROFILE_SHAPES.repeat_regular_no_product;
  assert.equal(approvedProductLabelFor(profile), '');
  const candidates = candidateKeysFor(profile);
  assert.ok(candidates.every(key => key.startsWith('plain_')), candidates.join(', '));
  assert.equal(selectCheckInVariant({ profile, lastVariant: null }).reason, 'conversational+no_product');
});

test('an unapproved product NAME wins over an approved SKU, because the renderer says so', () => {
  // The trap this module exists to avoid. merge-fields renders
  // `lastProductName || lastProductSku` as ONE value, so a banned compound
  // name renders empty even though the SKU beside it is on the approved list.
  // If this module decided product availability for itself it would offer a
  // named variant, the field would render empty, and that person would be
  // silently dropped. Delegating to the field is what keeps one answer.
  const profile = PROFILE_SHAPES.first_time_no_product;
  assert.equal(profile.last_product_sku, 'P-RT10', 'the SKU is on the approved list');
  assert.equal(approvedProductLabelFor(profile), '', 'and it still must not be offered a named variant');
  assert.ok(candidateKeysFor(profile).every(key => key.startsWith('plain_')));
});

test('an approved product opens the named variants and keeps the plain ones behind them', () => {
  // Named first, because naming what somebody bought is the difference between
  // a message and a mail merge. Plain kept in the list rather than filtered
  // out, because that is what gives the no-repeat rule six places to go
  // instead of three.
  const candidates = candidateKeysFor(PROFILE_SHAPES.repeat_talker);
  assert.equal(candidates.length, 4);
  assert.deepEqual(candidates.slice(0, 2).map(k => k.startsWith('named_')), [true, true]);
  assert.deepEqual(candidates.slice(2).map(k => k.startsWith('plain_')), [true, true]);
});

test('a profile that is not an object at all still selects a sendable message', () => {
  // The builder is another workstream. A null profile, or one that failed to
  // load, must produce the safest generic message rather than throwing inside
  // a daily sweep that is midway through building a campaign.
  for (const profile of [null, undefined, {}, 0, 'nope']) {
    const chosen = selectCheckInVariant({ profile, lastVariant: null });
    assert.ok(VARIANT_KEYS.includes(chosen.key));
    assert.equal(validateCopy(chosen.template).ok, true);
    assert.ok(chosen.key.startsWith('plain_'), 'nothing is known about the product, so nothing may be named');
  }
  assert.ok(VARIANT_KEYS.includes(selectCheckInVariant().key), 'called with no arguments at all');
});

// ── lastVariant handling ───────────────────────────────────────────────────

test('the previous variant defaults to the column that records what was sent', () => {
  // The failure mode of not doing this is a caller forgetting one argument and
  // silently reissuing the same wording, which is the exact thing this phase
  // was built to stop. The column is the record of truth; the argument
  // overrides it.
  const profile = { ...PROFILE_SHAPES.repeat_talker, last_checkin_variant: 'named_how_it_went' };
  const chosen = selectCheckInVariant({ profile });
  assert.notEqual(chosen.key, 'named_how_it_went');
  assert.ok(chosen.reason.endsWith('avoided_last_variant'));
});

test('an explicit null means ignore what they had before', () => {
  // The opt-out, for a caller replaying a selection or building a preview.
  // Distinguishable from "argument omitted" because null is not undefined,
  // which is why the default is written as an undefined check rather than a
  // falsy one.
  const profile = { ...PROFILE_SHAPES.repeat_talker, last_checkin_variant: 'named_how_it_went' };
  assert.equal(selectCheckInVariant({ profile, lastVariant: null }).key, 'named_how_it_went');
});

test('an unrecognised previous variant excludes nothing', () => {
  // Historic sends predate this bank, so `last_checkin_variant` may hold a
  // legacy label or a key that has since been retired. Excluding on a name
  // nothing matches must be a no-op, not a shift down the list, or the whole
  // audience quietly moves to their second-choice message forever.
  const profile = PROFILE_SHAPES.repeat_talker;
  const baseline = selectCheckInVariant({ profile, lastVariant: null });
  for (const stale of ['named', 'plain', 'checkin_21d', '']) {
    const chosen = selectCheckInVariant({ profile, lastVariant: stale });
    assert.equal(chosen.key, baseline.key, `"${stale}" should not have displaced the first choice`);
    assert.equal(chosen.reason, baseline.reason);
  }
});

test('the reason names the basis, the product state and any repeat avoided', () => {
  // The reason is what a reviewer reads next to a grouped message on the
  // approval screen, and what an operator reads when asking why somebody got
  // this one. It is built from stable tokens so it can be asserted rather than
  // eyeballed.
  assert.equal(selectCheckInVariant({ profile: PROFILE_SHAPES.repeat_talker, lastVariant: null }).reason, 'conversational');
  assert.equal(selectCheckInVariant({ profile: PROFILE_SHAPES.first_time_no_product, lastVariant: null }).reason, 'first_order+no_product');
  assert.equal(
    selectCheckInVariant({ profile: PROFILE_SHAPES.repeat_silent, lastVariant: 'named_how_it_went' }).reason,
    'quiet+avoided_last_variant'
  );
  assert.equal(
    selectCheckInVariant({ profile: PROFILE_SHAPES.repeat_flicker_no_product, lastVariant: 'plain_how_it_went' }).reason,
    'quiet+no_product+avoided_last_variant'
  );

  // A RETIRED key is still stored against everybody who received one before
  // the angle was dropped, and `last_checkin_variant` is read straight out of
  // the database. Excluding a key that is no longer a candidate must be a
  // no-op rather than an error or an empty candidate list.
  const withRetired = selectCheckInVariant({
    profile: PROFILE_SHAPES.repeat_silent, lastVariant: 'named_arrived_ok'
  });
  assert.equal(withRetired.reason, 'quiet', 'a retired key excludes nothing, so nothing was avoided');
  assert.ok(VARIANT_KEYS.includes(withRetired.key), 'and a live variant is still chosen');
});

// ── The property that matters most ─────────────────────────────────────────

test('a person cycles through every message they are eligible for before any repeats', () => {
  // The lived version of the promise, and the reason the selector rotates
  // rather than taking the first non-matching candidate. Both satisfy "never
  // reissue the previous variant"; only rotation satisfies the definition of
  // done, which is "nobody receives wording they have received before".
  //
  // Taking the first non-matching candidate would alternate between the top
  // two messages forever, so somebody's third check-in would be word for word
  // their first. This asserts the stronger property directly: a full cycle
  // with no repeat in it.
  for (const [name, profile] of EVERY_PROFILE) {
    const candidates = candidateKeysFor(profile);
    let previous = null;
    const seen = [];
    for (let cycle = 0; cycle < candidates.length; cycle += 1) {
      const chosen = selectCheckInVariant({ profile, lastVariant: previous });
      assert.notEqual(chosen.key, previous, `${name} repeated at check-in ${cycle}`);
      seen.push(chosen.key);
      previous = chosen.key;
    }
    assert.equal(
      new Set(seen).size, candidates.length,
      `${name} received ${new Set(seen).size} distinct messages across ${candidates.length} check-ins: ${seen.join(', ')}`
    );
    // And then it comes back round to where it started, rather than sticking.
    assert.equal(selectCheckInVariant({ profile, lastVariant: previous }).key, seen[0], `${name} did not close the cycle`);
  }
});

test('the rotation advances exactly one place, so the order is auditable', () => {
  // Deliberately pinned rather than left as "some other variant". An operator
  // asking "why did this person get that one" has to be answerable from the
  // candidate list and the previous key alone, with no state anywhere.
  const profile = PROFILE_SHAPES.repeat_talker;
  const candidates = candidateKeysFor(profile);
  for (let index = 0; index < candidates.length; index += 1) {
    const expected = candidates[(index + 1) % candidates.length];
    assert.equal(selectCheckInVariant({ profile, lastVariant: candidates[index] }).key, expected);
  }
});

test('every message the selector can ever return is a compliant one', () => {
  // Belt and braces over the whole reachable surface. The per-variant tests
  // above validate the bank; this validates the SELECTOR, so a key that
  // resolved to an undefined template, or a template that arrived from
  // somewhere other than the bank, is caught here.
  for (const [, profile] of EVERY_PROFILE) {
    for (const lastVariant of [null, ...VARIANT_KEYS]) {
      const chosen = selectCheckInVariant({ profile, lastVariant });
      assert.equal(typeof chosen.template, 'string');
      assert.equal(validateCopy(chosen.template).ok, true, chosen.key);
      const rendered = render(chosen.template, WORST_CASE_FACTS);
      assert.deepEqual(rendered.missing, []);
      assert.equal(validateCopy(rendered.text).ok, true, rendered.text);
    }
  }
});
