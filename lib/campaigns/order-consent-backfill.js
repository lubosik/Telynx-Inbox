'use strict';
/**
 * lib/campaigns/order-consent-backfill.js — selection logic for the one-off
 * "treat paid customers as opted in" promotional SMS consent backfill.
 *
 * WHAT THIS IS, STATED PLAINLY
 *   Vici has ~926 SMS contacts and ~1281 paid orders, and ZERO recorded
 *   promotional SMS consent. The business owner has decided that a completed
 *   purchase, combined with the checkout data notice and the privacy policy,
 *   is a sufficient basis to send promotional SMS.
 *
 *   That is a policy-derived determination. It is NOT an explicit SMS opt-in.
 *   Nobody ticked a box that said "text me". The privacy policy clause the
 *   decision rests on names marketing and promotional EMAIL and does not
 *   mention SMS or text messages at all.
 *
 *   The owner has been told this. The purpose of this module is not to argue
 *   about the decision; it is to carry it out HONESTLY, so that every row it
 *   writes says exactly what the basis was and a reader a year from now cannot
 *   mistake it for something stronger. That is why every candidate carries the
 *   verbatim notice text, the clause relied on, the specific order, and an
 *   explicit `explicit_sms_opt_in: false` and a `limitations` list.
 *
 * WHY THE SELECTION IS A PURE FUNCTION
 *   `planOrderConsentBackfill()` takes rows in and returns a plan out. It
 *   touches no database, no clock it was not given, and no environment. That
 *   makes the part that decides who gets a consent record fully testable
 *   offline, which matters more here than in most code: the cost of a wrong
 *   decision is a promotional text to somebody who withdrew.
 *
 * NEVER RESURRECT A WITHDRAWAL
 *   There are five independent places a withdrawal can live in this system and
 *   all five are checked:
 *     - a later `opt_out` in `sms_consent_events` (the ledger),
 *     - `sms_contacts.opted_out`,
 *     - the `sms_sent_log` opt-out sentinel that `flows/utils.js:isOptedOut()`
 *       actually reads before every send,
 *     - HighLevel SMS do-not-disturb on the contact (`ghl_dnd = true`, or
 *       `ghl_sms_dnd_status` in 'active'/'permanent'), which
 *       `lib/campaigns/eligibility.js` already treats as authoritative,
 *     - an active row in `sms_campaign_suppressions`.
 *   Any one of them skips the phone. Withdrawal reasons are reported before
 *   "already opted in" so the summary names the strongest fact about a person,
 *   not merely the first one that happened to match.
 *
 *   DND deserves a word, because the send path would have blocked it anyway.
 *   That is precisely why it belongs here: this script does not send, it writes
 *   an assertion that somebody consented. Recording positive promotional
 *   consent for a person the CRM has on a do-not-disturb list is a false
 *   statement in a compliance ledger, whether or not a downstream gate happens
 *   to save us from acting on it.
 */

const { normalisePhoneStrict } = require('../phone');
const { normalisePhone: strictE164, SOURCE } = require('./consent');
const { analyticsExclusions, isExcludedIdentity } = require('../analytics/exclusions');
const { activeSuppressionReason } = require('./eligibility');

const WORKSPACE_ID = 'vici';

/** Bumping this changes the dedupe key, so a re-run would write again. Don't. */
const BACKFILL_VERSION = 1;
const DEDUPE_PREFIX = `order_privacy_policy_backfill:v${BACKFILL_VERSION}`;
const PROCESS_REF = 'scripts/backfill-order-sms-consent.js';

/**
 * The evidence reference is namespaced by BASIS, not merely by order.
 *
 * `lib/campaigns/checkout-consent.js` writes the bare `woo_order:<id>` for the
 * checkout tick box — the strongest basis in the system. Writing the identical
 * string here, for the weakest, let two rows for the same person and the same
 * order carry the same reference and, when their `occurred_at` also matched,
 * left the "which basis was this" question to insertion order. It also broke
 * the verification query in docs/campaigns/CONSENT-CAPTURE.md section 6, which
 * counts rows by `evidence_ref = 'woo_order:<id>'` to prove the unticked case
 * records nothing.
 *
 * Namespacing costs nothing — the order is still named exactly — and makes the
 * two bases impossible to confuse in either direction.
 */
