'use strict';

const { findCouponByCode } = require('../woocommerce-coupons');

class CampaignCouponError extends Error {
  constructor(message, code = 'CAMPAIGN_COUPON_NOT_READY') {
    super(message);
    this.name = 'CampaignCouponError';
    this.code = code;
    this.status = 409;
  }
}

function namedCouponInBrief(brief) {
  const match = String(brief || '').match(/\b(?:code|with|using)\s+([A-Z][A-Z0-9-]{3,15})\b/);
  return match ? match[1] : null;
}

function minimumInMessage(message, minimum) {
  if (!Number.isFinite(minimum) || minimum <= 0) return true;
  const value = Number.isInteger(minimum) ? String(minimum) : minimum.toFixed(2);
  return new RegExp(`(?:\\$\\s*${value}|\\b${value}\\s+dollars?\\b)`, 'i').test(String(message || ''));
}

function assertExistingCoupon(coupon, { code, percent, audienceSize = 0, message = null, now = new Date() } = {}) {
  if (!coupon || String(coupon.code || '').toLowerCase() !== String(code || '').toLowerCase()) {
    throw new CampaignCouponError(`Coupon ${code} does not exist in WooCommerce. Create it before using it in a campaign.`);
  }
  if (coupon.status && !['publish', 'published'].includes(String(coupon.status).toLowerCase())) {
    throw new CampaignCouponError(`Coupon ${code} is not active in WooCommerce.`);
  }
  if (coupon.discount_type !== 'percent' ||
    (percent !== null && percent !== undefined && Number(coupon.amount) !== Number(percent))) {
    throw new CampaignCouponError(`Coupon ${code} is not ${percent || 'a percentage'}% off in WooCommerce. Fix the coupon or the message before continuing.`);
  }
  const expires = coupon.date_expires_gmt || coupon.date_expires;
  if (expires && Date.parse(expires) <= now.getTime()) {
    throw new CampaignCouponError(`Coupon ${code} has expired in WooCommerce.`);
  }
  const restricted = ['product_ids', 'excluded_product_ids', 'product_categories', 'excluded_product_categories', 'email_restrictions']
    .some(key => Array.isArray(coupon[key]) && coupon[key].length > 0);
  if (restricted || Number(coupon.maximum_amount || 0) > 0) {
    throw new CampaignCouponError(`Coupon ${code} has checkout restrictions. Review them in WooCommerce before promising it to this whole audience.`);
  }
  const minimum = Number(coupon.minimum_amount || 0);
  if (message !== null && !minimumInMessage(message, minimum)) {
    throw new CampaignCouponError(`Coupon ${code} requires a $${minimum} minimum order. Add that minimum to the message before continuing.`);
  }
  if (Number(coupon.usage_limit_per_user || 0) < 1) {
    throw new CampaignCouponError(`Coupon ${code} needs a per-customer use limit before it can be attached to a campaign.`);
  }
  const limit = Number(coupon.usage_limit || 0);
  const used = Number(coupon.usage_count || 0);
  if (limit > 0 && audienceSize > 0 && limit - used < audienceSize) {
    throw new CampaignCouponError(`Coupon ${code} has only ${Math.max(0, limit - used)} uses left for ${audienceSize} recipients. Raise its use limit in WooCommerce before approval.`);
  }
  return coupon;
}

async function verifyExistingCoupon({ code, percent, audienceSize = 0, message = null, lookup = findCouponByCode, now } = {}) {
  if (!/^[A-Z0-9-]{4,16}$/.test(String(code || ''))) {
    throw new CampaignCouponError('Enter a coupon code with 4 to 16 letters, numbers or hyphens.');
  }
  const coupon = await lookup(code);
  return assertExistingCoupon(coupon, { code, percent, audienceSize, message, now });
}

module.exports = { CampaignCouponError, namedCouponInBrief, minimumInMessage, assertExistingCoupon, verifyExistingCoupon };
