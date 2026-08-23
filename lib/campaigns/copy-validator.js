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

function checkLength(text) {
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

function checkBrandPrefix(text, brandName) {
  if (String(text).startsWith(brandName)) return [];
  return [failure(
    'brand_identifies_sender_first',
    `Message must start with the brand "${brandName}" so the sender is identified.`
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
    if (url.search) {
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

  for (const token of tokenise(text)) {
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
    ...checkPatterns(text)
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
