'use strict';

const { createCoupons, findCouponByCode } = require('../woocommerce-coupons');

class CampaignCouponBuildError extends Error {
  constructor(message, code = 'CAMPAIGN_COUPON_INVALID', status = 400) {
    super(message);
    this.name = 'CampaignCouponBuildError';
    this.code = code;
    this.status = status;
  }
}

function integer(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new CampaignCouponBuildError(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function money(value, name, { minimum = 0, maximum = 100000 } = {}) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new CampaignCouponBuildError(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return parsed.toFixed(2);
}

function couponCode(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{4,16}$/.test(code)) {
    throw new CampaignCouponBuildError('Coupon code must be 4 to 16 letters, numbers or hyphens.');
  }
  return code;
}

function campaignCouponSpec(input = {}, { now = new Date() } = {}) {
  const code = couponCode(input.code);
  const percent = integer(input.percent, 'Discount percent', 1, 99);
  const expiryDays = integer(input.expiryDays, 'Expiry', 1, 365);
  const usageLimit = integer(input.usageLimit, 'Total uses', 1, 100000);
  const perCustomer = integer(input.usageLimitPerUser, 'Uses per customer', 1, 20);
  if (perCustomer > usageLimit) {
    throw new CampaignCouponBuildError('Uses per customer cannot be higher than total uses.');
  }
  const minimumAmount = money(input.minimumAmount, 'Minimum order');
  const maximumAmount = money(input.maximumAmount, 'Maximum order');
  if (Number(maximumAmount) > 0 && Number(maximumAmount) < Number(minimumAmount)) {
    throw new CampaignCouponBuildError('Maximum order must be higher than the minimum order.');
  }
  const expiry = new Date(now.getTime());
  expiry.setUTCDate(expiry.getUTCDate() + expiryDays);
  const expiryDate = `${expiry.toISOString().slice(0, 10)}T23:59:59`;
  const description = String(input.name || `${code} campaign coupon`).trim().slice(0, 160);
  return {
    code: code.toLowerCase(),
    description,
    discount_type: 'percent',
    amount: String(percent),
    individual_use: input.individualUse !== false,
    usage_limit: usageLimit,
    usage_limit_per_user: perCustomer,
    minimum_amount: minimumAmount,
    maximum_amount: Number(maximumAmount) > 0 ? maximumAmount : '',
    date_expires: expiryDate,
    exclude_sale_items: input.excludeSaleItems === true,
    free_shipping: input.freeShipping === true,
    product_ids: [], excluded_product_ids: [],
    product_categories: [], excluded_product_categories: [], email_restrictions: []
  };
}

function presentCoupon(row) {
  return {
    id: Number(row.id), code: String(row.code || '').toUpperCase(), name: row.description || null,
    percent: Number(row.amount), minimumAmount: Number(row.minimum_amount || 0),
    maximumAmount: Number(row.maximum_amount || 0), expiry: row.date_expires || null,
    usageLimit: Number(row.usage_limit || 0), usageLimitPerUser: Number(row.usage_limit_per_user || 0),
    individualUse: row.individual_use === true, excludeSaleItems: row.exclude_sale_items === true,
    freeShipping: row.free_shipping === true, status: row.status || 'publish'
  };
}

async function createCampaignCoupon(input, { now = new Date(), find = findCouponByCode, create = createCoupons } = {}) {
  const spec = campaignCouponSpec(input, { now });
  const existing = await find(spec.code);
  if (existing) {
    throw new CampaignCouponBuildError(
      `Coupon ${spec.code.toUpperCase()} already exists. Choose a different code or use the existing coupon.`,
      'CAMPAIGN_COUPON_ALREADY_EXISTS', 409
    );
  }
  const result = await create([spec]);
  const failed = (result?.failed || []).find(row => row?.duplicate !== true) || result?.failed?.[0];
  if (failed) throw new CampaignCouponBuildError(
    `WooCommerce could not create this coupon: ${failed.error || 'unknown error'}. Nothing was attached to the campaign.`,
    'CAMPAIGN_COUPON_CREATE_FAILED', 502
  );
  const created = await find(spec.code);
  if (!created) throw new CampaignCouponBuildError(
    'WooCommerce did not return the new coupon. Check Coupons before trying again.',
    'CAMPAIGN_COUPON_CREATE_FAILED', 502
  );
  return presentCoupon(created);
}

module.exports = { CampaignCouponBuildError, couponCode, campaignCouponSpec, presentCoupon, createCampaignCoupon };
