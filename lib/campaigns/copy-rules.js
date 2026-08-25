'use strict';
/**
 * lib/campaigns/copy-rules.js — the ONE machine copy of the SMS campaign copy
 * rules.
 *
 * PROVENANCE. Every rule below is transcribed from, and only from:
 *
 *   docs/campaigns/SMS-COPY-RESEARCH.md          section 1, the RULES block
 *   docs/campaigns/CAMPAIGN-COPY-PLAYBOOK.md     (the research doc's source)
 *   docs/campaigns/SMS-COMPLIANCE-RESEARCH.md    (the research doc's source)
 *
 * `RULES` below is byte-for-byte the JSON in that RULES block.
 * `test/campaign-copy-rules.test.js` parses the fenced block out of the
 * markdown and asserts deep equality in both directions, so the doc and this
 * module cannot drift. Edit one without the other and CI fails.
 *
 * WHY IT IS SHAPED LIKE THIS. `RULES.promptRules` holds the exact sentences
 * that go into the model's system prompt. They are transported verbatim —
 * `renderPromptRules()` only numbers them and joins them with newlines. There
 * is deliberately no place in this codebase where a compliance rule is
 * restated in somebody's own words, because a paraphrase is how a rule
 * quietly loosens: "do not state a dose" becomes "avoid being too specific
 * about dosing" and the model starts writing doses again.
 *
 * ON `defaultApprovedProductCodes`. This was deliberately left empty by the
 * agent that wrote this file, on the correct reasoning that an invented SKU
 * list would exempt unverified codes from the ALL-CAPS and obfuscation checks.
 * It is now populated from the live WooCommerce catalogue (25 published
 * products, read 2026-08-23), not from memory. Regenerate it rather than
 * hand-editing when the catalogue changes.
 *
 * A code here is exempt from the ALL-CAPS check ONLY. It buys no exemption
 * from the banned-claims lexicon, the length cap, GSM-7, or anything else, so
 * a listed code in an otherwise non-compliant message still fails.
 *
 * READ THIS BEFORE ADDING A NAME. The catalogue lists the GLP-1 products as
 * `RT`, `TZ` and `SM`, never as retatrutide, tirzepatide or semaglutide. That
 * is the business already declining to name them, and it is the single most
 * load-bearing compliance decision in the product data: those three are the
 * substances that put a peptide seller inside Telnyx's prohibited categories
 * and in front of the FDA. The abbreviations are approved. The full names are
 * NOT in this list and must never be added to it, and no generated copy may
 * expand an abbreviation into the name it stands for.
 */

/**
 * The rule set. Mirrors docs/campaigns/SMS-COPY-RESEARCH.md section 1.
 * @type {Readonly<object>}
 */
