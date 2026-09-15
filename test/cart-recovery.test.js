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
const { LOCKED_SMS_TEMPLATE, productSummary, renderLockedSMS } = require('../lib/cart-recovery/copy');
const { deterministicCategory } = require('../lib/cart-recovery/reply');
const { verifyCouponForCart, reliableScarcity, customerPushDestination, DISCOUNT_CODE } = require('../lib/cart-recovery/push');
const { trackedPushDestination } = require('../lib/cart-recovery/push');

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
    customer: { wordpress_user_id: 42, first_name: 'Maya', email: 'maya@example.com', phone: '+15551234567' },
    consent: {
      granted: true, phone: '+15551234567', disclosure: 'SMS disclosure', version: 'v1',
      source: 'vici_registration', occurred_at: NOW.toISOString(),
      privacy_url: 'https://vicipeptides.com/privacy-policy/', terms_url: 'https://vicipeptides.com/terms/'
    },
    cart: {
      external_cart_id: 'cart-123456', version: 1, currency: 'USD', total: '120.00',
      last_activity_at: NOW.toISOString(), expires_at: '2026-09-22T12:00:00.000Z',
      recovery_url: `https://vicipeptides.com/r/${'a'.repeat(43)}`,
      items: [{ product_id: 9, variation_id: 0, quantity: 2, variation: {}, product_name: 'RT',
        product_url: 'https://vicipeptides.com/product/rt/', category_ids: [4], on_sale: false,
        stock_managed: true, stock_quantity: 4, stock_status: 'instock' }]
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
  const tampered = first.split('.');
  tampered[3] = `${tampered[3][0] === 'A' ? 'B' : 'A'}${tampered[3].slice(1)}`;
  assert.throws(() => unseal(tampered.join('.'), SECRET));
});

test('connector validation binds consent to the same normalized phone and Vici origin', () => {
  const valid = normalizeEvent(cartEvent(), ENV, NOW);
  assert.equal(valid.consent.granted, true);
  assert.match(valid.recovery_ciphertext, /^v1\./);
  assert.equal(valid.version, 1);
  assert.equal(valid.customer_first_name, 'Maya');
  assert.equal(valid.items[0].product_name, 'RT');
  const mismatched = cartEvent();
  mismatched.consent.phone = '+15557654321';
  assert.equal(normalizeEvent(mismatched, ENV, NOW).consent.granted, false);
  const hostile = cartEvent();
  hostile.cart.recovery_url = `https://example.com/r/${'a'.repeat(43)}`;
  assert.throws(() => normalizeEvent(hostile, ENV, NOW), { code: 'INVALID_CART_EVENT' });
});

test('existing Woo customers are logged without silently inferring SMS consent from a phone', () => {
  const legacy = cartEvent({
    customer: { wordpress_user_id: 84, first_name: 'Alex', email: 'alex@example.com', phone: '' },
    consent: { granted: false, phone: '', disclosure: '', version: '', source: '',
      occurred_at: NOW.toISOString(), privacy_url: '', terms_url: '' }
  });
  const normalized = normalizeEvent(legacy, ENV, NOW);
  assert.equal(normalized.phone, null);
  assert.equal(normalized.phone_available, false);
  assert.equal(normalized.consent.granted, false);
  assert.equal(normalized.customer_id, '84');
});

test('existing Woo identity reuses canonical LUKO consent without creating a contact', async () => {
  const applied = [];
  const client = {
    rpc: async (name, args) => {
      if (name === 'resolve_luko_cart_customer_identity') return { data: {
        identity_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        contact_phone: '+15551234567', luko_contact_linked: true, resolved_by: 'external_mapping'
      }, error: null };
      if (name === 'apply_luko_cart_event') { applied.push(args.p_event); return { data: { accepted: true }, error: null }; }
      throw new Error(`Unexpected RPC ${name}`);
    },
    from: table => {
      assert.equal(table, 'sms_consent_events');
      const chain = {
        select: () => chain, eq: () => chain, order: () => chain,
        limit: async () => ({ data: [{ id: 91, event_type: 'opt_in', source: 'woocommerce_account_registration',
          evidence_ref: 'WooCommerce customer #42', purpose: 'promotional_sms', brand_id: 'vici',
          occurred_at: '2026-09-01T12:00:00.000Z' }], error: null })
      };
      return chain;
    }
  };
  const noConnectorConsent = cartEvent({
    consent: { granted: false, phone: '', disclosure: '', version: '', source: '',
      occurred_at: NOW.toISOString(), privacy_url: '', terms_url: '' }
  });
  const service = createCartRecoveryService({ client, env: ENV, now: () => NOW });
  await service.processEvent(noConnectorConsent);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].customer_identity_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(applied[0].phone, '+15551234567');
  assert.equal(applied[0].consent.granted, true);
  assert.equal(applied[0].consent.resolved_by, 'existing_luko_consent');
});

