'use strict';
/**
 * lib/woocommerce-coupons.js - per-customer discount codes in WooCommerce.
 *
 * THIS IS THE FIRST WRITE PATH TO WOOCOMMERCE IN THIS REPO
 *
 * Everything else in this codebase reads from the store (woocommerce.js is
 * GET-only by design). Creating coupons is the first mutation, so this module
 * is deliberately narrow: it creates coupons, finds them, and deletes them.
 * It never touches orders, products, or customers, and it never sends
 * anything. If a future feature needs another write, it gets its own module
 * with the same level of care rather than a general-purpose wooPost.
 *
 * THE CONSTRAINTS THAT SHAPED THIS FILE
 *
 *   1. THE BATCH ENDPOINT CAPS AT 100 OBJECTS PER REQUEST. WooCommerce
 *      enforces this server-side on /coupons/batch. Sending 101 does not
 *      create 100 and fail 1; the whole request is rejected. So we chunk at
 *      100 and send chunks sequentially with a small delay, which also keeps
 *      the site's WAF from reading a burst of POSTs as an attack.
 *
 *   2. PER-ITEM FAILURES DO NOT SHOW UP IN THE HTTP STATUS. A batch request
 *      returns 200 even when some of its items failed. Each element of the
 *      response array carries its own optional `error`. Trusting the status
 *      code alone means declaring victory over coupons that were never
 *      created, so every element is inspected individually.
 *
 *   3. A DUPLICATE CODE IS A RE-RUN, NOT A FAILURE. Re-running a campaign
 *      regenerates the same deterministic code for the same person (see
 *      generateCode), and WooCommerce answers with
 *      woocommerce_rest_coupon_code_already_exists. That is the system
 *      working as intended, so duplicates are reported in `failed` with
 *      `duplicate: true` instead of being thrown. A campaign re-run must
 *      never explode because it already succeeded once.
 *
 *   4. CODES ARE LOWERCASE ONLY. WooCommerce lowercased coupon codes for
 *      years and stopped doing so around version 9.9, which turned code
 *      matching case-sensitive and broke integrations that relied on the old
 *      folding. Generating lowercase-only codes sidesteps that whole class of
 *      regression: there is no uppercase variant to disagree about. It also
 *      keeps codes inside the shape sanitiseCode() in
 *      lib/campaigns/merge-fields.js accepts, because a code that fails that
 *      regex renders to an empty string and silently drops the recipient.
 */

const crypto = require('node:crypto');
const { RULES, flattenedBannedTerms } = require('./campaigns/copy-rules');

/**
 * How many rehashes before giving up. Each attempt is an independent draw and
 * unsafe codes are rare, so reaching double figures means something is wrong
 * with the rules rather than with the luck.
 */
const MAX_CODE_ATTEMPTS = 24;

/** Flattened once. The list is frozen, so this cannot go stale. */
const FLAT_BANNED_TERMS = flattenedBannedTerms().map(entry => String(entry.term).toLowerCase());

const WC_URL = process.env.WC_URL || 'https://vicipeptides.com/wp-json/wc/v3';
const WC_KEY = process.env.WC_CONSUMER_KEY;
const WC_SECRET = process.env.WC_CONSUMER_SECRET;

/** WooCommerce rejects batch requests with more than 100 objects. */
const BATCH_LIMIT = 100;

/** Pause between sequential batches so a WAF does not read us as a flood. */
const DEFAULT_BATCH_DELAY_MS = 250;

/** One initial attempt plus three retries for 429 and 5xx responses. */
const DEFAULT_MAX_ATTEMPTS = 4;

/** Base for exponential backoff between retry attempts. */
const DEFAULT_RETRY_BASE_MS = 1000;

/** Must agree with sanitiseCode() in lib/campaigns/merge-fields.js. */
const CODE_SHAPE = /^[a-z0-9-]{4,16}$/;

/** WooCommerce's error code for an existing coupon code. */
const DUPLICATE_ERROR_CODE = 'woocommerce_rest_coupon_code_already_exists';

class CouponRequestError extends Error {
  constructor(message, code = 'INVALID_COUPON_REQUEST', status = 400) {
    super(message);
    this.name = 'CouponRequestError';
    this.code = code;
    this.status = status;
  }
}

function wooAuth() {
  const creds = Buffer.from(`${WC_KEY}:${WC_SECRET}`).toString('base64');
  return { Authorization: `Basic ${creds}`, 'Content-Type': 'application/json' };
}

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Deterministic, collision-resistant, lowercase-only coupon code.
 *
 * Determinism is the point: the seed is the identity of the grant (for
 * example `${campaignId}:${customerId}`), so re-running a campaign produces
 * the SAME code for the same person instead of minting a second one. That is
 * why there is no Math.random() and no Date.now() in here; either would turn
 * a re-run into a fresh grant. If time must participate, the caller bakes it
 * into the seed.
 *
 * The hash tail is 10 base36 characters, roughly 51 bits, so accidental
 * collisions across realistic campaign sizes are negligible while the code
 * stays inside the 16-character cap sanitiseCode() enforces.
 */
