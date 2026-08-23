'use strict';
/**
 * Checkout consent capture — the fail-closed tests are the point of this file.
 *
 * Recording consent that was never given is the worst outcome available to this
 * code: it manufactures the evidence that would later be used to justify texting
 * someone who never agreed. So most of what follows asserts an ABSENCE — that
 * the ledger was not written to at all — rather than a return value, because a
 * return value can be wrong in a way that still leaves a row in the database.
 *
 * The fake client is a thenable with `then` only, exactly like a real Supabase
 * query builder. If anything in the module under test ever reaches for
 * `.catch()` on it, these tests fail rather than production.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_META_KEY,
  REASON,
  billingConsentPhone,
  captureCheckoutConsent,
  consentTimestamp,
  detectCheckoutOptIn,
  isAffirmativeOptIn,
  metaKeysOnOrder,
  optInMetaKey,
  recordCheckoutConsent,
  resetOptInFieldAbsentWarning
} = require('../lib/campaigns/checkout-consent');
const { SOURCE } = require('../lib/campaigns/consent');

const SILENT = { error() {}, warn() {}, log() {} };

/** A builder-shaped thenable: `then` and nothing else. */
function thenable(value) {
  return { then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) };
}

/**
 * @param {(row: object) => object} reply  what the insert resolves to.
 */
function fakeClient(reply = () => ({ error: null })) {
  const inserts = [];
  return {
    inserts,
    from(table) {
      return {
        insert(row) {
          inserts.push({ table, row });
          return thenable(reply(row, inserts));
        }
      };
    }
  };
}

/** Explicit "the checkbox is not on this order at all". `undefined` cannot say
 *  that: passing it would trigger the default parameter and quietly tick the
 *  box, which made four fail-closed tests vacuous the first time this ran. */
const NO_FIELD = Symbol('no opt-in field');

function order(overrides = {}, optIn = '1') {
  const meta = optIn === NO_FIELD ? [] : [{ id: 9, key: DEFAULT_META_KEY, value: optIn }];
  return {
    id: 12345,
    status: 'processing',
    customer_id: 77,
    date_created_gmt: '2026-08-20T15:04:05',
    date_created: '2026-08-20T11:04:05',
    billing: {
      first_name: 'Dana',
      last_name: 'Reyes',
      email: 'dana@example.com',
      phone: '(305) 555-1234'
    },
    meta_data: [{ id: 1, key: '_billing_address_index', value: 'noise' }, ...meta],
    ...overrides
  };
}

/**
 * A verified webhook.
 *
 * Every positive case in this file has to pass one, because the module fails
 * closed on anything else — including, deliberately, a deployment with no
 * WC_WEBHOOK_SECRET at all. These tests used to omit it and still expect a
 * write, which is precisely the forgeable behaviour that was removed: see
 * "an unsigned webhook records nothing, even with no secret configured".
 */
const VERIFIED = Object.freeze({ secretConfigured: true, signatureValid: true });

/** Records and returns [result, client] with a default-happy ledger. */
async function record(orderObject, options = {}) {
  const client = options.client || fakeClient();
  const result = await recordCheckoutConsent({
    client, order: orderObject, env: {}, ...VERIFIED, ...options, client
  });
  return [result, client];
}

// ── The tick is recorded ────────────────────────────────────────────────────

test('an explicit tick is recorded as promotional consent against the order', async () => {
  const [result, client] = await record(order());

  assert.equal(result.recorded, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.reason, REASON.RECORDED);
  assert.equal(result.phone, '+13055551234');
  assert.equal(result.evidenceRef, 'woo_order:12345');

  assert.equal(client.inserts.length, 1);
  const { table, row } = client.inserts[0];
  assert.equal(table, 'sms_consent_events');
  assert.equal(row.event_type, 'opt_in');
  assert.equal(row.purpose, 'promotional_sms');
  assert.equal(row.source, SOURCE.CHECKOUT_OPT_IN);
  assert.equal(row.source, 'woocommerce_checkout_sms_optin');
  assert.equal(row.evidence_ref, 'woo_order:12345');
  assert.equal(row.dedupe_key, 'woo-order-optin:12345');
  assert.equal(row.contact_phone, '+13055551234');
});

