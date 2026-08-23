'use strict';
/**
 * The resolver's job is to be RIGHT or to say nothing. Most of these tests are
 * therefore about refusal: the cases where a resolver that wanted a better
 * number would guess, and this one must not.
 *
 * The fixture mirrors the live Vici catalogue, including the three shapes that
 * actually caused trouble there:
 *   - a parent and its own variation carrying the SAME SKU (P-WA10)
 *   - two combination products whose component lists are a subset of one
 *     another (BBG70 with three peptides, KLOW80 with the same three plus KPV)
 *   - a parent whose printed dose no longer exists as a variation (Glutathione
 *     sold at 600mg historically, catalogued only at 1500mg today)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCatalogueIndex,
  componentKey,
  emptyCatalogueIndex,
  normaliseDose,
  resolveOrderItemIdentity,
  splitProductName,
  summariseResolutions
} = require('../lib/campaigns/product-identity');
const { catalogueEntries } = require('../lib/campaigns/product-catalogue');

function product(overrides = {}) {
  return {
    id: 1, sku: '', name: '', type: 'variable', status: 'publish',
    purchasable: true, stock_status: 'instock', stock_quantity: 10, manage_stock: true,
    ...overrides
  };
}

function variation(overrides = {}) {
  return {
    id: 1, sku: '', name: '', status: 'publish', purchasable: true,
    stock_status: 'instock', stock_quantity: 10, manage_stock: true,
    attributes: [], ...overrides
  };
}

/** A miniature of the live catalogue. */
function fixtureIndex() {
  const entries = [
    ...catalogueEntries(product({ id: 551, sku: 'P-RT10', name: 'RT' }), [
      variation({ id: 566, sku: 'RT10', name: '10mg', attributes: [{ option: '10mg' }] }),
      variation({ id: 567, sku: 'RT20', name: '20mg', attributes: [{ option: '20mg' }] }),
      variation({ id: 568, sku: 'RT30', name: '30mg', attributes: [{ option: '30mg' }] })
    ]),
    ...catalogueEntries(product({ id: 556, sku: 'P-TR10', name: 'TZ' }), [
      variation({ id: 572, sku: 'TR20', name: '20mg', attributes: [{ option: '20mg' }] }),
      variation({
        id: 573, sku: 'TR30', name: '30mg', attributes: [{ option: '30mg' }],
        stock_status: 'outofstock', stock_quantity: 0
      })
    ]),
    // Parent and variation share one SKU, exactly as BAC Water does live.
    ...catalogueEntries(product({ id: 549, sku: 'P-WA10', name: 'BAC Water' }), [
      variation({ id: 623, sku: 'P-WA10', name: '10ml', attributes: [{ option: '10ml' }] })
    ]),
    // Two combos, one a strict superset of the other.
    ...catalogueEntries(product({ id: 579, sku: 'BBG70', name: 'GHK-Cu + BPC-157 + TB-500' }), [
      variation({ id: 608, sku: 'BBG70', name: '70mg', attributes: [{ option: '70mg' }] })
    ]),
    ...catalogueEntries(product({ id: 550, sku: 'KLOW80', name: 'GHK-Cu + BPC-157 + TB-500 + KPV' }), [
      variation({ id: 609, sku: 'KLOW80', name: '80mg', attributes: [{ option: '80mg' }] })
    ]),
    ...catalogueEntries(product({ id: 577, sku: 'BC10', name: 'BPC-157', stock_status: 'outofstock', stock_quantity: 0 }), [
      variation({ id: 611, sku: 'BC10', name: '10mg', attributes: [{ option: '10mg' }] })
    ]),
    // The 600mg vial this shop used to sell is gone; only 1500mg is catalogued.
    ...catalogueEntries(product({ id: 553, sku: 'P-GTT600', name: 'Glutathione' }), [
      variation({ id: 565, sku: 'GTT1500', name: '1500mg', attributes: [{ option: '1500mg' }] })
    ]),
    // A draft with no name and no SKU must never become a match target.
    ...catalogueEntries(product({ id: 624, sku: '', name: '', type: 'simple', status: 'draft' }), [])
  ];
  return buildCatalogueIndex(entries);
}

test('a dose suffix is split off only when it is actually a dose', () => {
  assert.deepEqual(splitProductName('Retatrutide - 30mg'), { base: 'retatrutide', dose: '30mg' });
  assert.deepEqual(splitProductName('BPC-157 + TB-500 - 10mg + 10mg'),
    { base: 'bpc-157 + tb-500', dose: '10mg + 10mg' });
  assert.deepEqual(splitProductName('PT-141 - 10mg'), { base: 'pt-141', dose: '10mg' });
  // "GLP2 - Tirz" must keep its whole name: "Tirz" is not a dose.
  assert.deepEqual(splitProductName('GLP2 - Tirz - 30mg'), { base: 'glp2 - tirz', dose: '30mg' });
  assert.deepEqual(splitProductName('GLP2 - Tirz'), { base: 'glp2 - tirz', dose: null });
  assert.deepEqual(splitProductName('GHK-Cu'), { base: 'ghk-cu', dose: null });
  assert.equal(normaliseDose('10 mg + 10 mg'), '10mg + 10mg');
});

