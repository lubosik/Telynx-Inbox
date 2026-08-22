'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { wooOrderItems } = require('../lib/woocommerce-order-items');

test('Woo order items preserve exact product and variation identifiers', () => {
  assert.deepEqual(wooOrderItems({ line_items: [{
    product_id: 42,
    variation_id: 84,
    name: 'Product variation',
    quantity: 2,
    total: '199.00',
    sku: 'SKU-84'
  }] }), [{
    product_id: 42,
    variation_id: 84,
    name: 'Product variation',
    quantity: 2,
    total: '199.00',
    sku: 'SKU-84'
  }]);
});

test('legacy-compatible item data stays usable when Woo identifiers are absent', () => {
  assert.deepEqual(wooOrderItems({ line_items: [{ name: 'Legacy item', quantity: '1', total: '20' }] }), [{
    product_id: null,
    variation_id: null,
    name: 'Legacy item',
    quantity: 1,
    total: '20',
    sku: null
  }]);
  assert.deepEqual(wooOrderItems({}), []);
});
