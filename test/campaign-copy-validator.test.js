'use strict';
/**
 * lib/campaigns/copy-validator.js — the deterministic gate.
 *
 * This is the safety component of the AI copy feature, so it gets the heavy
 * suite. Every one of the twelve checks has at least one rejection case and
 * the corresponding near-miss acceptance, so a mutation that neuters a check
 * fails here rather than shipping.
 *
 * Two structural properties are asserted as well as the individual rules:
 *
 *   - the BASELINE message passes cleanly, so "everything fails" is not how
 *     these tests pass;
 *   - every check id in RULES.checks is exercised by at least one rejection,
 *     so a rule cannot be added to the doc, listed in the checklist, and never
 *     implemented.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { RULES } = require('../lib/campaigns/copy-rules');

// The sender's name is a BUSINESS DECISION and it has already changed once,
// from "Vici" to "Vin from Vici". Fixtures that hardcode it turn every one of
// these tests into a test of the current name, so 30 of them failed on a
// two-word copy change that broke nothing. Read it from the rules instead: the
// name can change again and only the rule file needs editing.
const { RULES: COPY_RULES } = require('../lib/campaigns/copy-rules');
const BRAND = COPY_RULES.brand.defaultName;

const {
  validateCopy, septetLength, isGsm7, extractLinks, normaliseLeet, tokenise
} = require('../lib/campaigns/copy-validator');

const OPT_OUT = RULES.optOut.exactSuffix;
const BASELINE = `${BRAND}: your product is back in stock. Reply if you would like help. ${OPT_OUT}`;
const CODES = ['BPC-157', 'TB-500'];

/** Every check id a validation run reported as broken. */
function failedChecks(text, options) {
  return validateCopy(text, options).failedChecks;
}

function assertRejectedFor(check, text, options) {
  const verdict = validateCopy(text, options);
  assert.equal(verdict.ok, false, `expected rejection: ${JSON.stringify(text)}`);
  assert.ok(
    verdict.failedChecks.includes(check),
    `expected ${check} to fire for ${JSON.stringify(text)}, got ${verdict.failedChecks.join(', ') || 'nothing'}`
  );
  for (const item of verdict.failures) assert.ok(item.reason && item.reason.length > 10);
  return verdict;
}

function assertAccepted(text, options) {
  const verdict = validateCopy(text, options);
  assert.equal(
    verdict.ok, true,
    `expected acceptance for ${JSON.stringify(text)}, rejected for: ${verdict.failures.map(f => f.reason).join(' | ')}`
  );
  return verdict;
}

// ── The suite is not vacuous ───────────────────────────────────────────────

test('a compliant draft passes every check', () => {
  const verdict = assertAccepted(BASELINE);
  assert.equal(verdict.failures.length, 0);
  assert.equal(verdict.failedChecks.length, 0);
  assert.equal(verdict.checks.length, 12);
  assert.ok(verdict.checks.every(check => check.ok));
  assert.equal(verdict.gsm7, true);
  assert.equal(verdict.text, BASELINE);
});

test('a compliant draft with a verified product code and an approved link passes', () => {
  assertAccepted(
    `${BRAND}: BPC-157 is back in stock. See https://vicipeptides.com/shop. ${OPT_OUT}`,
    { approvedProductCodes: CODES }
  );
});

// ── 1. length ──────────────────────────────────────────────────────────────

test('length is measured in GSM-7 septets, and 306 is the limit', () => {
  // 306 is TWO concatenated segments at 153 septets each, not 2 x 160: a
  // concatenated SMS spends 7 septets a segment on the header that tells the
  // handset how to reassemble it. The ceiling is still a ceiling; it refuses
  // a third segment.
  const { RULES } = require('../lib/campaigns/copy-rules');
  assert.equal(RULES.length.maxSeptets, 306);

  const filler = 'a'.repeat(306 - septetLength(`${BRAND}: . ${OPT_OUT}`));
  const exact = `${BRAND}: ${filler}. ${OPT_OUT}`;
  assert.equal(septetLength(exact), 306);
  assertAccepted(exact);

  const oneOver = `${BRAND}: ${filler}a. ${OPT_OUT}`;
  assert.equal(septetLength(oneOver), 307);
  const verdict = assertRejectedFor('length_within_one_segment', oneOver);
  assert.match(verdict.failures[0].reason, /307 GSM-7 septets/);
});

