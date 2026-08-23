'use strict';
/**
 * buildGenerationInput with real product identity.
 *
 * The behaviour under test is the two-level identity: dose variants share a
 * CADENCE series and keep separate STOCK, and a restock reaches the buyers of
 * the vial that came back rather than everyone who ever bought the molecule.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildGenerationInput } = require('../lib/campaigns/generation-service');
const { catalogueEntries, catalogueInventoryRows } = require('../lib/campaigns/product-catalogue');

const NOW = new Date('2026-08-23T12:00:00.000Z');
const PHONE = '+15555550123';
const OTHER = '+15555550999';

const RT = {
  id: 551, sku: 'P-RT10', name: 'RT', type: 'variable', status: 'publish',
  purchasable: true, stock_status: 'instock', stock_quantity: 251, manage_stock: true
};
const RT_VARIATIONS = [
  { id: 566, sku: 'RT10', name: '10mg', status: 'publish', purchasable: true, stock_status: 'instock', stock_quantity: 158, manage_stock: true, attributes: [{ option: '10mg' }] },
  { id: 567, sku: 'RT20', name: '20mg', status: 'publish', purchasable: true, stock_status: 'instock', stock_quantity: 344, manage_stock: true, attributes: [{ option: '20mg' }] },
  { id: 568, sku: 'RT30', name: '30mg', status: 'publish', purchasable: true, stock_status: 'instock', stock_quantity: 58, manage_stock: true, attributes: [{ option: '30mg' }] }
];
// Live shape: the parent reports out of stock while the variation has 30 units.
const BPC = {
  id: 577, sku: 'BC10', name: 'BPC-157', type: 'variable', status: 'publish',
  purchasable: true, stock_status: 'outofstock', stock_quantity: 0, manage_stock: true
};
const BPC_VARIATIONS = [
  { id: 611, sku: 'BC10', name: '10mg', status: 'publish', purchasable: true, stock_status: 'instock', stock_quantity: 30, manage_stock: true, attributes: [{ option: '10mg' }] }
];

const ENTRIES = [...catalogueEntries(RT, RT_VARIATIONS), ...catalogueEntries(BPC, BPC_VARIATIONS)];
const INVENTORY = catalogueInventoryRows({ fetchedAt: '2026-08-23T11:59:00Z', entries: ENTRIES }, { now: NOW });

function order(id, phone, createdAt, items) {
  return { id, woo_order_id: id, contact_phone: phone, status: 'completed', created_at: createdAt, total: 195, items };
}

function sources(orders, overrides = {}) {
  return {
    orders,
    contacts: [{ id: 5, phone: PHONE }, { id: 6, phone: OTHER }],
    inventory: [],
    catalogueEntries: ENTRIES,
    catalogueInventory: INVENTORY,
    catalogueAvailable: true,
    restockEvents: [],
    opportunities: [],
    ledger: [],
    suppressions: [],
    support: [
      { contact_phone: PHONE, status: 'clear', observed_at: '2026-08-23T11:00:00Z' },
      { contact_phone: OTHER, status: 'clear', observed_at: '2026-08-23T11:00:00Z' }
    ],
    supportAvailable: true,
    ...overrides
  };
}

/** Four purchases roughly 30 days apart, printed under three different names. */
const TITRATION = [
  order(1, PHONE, '2026-04-20T12:00:00Z', [{ sku: 'RT10', name: 'RT - 10mg', quantity: 1, total: '195.00' }]),
  order(2, PHONE, '2026-05-20T12:00:00Z', [{ sku: null, name: 'Retatrutide - 20mg', quantity: 1, total: '195.00' }]),
  order(3, PHONE, '2026-06-19T12:00:00Z', [{ sku: 'RT20', name: 'GLP3-Ret - 20mg', quantity: 1, total: '195.00' }]),
  order(4, PHONE, '2026-07-19T12:00:00Z', [{ sku: null, name: 'Retatrutide - 30mg', quantity: 1, total: '195.00' }])
];