test('stable identity never transfers fresh consent to a different phone', async () => {
  let applied;
  const client = {
    rpc: async (name, args) => {
      if (name === 'resolve_luko_cart_customer_identity') return { data: {
        identity_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        contact_phone: '+15557654321', luko_contact_linked: true, resolved_by: 'wordpress_user_id'
      }, error: null };
      if (name === 'apply_luko_cart_event') { applied = args.p_event; return { data: { accepted: true }, error: null }; }
      throw new Error(`Unexpected RPC ${name}`);
    },
    from: () => {
      const chain = { select: () => chain, eq: () => chain, order: () => chain,
        limit: async () => ({ data: [{ id: 92, event_type: 'opt_out', source: 'customer_reply',
          evidence_ref: null, purpose: 'promotional_sms', brand_id: 'vici',
          occurred_at: '2026-09-14T12:00:00.000Z' }], error: null }) };
      return chain;
    }
  };
  const service = createCartRecoveryService({ client, env: ENV, now: () => NOW });
  await service.processEvent(cartEvent());
  assert.equal(applied.phone, '+15557654321');
  assert.equal(applied.consent.granted, false);
  assert.equal(applied.consent.resolved_by, 'phone_identity_mismatch');
});

test('ambiguous email or phone identity is visible but never SMS eligible', async () => {
  let applied;
  const client = { rpc: async (name, args) => {
    if (name === 'resolve_luko_cart_customer_identity') return { data: {
      identity_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', contact_phone: null,
      luko_contact_linked: false, ambiguous: true, resolved_by: 'new_mapping'
    }, error: null };
    if (name === 'apply_luko_cart_event') { applied = args.p_event; return { data: { accepted: true }, error: null }; }
    throw new Error(`Unexpected RPC ${name}`);
  } };
  const service = createCartRecoveryService({ client, env: ENV, now: () => NOW });
  await service.processEvent(cartEvent());
  assert.equal(applied.phone_available, true);
  assert.equal(applied.identity_resolution_ambiguous, true);
  assert.equal(applied.consent.granted, false);
  assert.equal(applied.consent.resolved_by, 'ambiguous_customer_identity');
});