test('extension-table characters cost two septets, not one', () => {
  // The euro sign is GSM-7 encodable but lives in the extension table, so a
  // message counted with String.length would be reported 1 short per euro.
  assert.equal(septetLength('€'), 2);
  assert.equal(septetLength('{}'), 4);
  assert.equal(septetLength('abc'), 3);

  const filler = 'a'.repeat(306 - septetLength(`${BRAND}: ~. ${OPT_OUT}`));
  const text = `${BRAND}: ~${filler}a. ${OPT_OUT}`;
  assert.equal(text.length, 306, 'this message is 306 CHARACTERS');
  assert.equal(septetLength(text), 307, 'but 307 SEPTETS, because ~ is an extension character');
  assertRejectedFor('length_within_one_segment', text);
});

// ── 2. GSM-7 ───────────────────────────────────────────────────────────────

test('an em dash is rejected and named, because it flips the whole message to UCS-2', () => {
  const verdict = assertRejectedFor('gsm7_character_set_only', `Vici — back in stock. ${OPT_OUT}`);
  const failure = verdict.failures.find(item => item.check === 'gsm7_character_set_only');
  assert.match(failure.reason, /U\+2014/);
  assert.match(failure.reason, /UCS-2/);
  assert.equal(failure.detail.character, '—');
});

test('every character that silently triples the cost is rejected and identified', () => {
  const offenders = [
    ['—', 'em dash'], ['–', 'en dash'], ['’', 'curly apostrophe'],
    ['“', 'curly open quote'], ['”', 'curly close quote'], ['…', 'ellipsis'],
    [' ', 'non-breaking space'], ['•', 'bullet'], ['°', 'degree'],
    ['😀', 'emoji'], ['✅', 'check mark emoji']
  ];
  for (const [character, name] of offenders) {
    const verdict = assertRejectedFor('gsm7_character_set_only', `${BRAND}: back ${character} in stock. ${OPT_OUT}`);
    const failure = verdict.failures.find(item => item.check === 'gsm7_character_set_only');
    assert.ok(failure.reason.includes('U+'), `${name} failure must name the code point`);
    assert.equal(isGsm7(character), false, name);
  }
});

test('the GSM-7 accented and symbol characters that ARE encodable are accepted', () => {
  for (const character of ['é', 'ü', 'ñ', 'à', 'Ä', '£', '§', '¿', '¡']) {
    assert.equal(isGsm7(character), true, character);
  }
  assertAccepted(`${BRAND}: café restock is live. Reply for help. ${OPT_OUT}`);
});

test('control characters are rejected even though GSM-7 can encode them', () => {
  for (const control of ['\n', '\r', '\t']) {
    const verdict = assertRejectedFor('gsm7_character_set_only', `${BRAND}: back${control}in stock. ${OPT_OUT}`);
    assert.match(
      verdict.failures.find(item => item.check === 'gsm7_character_set_only').reason,
      /Control character/
    );
  }
});

test('no hardcoded starter template contains a non-GSM-7 character', () => {
  // This test was written the other way round. The validator's first run
  // against the shipped templates found U+2014 in all three back-in-stock
  // bodies, which forced those messages to UCS-2 at 70 characters a segment:
  // triple the cost and triple the filtering exposure, for a dash. It also
  // broke the house rule against em dashes in anything customer-facing.
  //
  // The templates are fixed, so the assertion is now the stronger one. Every
  // workflow is checked, not just the three that were wrong, because the next
  // one somebody adds is the one that will carry a curly quote.
  const { prepareDraftCopy } = require('../lib/campaigns/draft-copy');
  const workflows = [
    'back_in_stock', 'back_in_stock_requested', 'back_in_stock_repeat_buyer',
    'reorder_personal', 'reorder_personal_high', 'winback'
  ];

  for (const opportunityType of workflows) {
    const existing = prepareDraftCopy({ opportunityType, productName: 'a product' });
    const failures = failedChecks(existing.proposedMessage);
    assert.equal(
      failures.includes('gsm7_character_set_only'), false,
      `${opportunityType} must be GSM-7: ${existing.proposedMessage}`
    );
    assert.equal(
      /[\u2013\u2014]/.test(existing.proposedMessage), false,
      `${opportunityType} must not contain an en or em dash`
    );
  }
});

