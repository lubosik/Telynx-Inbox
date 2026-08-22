'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateOpportunityExpiry,
  resolveOpportunityCollision
} = require('../lib/campaigns/opportunity-policy');

test('collision resolution deterministically prefers exact requested restock over generic promotion', () => {
  const result = resolveOpportunityCollision([
    { id: 'generic', type: 'generic_promotion', createdAt: '2026-08-20T10:00:00Z', expiresAt: '2026-08-30T00:00:00Z' },
    { id: 'restock', type: 'back_in_stock_requested', createdAt: '2026-08-21T10:00:00Z', expiresAt: '2026-08-29T00:00:00Z' },
    { id: 'reorder', type: 'reorder_personal_high', createdAt: '2026-08-19T10:00:00Z', expiresAt: '2026-08-29T00:00:00Z' }
  ], {
    now: '2026-08-22T12:00:00Z',
    contextsByID: { restock: { productAvailable: true } }
  });

  assert.equal(result.selected.id, 'restock');
  assert.deepEqual(result.suppressed.map(item => item.opportunity.id), ['reorder', 'generic']);
  assert.ok(result.suppressed.every(item => item.reason === 'lower_priority_collision'));
});

test('same-priority collision uses evidence, expiry, creation and ID as stable tie breakers', () => {
  const common = { type: 'back_in_stock', createdAt: '2026-08-20T00:00:00Z', expiresAt: '2026-08-30T00:00:00Z' };
  const result = resolveOpportunityCollision([
    { ...common, id: 'b', relevanceScore: 0.7 },
    { ...common, id: 'a', relevanceScore: 0.7 },
    { ...common, id: 'higher', relevanceScore: 0.9 }
  ], {
    now: '2026-08-22T12:00:00Z',
    contextsByID: {
      a: { productAvailable: true },
      b: { productAvailable: true },
      higher: { productAvailable: true }
    }
  });
  assert.equal(result.selected.id, 'higher');
  assert.deepEqual(result.suppressed.map(item => item.opportunity.id), ['a', 'b']);
});

test('opportunities close on conversion, stock loss and bounded expiry', () => {
  const converted = evaluateOpportunityExpiry({
    type: 'reorder_personal',
    createdAt: '2026-08-20T00:00:00Z'
  }, { reordered: true }, { now: '2026-08-22T00:00:00Z' });
  assert.equal(converted.active, false);
  assert.ok(converted.reasons.includes('customer_converted'));

  const unavailable = evaluateOpportunityExpiry({
    type: 'back_in_stock',
    createdAt: '2026-08-20T00:00:00Z'
  }, { productAvailable: false }, { now: '2026-08-22T00:00:00Z' });
  assert.ok(unavailable.reasons.includes('product_unavailable'));

  const stale = evaluateOpportunityExpiry({
    type: 'back_in_stock',
    createdAt: '2026-08-01T00:00:00Z'
  }, { productAvailable: true }, { now: '2026-08-22T00:00:00Z' });
  assert.ok(stale.reasons.includes('opportunity_stale'));
});

test('an opportunity with no explicit or rule-derived lifetime fails closed', () => {
  const result = evaluateOpportunityExpiry({ type: 'unknown_type', createdAt: '2026-08-22T00:00:00Z' }, {}, {
    now: '2026-08-22T12:00:00Z'
  });
  assert.equal(result.active, false);
  assert.deepEqual(result.reasons, ['expiry_unknown']);
});

test('active payment recovery pauses promotional collisions instead of competing as a campaign', () => {
  const result = resolveOpportunityCollision([
    { id: 'restock', type: 'back_in_stock', createdAt: '2026-08-20T00:00:00Z' },
    { id: 'manual', type: 'manual', createdAt: '2026-08-20T00:00:00Z' }
  ], {
    now: '2026-08-22T00:00:00Z',
    activePaymentRecovery: true,
    contextsByID: { restock: { productAvailable: true } }
  });
  assert.equal(result.selected, null);
  assert.equal(result.suppressed.length, 2);
  assert.ok(result.suppressed.every(item => item.reason === 'active_payment_recovery'));
});