test('SKU equality resolves the exact vial', () => {
  const index = fixtureIndex();
  const result = resolveOrderItemIdentity({ sku: 'RT20', name: 'RT - 20mg' }, index);
  assert.equal(result.resolved, true);
  assert.equal(result.method, 'catalogue_sku');
  assert.equal(result.productID, 551);
  assert.equal(result.variationID, 567);
  assert.equal(result.doseResolved, true);
});

test('a SKU shared by a parent and its own variation resolves to the variation', () => {
  const index = fixtureIndex();
  const result = resolveOrderItemIdentity({ sku: 'P-WA10', name: 'BAC Water - 10ml' }, index);
  assert.equal(result.resolved, true);
  assert.equal(result.productID, 549);
  assert.equal(result.variationID, 623, 'the more specific record wins over its own parent');
});

test('dose variants are one parent and different vials', () => {
  const index = fixtureIndex();
  const ten = resolveOrderItemIdentity({ sku: null, name: 'Retatrutide - 10mg' }, index);
  const thirty = resolveOrderItemIdentity({ sku: null, name: 'Retatrutide - 30mg' }, index);
  assert.equal(ten.productID, thirty.productID, 'same molecule, so one cadence series');
  assert.notEqual(ten.variationID, thirty.variationID, 'different vial, so different stock');
  assert.equal(ten.variationID, 566);
  assert.equal(thirty.variationID, 568);
  assert.equal(ten.method, 'curated_alias');
});

test('the same product under three different printed names resolves to one identity', () => {
  const index = fixtureIndex();
  // All three of these spellings appear in the live order history for one SKU.
  const spellings = [
    { sku: 'RT20', name: 'RT - 20mg' },
    { sku: 'RT20', name: 'GLP3-Ret - 20mg' },
    { sku: null, name: 'Retatrutide - 20mg' }
  ];
  const resolved = spellings.map(item => resolveOrderItemIdentity(item, index));
  assert.deepEqual([...new Set(resolved.map(row => `${row.productID}:${row.variationID}`))], ['551:567']);
});

test('a combination product is one identity and is never decomposed into its parts', () => {
  const index = fixtureIndex();
  const combo = resolveOrderItemIdentity({ sku: 'BBG70', name: 'GHK-Cu + BPC-157 + TB-500 - 70mg' }, index);
  const part = resolveOrderItemIdentity({ sku: 'BC10', name: 'BPC-157 - 10mg' }, index);
  assert.equal(combo.productID, 579);
  assert.equal(part.productID, 577);
  assert.notEqual(combo.productID, part.productID,
    'buying the bundle and later buying one peptide is two series, not one');
});

test('component matching is SET EQUALITY, so a subset combo never claims a superset combo', () => {
  const index = fixtureIndex();
  const three = resolveOrderItemIdentity({ sku: null, name: 'GLOW (TB + BPC-157 + GHK) - 70mg' }, index);
  const four = resolveOrderItemIdentity({ sku: null, name: 'KLOW (TB + BPC-157 + GHK + KPV) - 80mg' }, index);
  assert.equal(three.productID, 579, 'three peptides is BBG70');
  assert.equal(four.productID, 550, 'the same three plus KPV is a different product');
  assert.notEqual(three.productID, four.productID);
  assert.notEqual(componentKey('ghk-cu + bpc-157 + tb-500'), componentKey('ghk-cu + bpc-157 + tb-500 + kpv'));
});

test('an unknown product stays unresolved rather than becoming a near neighbour', () => {
  const index = fixtureIndex();
  const result = resolveOrderItemIdentity({ sku: 'LC600', name: 'L-carnitine - 600mg + 10ml' }, index);
  assert.equal(result.resolved, false);
  assert.equal(result.productID, null);
  assert.deepEqual(result.reasons, ['name_not_in_catalogue', 'sku_not_in_catalogue']);
});

test('a SKU is never matched by prefix', () => {
  const index = fixtureIndex();
  // 'KLOW' is a real legacy SKU in the order history and 'KLOW80' is the
  // catalogue SKU. Prefix matching would join them; equality must not.
  const result = resolveOrderItemIdentity({ sku: 'KLOW', name: 'Something Unlisted' }, index);
  assert.equal(result.resolved, false);
  assert.ok(result.reasons.includes('sku_not_in_catalogue'));
});

test('a SKU and a name naming two different parents resolves to neither', () => {
  const index = fixtureIndex();
  const result = resolveOrderItemIdentity({ sku: 'RT20', name: 'BPC-157 - 10mg' }, index);
  assert.equal(result.resolved, false);
  assert.deepEqual(result.reasons, ['sku_name_conflict']);
});