const EVIDENCE_NAMESPACE = 'order_privacy_policy';

/**
 * The same definition of "paid" that `lib/campaigns/generation-service.js` and
 * `scripts/dry-run-campaign-cadence.js` use. One definition, three call sites.
 */
const PAID_STATUSES = new Set(['processing', 'completed', 'shipped', 'delivered']);

/** Quoted exactly as published. Paraphrasing it here would defeat the point. */
const CHECKOUT_NOTICE_VERBATIM =
  'Your personal data will be used to process your order, support your ' +
  'experience throughout this website, and for other purposes described in ' +
  'our privacy policy.';

const PRIVACY_POLICY_CLAUSE_VERBATIM =
  'marketing and promotional emails, as well as information regarding your ' +
  'order updates';

const BASIS_SUMMARY =
  'Promotional SMS consent was DERIVED from a completed WooCommerce purchase ' +
  'plus the published checkout notice and privacy policy, as a documented ' +
  'business decision by the Vici owner. The customer did not give an explicit ' +
  'SMS opt-in.';

const BASIS_LIMITATIONS = Object.freeze([
  'This is not an explicit SMS opt-in. No recipient ticked an SMS consent box, ' +
    'confirmed a link, or otherwise named SMS as a channel they wanted.',
  'The privacy policy clause relied on names marketing and promotional EMAIL. ' +
    'It does not mention SMS or text messages.',
  'The checkout notice relied on says "other purposes described in our privacy ' +
    'policy". It names no channel at all.',
  'Treat this basis as weaker than woocommerce_checkout_sms_optin or ' +
    'email_invite_confirmed_link. Do not report it as equivalent to either.'
]);

const REVERSAL_NOTE =
  'To reverse: record an opt_out for this phone via lib/campaigns/consent.js ' +
  'recordOptOut(). See docs/campaigns/CONSENT-BACKFILL.md for the sweep.';

const SKIP_REASONS = Object.freeze({
  INVALID_PHONE: 'invalid_phone',
  INTERNAL_OR_TEST_IDENTITY: 'internal_or_test_identity',
  LEDGER_OPT_OUT: 'ledger_opt_out',
  CONTACT_OPTED_OUT: 'contact_opted_out',
  OPT_OUT_SENTINEL: 'opt_out_sentinel',
  GHL_SMS_DND: 'ghl_sms_dnd',
  AUTHORITATIVE_SUPPRESSION: 'authoritative_suppression',
  ALREADY_OPTED_IN: 'already_opted_in'
});

/**
 * Resolve a stored phone to the strict E.164 the consent ledger's CHECK
 * constraint demands.
 *
 * The strict test is tried FIRST and unchanged, so an already-canonical number
 * is never rewritten. A legacy, loosely-stored value falls through to
 * `normalisePhoneStrict()` in `lib/phone.js`, and if that refuses, the row is
 * skipped rather than guessed at.
 *
 * The fallback used to be `lib/phone.js`'s LOOSE `normalisePhone()`, which
 * fabricates: it strips every non-digit, so "3055551234 ext 22" became
 * +305555123422 — a number that does not exist, and which some real person may
 * one day be assigned. On a delivery path that is a failed send. On a consent
 * record it is manufactured evidence that somebody who never saw our checkout
 * agreed to be texted. `normalisePhoneStrict()` refuses anything whose digits
 * are not provably the same number, so the worst case is now a skipped row with
 * an `invalid_phone` reason the operator can see.
 */
function resolvePhone(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const exact = strictE164(text);
  if (exact) return exact;
  // The ledger's own CHECK-constraint shape stays the last word, so this file
  // can never write a phone the database would reject.
  return strictE164(normalisePhoneStrict(text) || '');
}