function generateCode({ prefix = '', seed } = {}) {
  if (typeof seed !== 'string' || !seed) {
    throw new CouponRequestError('generateCode requires a non-empty string seed.', 'COUPON_SEED_REQUIRED');
  }
  const cleanPrefix = String(prefix || '').trim().toLowerCase();
  // Prefix caps at 5 characters so prefix + dash + 10 hash characters stays
  // within the 16-character ceiling without shortening the hash tail.
  if (cleanPrefix && !/^[a-z0-9]{1,5}$/.test(cleanPrefix)) {
    throw new CouponRequestError(
      'Coupon prefix must be 1 to 5 lowercase letters or digits.',
      'COUPON_PREFIX_INVALID'
    );
  }
  // A PREFIX CONTAINING A BANNED WORD CAN NEVER PRODUCE A SAFE CODE, so it is
  // refused here with the real reason rather than after twenty-four hashes
  // with "could not generate one". "save5" is the obvious trap: "save" is a
  // carrier-filter term, so every code built on it is unusable and the
  // exhaustion message would send somebody looking in the wrong place.
  if (cleanPrefix && !isSafeInCopy(cleanPrefix)) {
    throw new CouponRequestError(
      `Coupon prefix "${cleanPrefix}" contains something the copy rules refuse, so no code built on it could be sent.`,
      'COUPON_PREFIX_UNSAFE'
    );
  }

  // REHASHED UNTIL THE CODE IS SAFE TO PUT IN A MESSAGE, and this is not
  // hypothetical caution.
  //
  // Against 200 real customers, one code came out as "vin-6m10cc5sl3". The
  // substring "10cc" matches the dose-measurement pattern in the copy rules,
  // so the rendered message failed validation and that customer was silently
  // dropped from the campaign. Ten random base36 characters produce "10cc",
  // "5ml" and "20mg" at a low but entirely reachable rate: eight in three
  // thousand, measured. At five hundred recipients it happens.
  //
  // The attempt counter is part of the hash input, so this stays
  // deterministic. The same seed always yields the same code, including the
  // same number of attempts, so re-running a campaign gives somebody the code
  // they already have rather than a second one.
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    const input = attempt === 0 ? seed : `${seed}#${attempt}`;
    const digest = crypto.createHash('sha256').update(input).digest('hex');
    // BigInt keeps the hex-to-base36 conversion exact; Number would lose
    // precision past 53 bits and quietly shrink the keyspace.
    const tail = BigInt(`0x${digest.slice(0, 24)}`).toString(36).padStart(10, '0').slice(0, 10);
    const code = cleanPrefix ? `${cleanPrefix}-${tail}` : tail;
    if (CODE_SHAPE.test(code) && isSafeInCopy(code)) return code;
  }
  throw new CouponRequestError(
    `No code safe to put in a message could be generated for this seed in ${MAX_CODE_ATTEMPTS} attempts.`,
    'COUPON_CODE_UNSAFE', 500
  );
}

/**
 * Whether a code can appear in a customer message without failing the rules.
 *
 * Runs the real copy patterns rather than a hand-kept list, so a rule added to
 * copy-rules.js tomorrow is honoured here without anybody remembering to come
 * back and update a second copy of it.
 */
function isSafeInCopy(code) {
  for (const pattern of RULES.bannedPatterns) {
    if (new RegExp(pattern.pattern, pattern.flags || '').test(code)) return false;
  }
  const lowered = code.toLowerCase();
  for (const term of FLAT_BANNED_TERMS) {
    // Two-letter terms would reject almost every random string for nothing;
    // the real risk is a whole word appearing by chance.
    if (term.length >= 3 && lowered.includes(term)) return false;
  }
  return true;
}

/**
 * One validated coupon object ready for the batch endpoint.
 *
 * Defaults enforce that these are per-person codes: individual_use stops
 * stacking with other coupons, and both usage limits stop the code being
 * passed around after one redemption.
 */
