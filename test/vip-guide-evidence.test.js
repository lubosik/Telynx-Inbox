'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildVIPGuideEvidence } = require('../lib/vip-guide-evidence');

const at = new Date('2026-09-29T12:00:00Z');
const sources = {
  contacts: [{ id: 7, phone: '+19175550123', name: 'Jane' }],
  orders: [
    { id: 1, woo_order_id: 101, contact_phone: '+19175550123', status: 'completed', total: 120,
      created_at: '2026-08-01T12:00:00Z', items: [{ product_id: 12, variation_id: 0, name: 'Product A' }] },
    { id: 2, woo_order_id: 102, contact_phone: '+19175550123', status: 'processing', total: 80,
      created_at: '2026-09-01T12:00:00Z', items: [{ product_id: 12, variation_id: 0, name: 'Product A' }] },
    { id: 3, woo_order_id: 103, contact_phone: '+19175550123', status: 'failed', total: 999,
      created_at: '2026-09-20T12:00:00Z', items: [{ product_id: 77, variation_id: 0, name: 'Product B' }] }
  ],
  inventory: [],
  supportAvailable: false
};

test('guide evidence uses paid orders, keeps unavailable products visible, and never enables sending', () => {
  const result = buildVIPGuideEvidence(sources, '+19175550123', { now: at });
  assert.equal(result.paidOrderCount, 2);
  assert.equal(result.recordedLifetimeSpend, 200);
  assert.equal(result.orderedProducts.length, 1);
  assert.deepEqual(result.orderedProducts[0], {
    productKey: '12:0', name: 'Product A', paidOrderCount: 2, currentlyAvailable: false
  });
  assert.equal(result.guideStatus, 'evidence_only');
  assert.equal(result.sendEnabled, false);
  assert.equal(JSON.stringify(result).includes('Product B'), false);
});

test('guide evidence does not invent a customer or accept an invalid number', () => {
  assert.equal(buildVIPGuideEvidence(sources, '+19175550999', { now: at }), null);
  assert.throws(() => buildVIPGuideEvidence(sources, 'not a phone', { now: at }), /valid customer phone/);
});