/** Stable per phone, deliberately independent of which order was chosen. */
function dedupeKeyFor(phone) {
  const normalised = resolvePhone(phone);
  return normalised ? `${DEDUPE_PREFIX}:${normalised}` : null;
}

function orderIdentity(row) {
  const woo = row?.woo_order_id;
  if (woo !== null && woo !== undefined && String(woo).trim()) {
    return { id: String(woo).trim(), kind: 'woo_order' };
  }
  const local = row?.id;
  if (local !== null && local !== undefined && String(local).trim()) {
    return { id: String(local).trim(), kind: 'sms_orders_row' };
  }
  return null;
}

/**
 * Earliest wins, and ties break on the order identity so the same input always
 * produces the same evidence reference. A backfill whose evidence flips between
 * runs is not evidence.
 */
function earlierOrder(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.createdAtTime !== b.createdAtTime) return a.createdAtTime < b.createdAtTime ? a : b;
  return String(a.orderID) <= String(b.orderID) ? a : b;
}

function groupByPhone(rows, phoneField) {
  const grouped = new Map();
  for (const row of rows || []) {
    const phone = resolvePhone(row?.[phoneField]);
    if (!phone) continue;
    if (!grouped.has(phone)) grouped.set(phone, []);
    grouped.get(phone).push(row);
  }
  return grouped;
}

const BLOCKING_DND_STATUSES = new Set(['active', 'permanent']);

/**
 * The same rule `lib/campaigns/eligibility.js` applies at send time: the global
 * flag OR an SMS-specific status of active/permanent is a block. A missing or
 * stale status is deliberately NOT treated as a withdrawal here — "we have not
 * synced this contact recently" is not evidence that they said no, and the send
 * path has its own `dnd_unknown` freshness gate for that.
 */
function contactHasSmsDnd(row) {
  if (row?.ghl_dnd === true) return true;
  return BLOCKING_DND_STATUSES.has(String(row?.ghl_sms_dnd_status || '').toLowerCase());
}

function inWorkspace(row, workspaceID) {
  const value = row?.workspace_id;
  return value === null || value === undefined || String(value) === String(workspaceID);
}

/**
 * The newest ledger event for a phone. Deliberately a local copy of the
 * ordering rule rather than a call into `latestConsent()`, because this needs
 * the WHOLE event including `event_type` for a skip reason, and because an
 * opt_in that fails validation (no evidence, wrong brand) must not count as an
 * existing opt-in here — it would leave the person with no usable record and
 * no way for this script to ever give them one.
 */
function latestLedgerEvent(events) {
  const usable = (events || []).filter(event =>
    ['opt_in', 'opt_out'].includes(event?.event_type) &&
    Number.isFinite(Date.parse(event?.occurred_at)) &&
    (event.event_type === 'opt_out' || (
      (event.purpose === undefined || event.purpose === 'promotional_sms') &&
      typeof event.source === 'string' && event.source.trim() &&
      typeof event.evidence_ref === 'string' && event.evidence_ref.trim()
    ))
  );
  return usable.sort((a, b) => {
    const time = Date.parse(b.occurred_at) - Date.parse(a.occurred_at);
    if (time !== 0) return time;
    return Number(b.id || 0) - Number(a.id || 0);
  })[0] || null;
}

/**
 * Suppression block. `activeSuppressionReason()` is the authority the send path
 * uses, so it is used here too. The extra clause covers a row that claims to be
 * active but whose window cannot be parsed: unreadable is treated as blocking,
 * because the alternative is texting somebody on the strength of a row nobody
 * can read.
 */
function suppressionBlock(rows, now) {
  const reason = activeSuppressionReason(rows, now);
  if (reason) return reason;
  const unreadable = (rows || []).some(row =>
    row?.active === true && !Number.isFinite(Date.parse(row?.effective_at)));
  return unreadable ? SKIP_REASONS.AUTHORITATIVE_SUPPRESSION : null;
}

/**
 * The consent record written for one customer.
 *
 * Everything a future reader needs is inside the row itself: what was said at
 * checkout, which policy clause was leaned on, which channel that clause
 * actually named, which order it came from, who decided, and what the record
 * does NOT mean. No cross-referencing another document, no asking anyone.
 */
