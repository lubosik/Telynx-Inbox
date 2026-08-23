'use strict';
/**
 * lib/campaigns/checkout-consent.js — capture REAL promotional SMS consent
 * from a WooCommerce checkout tick box.
 *
 * WHY THIS EXISTS
 *   `sms_consent_events` is empty. Every promotional recipient check therefore
 *   fails closed, which is correct and also means the campaign machinery can
 *   never send anything until genuine evidence starts arriving. This module is
 *   the first honest source of that evidence: a customer who ticked an SMS
 *   marketing box, next to a disclosure, at the moment they gave us the number.
 *
 * WHAT IT WILL NOT DO
 *   It will not infer. A missing field is not consent. An empty value is not
 *   consent. "0", "no", "false", `false`, an unexpected object, a value under a
 *   near-miss meta key, or two conflicting entries for the same key are not
 *   consent. Only an explicit affirmative the merchant configured us to look
 *   for counts, because the whole point of the ledger is that someone can ask
 *   "why did you text me" and get an answer that survives the question.
 *
 * WHERE THE EVIDENCE POINTS
 *   `evidence_ref` is `woo_order:<id>`: an order that exists in WooCommerce,
 *   with the tick stored on it in `meta_data`, retrievable years later. The
 *   dedupe key `woo-order-optin:<id>` means the same order can be replayed by
 *   WooCommerce's webhook retries — or by `order.updated` firing on every
 *   status change — without ever writing a second opt-in.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH
 *   The phone number is the BILLING phone off the order and nothing else. The
 *   order path has fallbacks (customer record, local contacts, HighLevel) that
 *   are right for delivering a transactional order update and wrong here: a
 *   number recovered from another system was never sitting under the checkout
 *   disclosure the customer read. Consent belongs to the number they typed.
 *
 * IT NEVER THROWS
 *   Every entry point returns a structured result. This runs beside an order
 *   confirmation SMS; a consent bookkeeping problem must never become a
 *   customer-facing failure.
 */

const { normalisePhoneStrict } = require('../phone');
const { SOURCE, normalisePhone: strictE164, recordOptIn } = require('./consent');

/** WooCommerce stores custom checkout fields under a merchant-chosen key. */
const DEFAULT_META_KEY = '_sms_marketing_optin';

/**
 * The complete affirmative set. WooCommerce writes '1' or 'yes' for a classic
 * checkout checkbox, `true` for a Blocks/Store API checkbox, and 'on' for a raw
 * unfiltered HTML checkbox POST. Nothing else is an opt-in, and this set must
 * not grow to accommodate a guess about what some plugin might store.
 */
const AFFIRMATIVE_VALUES = new Set(['1', 'yes', 'true', 'on']);

/** Outcomes. Every one of these is a reason we did NOT record, except the last two. */
const REASON = Object.freeze({
  CLIENT_REQUIRED: 'client_required',
  NO_ORDER: 'no_order',
  NO_ORDER_ID: 'no_order_id',
  UNVERIFIED_WEBHOOK: 'unverified_webhook',
  FIELD_ABSENT: 'optin_field_absent',
  NOT_AFFIRMATIVE: 'optin_not_affirmative',
  CONFLICTING_VALUES: 'optin_values_conflict',
  INVALID_PHONE: 'invalid_billing_phone',
  WRITE_FAILED: 'write_failed',
  RECORDED: 'recorded',
  DUPLICATE: 'duplicate'
});

function optInMetaKey(env = process.env) {
  const configured = String(env?.WC_SMS_OPTIN_META_KEY || '').trim();
  return configured || DEFAULT_META_KEY;
}

/**
 * Which wording the customer actually agreed to. The compliance research names
 * "disclosure or form version" as part of a usable consent record: without it,
 * a later change to the checkout copy silently rewrites what every historical
 * row appears to mean. Unset is recorded as 'unversioned' rather than pretended.
 */
function disclosureVersion(env = process.env) {
  const configured = String(env?.WC_SMS_OPTIN_DISCLOSURE_VERSION || '').trim();
  return configured || 'unversioned';
}

/**
 * True only for an explicit affirmative. Types are checked before any string
 * conversion, because `String(['1'])` is '1' and an array is not a tick.
 */
