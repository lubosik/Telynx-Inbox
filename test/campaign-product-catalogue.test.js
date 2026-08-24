'use strict';
/**
 * The cache exists so a segment recompute does not make 24 WooCommerce
 * requests. The tests that matter are the failure ones: a provider outage must
 * cost the run its candidates, never its correctness and never the whole
 * generation.
 *
 * The last test in this file is a guard, not a behaviour test. Reading current
 * stock is a FIRST SIGHTING. `isRestockTransition()` returns false without a
 * previous snapshot precisely because a first sighting of "in stock" is not
 * evidence that anything came back, and the tempting shortcut when the event
 * table is empty is to synthesise events from the catalogue. That would text
 * every prior buyer of every in-stock product at once.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  catalogueEntries,
  catalogueInventoryRows,
  fetchProductCatalogue,
  invalidateProductCatalogue,
  primeProductCatalogue,
  productCatalogue,
  variationDose
} = require('../lib/campaigns/product-catalogue');
const { isRestockTransition } = require('../lib/campaigns/product-webhooks');
const { currentInventory } = require('../lib/campaigns/generation-service');

const HEADERS = { get: () => '1' };

function fakeWoo({ products = [], variations = {}, failAfter = Infinity } = {}) {
  let calls = 0;
  const paths = [];
  const reader = async (path, params) => {
    calls += 1;
    paths.push(path);
    if (calls > failAfter) throw new Error('woocommerce unavailable');
    if (path === '/products') {
      return { data: params?.page > 1 ? [] : products, headers: HEADERS };
    }
    const match = /^\/products\/(\d+)\/variations$/.exec(path);
    if (match) return { data: variations[Number(match[1])] || [], headers: HEADERS };
    throw new Error(`unexpected path ${path}`);
  };
  reader.calls = () => calls;
  reader.paths = () => paths;
  return reader;
}

const PRODUCTS = [
  { id: 551, sku: 'P-RT10', name: 'RT', type: 'variable', status: 'publish', purchasable: true, stock_status: 'instock', stock_quantity: 251, manage_stock: true },
  { id: 577, sku: 'BC10', name: 'BPC-157', type: 'variable', status: 'publish', purchasable: true, stock_status: 'outofstock', stock_quantity: 0, manage_stock: true }
];
const VARIATIONS = {
  551: [{ id: 566, sku: 'RT10', name: '10mg', status: 'publish', purchasable: true, stock_status: 'instock', stock_quantity: 158, manage_stock: true, attributes: [{ option: '10mg' }] }],
  577: [{ id: 611, sku: 'BC10', name: '10mg', status: 'publish', purchasable: true, stock_status: 'instock', stock_quantity: 30, manage_stock: true, attributes: [{ option: '10mg' }] }]
};

test.beforeEach(() => { primeProductCatalogue(null); });
test.after(() => { primeProductCatalogue(null); });

test('the catalogue is read as parents plus variations', async () => {
  const woo = fakeWoo({ products: PRODUCTS, variations: VARIATIONS });
  const snapshot = await fetchProductCatalogue(woo);
  assert.equal(snapshot.productCount, 2);
  assert.equal(snapshot.variationCount, 2);
  assert.equal(snapshot.entries.length, 4, 'two parents and two variations');
  assert.deepEqual(woo.paths(), ['/products', '/products/551/variations', '/products/577/variations']);
  assert.equal(variationDose({ attributes: [{ option: '20 mg' }] }), '20mg');
});

test('a second read inside the TTL does not touch WooCommerce', async () => {
  const woo = fakeWoo({ products: PRODUCTS, variations: VARIATIONS });
  const now = new Date('2026-08-23T12:00:00Z');
  const first = await productCatalogue({ wooGet: woo, env: {}, now });
  const callsAfterFirst = woo.calls();
  const second = await productCatalogue({ wooGet: woo, env: {}, now: new Date('2026-08-23T12:05:00Z') });
  assert.equal(woo.calls(), callsAfterFirst, 'served from cache');
  assert.equal(second.fetchedAt, first.fetchedAt);
  assert.equal(second.stale, false);
});

test('the TTL expires and the webhook invalidation is immediate', async () => {
  const woo = fakeWoo({ products: PRODUCTS, variations: VARIATIONS });
  await productCatalogue({ wooGet: woo, env: { CAMPAIGN_CATALOGUE_TTL_MS: '1000' }, now: new Date('2026-08-23T12:00:00Z') });
  const afterFirst = woo.calls();
  await productCatalogue({ wooGet: woo, env: { CAMPAIGN_CATALOGUE_TTL_MS: '1000' }, now: new Date('2026-08-23T12:00:05Z') });
  assert.ok(woo.calls() > afterFirst, 'TTL is the backstop');

  const afterTTL = woo.calls();
  invalidateProductCatalogue();
  await productCatalogue({ wooGet: woo, env: {}, now: new Date('2026-08-23T12:00:06Z') });
  assert.ok(woo.calls() > afterTTL, 'invalidation is the primary mechanism');
});

test('concurrent callers share one read', async () => {
  const woo = fakeWoo({ products: PRODUCTS, variations: VARIATIONS });
  const now = new Date('2026-08-23T12:00:00Z');
  await Promise.all([
    productCatalogue({ wooGet: woo, env: {}, now }),
    productCatalogue({ wooGet: woo, env: {}, now }),
    productCatalogue({ wooGet: woo, env: {}, now })
  ]);
  assert.equal(woo.calls(), 3, 'one product list plus two variation reads, not nine');
});

test('a failed refresh keeps the last good snapshot and marks it stale', async () => {
  const woo = fakeWoo({ products: PRODUCTS, variations: VARIATIONS, failAfter: 3 });
  const good = await productCatalogue({ wooGet: woo, env: {}, now: new Date('2026-08-23T12:00:00Z') });
  assert.equal(good.available, true);

  const later = await productCatalogue({
    wooGet: woo, env: {}, now: new Date('2026-08-23T14:00:00Z'), forceRefresh: true
  });
  assert.equal(later.available, true);
  assert.equal(later.stale, true, 'the caller is told, rather than being handed a fresh-looking lie');
  assert.equal(later.fetchedAt, good.fetchedAt);
  assert.equal(later.error, 'woocommerce unavailable');
  assert.equal(later.ageMs, 2 * 60 * 60 * 1000);
});

test('a first read that fails reports unavailable instead of throwing', async () => {
  const woo = fakeWoo({ failAfter: 0 });
  const result = await productCatalogue({ wooGet: woo, env: {}, now: new Date('2026-08-23T12:00:00Z') });
  assert.equal(result.available, false);
  assert.deepEqual(result.entries, []);
  assert.equal(result.error, 'woocommerce unavailable');
});

test('inventory rows keep the shape currentInventory already understands', () => {
  const now = new Date('2026-08-23T12:00:00Z');
  const snapshot = { fetchedAt: '2026-08-23T11:59:00Z', entries: catalogueEntries(PRODUCTS[0], VARIATIONS[551]) };
  const rows = catalogueInventoryRows(snapshot, { now });
  const variationRow = rows.find(row => row.variation_id === 566);
  assert.equal(variationRow.workspace_id, 'vici');
  assert.equal(variationRow.product_id, 551);
  assert.equal(variationRow.stock_status, 'instock');
  assert.equal(variationRow.stock_quantity, 158);
  assert.equal(currentInventory(variationRow, now), true);
});

test('a catalogue read that finished after the evaluation instant is clamped, not rejected', () => {
  // The live failure: a run captures `now`, then spends eight seconds reading
  // WooCommerce, so every row looked future-dated and currentInventory refused
  // all 55 of them with inventory_unknown_or_unavailable.
  const now = new Date('2026-08-23T12:00:00Z');
  const snapshot = { fetchedAt: '2026-08-23T12:00:08Z', entries: catalogueEntries(PRODUCTS[0], VARIATIONS[551]) };
  const rows = catalogueInventoryRows(snapshot, { now });
  assert.equal(rows[0].updated_at, now.toISOString());
  assert.equal(currentInventory(rows[0], now), true);

  // Clamping only ever moves a timestamp backwards.
  const old = catalogueInventoryRows(
    { fetchedAt: '2026-08-20T12:00:00Z', entries: catalogueEntries(PRODUCTS[0], VARIATIONS[551]) }, { now }
  );
  assert.equal(old[0].updated_at, '2026-08-20T12:00:00.000Z');
  assert.equal(currentInventory(old[0], now), false, 'a three day old observation is still refused');
});

test('an unpurchasable product is recorded as out of stock whatever its status field says', () => {
  const rows = catalogueInventoryRows({
    fetchedAt: '2026-08-23T12:00:00Z',
    entries: catalogueEntries(
      { id: 900, sku: 'X', name: 'X', type: 'simple', status: 'publish', purchasable: false, stock_status: 'instock', stock_quantity: 5 }, []
    )
  }, { now: new Date('2026-08-23T12:00:00Z') });
  assert.equal(rows[0].stock_status, 'outofstock');
  assert.equal(currentInventory(rows[0], new Date('2026-08-23T12:00:00Z')), false);
});

test('GUARD: reading the catalogue is a first sighting and never a restock', () => {
  // Every entry the catalogue reports as in stock, offered to the transition
  // rule with no previous snapshot, must produce no restock. If someone later
  // seeds `previous` from the same catalogue read to "make back in stock work",
  // this is the test that should stop them.
  const entries = [...catalogueEntries(PRODUCTS[0], VARIATIONS[551]), ...catalogueEntries(PRODUCTS[1], VARIATIONS[577])];
  const rows = catalogueInventoryRows({ fetchedAt: '2026-08-23T12:00:00Z', entries });
  for (const row of rows) {
    assert.equal(isRestockTransition(null, row), false, 'a first observation is not a transition');
    assert.equal(isRestockTransition(undefined, row), false);
  }
  // A genuine out-to-in transition, with a real previous snapshot, still works.
  assert.equal(isRestockTransition(
    { stock_status: 'outofstock', stock_quantity: 0 }, { stock_status: 'instock', stock_quantity: 5 }
  ), true);
});

test('GUARD: the catalogue module exposes no way to produce a product event', () => {
  const surface = Object.keys(require('../lib/campaigns/product-catalogue'));
  for (const name of surface) {
    assert.ok(!/event/i.test(name), `${name} suggests this module can create restock events`);
  }
});

// A WooCommerce read that SUCCEEDS and returns nothing used to report
// `available: true` with an empty entries list. Nothing threw, so the failure
// path never ran, and every caller that resolves an order line against the
// catalogue silently stopped resolving anything.
//
// Measured on live data at the time this was written: catalogue present, 2356
// of 2360 order lines resolve and `one_time_multi_product` holds 328 people;
// catalogue empty but reported available, 28 resolve and the same cohort holds
// 11. A 97 per cent under-count presented as fact.
//
// The credential losing `read_products` scope produces exactly this: a 200
// with an empty list, not an error.
test('a fetch that succeeds with no products is unavailable, not an empty catalogue', async () => {
  const woo = fakeWoo({ products: [], variations: {} });
  const snapshot = await productCatalogue({ wooGet: woo, env: {}, now: new Date('2026-08-24T09:00:00Z') });

  assert.equal(snapshot.available, false,
    'an empty catalogue must not be reported as available: callers treat available as "identity can be resolved"');
  assert.equal(snapshot.zeroEntries, true);
  assert.deepEqual(snapshot.entries, []);
  assert.match(String(snapshot.error), /no products/i,
    'the reason has to survive to the caller, or this is just a silent zero again');
  // Distinguishable from a provider that was never reachable, which has no
  // fetchedAt at all.
  assert.ok(snapshot.fetchedAt, 'the fetch did happen, and the timestamp is how a caller tells the two apart');
});

test('an unreachable provider and an empty answer are both unavailable, and both say why', async () => {
  const unreachable = await productCatalogue({
    wooGet: fakeWoo({ failAfter: 0 }), env: {}, now: new Date('2026-08-24T09:00:00Z')
  });
  assert.equal(unreachable.available, false);
  assert.equal(unreachable.zeroEntries, true);
  assert.equal(unreachable.fetchedAt, null, 'never fetched, so no timestamp');
  assert.match(String(unreachable.error), /unavailable/i);
});