test('legacy sku/name line items now produce a reorder candidate', () => {
  const input = buildGenerationInput(sources(TITRATION), { now: NOW, workflows: ['reorder'] });
  assert.equal(input.reorderCandidates.length, 1);
  assert.equal(input.sourceCoverage.nonExactOrderItems, 0);
  assert.equal(input.sourceCoverage.productIdentity.resolved, 4);
});

test('dose titration is ONE cadence series, not three', () => {
  const input = buildGenerationInput(sources(TITRATION), { now: NOW, workflows: ['reorder'] });
  const [candidate] = input.reorderCandidates;
  assert.equal(candidate.productID, 551);
  assert.equal(candidate.purchases.length, 4,
    'splitting by dose would leave 1+2+1 and no reliable cadence at all');
  assert.equal(candidate.variationID, 568, 'the candidate names the vial bought most recently');
});

test('the resulting cadence is reliable, which is the whole point', () => {
  const { calculateReorderCadence } = require('../lib/campaigns/reorder-cadence');
  const input = buildGenerationInput(sources(TITRATION), { now: NOW, workflows: ['reorder'] });
  const result = calculateReorderCadence({
    purchases: input.reorderCandidates[0].purchases,
    productCadence: input.reorderCandidates[0].productCadence,
    now: NOW
  });
  assert.equal(result.cadence.reliable, true);
  assert.equal(result.cadence.intervalCount, 3);
  assert.ok(Math.abs(result.cadence.medianDays - 30) < 1);
});

test('two lines of one order for the same vial are one purchase', () => {
  const duplicated = [order(9, PHONE, '2026-04-20T12:00:00Z', [
    { sku: 'RT10', name: 'RT - 10mg', quantity: 1, total: '195.00' },
    { sku: 'RT10', name: 'RT - 10mg', quantity: 1, total: '195.00' }
  ])];
  const input = buildGenerationInput(sources(duplicated), { now: NOW, workflows: ['reorder'] });
  assert.equal(input.reorderCandidates[0].purchases.length, 1);
});

test('an in-stock variation is not suppressed by a stale out-of-stock parent', () => {
  const orders = [order(1, PHONE, '2026-07-19T12:00:00Z', [{ sku: 'BC10', name: 'BPC-157 - 10mg', quantity: 1, total: '60.00' }])];
  const input = buildGenerationInput(sources(orders), { now: NOW, workflows: ['reorder'] });
  assert.equal(input.reorderCandidates.length, 1, 'the 30 units on the variation are the real fact');
  assert.equal(input.reorderCandidates[0].variationID, 611);
});

test('an unresolved item is counted and produces no candidate', () => {
  const orders = [order(1, PHONE, '2026-07-19T12:00:00Z', [
    { sku: 'LC600', name: 'L-carnitine - 600mg + 10ml', quantity: 1, total: '40.00' }
  ])];
  const input = buildGenerationInput(sources(orders), { now: NOW, workflows: ['reorder'] });
  assert.equal(input.reorderCandidates.length, 0);
  assert.equal(input.sourceCoverage.nonExactOrderItems, 1);
  assert.equal(input.sourceCoverage.productIdentity.unresolvedReasons.sku_not_in_catalogue, 1);
});

test('a catalogue outage yields no candidates and says so, rather than guessing', () => {
  const input = buildGenerationInput(
    sources(TITRATION, { catalogueEntries: [], catalogueInventory: [], catalogueAvailable: false }),
    { now: NOW, workflows: ['reorder'] }
  );
  assert.equal(input.reorderCandidates.length, 0);
  assert.equal(input.sourceCoverage.catalogueAvailable, false);
  assert.equal(input.sourceCoverage.productIdentity.unresolvedReasons.catalogue_unavailable, 4);
});

test('a variation restock reaches the buyers of THAT vial only', () => {
  const orders = [
    order(1, PHONE, '2026-06-19T12:00:00Z', [{ sku: 'RT10', name: 'RT - 10mg', quantity: 1, total: '195.00' }]),
    order(2, OTHER, '2026-06-19T12:00:00Z', [{ sku: 'RT30', name: 'RT - 30mg', quantity: 1, total: '295.00' }])
  ];
  const input = buildGenerationInput(sources(orders, {
    restockEvents: [{
      id: 77, product_id: 551, variation_id: 566, name: 'RT', delivery_id: 'woo-77',
      previous_stock_status: 'outofstock', current_stock_status: 'instock',
      previous_quantity: 0, current_quantity: 158,
      received_at: '2026-08-23T11:30:00Z', signature_valid: true
    }]
  }), { now: NOW, workflows: ['back_in_stock'] });
  assert.equal(input.backInStockCandidates.length, 1);
  assert.equal(input.backInStockCandidates[0].phone, PHONE,
    'the 30mg buyer must not be told the 10mg vial is back');
});

