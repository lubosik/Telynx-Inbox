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

module.exports = { normalisePhone };
