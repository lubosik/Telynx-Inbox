'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { qualifyBackInStockTransition } = require('../lib/campaigns/back-in-stock');

function snapshot(overrides = {}) {
  return {
    productID: 42,
    variationID: 7,
    stockStatus: 'instock',
    manageStock: true,
    stockQuantity: 12,
    purchasable: true,
    publicationStatus: 'publish',
    ...overrides
  };
}

test('qualifies only a trusted exact-item unavailable to available transition after debounce', () => {
  const result = qualifyBackInStockTransition({
    previous: snapshot({ stockStatus: 'outofstock', stockQuantity: 0, purchasable: false }),
    observed: snapshot(),
    authoritative: snapshot(),
    webhookTrusted: true,
    previousSnapshotTrusted: true,
    authoritativeRefetchTrusted: true,
    deliveryID: 'delivery-1',
    observedAt: '2026-08-22T10:00:00Z',
    recheckedAt: '2026-08-22T10:05:00Z'
  });
  assert.equal(result.qualifies, true);
  assert.equal(result.transitionKey, '42:7:delivery-1');
});

test('ordinary in-stock product edits do not become restock opportunities', () => {
  const result = qualifyBackInStockTransition({
    previous: snapshot(),
    observed: snapshot({ stockQuantity: 15 }),
    authoritative: snapshot({ stockQuantity: 15 }),
    webhookTrusted: true,
    previousSnapshotTrusted: true,
    authoritativeRefetchTrusted: true,
    deliveryID: 'delivery-2',
    observedAt: '2026-08-22T10:00:00Z',
    recheckedAt: '2026-08-22T10:05:00Z'
  });
  assert.equal(result.qualifies, false);
  assert.ok(result.reasons.includes('previous_state_not_definitely_unavailable'));
});

test('duplicate, untrusted, reversed, early and variation-mismatched restocks fail closed', () => {
  const result = qualifyBackInStockTransition({
    previous: snapshot({ stockStatus: 'outofstock', stockQuantity: 0, purchasable: false }),
    observed: snapshot(),
    authoritative: snapshot({ variationID: 8, stockStatus: 'outofstock', stockQuantity: 0 }),
    webhookTrusted: false,
    deliveryID: 'delivery-3',
    deliveryAlreadyProcessed: true,
    observedAt: '2026-08-22T10:00:00Z',
    recheckedAt: '2026-08-22T10:01:00Z'
  });
  assert.equal(result.qualifies, false);
  assert.ok(result.reasons.includes('webhook_untrusted'));
  assert.ok(result.reasons.includes('duplicate_delivery'));
  assert.ok(result.reasons.includes('authoritative_identity_mismatch'));
  assert.ok(result.reasons.includes('authoritative_state_not_available'));
  assert.ok(result.reasons.includes('debounce_not_elapsed'));
});

test('managed stock with unknown quantity is not treated as definitely available', () => {
  const result = qualifyBackInStockTransition({
    previous: snapshot({ stockStatus: 'outofstock', stockQuantity: 0 }),
    observed: snapshot({ stockQuantity: null }),
    authoritative: snapshot({ stockQuantity: null }),
    webhookTrusted: true,
    previousSnapshotTrusted: true,
    authoritativeRefetchTrusted: true,
    deliveryID: 'delivery-4',
    observedAt: '2026-08-22T10:00:00Z',
    recheckedAt: '2026-08-22T10:05:00Z'
  });
  assert.equal(result.qualifies, false);
  assert.ok(result.reasons.includes('observed_state_not_definitely_available'));
});

test('raw Woo variation identity uses parent_id plus the variation id', () => {
  const previous = snapshot({ productID: undefined, variationID: undefined, id: 7, parent_id: 42, stockStatus: 'outofstock', stockQuantity: 0 });
  const current = snapshot({ productID: undefined, variationID: undefined, id: 7, parent_id: 42 });
  const result = qualifyBackInStockTransition({
    previous,
    observed: current,
    authoritative: current,
    webhookTrusted: true,
    previousSnapshotTrusted: true,
    authoritativeRefetchTrusted: true,
    deliveryID: 'delivery-raw',
    observedAt: '2026-08-22T10:00:00Z',
    recheckedAt: '2026-08-22T10:05:00Z'
  });
  assert.equal(result.qualifies, true);
  assert.equal(result.productID, '42');
  assert.equal(result.variationID, '7');
});