function couponSpec({ code, percent, usageLimit = 1, expiresAt, emailRestriction, emailRestrictions } = {}) {
  const cleanCode = String(code || '').trim().toLowerCase();
  if (!CODE_SHAPE.test(cleanCode)) {
    throw new CouponRequestError(
      'Coupon code must be 4 to 16 lowercase letters, digits, or hyphens.',
      'COUPON_CODE_INVALID'
    );
  }

  const pct = Number(percent);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
    throw new CouponRequestError('percent must be a number greater than 0 and at most 100.', 'COUPON_PERCENT_INVALID');
  }

  const limit = Number(usageLimit);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new CouponRequestError('usageLimit must be a positive integer.', 'COUPON_USAGE_LIMIT_INVALID');
  }

  const spec = {
    code: cleanCode,
    discount_type: 'percent',
    // WooCommerce requires amount as a string even for percentages. A numeric
    // amount is silently coerced by some versions and rejected by others, so
    // the string form is the only shape that behaves the same everywhere.
    amount: String(pct),
    individual_use: true,
    usage_limit: limit,
    usage_limit_per_user: 1
  };

  if (expiresAt !== undefined && expiresAt !== null) {
    // WooCommerce interprets date_expires in the SITE timezone, so the value
    // must be ISO8601 with no timezone designator. A trailing Z or offset
    // would be misread or rejected depending on the store version.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(expiresAt))) {
      throw new CouponRequestError(
        'expiresAt must be ISO8601 without a timezone, like 2026-09-01T23:59:59.',
        'COUPON_EXPIRY_INVALID'
      );
    }
    spec.date_expires = String(expiresAt);
  }

  // ── ONE CODE FOR A WHOLE CAMPAIGN ──────────────────────────────────────
  //
  // `emailRestrictions` takes the LIST of everybody the campaign is going to,
  // which is what makes a single shared code safe. Minting one code per person
  // was the original design and it has two costs the owner's partner spotted:
  // a campaign of 221 leaves 221 rows in the store's coupon table, and the
  // admin screen shows no campaign-level number at all, just 221 coupons used
  // 0 or 1 times each.
  //
  // A shared code restricted to the audience is also SAFER than the per-person
  // codes it replaces, which is the opposite of the intuition. Those carry no
  // email restriction, so a code posted publicly works for whoever finds it
  // first, and the person it was meant for then cannot use it. A restricted
  // code is worthless to anyone outside the list.
  //
  // The caveat in the singular case still holds and is worth repeating: the
  // match is against the billing email TYPED at checkout, not a verified
  // account. It is a strong deterrent, not an identity proof.
  const restrictionList = emailRestrictions !== undefined && emailRestrictions !== null
    ? emailRestrictions
    : (emailRestriction !== undefined && emailRestriction !== null ? [emailRestriction] : null);

  if (restrictionList !== null) {
    const list = Array.isArray(restrictionList) ? restrictionList : [restrictionList];
    if (!list.length) {
      throw new CouponRequestError(
        'emailRestrictions must not be empty. A restricted coupon nobody can use is worse than an unrestricted one.',
        'COUPON_EMAIL_INVALID'
      );
    }
    const cleaned = [];
    const seen = new Set();
    for (const entry of list) {
      const email = String(entry ?? '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new CouponRequestError(
          `emailRestrictions must all be email addresses; "${String(entry).slice(0, 40)}" is not.`,
          'COUPON_EMAIL_INVALID'
        );
      }
      // Deduplicated: two recipients sharing a billing address would otherwise
      // consume two of the usage allowance for one person.
      if (seen.has(email)) continue;
      seen.add(email);
      cleaned.push(email);
    }
    const email = cleaned[0];
    // email_restrictions is matched against the billing email TYPED AT
    // CHECKOUT, not a verified account. Anyone who knows the code can type
    // the matching email, so this is a deterrent against casual sharing and
    // not a guarantee of who redeems it. The usage limits above are the real
    // enforcement.
    spec.email_restrictions = cleaned;
  }

  return spec;
}

function isRetryable(status) {
  return status === 429 || status >= 500;
}

/**
 * POST one chunk to /coupons/batch, retrying 429 and 5xx with exponential
 * backoff. A 4xx that is not 429 means the request itself is wrong; retrying
 * it would send the same wrong request again, so it throws immediately.
 */