function isAffirmativeOptIn(value) {
  if (value === true) return true;
  if (typeof value === 'number') return value === 1;
  if (typeof value !== 'string') return false;
  return AFFIRMATIVE_VALUES.has(value.trim().toLowerCase());
}

/** A short, non-identifying form of what was stored, for the evidence metadata. */
function describeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value !== 'string') return `<${Array.isArray(value) ? 'array' : typeof value}>`;
  return value.trim().slice(0, 32);
}

/**
 * Read every `meta_data` entry under the configured key.
 *
 * All of them, not the first: WooCommerce permits repeated meta keys, and a
 * conflicting pair ("yes" and "no" for the same field) means we do not know
 * what the customer chose. Not knowing is not consent.
 */
function readOptInEntries(order, metaKey) {
  const meta = Array.isArray(order?.meta_data) ? order.meta_data : [];
  const wanted = String(metaKey);
  // Exact match on the stored key. The CONFIGURED key is trimmed (stray
  // whitespace in an environment variable is a common accident); the key on the
  // order is not, because a key that is only nearly ours belongs to some other
  // field and reading consent out of it would be a guess.
  return meta
    .filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry))
    .filter(entry => typeof entry.key === 'string' && entry.key === wanted)
    .map(entry => entry.value);
}

/**
 * Decide, without writing anything. Exported so the decision can be tested and
 * inspected independently of the ledger.
 */
function detectCheckoutOptIn({ order, env = process.env } = {}) {
  const metaKey = optInMetaKey(env);
  const values = readOptInEntries(order, metaKey);

  if (values.length === 0) {
    return { metaKey, present: false, optedIn: false, reason: REASON.FIELD_ABSENT, rawValue: null };
  }

  const affirmative = values.filter(isAffirmativeOptIn);
  const rawValue = describeValue(values[values.length - 1]);

  if (affirmative.length === 0) {
    return { metaKey, present: true, optedIn: false, reason: REASON.NOT_AFFIRMATIVE, rawValue };
  }
  if (affirmative.length !== values.length) {
    return { metaKey, present: true, optedIn: false, reason: REASON.CONFLICTING_VALUES, rawValue };
  }
  return { metaKey, present: true, optedIn: true, reason: null, rawValue };
}

/** WooCommerce order ids are positive integers; anything else is not an order. */
function orderIdentifier(order) {
  const raw = order?.id;
  if (raw === null || raw === undefined || typeof raw === 'boolean') return null;
  const text = String(raw).trim();
  return /^[1-9][0-9]*$/.test(text) ? text : null;
}

/**
 * The billing phone, and only the billing phone, in strict E.164.
 *
 * This delegates to `normalisePhoneStrict` in `lib/phone.js`, which refuses any
 * input whose digits it cannot reproduce exactly. That refusal is the whole
 * point. The forgiving normalisers used by the delivery paths silently welded
 * an extension onto the subscriber number — "3055551234 ext 22" became
 * +305555123422, "0412345678" became +10412345678 — and each of those wrote a
 * CHECKOUT_OPT_IN row, the strongest basis in the ledger, against a person who
 * had never seen our checkout. A refusal costs one order's worth of consent
 * that the customer can give again. A fabrication cannot be undone.
 *
 * The consent core's own validator runs last as well: it is the shape the
 * database CHECK constraint enforces, and this module must never be the reason
 * a row that violates it is attempted.
 */
function billingConsentPhone(order) {
  const raw = order?.billing?.phone;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;

  const normalised = normalisePhoneStrict(raw);
  if (!normalised) return null;

  return strictE164(normalised);
}

/**
 * When the customer agreed. WooCommerce's `*_gmt` fields are UTC but carry no
 * timezone marker, so `new Date()` would read them as server-local and shift
 * the record by hours. Prefer the GMT field with an explicit Z; fall back to
 * the site-local field; fall back to the consent core stamping "now".
 */
