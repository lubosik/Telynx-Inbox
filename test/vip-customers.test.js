'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  VIP_MIN_LIFETIME_SPEND,
  VIP_MIN_PAID_ORDERS,
  automaticVIP,
  classifyVIPCustomer,
  progressState
} = require('../lib/vip-customers');
const { buildCustomerFacts } = require('../lib/campaigns/segment-facts');

test('the permanent VIP definition is exactly 3 paid orders and $500 lifetime spend', () => {
  assert.equal(VIP_MIN_PAID_ORDERS, 3);
  assert.equal(VIP_MIN_LIFETIME_SPEND, 500);
  assert.equal(automaticVIP({ orderCount: 3, lifetimeSpend: 500 }), true);
  assert.equal(automaticVIP({ orderCount: 2, lifetimeSpend: 5000 }), false);
  assert.equal(automaticVIP({ orderCount: 20, lifetimeSpend: 499.99 }), false);
});

test('VIP state separates active, due soon and needs attention using reliable customer cadence', () => {
  assert.equal(classifyVIPCustomer({
    orderCount: 3, lifetimeSpend: 500, daysSinceLastOrder: 29, cadenceMedianDays: 30
  }).vip_state, 'active');
  assert.equal(classifyVIPCustomer({
    orderCount: 3, lifetimeSpend: 500, daysSinceLastOrder: 31, cadenceMedianDays: 30
  }).vip_state, 'due_soon');
  assert.equal(classifyVIPCustomer({
    orderCount: 3, lifetimeSpend: 500, daysSinceLastOrder: 46, cadenceMedianDays: 30
  }).vip_state, 'needs_attention');
});

test('manual inclusion adds a standard customer without changing the automatic rule', () => {
  const result = classifyVIPCustomer({ orderCount: 1, lifetimeSpend: 100 }, {
    manuallyIncluded: true,
    segmentID: 'segment-vip'
  });
  assert.equal(result.customer_tier, 'vip');
  assert.equal(result.vip_source, 'manual');
  assert.equal(result.vip_automatic, false);
  assert.equal(result.vip_manual_override, true);
  assert.equal(result.vip_segment_id, 'segment-vip');
});

test('standard customers receive honest VIP progress labels', () => {
  assert.equal(progressState({ orderCount: 2, lifetimeSpend: 800 }), 'one_order_away');
  assert.equal(progressState({ orderCount: 1, lifetimeSpend: 900 }), 'high_value_first_order');
  assert.equal(progressState({ orderCount: 4, lifetimeSpend: 300 }), 'frequent_building_value');
  assert.equal(progressState({ orderCount: 1, lifetimeSpend: 100 }), 'standard');
});

test('VIP history counts distinct paid orders and ignores failed or cancelled orders', () => {
  const phone = '+15555550123';
  const facts = buildCustomerFacts({
    contacts: [{ id: 42, phone, name: 'Test Customer' }],
    orders: [
      { id: 1, woo_order_id: 1001, contact_phone: phone, status: 'completed', total: 200, created_at: '2026-01-01T12:00:00Z', items: [] },
      { id: 2, woo_order_id: 1002, contact_phone: phone, status: 'processing', total: 150, created_at: '2026-02-01T12:00:00Z', items: [] },
      { id: 3, woo_order_id: 1003, contact_phone: phone, status: 'shipped', total: 150, created_at: '2026-03-01T12:00:00Z', items: [] },
      { id: 4, woo_order_id: 1004, contact_phone: phone, status: 'failed', total: 999, created_at: '2026-04-01T12:00:00Z', items: [] },
      { id: 5, woo_order_id: 1005, contact_phone: phone, status: 'cancelled', total: 999, created_at: '2026-05-01T12:00:00Z', items: [] }
    ]
  }, { now: new Date('2026-06-01T12:00:00Z') }).facts[0];

  const result = classifyVIPCustomer(facts);
  assert.equal(result.paid_order_count, 3);
  assert.equal(result.lifetime_spend_cents, 50_000);
  assert.equal(result.customer_tier, 'vip');
  assert.equal(result.vip_source, 'automatic');
});