async function postBatch(chunk, { fetchImpl, sleep, maxAttempts, retryBaseMs }) {
  let lastStatus = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetchImpl(`${WC_URL}/coupons/batch`, {
      method: 'POST',
      headers: wooAuth(),
      body: JSON.stringify({ create: chunk })
    });

    if (response.ok) {
      let body;
      try {
        body = await response.json();
      } catch (error) {
        throw new CouponRequestError(
          `WooCommerce returned an unparseable batch response: ${error.message}`,
          'COUPON_BATCH_UNPARSEABLE',
          502
        );
      }
      // The batch endpoint wraps results as { create: [...] }; tolerate a
      // bare array in case a proxy or plugin unwraps it.
      const results = Array.isArray(body) ? body : body?.create;
      if (!Array.isArray(results)) {
        throw new CouponRequestError(
          'WooCommerce batch response did not contain a create array.',
          'COUPON_BATCH_MALFORMED',
          502
        );
      }
      return results;
    }

    lastStatus = response.status;
    if (!isRetryable(response.status)) {
      throw new CouponRequestError(
        `WooCommerce API /coupons/batch: ${response.status}`,
        'COUPON_BATCH_REJECTED',
        response.status
      );
    }
    if (attempt < maxAttempts) {
      await sleep(retryBaseMs * 2 ** (attempt - 1));
    }
  }
  throw new CouponRequestError(
    `WooCommerce API /coupons/batch still failing after ${maxAttempts} attempts: ${lastStatus}`,
    'COUPON_BATCH_EXHAUSTED',
    lastStatus || 502
  );
}

/**
 * Create many coupons via POST /coupons/batch.
 *
 * Chunks of at most 100 (the hard server-side cap), sent sequentially with a
 * delay between chunks. Returns { created, failed }; nothing per-item is ever
 * thrown, because a partially successful campaign run needs the full picture
 * of what landed and what did not, not an exception at the first casualty.
 *
 * failed entries: { code, errorCode, reason, duplicate }.
 */
async function createCoupons(specs, opts = {}) {
  if (!Array.isArray(specs)) {
    throw new CouponRequestError('createCoupons requires an array of coupon specs.', 'COUPON_SPECS_INVALID');
  }

  const {
    fetchImpl = global.fetch,
    sleep = defaultSleep,
    delayMs = DEFAULT_BATCH_DELAY_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryBaseMs = DEFAULT_RETRY_BASE_MS
  } = opts;

  const created = [];
  const failed = [];

  for (let offset = 0; offset < specs.length; offset += BATCH_LIMIT) {
    if (offset > 0) await sleep(delayMs);
    const chunk = specs.slice(offset, offset + BATCH_LIMIT);
    const results = await postBatch(chunk, { fetchImpl, sleep, maxAttempts, retryBaseMs });

    // The response array is positional: element i answers for chunk[i]. Each
    // element must be inspected because a 200 batch can still contain
    // per-item errors.
    for (let i = 0; i < chunk.length; i += 1) {
      const result = results[i];
      const error = result?.error;
      if (error) {
        failed.push({
          code: chunk[i].code,
          errorCode: error.code || 'unknown',
          reason: error.message || 'WooCommerce reported an unspecified error.',
          // A duplicate means this code already exists, almost always from a
          // previous run of the same campaign. Recoverable and expected.
          duplicate: error.code === DUPLICATE_ERROR_CODE
        });
      } else if (result) {
        created.push(result);
      } else {
        failed.push({
          code: chunk[i].code,
          errorCode: 'missing_result',
          reason: 'WooCommerce returned no result for this item.',
          duplicate: false
        });
      }
    }
  }

  return { created, failed };
}

/** The coupon with this exact code, or null if none exists. */
async function findCouponByCode(code, opts = {}) {
  const { fetchImpl = global.fetch } = opts;
  const url = new URL(`${WC_URL}/coupons`);
  url.searchParams.set('code', String(code || '').trim().toLowerCase());
  const response = await fetchImpl(url.toString(), { headers: wooAuth() });
  if (!response.ok) throw new Error(`WooCommerce API /coupons: ${response.status}`);
  const data = await response.json();
  return Array.isArray(data) && data.length ? data[0] : null;
}

/**
 * Delete a coupon by id. With force: false WooCommerce only moves the coupon
 * to trash, and a trashed coupon does NOT block reuse of the same code
 * string, so cleanup that intends to free a code for re-issue can trash it,
 * while cleanup that must fully remove the record should pass force: true.
 */
async function deleteCoupon(id, opts = {}) {
  const { force = false, fetchImpl = global.fetch } = opts;
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId < 1) {
    throw new CouponRequestError('deleteCoupon requires a positive integer id.', 'COUPON_ID_INVALID');
  }
  const url = new URL(`${WC_URL}/coupons/${numericId}`);
  url.searchParams.set('force', force ? 'true' : 'false');
  const response = await fetchImpl(url.toString(), { method: 'DELETE', headers: wooAuth() });
  if (!response.ok) {
    throw new CouponRequestError(
      `WooCommerce API /coupons/${numericId}: ${response.status}`,
      'COUPON_DELETE_FAILED',
      response.status
    );
  }
  return response.json();
}

module.exports = {
  BATCH_LIMIT,
  CouponRequestError,
  couponSpec,
  createCoupons,
  deleteCoupon,
  findCouponByCode,
  generateCode
};
