'use strict';
/**
 * test/campaign-product-resolution.test.js — naming what somebody bought.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE OWNER'S POINT
 *
 *   "Everyone who's bought before should have a last product variable."
 *
 *   Right, and measured against the live audience they did not: 60 of 384
 *   people got the weaker message that names no product, despite the shop
 *   knowing exactly what they bought. Three separate causes, all fixed here.
 *
 *   1. A RENAME BROKE THE JOIN. Three products were renamed in the store to
 *      their approved codes. Orders placed before that kept the old name and
 *      have `sku: null`, so nothing was left to join on. 58 people.
 *
 *   2. A SKU DRIFTED. A discontinued variation says GTT600 while the
 *      catalogue holds P-GTT600. An exact lookup misses. 4 people.
 *
 *   3. RESOLVING IS NOT THE SAME AS BEING ABLE TO WRITE IT DOWN. The store
 *      calls one product "Melanotan II", which may not be sent to a customer.
 *      The old loop stopped at the first RESOLVABLE item, so a buyer whose
 *      biggest item was unwriteable was dropped even when a later item in the
 *      same order could have been named.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RENAMED_PRODUCTS, factsForBuyer, renamedProductFor, resolveBySkuBase, skuBase
} = require('../lib/campaigns/personalise');
const { approvedProductLabel } = require('../lib/campaigns/merge-fields');
const { RULES } = require('../lib/campaigns/copy-rules');

/** The live catalogue's shape, small enough to reason about. */
const SKU_MAP = new Map([
  ['P-RT10', 'RT'], ['RT10', 'RT'], ['RT20', 'RT'],
  ['SK10', 'Selank'], ['TSM10', 'Tesamorelin'],
  ['ML10', 'Melanotan II'], ['P-GTT600', 'Glutathione'], ['GTT1500', 'Glutathione'],
  ['P-WA10', 'BAC Water'], ['KLOW80', 'GHK-Cu + BPC-157 + TB-500 + KPV']
]);

const order = items => ({ items, created_at: '2026-04-01T00:00:00Z' });
const facts = items => factsForBuyer({ contact: { first_name: 'A' }, order: order(items), skuMap: SKU_MAP });

test('every renamed product maps to a code that may actually be written', () => {
  // The left side is a banned compound name and must never be written; the
  // right side is what the store calls that product today and IS approved.
  // If a value here ever stopped being approved, this would silently start
  // dropping people again.
  for (const [historical, code] of Object.entries(RENAMED_PRODUCTS)) {
    assert.equal(approvedProductLabel(code), code,
      `${historical} maps to "${code}", which is not an approved product code`);
    assert.ok(!RULES.defaultApprovedProductCodes.includes(historical));
  }
});

test('an order placed before a rename still names the product', () => {
  // The exact shape from production: no SKU, the old name on the line.
  const resolved = facts([{ sku: null, name: 'Retatrutide - 20mg', total: '145.00' }]);
  assert.equal(resolved.lastProductName, 'RT');
  assert.equal(approvedProductLabel(resolved.lastProductName), 'RT');
});

test('the old compound name is never what gets written', () => {
  const resolved = facts([{ sku: null, name: 'Tirzepatide - 30mg', total: '200.00' }]);
  assert.equal(resolved.lastProductName, 'TZ');
  assert.doesNotMatch(String(resolved.lastProductName), /tirzepatide/i);
});

test('a SKU that still resolves exactly is not touched by the rename map', () => {
  // renamedProductFor only fires when there is no SKU at all.
  assert.equal(renamedProductFor({ sku: 'RT20', name: 'Retatrutide - 20mg' }), null);
  assert.equal(facts([{ sku: 'RT20', name: 'Retatrutide - 20mg', total: '10' }]).lastProductName, 'RT');
});

test('a drifted SKU resolves through its base, but only when certain', () => {
  assert.equal(skuBase('P-GTT600'), 'GTT');
  assert.equal(skuBase('GTT600'), 'GTT');
  assert.equal(resolveBySkuBase('GTT600', SKU_MAP), 'Glutathione');

  // Ambiguity resolves to NOTHING. Naming the wrong product in a marketing
  // message is worse than naming none, which is the whole reason this
  // fallback is allowed to exist at all.
  const ambiguous = new Map([['AB10', 'First Thing'], ['AB20', 'Second Thing']]);
  assert.equal(resolveBySkuBase('AB30', ambiguous), null);
});

test('an unwriteable product does not cost somebody the whole message', () => {
  // THE ONE THAT LOST PEOPLE. Tesamorelin is the biggest line and cannot be
  // written; RT is smaller and can. The old loop stopped at the first
  // resolvable item and dropped this person entirely.
  const resolved = facts([
    { sku: 'TSM20', name: 'Tesamorelin - 20mg', total: '595.00' },
    { sku: 'RT20', name: 'RT - 20mg', total: '145.00' },
    { sku: 'P-WA10', name: 'BAC Water - 10ml', total: '20.00' }
  ]);
  assert.equal(resolved.lastProductName, 'RT');
});

test('a product that cannot be named readably is not named at all', () => {
  // THIS TEST USED TO ASSERT THE OPPOSITE. It checked that the SKU was used
  // when the product name could not be written, and that shipped: somebody who
  // bought BAC water was told "15% off P-WA10".
  //
  // The owner's reaction was the correct one — that does not make any sense to
  // the person reading it — so the store's own product names were added to the
  // approved list instead, and the SKU fallback was removed. A product that
  // cannot be named in words a customer would recognise now sends them the
  // copy that names no product.
  const { approvedProductLabel } = require('../lib/campaigns/merge-fields');

  // Readable names resolve to themselves.
  const named = facts([{ sku: 'ML10', name: 'Melanotan II - 10mg', total: '45.00' }]);
  assert.equal(approvedProductLabel(named.lastProductName), 'Melanotan II');

  // A banned compound name resolves to nothing, NOT to its SKU.
  const banned = facts([{ sku: 'TSM20', name: 'Tesamorelin - 20mg', total: '595.00' }]);
  assert.equal(approvedProductLabel(banned.lastProductName), '',
    'a banned product must not be smuggled in as its SKU');
});

test('what is stored is what gets written, with no second lookup', () => {
  // merge-fields renders approvedProductLabel(name || sku), and that `||`
  // short-circuits — a truthy-but-unwriteable name blocks a good SKU behind
  // it. Storing the LABEL removes the trap entirely.
  for (const items of [
    [{ sku: 'ML10', name: 'Melanotan II - 10mg', total: '45' }],
    [{ sku: 'RT20', name: 'RT - 20mg', total: '99' }],
    [{ sku: null, name: 'Retatrutide - 10mg', total: '120' }]
  ]) {
    const name = facts(items).lastProductName;
    assert.equal(approvedProductLabel(name), name,
      `stored "${name}" is not what merge-fields would render`);
  }
});

test('an order with nothing nameable reports the product but writes nothing', () => {
  // Honest on both counts: the caller can still see what they bought, and the
  // message cannot name it.
  const resolved = facts([{ sku: 'TSM20', name: 'Tesamorelin - 20mg', total: '595.00' }]);
  assert.equal(resolved.lastProductName, 'Tesamorelin');
  assert.equal(approvedProductLabel(resolved.lastProductName), '');
});
