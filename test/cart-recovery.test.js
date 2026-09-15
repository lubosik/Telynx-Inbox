'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const crypto = require('node:crypto');
const { normalizeEvent, createCartRecoveryService } = require('../lib/cart-recovery/service');
const { signBody, verifySignature, seal, unseal } = require('../lib/cart-recovery/security');
const { attributionPayload } = require('../lib/cart-recovery/attribution');
const { aggregateRevenue, aggregateRevenueDrivers } = require('../lib/analytics/aggregate');
const { decodeVerifiedTelnyxEvent, claimTelnyxEvent } = require('../lib/telnyx-webhook-claim');

const NOW = new Date('2026-09-15T12:00:00.000Z');
const SECRET = 'test-secret-that-is-long-enough-for-aead-123456';
const ENV = {
  LUKO_WP_STORE_ID: 'vici',
  LUKO_WP_URL: 'https://vicipeptides.com',
  LUKO_WP_SIGNING_SECRET: SECRET,
  CART_RECOVERY_ENABLED: 'true',
  SMS_DRY_RUN: 'true'
};

function cartEvent(overrides = {}) {
  return {
    event_id: 'cart-event-123456', event_type: 'cart.updated', occurred_at: NOW.toISOString(), store: 'vici',
    customer: { wordpress_user_id: 42, phone: '+15551234567' },
    consent: {
      granted: true, phone: '+15551234567', disclosure: 'SMS disclosure', version: 'v1',
      source: 'vici_registration', occurred_at: NOW.toISOString(),
      privacy_url: 'https://vicipeptides.com/privacy-policy/', terms_url: 'https://vicipeptides.com/terms/'
    },
    cart: {
      external_cart_id: 'cart-123456', version: 1, currency: 'USD', total: '120.00',
      last_activity_at: NOW.toISOString(), expires_at: '2026-09-22T12:00:00.000Z',
      recovery_url: `https://vicipeptides.com/r/${'a'.repeat(43)}`,
      items: [{ product_id: 9, variation_id: 0, quantity: 2, variation: {} }]
    },
    ...overrides
  };
}

test('WordPress HMAC covers the exact raw body and rejects tampering or stale timestamps', () => {
  const body = JSON.stringify(cartEvent());
  const timestamp = Math.floor(NOW.getTime() / 1000);
  const headers = signBody(body, SECRET, timestamp);
  assert.equal(verifySignature(Buffer.from(body), headers['X-LUKO-Timestamp'], headers['X-LUKO-Signature'], SECRET, NOW.getTime()), true);
  assert.equal(verifySignature(Buffer.from(`${body} `), headers['X-LUKO-Timestamp'], headers['X-LUKO-Signature'], SECRET, NOW.getTime()), false);
  assert.equal(verifySignature(Buffer.from(body), headers['X-LUKO-Timestamp'], headers['X-LUKO-Signature'], SECRET, NOW.getTime() + 301000), false);
});

test('recovery URLs are encrypted with randomized authenticated encryption', () => {
  const value = `https://vicipeptides.com/r/${'z'.repeat(43)}`;
  const first = seal(value, SECRET);
  const second = seal(value, SECRET);
  assert.notEqual(first, second);
  assert.equal(unseal(first, SECRET), value);
  assert.throws(() => unseal(`${first.slice(0, -1)}x`, SECRET));
});

test('connector validation binds consent to the same normalized phone and Vici origin', () => {
  const valid = normalizeEvent(cartEvent(), ENV, NOW);
  assert.equal(valid.consent.granted, true);
  assert.match(valid.recovery_ciphertext, /^v1\./);
  assert.equal(valid.version, 1);
  const mismatched = cartEvent();
  mismatched.consent.phone = '+15557654321';
  assert.equal(normalizeEvent(mismatched, ENV, NOW).consent.granted, false);
  const hostile = cartEvent();
  hostile.cart.recovery_url = `https://example.com/r/${'a'.repeat(43)}`;
  assert.throws(() => normalizeEvent(hostile, ENV, NOW), { code: 'INVALID_CART_EVENT' });
});