function consentTimestamp(order) {
  const gmt = order?.date_created_gmt || order?.date_paid_gmt;
  if (typeof gmt === 'string' && gmt.trim()) {
    const text = gmt.trim();
    const iso = /(?:Z|z|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}Z`;
    const parsed = new Date(iso);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  const local = order?.date_created;
  if (typeof local === 'string' && local.trim()) {
    const parsed = new Date(local.trim());
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

/**
 * Logged at most once per process; the same pattern as `didLogMissingTeamId` in
 * `routes/well-known.js`. Every live order fires this path, so an unrated
 * warning would be one line per order forever.
 */
let didWarnOptInFieldAbsent = false;

/** Test hook for the "warn once about a possibly mis-keyed field" behaviour. */
function resetOptInFieldAbsentWarning() {
  didWarnOptInFieldAbsent = false;
}

/**
 * The distinct `meta_data` KEYS on an order, for the mis-configuration warning.
 *
 * Keys only, and never values. A merchant's checkout meta routinely holds
 * names, addresses and internal customer notes, and a diagnostic line is not a
 * place to spill them. The keys alone answer the only question being asked:
 * "is our configured key nearly, but not exactly, one of these?"
 */
function metaKeysOnOrder(order, limit = 40) {
  const meta = Array.isArray(order?.meta_data) ? order.meta_data : [];
  const keys = [];
  for (const entry of meta) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (typeof entry.key !== 'string' || !entry.key) continue;
    if (keys.includes(entry.key)) continue;
    keys.push(entry.key);
    if (keys.length >= limit) break;
  }
  return keys;
}

function refusal(reason, extra = {}) {
  return { recorded: false, duplicate: false, reason, phone: null, evidenceRef: null, ...extra };
}

/**
 * Detect a ticked checkout opt-in on one WooCommerce order and, if it is
 * genuinely there, record promotional consent.
 *
 * @param {object}  options
 * @param {object}  options.client            Supabase client.
 * @param {object}  options.order             Parsed WooCommerce order.
 * @param {object}  [options.env]             Environment (injectable for tests).
 * @param {boolean} [options.secretConfigured] Whether webhook HMAC verification
 *   is even possible in this deployment.
 * @param {boolean|null} [options.signatureValid] Result of that verification.
 * @param {string}  [options.occurredAt]      Override the consent timestamp.
 * @param {string}  [options.workspace]       Defaults to the consent core's.
 * @returns {Promise<{recorded: boolean, duplicate: boolean, reason: string,
 *   phone: string|null, evidenceRef: string|null, metaKey: string}>}
 *   Never rejects.
 */
async function recordCheckoutConsent({
  client,
  order,
  env = process.env,
  secretConfigured = false,
  signatureValid = null,
  occurredAt = null,
  workspace = undefined,
  recordedBy = null
} = {}) {
  let metaKey = DEFAULT_META_KEY;
  try {
    metaKey = optInMetaKey(env);

    if (!client) return refusal(REASON.CLIENT_REQUIRED, { metaKey });
    if (!order || typeof order !== 'object') return refusal(REASON.NO_ORDER, { metaKey });

    const orderId = orderIdentifier(order);
    if (!orderId) return refusal(REASON.NO_ORDER_ID, { metaKey });

    // FAIL CLOSED, ALWAYS. This endpoint is unauthenticated, so an unverified
    // body is an assertion by a stranger, and consent asserted by a stranger is
    // exactly the thing the ledger exists to make impossible.
    //
    // An earlier version of this gate read `secretConfigured && signatureValid
    // !== true`, which recorded consent when no secret was configured — on the
    // reasoning that verification "was never on offer" so real consent should
    // not be lost. That reasoning was wrong, and it was wrong in the live
    // configuration: WC_WEBHOOK_SECRET was empty, so a single unauthenticated
    // curl carrying any phone number and `_sms_marketing_optin: 1` would have
    // written a row under CHECKOUT_OPT_IN, the STRONGEST basis in the ledger.
    //
    // `metadata.signature_verified: false` did not save it. Nothing reads that
    // field: the eligibility SQL checks event_type, purpose, brand_id, a
    // non-empty source and evidence_ref, and the absence of a later opt_out.
    // The forged row made the number sendable.
    //
    // Losing genuine consent from a misconfigured deployment is recoverable —
    // the customer ticks the box on their next order. A ledger anyone on the
    // internet can write to is not evidence at all, and it is the single thing
    // that would end a 10DLC registration.
    if (signatureValid !== true) {
      return refusal(REASON.UNVERIFIED_WEBHOOK, { metaKey, secretConfigured });
    }

    const detection = detectCheckoutOptIn({ order, env });
    if (!detection.optedIn) return refusal(detection.reason, { metaKey });

    const phone = billingConsentPhone(order);
    if (!phone) return refusal(REASON.INVALID_PHONE, { metaKey });

    const evidenceRef = `woo_order:${orderId}`;
    const result = await recordOptIn({
      client,
      phone,
      source: SOURCE.CHECKOUT_OPT_IN,
      evidenceRef,
      occurredAt: occurredAt || consentTimestamp(order),
      dedupeKey: `woo-order-optin:${orderId}`,
      recordedBy,
      workspace,
      // Deliberately no name, email or address: the reference points at the
      // order, and the order holds the identity.
      metadata: {
        woo_order_id: orderId,
        woo_customer_id: order.customer_id ?? null,
        order_status: typeof order.status === 'string' ? order.status : null,
        meta_key: metaKey,
        meta_value: detection.rawValue,
        disclosure_version: disclosureVersion(env),
        capture_path: 'woocommerce_order_webhook',
        signature_verified: signatureValid === true
      }
    });

    if (!result.recorded) {
      return refusal(result.reason || REASON.WRITE_FAILED, { metaKey, evidenceRef });
    }
    return {
      recorded: true,
      duplicate: Boolean(result.duplicate),
      reason: result.duplicate ? REASON.DUPLICATE : REASON.RECORDED,
      phone,
      evidenceRef,
      metaKey
    };
  } catch (error) {
    return refusal(REASON.WRITE_FAILED, {
      metaKey,
      error: error?.code || 'unknown_error'
    });
  }
}

