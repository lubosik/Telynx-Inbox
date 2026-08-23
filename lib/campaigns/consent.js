'use strict';
/**
 * lib/campaigns/consent.js — the promotional SMS consent ledger.
 *
 * WHAT THIS TABLE IS
 *   `sms_consent_events` is append-only evidence, not a flag. Every row says
 *   who, what they agreed to, WHERE that agreement came from, and when. The
 *   schema enforces the important half: an opt_in with no `evidence_ref` is
 *   rejected by a CHECK constraint, and `purpose` can only ever be
 *   'promotional_sms'. There is no transactional purpose here, because order
 *   updates never needed a ledger — the order is the basis.
 *
 * WHY EVIDENCE MATTERS MORE THAN THE ANSWER
 *   A consent record whose basis is not written down is worthless in the only
 *   situation where it matters: someone asks why you texted them. So every
 *   writer in this file must name a `source` and an `evidenceRef`, and the two
 *   are meant to be specific enough that a person can go and look. "checkout"
 *   is not a source; "woocommerce_checkout_sms_optin" with evidence
 *   "woo_order:12345" is.
 *
 * STRENGTH IS NOT UNIFORM
 *   These bases are not equal, and the ledger does not pretend otherwise — it
 *   records which one applied so the difference stays visible later:
 *
 *     CHECKOUT_OPT_IN     a ticked SMS box at checkout. Strongest.
 *     CONFIRMED_INVITE    they clicked a signed link in an email we were
 *                         already permitted to send. Strong, and documented.
 *     ORDER_PRIVACY_POLICY a purchase, relying on the privacy policy text.
 *                         Recorded honestly as what it is so that nobody later
 *                         mistakes it for an explicit SMS opt-in.
 *
 * OPT-OUT ALWAYS WINS
 *   Every eligibility check in the database looks for a later opt_out and stops
 *   there. Recording one is the single most important write in this file, so
 *   `recordOptOut` deliberately has fewer requirements than `recordOptIn`: no
 *   evidence is demanded, because refusing to record a STOP for want of
 *   paperwork would be indefensible.
 */

const DEFAULT_WORKSPACE = 'vici';
const PURPOSE = 'promotional_sms';

/**
 * Named bases. A caller passing a free-text source is not prevented, but
 * everything in this codebase should use one of these so the ledger can be
 * grouped and audited by how consent was actually obtained.
 */
const SOURCE = {
  CHECKOUT_OPT_IN: 'woocommerce_checkout_sms_optin',
  CONFIRMED_INVITE: 'email_invite_confirmed_link',
  // A decline needs its own source. Recording a withdrawal under a name that
  // asserts a confirmation makes "how did these people opt out?" unanswerable,
  // which is precisely the question this ledger exists to answer.
  INVITE_DECLINED: 'email_invite_declined_link',
  ORDER_PRIVACY_POLICY: 'woocommerce_order_privacy_policy',
  INBOUND_STOP: 'inbound_sms_stop',
  INBOUND_START: 'inbound_sms_start',
  MANUAL: 'recorded_by_team_member'
};

function normalisePhone(value) {
  const text = String(value || '').trim();
  return /^\+[1-9][0-9]{7,14}$/.test(text) ? text : null;
}

function isoOrNow(value) {
  if (!value) return new Date().toISOString();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

/** PostgREST's unique-violation code. A duplicate dedupe key is success. */
function isDuplicate(error) {
  return error?.code === '23505'
    || String(error?.message || '').includes('sms_consent_events_dedupe_idx');
}

async function writeEvent(client, row, workspace) {
  const { error } = await client.from('sms_consent_events').insert(row);
  if (!error) return { recorded: true, duplicate: false };
  if (isDuplicate(error)) return { recorded: true, duplicate: true };
  throw Object.assign(new Error(error.message), {
    code: 'CONSENT_WRITE_FAILED', workspace, phone: row.contact_phone
  });
}

/**
 * Record positive promotional SMS consent.
 *
 * `source` and `evidenceRef` are both required here rather than defaulted,
 * because a default would let a caller create an unattributable record by
 * omission — exactly the failure this ledger exists to prevent.
 */
async function recordOptIn({
  client,
  phone,
  source,
  evidenceRef,
  occurredAt = null,
  metadata = {},
  dedupeKey = null,
  recordedBy = null,
  workspace = DEFAULT_WORKSPACE
}) {
  const contactPhone = normalisePhone(phone);
  if (!contactPhone) return { recorded: false, reason: 'invalid_phone' };
  if (!String(source || '').trim()) return { recorded: false, reason: 'source_required' };
  if (!String(evidenceRef || '').trim()) return { recorded: false, reason: 'evidence_required' };

  return writeEvent(client, {
    workspace_id: workspace,
    contact_phone: contactPhone,
    event_type: 'opt_in',
    purpose: PURPOSE,
    brand_id: workspace,
    source: String(source).trim(),
    evidence_ref: String(evidenceRef).trim(),
    occurred_at: isoOrNow(occurredAt),
    recorded_by: recordedBy,
    metadata,
    dedupe_key: dedupeKey
  }, workspace);
}

/**
 * Record withdrawal. Intentionally permissive: a STOP must be recordable even
 * when we know nothing else about where it came from.
 */
async function recordOptOut({
  client,
  phone,
  source = SOURCE.INBOUND_STOP,
  evidenceRef = null,
  occurredAt = null,
  metadata = {},
  dedupeKey = null,
  recordedBy = null,
  workspace = DEFAULT_WORKSPACE
}) {
  const contactPhone = normalisePhone(phone);
  if (!contactPhone) return { recorded: false, reason: 'invalid_phone' };

  return writeEvent(client, {
    workspace_id: workspace,
    contact_phone: contactPhone,
    event_type: 'opt_out',
    purpose: PURPOSE,
    brand_id: workspace,
    source: String(source || SOURCE.INBOUND_STOP).trim() || SOURCE.INBOUND_STOP,
    evidence_ref: evidenceRef ? String(evidenceRef).trim() : null,
    occurred_at: isoOrNow(occurredAt),
    recorded_by: recordedBy,
    metadata,
    dedupe_key: dedupeKey
  }, workspace);
}

/**
 * The current state for one phone: the newest event wins, and a tie on
 * `occurred_at` is broken by id, matching the ordering the SQL eligibility
 * checks use. Returns null when the ledger has never heard of this number,
 * which is different from — and must never be confused with — an opt-out.
 */
async function currentConsent({ client, phone, workspace = DEFAULT_WORKSPACE }) {
  const contactPhone = normalisePhone(phone);
  if (!contactPhone) return null;

  const { data, error } = await client
    .from('sms_consent_events')
    .select('event_type, source, evidence_ref, occurred_at, id')
    .eq('workspace_id', workspace)
    .eq('contact_phone', contactPhone)
    .order('occurred_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1);

  if (error) {
    throw Object.assign(new Error(error.message), { code: 'CONSENT_READ_FAILED' });
  }
  const latest = Array.isArray(data) ? data[0] : null;
  if (!latest) return null;

  return {
    optedIn: latest.event_type === 'opt_in',
    source: latest.source,
    evidenceRef: latest.evidence_ref,
    occurredAt: latest.occurred_at
  };
}

module.exports = {
  DEFAULT_WORKSPACE,
  PURPOSE,
  SOURCE,
  currentConsent,
  normalisePhone,
  recordOptIn,
  recordOptOut
};