test('dry-run schedules a proposal and never crosses the Telnyx boundary', async () => {
  const cart = {
    id: '8b93f02e-6246-4ca7-b4bd-175963f47bb1', claim_token: 'c1', external_cart_id: 'cart-123456',
    event_version: 1, contact_phone: '+15551234567',
    recovery_ciphertext: seal(`https://vicipeptides.com/r/${'a'.repeat(43)}`, SECRET)
  };
  const calls = [];
  const client = { rpc: async (name, args) => {
    calls.push({ name, args });
    if (name === 'claim_luko_cart_recoveries') return { data: [cart], error: null };
    if (name === 'begin_luko_cart_recovery') return { data: { allowed: true, dry_run: true }, error: null };
    return { data: true, error: null };
  } };
  let sends = 0;
  const service = createCartRecoveryService({
    client, env: ENV, now: () => NOW, send: async () => { sends++; },
    evaluateRecipient: async () => ({ eligible: true }), liveEligibility: async () => ({ allowed: true }),
    fetch: async (_url, request) => ({ ok: true, json: async () => ({
      request_id: JSON.parse(request.body).request_id, eligible: true, current_consent: true,
      external_cart_id: cart.external_cart_id, version: 1, items: [{ product_id: 9 }], order_id: null
    }) })
  });
  const result = await service.runDue();
  assert.equal(result.dryRun, 1);
  assert.equal(sends, 0);
  assert.equal(calls.find(call => call.name === 'begin_luko_cart_recovery').args.p_dry_run, true);
});

test('live delivery requires the provider gate and performs a second WordPress preflight', async () => {
  const env = {
    ...ENV, SMS_DRY_RUN: 'false', LUKO_CART_PROVIDER_APPROVED: 'true',
    TELNYX_API_KEY: 'configured', TELNYX_PHONE_NUMBER: '+15550003184',
    TELNYX_MESSAGING_PROFILE_ID: 'profile-1', TELNYX_PUBLIC_KEY: 'configured'
  };
  const cart = {
    id: '8b93f02e-6246-4ca7-b4bd-175963f47bb1', claim_token: 'c1', external_cart_id: 'cart-123456',
    event_version: 1, contact_phone: '+15551234567',
    recovery_ciphertext: seal(`https://vicipeptides.com/r/${'a'.repeat(43)}`, SECRET)
  };
  const rpcCalls = [];
  const client = {
    rpc: async (name, args) => {
      rpcCalls.push({ name, args });
      if (name === 'claim_luko_cart_recoveries') return { data: [cart], error: null };
      if (name === 'begin_luko_cart_recovery') return { data: { allowed: true, dry_run: false }, error: null };
      return { data: true, error: null };
    },
    from: () => ({
      insert: async () => ({ error: null }),
      update: () => ({ eq: async () => ({ error: null }) })
    })
  };
  let preflights = 0;
  let sends = 0;
  const service = createCartRecoveryService({
    client, env, now: () => NOW,
    evaluateRecipient: async () => ({ eligible: true }), liveEligibility: async () => ({ allowed: true }),
    send: async () => { sends++; return { messageId: 'msg-1' }; },
    fetch: async (_url, request) => {
      preflights++;
      return { ok: true, json: async () => ({ request_id: JSON.parse(request.body).request_id, eligible: true,
        current_consent: true, external_cart_id: cart.external_cart_id, version: 1, items: [{ product_id: 9 }], order_id: null }) };
    }
  });
  const result = await service.runDue();
  assert.equal(result.sent, 1);
  assert.equal(sends, 1);
  assert.equal(preflights, 2);
  assert.equal(rpcCalls.find(call => call.name === 'begin_luko_cart_recovery').args.p_live_allowed, true);
  assert.ok(rpcCalls.some(call => call.name === 'finish_luko_cart_recovery'));
});

test('attribution requires delivery, a bound click, payment, and the 24-hour window', () => {
  const base = {
    status: 'recovered', dry_run: false, attribution_valid: true, workspace_id: 'vici',
    external_cart_id: 'cart-123456', wordpress_user_id: '42', contact_phone: '+15551234567',
    telnyx_message_id: 'msg-1', order_id: '1001', order_status: 'processing', order_currency: 'USD', order_total: '120.00',
    delivered_at: '2026-09-15T12:00:00Z', clicked_at: '2026-09-15T12:05:00Z', order_paid_at: '2026-09-15T12:20:00Z'
  };
  assert.equal(attributionPayload(base).confidence_level, 'direct');
  assert.equal(attributionPayload({ ...base, dry_run: true }), null);
  assert.equal(attributionPayload({ ...base, order_paid_at: '2026-09-17T12:20:00Z' }), null);
});

