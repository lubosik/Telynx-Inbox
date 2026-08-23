'use strict';
/**
 * lib/campaigns/segment-contactability.js — "may we message this person right
 * now, and if not, why not", answered FOR DISPLAY next to a segment member.
 *
 * WHY THIS FILE EXISTS AT ALL
 *   Segment membership answers WHO MATCHES THIS PATTERN. That question is pure
 *   behaviour: purchase history, cadence, product identity, recency. It used
 *   to be gated by MAY WE CONTACT THIS PERSON, and because
 *   `sms_customer_commercial_eligibility` is empty in production, the second
 *   question answered "unknown" for every phone, failed closed 3,378 times,
 *   and every segment read zero. An empty list is indistinguishable from a
 *   broken engine.
 *
 *   Splitting the two questions is only useful if the second one is still
 *   ANSWERED, visibly. "412 people match, 0 can be messaged today, here is the
 *   reason for each" is an honest screen. "412 people match" on its own would
 *   be a worse lie than the empty list.
 *
 * WHAT THIS IS NOT
 *   It is NOT authority to send, and it cannot become one.
 *     - It writes nothing and claims nothing.
 *     - It is computed at READ time and never stored, because it goes stale
 *       within the hour: the DND freshness window is 24 hours, a support
 *       observation expires, quiet hours pass. A persisted "contactable: true"
 *       is precisely the artefact somebody later mistakes for permission.
 *     - It never enters computedSetDigest(), so it cannot make a recompute
 *       churn or move a single person in or out of a segment.
 *     - The real decision is made in SQL, under row locks, inside
 *       `claim_sms_campaign_recipients` and
 *       `begin_sms_campaign_provider_attempt`, which re-check consent,
 *       suppression, DND freshness, quiet hours and frequency at send time.
 *       Those are untouched. This file is a window, not a door.
 *
 * WHY IT REUSES eligibility.js RATHER THAN DECIDING AGAIN
 *   A second opinion about who may be messaged is a second thing to keep in
 *   step with the SQL, and it will drift. The per-recipient verdict here is
 *   evaluateRecipient() from lib/campaigns/eligibility.js, unmodified, fed the
 *   same four facts it is fed everywhere else. The support-state verdict is
 *   authoritativeSupportState() from lib/campaigns/generation-service.js,
 *   likewise unmodified. This file only batches the reads and merges the two
 *   verdicts into one sentence.
 *
 * SUPABASE RULES OBEYED HERE (all three have caused an outage in this repo)
 *   1. No `.catch()` on a query builder. It is a thenable with `then` only, so
 *      `.catch()` throws before the query is sent. try/catch the await.
 *   2. No unbounded `.in()`. Every `.in()` below runs over a slice capped at
 *      IN_CHUNK_SIZE.
 *   3. No unpaged full-table read. Everything here is keyed by a bounded
 *      phone list, and the list itself is capped.
 */

const { normalisePhone } = require('../phone');
const { IN_CHUNK_SIZE } = require('../fetch-all-rows');
const { activeSuppressionReason, evaluateRecipient, loadCampaignSettings, WORKSPACE_ID } = require('./eligibility');
const { authoritativeSupportState } = require('./generation-service');

/**
 * The most people we will evaluate in one request. Above this the screen gets
 * a count and an honest "not evaluated" rather than a request that fans out
 * into hundreds of round trips.
 */
const MAX_EVALUATED_PHONES = 5000;

/**
 * Carried on every summary so the sentence travels with the number. A count
 * of contactable people is an observation about right now; the send-time SQL
 * decides again, under row locks, at the moment of sending.
 */
const NOT_PERMISSION_TO_SEND =
  'Counted for display only. Sending is decided again at send time by the campaign claim and provider-attempt functions.';

/** Human-readable, in the order an operator would want to hear them. */
const REASON_LABELS = Object.freeze({
  eligible: 'Contactable now',
  invalid_phone: 'The number is not a valid E.164 number',
  internal_or_test_identity: 'Internal or test identity',
  opted_out: 'Opted out',
  dnd: 'Do not disturb is set in HighLevel',
  dnd_unknown: 'HighLevel do-not-disturb status is missing or stale',
  consent_not_recorded: 'No recorded promotional SMS consent',
  authoritative_suppression: 'Suppressed by an authoritative rule',
  eligibility_check_failed: 'The eligibility sources could not be read',
  campaign_settings_missing: 'Campaign settings have not been configured',
  support_state_unknown: 'No current customer experience clearance on record',
  support_state_source_unavailable: 'The customer experience clearance source is unavailable',
  customer_experience_block: 'Blocked by a customer experience hold',
  commercial_clearance_unknown: 'Commercial clearance was not observed for this run',
  not_evaluated: 'Not evaluated'
});

function describeReason(reason) {
  return REASON_LABELS[reason] || String(reason || 'not_evaluated');
}

function uniquePhones(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const phone = normalisePhone(typeof value === 'string' ? value : value?.contactPhone || value?.phone);
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    out.push(phone);
  }
  return out;
}