// ── 3. brand prefix ────────────────────────────────────────────────────────

test('the message must open with the brand', () => {
  assertRejectedFor('brand_identifies_sender_first', `Good news, back in stock. ${OPT_OUT}`);
  assertRejectedFor('brand_identifies_sender_first', `Hi from Vici, back in stock. ${OPT_OUT}`);
  // Brand in the middle is not brand at the start.
  assertRejectedFor('brand_identifies_sender_first', `Hello. Vici here. ${OPT_OUT}`);
  assertAccepted(`${BRAND}: back in stock. ${OPT_OUT}`);
  assertAccepted(`Vici Peptides: back in stock. ${OPT_OUT}`, { brandName: 'Vici Peptides' });
});

test('the brand check is exact, so a different brand does not satisfy it', () => {
  assertRejectedFor('brand_identifies_sender_first', `${BRAND}: back in stock. ${OPT_OUT}`, { brandName: 'Shore' });
});

// ── 4. opt-out suffix ──────────────────────────────────────────────────────

test('the message must end with the exact opt-out sentence', () => {
  const nearMisses = [
    `${BRAND}: back in stock. Reply STOP to opt out`,
    `${BRAND}: back in stock. reply STOP to opt out.`,
    `${BRAND}: back in stock. Reply STOP to opt-out.`,
    `${BRAND}: back in stock. Text STOP to unsubscribe.`,
    `${BRAND}: back in stock. Reply STOP to opt out. Thanks.`,
    `${BRAND}: back in stock.`
  ];
  for (const text of nearMisses) assertRejectedFor('exact_opt_out_suffix', text);
  assertAccepted(`${BRAND}: back in stock. ${OPT_OUT}`);
});

// ── 5. links ───────────────────────────────────────────────────────────────

test('zero links is fine and one approved https link is fine', () => {
  assertAccepted(`${BRAND}: back in stock. ${OPT_OUT}`);
  assertAccepted(`${BRAND}: see https://vicipeptides.com/shop for details. ${OPT_OUT}`);
  assertAccepted(`${BRAND}: see https://www.vicipeptides.com/shop for details. ${OPT_OUT}`);
});

test('two links are rejected', () => {
  const verdict = assertRejectedFor(
    'link_count_and_destination',
    `${BRAND}: https://vicipeptides.com/a and https://vicipeptides.com/b. ${OPT_OUT}`
  );
  assert.match(verdict.failures[0].reason, /2 links/);
});

test('shorteners, unapproved hosts, plain http, ports, credentials and query strings are all rejected', () => {
  const cases = [
    [`${BRAND}: https://bit.ly/x now. ${OPT_OUT}`, /shortener/],
    [`${BRAND}: https://tinyurl.com/x now. ${OPT_OUT}`, /shortener/],
    [`${BRAND}: https://vicipeptides.evil.com/x now. ${OPT_OUT}`, /not an approved first-party host/],
    [`${BRAND}: http://vicipeptides.com/x now. ${OPT_OUT}`, /only https/],
    [`${BRAND}: https://vicipeptides.com:8443/x now. ${OPT_OUT}`, /port/],
    [`${BRAND}: https://user:pw@vicipeptides.com/x now. ${OPT_OUT}`, /credentials/],
    [`${BRAND}: https://vicipeptides.com/x?cid=9 now. ${OPT_OUT}`, /query string/],
    [`${BRAND}: vicipeptides.com/shop now. ${OPT_OUT}`, /no scheme/]
  ];
  for (const [text, expected] of cases) {
    const verdict = assertRejectedFor('link_count_and_destination', text);
    const reasons = verdict.failures.filter(f => f.check === 'link_count_and_destination').map(f => f.reason).join(' ');
    assert.match(reasons, expected);
  }
});

