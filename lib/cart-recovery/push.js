'use strict';

const DISCOUNT_CODE = 'VICI15';
const { productSummary } = require('./copy');

function numberList(value) {
  return Array.isArray(value) ? value.map(Number).filter(Number.isFinite) : [];
}

function emailMatchesRestriction(email, restriction) {
  const candidate = String(email || '').trim().toLowerCase();
  const pattern = String(restriction || '').trim().toLowerCase();
  if (!candidate || !pattern) return false;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`, 'i').test(candidate);
}

function verifyCouponForCart(coupon, cart, now = new Date()) {
  if (!coupon || String(coupon.status || '') !== 'publish') return { eligible: false, reason: 'coupon_unavailable' };
  if (String(coupon.code || '').toLowerCase() !== DISCOUNT_CODE.toLowerCase()) return { eligible: false, reason: 'coupon_code_mismatch' };
  if (String(coupon.discount_type || '') !== 'percent' || Number(coupon.amount) !== 15) return { eligible: false, reason: 'coupon_terms_mismatch' };
  if (coupon.date_expires && Date.parse(coupon.date_expires) <= now.getTime()) return { eligible: false, reason: 'coupon_expired' };
  const total = Number(cart?.total || 0);
  if (coupon.minimum_amount && total < Number(coupon.minimum_amount)) return { eligible: false, reason: 'coupon_minimum_not_met' };
  if (coupon.maximum_amount && Number(coupon.maximum_amount) > 0 && total > Number(coupon.maximum_amount)) return { eligible: false, reason: 'coupon_maximum_exceeded' };
  if (Number(coupon.usage_limit) > 0 && Number(coupon.usage_count) >= Number(coupon.usage_limit)) return { eligible: false, reason: 'coupon_usage_exhausted' };
  const emailRestrictions = Array.isArray(coupon.email_restrictions) ? coupon.email_restrictions.filter(Boolean) : [];
  const customerEmail = String(cart?.customer_email || '').trim().toLowerCase();
  const customerID = String(cart?.wordpress_user_id || '').trim();
  if (emailRestrictions.length && !emailRestrictions.some(value => emailMatchesRestriction(customerEmail, value))) {
    return { eligible: false, reason: customerEmail ? 'coupon_email_restricted' : 'coupon_customer_email_missing' };
  }
  const perUser = Number(coupon.usage_limit_per_user) || 0;
  if (perUser > 0) {
    if (!Array.isArray(coupon.used_by)) return { eligible: false, reason: 'coupon_customer_usage_unverified' };
    if (!customerID && !customerEmail) return { eligible: false, reason: 'coupon_customer_identity_missing' };
    const customerUses = coupon.used_by.map(value => String(value).trim().toLowerCase())
      .filter(value => value === customerID.toLowerCase() || value === customerEmail).length;
    if (customerUses >= perUser) return { eligible: false, reason: 'coupon_customer_usage_exhausted' };
  }
  const applied = Array.isArray(cart?.applied_coupons) ? cart.applied_coupons.map(value => String(value).toLowerCase()) : [];
  if (coupon.individual_use === true && applied.some(code => code !== DISCOUNT_CODE.toLowerCase())) {
    return { eligible: false, reason: 'coupon_conflicts_with_cart' };
  }
  const items = Array.isArray(cart?.items) ? cart.items : [];
  if (!items.length) return { eligible: false, reason: 'cart_items_missing' };
  const includedProducts = new Set(numberList(coupon.product_ids));
  const excludedProducts = new Set(numberList(coupon.excluded_product_ids));
  const includedCategories = new Set(numberList(coupon.product_categories));
  const excludedCategories = new Set(numberList(coupon.excluded_product_categories));
  for (const item of items) {
    const ids = [Number(item.product_id), Number(item.variation_id)].filter(Boolean);
    const categories = numberList(item.category_ids);
    if (ids.some(id => excludedProducts.has(id))) return { eligible: false, reason: 'cart_product_excluded' };
    if (categories.some(id => excludedCategories.has(id))) return { eligible: false, reason: 'cart_category_excluded' };
    if (includedProducts.size && !ids.some(id => includedProducts.has(id))) return { eligible: false, reason: 'cart_product_not_included' };
    if (includedCategories.size && !categories.some(id => includedCategories.has(id))) return { eligible: false, reason: 'cart_category_not_included' };
    if (coupon.exclude_sale_items === true && item.on_sale === true) return { eligible: false, reason: 'sale_item_excluded' };
  }
  return { eligible: true, code: DISCOUNT_CODE, percent: 15 };
}

function reliableScarcity(items, threshold = 5) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return null;
  const quantities = rows.map(row => row.stock_managed === true && Number.isFinite(Number(row.stock_quantity))
    ? Number(row.stock_quantity) : null);
  if (quantities.some(value => value === null)) return null;
  const lowest = Math.min(...quantities);
  return lowest > 0 && lowest <= threshold ? { lowStock: true, quantity: lowest } : { lowStock: false, quantity: lowest };
}

function customerPushDestination(cart, storeURL) {
  const items = Array.isArray(cart?.items) ? cart.items : [];
  if (items.length === 1) {
    try {
      const target = new URL(items[0].product_url);
      const allowed = new URL(storeURL);
      if (target.protocol === 'https:' && target.origin === allowed.origin) return target.href;
    } catch {}
  }
  try { return new URL('/shop/', storeURL).href; } catch { return null; }
}

function trackedPushDestination(target, recoveryURL, storeURL) {
  try {
    const targetURL = new URL(target);
    const recovery = new URL(recoveryURL);
    const allowed = new URL(storeURL);
    const match = recovery.pathname.match(/^\/r\/([A-Za-z0-9_-]{43,128})\/?$/);
    if (!match || targetURL.origin !== allowed.origin || recovery.origin !== allowed.origin) return null;
    const tracked = new URL(`/luko-go/${match[1]}/`, allowed);
    tracked.searchParams.set('to', targetURL.href);
    return tracked.href;
  } catch { return null; }
}

function composePush({ cart, coupon, storeURL, recoveryURL, requireChannel = true,
  scarcityEnabled = false, scarcityThreshold = 5,
  titleTemplate = 'Still thinking about {{product_name}}?',
  bodyTemplate = 'Vin here. I managed to get you 15% off if you still want to go ahead. Use code {{discount_code}}.',
  now = new Date() }) {
  if (requireChannel && (!cart?.customer_push_destination_id || cart?.customer_push_permission !== true)) {
    return { eligible: false, reason: 'customer_push_channel_unavailable' };
  }
  const discount = verifyCouponForCart(coupon, cart, now);
  if (!discount.eligible) return discount;
  const targetDestination = customerPushDestination(cart, storeURL);
  if (!targetDestination) return { eligible: false, reason: 'push_destination_unavailable' };
  const destination = recoveryURL ? trackedPushDestination(targetDestination, recoveryURL, storeURL) : targetDestination;
  if (!destination) return { eligible: false, reason: 'push_tracking_unavailable' };
  const scarcity = scarcityEnabled ? reliableScarcity(cart.items, scarcityThreshold) : null;
  const suffix = scarcity?.lowStock ? ` Only ${scarcity.quantity} left.` : '';
  const product = productSummary(cart.items);
  const title = String(titleTemplate).replaceAll('{{product_name}}', product);
  const body = String(bodyTemplate).replaceAll('{{discount_code}}', DISCOUNT_CODE).replaceAll('{{product_name}}', product);
  return { eligible: true, title, body: `${body}${suffix}`, destination, targetDestination,
    code: DISCOUNT_CODE, percent: 15, scarcity };
}

module.exports = { DISCOUNT_CODE, verifyCouponForCart, reliableScarcity, customerPushDestination,
  trackedPushDestination, composePush };
