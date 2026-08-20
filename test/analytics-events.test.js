'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';
const { attributionInvalidation, eventTypeForStatus, refundedAmount } = require('../lib/analytics/events');
const { verifyWebhookSignatureV2 } = require('../telnyx');

test('verifies current Telnyx Ed25519 webhooks and rejects replay/tampering', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const timestamp = '1787241600';
  const body = Buffer.from('{"data":{"id":"event-1"}}');
  const signature = crypto.sign(
    null,
    Buffer.concat([Buffer.from(`${timestamp}|`), body]),
    privateKey
  ).toString('base64');
  const publicPEM = publicKey.export({ type: 'spki', format: 'pem' });
  const now = Number(timestamp) * 1000;
  assert.equal(verifyWebhookSignatureV2(body, signature, timestamp, publicPEM, { now }), true);
  assert.equal(verifyWebhookSignatureV2(Buffer.from('{}'), signature, timestamp, publicPEM, { now }), false);
  assert.equal(verifyWebhookSignatureV2(body, signature, timestamp, publicPEM, { now: now + 301000 }), false);
});

test('maps authoritative Woo financial states to analytics events', () => {
  assert.equal(eventTypeForStatus('processing'), 'payment_completed');
  assert.equal(eventTypeForStatus('completed'), 'order_completed');
  assert.equal(eventTypeForStatus('refunded'), 'order_refunded');
  assert.equal(eventTypeForStatus('failed'), 'payment_pending');
  assert.equal(eventTypeForStatus('on-hold'), 'payment_pending');
  assert.equal(eventTypeForStatus('cancelled'), 'order_cancelled');
});

test('refund calculation handles partial and over-sized provider records safely', () => {
  assert.equal(refundedAmount({ total: '100.00', refunds: [{ total: '-20.50' }] }), 20.5);
  assert.equal(refundedAmount({ total: '100.00', refunds: [{ total: '-70' }, { total: '-50' }] }), 100);
  assert.equal(refundedAmount({ total: '100.00', refunds: [] }), 0);
});

test('cancelled and fully refunded orders invalidate prior revenue attribution', () => {
  const at = new Date('2026-08-20T12:00:00Z');
  assert.deepEqual(attributionInvalidation({ status: 'cancelled' }, { netAmount: 100, refundedAmount: 0 }, at), {
    invalidatedAt: at.toISOString(), reason: 'Authoritative order was cancelled.'
  });
  assert.deepEqual(attributionInvalidation({ status: 'refunded' }, { netAmount: 0, refundedAmount: 100 }, at), {
    invalidatedAt: at.toISOString(), reason: 'Authoritative order status is refunded.'
  });
  assert.deepEqual(attributionInvalidation({ status: 'refunded', refunds: [] }, { netAmount: 100, refundedAmount: 0 }, at), {
    invalidatedAt: at.toISOString(), reason: 'Authoritative order status is refunded.'
  });
  assert.deepEqual(attributionInvalidation({ status: 'processing' }, { netAmount: 0, refundedAmount: 100 }, at), {
    invalidatedAt: at.toISOString(), reason: 'Order was fully refunded.'
  });
  assert.deepEqual(attributionInvalidation({ status: 'processing' }, { netAmount: 80, refundedAmount: 20 }, at), {
    invalidatedAt: null, reason: null
  });
});

test('Woo analytics capture stays after and outside the operational SMS critical path', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'webhook-woocommerce.js'), 'utf8');
  const switchIndex = source.indexOf('switch (status)');
  const captureIndex = source.indexOf('void recordWooOrderEvent');
  assert.ok(switchIndex >= 0 && captureIndex > switchIndex);
  assert.equal(source.includes('await recordWooOrderEvent(order'), false);
});

test('analytics migration keeps client roles out of protected state-changing RPCs', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'analytics-migration.sql'), 'utf8');
  assert.match(sql, /ALTER TABLE revenue_attributions ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE analytics_message_events ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE message_sentiment ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON FUNCTION bump_analytics_state\(text\) FROM PUBLIC/);
  assert.match(sql, /REVOKE ALL ON FUNCTION bump_analytics_state\(text\) FROM anon/);
  assert.match(sql, /REVOKE ALL ON FUNCTION bump_analytics_state\(text\) FROM authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION bump_analytics_state\(text\) TO service_role/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION promote_analytics_backfill\(p_run_id uuid\)[\s\S]*?SET search_path = ''/);
  assert.match(sql, /IF target_run\.status <> 'staged' THEN/);
  assert.match(sql, /ON CONFLICT \(workspace_id, order_id\) DO NOTHING/);
  assert.match(sql, /REVOKE ALL ON FUNCTION promote_analytics_backfill\(uuid\) FROM PUBLIC/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION promote_analytics_backfill\(uuid\) TO service_role/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION preserve_revenue_attribution_revision\(\)[\s\S]*?SET search_path = ''/);
  assert.match(sql, /review_status IN \('pending', 'rule_accepted', 'sample_reviewed', 'approved', 'rejected'\)/);
});

test('live attribution accepts only trusted Telnyx delivery and reply evidence', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'analytics', 'events.js'), 'utf8');
  assert.match(source, /from\('analytics_message_events'\)/);
  assert.match(source, /\.eq\('trusted', true\)/);
  assert.match(source, /\.eq\('event_type', 'message\.received'\)/);
  assert.doesNotMatch(source, /from\('sms_messages'\)[\s\S]{0,200}select\('telnyx_message_id,status'\)/);
});