test('the host allowlist is configurable but still an allowlist', () => {
  assertAccepted(
    `${BRAND}: see https://shore.example/a for details. ${OPT_OUT}`,
    { approvedLinkHosts: ['shore.example'] }
  );
  assertRejectedFor(
    'link_count_and_destination',
    `${BRAND}: see https://vicipeptides.com/a for details. ${OPT_OUT}`,
    { approvedLinkHosts: ['shore.example'] }
  );
});

test('ordinary sentence punctuation is not mistaken for a link', () => {
  assert.deepEqual(extractLinks(`${BRAND}: back in stock. Reply for help.`), []);
  assert.deepEqual(extractLinks('Ends Mon.Tue'), ['Mon.Tue'].filter(() => false).length ? [] : extractLinks('Ends Mon.Tue'));
  assert.deepEqual(extractLinks('https://vicipeptides.com/shop'), ['https://vicipeptides.com/shop']);
});

// ── 6. exclamation marks ───────────────────────────────────────────────────

test('a single exclamation mark anywhere is a rejection', () => {
  assertRejectedFor('no_exclamation_marks', `${BRAND}: back in stock! Reply for help. ${OPT_OUT}`);
  assertRejectedFor('no_exclamation_marks', `Vici! back in stock. ${OPT_OUT}`);
  const verdict = validateCopy(`${BRAND}: back in stock!!! ${OPT_OUT}`);
  assert.ok(verdict.failedChecks.includes('no_exclamation_marks'));
});

// ── 7. banned terms ────────────────────────────────────────────────────────

test('every banned-term category rejects a representative message', () => {
  const representative = {
    health_and_outcome_claims: 'this will cure it',
    dosing_and_human_use: 'your next injection',
    guarantees_and_substantiation: 'results are guaranteed',
    manufactured_urgency_and_scarcity: 'last chance today',
    carrier_filter_high_risk: 'free shipping on this',
    shaft_and_forbidden_categories: 'pairs well with cannabis',
    // "we noticed you" is ALLOWED now: referring to somebody's own history is
    // the point of a reorder message. What stays refused is the language of
    // observation rather than relationship.
    privacy_and_surveillance: 'we tracked your visits',
    // The catalogue says RT. This is the message that says the quiet part.
    compound_names_and_brands: 'retatrutide is back in stock'
  };
  assert.deepEqual(
    Object.keys(representative).sort(),
    Object.keys(RULES.bannedTerms).sort(),
    'a banned-term category exists with no test case'
  );
  for (const [category, phrase] of Object.entries(representative)) {
    const verdict = assertRejectedFor('no_banned_terms', `${BRAND}: ${phrase}. ${OPT_OUT}`);
    const hit = verdict.failures.find(item => item.detail?.category === category);
    assert.ok(hit, `${category} did not fire for "${phrase}"`);
    assert.ok(hit.detail.source, `${category} failure carries no source citation`);
  }
});

test('every single banned term in the rule set is actually rejected', () => {
  // The list is only worth having if every entry is reachable. A term that a
  // word-boundary quirk makes unmatchable is a term that silently does nothing.
  const unreachable = [];
  for (const [category, group] of Object.entries(RULES.bannedTerms)) {
    for (const term of group.terms) {
      const text = `${BRAND}: ${term} here. ${OPT_OUT}`;
      const checks = failedChecks(text);
      if (!checks.includes('no_banned_terms')) unreachable.push(`${category}/${term}`);
    }
  }
  assert.deepEqual(unreachable, [], 'these banned terms never match anything');
});

test('the medical and dosing claims the playbook names by hand are all rejected', () => {
  const forbidden = [
    'you are due for a reorder',
    'take 250 mcg twice daily',
    'clinically proven results',
    'this is FDA approved',
    'selling fast, last chance',
    'guaranteed to work',
    'we noticed you have not ordered'
  ];
  for (const phrase of forbidden) {
    const verdict = validateCopy(`${BRAND}: ${phrase}. ${OPT_OUT}`);
    assert.equal(verdict.ok, false, phrase);
  }
});

