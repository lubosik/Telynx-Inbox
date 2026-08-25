# SMS campaign copy research

Status: implementation spec for LLM-drafted, human-approved campaign copy.
Written 23 August 2026.

This document describes product safeguards. It does not certify legal
compliance, is not legal advice, is not provider approval, and is not
permission to send anything.

## Provenance of this document

This file did not exist when the AI copy-drafting work was assigned. It was
assembled from the two research documents that did, plus the primary sources
they cite:

- `docs/campaigns/CAMPAIGN-COPY-PLAYBOOK.md` — the pre-submission review list,
  the three starter drafts, the explicit "do not say" lists per workflow, and
  the rules on links, offers, personalisation and merge fields.
- `docs/campaigns/SMS-COMPLIANCE-RESEARCH.md` — the "Copy and health-product
  claims" section, the provider eligibility gate, and the send-time
  eligibility order.
- FTC Health Products Compliance Guidance, Telnyx forbidden messaging use
  cases, Telnyx acceptable use policy for messaging, and CTIA messaging channel
  guidance, all as cited by `SMS-COMPLIANCE-RESEARCH.md`.

Nothing here is a new policy invented for the convenience of the code. Every
banned term group and every pattern below carries a `source` string naming the
document or authority it was transcribed from. Two lists are the exception
worth flagging explicitly to a reviewer, because they are *elaborations* rather
than transcriptions:

- `carrier_filter_high_risk` and `shaft_and_forbidden_categories` enumerate
  concrete words. The cited sources describe the categories and forbid the
  traffic; they do not publish a word list, because carrier filtering is not
  published. These lists are a conservative reading of those categories. They
  are deliberately over-broad — `free` blocks "free shipping", `save` blocks
  "save your spot", `treat` blocks "treat yourself" — because a false rejection
  costs a reviewer one edit and a false acceptance can get the sending number
  suspended, which takes order confirmations down with it.

If a rule below is wrong, fix it here and in `lib/campaigns/copy-rules.js` in
the same change. `test/campaign-copy-rules.test.js` fails if they diverge.

## 1. RULES

The block below is the machine-readable rule set. It is mirrored exactly by the
`RULES` constant in `lib/campaigns/copy-rules.js`, which is what the validator
and the drafting prompt actually read. The test named above parses this fenced
block out of this markdown file and asserts deep equality against that
constant, in both directions, so neither copy can drift from the other.

`promptRules` is the part that reaches the language model. Those sentences are
transported into the system prompt verbatim, numbered and newline-joined and
otherwise untouched. There is no second, friendlier restatement of them
anywhere in the codebase.