test('locked Vin SMS is personalized, readable, and summarizes multi-item carts exactly', () => {
  const url = `https://vicipeptides.com/r/${'a'.repeat(43)}`;
  assert.equal(productSummary([{ product_name: 'RT', quantity: 1 }]), 'RT');
  assert.equal(productSummary([{ product_name: 'RT', quantity: 1 }, { product_name: 'TZ', quantity: 2 }]), 'RT and 2 other items');
  const personalized = renderLockedSMS({ customerFirstName: 'Maya', items: [{ product_name: 'RT', quantity: 1 }], recoveryURL: url });
  assert.equal(personalized, LOCKED_SMS_TEMPLATE.replace('{{first_name}}', 'Maya').replace('{{product_name}}', 'RT').replace('{{recovery_url}}', url));
  assert.match(renderLockedSMS({ customerFirstName: '', items: [], recoveryURL: url }), /^Hey, it's Vin from Vici\./);
});

test('cart reply classification uses the required objections and escalates medical language', () => {
  assert.equal(deterministicCategory('My card was declined').category, 'payment_problem');
  assert.equal(deterministicCategory('Why is the shipping fee so high?').category, 'shipping_cost');
  assert.equal(deterministicCategory('The checkout page keeps crashing').category, 'website_problem');
  const medical = deterministicCategory('Can you tell me what dose to take?');
  assert.equal(medical.category, 'needs_help');
  assert.equal(medical.medical, true);
});

test('Vici15 push is offered only when WooCommerce proves exact cart applicability', () => {
  const coupon = { status: 'publish', code: 'vici15', discount_type: 'percent', amount: '15.00',
    minimum_amount: '100', maximum_amount: '', usage_limit: null, usage_count: 0,
    product_ids: [], excluded_product_ids: [99], product_categories: [], excluded_product_categories: [], exclude_sale_items: false };
  const cart = { total: 120, items: [{ product_id: 9, variation_id: 0, category_ids: [4], on_sale: false }] };
  assert.deepEqual(verifyCouponForCart(coupon, cart, NOW), { eligible: true, code: DISCOUNT_CODE, percent: 15 });
  assert.equal(verifyCouponForCart(coupon, { ...cart, items: [{ ...cart.items[0], product_id: 99 }] }, NOW).reason, 'cart_product_excluded');
  assert.equal(verifyCouponForCart({ ...coupon, amount: '10' }, cart, NOW).reason, 'coupon_terms_mismatch');
  assert.equal(verifyCouponForCart({ ...coupon, email_restrictions: ['vip@example.com'] },
    { ...cart, customer_email: 'other@example.com' }, NOW).reason, 'coupon_email_restricted');
  assert.equal(verifyCouponForCart({ ...coupon, usage_limit_per_user: 1, used_by: ['42'] },
    { ...cart, wordpress_user_id: '42' }, NOW).reason, 'coupon_customer_usage_exhausted');
  assert.equal(verifyCouponForCart({ ...coupon, individual_use: true },
    { ...cart, applied_coupons: ['WELCOME10'] }, NOW).reason, 'coupon_conflicts_with_cart');
});

test('push scarcity and destination claims fail closed without reliable WooCommerce evidence', () => {
  assert.equal(reliableScarcity([{ stock_managed: false, stock_quantity: 2 }]), null);
  assert.deepEqual(reliableScarcity([{ stock_managed: true, stock_quantity: 3 }], 5), { lowStock: true, quantity: 3 });
  assert.equal(customerPushDestination({ items: [{ product_url: 'https://vicipeptides.com/product/rt/' }] }, 'https://vicipeptides.com'), 'https://vicipeptides.com/product/rt/');
  assert.equal(customerPushDestination({ items: [{}, {}] }, 'https://vicipeptides.com'), 'https://vicipeptides.com/shop/');
  const tracked = trackedPushDestination('https://vicipeptides.com/product/rt/',
    `https://vicipeptides.com/r/${'p'.repeat(43)}`, 'https://vicipeptides.com');
  assert.match(tracked, new RegExp(`^https://vicipeptides\\.com/luko-go/${'p'.repeat(43)}/\\?to=`));
  assert.equal(trackedPushDestination('https://example.com/product/rt/',
    `https://vicipeptides.com/r/${'p'.repeat(43)}`, 'https://vicipeptides.com'), null);
});

test('push worker uses the dedicated push claim token', async () => {
  const pushClaim = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  let beginArgs;
  const cart = {
    id: '8b93f02e-6246-4ca7-b4bd-175963f47bb1', push_claim_token: pushClaim,
    external_cart_id: 'cart-123456', event_version: 1, customer_push_permission: false,
    customer_push_destination_id: null, cart_total: 120,
    recovery_ciphertext: seal(`https://vicipeptides.com/r/${'p'.repeat(43)}`, SECRET),
    cart_items: [{ product_id: 9, variation_id: 0, quantity: 1, product_name: 'RT',
      product_url: 'https://vicipeptides.com/product/rt/', category_ids: [4], on_sale: false }]
  };
  const client = { rpc: async (name, args) => {
    if (name === 'claim_luko_cart_pushes') return { data: [cart], error: null };
    if (name === 'begin_luko_cart_push') { beginArgs = args; return { data: { allowed: false }, error: null }; }
    return { data: true, error: null };
  } };
  const service = createCartRecoveryService({
    client, env: { ...ENV, CART_RECOVERY_PUSH_ENABLED: 'true' }, now: () => NOW,
    loadSettings: async () => ({ push_enabled: true, low_stock_enabled: false }),
    couponLookup: async () => ({ status: 'publish', code: 'vici15', discount_type: 'percent', amount: '15',
      minimum_amount: '', maximum_amount: '', usage_limit: null, usage_count: 0,
      product_ids: [], excluded_product_ids: [], product_categories: [], excluded_product_categories: [], exclude_sale_items: false }),
    fetch: async (_url, request) => ({ ok: true, json: async () => ({
      request_id: JSON.parse(request.body).request_id, eligible: true, external_cart_id: cart.external_cart_id,
      version: cart.event_version, items: cart.cart_items, order_id: null
    }) })
  });
  const summary = await service.runPushDue();
  assert.equal(summary.claimed, 1);
  assert.equal(beginArgs.p_claim, pushClaim);
  assert.equal(beginArgs.p_dry_run, true);
});

test('live customer push performs a final purchase preflight before the provider boundary', async () => {
  const pushClaim = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const cart = {
    id: '8b93f02e-6246-4ca7-b4bd-175963f47bb1', push_claim_token: pushClaim,
    external_cart_id: 'cart-123456', event_version: 1, customer_push_permission: true,
    customer_push_destination_id: 'shopper-device-1', cart_total: 120, customer_email: 'maya@example.com',
    wordpress_user_id: '42', cart_applied_coupons: [],
    recovery_ciphertext: seal(`https://vicipeptides.com/r/${'p'.repeat(43)}`, SECRET),
    cart_items: [{ product_id: 9, variation_id: 0, quantity: 1, product_name: 'RT',
      product_url: 'https://vicipeptides.com/product/rt/', category_ids: [4], on_sale: false }]
  };
  const calls = [];
  const client = { rpc: async (name, args) => {
    calls.push({ name, args });
    if (name === 'claim_luko_cart_pushes') return { data: [cart], error: null };
    if (name === 'begin_luko_cart_push') return { data: { allowed: true, customer_push_destination_id: 'shopper-device-1' }, error: null };
    if (name === 'confirm_luko_cart_push_send') return { data: { allowed: true, customer_push_destination_id: 'shopper-device-1' }, error: null };
    return { data: true, error: null };
  } };
  let preflights = 0;
  let pushes = 0;
  const service = createCartRecoveryService({
    client, env: { ...ENV, CART_RECOVERY_PUSH_ENABLED: 'true', CART_RECOVERY_PUSH_DRY_RUN: 'false' }, now: () => NOW,
    loadSettings: async () => ({ push_enabled: true, low_stock_enabled: false }),
    couponLookup: async () => ({ status: 'publish', code: 'vici15', discount_type: 'percent', amount: '15',
      minimum_amount: '', maximum_amount: '', usage_limit: null, usage_count: 0, usage_limit_per_user: 1, used_by: [],
      email_restrictions: [], product_ids: [], excluded_product_ids: [], product_categories: [], excluded_product_categories: [], exclude_sale_items: false }),
    sendCustomerPush: async payload => { pushes++; assert.equal(payload.destinationID, 'shopper-device-1'); return { messageId: 'push-1' }; },
    fetch: async (_url, request) => {
      preflights++;
      return { ok: true, json: async () => ({ request_id: JSON.parse(request.body).request_id,
        eligible: true, external_cart_id: cart.external_cart_id, version: cart.event_version,
        items: cart.cart_items, order_id: null }) };
    }
  });
  const summary = await service.runPushDue();
  assert.equal(preflights, 2);
  assert.equal(pushes, 1);
  assert.equal(summary.sent, 1);
  assert.ok(calls.some(call => call.name === 'confirm_luko_cart_push_send' && call.args.p_claim === pushClaim));
  assert.ok(calls.some(call => call.name === 'finish_luko_cart_push' && call.args.p_claim === pushClaim));
});

test('live customer push stops when the database state changes at the provider boundary', async () => {
  const pushClaim = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const cart = {
    id: '8b93f02e-6246-4ca7-b4bd-175963f47bb1', push_claim_token: pushClaim,
    external_cart_id: 'cart-123456', event_version: 1, customer_push_permission: true,
    customer_push_destination_id: 'shopper-device-1', cart_total: 120, customer_email: 'maya@example.com',
    wordpress_user_id: '42', cart_applied_coupons: [],
    recovery_ciphertext: seal(`https://vicipeptides.com/r/${'p'.repeat(43)}`, SECRET),
    cart_items: [{ product_id: 9, variation_id: 0, quantity: 1, product_name: 'RT',
      product_url: 'https://vicipeptides.com/product/rt/', category_ids: [4], on_sale: false }]
  };
  const calls = [];
  const client = { rpc: async (name, args) => {
    calls.push({ name, args });
    if (name === 'claim_luko_cart_pushes') return { data: [cart], error: null };
    if (name === 'begin_luko_cart_push') return { data: { allowed: true, customer_push_destination_id: 'shopper-device-1' }, error: null };
    if (name === 'confirm_luko_cart_push_send') return { data: { allowed: false, reason: 'state_changed' }, error: null };
    return { data: true, error: null };
  } };
  let pushes = 0;
  const service = createCartRecoveryService({
    client, env: { ...ENV, CART_RECOVERY_PUSH_ENABLED: 'true', CART_RECOVERY_PUSH_DRY_RUN: 'false' }, now: () => NOW,
    loadSettings: async () => ({ push_enabled: true, low_stock_enabled: false }),
    couponLookup: async () => ({ status: 'publish', code: 'vici15', discount_type: 'percent', amount: '15',
      minimum_amount: '', maximum_amount: '', usage_limit: null, usage_count: 0, usage_limit_per_user: 1, used_by: [],
      email_restrictions: [], product_ids: [], excluded_product_ids: [], product_categories: [], excluded_product_categories: [], exclude_sale_items: false }),
    sendCustomerPush: async () => { pushes++; return { messageId: 'must-not-send' }; },
    fetch: async (_url, request) => ({ ok: true, json: async () => ({ request_id: JSON.parse(request.body).request_id,
      eligible: true, external_cart_id: cart.external_cart_id, version: cart.event_version,
      items: cart.cart_items, order_id: null }) })
  });
  const summary = await service.runPushDue();
  assert.equal(pushes, 0);
  assert.equal(summary.blocked, 1);
  assert.ok(calls.some(call => call.name === 'mark_luko_cart_push_blocked' && call.args.p_reason === 'state_changed'));
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
    loadSettings: async () => ({ enabled: true, push_enabled: false }),
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
    loadSettings: async () => ({ enabled: true, push_enabled: false }),
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
  const push = attributionPayload({
    ...base, dry_run: true, telnyx_message_id: null, delivered_at: null, clicked_at: null,
    push_provider_message_id: 'push-1', push_sent_at: '2026-09-15T12:00:00Z',
    push_clicked_at: '2026-09-15T12:05:00Z'
  });
  assert.equal(push.originating_action_type, 'push');
  assert.equal(push.originating_action_id, 'push-1');
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
  assert.match(cart, /interval '45 minutes'/);
  assert.match(cart, /FOR UPDATE SKIP LOCKED/);
  assert.match(cart, /status='reconciliation_required'/);
  const growth = fs.readFileSync(path.join(root, 'scripts/cart-recovery-growth-migration.sql'), 'utf8');
  assert.match(growth, /CREATE TABLE IF NOT EXISTS public\.luko_customer_identities/);
  assert.match(growth, /resolve_luko_cart_customer_identity/);
  assert.match(growth, /luko_contact_linked/);
  assert.match(growth, /v_ambiguous/);
  assert.match(growth, /journey_status IN \('SENT','DELIVERED','CLICKED','REPLIED'\)/);
  assert.match(growth, /push_clicked_at IS NOT NULL/);
  assert.match(growth, /p_dry_run boolean,p_discount_verified/);
  assert.match(growth, /phone_available|contact_phone/);
  assert.match(growth, /interval '45 minutes'|make_interval\(mins=>v_sms_delay\)/);
  assert.match(growth, /automatic_ai_sending boolean NOT NULL DEFAULT false/);
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
  assert.match(plugin, /automated marketing SMS messages from Vici Peptides/);
  assert.match(plugin, /luko_vici_sms_disclosure_version', 'v2'/);
  assert.match(plugin, /random_bytes\( 32 \)/);
  assert.match(plugin, /luko_recovery_outbox/);
  assert.match(plugin, /luko_recovery_context/);
  assert.match(plugin, /'phone_available' => '' !== self::resolve_phone/);
  assert.match(plugin, /'push_permission' => false/);
  assert.match(plugin, /\^luko-go\//);
  assert.match(plugin, /'click_channel' => 'push'/);
  assert.match(plugin, /'applied_coupons' => array_values/);
  assert.doesNotMatch(plugin, /if \( ! self::has_consent\( \$user_id \) \) return;/);
  assert.doesNotMatch(plugin, /luko_raw_token_/);
  assert.doesNotMatch(plugin, /\$_COOKIE\['luko_recovery_cart'\]/);
});