function buildConsentMetadata({ order, qualifyingOrderCount, determinedAt, runID = null }) {
  return {
    basis: 'policy_derived_determination',
    explicit_sms_opt_in: false,
    basis_summary: BASIS_SUMMARY,
    relied_upon: {
      checkout_notice_verbatim: CHECKOUT_NOTICE_VERBATIM,
      privacy_policy_clause_verbatim: PRIVACY_POLICY_CLAUSE_VERBATIM,
      privacy_policy_channel_named: 'email',
      channel_recorded_here: 'sms'
    },
    limitations: [...BASIS_LIMITATIONS],
    qualifying_order: {
      reference: order.evidenceRef,
      woo_order_id: order.wooOrderID,
      sms_orders_row_id: order.rowID,
      status: order.status,
      created_at: order.createdAt
    },
    qualifying_paid_orders: qualifyingOrderCount,
    determination: {
      made_by: 'vici_business_owner',
      recorded_at: determinedAt,
      recorded_by_process: PROCESS_REF,
      backfill_version: BACKFILL_VERSION,
      run_id: runID
    },
    reversal: REVERSAL_NOTE
  };
}

/**
 * Decide who gets a backfilled consent record. Pure: rows in, plan out.
 *
 * @param {object}   input
 * @param {Array}    input.orders            `sms_orders` rows
 * @param {Array}    input.consentEvents     `sms_consent_events` rows
 * @param {Array}    input.contacts          `sms_contacts` rows
 *                                           (phone, opted_out, ghl_dnd,
 *                                           ghl_sms_dnd_status)
 * @param {Array}    input.suppressions      `sms_campaign_suppressions` rows
 * @param {Array}    input.optOutSentinels   `sms_sent_log` rows, flow_type 'opted-out'
 * @param {object}   [input.exclusions]      analytics staff/test exclusions
 * @param {Date}     [input.now]
 * @param {string}   [input.runID]
 * @returns {{candidates: Array, skipped: Array, counts: object}}
 */