```json
{
  "version": "2026-08-23",
  "brand": {
    "defaultName": "Vin from Vici",
    "recommendedPrefix": "Vin from Vici: "
  },
  "optOut": {
    "exactSuffix": "Reply STOP to opt out."
  },
  "length": {
    "maxSeptets": 160
  },
  "links": {
    "maxPerMessage": 1,
    "requiredScheme": "https",
    "approvedHosts": [
      "vicipeptides.com",
      "www.vicipeptides.com"
    ],
    "forbiddenShortenerHosts": [
      "bit.ly",
      "tinyurl.com",
      "t.co",
      "goo.gl",
      "ow.ly",
      "buff.ly",
      "is.gd",
      "rebrand.ly",
      "cutt.ly",
      "lnkd.in",
      "shorturl.at",
      "rb.gy",
      "tiny.cc"
    ]
  },
  "allCaps": {
    "alwaysAllowedTokens": [
      "STOP"
    ],
    "allowApprovedProductCodes": true
  },
  "defaultApprovedProductCodes": ["BPC-157", "TB-500", "GHK-Cu", "PT-141", "MOTS-C", "CJC-1295", "IGF-1LR3", "KPV", "NAD", "IPA", "DAC", "BAC", "RT", "TZ", "SM", "II", "BB10", "BBG70", "BC10", "BT10", "CND10", "CP10", "CU100", "IG1", "IP10", "KLOW80", "ML10", "MT1", "PT10", "SK10", "TSM10", "XA10", "P-GTT600", "P-MS10", "P-NJ100", "P-RT10", "P-SM10", "P-TR10", "P-WA10"],
  "leetSubstitutions": {
    "primary": {
      "0": "o",
      "1": "i",
      "3": "e",
      "4": "a",
      "5": "s",
      "6": "g",
      "7": "t",
      "8": "b",
      "9": "g",
      "@": "a",
      "$": "s",
      "!": "i",
      "+": "t",
      "|": "l",
      "£": "e",
      "€": "e",
      "¥": "y",
      "§": "s",
      "¤": "o"
    },
    "alternate": {
      "0": "o",
      "1": "l",
      "3": "e",
      "4": "a",
      "5": "s",
      "6": "g",
      "7": "t",
      "8": "b",
      "9": "g",
      "@": "a",
      "$": "s",
      "!": "i",
      "+": "t",
      "|": "i",
      "£": "e",
      "€": "e",
      "¥": "y",
      "§": "s",
      "¤": "o"
    }
  },
  "bannedTerms": {
    "health_and_outcome_claims": {
      "source": "FTC Health Products Compliance Guidance; SMS-COMPLIANCE-RESEARCH.md \"Copy and health-product claims\"; CAMPAIGN-COPY-PLAYBOOK.md \"Reorder check-in\"",
      "terms": [
        "cure",
        "cures",
        "cured",
        "heal",
        "heals",
        "healed",
        "healing",
        "treat",
        "treats",
        "treated",
        "treatment",
        "therapy",
        "therapeutic",
        "diagnose",
        "diagnosis",
        "prevents",
        "prevention",
        "remedy",
        "side effect",
        "side effects",
        "clinically proven",
        "clinical results",
        "doctor recommended",
        "physician recommended",
        "fda approved",
        "fda-approved",
        "prescription",
        "prescribed",
        "weight loss",
        "fat loss",
        "muscle growth",
        "anti aging",
        "anti-aging",
        "immune boost",
        "boost your immunity",
        "recovery time",
        "transform your body",
        "before and after",
        "results you can feel"
      ]
    },
    "dosing_and_human_use": {
      "source": "CAMPAIGN-COPY-PLAYBOOK.md \"Avoid ... dosage schedules, treatment continuity\"; SMS-COMPLIANCE-RESEARCH.md \"do not generate ... dosing, human-use ... claims\"",
      "terms": [
        "dose",
        "doses",
        "dosage",
        "dosing",
        "microdose",
        "inject",
        "injects",
        "injecting",
        "injection",
        "injections",
        "injectable",
        "syringe",
        "needle",
        "subcutaneous",
        "intramuscular",
        "oral use",
        "human use",
        "human consumption",
        "take one",
        "take two",
        "twice daily",
        "once daily",
        "per day",
        "empty stomach",
        "cycle length",
        "stack with",
        "you are due",
        "youre due",
        "you're due"
      ]
    },
    "guarantees_and_substantiation": {
      "source": "CAMPAIGN-COPY-PLAYBOOK.md \"Do not say ... “guaranteed”\"; FTC Health Products Compliance Guidance",
      "terms": [
        "guarantee",
        "guarantees",
        "guaranteed",
        "proven",
        "risk free",
        "risk-free",
        "no risk",
        "100% effective",
        "miracle",
        "breakthrough",
        "best in the world",
        "number one"
      ]
    },
    "manufactured_urgency_and_scarcity": {
      "source": "CAMPAIGN-COPY-PLAYBOOK.md \"Do not say “selling fast,” “last chance” ... or quote a quantity\"; SMS-COMPLIANCE-RESEARCH.md \"do not use fake scarcity or misleading inventory claims\"",
      "terms": [
        "selling fast",
        "last chance",
        "final chance",
        "hurry",
        "act now",
        "act fast",
        "dont miss",
        "don't miss",
        "do not miss",
        "while supplies last",
        "limited time",
        "limited stock",
        "almost gone",
        "going fast",
        "ends tonight",
        "ends today",
        "expires today",
        "final hours",
        "final call",
        "urgent",
        "today only",
        "now or never"
      ]
    },
    "carrier_filter_high_risk": {
      "source": "CTIA messaging channel guidance; Telnyx acceptable use policy for messaging (both cited in SMS-COMPLIANCE-RESEARCH.md)",
      "terms": [
        "free",
        "save",
        "cash",
        "winner",
        "you won",
        "congratulations",
        "click here",
        "buy now",
        "order now",
        "shop now",
        "no obligation",
        "credit card",
        "loan",
        "debt",
        "bitcoin",
        "crypto",
        "investment",
        "earn money",
        "make money",
        "work from home",
        "cheap",
        "discount",
        "coupon",
        "promo code",
        "sale",
        "offer expires",
        "lowest price",
        "special offer",
        "exclusive deal"
      ]
    },
    "shaft_and_forbidden_categories": {
      "source": "CTIA messaging channel guidance; Telnyx forbidden messaging use cases in the US and Canada (cited in SMS-COMPLIANCE-RESEARCH.md)",
      "terms": [
        "sex",
        "sexual",
        "porn",
        "nude",
        "escort",
        "alcohol",
        "beer",
        "wine",
        "vodka",
        "whiskey",
        "liquor",
        "gun",
        "guns",
        "firearm",
        "firearms",
        "ammo",
        "ammunition",
        "tobacco",
        "cigarette",
        "vape",
        "vaping",
        "nicotine",
        "cannabis",
        "marijuana",
        "weed",
        "thc",
        "cbd",
        "kratom",
        "steroid",
        "steroids",
        "sarm",
        "sarms"
      ]
    },
    "compound_names_and_brands": {
      "source": "CAMPAIGN-COPY-PLAYBOOK.md \"Avoid ... treatment continuity\"; Telnyx forbidden messaging use cases in the US and Canada; copy-rules.js \"no generated copy may expand an abbreviation into the name it stands for\"",
      "terms": [
        "retatrutide",
        "tirzepatide",
        "semaglutide",
        "liraglutide",
        "dulaglutide",
        "cagrilintide",
        "survodutide",
        "tesamorelin",
        "ipamorelin",
        "sermorelin",
        "ozempic",
        "wegovy",
        "mounjaro",
        "zepbound",
        "saxenda",
        "victoza",
        "trulicity",
        "glp-1",
        "glp1",
        "glp 1"
      ]
    },
    "privacy_and_surveillance": {
      "source": "CAMPAIGN-COPY-PLAYBOOK.md \"Do not mention how much the customer spent, expose private purchase history, imply surveillance\"",
      "terms": [
        "you spent",
        "your last order",
        "your purchase history",
        "we noticed you",
        "we noticed that you",
        "we see you",
        "we have been watching",
        "weve been watching",
        "we've been watching",
        "you havent ordered",
        "you haven't ordered",
        "you have not ordered",
        "your account shows",
        "our records show",
        "we tracked"
      ]
    }
  },
  "bannedPatterns": [
    {
      "id": "dose_measurement",
      "pattern": "\\d+(?:\\.\\d+)?\\s*(?:mg|mcg|ug|iu|ml|cc)(?![A-Za-z])",
      "flags": "i",
      "reason": "states a measured quantity of product, which reads as a dose",
      "source": "SMS-COMPLIANCE-RESEARCH.md \"do not generate ... dosing, human-use ... claims\""
    },
    {
      "id": "quantity_on_hand_claim",
      "pattern": "\\bonly\\s+\\d+\\b|\\b\\d+\\s+(?:left|remaining|in stock|units?|spots?|slots?)\\b",
      "flags": "i",
      "reason": "quotes an inventory quantity, which the playbook forbids without an authoritative source",
      "source": "CAMPAIGN-COPY-PLAYBOOK.md \"or quote a quantity unless an authoritative source supports it\""
    },
    {
      "id": "deadline_claim",
      "pattern": "\\bends?\\s+(?:in\\s+)?\\d+\\s*(?:min|mins|minutes?|hours?|hrs?|days?)\\b",
      "flags": "i",
      "reason": "states a deadline, which needs an authoritative end time set during human review",
      "source": "CAMPAIGN-COPY-PLAYBOOK.md \"A promotion with a deadline needs an authoritative end time\""
    },
    {
      "id": "price_or_percentage_offer",
      "pattern": "[$\\u00a3\\u20ac]\\s*\\d|\\d\\s*%|%\\s*off",
      "flags": "i",
      "reason": "states a price or discount; offers are added during human review, never drafted",
      "source": "CAMPAIGN-COPY-PLAYBOOK.md \"Add a link or offer only during human review\""
    },
    {
      "id": "merge_field_or_placeholder",
      "pattern": "\\{\\{[^}]*\\}\\}|\\$\\{[^}]*\\}|%%[^%]*%%|\\[[^\\]]*\\]|<[^>]*>",
      "flags": "",
      "reason": "contains a merge field or placeholder; rendering is not implemented and a placeholder can reach a customer",
      "source": "CAMPAIGN-COPY-PLAYBOOK.md \"Do not add {{first_name}} or another merge field until rendering is implemented\""
    },
    {
      "id": "phone_number",
      "pattern": "\\+?\\d[\\d().\\-\\s]{7,}\\d",
      "flags": "",
      "reason": "contains something shaped like a phone number",
      "source": "SMS-COMPLIANCE-RESEARCH.md \"Do not copy ... unnecessary customer data\""
    },
    {
      "id": "email_address",
      "pattern": "[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}",
      "flags": "i",
      "reason": "contains an email address",
      "source": "SMS-COMPLIANCE-RESEARCH.md \"Do not copy ... unnecessary customer data\""
    },
    {
      "id": "street_address",
      "pattern": "\\b\\d{1,6}\\s+[A-Za-z0-9.'-]+(?:\\s+[A-Za-z0-9.'-]+){0,5}\\s+(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|boulevard|blvd|court|ct|way|place|pl)\\b",
      "flags": "i",
      "reason": "contains something shaped like a street address",
      "source": "SMS-COMPLIANCE-RESEARCH.md \"Do not copy ... unnecessary customer data\""
    },
    {
      "id": "stray_at_sign",
      "pattern": "@",
      "flags": "",
      "reason": "contains an @ sign, which is either an address or a character substitution",
      "source": "CTIA messaging channel guidance (cited in SMS-COMPLIANCE-RESEARCH.md)"
    },
    {
      "id": "shouted_punctuation",
      "pattern": "\\?{2,}|\\.{4,}|\\*",
      "flags": "",
      "reason": "uses repeated or decorative punctuation associated with filtered traffic",
      "source": "CTIA messaging channel guidance (cited in SMS-COMPLIANCE-RESEARCH.md)"
    }
  ],
  "checks": [
    {
      "id": "length_within_one_segment",
      "title": "The whole message, including brand, link and opt-out, fits 160 GSM-7 septets."
    },
    {
      "id": "gsm7_character_set_only",
      "title": "Every character is in the GSM 03.38 alphabet, and there are no control characters."
    },
    {
      "id": "brand_identifies_sender_first",
      "title": "The message opens with the brand so the sender is identified."
    },
    {
      "id": "exact_opt_out_suffix",
      "title": "The message ends with the exact string \"Reply STOP to opt out.\""
    },
    {
      "id": "link_count_and_destination",
      "title": "Zero or one link, https, on an approved first-party host, never a shortener."
    },
    {
      "id": "no_exclamation_marks",
      "title": "The message contains no exclamation mark."
    },
    {
      "id": "no_banned_terms",
      "title": "No banned health, dosing, guarantee, urgency, carrier-risk, SHAFT or surveillance term."
    },
    {
      "id": "no_character_substitution_evasion",
      "title": "No leetspeak or symbol substitution, which is itself a violation rather than a workaround."
    },
    {
      "id": "no_all_caps_shouting",
      "title": "No ALL-CAPS word except STOP and verified product codes."
    },
    {
      "id": "no_merge_fields_or_placeholders",
      "title": "No merge field, template placeholder or bracketed stand-in."
    },
    {
      "id": "no_customer_identifiers",
      "title": "No phone number, email address or street address."
    },
    {
      "id": "no_unsupported_quantity_price_or_deadline",
      "title": "No inventory quantity, price, discount or deadline invented by the drafter."
    }
  ],
  "promptRules": [
    "Write one SMS message and nothing else.",
    "The entire message, including the brand, any link and the opt-out sentence, must be 160 characters or fewer.",
    "Begin the message with the brand name so the recipient can tell who is texting.",
    "End the message with the exact sentence: Reply STOP to opt out.",
    "Use only plain ASCII letters, digits, spaces and the punctuation . , ? : ; ( ) / ' \" - . Do not use an em dash, an en dash, a curly quote, an ellipsis character, an emoji, or any other non-ASCII character.",
    "Do not use an exclamation mark anywhere in the message.",
    "Do not make any health, medical, therapeutic, disease, safety, efficacy or outcome claim, and do not imply one.",
    "Do not state or imply a dose, a dosage, a measurement in mg, mcg, iu or ml, an injection, a schedule, a cycle, or any human use or human consumption of the product.",
    "Do not say that the customer needs the product, is due for it, or should continue a course of it.",
    "Do not guarantee anything, and do not claim that anything is proven, clinical, doctor recommended or FDA approved.",
    "Do not invent urgency or scarcity. Do not say selling fast, last chance, hurry, act now, limited time, or while supplies last.",
    "Do not quote a quantity in stock, a price, a discount, a percentage off, a coupon, or a deadline. Offers are added by a human reviewer, never by you.",
    "Do not use the words free, save, cash, winner, congratulations, click here, buy now, order now or shop now, because carriers filter them.",
    "Do not reference the customer by name, phone number, email address, address, order number, spend, or purchase history, and do not imply that the business has been watching them.",
    "Do not use a merge field, a placeholder, square brackets, angle brackets, or curly braces.",
    "Do not write any word in capital letters except STOP.",
    "Do not substitute characters to disguise a word. Writing Fr33 or S@ve is a carrier violation in itself, not a way around one.",
    "Include a link only if you are given an approved link, and then use it exactly once and exactly as given.",
    "Phrase a reorder message as an offer to help, never as knowledge that the customer needs to reorder.",
    "Keep the tone plain, calm and factual. A boring compliant message is the goal."
  ]
}
```