test('every affirmative WooCommerce writes for a checkbox is accepted', async () => {
  for (const value of ['1', 'yes', 'true', 'on', true, 'YES', ' True ', 'On', 1]) {
    const [result, client] = await record(order({}, value));
    assert.equal(result.recorded, true, `${JSON.stringify(value)} must be an opt-in`);
    assert.equal(client.inserts.length, 1, `${JSON.stringify(value)} must write exactly one row`);
  }
});

test('the source is the named checkout basis, never a free-text string', () => {
  assert.equal(SOURCE.CHECKOUT_OPT_IN, 'woocommerce_checkout_sms_optin');
});

// ── Fail closed: nothing reaches the ledger ─────────────────────────────────

test('an absent opt-in field is not consent and writes nothing', async () => {
  const [result, client] = await record(order({}, NO_FIELD));
  assert.equal(result.recorded, false);
  assert.equal(result.reason, REASON.FIELD_ABSENT);
  assert.deepEqual(client.inserts, []);
});

test('an order with no meta_data at all is not consent', async () => {
  for (const meta of [undefined, null, [], {}, 'nonsense', 0]) {
    const [result, client] = await record(order({ meta_data: meta }, NO_FIELD));
    assert.equal(result.recorded, false, `meta_data=${JSON.stringify(meta)}`);
    assert.equal(result.reason, REASON.FIELD_ABSENT);
    assert.deepEqual(client.inserts, []);
  }
});

test('every negative, empty or unexpected value fails closed', async () => {
  const notConsent = [
    '0', 'no', 'false', 'off', 'NO', 'False', '', '   ', 'null', 'undefined',
    'yes please', 'y', 'checked', '2', '01', 'ye s',
    false, 0, 2, -1, null, undefined, {}, [], ['1'], ['yes'], { value: 'yes' },
    Number.NaN
  ];

  for (const value of notConsent) {
    // The value is placed directly, so `undefined` means "the field exists and
    // holds undefined" rather than tripping the helper's default.
    const subject = order({ meta_data: [{ key: DEFAULT_META_KEY, value }] }, NO_FIELD);
    const [result, client] = await record(subject);
    assert.equal(
      result.recorded, false,
      `${JSON.stringify(value) ?? String(value)} must NOT be treated as consent`
    );
    assert.equal(result.reason, REASON.NOT_AFFIRMATIVE);
    assert.deepEqual(
      client.inserts, [],
      `${JSON.stringify(value) ?? String(value)} must not reach the ledger`
    );
  }
});

test('a near-miss meta key is not the configured field', async () => {
  const nearMisses = ['sms_marketing_optin', '_sms_marketing_opt_in', '_SMS_MARKETING_OPTIN', '_sms_marketing_optin '];
  for (const key of nearMisses) {
    const subject = order({ meta_data: [{ key, value: 'yes' }] }, NO_FIELD);
    const [result, client] = await record(subject);
    assert.equal(result.recorded, false, key);
    assert.equal(result.reason, REASON.FIELD_ABSENT);
    assert.deepEqual(client.inserts, []);
  }
});

test('two conflicting entries for the same key mean we do not know, so we do not record', async () => {
  const subject = order({
    meta_data: [
      { key: DEFAULT_META_KEY, value: 'yes' },
      { key: DEFAULT_META_KEY, value: 'no' }
    ]
  }, NO_FIELD);

  const [result, client] = await record(subject);
  assert.equal(result.recorded, false);
  assert.equal(result.reason, REASON.CONFLICTING_VALUES);
  assert.deepEqual(client.inserts, []);
});

test('repeated entries that all agree are still a single opt-in', async () => {
  const subject = order({
    meta_data: [
      { key: DEFAULT_META_KEY, value: '1' },
      { key: DEFAULT_META_KEY, value: 'yes' }
    ]
  }, NO_FIELD);

  const [result, client] = await record(subject);
  assert.equal(result.recorded, true);
  assert.equal(client.inserts.length, 1);
});

test('a ticked box with an unusable phone number records nothing', async () => {
  const unusable = ['', '   ', 'not a phone', '555-1234', '12345', '+', '+0123456789', null, undefined, {}];
  for (const phone of unusable) {
    const [result, client] = await record(order({ billing: { phone } }));
    assert.equal(result.recorded, false, JSON.stringify(phone));
    assert.equal(result.reason, REASON.INVALID_PHONE);
    assert.deepEqual(client.inserts, []);
  }
});