function planOrderConsentBackfill({
  orders = [],
  consentEvents = [],
  contacts = [],
  suppressions = [],
  optOutSentinels = [],
  exclusions = analyticsExclusions(),
  workspaceID = WORKSPACE_ID,
  now = new Date(),
  runID = null
} = {}) {
  const determinedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();

  // ── 1. Paid orders, deduplicated by order identity ─────────────────────────
  const seenOrders = new Set();
  const byPhone = new Map();
  const invalidPhones = new Map();
  let paidOrdersConsidered = 0;
  let unusableOrders = 0;

  for (const row of orders) {
    const identity = orderIdentity(row);
    if (!identity) {
      unusableOrders += 1;
      continue;
    }

    // Keyed on KIND AND ID, never the bare id.
    //
    // `orderIdentity()` returns a WooCommerce order id when there is one and
    // falls back to the local `sms_orders.id` when there is not, so the two
    // kinds draw from two unrelated number spaces. Keying the set on the id
    // alone made `woo_order:1001` and `sms_orders_row:1001` collide: two paid
    // orders from two different customers collapsed into one candidate, and
    // the second person vanished from a ~900-row compliance write with no
    // entry in `skippedByReason` for the operator to notice. A silent
    // disappearance is the one outcome this plan must never produce.
    const identityKey = `${identity.kind}:${identity.id}`;
    if (seenOrders.has(identityKey)) continue;
    seenOrders.add(identityKey);

    if (!PAID_STATUSES.has(String(row.status || '').toLowerCase())) continue;
    const createdAtTime = Date.parse(row.created_at);
    if (!Number.isFinite(createdAtTime)) {
      unusableOrders += 1;
      continue;
    }

    const phone = resolvePhone(row.contact_phone);
    if (!phone) {
      // Grouped by the raw stored value so the count is per distinct customer,
      // not per order. The raw value is carried for the operator to inspect;
      // the CLI masks it before printing.
      const raw = String(row.contact_phone ?? '').trim();
      if (!invalidPhones.has(raw)) invalidPhones.set(raw, 0);
      invalidPhones.set(raw, invalidPhones.get(raw) + 1);
      continue;
    }

    paidOrdersConsidered += 1;
    const candidateOrder = {
      orderID: identity.id,
      wooOrderID: row.woo_order_id ?? null,
      rowID: row.id ?? null,
      status: String(row.status || '').toLowerCase(),
      createdAt: new Date(createdAtTime).toISOString(),
      createdAtTime,
      evidenceRef: `${EVIDENCE_NAMESPACE}:${identity.kind}:${identity.id}`
    };

    if (!byPhone.has(phone)) byPhone.set(phone, { earliest: null, count: 0 });
    const bucket = byPhone.get(phone);
    bucket.earliest = earlierOrder(bucket.earliest, candidateOrder);
    bucket.count += 1;
  }

  // ── 2. Withdrawal and suppression indexes ──────────────────────────────────
  const ledgerByPhone = groupByPhone(
    consentEvents.filter(event => inWorkspace(event, workspaceID)), 'contact_phone');
  const suppressionsByPhone = groupByPhone(
    suppressions.filter(row => inWorkspace(row, workspaceID)), 'contact_phone');

  const contactOptedOut = new Set();
  const contactSmsDnd = new Set();
  for (const contact of contacts || []) {
    const phone = resolvePhone(contact?.phone);
    if (!phone) continue;
    if (contact.opted_out === true) contactOptedOut.add(phone);
    if (contactHasSmsDnd(contact)) contactSmsDnd.add(phone);
  }

  const sentinelOptedOut = new Set();
  for (const row of optOutSentinels || []) {
    if (row?.flow_type !== undefined && row.flow_type !== 'opted-out') continue;
    const phone = resolvePhone(row?.phone);
    if (phone) sentinelOptedOut.add(phone);
  }

  // ── 3. Decide, one phone at a time ─────────────────────────────────────────
  const candidates = [];
  const skipped = [];

  for (const [raw, orderCount] of invalidPhones) {
    skipped.push({ phone: null, rawPhone: raw, reason: SKIP_REASONS.INVALID_PHONE, orders: orderCount });
  }

  for (const phone of [...byPhone.keys()].sort()) {
    const { earliest, count } = byPhone.get(phone);
    const skip = reason => skipped.push({ phone, reason, orders: count });

    if (isExcludedIdentity({ phone }, exclusions)) {
      skip(SKIP_REASONS.INTERNAL_OR_TEST_IDENTITY);
      continue;
    }

    // Withdrawals are checked before anything else about this person, and
    // before "already opted in", so the reported reason is always the
    // strongest fact rather than the first match.
    const latest = latestLedgerEvent(ledgerByPhone.get(phone));
    if (latest?.event_type === 'opt_out') { skip(SKIP_REASONS.LEDGER_OPT_OUT); continue; }
    if (contactOptedOut.has(phone)) { skip(SKIP_REASONS.CONTACT_OPTED_OUT); continue; }
    if (sentinelOptedOut.has(phone)) { skip(SKIP_REASONS.OPT_OUT_SENTINEL); continue; }
    // Reported after the three explicit withdrawals and before suppression: a
    // customer who texted STOP said no to us directly, which is a stronger fact
    // about them than a flag their CRM record carries.
    if (contactSmsDnd.has(phone)) { skip(SKIP_REASONS.GHL_SMS_DND); continue; }

    const suppression = suppressionBlock(suppressionsByPhone.get(phone), now);
    if (suppression) { skip(suppression); continue; }

    if (latest?.event_type === 'opt_in') { skip(SKIP_REASONS.ALREADY_OPTED_IN); continue; }

    candidates.push({
      phone,
      source: SOURCE.ORDER_PRIVACY_POLICY,
      evidenceRef: earliest.evidenceRef,
      occurredAt: earliest.createdAt,
      dedupeKey: dedupeKeyFor(phone),
      qualifyingOrders: count,
      metadata: buildConsentMetadata({
        order: earliest,
        qualifyingOrderCount: count,
        determinedAt,
        runID
      })
    });
  }

  const skippedByReason = {};
  for (const entry of skipped) {
    skippedByReason[entry.reason] = (skippedByReason[entry.reason] || 0) + 1;
  }

  return {
    runID,
    determinedAt,
    candidates,
    skipped,
    counts: {
      ordersRead: orders.length,
      distinctOrders: seenOrders.size,
      unusableOrders,
      paidOrdersConsidered,
      distinctPhones: byPhone.size,
      eligible: candidates.length,
      skipped: skipped.length,
      skippedByReason
    }
  };
}

