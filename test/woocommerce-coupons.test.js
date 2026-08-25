'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BATCH_LIMIT,
  CouponRequestError,
  couponSpec,
  createCoupons,
  deleteCoupon,
  findCouponByCode,
  generateCode
} = require('../lib/woocommerce-coupons');
const { sanitiseCode } = require('../lib/campaigns/merge-fields');

/** No sleeping in tests; record what would have been slept instead. */
function recordingSleep(log) {
  return async (ms) => { log.push(ms); };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

/**
 * A fake fetch that answers every batch POST by echoing each requested
 * coupon back as created, while recording the size of every request. Pass
 * overrides to script specific responses per call index.
 */
function fakeBatchFetch(calls, overrides = {}) {
  return async (url, init) => {
    const index = calls.length;
    const payload = JSON.parse(init.body);
    calls.push({ url, size: payload.create.length });
    if (overrides[index]) return overrides[index](payload);
    return jsonResponse({ create: payload.create.map((c, i) => ({ id: index * 1000 + i, code: c.code })) });
  };
}

function specs(count) {
  return Array.from({ length: count }, (_, i) => couponSpec({ code: generateCode({ seed: `spec:${i}` }), percent: 10 }));
}

test('createCoupons sends exactly one request for exactly 100 specs', async () => {
  const calls = [];
  const sleeps = [];
  const result = await createCoupons(specs(100), { fetchImpl: fakeBatchFetch(calls), sleep: recordingSleep(sleeps) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].size, 100);
  assert.equal(result.created.length, 100);
  assert.equal(result.failed.length, 0);
  assert.equal(sleeps.length, 0, 'no inter-batch delay when there is only one batch');
});

test('createCoupons splits 101 specs into 100 + 1 with a delay between', async () => {
  const calls = [];
  const sleeps = [];
  const result = await createCoupons(specs(101), {
    fetchImpl: fakeBatchFetch(calls),
    sleep: recordingSleep(sleeps),
    delayMs: 250
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(c => c.size), [100, 1]);
  assert.deepEqual(sleeps, [250]);
  assert.equal(result.created.length, 101);
});

test('createCoupons splits 250 specs into 100 + 100 + 50', async () => {
  const calls = [];
  const sleeps = [];
  const result = await createCoupons(specs(250), { fetchImpl: fakeBatchFetch(calls), sleep: recordingSleep(sleeps) });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(c => c.size), [100, 100, 50]);
  assert.deepEqual(sleeps, [250, 250], 'a delay before every batch after the first');
  assert.equal(result.created.length, 250);
});

test('a per-item failure inside a 200 batch lands in failed, not thrown', async () => {
  const input = specs(3);
  const calls = [];
  const fetchImpl = fakeBatchFetch(calls, {
    0: (payload) => jsonResponse({ create: [
      { id: 1, code: payload.create[0].code },
      { error: { code: 'woocommerce_rest_invalid_coupon', message: 'Amount out of range.' } },
      { id: 3, code: payload.create[2].code }
    ] })
  });
  const result = await createCoupons(input, { fetchImpl, sleep: recordingSleep([]) });
  assert.equal(result.created.length, 2);
  assert.equal(result.failed.length, 1);
  assert.deepEqual(result.failed[0], {
    code: input[1].code,
    errorCode: 'woocommerce_rest_invalid_coupon',
    reason: 'Amount out of range.',
    duplicate: false
  });
});

test('a duplicate code is reported as recoverable, never thrown', async () => {
  const input = specs(2);
  const calls = [];
  const fetchImpl = fakeBatchFetch(calls, {
    0: (payload) => jsonResponse({ create: [
      { error: { code: 'woocommerce_rest_coupon_code_already_exists', message: 'The coupon code already exists' } },
      { id: 2, code: payload.create[1].code }
    ] })
  });
  const result = await createCoupons(input, { fetchImpl, sleep: recordingSleep([]) });
  assert.equal(result.created.length, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].code, input[0].code);
  assert.equal(result.failed[0].duplicate, true, 'a re-run hitting its own codes must be recoverable');
});

test('429 is retried with backoff and then succeeds', async () => {
  const input = specs(1);
  const sleeps = [];
  let attempts = 0;
  const fetchImpl = async (url, init) => {
    attempts += 1;
    if (attempts === 1) return jsonResponse({}, 429);
    const payload = JSON.parse(init.body);
    return jsonResponse({ create: payload.create.map((c, i) => ({ id: i + 1, code: c.code })) });
  };
  const result = await createCoupons(input, { fetchImpl, sleep: recordingSleep(sleeps), retryBaseMs: 100 });
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [100], 'one backoff sleep for the one retry');
  assert.equal(result.created.length, 1);
});

