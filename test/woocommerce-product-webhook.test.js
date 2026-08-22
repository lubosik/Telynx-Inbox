'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { verifyWooSignature, wooDeliveryID } = require('../lib/woocommerce-webhook');
const { isRestockTransition, stockSnapshot } = require('../lib/campaigns/product-webhooks');

test('Woo signature verification accepts only the matching raw payload', () => {
  const body = Buffer.from('{"id":42,"stock_status":"instock"}');
  const secret = 'offline-test-secret';
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64');
  assert.equal(verifyWooSignature(body, signature, secret), true);
  assert.equal(verifyWooSignature(Buffer.from('{}'), signature, secret), false);
  assert.equal(verifyWooSignature(body, null, secret), false);
});

test('official Woo delivery header wins with legacy fallback retained', () => {
  assert.equal(wooDeliveryID({
    'x-wc-webhook-delivery-id': 'official',
    'x-wc-delivery-id': 'legacy'
  }), 'official');
  assert.equal(wooDeliveryID({ 'x-wc-delivery-id': 'legacy' }), 'legacy');
});

test('first-seen in-stock is not called a restock, but a verified transition is', () => {
  const current = stockSnapshot({ id: 42, name: 'Product', stock_status: 'instock', stock_quantity: 20 });
  assert.equal(isRestockTransition(null, current), false);
  assert.equal(isRestockTransition({ stock_status: 'outofstock', stock_quantity: 0 }, current), true);
  assert.equal(isRestockTransition({ stock_status: 'instock', stock_quantity: 5 }, current), false);
});

test('product ingestion is raw, signature-required and never creates a draft directly', () => {
  const root = path.join(__dirname, '..');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const route = fs.readFileSync(path.join(root, 'routes/webhook-woocommerce.js'), 'utf8');
  const recorder = fs.readFileSync(path.join(root, 'lib/campaigns/product-webhooks.js'), 'utf8');
  assert.match(server, /app\.use\('\/webhook\/woocommerce-product', express\.raw/);
  assert.match(route, /if \(!verifyWooSignature\(req\.body, signature, secret\)\)/);
  assert.ok(route.indexOf('verifyWooSignature(req.body, signature, secret)') <
    route.indexOf('recordTrustedProductEvent({'));
  assert.doesNotMatch(recorder, /sms_campaigns/);
  assert.doesNotMatch(recorder, /sms_campaign_opportunities/);
});
