'use strict';
/**
 * test/campaign-copy-compound-names.test.js
 *
 * THE HOLE THIS CLOSES
 *
 * The catalogue calls the GLP-1 products RT, TZ and SM. That is the business
 * declining to name them, and it is the single decision keeping a peptide
 * seller outside Telnyx's prohibited categories and away from the FDA.
 *
 * It was enforced in exactly one place: the full names were kept out of
 * `defaultApprovedProductCodes`, so writing RETATRUTIDE in capitals failed the
 * ALL-CAPS check. Lower case passed. And the drafting model is handed a
 * `productName` taken straight from the WooCommerce title, under the
 * instruction "use it exactly as written", so the protection amounted to
 * nobody having renamed a product in WooCommerce yet.
 *
 * These tests assert the lexicon closes it at the validator, where a catalogue
 * edit cannot reach.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateCopy } = require('../lib/campaigns/copy-validator');
const { RULES } = require('../lib/campaigns/copy-rules');

// The sender's name is a BUSINESS DECISION and it has already changed once,
// from "Vici" to "Vin from Vici". Fixtures that hardcode it turn every one of
// these tests into a test of the current name, so 30 of them failed on a
// two-word copy change that broke nothing. Read it from the rules instead: the
// name can change again and only the rule file needs editing.
const { RULES: COPY_RULES } = require('../lib/campaigns/copy-rules');
const BRAND = COPY_RULES.brand.defaultName;


const OPTIONS = { brandName: BRAND, approvedProductCodes: RULES.defaultApprovedProductCodes };

function refusalTerms(text) {
  const result = validateCopy(text, OPTIONS);
  return (result.failures || []).filter(f => f.check === 'no_banned_terms').map(f => f.detail && f.detail.term);
}

test('a message naming a compound is refused, in any case', () => {
  for (const name of ['retatrutide', 'Retatrutide', 'RETATRUTIDE', 'tirzepatide', 'semaglutide']) {
    const text = `${BRAND}: your ${name} is back in stock. https://vicipeptides.com Reply STOP to opt out.`;
    const result = validateCopy(text, OPTIONS);
    assert.equal(result.ok, false, `"${name}" must be refused`);
    assert.ok(refusalTerms(text).includes(name.toLowerCase()),
      `the refusal must name ${name.toLowerCase()} as the reason`);
  }
});

test('the branded GLP-1 drugs are refused too', () => {
  // A message can dodge the compound name and still put the business in the
  // prohibited category by naming what people call it.
  for (const brand of ['ozempic', 'wegovy', 'mounjaro', 'zepbound']) {
    const text = `${BRAND}: ${brand} restocked today. https://vicipeptides.com Reply STOP to opt out.`;
    assert.equal(validateCopy(text, OPTIONS).ok, false, `"${brand}" must be refused`);
  }
});

test('leet evasion of a compound name is refused as well', () => {
  // Free, because the substitution check re-matches normalised text against
  // this same lexicon. It only works because the name is IN the lexicon: the
  // old ALL-CAPS-only defence saw "r3tatrutide" as an ordinary lowercase word.
  const text = `${BRAND}: r3tatrutide back in stock. https://vicipeptides.com Reply STOP to opt out.`;
  assert.equal(validateCopy(text, OPTIONS).ok, false);
});

test('the abbreviations the catalogue actually uses still pass', () => {
  // The point is not to make GLP-1 products unmentionable. RT, TZ and SM are
  // approved, and a rule that refused them would have the business quietly
  // turn the validator off.
  const text = `${BRAND}: RT is back in stock now. https://vicipeptides.com Reply STOP to opt out.`;
  const result = validateCopy(text, OPTIONS);
  assert.equal(result.ok, true, JSON.stringify(result.failures));
});

test('the word peptide is NOT banned, because it is the brand and the link', () => {
  // Banning it would refuse every compliant message this business can send.
  const text = `${BRAND}: your order shipped today. https://vicipeptides.com Reply STOP to opt out.`;
  assert.equal(validateCopy(text, OPTIONS).ok, true);
  const flat = Object.values(RULES.bannedTerms).flatMap(group => group.terms);
  assert.equal(flat.includes('peptide'), false);
  assert.equal(flat.includes('peptides'), false);
});

test('a plain reorder check-in, naming nothing, passes', () => {
  // This is the shape the revenue activity actually needs: it references the
  // relationship, not the product, and not the order history either, which
  // privacy_and_surveillance already forbids.
  const text = `${BRAND}: ready for another round? https://vicipeptides.com Reply STOP to opt out.`;
  const result = validateCopy(text, OPTIONS);
  assert.equal(result.ok, true, JSON.stringify(result.failures));
});

test('the compound lexicon is frozen like every other list', () => {
  const group = RULES.bannedTerms.compound_names_and_brands;
  assert.ok(Object.isFrozen(group.terms), 'a caller must not be able to shorten this list');
  assert.throws(() => { group.terms.push('anything'); });
});
