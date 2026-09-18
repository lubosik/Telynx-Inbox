'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { campaignCouponSpec, createCampaignCoupon } = require('../lib/campaigns/coupon-builder');
const { findPolicy } = require('../lib/enforce-policy');

test('coupon builder creates the configured bounded WooCommerce spec', () => {
  const spec = campaignCouponSpec({
    code: 'CC20', name: 'Card launch', percent: 20, expiryDays: 30,
    minimumAmount: 100, maximumAmount: 0, usageLimit: 1200,
    usageLimitPerUser: 1, individualUse: true,
    excludeSaleItems: false, freeShipping: false
  }, { now: new Date('2026-09-18T12:00:00Z') });
  assert.deepEqual({
    code: spec.code, amount: spec.amount, minimum: spec.minimum_amount,
    maximum: spec.maximum_amount, total: spec.usage_limit, perUser: spec.usage_limit_per_user,
    expires: spec.date_expires, excluded: spec.excluded_product_ids
  }, {
    code: 'cc20', amount: '20', minimum: '100.00', maximum: '',
    total: 1200, perUser: 1, expires: '2026-10-18T23:59:59', excluded: []
  });
});

test('invalid and internally contradictory coupon settings are refused before WooCommerce', () => {
  const base = { code: 'TEST20', name: 'Test', percent: 20, expiryDays: 30,
    minimumAmount: 100, maximumAmount: 0, usageLimit: 100, usageLimitPerUser: 1 };
  assert.throws(() => campaignCouponSpec({ ...base, percent: 100 }), /between 1 and 99/);
  assert.throws(() => campaignCouponSpec({ ...base, usageLimitPerUser: 101 }), /between 1 and 20/);
  assert.throws(() => campaignCouponSpec({ ...base, minimumAmount: 200, maximumAmount: 100 }), /higher/);
});

test('creation checks duplicates, creates once, then reads authoritative Woo terms', async () => {
  let lookups = 0;
  let writes = 0;
  const coupon = await createCampaignCoupon({
    code: 'NEW20', name: 'New offer', percent: 20, expiryDays: 30,
    minimumAmount: 100, maximumAmount: 0, usageLimit: 1200, usageLimitPerUser: 1
  }, {
    now: new Date('2026-09-18T12:00:00Z'),
    find: async () => (++lookups === 1 ? null : {
      id: 44, code: 'new20', description: 'New offer', amount: '20',
      minimum_amount: '100', maximum_amount: '', date_expires: '2026-10-18T23:59:59',
      usage_limit: 1200, usage_limit_per_user: 1, individual_use: true,
      exclude_sale_items: false, free_shipping: false, status: 'publish'
    }),
    create: async specs => { writes += 1; assert.equal(specs.length, 1); return { created: [{}], failed: [] }; }
  });
  assert.equal(writes, 1);
  assert.equal(coupon.code, 'NEW20');
  assert.equal(coupon.minimumAmount, 100);
});

test('coupon creation requires campaign approval permission and is audited', () => {
  const policy = findPolicy('POST', '/api/campaigns/coupons');
  assert.equal(policy.permission, 'campaigns.approve');
  assert.equal(policy.audit, true);
});

test('the iOS builder states that coupon creation never sends the campaign', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'ios/ViciInbox/UI/CampaignsView.swift'), 'utf8'
  );
  assert.match(source, /Generate Coupon/);
  assert.match(source, /does not send, approve, or schedule this campaign/);
  assert.match(source, /Create and Attach Coupon/);
});