test('a number too long for E.164 is refused rather than written', async () => {
  const [result, client] = await record(order({ billing: { phone: '+1234567890123456789' } }));
  assert.equal(result.recorded, false);
  assert.equal(result.reason, REASON.INVALID_PHONE);
  assert.deepEqual(client.inserts, []);
});

test('a number written with a country code is never re-read as a US number', async () => {
  // '+0123456789' is ten digits after the '+', which the shared normaliser
  // would turn into '+10123456789' — a different subscriber.
  for (const phone of ['+0123456789', '+012 345 6789']) {
    const [result, client] = await record(order({ billing: { phone } }));
    assert.equal(result.recorded, false, phone);
    assert.equal(result.reason, REASON.INVALID_PHONE);
    assert.deepEqual(client.inserts, []);
  }

  // Genuine international and NANP numbers still pass through unchanged.
  for (const [phone, expected] of [
    ['+447506440284', '+447506440284'],
    ['+1 (305) 555-1234', '+13055551234'],
    ['3055551234', '+13055551234'],
    ['13055551234', '+13055551234']
  ]) {
    const [result] = await record(order({ billing: { phone } }));
    assert.equal(result.phone, expected, phone);
  }
});

test('the billing phone is used, never a number recovered from elsewhere on the order', async () => {
  // MUTATION-PROVEN. This test previously set a VALID billing.phone alongside
  // the shipping one, so a `|| order?.shipping?.phone` fallback in the source
  // never had to fire: the mutant passed 36/36. The only fixture that can catch
  // the fallback is one where billing.phone is UNUSABLE and the other numbers
  // are perfectly good — the exact shape a fallback exists to rescue.
  const decoys = { shipping: { phone: '+19995550000' }, _resolved_phone: '+19995550000' };

  // 1. No billing phone at all.
  {
    const [result, client] = await record(order({ billing: { phone: undefined }, ...decoys }));
    assert.equal(result.recorded, false, 'a missing billing phone must not fall back to shipping');
    assert.equal(result.reason, REASON.INVALID_PHONE);
    assert.equal(result.phone, null);
    assert.deepEqual(client.inserts, []);
  }

  // 2. A billing phone that exists but cannot be normalised. The consent was
  //    given next to the number the customer typed at checkout; a number lifted
  //    from the shipping address or resolved out of another system was never
  //    under the disclosure they read, whoever it belongs to.
  for (const unusable of ['', '   ', 'not a phone', '555-1234', '+', '3055551234 ext 22']) {
    const [result, client] = await record(order({ billing: { phone: unusable }, ...decoys }));
    assert.equal(result.recorded, false, JSON.stringify(unusable));
    assert.equal(result.reason, REASON.INVALID_PHONE, JSON.stringify(unusable));
    assert.equal(result.phone, null);
    assert.deepEqual(
      client.inserts, [],
      `${JSON.stringify(unusable)} must not be rescued by shipping.phone or _resolved_phone`
    );
  }

  // 3. A usable billing phone is the one written, even when the decoys differ.
  const [result, client] = await record(order({ billing: { phone: '+13055551234' }, ...decoys }));
  assert.equal(result.phone, '+13055551234');
  assert.equal(client.inserts[0].row.contact_phone, '+13055551234');
});

test('a phone number is never invented from an extension or a foreign format', async () => {
  // Every one of these was executed against the previous normaliser and every
  // one produced a real, writable E.164 number belonging to somebody else. The
  // '+' guard did not fire on three of them because it only ran when the input
  // began with '+', and it never ran at all on the extension cases.
  const fabrications = [
    ['3055551234 ext 22', '+305555123422'],
    ['305.555.1234.22', '+305555123422'],
    ['+1 (305) 555-1234x9', '+130555512349'],
    ['13055551234 #5', '+130555512345'],
    ['0412345678', '+10412345678'],
    ['(305) 555-1234 x9', null],
    ['3055551234x', null],
    ['1 800 FLOWERS', null],
    ['305 555 1234 ext. 100', null],
    ['+44 7506 440284 ext 3', null],
    ['447506440284', null]
  ];

  for (const [input, fabricated] of fabrications) {
    const [result, client] = await record(order({ billing: { phone: input } }));
    assert.equal(result.recorded, false, `${JSON.stringify(input)} must be refused`);
    assert.equal(result.reason, REASON.INVALID_PHONE, JSON.stringify(input));
    assert.equal(result.phone, null);
    assert.deepEqual(
      client.inserts, [],
      `${JSON.stringify(input)} must not record consent`
        + `${fabricated ? ` against ${fabricated}` : ''}`
    );
  }
});

