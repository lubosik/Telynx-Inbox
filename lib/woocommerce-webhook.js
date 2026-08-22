'use strict';

const crypto = require('node:crypto');

function verifyWooSignature(rawBody, signature, secret) {
  if (!Buffer.isBuffer(rawBody) || !signature || !secret) return false;
  try {
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
    const supplied = Buffer.from(String(signature), 'utf8');
    const calculated = Buffer.from(expected, 'utf8');
    return supplied.length === calculated.length && crypto.timingSafeEqual(supplied, calculated);
  } catch {
    return false;
  }
}

/** WooCommerce's documented name, followed by the legacy alias this app read. */
function wooDeliveryID(headers = {}) {
  return headers['x-wc-webhook-delivery-id'] || headers['X-WC-Webhook-Delivery-ID'] ||
    headers['x-wc-delivery-id'] || null;
}

module.exports = { verifyWooSignature, wooDeliveryID };