const RULES = {
  version: '2026-08-23',

  // WHO IS TEXTING, and why it is a person AND a company.
  //
  // The rule this feeds is `brand_identifies_sender_first`, and its stated
  // purpose is that the recipient knows who is contacting them. "Vin" alone
  // passes the mechanical check and defeats the purpose: a stranger reading
  // "Vin here, ready for another round?" has no idea who Vin is, and the two
  // things that follow are a complaint and a carrier filter.
  //
  // "Vin from Vici" keeps the person, which is the whole point of the change,
  // and still names the business in the first three words.
  brand: {
    defaultName: 'Vin from Vici',
    recommendedPrefix: 'Vin from Vici: '
  },

  optOut: {
    exactSuffix: 'Reply STOP to opt out.'
  },

  length: {
    maxSeptets: 160
  },

  links: {
    maxPerMessage: 1,
    requiredScheme: 'https',
    approvedHosts: ['vicipeptides.com', 'www.vicipeptides.com'],
    forbiddenShortenerHosts: [
      'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'buff.ly', 'is.gd',
      'rebrand.ly', 'cutt.ly', 'lnkd.in', 'shorturl.at', 'rb.gy', 'tiny.cc'
    ]
  },

  allCaps: {
    alwaysAllowedTokens: ['STOP'],
    allowApprovedProductCodes: true
  },

  // From the live WooCommerce catalogue, 2026-08-23. Display names first,
  // then internal SKUs, which can legitimately appear in an operator-written
  // message. Deliberately absent: retatrutide, tirzepatide, semaglutide.
  defaultApprovedProductCodes: [
    'BPC-157', 'TB-500', 'GHK-Cu', 'PT-141', 'MOTS-C', 'CJC-1295', 'IGF-1LR3',
    'KPV', 'NAD', 'IPA', 'DAC', 'BAC', 'RT', 'TZ', 'SM', 'II',
    'BB10', 'BBG70', 'BC10', 'BT10', 'CND10', 'CP10', 'CU100', 'IG1', 'IP10',
    'KLOW80', 'ML10', 'MT1', 'PT10', 'SK10', 'TSM10', 'XA10',
    'P-GTT600', 'P-MS10', 'P-NJ100', 'P-RT10', 'P-SM10', 'P-TR10', 'P-WA10'
  ],

  leetSubstitutions: {
    primary: {
      0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 6: 'g', 7: 't', 8: 'b', 9: 'g',
      '@': 'a', $: 's', '!': 'i', '+': 't', '|': 'l', '£': 'e', '€': 'e',
      '¥': 'y', '§': 's', '¤': 'o'
    },
    alternate: {
      0: 'o', 1: 'l', 3: 'e', 4: 'a', 5: 's', 6: 'g', 7: 't', 8: 'b', 9: 'g',
      '@': 'a', $: 's', '!': 'i', '+': 't', '|': 'i', '£': 'e', '€': 'e',
      '¥': 'y', '§': 's', '¤': 'o'
    }
  },

  bannedTerms: {
    health_and_outcome_claims: {
      source: 'FTC Health Products Compliance Guidance; SMS-COMPLIANCE-RESEARCH.md "Copy and health-product claims"; CAMPAIGN-COPY-PLAYBOOK.md "Reorder check-in"',
      terms: [
        'cure', 'cures', 'cured', 'heal', 'heals', 'healed', 'healing',
        'treat', 'treats', 'treated', 'treatment', 'therapy', 'therapeutic',
        'diagnose', 'diagnosis', 'prevents', 'prevention', 'remedy',
        'side effect', 'side effects', 'clinically proven', 'clinical results',
        'doctor recommended', 'physician recommended', 'fda approved',
        'fda-approved', 'prescription', 'prescribed', 'weight loss',
        'fat loss', 'muscle growth', 'anti aging', 'anti-aging',
        'immune boost', 'boost your immunity', 'recovery time',
        'transform your body', 'before and after', 'results you can feel'
      ]
    },
    dosing_and_human_use: {
      source: 'CAMPAIGN-COPY-PLAYBOOK.md "Avoid ... dosage schedules, treatment continuity"; SMS-COMPLIANCE-RESEARCH.md "do not generate ... dosing, human-use ... claims"',
      terms: [
        'dose', 'doses', 'dosage', 'dosing', 'microdose', 'inject', 'injects',
        'injecting', 'injection', 'injections', 'injectable', 'syringe',
        'needle', 'subcutaneous', 'intramuscular', 'oral use', 'human use',
        'human consumption', 'take one', 'take two', 'twice daily',
        'once daily', 'per day', 'empty stomach', 'cycle length', 'stack with',
        'you are due', 'youre due', "you're due"
      ]
    },
    guarantees_and_substantiation: {
      source: 'CAMPAIGN-COPY-PLAYBOOK.md "Do not say ... “guaranteed”"; FTC Health Products Compliance Guidance',
      terms: [
        'guarantee', 'guarantees', 'guaranteed', 'proven', 'risk free',
        'risk-free', 'no risk', '100% effective', 'miracle', 'breakthrough',
        'best in the world', 'number one'
      ]
    },
    manufactured_urgency_and_scarcity: {
      source: 'CAMPAIGN-COPY-PLAYBOOK.md "Do not say “selling fast,” “last chance” ... or quote a quantity"; SMS-COMPLIANCE-RESEARCH.md "do not use fake scarcity or misleading inventory claims"',
      terms: [
        'selling fast', 'last chance', 'final chance', 'hurry', 'act now',
        'act fast', 'dont miss', "don't miss", 'do not miss',
        'while supplies last', 'limited time', 'limited stock', 'almost gone',
        'going fast', 'ends tonight', 'ends today', 'expires today',
        'final hours', 'final call', 'urgent', 'today only', 'now or never'
      ]
    },
    carrier_filter_high_risk: {
      source: 'CTIA messaging channel guidance; Telnyx acceptable use policy for messaging (both cited in SMS-COMPLIANCE-RESEARCH.md)',
      terms: [
        'free', 'save', 'cash', 'winner', 'you won', 'congratulations',
        'click here', 'buy now', 'order now', 'shop now', 'no obligation',
        'credit card', 'loan', 'debt', 'bitcoin', 'crypto', 'investment',
        'earn money', 'make money', 'work from home', 'cheap', 'discount',
        'coupon', 'promo code', 'sale', 'offer expires', 'lowest price',
        'special offer', 'exclusive deal'
      ]
    },
    shaft_and_forbidden_categories: {
      source: 'CTIA messaging channel guidance; Telnyx forbidden messaging use cases in the US and Canada (cited in SMS-COMPLIANCE-RESEARCH.md)',
      terms: [
        'sex', 'sexual', 'porn', 'nude', 'escort', 'alcohol', 'beer', 'wine',
        'vodka', 'whiskey', 'liquor', 'gun', 'guns', 'firearm', 'firearms',
        'ammo', 'ammunition', 'tobacco', 'cigarette', 'vape', 'vaping',
        'nicotine', 'cannabis', 'marijuana', 'weed', 'thc', 'cbd', 'kratom',
        'steroid', 'steroids', 'sarm', 'sarms'
      ]
    },
    // THE SINGLE MOST IMPORTANT GROUP IN THIS FILE.
    // The catalogue calls the GLP-1 products RT, TZ and SM. That abbreviation
    // is the business declining to name them, and it is what keeps a peptide
    // seller outside Telnyx's prohibited categories and out of the FDA's way.
    // It was only half a defence: nothing stopped the drafting model writing
    // the full name, and `productName` is handed to that model with the words
    // "use it exactly as written", straight from the WooCommerce title. One
    // product renamed in WooCommerce and the compound name lands in an SMS.
    // Banning the names here closes it at the layer that cannot be bypassed by
    // a catalogue edit, and the substitution-evasion check gets "r3tatrutide"
    // free, because it re-matches normalised text against this same lexicon.
    // NOT banned, deliberately: the word "peptide". It is the brand name and
    // the link host, and banning it would refuse every compliant message.
    compound_names_and_brands: {
      source: 'CAMPAIGN-COPY-PLAYBOOK.md "Avoid ... treatment continuity"; Telnyx forbidden messaging use cases in the US and Canada; copy-rules.js "no generated copy may expand an abbreviation into the name it stands for"',
      terms: [
        'retatrutide', 'tirzepatide', 'semaglutide', 'liraglutide',
        'dulaglutide', 'cagrilintide', 'survodutide', 'tesamorelin',
        'ipamorelin', 'sermorelin', 'ozempic', 'wegovy', 'mounjaro',
        'zepbound', 'saxenda', 'victoza', 'trulicity', 'glp-1', 'glp1',
        'glp 1'
      ]
    },
    privacy_and_surveillance: {
      source: 'CAMPAIGN-COPY-PLAYBOOK.md "Do not mention how much the customer spent, expose private purchase history, imply surveillance"',
      // LOOSENED, DELIBERATELY, AND NOT ALL OF IT.
      //
      // Referring to somebody's own order history is the entire point of a
      // reorder or a loyalty message: "four orders in" is why the message is
      // worth sending at all, and a customer already knows what they bought.
      // So "your last order" and "you haven't ordered" are no longer refused.
      //
      // What stays refused is the language that implies SURVEILLANCE rather
      // than a relationship. "We tracked", "we have been watching", "our
      // records show" and "your account shows" describe a system observing a
      // person; "you have ordered four times" describes a customer. The
      // difference is not squeamishness, it is the difference between a
      // message that reads as thoughtful and one that reads as creepy, and
      // the second gets reported.
      //
      // "you spent" stays banned too. Order COUNT earns goodwill; quoting
      // somebody the money they have given you does not, and it is the one
      // fact here that is genuinely sensitive.
      // THE LINE IS BETWEEN THEIR HISTORY AND YOUR OBSERVATION OF IT.
      //
      // "You have ordered four times" and "it has been a while since your last
      // order" are allowed: a customer knows what they bought, and referring
      // to it is the reason a reorder message is worth sending at all.
      //
      // "We noticed you", "we see you" and "we tracked" are still refused,
      // because they narrate the business WATCHING rather than the customer
      // buying. It is the same fact and a completely different message, and
      // the second one gets reported rather than replied to.
      //
      // "you spent" stays banned as well. Order count earns goodwill; quoting
      // somebody the money they have handed over does not, and it is the one
      // fact in here that is genuinely sensitive.
      terms: [
        'you spent', 'your purchase history',
        'we noticed you', 'we noticed that you', 'we see you',
        'we have been watching', 'weve been watching', "we've been watching",
        'your account shows', 'our records show', 'we tracked',
        'we are watching', 'we know you', 'we can see that you'
      ]
    }
  },

  bannedPatterns: [
    {
      id: 'dose_measurement',
      pattern: '\\d+(?:\\.\\d+)?\\s*(?:mg|mcg|ug|iu|ml|cc)(?![A-Za-z])',
      flags: 'i',
      reason: 'states a measured quantity of product, which reads as a dose',
      source: 'SMS-COMPLIANCE-RESEARCH.md "do not generate ... dosing, human-use ... claims"'
    },
    {
      id: 'quantity_on_hand_claim',
      pattern: '\\bonly\\s+\\d+\\b|\\b\\d+\\s+(?:left|remaining|in stock|units?|spots?|slots?)\\b',
      flags: 'i',
      reason: 'quotes an inventory quantity, which the playbook forbids without an authoritative source',
      source: 'CAMPAIGN-COPY-PLAYBOOK.md "or quote a quantity unless an authoritative source supports it"'
    },
    {
      id: 'deadline_claim',
      pattern: '\\bends?\\s+(?:in\\s+)?\\d+\\s*(?:min|mins|minutes?|hours?|hrs?|days?)\\b',
      flags: 'i',
      reason: 'states a deadline, which needs an authoritative end time set during human review',
      source: 'CAMPAIGN-COPY-PLAYBOOK.md "A promotion with a deadline needs an authoritative end time"'
    },
    {
      // A PERCENTAGE IS NOW ALLOWED. A CURRENCY AMOUNT IS STILL NOT.
      //
      // "15% off with code THANKYOU" is the offer, and hiding the number makes
      // the message weaker for no compliance gain: the code carries the
      // discount either way and the recipient finds out at checkout.
      //
      // A currency symbol next to a digit stays refused. It is a much stronger
      // spam signal to carrier filters than a percentage, it invites the
      // "$500 winner" shape those filters are built to catch, and nothing this
      // business wants to say needs one.
      id: 'price_or_percentage_offer',
      pattern: '[$\\u00a3\\u20ac]\\s*\\d',
      flags: 'i',
      reason: 'states a currency amount, which carrier filters score heavily; a percentage is permitted',
      source: 'CAMPAIGN-COPY-PLAYBOOK.md "Add a link or offer only during human review"'
    },
    {
      // NARROWED FROM A BAN TO AN ALLOWLIST.
      //
      // This used to refuse every {{...}}, and the stated reason was exact:
      // "rendering is not implemented and a placeholder can reach a customer."
      // That was true. Rendering exists now, in lib/campaigns/merge-fields.js,
      // so the {{ }} form is permitted and checked against the field table by
      // `no_unknown_merge_fields` in the validator.
      //
      // Every OTHER placeholder shape is still refused here, because none of
      // them renders: ${...}, %%...%%, [...] and <...> would all reach a
      // customer as literal characters, which is precisely the original fear.
      id: 'merge_field_or_placeholder',
      pattern: '\\$\\{[^}]*\\}|%%[^%]*%%|\\[[^\\]]*\\]|<[^>]*>',
      flags: '',
      reason: 'contains a placeholder shape that nothing renders, so it would reach a customer as literal text',
      source: 'CAMPAIGN-COPY-PLAYBOOK.md "Do not add {{first_name}} or another merge field until rendering is implemented"'
    },
    {
      id: 'phone_number',
      pattern: '\\+?\\d[\\d().\\-\\s]{7,}\\d',
      flags: '',
      reason: 'contains something shaped like a phone number',
      source: 'SMS-COMPLIANCE-RESEARCH.md "Do not copy ... unnecessary customer data"'
    },
    {
      id: 'email_address',
      pattern: '[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}',
      flags: 'i',
      reason: 'contains an email address',
      source: 'SMS-COMPLIANCE-RESEARCH.md "Do not copy ... unnecessary customer data"'
    },
    {
      id: 'street_address',
      pattern: '\\b\\d{1,6}\\s+[A-Za-z0-9.\'-]+(?:\\s+[A-Za-z0-9.\'-]+){0,5}\\s+(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|boulevard|blvd|court|ct|way|place|pl)\\b',
      flags: 'i',
      reason: 'contains something shaped like a street address',
      source: 'SMS-COMPLIANCE-RESEARCH.md "Do not copy ... unnecessary customer data"'
    },
    {
      id: 'stray_at_sign',
      pattern: '@',
      flags: '',
      reason: 'contains an @ sign, which is either an address or a character substitution',
      source: 'CTIA messaging channel guidance (cited in SMS-COMPLIANCE-RESEARCH.md)'
    },
    {
      id: 'shouted_punctuation',
      pattern: '\\?{2,}|\\.{4,}|\\*',
      flags: '',
      reason: 'uses repeated or decorative punctuation associated with filtered traffic',
      source: 'CTIA messaging channel guidance (cited in SMS-COMPLIANCE-RESEARCH.md)'
    }
  ],

  checks: [
    { id: 'length_within_one_segment', title: 'The whole message, including brand, link and opt-out, fits 160 GSM-7 septets.' },
    { id: 'gsm7_character_set_only', title: 'Every character is in the GSM 03.38 alphabet, and there are no control characters.' },
    { id: 'brand_identifies_sender_first', title: 'The message opens with the brand so the sender is identified.' },
    { id: 'exact_opt_out_suffix', title: 'The message ends with the exact string "Reply STOP to opt out."' },
    { id: 'link_count_and_destination', title: 'Zero or one link, https, on an approved first-party host, never a shortener.' },
    { id: 'no_exclamation_marks', title: 'The message contains no exclamation mark.' },
    { id: 'no_banned_terms', title: 'No banned health, dosing, guarantee, urgency, carrier-risk, SHAFT or surveillance term.' },
    { id: 'no_character_substitution_evasion', title: 'No leetspeak or symbol substitution, which is itself a violation rather than a workaround.' },
    { id: 'no_all_caps_shouting', title: 'No ALL-CAPS word except STOP and verified product codes.' },
    { id: 'no_merge_fields_or_placeholders', title: 'Only approved {{merge fields}}. No other placeholder or bracketed stand-in.' },
    { id: 'no_customer_identifiers', title: 'No phone number, email address or street address.' },
    { id: 'no_unsupported_quantity_price_or_deadline', title: 'No inventory quantity, price, discount or deadline invented by the drafter.' }
  ],

  promptRules: [
    'Write one SMS message and nothing else.',
    'The entire message, including the brand, any link and the opt-out sentence, must be 160 characters or fewer.',
    'Begin the message with the brand name so the recipient can tell who is texting.',
    'End the message with the exact sentence: Reply STOP to opt out.',
    'Use only plain ASCII letters, digits, spaces and the punctuation . , ? : ; ( ) / \' " - . Do not use an em dash, an en dash, a curly quote, an ellipsis character, an emoji, or any other non-ASCII character.',
    'Do not use an exclamation mark anywhere in the message.',
    'Do not make any health, medical, therapeutic, disease, safety, efficacy or outcome claim, and do not imply one.',
    'Do not state or imply a dose, a dosage, a measurement in mg, mcg, iu or ml, an injection, a schedule, a cycle, or any human use or human consumption of the product.',
    'Do not say that the customer needs the product, is due for it, or should continue a course of it.',
    'Do not guarantee anything, and do not claim that anything is proven, clinical, doctor recommended or FDA approved.',
    'Do not invent urgency or scarcity. Do not say selling fast, last chance, hurry, act now, limited time, or while supplies last.',
    'Do not quote a quantity in stock, a price, a discount, a percentage off, a coupon, or a deadline. Offers are added by a human reviewer, never by you.',
    'Do not use the words free, save, cash, winner, congratulations, click here, buy now, order now or shop now, because carriers filter them.',
    'Do not reference the customer by name, phone number, email address, address, order number, spend, or purchase history, and do not imply that the business has been watching them.',
    'Do not use a merge field, a placeholder, square brackets, angle brackets, or curly braces.',
    'Do not write any word in capital letters except STOP.',
    'Do not substitute characters to disguise a word. Writing Fr33 or S@ve is a carrier violation in itself, not a way around one.',
    'Include a link only if you are given an approved link, and then use it exactly once and exactly as given.',
    'Phrase a reorder message as an offer to help, never as knowledge that the customer needs to reorder.',
    'Keep the tone plain, calm and factual. A boring compliant message is the goal.'
  ]
};