test('billingConsentPhone reproduces the customer digits exactly, or refuses', () => {
  // The invariant, stated directly: the output is the input's own digits with
  // at most a NANP country code in front. Nothing else is a defensible record.
  for (const input of [
    '(305) 555-1234', '+1 (305) 555-1234', '3055551234', '13055551234',
    '+447506440284', '+44 7506 440284', '+61412345678'
  ]) {
    const out = billingConsentPhone({ billing: { phone: input } });
    const digits = input.replace(/\D/g, '');
    assert.ok(out, `${input} should normalise`);
    assert.ok(
      out === `+${digits}` || out === `+1${digits}`,
      `${input} -> ${out} added or dropped a digit`
    );
    assert.match(out, /^\+[1-9][0-9]{7,14}$/);
  }

  for (const input of [
    '3055551234 ext 22', '305.555.1234.22', '+1 (305) 555-1234x9', '13055551234 #5',
    '0412345678', '(305) 555-1234 x9', '+0123456789', '+1234567890123456789',
    '12345', '', '   ', null, undefined, {}, [], true
  ]) {
    assert.equal(
      billingConsentPhone({ billing: { phone: input } }), null,
      `${JSON.stringify(input)} must be refused, not guessed at`
    );
  }

  assert.equal(billingConsentPhone({}), null);
  assert.equal(billingConsentPhone(null), null);
  assert.equal(billingConsentPhone({ billing: {} }), null);
});

test('an order with no usable id cannot produce evidence', async () => {
  for (const id of [undefined, null, '', '  ', 0, '0', -3, 'abc', '12a', true, {}, 1.5]) {
    const [result, client] = await record(order({ id }));
    assert.equal(result.recorded, false, JSON.stringify(id));
    assert.equal(result.reason, REASON.NO_ORDER_ID);
    assert.deepEqual(client.inserts, []);
  }
});

test('a missing order or missing client is refused, not assumed', async () => {
  for (const bad of [undefined, null, 'a string', 42, []]) {
    const client = fakeClient();
    const result = await recordCheckoutConsent({ client, order: bad, env: {}, ...VERIFIED });
    assert.equal(result.recorded, false);
    assert.ok([REASON.NO_ORDER, REASON.NO_ORDER_ID].includes(result.reason), result.reason);
    assert.deepEqual(client.inserts, []);
  }

  const result = await recordCheckoutConsent({ client: null, order: order(), env: {}, ...VERIFIED });
  assert.equal(result.recorded, false);
  assert.equal(result.reason, REASON.CLIENT_REQUIRED);
});

// ── The forged-webhook case ─────────────────────────────────────────────────

test('a deployment that can verify signatures refuses unverified consent', async () => {
  for (const signatureValid of [false, null, undefined, 'true', 1]) {
    const [result, client] = await record(order(), { secretConfigured: true, signatureValid });
    assert.equal(result.recorded, false, String(signatureValid));
    assert.equal(result.reason, REASON.UNVERIFIED_WEBHOOK);
    assert.deepEqual(client.inserts, []);
  }
});

test('a verified webhook records, and marks the row as verified', async () => {
  const [result, client] = await record(order(), { secretConfigured: true, signatureValid: true });
  assert.equal(result.recorded, true);
  assert.equal(client.inserts[0].row.metadata.signature_verified, true);
});

