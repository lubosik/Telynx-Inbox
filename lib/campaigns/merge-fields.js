'use strict';
/**
 * lib/campaigns/merge-fields.js — the only variables a message may contain.
 *
 * WHAT CHANGED AND WHY THE OLD RULE WAS RIGHT AT THE TIME
 *
 * Merge fields used to be banned outright, and the stated reason was exact:
 * "rendering is not implemented and a placeholder can reach a customer".
 * Nothing substituted anything, so `{{first_name}}` in a message meant a
 * customer receiving the literal characters {{first_name}}. Banning it was
 * correct while that was true.
 *
 * Rendering exists now, so the ban becomes an ALLOWLIST rather than
 * disappearing. Three properties survive the change, and they are the whole
 * reason this file exists rather than a regex being relaxed:
 *
 *   1. ONLY THESE FIELDS. A field not in this table is still refused by the
 *      validator, because an unknown placeholder is exactly the failure the
 *      old rule feared and it has not become less likely.
 *
 *   2. EVERY FIELD HAS A FALLBACK. A message that cannot render for somebody
 *      is a message that must still be sendable to them, or the audience
 *      silently shrinks at the last moment.
 *
 *   3. LENGTH IS CHECKED AT THE WORST CASE, not the average. "Hi {{first_name}}"
 *      is 16 characters as a template and 25 for a Christopher. A 160 septet
 *      cap validated before substitution is not a cap at all, and the person
 *      it breaks for is always the one with the longest name.
 *
 * WHAT IS DELIBERATELY NOT A FIELD
 *
 * No spend, no order total, no phone number, no email, no address, no dose.
 * Quoting somebody their own money back at them reads as surveillance and
 * buys nothing that order count does not.
 *
 * ON `last_order_date`, WHICH THIS LIST USED TO REFUSE
 *
 * The exclusion above used to end "no date of an order", on the same
 * surveillance reasoning. The business owner reversed that on 29 Aug 2026 for
 * the one-time-buyer win-back, whose whole premise is a message that sounds
 * like the owner remembering a specific customer rather than a system firing:
 * "the last time you ordered was back in June".
 *
 * The reversal is narrowed rather than taken whole. The field renders a MONTH
 * NAME and never a calendar date. "back in June" is how a person who
 * remembers you talks; "on 19 February" is how a database talks, and the
 * difference is most of what the original objection was about. A precise date
 * also dates the purchase to the day for anyone who reads the message over
 * the recipient's shoulder, which for this catalogue is a real cost and buys
 * nothing.
 *
 * Every order in this database is inside 215 days, so a bare month is
 * unambiguous. If that ever stops being true this field must gain a year, and
 * `maxLength` below must grow with it.
 *
 * PRODUCT NAMES ARE THE DANGEROUS ONE
 *
 * The catalogue contains "Retatrutide - 20mg". Rendering that into a message
 * puts a compound name and a dose in front of a carrier. `last_product` is
 * therefore rendered through the APPROVED CODE for the product and never its
 * raw title, and the rendered message is validated again per recipient, so a
 * product that cannot be named safely removes that one recipient rather than
 * quietly shipping.
 */

const { RULES } = require('./copy-rules');

/** Opening and closing delimiters. Doubled braces, mustache-style. */
const OPEN = '{{';
const CLOSE = '}}';

/**
 * Longest value each field is allowed to render to.
 *
 * Used for worst-case length validation at draft time. A value longer than
 * this is truncated at render, so the number here is a promise the renderer
 * keeps rather than a hope about the data.
 */
const FIELDS = Object.freeze({
  first_name: Object.freeze({
    description: "The customer's first name, capitalised.",
    maxLength: 12,
    // Not "there". A message that says "Hi there" to somebody whose name is
    // missing is obviously a broken mail merge; one that says "Hi" is just a
    // message. The fallback is chosen to be invisible, not to be filled in.
    fallback: '',
    render: (facts) => firstNameFrom(facts?.contactName)
  }),
  order_count: Object.freeze({
    description: 'How many paid orders they have placed, as a numeral.',
    maxLength: 3,
    fallback: '',
    render: (facts) => {
      const count = Number(facts?.orderCount);
      return Number.isInteger(count) && count > 0 ? String(count) : '';
    }
  }),
  last_product: Object.freeze({
    description: 'The approved code for the last thing they bought. Never the full product name.',
    maxLength: 12,
    fallback: '',
    render: (facts) => approvedProductLabel(facts?.lastProductName || facts?.lastProductSku)
  }),
  code: Object.freeze({
    description: 'A discount code issued to this one person.',
    maxLength: 16,
    fallback: '',
    render: (facts) => sanitiseCode(facts?.couponCode)
  }),
  last_order_date: Object.freeze({
    description: 'The month of their last order, as a name. Never a calendar date.',
    // "September" is the longest month name at 9 characters.
    maxLength: 9,
    fallback: '',
    render: (facts) => monthNameFrom(facts?.lastOrderAt)
  })
});

const FIELD_NAMES = Object.freeze(Object.keys(FIELDS));