/**
 * Freeze the whole tree, not just the top level. `Object.freeze(RULES)` alone
 * leaves `RULES.bannedTerms.shaft_and_forbidden_categories.terms` mutable, and
 * a compliance list a caller can `.push()` into is not a constant.
 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** GSM 03.38 basic character set, minus the control characters. */
const GSM7_BASIC =
  '@£$¥èéùìòÇØøÅå' +
  'Δ_ΦΓΛΩΠΨΣΘΞÆæßÉ' +
  ' !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§' +
  '¿abcdefghijklmnopqrstuvwxyzäöñüà';

/** GSM 03.38 extension characters. Each costs two septets, not one. */
const GSM7_EXTENDED = '^{}\\[~]|€';

/** Control characters that are technically encodable but not allowed here. */
const FORBIDDEN_CONTROL = '\n\r\t\f';

const GSM7_BASIC_SET = new Set(GSM7_BASIC);
const GSM7_EXTENDED_SET = new Set(GSM7_EXTENDED);

/**
 * Every banned term, flattened, each carrying the category and the citation it
 * came from. Sorted longest first so a phrase is reported before a word inside
 * it ("last chance" rather than "chance").
 */
function flattenedBannedTerms(rules = RULES) {
  const flattened = [];
  for (const [category, group] of Object.entries(rules.bannedTerms)) {
    for (const term of group.terms) {
      flattened.push({ term, category, source: group.source });
    }
  }
  return flattened.sort((a, b) => b.term.length - a.term.length);
}

/**
 * The system-prompt rule block, transported verbatim.
 *
 * The only transformation applied to a rule sentence is numbering. Nothing
 * here rewrites, shortens, merges or "clarifies" a rule, because that is
 * exactly where a compliance constraint gets softened without anyone noticing.
 */
function renderPromptRules(rules = RULES) {
  return rules.promptRules.map((rule, index) => `${index + 1}. ${rule}`).join('\n');
}

module.exports = {
  RULES: deepFreeze(RULES),
  GSM7_BASIC,
  GSM7_EXTENDED,
  GSM7_BASIC_SET,
  GSM7_EXTENDED_SET,
  FORBIDDEN_CONTROL,
  flattenedBannedTerms,
  renderPromptRules
};
