'use strict';

/**
 * Normalise any phone number to E.164 format.
 * Returns null if the number cannot be parsed.
 *
 * Handles:
 *   "+13055551234" -> "+13055551234" (already correct)
 *   "13055551234"  -> "+13055551234" (missing + prefix)
 *   "3055551234"   -> "+13055551234" (10-digit US number)
 *   "(305) 555-1234" -> "+13055551234" (formatted)
 *   "+447506440284"  -> "+447506440284" (non-US, preserved)
 */
function normalisePhone(raw) {
  if (!raw) return null;

  if (raw.startsWith('+') && raw.replace(/\D/g, '').length >= 10) {
    return '+' + raw.replace(/\D/g, '');
  }

  const digits = raw.replace(/\D/g, '');

  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  if (digits.length >= 11) return '+' + digits;

  return null;
}

/** The shape the `sms_consent_events` CHECK constraint enforces. */
const STRICT_E164 = /^\+[1-9][0-9]{7,14}$/;

/**
 * A NANP national number: [2-9] area code, [2-9] central-office code.
 * Neither may begin with 0 or 1, so "0412345678" is not a US number however
 * much it looks like ten digits.
 */
const NANP_NATIONAL = /^[2-9][0-9]{2}[2-9][0-9]{6}$/;

/** Any Unicode letter. "3055551234 ext 22" and "...x9" are caught here. */
const CONTAINS_LETTER = /\p{L}/u;

/**
 * An extension marker followed by digits: "x9", "ext. 22", "#5".
 * The letter test already covers x/ext; '#' needs its own rule.
 */
const EXTENSION_MARKER = /(?:#|\bx|\bext)\s*\.?\s*[0-9]/i;

/**
 * Normalise to strict E.164, or refuse. NEVER guesses.
 *
 * WHY A SECOND, STRICTER NORMALISER EXISTS
 *   `normalisePhone` above (and its twin `normalizePhone` in `woocommerce.js`)
 *   are deliberately forgiving because they serve delivery paths where a
 *   best-effort match against an existing contact row is better than dropping a
 *   transactional order update. That forgiveness FABRICATES numbers:
 *
 *     "3055551234 ext 22"   -> +305555123422   extension welded onto the number
 *     "305.555.1234.22"     -> +305555123422   a subscriber who does not exist
 *     "+1 (305) 555-1234x9" -> +130555512349
 *     "0412345678"          -> +10412345678    an AU mobile re-read as NANP
 *
 *   On a delivery path that is a failed send. On a CONSENT record it is worse
 *   than having no record: it is manufactured evidence that some real person,
 *   who never saw our checkout, agreed to be texted. Use this function
 *   ANYWHERE a phone number is about to be written to, or looked up in, the
 *   consent ledger.
 *
 * THE RULE
 *   Let `digits` be every digit in the input, in order. The result must be
 *   exactly `+${digits}` or `+1${digits}`. No digit may be dropped, added,
 *   reordered, or synthesised from anything other than the NANP country code.
 *   Anything the rule cannot decide — a letter, an extension, a bare 12-digit
 *   string with no '+' to say where the country code ends — is refused.
 *
 * @param {string|number|null|undefined} raw
 * @returns {string|null} strict E.164, or null when the input is not provably
 *   the same number. Never throws.
 */
function normalisePhoneStrict(raw) {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    raw = String(raw);
  }
  if (typeof raw !== 'string') return null;

  const text = raw.trim();
  if (!text) return null;

  // A letter is either an extension marker, a vanity number, or prose. None of
  // those are a subscriber number and none may be silently discarded.
  if (CONTAINS_LETTER.test(text)) return null;
  if (EXTENSION_MARKER.test(text)) return null;

  // '+' is a country-code marker and only ever leads. Anywhere else it is
  // malformed input, and a malformed input must not be repaired into a number.
  if (text.indexOf('+', 1) !== -1) return null;

  const digits = text.replace(/\D/g, '');
  if (!digits) return null;

  let candidate;
  if (text.startsWith('+')) {
    // The customer stated the country code. Take it as written.
    candidate = `+${digits}`;
  } else if (digits.length === 10 && NANP_NATIONAL.test(digits)) {
    candidate = `+1${digits}`;
  } else if (digits.length === 11 && digits[0] === '1' && NANP_NATIONAL.test(digits.slice(1))) {
    candidate = `+${digits}`;
  } else {
    // No '+', and not a well-formed NANP number. "447506440284" might be a UK
    // number with its country code or a local number somewhere else entirely;
    // "305555123422" might be a number with an extension stuck to it. Refuse.
    return null;
  }

  // The equality gate: the output is the input's own digits, with at most a
  // NANP country code added. Given the construction directly above it can only
  // hold, and that is the point — it is an invariant assertion that fails
  // closed the moment somebody edits that construction into something which
  // drops, pads or reorders a digit. Deleting this line alone changes no
  // current behaviour; deleting it and then getting the construction wrong is
  // how the fabricated numbers got written in the first place.
  if (candidate !== `+${digits}` && candidate !== `+1${digits}`) return null;

  // A +1 number must still be a real NANP number, or "10412345678" would pass
  // as a US subscriber on the strength of its leading 1 alone.
  if (candidate.startsWith('+1') && candidate.length === 12
      && !NANP_NATIONAL.test(candidate.slice(2))) {
    return null;
  }

  return STRICT_E164.test(candidate) ? candidate : null;
}

module.exports = { normalisePhone, normalisePhoneStrict };