test('a parent-level restock reaches every buyer of the product', () => {
  const orders = [
    order(1, PHONE, '2026-06-19T12:00:00Z', [{ sku: 'RT10', name: 'RT - 10mg', quantity: 1, total: '195.00' }]),
    order(2, OTHER, '2026-06-19T12:00:00Z', [{ sku: 'RT30', name: 'RT - 30mg', quantity: 1, total: '295.00' }])
  ];
  const input = buildGenerationInput(sources(orders, {
    restockEvents: [{
      id: 78, product_id: 551, variation_id: 0, name: 'RT', delivery_id: 'woo-78',
      previous_stock_status: 'outofstock', current_stock_status: 'instock',
      previous_quantity: 0, current_quantity: 251,
      received_at: '2026-08-23T11:30:00Z', signature_valid: true
    }]
  }), { now: NOW, workflows: ['back_in_stock'] });
  assert.deepEqual(input.backInStockCandidates.map(row => row.phone).sort(), [PHONE, OTHER].sort());
});

test('catalogue stock alone creates no back-in-stock candidate', () => {
  // Every product in the fixture is in stock and 761 people have bought them.
  // With no verified restock EVENT the answer must still be nobody.
  const input = buildGenerationInput(sources(TITRATION), { now: NOW, workflows: ['back_in_stock'] });
  assert.equal(input.backInStockCandidates.length, 0);
  assert.ok(input.sourceCoverage.inventory > 0, 'stock is known');
  assert.equal(input.sourceCoverage.restockEvents, 0, 'but nothing came back');
});

test('a webhook inventory row beats an older catalogue row and loses to a newer one', () => {
  const stale = { product_id: 551, variation_id: 568, stock_status: 'outofstock', stock_quantity: 0, updated_at: '2026-08-23T10:00:00Z' };
  const fresh = { product_id: 551, variation_id: 568, stock_status: 'outofstock', stock_quantity: 0, updated_at: '2026-08-23T11:59:30Z' };

  const older = buildGenerationInput(sources(TITRATION, { inventory: [stale] }), { now: NOW, workflows: ['reorder'] });
  assert.equal(older.reorderCandidates.length, 1, 'the newer catalogue read wins');

  const newer = buildGenerationInput(sources(TITRATION, { inventory: [fresh] }), { now: NOW, workflows: ['reorder'] });
  assert.equal(newer.reorderCandidates.length, 0, 'the newer webhook row wins');
});

test('a prior reorder contact for one dose suppresses the whole series', () => {
  const ledger = [{
    contact_phone: PHONE, workflow_category: 'reorder', product_id: 551, variation_id: 566,
    accepted_at: '2026-08-01T12:00:00Z'
  }];
  const input = buildGenerationInput(sources(TITRATION, { ledger }), { now: NOW, workflows: ['reorder'] });
  assert.equal(input.reorderCandidates[0].alreadyContactedForLastPurchase, true,
    'one molecule is one conversation, whichever vial it was about');
});

test('coverage reports identity in full, so a regression is visible on the summary', () => {
  const input = buildGenerationInput(sources(TITRATION), { now: NOW, workflows: ['reorder'] });
  const coverage = input.sourceCoverage;
  assert.equal(coverage.catalogueAvailable, true);
  assert.equal(coverage.inventoryFromCatalogue, INVENTORY.length);
  assert.equal(coverage.inventoryFromWebhook, 0);
  assert.equal(coverage.productIdentity.items, 4);
  assert.deepEqual(Object.keys(coverage.productIdentity.byMethod).sort(), ['catalogue_sku', 'curated_alias']);
});