/** `{{ first_name }}` and `{{first_name}}` are the same field. */
const TOKEN = /\{\{\s*([a-z_]{1,32})\s*\}\}/g;

/**
 * First name from a full name, title-cased.
 *
 * 863 of this account's names are already title case and 69 are all lower
 * case, which are real names typed casually rather than junk. Sending "hi
 * chloe" reads as a bot; normalising is the difference between a merge that
 * looks handmade and one that looks automated.
 */
function firstNameFrom(fullName) {
  const first = String(fullName || '').trim().split(/\s+/)[0] || '';
  if (!first) return '';
  // Anything that is not plainly a name is dropped rather than guessed at. A
  // single letter, a number, or an address is worse in a greeting than nothing.
  if (first.length < 2 || !/^[A-Za-zÀ-ÿ'-]+$/.test(first)) return '';
  return first[0].toUpperCase() + first.slice(1).toLowerCase();
}

/**
 * The approved code for a product, or nothing.
 *
 * Deliberately refuses rather than passes through. "Retatrutide - 20mg" is a
 * compound name and a dose; there is no safe way to shorten it into something
 * that is neither, so a product with no approved code renders to nothing and
 * the message reads as though the phrase was never there.
 */
function approvedProductLabel(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  const normalise = (text) => text.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const target = normalise(value);
  for (const code of RULES.defaultApprovedProductCodes) {
    const normalisedCode = normalise(code);
    if (!normalisedCode) continue;
    if (target === normalisedCode) return code;
  }
  // A SKU that is itself an approved code, e.g. "RT10", arrives here already.
  // Anything else, including every full compound name, renders to nothing.
  return '';
}

/**
 * The month an order was placed, in English, or nothing.
 *
 * UTC deliberately, matching how every other date in this system is stored and
 * compared. The alternative is the business time zone, which would move an
 * order placed late on the 31st into the previous month for a customer who
 * would say it happened in the new one. Neither is right for everybody; UTC is
 * at least the one the stored value already means, so the rendered month
 * always matches the timestamp an operator sees next to it in the app.
 */
const MONTH_NAMES = Object.freeze([
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]);

function monthNameFrom(raw) {
  if (!raw) return '';
  const time = raw instanceof Date ? raw.getTime() : Date.parse(raw);
  if (!Number.isFinite(time)) return '';
  return MONTH_NAMES[new Date(time).getUTCMonth()] || '';
}

/** Codes are compared case-insensitively in WooCommerce, so they are lower. */
function sanitiseCode(raw) {
  const value = String(raw || '').trim().toLowerCase();
  return /^[a-z0-9-]{4,16}$/.test(value) ? value : '';
}

/** Every field named in a template, in order, deduplicated. */
function fieldsUsed(template) {
  const found = [];
  for (const match of String(template || '').matchAll(TOKEN)) {
    if (!found.includes(match[1])) found.push(match[1]);
  }
  return found;
}

/** Any field a template names that this module cannot render. */
function unknownFields(template) {
  return fieldsUsed(template).filter(name => !Object.hasOwn(FIELDS, name));
}

/**
 * The template with every field at its longest permitted value.
 *
 * This is what the length check must run against. Validating "Hi
 * {{first_name}}" at 16 septets and then sending 25 to a Christopher is how a
 * campaign silently becomes two segments for the people with the longest names.
 */
function worstCase(template) {
  return String(template || '').replace(TOKEN, (whole, name) => {
    const field = FIELDS[name];
    if (!field) return whole;
    return 'W'.repeat(field.maxLength);
  });
}

/**
 * Render a template for one person.
 *
 * @param {string} template
 * @param {object} facts  contactName, orderCount, lastProductName, couponCode
 * @returns {{text: string, missing: string[]}} `missing` names the fields that
 *   fell back, so a caller can decide whether the result is worth sending.
 */
function render(template, facts = {}) {
  const missing = [];
  const text = String(template || '').replace(TOKEN, (whole, name) => {
    const field = FIELDS[name];
    if (!field) return whole;
    let value = '';
    try {
      value = String(field.render(facts) ?? '');
    } catch {
      value = '';
    }
    if (!value) {
      missing.push(name);
      return field.fallback;
    }
    return value.slice(0, field.maxLength);
  });
  // A dropped field leaves "Hi , ready" or a double space behind it. Tidying
  // is not cosmetic: punctuation stranded by an empty merge is the clearest
  // possible signal to a recipient that they are receiving a mailshot.
  return { text: tidy(text), missing };
}

/** Collapse the wreckage an empty substitution leaves behind. */
function tidy(text) {
  return String(text)
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/([,:])\s*([,.!?])/g, '$2')
    .replace(/\bHi\s*,\s*/gi, 'Hi. ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+\./g, '.')
    .trim();
}

module.exports = {
  CLOSE,
  FIELDS,
  FIELD_NAMES,
  OPEN,
  TOKEN,
  approvedProductLabel,
  fieldsUsed,
  firstNameFrom,
  render,
  sanitiseCode,
  unknownFields,
  worstCase
};