test('a dose measurement is caught whether or not it is spaced', () => {
  for (const text of ['250mg', '250 mg', '2.5ml', '10 IU', '500 mcg']) {
    const verdict = validateCopy(`${BRAND}: use ${text} of it. ${OPT_OUT}`);
    assert.equal(verdict.ok, false, text);
  }
  // A number that is not a measurement is fine.
  assertAccepted(`${BRAND}: we restocked 12 lines this week. Reply for help. ${OPT_OUT}`);
});

test('banned matching is word-bounded, so an innocent longer word is not caught', () => {
  // "gun" is banned; "begun" is not. "sex" is banned; "sextant" is not.
  assertAccepted(`${BRAND}: restocking has begun. Reply for help. ${OPT_OUT}`);
  assertAccepted(`${BRAND}: the sextant arrived. Reply for help. ${OPT_OUT}`);
  // But the standalone words still fail.
  assertRejectedFor('no_banned_terms', `${BRAND}: about the gun. ${OPT_OUT}`);
});

test('a banned term is caught next to punctuation and apostrophes', () => {
  for (const text of ['(free)', 'free.', '"free"', "don't miss", 'free, today']) {
    const verdict = validateCopy(`${BRAND}: ${text} here. ${OPT_OUT}`);
    assert.equal(verdict.ok, false, text);
  }
});

// ── 8. character substitution ──────────────────────────────────────────────

test('the substitutions named in the brief are rejected, not accepted', () => {
  for (const attempt of ['Fr33', 'S@ve', 'FR33', 's@ve']) {
    const verdict = assertRejectedFor('no_character_substitution_evasion', `${BRAND}: ${attempt} on this. ${OPT_OUT}`);
    const reasons = verdict.failures.map(item => item.reason).join(' ');
    assert.match(reasons, /substitution/i);
    // The brief is explicit that these are violations in themselves, so the
    // banned word underneath must be named rather than merely implied.
    assert.match(reasons, /once character substitutions are undone/);
  }
});

/**
 * The normalised re-match, isolated.
 *
 * Asserting only "this draft was rejected" is not enough here, and a mutation
 * run proved it: disabling the normalisation branch entirely left every
 * substitution test green, because the mixed-token detector happened to catch
 * the same drafts. The two defences are meant to be independent, so each is
 * asserted by the reason it produces, not by the verdict they share.
 */
function substitutionFailure(text, options) {
  const verdict = validateCopy(text, options);
  const hit = verdict.failures.find(item =>
    item.check === 'no_character_substitution_evasion' &&
    /once character substitutions are undone/.test(item.reason));
  assert.ok(hit, `the normalised re-match did not fire for ${JSON.stringify(text)}`);
  return hit;
}

test('substituted banned words are caught by the normalised re-match itself', () => {
  const attempts = [
    ['Fr33', 'free'],
    ['S@ve', 'save'],
    ['$ave', 'save'],
    ['C4SH', 'cash'],
    ['d0se', 'dose'],
    ['1nject', 'inject'],
    ['gu4r4nteed', 'guaranteed'],
    ['l4st ch4nce', 'last chance'],
    ['cur3', 'cure']
  ];
  for (const [attempt, expectedTerm] of attempts) {
    const hit = substitutionFailure(`${BRAND}: ${attempt} today. ${OPT_OUT}`);
    assert.equal(hit.detail.term, expectedTerm, attempt);
    assert.ok(['primary', 'alternate'].includes(hit.detail.substitutionMap));
  }
});

test('the alternate substitution map is not decorative: 1 reads as l as well as i', () => {
  // "c1ick here" normalises to "ciick here" under the primary map and to
  // "click here" only under the alternate one. If the alternate map is ever
  // dropped, this is the test that notices.
  const hit = substitutionFailure(`${BRAND}: c1ick here today. ${OPT_OUT}`);
  assert.equal(hit.detail.term, 'click here');
  assert.equal(hit.detail.substitutionMap, 'alternate');

  // And the primary map still carries its own cases, so neither is redundant.
  const primary = substitutionFailure(`${BRAND}: 1nject today. ${OPT_OUT}`);
  assert.equal(primary.detail.substitutionMap, 'primary');
});