/**
 * Fire-and-forget form for the webhook path.
 *
 * The caller must not await this. It resolves to the same structured result and
 * cannot reject, so a slow or broken consent write can neither delay an order
 * confirmation SMS nor fail the sync that produced it. Note `.then(ok, err)`
 * rather than `.catch()`: nothing in this file may hand a rejection back to an
 * order webhook.
 *
 * Nothing here logs a phone number. A consent line in the application log is
 * not the evidence; the ledger row is.
 */
function captureCheckoutConsent(options = {}) {
  const log = options.log || console;
  return recordCheckoutConsent(options).then(
    result => {
      if (result.recorded && !result.duplicate) {
        log.log?.(`[CONSENT] Checkout SMS opt-in recorded for ${result.evidenceRef}`);
      } else if (!result.recorded && result.reason === REASON.FIELD_ABSENT) {
        // An absent field is the normal case for a customer who did not tick
        // the box, so this must not be a per-order warning. It is also the
        // exact symptom of a one-character typo in WC_SMS_OPTIN_META_KEY, and
        // the previous silence meant that typo produced a permanently empty
        // ledger with a completely clean log. Warn once, with the keys the
        // order actually carries, so the mismatch is visible at a glance.
        if (!didWarnOptInFieldAbsent) {
          didWarnOptInFieldAbsent = true;
          const keys = metaKeysOnOrder(options.order);
          log.warn?.(
            `[CONSENT] Checkout SMS opt-in field "${result.metaKey}" was not present on an order`
            + ` (logged once per process). If the checkout stores the tick under a different key,`
            + ` set WC_SMS_OPTIN_META_KEY. meta_data keys seen on this order:`
            + ` ${keys.length ? keys.join(', ') : '(none)'}`
          );
        }
      } else if (!result.recorded) {
        log.warn?.(`[CONSENT] Checkout SMS opt-in not recorded (${result.reason})`);
      }
      return result;
    },
    error => {
      log.error?.(`[CONSENT] Checkout opt-in capture faulted: ${error?.code || 'unknown_error'}`);
      return refusal(REASON.WRITE_FAILED, { metaKey: DEFAULT_META_KEY });
    }
  );
}

module.exports = {
  AFFIRMATIVE_VALUES,
  DEFAULT_META_KEY,
  REASON,
  billingConsentPhone,
  captureCheckoutConsent,
  consentTimestamp,
  detectCheckoutOptIn,
  disclosureVersion,
  isAffirmativeOptIn,
  metaKeysOnOrder,
  optInMetaKey,
  recordCheckoutConsent,
  resetOptInFieldAbsentWarning
};