/**
 * Write the plan. Refuses to touch the client unless BOTH gates are explicitly
 * true, and that refusal is the first statement in the function — not a branch
 * further down that a future edit could slip past.
 *
 * Returns the same shape in both modes so a dry run and a commit are directly
 * comparable.
 */
async function applyConsentBackfill({
  client,
  plan,
  commit = false,
  basisAcknowledged = false,
  recordOptIn,
  recordedBy = null,
  workspace = WORKSPACE_ID,
  shouldStop = null
} = {}) {
  const candidates = plan?.candidates || [];
  const summary = {
    mode: 'dry_run',
    attempted: 0,
    written: 0,
    duplicates: 0,
    rejected: 0,
    failed: 0,
    stoppedEarly: false,
    failures: []
  };

  // The whole safety property of this script lives on this line.
  if (commit !== true || basisAcknowledged !== true) return summary;

  if (!client) throw new Error('applyConsentBackfill requires a Supabase client to commit.');
  if (typeof recordOptIn !== 'function') {
    throw new Error('applyConsentBackfill requires recordOptIn from lib/campaigns/consent.js.');
  }
  summary.mode = 'commit';

  for (const candidate of candidates) {
    // Checked before the write, not after, so Ctrl-C stops the run rather than
    // merely narrating it.
    if (typeof shouldStop === 'function' && shouldStop()) {
      summary.stoppedEarly = true;
      break;
    }
    summary.attempted += 1;
    let outcome;
    try {
      outcome = await recordOptIn({
        client,
        phone: candidate.phone,
        source: candidate.source,
        evidenceRef: candidate.evidenceRef,
        occurredAt: candidate.occurredAt,
        metadata: candidate.metadata,
        dedupeKey: candidate.dedupeKey,
        recordedBy,
        workspace
      });
    } catch (error) {
      // The CODE only, never `error.message`.
      //
      // A PostgREST error message quotes the offending row — a CHECK violation
      // will happily echo the phone number back — and the CLI prints these
      // straight to a terminal after carefully masking every phone it shows.
      // Putting the raw provider text in `failures` unmasked exactly what the
      // masking was for.
      summary.failed += 1;
      summary.failures.push({ phone: candidate.phone, code: error?.code || 'write_failed' });
      continue;
    }

    if (outcome?.recorded && outcome.duplicate) summary.duplicates += 1;
    else if (outcome?.recorded) summary.written += 1;
    else {
      // `reason` is one of the fixed refusal codes in lib/campaigns/consent.js
      // ('invalid_phone', 'source_required', 'evidence_required'), not provider
      // text, so it is safe to surface as-is under the same key.
      summary.rejected += 1;
      summary.failures.push({ phone: candidate.phone, code: outcome?.reason || 'rejected' });
    }
  }

  return summary;
}

module.exports = {
  BACKFILL_VERSION,
  BASIS_LIMITATIONS,
  CHECKOUT_NOTICE_VERBATIM,
  DEDUPE_PREFIX,
  EVIDENCE_NAMESPACE,
  PAID_STATUSES,
  PRIVACY_POLICY_CLAUSE_VERBATIM,
  SKIP_REASONS,
  WORKSPACE_ID,
  applyConsentBackfill,
  buildConsentMetadata,
  dedupeKeyFor,
  latestLedgerEvent,
  planOrderConsentBackfill,
  resolvePhone
};