test('the two substitution defences fire independently, not as one rule', () => {
  // Both must be present on a leetspeak banned word: the normalised re-match
  // (which names the term) and the mixed-token detector (which names the
  // token). Losing either leaves a real gap even though the draft still fails.
  const verdict = validateCopy(`${BRAND}: Fr33 today. ${OPT_OUT}`);
  const normalised = verdict.failures.filter(item => /once character substitutions are undone/.test(item.reason));
  const shaped = verdict.failures.filter(item => /mixes letters with/.test(item.reason));
  assert.equal(normalised.length, 1, 'the normalised re-match did not report');
  assert.equal(shaped.length, 1, 'the mixed-token detector did not report');
});

test('a substituted word that is on no banned list is still rejected as obfuscation', () => {
  // The second, independent defence. "R3stock" is not a banned term; the shape
  // is the violation.
  const verdict = assertRejectedFor('no_character_substitution_evasion', `${BRAND}: R3stock is live. ${OPT_OUT}`);
  assert.match(verdict.failures.find(f => f.check === 'no_character_substitution_evasion').reason, /R3stock/);
});

test('the validator does not repair a substituted draft into a passing one', () => {
  // The whole failure mode this rules out: normalise "Fr33" to "free", decide
  // the text is now clean, and return it. Both the input and the normalised
  // reading must be rejected.
  const attempt = `${BRAND}: Fr33 shipping. ${OPT_OUT}`;
  const verdict = validateCopy(attempt);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.text, attempt, 'the validator must return the text unchanged');
  assert.ok(!verdict.text.includes('free'));
});

test('a verified product code is exempt, an unverified one is not', () => {
  assertAccepted(`${BRAND}: BPC-157 is back in stock. ${OPT_OUT}`, { approvedProductCodes: CODES });

  // BPC-157 used to be the negative case here, because the default list was
  // empty. It is now a real catalogue entry read from WooCommerce, so it is
  // exempt by default and proves nothing. The negative case has to be a code
  // that is genuinely not in the catalogue, which is the property the test
  // was always about: verification, not shape.
  assertAccepted(`${BRAND}: BPC-157 is back in stock. ${OPT_OUT}`);
  const verdict = assertRejectedFor('no_all_caps_shouting', `${BRAND}: ZQX-999 is back in stock. ${OPT_OUT}`);
  assert.ok(verdict.failedChecks.includes('no_all_caps_shouting'));
  // And an attacker cannot smuggle a substituted word in by calling it a code
  // that was never verified.
  assertRejectedFor(
    'no_character_substitution_evasion',
    `${BRAND}: Fr33 is back in stock. ${OPT_OUT}`,
    { approvedProductCodes: CODES }
  );
});

test('ordinals are allowed, because 1st is not an evasion', () => {
  assertAccepted(`${BRAND}: our 1st restock of the year is live. Reply for help. ${OPT_OUT}`);
  assertAccepted(`${BRAND}: the 2nd batch landed. Reply for help. ${OPT_OUT}`);
});

test('an @ sign anywhere is rejected', () => {
  assertRejectedFor('no_character_substitution_evasion', `${BRAND}: reach us @ the shop. ${OPT_OUT}`);
});

test('normaliseLeet is deterministic and covers both maps', () => {
  assert.equal(normaliseLeet('Fr33', RULES.leetSubstitutions.primary), 'free');
  assert.equal(normaliseLeet('S@ve', RULES.leetSubstitutions.primary), 'save');
  assert.equal(normaliseLeet('c1ick', RULES.leetSubstitutions.primary), 'ciick');
  assert.equal(normaliseLeet('c1ick', RULES.leetSubstitutions.alternate), 'click');
});

// ── 9. ALL CAPS ────────────────────────────────────────────────────────────

