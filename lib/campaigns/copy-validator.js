'use strict';
/**
 * lib/campaigns/copy-validator.js — the deterministic twelve-point check that
 * every candidate SMS campaign draft must pass before a human sees it.
 *
 * This is the important half of the AI copy feature. The model is a drafter
 * with no authority; this file is the thing that actually decides what a
 * reviewer is allowed to look at. It is pure, synchronous, offline, and has no
 * dependency beyond lib/campaigns/copy-rules.js.
 *
 * THREE PROPERTIES IT DELIBERATELY HAS
 *
 * 1. It never repairs. There is no `sanitise()` here and there must not be
 *    one. Stripping an em dash or deleting an exclamation mark produces text
 *    that no model wrote and no human reviewed, and it hides the fact that the
 *    drafting prompt is drifting. A failure is surfaced with its reason.
 *
 * 2. It never short-circuits. Every check runs on every draft, so a reviewer
 *    reading a rejection sees all of it rather than one reason at a time.
 *
 * 3. Character substitution is a violation, not a bypass. `Fr33` and `S@ve`
 *    are rejected twice over: once because the leet-normalised text still
 *    matches the banned term, and once because a token mixing letters with
 *    digits or symbols is itself the shape carriers filter on. Neither check
 *    "cleans up" the token and re-tests it as if it were fine.
 *
 * WHY IT COUNTS SEPTETS AND NOT CHARACTERS. One character outside GSM 03.38 —
 * an em dash, a curly apostrophe, an emoji — moves the entire message to UCS-2
 * and cuts the single-segment limit from 160 to 70. The existing starter
 * templates in draft-copy.js contain U+2014 and would fail check 2 today; that
 * is a real finding about those templates, not a bug in this file.
 */

const {
  RULES,
  GSM7_BASIC_SET,
  GSM7_EXTENDED_SET,
  FORBIDDEN_CONTROL,
  flattenedBannedTerms
} = require('./copy-rules');
const { FIELD_NAMES, unknownFields, worstCase } = require('./merge-fields');

const BANNED_TERMS = flattenedBannedTerms();
const BANNED_PATTERNS = RULES.bannedPatterns.map(entry => ({
  ...entry,
  regex: new RegExp(entry.pattern, entry.flags || undefined)
}));

/** Which pattern ids belong to which of the twelve checks. */
const PATTERN_CHECK = new Map([
  ['dose_measurement', 'no_banned_terms'],
  ['quantity_on_hand_claim', 'no_unsupported_quantity_price_or_deadline'],
  ['deadline_claim', 'no_unsupported_quantity_price_or_deadline'],
  ['price_or_percentage_offer', 'no_unsupported_quantity_price_or_deadline'],
  ['merge_field_or_placeholder', 'no_merge_fields_or_placeholders'],
  ['phone_number', 'no_customer_identifiers'],
  ['email_address', 'no_customer_identifiers'],
  ['street_address', 'no_customer_identifiers'],
  ['stray_at_sign', 'no_character_substitution_evasion'],
  ['shouted_punctuation', 'no_exclamation_marks']
]);

const ORDINAL = /^\d+(?:st|nd|rd|th)$/i;

/**
 * Characters used for substitution inside a word.
 *
 * `!` is deliberately absent even though the substitution maps include it.
 * Every `!` already fails check 6 unconditionally with a plain reason, and
 * listing it here as well made "stock!" report as a disguised word, which is
 * a confusing thing to hand a reviewer for an ordinary exclamation mark.
 */
const LEET_CHARS = '0123456789@$+|£€¥§¤';

/**
 * GSM-7 septet cost. Basic characters cost one, extension-table characters
 * cost two, anything else is not encodable at all and is reported by the
 * gsm7 check rather than counted here.
 */
function septetLength(text) {
  let total = 0;
  for (const character of String(text)) {
    if (GSM7_EXTENDED_SET.has(character)) total += 2;
    else total += 1;
  }
  return total;
}

/** True when the whole string is GSM-7 encodable and control-character free. */
function isGsm7(text) {
  for (const character of String(text)) {
    if (FORBIDDEN_CONTROL.includes(character)) return false;
    if (!GSM7_BASIC_SET.has(character) && !GSM7_EXTENDED_SET.has(character)) return false;
  }
  return true;
}

function describeCharacter(character) {
  const point = character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
  return `${JSON.stringify(character)} (U+${point})`;
}