test('a 400 is not retried and throws a typed error', async () => {
  let attempts = 0;
  const fetchImpl = async () => { attempts += 1; return jsonResponse({}, 400); };
  await assert.rejects(
    createCoupons(specs(1), { fetchImpl, sleep: recordingSleep([]) }),
    (error) => error instanceof CouponRequestError && error.code === 'COUPON_BATCH_REJECTED' && error.status === 400
  );
  assert.equal(attempts, 1, 'a non-429 4xx must never be retried');
});

test('persistent 5xx exhausts bounded attempts then throws', async () => {
  let attempts = 0;
  const fetchImpl = async () => { attempts += 1; return jsonResponse({}, 503); };
  await assert.rejects(
    createCoupons(specs(1), { fetchImpl, sleep: recordingSleep([]), maxAttempts: 3 }),
    (error) => error instanceof CouponRequestError && error.code === 'COUPON_BATCH_EXHAUSTED'
  );
  assert.equal(attempts, 3);
});

test('generateCode is deterministic: same seed, same code', () => {
  const a = generateCode({ prefix: 'vip', seed: 'campaign-7:customer-42' });
  const b = generateCode({ prefix: 'vip', seed: 'campaign-7:customer-42' });
  assert.equal(a, b);
  assert.notEqual(a, generateCode({ prefix: 'vip', seed: 'campaign-7:customer-43' }));
});

test('every generated code passes merge-fields sanitiseCode, 500 codes with and without prefixes', () => {
  for (let i = 0; i < 500; i += 1) {
    // Not "save5": "save" is a carrier-filter term, so every code built on it
    // is refused by the copy rules. That is now a fast, named error rather
    // than an exhausted retry loop, and it has its own test below.
    const prefix = i % 3 === 0 ? '' : (i % 3 === 1 ? 'vp' : 'vin');
    const code = generateCode({ prefix, seed: `shape:${i}` });
    assert.match(code, /^[a-z0-9-]{4,16}$/);
    assert.equal(sanitiseCode(code), code, `sanitiseCode must accept ${code} unchanged or the recipient is dropped`);
  }
});

test('5000 distinct seeds produce 5000 distinct codes', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i += 1) {
    seen.add(generateCode({ seed: `collision:${i}` }));
  }
  assert.equal(seen.size, 5000);
});

test('generateCode refuses a missing seed and a bad prefix', () => {
  assert.throws(() => generateCode({}), (e) => e.code === 'COUPON_SEED_REQUIRED');
  assert.throws(() => generateCode({ prefix: 'TOOLONGPREFIX', seed: 'x' }), (e) => e.code === 'COUPON_PREFIX_INVALID');
  assert.throws(() => generateCode({ prefix: 'a_b', seed: 'x' }), (e) => e.code === 'COUPON_PREFIX_INVALID');
});

test('couponSpec defaults enforce single-person, single-use codes', () => {
  const spec = couponSpec({ code: 'vip-abc123', percent: 15 });
  assert.equal(spec.individual_use, true);
  assert.equal(spec.usage_limit, 1);
  assert.equal(spec.usage_limit_per_user, 1);
  assert.equal(spec.discount_type, 'percent');
});

test('couponSpec amount is a string, as WooCommerce requires', () => {
  const spec = couponSpec({ code: 'vip-abc123', percent: 12.5 });
  assert.equal(typeof spec.amount, 'string');
  assert.equal(spec.amount, '12.5');
});

test('couponSpec accepts expiry and email, lowercasing the email', () => {
  const spec = couponSpec({
    code: 'vip-abc123',
    percent: 10,
    expiresAt: '2026-09-01T23:59:59',
    emailRestriction: 'Person@Example.com'
  });
  assert.equal(spec.date_expires, '2026-09-01T23:59:59');
  assert.deepEqual(spec.email_restrictions, ['person@example.com']);
});

test('couponSpec rejects invalid input with typed errors', () => {
  assert.throws(() => couponSpec({ code: 'BAD CODE', percent: 10 }), (e) => e.code === 'COUPON_CODE_INVALID');
  assert.throws(() => couponSpec({ code: 'abc', percent: 10 }), (e) => e.code === 'COUPON_CODE_INVALID');
  assert.throws(() => couponSpec({ code: 'a'.repeat(17), percent: 10 }), (e) => e.code === 'COUPON_CODE_INVALID');
  assert.throws(() => couponSpec({ code: 'vip-abc123', percent: 0 }), (e) => e.code === 'COUPON_PERCENT_INVALID');
  assert.throws(() => couponSpec({ code: 'vip-abc123', percent: 101 }), (e) => e.code === 'COUPON_PERCENT_INVALID');
  assert.throws(() => couponSpec({ code: 'vip-abc123', percent: 'ten' }), (e) => e.code === 'COUPON_PERCENT_INVALID');
  assert.throws(() => couponSpec({ code: 'vip-abc123', percent: 10, usageLimit: 0 }), (e) => e.code === 'COUPON_USAGE_LIMIT_INVALID');
  // A timezone designator would be misread as site time or rejected outright.
  assert.throws(
    () => couponSpec({ code: 'vip-abc123', percent: 10, expiresAt: '2026-09-01T23:59:59Z' }),
    (e) => e.code === 'COUPON_EXPIRY_INVALID'
  );
  assert.throws(
    () => couponSpec({ code: 'vip-abc123', percent: 10, expiresAt: '2026-09-01' }),
    (e) => e.code === 'COUPON_EXPIRY_INVALID'
  );
  assert.throws(
    () => couponSpec({ code: 'vip-abc123', percent: 10, emailRestriction: 'not-an-email' }),
    (e) => e.code === 'COUPON_EMAIL_INVALID'
  );
});

