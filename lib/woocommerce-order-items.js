'use strict';

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Preserve authoritative WooCommerce product and variation identifiers inside
 * the existing sms_orders.items JSON. Older rows keep working because every
 * added key is optional; new campaign attribution can use exact identifiers
 * instead of guessing from a mutable product name.
 */
function wooOrderItems(order = {}) {
  return (Array.isArray(order.line_items) ? order.line_items : []).map(item => ({
    product_id: positiveInteger(item?.product_id),
    variation_id: positiveInteger(item?.variation_id),
    name: typeof item?.name === 'string' ? item.name : null,
    quantity: Number.isFinite(Number(item?.quantity)) ? Number(item.quantity) : 0,
    total: item?.total ?? null,
    sku: typeof item?.sku === 'string' && item.sku ? item.sku : null
  }));
}

module.exports = { positiveInteger, wooOrderItems };