## 2. The twelve-point pre-send check

`lib/campaigns/copy-validator.js` implements `RULES.checks` as code. Every
draft runs all twelve before a human is shown it. The validator does not
short-circuit on the first failure, because a reviewer wants the full list, and
it does not repair anything, because a repaired draft is a draft nobody
reviewed.

1. **length_within_one_segment.** 160 GSM-7 septets or fewer, counting the
   brand prefix, the link and the opt-out sentence. Extension-table characters
   (`^{}\[~]|€`) count as two septets each, which is why the metric is septets
   and not `String.length`.
2. **gsm7_character_set_only.** One character outside GSM 03.38 switches the
   whole message to UCS-2, which drops the single-segment limit from 160 to 70
   and roughly triples the cost. An em dash, a curly apostrophe and an ellipsis
   character all do this and all look like ordinary punctuation in a diff. The
   failure names the offending character and its code point.
3. **brand_identifies_sender_first.** The message opens with the brand.
4. **exact_opt_out_suffix.** The message ends with `Reply STOP to opt out.`
   exactly. Not "reply stop", not "Text STOP to unsubscribe."
5. **link_count_and_destination.** Zero or one link. `https` only. Host must be
   in `links.approvedHosts`. Shorteners, redirectors, raw IPs, ports, embedded
   credentials and query strings are all rejected.