test('recovered cart revenue appears in LUKO as its own revenue driver', () => {
  const row = {
    id: 'a1', order_id: '1001', category: 'cart_recovery', confidence_level: 'direct',
    confidence_score: '1.00', gross_amount: '120.00', refunded_amount: '0.00', net_amount: '120.00'
  };
  assert.equal(aggregateRevenue([row]).recoveredRevenue, '120.00');
  assert.deepEqual(aggregateRevenueDrivers([row]).map(item => [item.key, item.label]), [
    ['cartRecovery', 'Abandoned Cart Recovery']
  ]);
});

test('cart migrations are pasteable, fail closed, service-role only, and reload PostgREST', () => {
  const root = path.join(__dirname, '..');
  for (const name of ['cart-recovery-migration.sql', 'telnyx-webhook-security-migration.sql']) {
    const sql = fs.readFileSync(path.join(root, 'scripts', name), 'utf8');
    assert.match(sql, /^BEGIN;$/m);
    assert.match(sql, /^COMMIT;$/m);
    assert.match(sql, /NOTIFY pgrst, 'reload schema'/);
    assert.match(sql, /FROM public,anon,authenticated/);
    assert.match(sql, /TO service_role/);
  }
  const cart = fs.readFileSync(path.join(root, 'scripts/cart-recovery-migration.sql'), 'utf8');
  assert.match(cart, /interval '30 minutes'/);
  assert.match(cart, /FOR UPDATE SKIP LOCKED/);
  assert.match(cart, /status='reconciliation_required'/);
});

test('Telnyx events must pass Ed25519 verification before a durable claim is requested', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const event = { data: { id: 'evt-1', event_type: 'message.delivered', occurred_at: NOW.toISOString(), payload: { id: 'msg-1' } } };
  const raw = Buffer.from(JSON.stringify(event));
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  const signature = crypto.sign(null, Buffer.concat([Buffer.from(`${timestamp}|`), raw]), privateKey).toString('base64');
  const headers = { 'telnyx-timestamp': timestamp, 'telnyx-signature-ed25519': signature };
  assert.equal(decodeVerifiedTelnyxEvent(raw, headers, publicKey.export({ format: 'pem', type: 'spki' }), { now: NOW.getTime() }).id, 'evt-1');
  assert.throws(() => decodeVerifiedTelnyxEvent(Buffer.from(`${raw} `), headers, publicKey.export({ format: 'pem', type: 'spki' }), { now: NOW.getTime() }), { status: 403 });
  let claims = 0;
  const client = { rpc: async (name, args) => { claims++; assert.equal(name, 'claim_telnyx_message_event'); assert.equal(args.p_event.provider_event_id, 'evt-1'); return { data: { claimed: true, token: 't1' }, error: null }; } };
  assert.equal((await claimTelnyxEvent(client, event.data, 'delivered')).claimed, true);
  assert.equal(claims, 1);
  const route = fs.readFileSync(path.join(__dirname, '../routes/webhook.js'), 'utf8');
  assert.match(route, /if \(claim\?\.duplicate\) return res\.sendStatus\(200\)/);
  assert.match(route, /await finishTelnyxEvent/);
  assert.match(route, /await failTelnyxEvent/);
});

test('WordPress connector preserves OTP flow and removes the unsafe v0.2 token and cookie design', () => {
  const plugin = fs.readFileSync(path.join(__dirname, '../wordpress/luko-vici-connector/luko-vici-connector.php'), 'utf8');
  assert.match(plugin, /eael\/login-register\/new-user-data/);
  assert.match(plugin, /_eael_otp_pending/);
  assert.match(plugin, /eael_custom_profile_field_phone_number/);
  assert.match(plugin, /name="luko_sms_consent" value="1"/);
  assert.doesNotMatch(plugin, /name="luko_sms_consent"[^>]*checked/);
  assert.match(plugin, /random_bytes\( 32 \)/);
  assert.match(plugin, /luko_recovery_outbox/);
  assert.match(plugin, /luko_recovery_context/);
  assert.doesNotMatch(plugin, /luko_raw_token_/);
  assert.doesNotMatch(plugin, /\$_COOKIE\['luko_recovery_cart'\]/);
});
