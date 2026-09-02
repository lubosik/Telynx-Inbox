'use strict';
/**
 * test/campaign-attempted-product-field.test.js — naming what somebody tried
 * to buy, without ever claiming they bought it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS FIELD EXISTS SEPARATELY
 *
 *   122 people have no paid order at all: $18,932 of attempts, 71 of them for
 *   RT, every one still reachable. A campaign to them needs to name the thing
 *   they tried to buy, which is the most useful sentence it could contain.
 *
 *   `{{last_product}}` cannot do it and must not be made to. That field means
 *   "what they bought", and a message naming a product somebody never received
 *   is a lie they can catch — twelve people were told "saw you ordered RT in
 *   May" about a cancelled May order, and that is the exact mistake it now
 *   refuses to make.
 *
 *   Measured before this field existed: three sampled recipients from the
 *   segment all came back `missing: ["last_product"]`, which means
 *   render-recipients would have dropped all 122 as unpersonalisable. A
 *   campaign that silently reaches nobody is worse than one that is never
 *   written.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { FIELDS, render, worstCase } = require('../lib/campaigns/merge-fields');
const { validateCopy, septetLength } = require('../lib/campaigns/copy-validator');
const { RULES } = require('../lib/campaigns/copy-rules');

test('attempted_product renders an approved label, like last_product does', () => {
  const facts = { attemptedProductName: 'RT', attemptedProductSku: 'RT20' };
  assert.equal(FIELDS.attempted_product.render(facts), 'RT');
});

test('a product nobody can name in words is still not named', () => {
  // The same rule last_product follows. Naming a SKU at a customer shipped
  // once and told somebody who bought BAC water they had money off "P-WA10",
  // which the owner rightly called nonsense.
  const facts = { attemptedProductName: 'Some Unlisted Thing', attemptedProductSku: 'ZZ99' };
  assert.equal(FIELDS.attempted_product.render(facts), '');
});

test('the two fields never describe the same order', () => {
  // A buyer's interesting product is the one they received; an attempt only
  // matters when there is no purchase. Populating both would create a second
  // answer to "what should this message name", which is the fault this
  // codebase keeps repeating.
  const buyer = { lastProductName: 'RT', attemptedProductName: null };
  assert.equal(FIELDS.last_product.render(buyer), 'RT');
  assert.equal(FIELDS.attempted_product.render(buyer), '');

  const neverBought = { lastProductName: null, attemptedProductName: 'GHK-Cu' };
  assert.equal(FIELDS.last_product.render(neverBought), '');
  assert.equal(FIELDS.attempted_product.render(neverBought), 'GHK-Cu');
});

test('the recovery copy renders and validates at worst case', () => {
  // A template that fits with "RT" and breaks with "BPC-157 + TB-500" drops
  // people at send time, which is how a campaign quietly reaches half its list.
  const template = "Hi {{first_name}}, it's Vin from Vici. Your {{attempted_product}} order never "
    + 'went through, so I put BACK20 on your account for 20% off if you want another go. '
    + 'Reply STOP to opt out.';

  const worst = worstCase(template);
  assert.ok(septetLength(worst) <= RULES.length.maxSeptets,
    `worst case is ${septetLength(worst)} septets`);

  const rendered = render(template, {
    contactName: 'Konstantinos', attemptedProductName: 'BPC-157 + TB-500'
  });
  assert.deepEqual(rendered.missing, [], 'nobody is dropped for a missing field');
  const verdict = validateCopy(rendered.text, {
    brandName: RULES.brand.defaultName,
    approvedProductCodes: [...RULES.defaultApprovedProductCodes, 'BACK20']
  });
  assert.ok(verdict.ok, `rendered copy must be compliant: ${JSON.stringify(verdict.failures)}`);
});

test('somebody who bought nothing and tried nothing nameable is still dropped', () => {
  // Correct rather than a gap: there is no honest product to name, and the
  // alternative is sending "Your  order never went through".
  const rendered = render('Vici. Your {{attempted_product}} order. Reply STOP to opt out.', {});
  assert.deepEqual(rendered.missing, ['attempted_product']);
});