6. **no_exclamation_marks.** Zero.
7. **no_banned_terms.** Word-boundary matching against every list in
   `bannedTerms`.
8. **no_character_substitution_evasion.** Two independent defences. The text is
   normalised through both substitution maps and re-matched against the banned
   terms, so `Fr33` fails the same rule `free` fails. Separately, any token that
   mixes letters with digits or with `@ $ ! + |` is rejected outright unless it
   is a verified product code or an ordinal. Character substitution is itself a
   carrier violation; it is never a way of passing a check.
9. **no_all_caps_shouting.** No run of two or more capital letters, except
   `STOP`, the brand's own capitalisation, and verified product codes supplied
   by the caller.
10. **no_merge_fields_or_placeholders.** No `{{ }}`, `${ }`, `%% %%`, `[ ]` or
    `< >`. Per-recipient rendering is not implemented; a placeholder that
    survives review reaches a customer literally.
11. **no_customer_identifiers.** No phone number, email address or street
    address. The drafter is never given customer identity, so anything of this
    shape in a draft means something upstream is wrong and the draft must not be
    shown.
12. **no_unsupported_quantity_price_or_deadline.** No inventory count, price,
    percentage off, coupon or deadline. Those come from an authoritative source
    during human review, never from a model.

## 3. Where the language model sits