/** Apply one substitution map, lower-cased, for the evasion re-match. */
function normaliseLeet(text, map) {
  let output = '';
  for (const character of String(text).toLowerCase()) {
    output += Object.prototype.hasOwnProperty.call(map, character) ? map[character] : character;
  }
  return output;
}

/** Word-boundary-ish containment that also works for multi-word phrases. */
function containsTerm(haystack, term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // \b fails next to a non-word edge character such as the ' in "don't", so
  // the boundary is spelled out as "not a letter or digit" on both sides.
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, 'i').test(haystack);
}

function normaliseCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Tokens for the ALL-CAPS and substitution checks. A token is a maximal run of
 * characters a word could plausibly be written with, including the symbols
 * used for substitution, so `S@ve` arrives as one token rather than three.
 */
function tokenise(text) {
  return String(text).match(/[A-Za-z0-9@$!+|£€¥§¤_'-]+/g) || [];
}

/**
 * Extract every URL-ish run. Deliberately greedy about what counts as a link:
 * a bare `vicipeptides.com/x` and an `http://` link both need to be seen by
 * the destination check, not skipped for lacking a scheme.
 */
function extractLinks(text) {
  // Userinfo is matched ONLY after a scheme. Allowing it unconditionally
  // would make every email address parse as a link and report the wrong
  // rule; requiring the scheme keeps `https://user:pw@host/` reported as
  // embedded credentials, which is what it is.
  const pattern = /\b(?:[a-z][a-z0-9+.-]*:\/\/(?:[^\s/?#@]*@)?)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?::\d+)?(?:\/[^\s]*)?/g;
  const found = [];
  for (const match of String(text).matchAll(pattern)) {
    const candidate = match[0];
    // A sentence-ending "stock." is not a link; require a plausible TLD.
    if (!/\.[A-Za-z]{2,}(?:$|[:/])/.test(candidate) && !/\.[A-Za-z]{2,}$/.test(candidate)) continue;
    if (/^\d+(?:\.\d+)+$/.test(candidate)) { found.push(candidate); continue; }
    found.push(candidate);
  }
  return found;
}

function failure(check, reason, detail) {
  return detail === undefined ? { check, reason } : { check, reason, detail };
}

// ── The twelve checks ───────────────────────────────────────────────────────
// Each returns an array of failures. An empty array is a pass. They are kept
// as separate named functions so a mutation to one of them kills exactly the
// tests that cover it.

/**
 * Length of a message that has no variables in it.
 *
 * A TEMPLATE is deliberately not measured here, and checkRenderedLength below
 * owns that case instead. The reason is that `{` and `}` are GSM-7 extended
 * characters costing two septets each, so `{{first_name}}` is charged 18
 * septets by this function and renders to at most 12. Measuring the braces
 * measures a string that is never transmitted, and it is stricter than reality
 * by 32 septets on a four-variable message: the win-back template scored
 * exactly 160 of 160 on characters no customer would ever receive, leaving no
 * room to say "your next order".
 *
 * Nothing is loosened by this. Worst case is by definition the longest thing
 * that can actually be sent, so a template whose worst case fits cannot render
 * into something that does not. What changes is that one function owns the
 * length of a template and a different one owns the length of a literal
 * message, rather than both answering and the wrong one winning.
 */
function checkLength(text) {
  if (worstCase(text) !== text) return [];
  const septets = septetLength(text);
  if (septets <= RULES.length.maxSeptets) return [];
  return [failure(
    'length_within_one_segment',
    `Message is ${septets} GSM-7 septets, over the ${RULES.length.maxSeptets} limit for one segment.`,
    { septets, limit: RULES.length.maxSeptets }
  )];
}

function checkGsm7(text) {
  const failures = [];
  const seen = new Set();
  for (const character of String(text)) {
    if (seen.has(character)) continue;
    if (FORBIDDEN_CONTROL.includes(character)) {
      seen.add(character);
      failures.push(failure(
        'gsm7_character_set_only',
        `Control character ${describeCharacter(character)} is not allowed in campaign copy.`,
        { character }
      ));
      continue;
    }
    if (GSM7_BASIC_SET.has(character) || GSM7_EXTENDED_SET.has(character)) continue;
    seen.add(character);
    failures.push(failure(
      'gsm7_character_set_only',
      `Character ${describeCharacter(character)} is not in the GSM 03.38 alphabet, so the whole message would be sent as UCS-2 at 70 characters per segment.`,
      { character }
    ));
  }
  return failures;
}

/**
 * How far into a message the brand may appear and still count as identifying
 * the sender up front.
 *
 * Six characters, which admits a natural opener like "It's " and admits
 * nothing else worth having. The rule this encodes is that a recipient knows
 * who is texting them before they read anything else; a bare `startsWith` was
 * a stricter reading of that than the requirement needs, and it refused
 * "It's Vin from Vici. Hi Jessica..." which identifies the sender in four
 * words and reads like a person rather than a broadcast header.
 *
 * Deliberately tiny. At 20 or 30 the brand could sit behind a whole clause,
 * and "identified up front" would stop meaning anything.
 */
const BRAND_LEAD_IN_LIMIT = 6;

function checkBrandPrefix(text, brandName) {
  const index = String(text).indexOf(brandName);
  if (index === 0) return [];
  if (index > 0 && index <= BRAND_LEAD_IN_LIMIT) return [];
  return [failure(
    'brand_identifies_sender_first',
    `Message must name the brand "${brandName}" within the first ${BRAND_LEAD_IN_LIMIT} characters so the sender is identified.`
  )];
}

function checkOptOutSuffix(text) {
  const suffix = RULES.optOut.exactSuffix;
  if (String(text).endsWith(suffix)) return [];
  return [failure(
    'exact_opt_out_suffix',
    `Message must end with the exact string "${suffix}".`
  )];
}

function checkLinks(text, approvedHosts) {
  const links = extractLinks(text);
  const failures = [];
  if (links.length > RULES.links.maxPerMessage) {
    failures.push(failure(
      'link_count_and_destination',
      `Message contains ${links.length} links; at most ${RULES.links.maxPerMessage} is allowed.`,
      { links }
    ));
  }
  for (const link of links) {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(link) ? link : `https://${link}`;
    let url;
    try {
      url = new URL(withScheme);
    } catch {
      failures.push(failure('link_count_and_destination', `"${link}" is not a parseable link.`, { link }));
      continue;
    }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(link)) {
      failures.push(failure(
        'link_count_and_destination',
        `"${link}" has no scheme; links must be written in full with https.`, { link }
      ));
    } else if (url.protocol !== `${RULES.links.requiredScheme}:`) {
      failures.push(failure(
        'link_count_and_destination',
        `"${link}" uses ${url.protocol.replace(':', '')}; only ${RULES.links.requiredScheme} is allowed.`, { link }
      ));
    }
    const host = url.hostname.toLowerCase();
    if (RULES.links.forbiddenShortenerHosts.includes(host)) {
      failures.push(failure(
        'link_count_and_destination',
        `"${host}" is a URL shortener; carriers and the playbook both forbid them.`, { link }
      ));
    } else if (!approvedHosts.includes(host)) {
      failures.push(failure(
        'link_count_and_destination',
        `"${host}" is not an approved first-party host (${approvedHosts.join(', ')}).`, { link }
      ));
    }
    if (url.port) {
      failures.push(failure('link_count_and_destination', `"${link}" specifies a port.`, { link }));
    }
    if (url.username || url.password) {
      failures.push(failure('link_count_and_destination', `"${link}" embeds credentials.`, { link }));
    }
    // ── ONE QUERY STRING IS ALLOWED, AND ONLY ONE SHAPE ─────────────────
    //
    // The rule exists so a link cannot carry a customer identifier, and that
    // intent is kept exactly: `?p=<digits>` is a WordPress post id. It is
    // public, it is identical for every recipient who bought that product, and
    // it says nothing whatever about the person receiving it.
    //
    // It is allowed because it is the only way the shop's own product links
    // fit. A readable permalink runs to 58 characters and the slug grows with
    // the product name, so the longest product names produce the longest URLs
    // and the message cannot hold a greeting, a name, a product, a month, an
    // offer and a link at once. The shortlink is a fixed 31 or 32 characters
    // whatever the product, and 301-redirects to the canonical page.
    //
    // Anything else is still refused: ?utm_source, ?ref, ?email, two
    // parameters, or a non-numeric value.
    const allowedQuery = /^\?p=\d+$/.test(url.search);
    if (url.search && !allowedQuery) {
      failures.push(failure(
        'link_count_and_destination',
        `"${link}" carries a query string, which can leak a customer identifier.`, { link }
      ));
    }
  }
  return failures;
}

function checkExclamation(text) {
  if (!String(text).includes('!')) return [];
  return [failure('no_exclamation_marks', 'Message contains an exclamation mark.')];
}

function checkBannedTerms(text) {
  const failures = [];
  const reported = new Set();
  for (const { term, category, source } of BANNED_TERMS) {
    if (reported.has(term)) continue;
    if (!containsTerm(text, term)) continue;
    reported.add(term);
    failures.push(failure(
      'no_banned_terms',
      `Contains the banned ${category.replace(/_/g, ' ')} term "${term}".`,
      { term, category, source }
    ));
  }
  return failures;
}

/**
 * Substitution evasion.
 *
 * Two independent detectors, because either one alone is defeatable. The
 * normalised re-match catches a substituted banned word; the mixed-token rule
 * catches a substituted word that is not on any list, which is still exactly
 * the shape a carrier spam filter scores on.
 */
function checkSubstitutionEvasion(text, approvedProductCodes) {
  const failures = [];
  const approved = new Set(approvedProductCodes.map(normaliseCode).filter(Boolean));

  for (const [mapName, map] of Object.entries(RULES.leetSubstitutions)) {
    const normalised = normaliseLeet(text, map);
    if (normalised === String(text).toLowerCase()) continue;
    for (const { term, category } of BANNED_TERMS) {
      if (!containsTerm(normalised, term)) continue;
      if (containsTerm(text, term)) continue; // already reported plainly
      failures.push(failure(
        'no_character_substitution_evasion',
        `Reads as the banned ${category.replace(/_/g, ' ')} term "${term}" once character substitutions are undone.`,
        { term, category, substitutionMap: mapName }
      ));
    }
  }

  // ── A LINK IS NOT LEET-SPEAK ────────────────────────────────────────────
  //
  // The mixed-token rule reads the inside of a URL, so a product page at
  // /product/cjc-1295-without-dac-ipa/ was reported as character substitution.
  // Every product URL on this store carries a dose number, so this refused
  // almost every link the shop could legitimately send. `bpc-157` passed only
  // because that slug happens to be an approved product code, which is luck
  // rather than a rule.
  //
  // A link is already governed by link_count_and_destination: at most one,
  // https, and only an approved host. That is the check that matters, because
  // a carrier scores the DESTINATION, and a slug the store itself chose is not
  // an attempt to disguise a banned word. The normalised re-match above still
  // runs on the whole text, so a banned term hidden in a URL is still caught.
  const linkSpans = extractLinks(text);
  const outsideLinks = linkSpans.reduce(
    (remaining, link) => remaining.split(link).join(' '), String(text)
  );

  for (const token of tokenise(outsideLinks)) {
    if (!/[A-Za-z]/.test(token)) continue;
    const substituted = [...token].filter(character => LEET_CHARS.includes(character));
    if (!substituted.length) continue;
    if (ORDINAL.test(token)) continue;
    if (approved.has(normaliseCode(token))) continue;
    failures.push(failure(
      'no_character_substitution_evasion',
      `"${token}" mixes letters with ${substituted.join(', ')}. Character substitution is itself a carrier violation, and this token is not a verified product code.`,
      { token }
    ));
  }

  return dedupe(failures);
}

function checkAllCaps(text, brandName, approvedProductCodes) {
  const allowed = new Set([
    ...RULES.allCaps.alwaysAllowedTokens.map(normaliseCode),
    ...tokenise(brandName).map(normaliseCode)
  ]);
  if (RULES.allCaps.allowApprovedProductCodes) {
    for (const code of approvedProductCodes) allowed.add(normaliseCode(code));
  }
  allowed.delete('');

  const failures = [];
  const reported = new Set();
  for (const token of tokenise(text)) {
    const letters = token.replace(/[^A-Za-z]/g, '');
    if (letters.length < 2) continue;
    if (letters !== letters.toUpperCase()) continue;
    const code = normaliseCode(token);
    if (allowed.has(code)) continue;
    if (reported.has(code)) continue;
    reported.add(code);
    failures.push(failure(
      'no_all_caps_shouting',
      `"${token}" is in capitals. Only STOP, the brand, and verified product codes may be capitalised.`,
      { token }
    ));
  }
  return failures;
}

/**
 * Merge fields, checked against the table that can actually render them.
 *
 * The blanket ban on {{...}} is gone, replaced by this. The property that
 * mattered is unchanged: a placeholder nothing can fill would reach a customer
 * as literal characters, so a field name this system does not know is refused
 * exactly as the whole shape used to be.
 */
function checkMergeFields(text) {
  const unknown = unknownFields(text);
  if (!unknown.length) return [];
  return unknown.map(name => failure(
    // The SAME check id as the placeholder pattern, deliberately. It is one
    // rule with two halves: a shape nothing renders, and a name nothing fills.
    // A thirteenth entry in a checklist the docs call twelve points would be a
    // worse lie than reusing the id that already describes this.
    'no_merge_fields_or_placeholders',
    `"{{${name}}}" is not a field this system can fill, so it would be sent as written.`,
    { term: name, allowed: FIELD_NAMES }
  ));
}

/**
 * Length, measured at the LONGEST the message can render to.
 *
 * "Hi {{first_name}}" is 16 septets as a template and 25 for a Christopher.
 * Checking the template is not checking the message, and the person it breaks
 * for is always the one with the longest name.
 */
function checkRenderedLength(text) {
  const expanded = worstCase(text);
  if (expanded === text) return [];
  const septets = septetLength(expanded);
  if (septets <= RULES.length.maxSeptets) return [];
  return [failure(
    'length_within_one_segment',
    `With every variable at its longest this is ${septets} septets, over the ${RULES.length.maxSeptets} limit. It fits as written but not for everybody it would be sent to.`,
    { septets, maximum: RULES.length.maxSeptets, worstCase: true }
  )];
}

function checkPatterns(text) {
  const failures = [];
  for (const entry of BANNED_PATTERNS) {
    entry.regex.lastIndex = 0;
    const match = entry.regex.exec(String(text));
    if (!match) continue;
    failures.push(failure(
      PATTERN_CHECK.get(entry.id) || 'no_banned_terms',
      `${entry.reason} (matched "${match[0]}").`,
      { pattern: entry.id, match: match[0], source: entry.source }
    ));
  }
  return failures;
}

function dedupe(failures) {
  const seen = new Set();
  const unique = [];
  for (const item of failures) {
    const key = `${item.check}::${item.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

/**
 * Validate one candidate SMS body.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {string} [options.brandName]              Required opening string.
 * @param {string[]} [options.approvedProductCodes] Verified codes, exempt from
 *   the ALL-CAPS and substitution rules. Empty means nothing is exempt.
 * @param {string[]} [options.approvedLinkHosts]    Overrides the rule default.
 * @returns {{ok: boolean, text: string, septets: number, gsm7: boolean,
 *   failures: Array<{check: string, reason: string, detail?: object}>,
 *   failedChecks: string[], checks: Array<{id: string, ok: boolean}>}}
 */
function validateCopy(text, options = {}) {
  const brandName = String(options.brandName || RULES.brand.defaultName);
  const approvedProductCodes = Array.isArray(options.approvedProductCodes)
    ? options.approvedProductCodes
    : RULES.defaultApprovedProductCodes;
  const approvedLinkHosts = (Array.isArray(options.approvedLinkHosts)
    ? options.approvedLinkHosts
    : RULES.links.approvedHosts).map(host => String(host).toLowerCase());

  if (typeof text !== 'string' || !text.trim()) {
    const empty = [failure('length_within_one_segment', 'Draft is empty.')];
    return {
      ok: false,
      text: '',
      septets: 0,
      gsm7: false,
      failures: empty,
      failedChecks: ['length_within_one_segment'],
      checks: RULES.checks.map(check => ({ id: check.id, ok: false }))
    };
  }

  const failures = dedupe([
    ...checkLength(text),
    ...checkGsm7(text),
    ...checkBrandPrefix(text, brandName),
    ...checkOptOutSuffix(text),
    ...checkLinks(text, approvedLinkHosts),
    ...checkExclamation(text),
    ...checkBannedTerms(text),
    ...checkSubstitutionEvasion(text, approvedProductCodes),
    ...checkAllCaps(text, brandName, approvedProductCodes),
    ...checkPatterns(text),
    ...checkMergeFields(text),
    ...checkRenderedLength(text)
  ]);

  const failedChecks = [...new Set(failures.map(item => item.check))];
  const known = new Set(RULES.checks.map(check => check.id));
  for (const check of failedChecks) {
    /* istanbul ignore next — a failure with an unknown check id is a coding
       error in this file, and silently accepting it would let a rule vanish
       from the reported check list. */
    if (!known.has(check)) throw new Error(`copy-validator produced an unknown check id: ${check}`);
  }

  return {
    ok: failures.length === 0,
    text,
    septets: septetLength(text),
    gsm7: isGsm7(text),
    failures,
    failedChecks,
    checks: RULES.checks.map(check => ({ id: check.id, ok: !failedChecks.includes(check.id) }))
  };
}

module.exports = {
  validateCopy,
  septetLength,
  isGsm7,
  extractLinks,
  normaliseLeet,
  tokenise
};
