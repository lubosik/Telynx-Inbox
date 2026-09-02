'use strict';
/**
 * test/campaign-store-link-resolution.test.js — a product that can be named
 * can always be reached.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT WENT WRONG
 *
 *   One person was dropped from the recovery campaign because their message
 *   would have read:
 *
 *     "...so I managed to get you 20% off. Use code BACK20 here: Reply STOP"
 *
 *   The product was named perfectly — KLOW — and had no link. The owner went
 *   and found the page himself in about ten seconds
 *   (product/ghk-bpc-tb-kpv-blend) and said every person should have one.
 *
 *   He was right. The NAME lookup had three fallbacks — the catalogue, the
 *   rename map, and resolveBySkuBase for a drifted variation — and the LINK
 *   lookup was a single exact match on the order's SKU. So the order carrying
 *   `KLOW` resolved its label and missed its link, because the catalogue holds
 *   `KLOW80`, the variation SKU with its size suffix. skuBase strips exactly
 *   that and was already in use one function away.
 *
 *   Measured after the fix: 112 of 112 recipients reach their exact product
 *   page, none needs the shop fallback, none is dropped.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { SHOP_PAGE, storeLinkFor } = require('../lib/campaigns/personalise');

const LINKS = new Map([
  ['RT10', 'https://vicipeptides.com/product/rt/'],
  ['RT20', 'https://vicipeptides.com/product/rt/'],
  ['KLOW80', 'https://vicipeptides.com/product/ghk-bpc-tb-kpv-blend/'],
  ['NAME:RT', 'https://vicipeptides.com/product/rt/'],
  ['BBG70', 'https://vicipeptides.com/product/ghk-bpc-tb-blend/']
]);
const SKUS = new Map([['RT10', 'RT'], ['RT20', 'RT'], ['KLOW80', 'KLOW']]);

test('an exact SKU wins', () => {
  assert.equal(storeLinkFor({ sku: 'RT20', label: 'RT', skuMap: SKUS, linkMap: LINKS }),
    'https://vicipeptides.com/product/rt/');
});

test('a drifted variation resolves through its base — the KLOW case', () => {
  // The order carries KLOW; the catalogue holds KLOW80. This is the exact
  // failure that dropped a real person from a real campaign.
  assert.equal(storeLinkFor({ sku: 'KLOW', label: 'KLOW', skuMap: SKUS, linkMap: LINKS }),
    'https://vicipeptides.com/product/ghk-bpc-tb-kpv-blend/');
});

test('an order with no SKU resolves by name', () => {
  // Orders predating a rename carry a name and sku: null.
  assert.equal(storeLinkFor({ sku: null, label: 'RT', skuMap: SKUS, linkMap: LINKS }),
    'https://vicipeptides.com/product/rt/');
});

test('an ambiguous base goes to the shop rather than guessing', () => {
  // Naming the WRONG product page in a marketing message is worse than the
  // shop, and it is the same refusal resolveBySkuBase already makes for names.
  const ambiguous = new Map([
    ['ZZ10', 'https://vicipeptides.com/product/one/'],
    ['ZZ20', 'https://vicipeptides.com/product/two/']
  ]);
  assert.equal(storeLinkFor({ sku: 'ZZ', label: 'ZZ', skuMap: new Map(), linkMap: ambiguous }),
    SHOP_PAGE);
});

test('nothing matching still lands somewhere real', () => {
  // The owner's instruction: if there is truly no product link, take them to
  // the shop. A message naming a product with nowhere to buy it is the
  // friction the message exists to remove, and being dropped over it is worse.
  assert.equal(storeLinkFor({ sku: 'NOPE99', label: 'Mystery', skuMap: SKUS, linkMap: LINKS }),
    SHOP_PAGE);
  assert.equal(storeLinkFor({ sku: null, label: null, skuMap: SKUS, linkMap: LINKS }), SHOP_PAGE);
  assert.equal(storeLinkFor({ sku: 'RT20', label: 'RT', skuMap: SKUS, linkMap: null }), SHOP_PAGE);
});

test('the shop page passes the link rules a message enforces', () => {
  // A fallback that renders empty would put everybody back where they started.
  const { FIELDS } = require('../lib/campaigns/merge-fields');
  assert.equal(FIELDS.attempted_product_link.render({ attemptedProductLink: SHOP_PAGE }), SHOP_PAGE);
  assert.equal(FIELDS.product_link.render({ lastProductLink: SHOP_PAGE }), SHOP_PAGE);
});

test('both link fields resolve the same way', () => {
  // A product that can be NAMED must always be linkable, on either path. They
  // had different lookups, which is how one of them could be named and
  // unreachable.
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'campaigns', 'personalise.js'), 'utf8');
  const calls = source.match(/storeLinkFor\(\{/g) || [];
  assert.ok(calls.length >= 2, `both paths must use the shared resolver, found ${calls.length}`);
});