function chunk(values, size = IN_CHUNK_SIZE) {
  const out = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

/**
 * Run one bounded `.in()` read per chunk and concatenate.
 *
 * A read failure is not fatal and is not swallowed either: it is returned as
 * `failed`, and every phone in the batch then reports
 * `eligibility_check_failed`. Reporting "we do not know" is the honest answer
 * and it fails in the safe direction, because "we do not know" is never
 * contactable.
 */
async function readInChunks(client, table, columns, phoneColumn, phones, decorate) {
  const rows = [];
  for (const slice of chunk(phones)) {
    // bounded: slice is capped at IN_CHUNK_SIZE (200), well below URL limits.
    let query = client.from(table).select(columns).in(phoneColumn, slice);
    if (typeof decorate === 'function') query = decorate(query);
    let result;
    try {
      result = await query;
    } catch (error) {
      return { failed: true, rows: [], error };
    }
    if (result.error) return { failed: true, rows: [], error: result.error };
    rows.push(...(result.data || []));
  }
  return { failed: false, rows };
}

function groupBy(rows, key) {
  const out = new Map();
  for (const row of rows || []) {
    const phone = normalisePhone(row?.[key]);
    if (!phone) continue;
    if (!out.has(phone)) out.set(phone, []);
    out.get(phone).push(row);
  }
  return out;
}

function latestSupportRow(rows) {
  let best = null;
  for (const row of rows || []) {
    const observed = Date.parse(row?.observed_at);
    if (!Number.isFinite(observed)) continue;
    if (!best || Date.parse(best.observed_at) < observed) best = row;
  }
  return best;
}

/**
 * Merge the two independent verdicts into one.
 *
 * They are genuinely independent and both must pass:
 *   - commercial clearance: is there a current customer-experience observation
 *     saying this person is not in the middle of a complaint or a refund?
 *   - recipient eligibility: consent, STOP, DND freshness, suppression.
 *
 * Reasons accumulate rather than short-circuit, because "no consent recorded
 * AND no clearance on record" is two pieces of work for an operator, not one.
 */
function mergeVerdict({ clearance, recipient }) {
  const reasons = [];
  if (clearance && clearance.clear !== true) reasons.push(clearance.reason || 'commercial_clearance_unknown');
  if (recipient && recipient.eligible !== true) reasons.push(recipient.reason || 'not_evaluated');
  const unique = [...new Set(reasons)];
  return {
    contactable: unique.length === 0,
    reasons: unique,
    explanations: unique.map(describeReason)
  };
}

/**
 * Contactability for a bounded list of phones, read live.
 *
 * @param {object} options
 * @param {object} options.client        Supabase client
 * @param {string[]} options.phones      E.164 or raw; deduplicated internally
 * @param {Date} [options.now]
 * @param {string} [options.workspaceID]
 * @returns {Promise<{
 *   evaluated: boolean, evaluatedAt: string, phoneCount: number,
 *   byPhone: Map<string, {contactable: boolean, reasons: string[], explanations: string[]}>,
 *   notEvaluatedReason: string|null
 * }>}
 */
async function readSegmentContactability({
  client,
  phones,
  now = new Date(),
  workspaceID = WORKSPACE_ID
} = {}) {
  const at = now instanceof Date ? now : new Date(now);
  const list = uniquePhones(phones);
  const empty = new Map();
  if (!list.length) {
    return { evaluated: true, evaluatedAt: at.toISOString(), phoneCount: 0, byPhone: empty, notEvaluatedReason: null };
  }
  if (list.length > MAX_EVALUATED_PHONES) {
    return {
      evaluated: false,
      evaluatedAt: at.toISOString(),
      phoneCount: list.length,
      byPhone: empty,
      notEvaluatedReason: 'segment_too_large_to_evaluate'
    };
  }

  let settings = null;
  try {
    settings = await loadCampaignSettings(client, workspaceID);
  } catch {
    settings = null;
  }

  const [contactResult, sentinelResult, consentResult, suppressionResult, supportResult] = await Promise.all([
    readInChunks(client, 'sms_contacts',
      'phone, opted_out, ghl_dnd, ghl_sms_dnd_status, ghl_dnd_synced_at', 'phone', list),
    readInChunks(client, 'sms_sent_log', 'phone', 'phone', list,
      query => query.eq('flow_type', 'opted-out')),
    readInChunks(client, 'sms_consent_events',
      'id, event_type, source, evidence_ref, purpose, brand_id, occurred_at, contact_phone',
      'contact_phone', list,
      query => query.eq('workspace_id', workspaceID).eq('brand_id', workspaceID).eq('purpose', 'promotional_sms')),
    readInChunks(client, 'sms_campaign_suppressions',
      'contact_phone, reason_code, active, effective_at, expires_at', 'contact_phone', list,
      query => query.eq('workspace_id', workspaceID).eq('active', true)),
    // Optional by design: this is the table that is empty in production, and a
    // missing or unreadable one must degrade to "we do not know", never to a
    // thrown request that hides the whole segment again.
    readInChunks(client, 'sms_customer_commercial_eligibility',
      'contact_phone, status, observed_at, expires_at', 'contact_phone', list,
      query => query.eq('workspace_id', workspaceID))
  ]);

  const recipientSourcesFailed = contactResult.failed || sentinelResult.failed ||
    consentResult.failed || suppressionResult.failed;

  const contacts = groupBy(contactResult.rows, 'phone');
  const sentinels = groupBy(sentinelResult.rows, 'phone');
  const consents = groupBy(consentResult.rows, 'contact_phone');
  const suppressions = groupBy(suppressionResult.rows, 'contact_phone');
  const support = groupBy(supportResult.rows, 'contact_phone');

  const byPhone = new Map();
  for (const phone of list) {
    const clearance = supportResult.failed
      ? { clear: false, reason: 'support_state_source_unavailable' }
      : (() => {
        const state = authoritativeSupportState(latestSupportRow(support.get(phone)), at);
        if (state === 'clear') return { clear: true, reason: null };
        return { clear: false, reason: state === 'unknown' ? 'support_state_unknown' : 'customer_experience_block' };
      })();

    const recipient = recipientSourcesFailed
      ? { eligible: false, reason: 'eligibility_check_failed' }
      : !settings
        ? { eligible: false, reason: 'campaign_settings_missing' }
        : evaluateRecipient({
          phone,
          contactOptedOut: (contacts.get(phone) || [])[0]?.opted_out === true,
          contactDnd: (contacts.get(phone) || [])[0]?.ghl_dnd,
          smsDndStatus: (contacts.get(phone) || [])[0]?.ghl_sms_dnd_status,
          dndSyncedAt: (contacts.get(phone) || [])[0]?.ghl_dnd_synced_at,
          dndMaxAgeHours: settings.dnd_status_max_age_hours,
          optOutSentinel: Boolean((sentinels.get(phone) || []).length),
          now: at,
          consentEvents: consents.get(phone) || [],
          consentEvidenceRequired: settings.consent_evidence_required !== false,
          authoritativeSuppressionReason: activeSuppressionReason(suppressions.get(phone) || [], at)
        });

    byPhone.set(phone, mergeVerdict({ clearance, recipient }));
  }

  return {
    evaluated: true,
    evaluatedAt: at.toISOString(),
    phoneCount: list.length,
    byPhone,
    notEvaluatedReason: null
  };
}

/**
 * "412 people match, 0 can be messaged today, and here is why."
 *
 * The shape a client renders directly. `contactable` is deliberately allowed
 * to be zero and reported as zero: that is the honest answer while consent
 * evidence and support clearance are both absent, and it is far more useful
 * than an empty list that looks like a bug.
 */
function summariseContactability({ phones = [], byPhone = new Map(), evaluated = true, notEvaluatedReason = null, evaluatedAt = null } = {}) {
  const list = uniquePhones(phones);
  if (!evaluated) {
    return {
      evaluated: false,
      evaluatedAt,
      matched: list.length,
      contactable: null,
      notContactable: null,
      reasons: [],
      notEvaluatedReason: notEvaluatedReason || 'not_evaluated',
      note: NOT_PERMISSION_TO_SEND
    };
  }
  const counts = new Map();
  let contactable = 0;
  for (const phone of list) {
    const verdict = byPhone.get(phone);
    if (verdict?.contactable === true) { contactable += 1; continue; }
    const reasons = verdict?.reasons?.length ? verdict.reasons : ['not_evaluated'];
    for (const reason of reasons) counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return {
    evaluated: true,
    evaluatedAt,
    matched: list.length,
    contactable,
    notContactable: list.length - contactable,
    reasons: [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([reason, people]) => ({ reason, people, explanation: describeReason(reason) })),
    notEvaluatedReason: null,
    note: NOT_PERMISSION_TO_SEND
  };
}

/**
 * Fold the in-run commercial clearance already carried on computed members
 * into a count, without touching the database.
 *
 * Used by recompute, where buildSegmentationInput() has just observed the
 * clearance for every candidate and a second read would only be a chance to
 * disagree with itself.
 */
function summariseCommercialClearance(members = []) {
  const counts = new Map();
  let clear = 0;
  let unobserved = 0;
  for (const member of members) {
    const clearance = member?.commercialClearance;
    if (!clearance) { unobserved += 1; continue; }
    if (clearance.clear === true) { clear += 1; continue; }
    const reason = clearance.reason || 'commercial_clearance_unknown';
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return {
    members: members.length,
    clear,
    notClear: members.length - clear - unobserved,
    unobserved,
    reasons: [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([reason, people]) => ({ reason, people, explanation: describeReason(reason) }))
  };
}

module.exports = {
  MAX_EVALUATED_PHONES,
  NOT_PERMISSION_TO_SEND,
  REASON_LABELS,
  describeReason,
  mergeVerdict,
  readSegmentContactability,
  summariseCommercialClearance,
  summariseContactability
};
