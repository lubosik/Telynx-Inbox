'use strict';

const { RULES } = require('./copy-rules');

// The validator's check IDs and evidence remain machine-readable. This is the
// operator-facing explanation used by both the copy check and the later review
// gate, so a saved draft cannot fail with a different, technical instruction.
function campaignCopyFeedback(failure) {
  const detail = failure?.detail || {};
  switch (failure?.check) {
    case 'length_within_one_segment': {
      const used = Number(detail.septets);
      const extra = Number.isFinite(used) ? Math.max(1, used - RULES.length.maxSeptets) : null;
      if (detail.worstCase) {
        return `Shorten the Message by at least ${extra || 'a few'} character${extra === 1 ? '' : 's'}. A longer customer name or other personalized detail could otherwise make it too long.`;
      }
      return extra
        ? `Shorten the Message by at least ${extra} standard character${extra === 1 ? '' : 's'} so it fits in two text-message parts.`
        : 'Enter a message before continuing.';
    }
    case 'gsm7_character_set_only':
      return failure.reason;
    case 'brand_identifies_sender_first':
      return `Start the Message with "${RULES.brand.defaultName}", or put it immediately after a short greeting such as "Hi Sam,".`;
    case 'exact_opt_out_suffix':
      return `Add "${RULES.optOut.exactSuffix}" to the very end of the Message.`;
    case 'link_count_and_destination':
      return 'Check the link in the Message. Use no more than one full, secure Vici website link. Remove shortened links, tracking details, login details, or custom ports.';
    case 'no_exclamation_marks':
      return 'Remove the exclamation mark from the Message.';
    case 'no_banned_terms':
      return detail.term
        ? `Remove or reword "${detail.term}" in the Message. That claim is not allowed in a Vici campaign text.`
        : 'Remove the unsupported claim from the Message.';
    case 'no_character_substitution_evasion':
      return detail.token
        ? `Write "${detail.token}" as an ordinary word or remove it from the Message. Do not mix letters with numbers or symbols to disguise a word.`
        : 'Remove the disguised claim from the Message. Do not replace letters with numbers or symbols.';
    case 'no_all_caps_shouting':
      return detail.token
        ? `Change "${detail.token}" to normal capitalization in the Message.`
        : 'Use normal capitalization in the Message.';
    case 'no_merge_fields_or_placeholders':
      return detail.term
        ? `Replace "{{${detail.term}}}" with a field from the Variables list in the Message step, or remove it.`
        : 'Remove the unfinished placeholder from the Message, or insert a supported field from Variables.';
    case 'no_customer_identifiers':
      return 'Remove the customer-specific phone number, email, or address from the Message. Use an approved field from Variables for personalization.';
    case 'no_unsupported_quantity_price_or_deadline':
      return 'Remove the unverified stock count, price, discount, or deadline from the Message. Only include offers and facts verified for this campaign.';
    default:
      return 'Edit the Message to remove the unsupported wording, then check it again.';
  }
}

module.exports = { campaignCopyFeedback };