test('an unsigned webhook records nothing, even with no secret configured', async () => {
  // THE FORGERY. /webhook/woocommerce is unauthenticated, and WC_WEBHOOK_SECRET
  // is empty in this repository's own .env. The gate this replaces read
  // `secretConfigured && signatureValid !== true`, so with no secret configured
  // it recorded — meaning one anonymous curl carrying any phone number and
  // `_sms_marketing_optin: 1` wrote a CHECKOUT_OPT_IN row, the strongest basis
  // in the ledger, and made that number sendable.
  //
  // `metadata.signature_verified: false` was not a defence: nothing reads it.
  // The only defence is refusing to write, so this asserts the ABSENCE of a row
  // rather than a flag on one.
  for (const signatureValid of [false, null, undefined, 'true', 1, 0, '', {}]) {
    const [result, client] = await record(order(), { secretConfigured: false, signatureValid });
    assert.equal(result.recorded, false, `secret unset + signatureValid=${String(signatureValid)}`);
    assert.equal(result.reason, REASON.UNVERIFIED_WEBHOOK);
    assert.deepEqual(
      client.inserts, [],
      'an unverifiable deployment must write nothing at all: losing a genuine tick is '
      + 'recoverable on the next order, a ledger the public can write to is not evidence'
    );
  }

  // Not even the defaults. A caller that forgets to pass the verification
  // result gets the refusal, not the benefit of the doubt.
  const client = fakeClient();
  const bare = await recordCheckoutConsent({ client, order: order(), env: {} });
  assert.equal(bare.recorded, false);
  assert.equal(bare.reason, REASON.UNVERIFIED_WEBHOOK);
  assert.deepEqual(client.inserts, []);
});

// ── Replay ──────────────────────────────────────────────────────────────────

test('a replayed webhook is a duplicate, not a second opt-in', async () => {
  const seen = new Set();
  const client = fakeClient(row => {
    if (seen.has(row.dedupe_key)) {
      return { error: { code: '23505', message: 'duplicate key value violates sms_consent_events_dedupe_idx' } };
    }
    seen.add(row.dedupe_key);
    return { error: null };
  });

  const first = await recordCheckoutConsent({ client, order: order(), env: {}, ...VERIFIED });
  const second = await recordCheckoutConsent({
    client, order: order({ status: 'completed' }), env: {}, ...VERIFIED
  });

  assert.equal(first.recorded, true);
  assert.equal(first.duplicate, false);
  assert.equal(second.recorded, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.reason, REASON.DUPLICATE);
  assert.equal(seen.size, 1, 'one order, one consent row');
});

test('the dedupe key is per order, so a second genuine order is its own evidence', async () => {
  const client = fakeClient();
  await recordCheckoutConsent({ client, order: order({ id: 1 }), env: {}, ...VERIFIED });
  await recordCheckoutConsent({ client, order: order({ id: 2 }), env: {}, ...VERIFIED });
  assert.deepEqual(
    client.inserts.map(i => i.row.dedupe_key),
    ['woo-order-optin:1', 'woo-order-optin:2']
  );
});

test('consent is captured regardless of order status — the tick is not the payment', async () => {
  for (const status of ['pending', 'processing', 'on-hold', 'failed', 'completed', 'refunded', 'cancelled']) {
    const [result] = await record(order({ status }));
    assert.equal(result.recorded, true, status);
  }
});

// ── Configuration ───────────────────────────────────────────────────────────

test('the meta key is configurable and the default is the documented one', async () => {
  assert.equal(optInMetaKey({}), '_sms_marketing_optin');
  assert.equal(optInMetaKey({ WC_SMS_OPTIN_META_KEY: '  ' }), '_sms_marketing_optin');
  assert.equal(optInMetaKey({ WC_SMS_OPTIN_META_KEY: 'sms_optin' }), 'sms_optin');

  const env = { WC_SMS_OPTIN_META_KEY: 'sms_optin' };
  const subject = order({ meta_data: [{ key: 'sms_optin', value: 'yes' }] }, NO_FIELD);

  const client = fakeClient();
  const configured = await recordCheckoutConsent({ client, order: subject, env, ...VERIFIED });
  assert.equal(configured.recorded, true);
  assert.equal(client.inserts[0].row.metadata.meta_key, 'sms_optin');

  // The same order under the default key is not consent.
  const other = fakeClient();
  const unconfigured = await recordCheckoutConsent({
    client: other, order: subject, env: {}, ...VERIFIED
  });
  assert.equal(unconfigured.recorded, false);
  assert.deepEqual(other.inserts, []);
});

test('the disclosure version travels with the row so later copy changes cannot rewrite history', async () => {
  const client = fakeClient();
  await recordCheckoutConsent({
    client, order: order(), env: { WC_SMS_OPTIN_DISCLOSURE_VERSION: 'checkout-2026-08' }, ...VERIFIED
  });
  assert.equal(client.inserts[0].row.metadata.disclosure_version, 'checkout-2026-08');

  const bare = fakeClient();
  await recordCheckoutConsent({ client: bare, order: order(), env: {}, ...VERIFIED });
  assert.equal(bare.inserts[0].row.metadata.disclosure_version, 'unversioned');
});