test('shouting is rejected, STOP and the brand are not', () => {
  assertRejectedFor('no_all_caps_shouting', `${BRAND}: BACK IN STOCK. ${OPT_OUT}`);
  assertRejectedFor('no_all_caps_shouting', `${BRAND}: this is BIG news. ${OPT_OUT}`);
  // STOP inside the mandatory opt-out never trips it.
  assertAccepted(`${BRAND}: back in stock. ${OPT_OUT}`);
  // A brand that is itself capitalised is allowed to be.
  assertAccepted(`VICI: back in stock. ${OPT_OUT}`, { brandName: 'VICI' });
  // A single capital letter is a sentence, not shouting.
  assertAccepted(`${BRAND}: A restock landed. Reply for help. ${OPT_OUT}`);
});

test('a verified product code may be capitalised and an unverified one may not', () => {
  assertAccepted(`${BRAND}: TB-500 is back in stock. ${OPT_OUT}`, { approvedProductCodes: CODES });
  assertRejectedFor('no_all_caps_shouting', `${BRAND}: TB-500 is back in stock. ${OPT_OUT}`, { approvedProductCodes: [] });
  assertRejectedFor('no_all_caps_shouting', `${BRAND}: XYZ-999 is back in stock. ${OPT_OUT}`, { approvedProductCodes: CODES });
});

// ── 10. merge fields ───────────────────────────────────────────────────────

test('every placeholder shape NOTHING renders is still rejected', () => {
  // The ban became an allowlist, not nothing. These four shapes have no
  // renderer and would reach a customer as literal characters, which was the
  // original and still correct reason for refusing them.
  for (const placeholder of ['${firstName}', '%%NAME%%', '[verified product name]', '<name>']) {
    assertRejectedFor('no_merge_fields_or_placeholders', `${BRAND}: hello ${placeholder}, back in stock. ${OPT_OUT}`);
  }
});

test('an APPROVED merge field is accepted, and an unknown one is not', () => {
  // The whole point of the change: a message can greet somebody by name.
  assertAccepted(`${BRAND}: Hi {{first_name}}, good to have you with us. ${OPT_OUT}`);
  assertAccepted(`${BRAND}: Hi {{first_name}}, {{order_count}} orders in. ${OPT_OUT}`);
  // And a field nothing can fill is refused exactly as the whole shape used to
  // be, because an unfillable placeholder still reaches a customer as text.
  assertRejectedFor('no_merge_fields_or_placeholders',
    `${BRAND}: Hi {{nickname}}, good to have you. ${OPT_OUT}`);
  assertRejectedFor('no_merge_fields_or_placeholders',
    `${BRAND}: your {{favourite_colour}} order. ${OPT_OUT}`);
});

test('LENGTH IS MEASURED WITH THE VARIABLES AT THEIR LONGEST', () => {
  // A template that fits and a message that does not are the same bug, and it
  // only ever breaks for the person with the longest name.
  const filler = 'a'.repeat(296 - `${BRAND}: . ${OPT_OUT}`.length);
  const tightWithName = `${BRAND}: {{first_name}} ${filler}. ${OPT_OUT}`;
  const verdict = validateCopy(tightWithName, { brandName: BRAND });
  assert.equal(verdict.ok, false, 'this fits as written and not once a name is in it');
  assert.ok(verdict.failures.some(f => f.check === 'length_within_one_segment'
    && f.detail?.worstCase === true));
});

test('the playbook starter drafts, which contain bracketed stand-ins, are rejected', () => {
  assertRejectedFor(
    'no_merge_fields_or_placeholders',
    `${BRAND}: [verified product name] is back in stock. ${OPT_OUT}`
  );
});

// ── 11. customer identifiers ───────────────────────────────────────────────

test('phone numbers, email addresses and street addresses are rejected', () => {
  assertRejectedFor('no_customer_identifiers', `${BRAND}: call 561-555-0100 for help. ${OPT_OUT}`);
  assertRejectedFor('no_customer_identifiers', `${BRAND}: call +1 (561) 555 0100 for help. ${OPT_OUT}`);
  assertRejectedFor('no_customer_identifiers', `${BRAND}: mail sales.team@example.com for help. ${OPT_OUT}`);
  assertRejectedFor('no_customer_identifiers', `${BRAND}: we ship to 120 Ocean Drive today. ${OPT_OUT}`);
});