test('a discontinued vial keeps the parent and refuses to invent a dose', () => {
  const index = fixtureIndex();
  const result = resolveOrderItemIdentity({ sku: 'GTT600', name: 'Glutathione - 600mg' }, index);
  assert.equal(result.resolved, true, 'the molecule is still identifiable');
  assert.equal(result.productID, 553);
  assert.equal(result.variationID, 0, 'the 600mg vial is gone, so no vial is claimed');
  assert.equal(result.doseResolved, false);
  assert.ok(result.reasons.includes('dose_not_in_catalogue'));
  assert.notEqual(result.variationID, 565, 'must not silently become the 1500mg vial');
});

test('a SKU whose vial contradicts the printed dose keeps the parent and drops the vial', () => {
  const index = fixtureIndex();
  // Live shape: SKU CU100 (the 100mg vial) printed as "GHK-Cu - 50mg".
  const result = resolveOrderItemIdentity({ sku: 'RT20', name: 'RT - 25mg' }, index);
  assert.equal(result.resolved, true);
  assert.equal(result.productID, 551);
  assert.equal(result.variationID, 0);
  assert.ok(result.reasons.includes('sku_dose_conflict'));
});

test('a name with no dose adopts the sole vial, and refuses when there are several', () => {
  const index = fixtureIndex();
  const sole = resolveOrderItemIdentity({ sku: null, name: 'Glutathione' }, index);
  assert.equal(sole.variationID, 565, 'one published vial leaves nothing to choose');

  const several = resolveOrderItemIdentity({ sku: null, name: 'RT' }, index);
  assert.equal(several.resolved, true);
  assert.equal(several.productID, 551);
  assert.equal(several.variationID, 0);
  assert.ok(several.reasons.includes('dose_missing_from_order_item'));
});

test('an ambiguous name resolves to nothing', () => {
  const index = buildCatalogueIndex([
    ...catalogueEntries(product({ id: 1, sku: 'A1', name: 'Peptide' }), []),
    ...catalogueEntries(product({ id: 2, sku: 'B1', name: 'Peptide' }), [])
  ]);
  const result = resolveOrderItemIdentity({ sku: null, name: 'Peptide' }, index);
  assert.equal(result.resolved, false);
  assert.deepEqual(result.reasons, ['ambiguous_name']);
});

test('an ambiguous SKU across two parents resolves to nothing', () => {
  const index = buildCatalogueIndex([
    ...catalogueEntries(product({ id: 1, sku: 'DUP', name: 'One' }), []),
    ...catalogueEntries(product({ id: 2, sku: 'DUP', name: 'Two' }), [])
  ]);
  const result = resolveOrderItemIdentity({ sku: 'DUP', name: 'Unlisted' }, index);
  assert.equal(result.resolved, false);
  assert.deepEqual(result.reasons, ['ambiguous_sku']);
});

test('a draft product is never a match target', () => {
  const index = fixtureIndex();
  assert.equal(index.byProductID.has(624), false);
  const result = resolveOrderItemIdentity({ sku: '', name: '' }, index);
  assert.equal(result.resolved, false);
});

test('Woo identifiers on the line item are believed without the catalogue', () => {
  const result = resolveOrderItemIdentity(
    { product_id: 42, variation_id: 7, name: 'Exact' }, emptyCatalogueIndex(), { catalogueAvailable: false }
  );
  assert.equal(result.resolved, true);
  assert.equal(result.method, 'order_item_ids');
  assert.equal(result.productID, 42);
  assert.equal(result.variationID, 7);
});

test('a catalogue outage produces no identity rather than a stale one', () => {
  const result = resolveOrderItemIdentity(
    { sku: 'RT20', name: 'RT - 20mg' }, emptyCatalogueIndex(), { catalogueAvailable: false }
  );
  assert.equal(result.resolved, false);
  assert.deepEqual(result.reasons, ['catalogue_unavailable']);
});

test('the summary counts every unresolved item so the gap cannot go silent', () => {
  const index = fixtureIndex();
  const items = [
    { sku: 'RT20', name: 'RT - 20mg' },
    { sku: null, name: 'Retatrutide - 10mg' },
    { sku: 'LC600', name: 'L-carnitine - 600mg + 10ml' },
    { sku: 'GTT600', name: 'Glutathione - 600mg' }
  ];
  const summary = summariseResolutions(items.map(item => resolveOrderItemIdentity(item, index)));
  assert.equal(summary.items, 4);
  assert.equal(summary.resolved, 3);
  assert.equal(summary.unresolved, 1);
  assert.equal(summary.doseResolved, 2);
  assert.equal(summary.unresolvedReasons.sku_not_in_catalogue, 1);
  assert.equal(summary.resolvedWithNotes.dose_not_in_catalogue, 1);
});

test('MUTATION: relaxing set equality to subset containment would merge two real products', () => {
  const index = fixtureIndex();
  const three = resolveOrderItemIdentity({ sku: null, name: 'GHK-Cu + BPC-157 + TB-500 - 70mg' }, index);
  const four = resolveOrderItemIdentity({ sku: null, name: 'GHK-Cu + BPC-157 + TB-500 + KPV - 80mg' }, index);
  assert.ok(three.resolved && four.resolved);
  assert.notEqual(three.productID, four.productID,
    'if this ever passes as equal, KLOW buyers inherit BBG70 cadence and vice versa');
});
