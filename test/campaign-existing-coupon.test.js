'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { namedCouponInBrief, verifyExistingCoupon } = require('../lib/campaigns/existing-coupon');
const { planCampaign, PAYMENT_OFFER_COPY } = require('../lib/campaigns/planner');
const { validateCopy } = require('../lib/campaigns/copy-validator');
const { issueSharedCode } = require('../lib/campaigns/personalise');

const liveCoupon = {
  code: 'cc20', status: 'publish', discount_type: 'percent', amount: '20',
  usage_limit: 0, usage_count: 0, usage_limit_per_user: 1,
  date_expires: null, product_ids: [], excluded_product_ids: [],
  product_categories: [], excluded_product_categories: [], email_restrictions: [],
  minimum_amount: '100', maximum_amount: '0'
};

test('CC20 is recognized as a named offer, not guessed from unrelated capitals', () => {
  assert.equal(namedCouponInBrief('20% off with CC20'), 'CC20');
  assert.equal(namedCouponInBrief('Apple Pay is live'), null);
});

test('an existing named code must be live, exact percent and broadly usable', async () => {
  const lookup = async () => liveCoupon;
  assert.equal((await verifyExistingCoupon({ code: 'CC20', percent: 20, lookup })).code, 'cc20');
  await assert.rejects(() => verifyExistingCoupon({ code: 'CC20', percent: 15, lookup }), /not 15%/);
  await assert.rejects(() => verifyExistingCoupon({ code: 'CC20', percent: 20, lookup: async () => null }), /does not exist/);
  await assert.rejects(() => verifyExistingCoupon({ code: 'CC20', percent: 20,
    lookup: async () => ({ ...liveCoupon, usage_limit: 10, usage_count: 2 }), audienceSize: 100 }), /only 8 uses left/);
  await assert.rejects(() => verifyExistingCoupon({ code: 'CC20', percent: 20,
    lookup, message: 'Vin from Vici: 20% off with {{code}}. Reply STOP to opt out.' }), /\$100 minimum/);
});

test('a named-code approval reuses the WooCommerce coupon without changing its terms', async () => {
  let writes = 0;
  const coupons = {
    findCouponByCode: async () => liveCoupon,
    createCoupons: async () => { writes += 1; },
    updateCoupon: async () => { writes += 1; }
  };
  const result = await issueSharedCode({
    campaignID: 'draft-1', phones: ['+15550000001'], facts: new Map(),
    percentOff: 20, fixedCode: 'CC20', preserveFixedCode: true, publicCode: true,
    message: PAYMENT_OFFER_COPY,
    coupons
  });
  assert.equal(result.byPhone.get('+15550000001'), 'CC20');
  assert.equal(result.created, false);
  assert.equal(writes, 0);
});

test('the payment-offer fallback has one verified coupon placeholder and safe copy', () => {
  assert.equal(validateCopy(PAYMENT_OFFER_COPY).ok, true);
  assert.equal((PAYMENT_OFFER_COPY.match(/\{\{code\}\}/g) || []).length, 1);
  assert.ok(PAYMENT_OFFER_COPY.includes('20%'));
});

test('the described campaign refuses a missing CC20 and gives a clear fix', async () => {
  const client = { from: () => ({ select: async () => ({ count: 100, error: null }) }) };
  const plan = await planCampaign({
    client, brief: 'Tell all contacts card checkout and Apple Pay work and give 20% off with CC20',
    segments: {}, drafter: async () => ({ candidates: [] }), couponLookup: async () => null
  });
  assert.equal(plan.ready, false);
  assert.match(plan.couponError.message, /does not exist/);
  assert.match(plan.nextSteps.join(' '), /WooCommerce/);
});

test('the described payment offer is reviewable with a verified CC20', async () => {
  const client = { from: () => ({ select: async () => ({ count: 100, error: null }) }) };
  const plan = await planCampaign({
    client, brief: 'Tell all contacts card checkout and Apple Pay work and give 20% off with CC20',
    segments: {}, drafter: async () => ({ candidates: [] }), couponLookup: async () => liveCoupon
  });
  assert.equal(plan.ready, true);
  assert.equal(plan.couponCode, 'CC20');
  assert.equal(plan.discountPercent, 20);
  assert.equal(plan.minimumSpend, 100);
  assert.equal(plan.copy[0].text, PAYMENT_OFFER_COPY);
});