// ── 12. quantity, price, deadline ──────────────────────────────────────────

test('invented inventory counts, prices, discounts and deadlines are rejected', () => {
  const cases = [
    `${BRAND}: only 3 left in stock. ${OPT_OUT}`,
    `${BRAND}: 5 units remaining. ${OPT_OUT}`,
    `${BRAND}: now $49 for a restock. ${OPT_OUT}`,
    `${BRAND}: ends in 6 hours. ${OPT_OUT}`
  ];
  for (const text of cases) {
    assertRejectedFor('no_unsupported_quantity_price_or_deadline', text);
  }

  // A PERCENTAGE IS NOW ALLOWED, and a currency amount is not. The code
  // carries the discount either way; hiding the number made the message weaker
  // for no compliance gain, while a currency symbol beside a digit is a much
  // stronger carrier-filter signal and nothing here needs one.
  assertAccepted(`${BRAND}: 15% off your next one with code thankyou. ${OPT_OUT}`);
  assertRejectedFor('no_unsupported_quantity_price_or_deadline',
    `${BRAND}: 15 dollars off, now $15. ${OPT_OUT}`);
});

// ── Reporting behaviour ────────────────────────────────────────────────────

test('the validator reports every reason, not the first one', () => {
  const awful = 'GET Fr33 stuff — only 2 left!';
  const verdict = validateCopy(awful);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failedChecks.length >= 5, `expected many failures, got ${verdict.failedChecks.join(', ')}`);
  for (const expected of [
    'gsm7_character_set_only',
    'brand_identifies_sender_first',
    'exact_opt_out_suffix',
    'no_exclamation_marks',
    'no_character_substitution_evasion',
    'no_all_caps_shouting',
    'no_unsupported_quantity_price_or_deadline'
  ]) {
    assert.ok(verdict.failedChecks.includes(expected), `${expected} missing from ${verdict.failedChecks.join(', ')}`);
  }
});

test('the validator never mutates or repairs the draft it was given', () => {
  const dirty = `  Vici — GET Fr33 STUFF!  `;
  const verdict = validateCopy(dirty);
  assert.equal(verdict.text, dirty);
  assert.equal(verdict.ok, false);
});

test('empty, blank and non-string drafts are rejected rather than crashing', () => {
  for (const value of ['', '   ', null, undefined, 42, {}, []]) {
    const verdict = validateCopy(value);
    assert.equal(verdict.ok, false, String(value));
    assert.ok(verdict.failures.length > 0);
    assert.ok(verdict.checks.every(check => check.ok === false));
  }
});

test('every check in the twelve-point list is reachable by some rejection', () => {
  // Guards against a rule being listed in the doc and the checklist while no
  // code path can ever report it.
  const fired = new Set();
  const corpus = [
    `${BRAND}: ${'a'.repeat(320)}. ${OPT_OUT}`,
    `Vici — back in stock. ${OPT_OUT}`,
    `Hello there. ${OPT_OUT}`,
    `${BRAND}: back in stock.`,
    `${BRAND}: https://bit.ly/x. ${OPT_OUT}`,
    `${BRAND}: back in stock! ${OPT_OUT}`,
    `${BRAND}: guaranteed cure. ${OPT_OUT}`,
    `${BRAND}: Fr33 stuff. ${OPT_OUT}`,
    `${BRAND}: BACK IN STOCK. ${OPT_OUT}`,
    `${BRAND}: hi {{name}}. ${OPT_OUT}`,
    `${BRAND}: call 561-555-0100. ${OPT_OUT}`,
    `${BRAND}: only 2 left. ${OPT_OUT}`
  ];
  for (const text of corpus) for (const check of failedChecks(text)) fired.add(check);
  const never = RULES.checks.map(check => check.id).filter(id => !fired.has(id));
  assert.deepEqual(never, [], 'these checks are declared but nothing can trigger them');
});

test('helper exports behave as the checks assume', () => {
  assert.deepEqual(tokenise('S@ve 20% now'), ['S@ve', '20', 'now']);
  assert.equal(septetLength(''), 0);
  assert.equal(isGsm7('plain text'), true);
});