// ── What the evidence row contains ──────────────────────────────────────────

test('the metadata carries the basis and no customer identity', async () => {
  const [, client] = await record(order());
  const { metadata } = client.inserts[0].row;

  assert.deepEqual(metadata, {
    woo_order_id: '12345',
    woo_customer_id: 77,
    order_status: 'processing',
    meta_key: '_sms_marketing_optin',
    meta_value: '1',
    disclosure_version: 'unversioned',
    capture_path: 'woocommerce_order_webhook',
    // Always true on a recorded row: an unverified webhook never gets this far.
    signature_verified: true
  });

  const serialised = JSON.stringify(metadata);
  for (const pii of ['Dana', 'Reyes', 'dana@example.com', '3055551234', '305']) {
    assert.ok(!serialised.includes(pii), `metadata must not contain ${pii}`);
  }
});

test('the consent timestamp reads WooCommerce GMT fields as UTC, not server-local', async () => {
  const [, client] = await record(order());
  assert.equal(client.inserts[0].row.occurred_at, '2026-08-20T15:04:05.000Z');

  assert.equal(consentTimestamp({ date_created_gmt: '2026-08-20T15:04:05Z' }), '2026-08-20T15:04:05.000Z');
  assert.equal(consentTimestamp({ date_paid_gmt: '2026-01-02T03:04:05' }), '2026-01-02T03:04:05.000Z');
  assert.equal(consentTimestamp({ date_created_gmt: 'not-a-date', date_created: '' }), null);
  assert.equal(consentTimestamp({}), null);
});

test('an order with no dates still records, stamped by the ledger', async () => {
  const [result, client] = await record(order({ date_created_gmt: null, date_created: null }));
  assert.equal(result.recorded, true);
  assert.ok(Number.isFinite(new Date(client.inserts[0].row.occurred_at).getTime()));
});

// ── Failure never escapes ───────────────────────────────────────────────────

test('a rejected ledger write is reported, never thrown at the order path', async () => {
  const client = fakeClient(() => ({ error: { code: '42501', message: 'permission denied' } }));
  const result = await recordCheckoutConsent({ client, order: order(), env: {}, ...VERIFIED });
  assert.equal(result.recorded, false);
  assert.equal(result.reason, REASON.WRITE_FAILED);
});

test('a client that throws, rejects, or returns nonsense cannot break the caller', async () => {
  const throwing = { from() { throw new Error('boom'); } };
  const rejecting = { from: () => ({ insert: () => Promise.reject(new Error('network')) }) };
  const nonsense = { from: () => ({ insert: () => thenable(null) }) };
  const missingInsert = { from: () => ({}) };

  for (const client of [throwing, rejecting, nonsense, missingInsert]) {
    const result = await recordCheckoutConsent({ client, order: order(), env: {}, ...VERIFIED });
    assert.equal(result.recorded, false);
    assert.equal(result.reason, REASON.WRITE_FAILED);
  }
});

test('the fire-and-forget wrapper resolves rather than rejecting, whatever happens', async () => {
  const failing = { from() { throw new Error('boom'); } };

  const bad = await captureCheckoutConsent({
    client: failing, order: order(), env: {}, log: SILENT, ...VERIFIED
  });
  assert.equal(bad.recorded, false);

  const good = await captureCheckoutConsent({
    client: fakeClient(), order: order(), env: {}, log: SILENT, ...VERIFIED
  });
  assert.equal(good.recorded, true);

  // No log object at all must not turn into a TypeError inside the wrapper.
  const quiet = await captureCheckoutConsent({
    client: fakeClient(), order: order(), env: {}, log: {}, ...VERIFIED
  });
  assert.equal(quiet.recorded, true);
});

test('the wrapper never puts a phone number in the log line', async () => {
  const lines = [];
  const log = { log: m => lines.push(m), warn: m => lines.push(m), error: m => lines.push(m) };

  await captureCheckoutConsent({ client: fakeClient(), order: order(), env: {}, log, ...VERIFIED });
  await captureCheckoutConsent({
    client: fakeClient(), order: order({}, 'no'), env: {}, log, ...VERIFIED
  });

  assert.ok(lines.length > 0, 'something was logged');
  for (const line of lines) {
    assert.ok(!line.includes('3055551234'), line);
    assert.ok(!line.includes('dana@example.com'), line);
  }
});