The model is a **drafter**. It is not an approver and not a sender.

- It runs only when `CAMPAIGN_AI_COPY_ENABLED` is exactly the string `true`.
- It reaches OpenRouter only through `lib/openrouter-private.js`, which
  tokenises PII, restricts the model and provider, and requires zero data
  retention plus data-collection denial. There is no second client.
- It is given no customer identity at all. Not a name, not a phone number, not
  an order, not a spend figure. Cadence reaches it as an abstract phrase
  assembled server-side from a bounded integer — "last order 8 weeks ago" — and
  never as caller-supplied free text. `lib/campaigns/copy-writer.js` throws
  before the network call if an input carries anything identifier-shaped. The
  tokeniser in `openrouter-private.js` is the second line of that defence, not
  the first.
- Everything it returns runs through the twelve-point validator. A draft that
  fails is never surfaced as a candidate, and its text is not returned to the
  client either — only the rule ids it broke, so a reviewer cannot copy a
  rejected draft out of an API response.
- It returns several candidates, so a human picks and edits rather than
  accepting.
- The drafting endpoint writes nothing. It does not create a campaign, submit
  one for review, approve, schedule, or send. Those remain separate, audited,
  separately permissioned actions.

## 4. What this does not do

Passing all twelve checks means a draft is *safe to show a reviewer*. It does
not mean the message may be sent. `SMS-COMPLIANCE-RESEARCH.md` still governs:
the product must be inside the provider-approved scope, the recipient needs
evidenced promotional consent, STOP and DND must be clear, quiet hours and
frequency caps apply, and an Admin must approve the exact frozen copy.

Copy validation does not make a provider-forbidden product eligible.
