'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { vipCouponPatch } = require('../lib/vip-benefit-coupon');
test('VIP15 is repeat-use 15%, includes sale products, and is never publicly unrestricted', () => {
  const patch = vipCouponPatch(['JESS@example.com', 'jess@example.com', 'invalid']);
  assert.deepEqual(patch.email_restrictions, ['jess@example.com']);
  assert.equal(patch.amount, '15');
  assert.equal(patch.minimum_amount, '0');
  assert.equal(patch.usage_limit_per_user, null);
  assert.equal(patch.exclude_sale_items, false);
  assert.deepEqual(patch.excluded_product_ids, []);
  assert.equal(patch.date_expires_gmt, null);
});
test('An empty VIP email audience cannot accidentally create a public coupon', () => {
  assert.throws(() => vipCouponPatch([]), /no VIP billing emails/);
});