test('findCouponByCode returns the coupon or null and lowercases the lookup', async () => {
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return jsonResponse([{ id: 9, code: 'vip-abc123' }]); };
  const found = await findCouponByCode('VIP-ABC123', { fetchImpl });
  assert.equal(found.id, 9);
  assert.match(seen[0], /code=vip-abc123/);

  const empty = await findCouponByCode('vip-nothing', { fetchImpl: async () => jsonResponse([]) });
  assert.equal(empty, null);
});

test('deleteCoupon passes force through and validates the id', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, method: init.method }); return jsonResponse({ id: 5 }); };
  await deleteCoupon(5, { fetchImpl });
  await deleteCoupon(6, { force: true, fetchImpl });
  assert.match(seen[0].url, /\/coupons\/5\?force=false/);
  assert.match(seen[1].url, /\/coupons\/6\?force=true/);
  assert.equal(seen[0].method, 'DELETE');
  await assert.rejects(deleteCoupon('nope', { fetchImpl }), (e) => e.code === 'COUPON_ID_INVALID');
});

test('BATCH_LIMIT is the WooCommerce hard cap of 100', () => {
  assert.equal(BATCH_LIMIT, 100);
});

test('A GENERATED CODE IS SAFE TO PUT IN A MESSAGE', () => {
  // FOUND AGAINST REAL DATA, not imagined. Rendering a win-back for 200 real
  // customers produced "vin-6m10cc5sl3" for one of them. The substring "10cc"
  // matches the dose-measurement pattern in the copy rules, the rendered
  // message failed validation, and that customer was silently dropped.
  //
  // Ten random base36 characters produce "10cc", "5ml" and "20mg" at a low but
  // entirely reachable rate. Measured before the fix: eight in three thousand.
  // At five hundred recipients it happens, and it happens invisibly.
  const { validateCopy } = require('../lib/campaigns/copy-validator');
  const { RULES } = require('../lib/campaigns/copy-rules');
  const brandName = RULES.brand.defaultName;

  let unsafe = 0;
  for (let index = 0; index < 3000; index += 1) {
    const code = generateCode({ prefix: 'vin', seed: `winback-${index}` });
    const message = `${brandName}. Hi Mark, it has been a while. Use ${code} for 15% off your next order. ${RULES.optOut.exactSuffix}`;
    if (!validateCopy(message, { brandName, approvedProductCodes: [code] }).ok) unsafe += 1;
  }
  assert.equal(unsafe, 0, 'a generated code must never be the reason a message is refused');
});

test('the exact code that caused it is no longer produced for that customer', () => {
  // Regression, pinned to the real seed. The dose-shaped code was the first
  // hash for this input, so this only passes because the rehash happens.
  const code = generateCode({ prefix: 'vin', seed: 'winback-+18563790172' });
  assert.doesNotMatch(code, /\d+(?:mg|mcg|ug|iu|ml|cc)\b/i);
});

test('rehashing for safety does not cost determinism', () => {
  // The attempt counter is part of the hash input, so a seed that needed three
  // attempts needs three attempts every time. Re-running a campaign has to
  // give somebody the code they already have, not a second one.
  for (const seed of ['winback-1', 'winback-99', 'loyalty-4']) {
    assert.equal(generateCode({ prefix: 'vin', seed }), generateCode({ prefix: 'vin', seed }));
  }
});


test('a prefix carrying a banned word is refused immediately, with the real reason', () => {
  // Found by this file's own fixture, which used "save5". Every code built on
  // it is unusable because "save" is a carrier-filter term, and the honest
  // failure is to say so rather than to hash twenty-four times and report that
  // no code could be generated, which sends somebody looking at the generator.
  for (const prefix of ['save5', 'free', 'cash']) {
    assert.throws(
      () => generateCode({ prefix, seed: 'anything' }),
      (error) => error.code === 'COUPON_PREFIX_UNSAFE',
      `"${prefix}" should be refused up front`
    );
  }
  assert.doesNotThrow(() => generateCode({ prefix: 'vin', seed: 'anything' }));
});