test('an absent checkbox warns exactly once per process, listing the keys it did see', async () => {
  // The absent field is the normal case for a customer who did not tick the
  // box, so it cannot warn per order. It is ALSO the only symptom of a
  // one-character typo in WC_SMS_OPTIN_META_KEY, which otherwise produces a
  // permanently empty consent ledger and a completely clean log. One warning
  // per process, naming the keys the order actually carries, is the compromise.
  resetOptInFieldAbsentWarning();

  const lines = [];
  const log = { log: m => lines.push(m), warn: m => lines.push(m), error: m => lines.push(m) };

  const subject = order({
    meta_data: [
      { id: 1, key: '_billing_address_index', value: 'Dana Reyes dana@example.com 3055551234' },
      { id: 2, key: '_sms_marketing_opt_in', value: '1' }
    ]
  }, NO_FIELD);

  await captureCheckoutConsent({ client: fakeClient(), order: subject, env: {}, log, ...VERIFIED });
  assert.equal(lines.length, 1, 'the misconfiguration must be visible at least once');

  const [warning] = lines;
  assert.match(warning, /_sms_marketing_optin/, 'the configured key we looked for');
  assert.match(warning, /WC_SMS_OPTIN_META_KEY/, 'the variable to correct');
  // The near-miss key is the whole diagnostic: it is one underscore away.
  assert.match(warning, /_sms_marketing_opt_in/);
  assert.match(warning, /_billing_address_index/);

  // Keys only. Meta VALUES routinely carry names, emails and phone numbers, and
  // a diagnostic line is not a place to spill them.
  for (const pii of ['Dana', 'Reyes', 'dana@example.com', '3055551234']) {
    assert.ok(!warning.includes(pii), `the warning must not contain ${pii}`);
  }

  // Every subsequent order is silent, including a different one.
  await captureCheckoutConsent({ client: fakeClient(), order: subject, env: {}, log, ...VERIFIED });
  await captureCheckoutConsent({
    client: fakeClient(), order: order({ id: 999 }, NO_FIELD), env: {}, log, ...VERIFIED
  });
  assert.equal(lines.length, 1, 'one line per process, not one per order');

  resetOptInFieldAbsentWarning();
});

test('the once-per-process warning survives an order with no meta_data at all', async () => {
  resetOptInFieldAbsentWarning();
  const lines = [];
  const log = { warn: m => lines.push(m), log: m => lines.push(m), error: m => lines.push(m) };

  await captureCheckoutConsent({
    client: fakeClient(), order: order({ meta_data: null }, NO_FIELD), env: {}, log, ...VERIFIED
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0], /\(none\)/);
  resetOptInFieldAbsentWarning();
});

test('metaKeysOnOrder returns distinct string keys and never a value', () => {
  assert.deepEqual(metaKeysOnOrder({
    meta_data: [
      { key: 'a', value: 'secret' }, { key: 'a', value: 'secret' }, { key: 'b', value: 'secret' },
      { key: '', value: 'x' }, { key: 7, value: 'x' }, null, 'nonsense', ['a'], { value: 'x' }
    ]
  }), ['a', 'b']);

  assert.deepEqual(metaKeysOnOrder({}), []);
  assert.deepEqual(metaKeysOnOrder(null), []);
  assert.deepEqual(metaKeysOnOrder({ meta_data: 'nonsense' }), []);

  // Bounded, so a pathological order cannot produce an unbounded log line.
  const many = { meta_data: Array.from({ length: 200 }, (_, i) => ({ key: `k${i}`, value: 'v' })) };
  assert.equal(metaKeysOnOrder(many).length, 40);
  assert.equal(metaKeysOnOrder(many, 3).length, 3);
});

// ── The pure decision, on its own ───────────────────────────────────────────

test('isAffirmativeOptIn accepts exactly the documented set', () => {
  for (const value of ['1', 'yes', 'true', 'on', 'YES', 'TRUE', ' on ', true, 1]) {
    assert.equal(isAffirmativeOptIn(value), true, JSON.stringify(value));
  }
  for (const value of ['0', 'no', 'false', 'off', '', ' ', 'y', 'yes!', '1 ok', 'ontario',
    false, 0, 2, null, undefined, {}, [], ['1'], new String('yes'), Symbol.iterator]) {
    assert.equal(isAffirmativeOptIn(value), false, String(typeof value));
  }
});

test('detectCheckoutOptIn reports the decision without a client', () => {
  assert.deepEqual(detectCheckoutOptIn({ order: order(), env: {} }), {
    metaKey: '_sms_marketing_optin', present: true, optedIn: true, reason: null, rawValue: '1'
  });
  assert.equal(detectCheckoutOptIn({ order: order({}, 'no'), env: {} }).optedIn, false);
  assert.equal(detectCheckoutOptIn({ order: undefined, env: {} }).present, false);
  assert.equal(detectCheckoutOptIn({}).present, false);
});

// ── Where it is wired ───────────────────────────────────────────────────────
//
// These read source text rather than behaviour, deliberately. The behavioural
// tests above prove the module is fail-closed; they say nothing about whether
// anything ever calls it, or about the one property that cannot be observed
// from inside the module — that a HISTORICAL bulk sync must never manufacture
// consent for orders placed before the checkbox existed.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('the live order webhook captures consent, and does not await it', () => {
  const source = readSource('routes/webhook-woocommerce.js');

  assert.match(source, /require\('\.\.\/lib\/campaigns\/checkout-consent'\)/);
  assert.match(
    source, /void captureCheckoutConsent\(/,
    'the capture must be fire-and-forget: an order confirmation SMS may never wait on a consent write'
  );
  assert.doesNotMatch(
    source, /await\s+captureCheckoutConsent\(/,
    'awaiting it would put a consent write on the customer SMS path'
  );

  const call = source.slice(source.indexOf('void captureCheckoutConsent('));
  assert.match(call, /secretConfigured:\s*Boolean\(process\.env\.WC_WEBHOOK_SECRET\)/);
  assert.match(call, /signatureValid/);
});

test('the capture runs before the first await, so a sync failure cannot drop the tick', () => {
  // The handler wraps everything in one try/catch. Anything sequenced after an
  // `await` is skipped entirely when that await throws, and the customer's
  // opt-in is gone with no second chance: WooCommerce's retry replays the same
  // failure. The capture used to sit under `await syncOrder(...)` while its own
  // comment claimed it was placed early for exactly this reason.
  const source = readSource('routes/webhook-woocommerce.js');
  const handler = source.slice(source.indexOf("router.post('/woocommerce'"));
  // Comments are blanked, not removed, so every index below still lines up with
  // the real source. The comment above the capture says the word "await".
  const body = handler
    .slice(0, handler.indexOf('\n  });'))
    .replace(/\/\/[^\n]*/g, match => ' '.repeat(match.length));

  const capture = body.indexOf('void captureCheckoutConsent(');
  assert.ok(capture > 0, 'the order webhook must capture checkout consent');

  const firstAwait = body.search(/\bawait\s/);
  assert.ok(firstAwait > 0, 'the handler does await something');
  assert.ok(
    capture < firstAwait,
    'captureCheckoutConsent must be reached before any await in the handler, '
    + 'because every await here throws into the same outer catch'
  );

  assert.ok(
    capture < body.indexOf('await syncOrder('),
    'specifically: before await syncOrder(...)'
  );
});

test('historical bulk sync never records consent', () => {
  // syncOrder runs for both live webhooks and `runWooSync`, the full-store
  // backfill. Wiring capture in there would write a consent row for every past
  // order that happens to carry the meta key — evidence for an agreement nobody
  // made under a disclosure nobody was shown. The webhook is the only entry
  // point that is unambiguously a live checkout.
  for (const file of ['sync-woocommerce.js', 'woocommerce.js']) {
    assert.doesNotMatch(
      readSource(file), /checkout-consent|captureCheckoutConsent|recordCheckoutConsent/,
      `${file} must not capture consent: it also serves historical backfills`
    );
  }
});

test('both configuration variables are documented in .env.example', () => {
  const example = readSource('.env.example');
  assert.match(example, /^WC_SMS_OPTIN_META_KEY=/m);
  assert.match(example, /^WC_SMS_OPTIN_DISCLOSURE_VERSION=/m);
});
