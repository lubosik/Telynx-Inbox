'use strict';
/**
 * lib/audit/log.js — the only writer for sms_audit_log.
 *
 * FAIL-OPEN BY DEFAULT
 *   An audit write must never break a send, a call, or a cancel. If the table
 *   is missing (deploy ordering), if PostgREST's schema cache is stale, or if
 *   the insert simply fails, the originating request continues and this
 *   function returns `{ recorded: false }`. A missing table is warned about
 *   exactly once per process, mirroring lib/analytics/events.js lines 18-27,
 *   so an un-migrated deploy does not produce one warning per queued message.
 *
 * THE ONE EXCEPTION
 *   Event types flagged `consentBearing` in lib/audit/event-types.js
 *   (contact.opted_out, contact.opt_in_restored) throw on write failure. A
 *   consent record that cannot be written must stop the action rather than let
 *   it proceed unrecorded. Everything else is best-effort.
 *
 * RESERVED AND UNKNOWN TYPES THROW
 *   Both are programming errors, deterministic, and caught by the unit tests
 *   rather than in production. Failing loudly is better than accepting a typo
 *   that quietly writes nothing, or writing a campaign event before the
 *   campaigns feature exists.
 *
 * WHAT IS DELIBERATELY NOT AUDITED
 *   Successful automated sends (sms_sent_log is already that ledger, and its
 *   unique index makes a double-insert impossible), inbound messages, and
 *   read-state changes such as marking a thread read. Failures are audited;
 *   successes are referenced. Recording who opened which conversation is the
 *   fastest way to make a two-person team feel surveilled, and it answers no
 *   question anyone has asked.
 */

const net = require('node:net');

const { broadcast: defaultBroadcast } = require('../broadcaster');
const { eventDefinition, isConsentBearing } = require('./event-types');
const { capMetadata, MESSAGE_BODY_KEYS, redactMetadata, stateEntryIsUnsafe } = require('./redact');

const WORKSPACE_ID = 'vici';
const MISSING_SCHEMA_CODES = new Set(['42P01', 'PGRST205', 'PGRST204']);
const MAX_SUMMARY_CHARS = 1000;
const MAX_USER_AGENT_CHARS = 512;

/**
 * Used when a request has no `req.actor` yet. The actor-identity work lands
 * separately; until it does, the table still accumulates correct before/after
 * history rather than nothing at all, and 'legacy' marks exactly which rows
 * predate real identities.
 */
const LEGACY_ACTOR = Object.freeze({
  actor_type: 'user',
  actor_user_id: null,
  actor_display_name: 'Team',
  actor_role: 'legacy'
});

const SYSTEM_ACTOR = Object.freeze({
  actor_type: 'system',
  actor_user_id: null,
  actor_display_name: 'Automation',
  actor_role: null
});

class AuditWriteError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'AuditWriteError';
    this.code = 'AUDIT_WRITE_FAILED';
    if (cause) this.cause = cause;
  }
}

let warnedMissingMigration = false;
let cachedClient = null;

function resolveClient(client) {
  if (client) return client;
  // Resolved lazily so unit tests can exercise this module without Supabase
  // configuration in the environment.
  if (!cachedClient) cachedClient = require('../../db').supabase;
  return cachedClient;
}

function isMissingAuditSchema(error) {
  // "The table is not there yet" and "the table refused this write" are
  // opposite conditions and must not be conflated.
  //
  // The old test was `code in MISSING_SCHEMA_CODES || /sms_audit_log/i.test(message)`.
  // Postgres names the relation in RLS, permission and constraint errors too,
  // so an RLS refusal, a permission denial and a CHECK violation all matched —
  // which silently disarmed the consent-bearing hard failure in precisely the
  // cases it exists for, and told the operator to apply a migration that was
  // already applied.
  //
  // Same shape as isMissingAnalyticsSchema in lib/analytics/aggregate.js: the
  // message must say the thing is ABSENT, and it must name one of our tables.
  if (MISSING_SCHEMA_CODES.has(error?.code)) return true;
  const message = String(error?.message || '');
  const absent = /does not exist|could not find|schema cache/i;
  const auditTable = /sms_audit_log/i;
  return absent.test(message) && auditTable.test(message);
}

function warnMissingOnce(error) {
  if (warnedMissingMigration) return;
  warnedMissingMigration = true;
  console.warn(`[AUDIT] Schema is not ready; source workflow continues safely (${error?.code || 'unknown'}). Apply scripts/audit-migration.sql.`);
}

/** Test seam: the once-only warning is process-global by design. */
function resetMissingSchemaWarning() {
  warnedMissingMigration = false;
}

function normaliseActorID(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Consume `req.actor` when it is present, and fall back to LEGACY_ACTOR when it
 * is not, so instrumentation is not blocked on the identity work.
 */
function resolveActor({ actor, req, actorType }) {
  if (actorType === 'system') return { ...SYSTEM_ACTOR };
  const source = actor || req?.actor || null;
  if (!source) return { ...LEGACY_ACTOR };
  return {
    actor_type: source.type || source.actorType || 'user',
    actor_user_id: normaliseActorID(source.id ?? source.userId),
    actor_display_name: source.displayName || source.name || 'Team',
    actor_role: source.role || null
  };
}

function clientIP(input) {
  const raw = input.ip || input.req?.ip || null;
  if (typeof raw !== 'string' || !raw) return null;
  const candidate = raw.trim();
  // `inet` rejects anything malformed with 22P02, which fails the whole insert
  // and loses the audit row. A character-class test is not a validator: it
  // admits 'aaaa', '1.2.3.4.5.6', '::::' and '....', all of which Postgres
  // refuses. net.isIP() is the actual parser, and returns 0 for anything that
  // is neither a valid IPv4 nor a valid IPv6 address.
  return net.isIP(candidate) === 0 ? null : candidate;
}

function clientUserAgent(input) {
  const raw = input.userAgent || (typeof input.req?.get === 'function' ? input.req.get('user-agent') : null);
  if (typeof raw !== 'string' || !raw) return null;
  return raw.slice(0, MAX_USER_AGENT_CHARS);
}

function requestID(input) {
  const raw = input.requestId ||
    (typeof input.req?.get === 'function' ? input.req.get('x-request-id') : null);
  return typeof raw === 'string' && raw ? raw.slice(0, 128) : null;
}

/**
 * Screen a state snapshot.
 *
 * `previous_state` and `new_state` are returned verbatim by GET /api/audit and
 * land in a table with REVOKE DELETE and an immutability trigger, so they get
 * the same hard rules as metadata: no message body, no secret-shaped key, no
 * live secret value, no signed URL. They cannot get the allowlist, because a
 * snapshot's keys are the source row's columns and are not enumerable in
 * advance — which is exactly why the unconditional screens have to apply.
 *
 * No current call site trips this. The point is that the next one cannot.
 *
 * @param {object} state
 * @param {object} [options]
 * @param {object} [options.env]
 */
function sanitiseState(state, { env = process.env } = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const clean = {};
  for (const [key, value] of Object.entries(state)) {
    if (MESSAGE_BODY_KEYS.has(key)) continue;
    if (value === undefined) continue;
    if (stateEntryIsUnsafe(key, value, { env })) continue;
    clean[key] = value;
  }
  return capMetadata(clean).metadata;
}

/** Field names whose values differ between two snapshots. */
function diffFields(previous, next) {
  const before = previous && typeof previous === 'object' ? previous : {};
  const after = next && typeof next === 'object' ? next : {};
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [];
  for (const name of names) {
    if (JSON.stringify(before[name] ?? null) !== JSON.stringify(after[name] ?? null)) changed.push(name);
  }
  return changed.sort();
}

function buildRow(input) {
  const definition = eventDefinition(input.eventType);
  if (!definition) {
    throw new AuditWriteError(`Unknown audit event type: ${input.eventType}. Add it to lib/audit/event-types.js.`);
  }
  if (definition.reserved) {
    throw new AuditWriteError(`Audit event type ${input.eventType} is reserved and cannot be emitted yet.`);
  }

  const actor = resolveActor(input);
  const previousState = sanitiseState(input.previousState, { env: input.env });
  const newState = sanitiseState(input.newState, { env: input.env });
  const changedFields = Array.isArray(input.changedFields) && input.changedFields.length
    ? input.changedFields
    : (previousState && newState ? diffFields(previousState, newState) : null);

  const { metadata } = redactMetadata(input.eventType, input.metadata, { env: input.env });
  const summary = typeof input.summary === 'string' && input.summary.trim()
    ? input.summary.trim().slice(0, MAX_SUMMARY_CHARS)
    : `${actor.actor_display_name} performed ${input.eventType}`;

  return {
    row: {
      workspace_id: input.workspaceId || WORKSPACE_ID,
      occurred_at: input.occurredAt || new Date().toISOString(),
      actor_type: actor.actor_type,
      actor_user_id: actor.actor_user_id,
      actor_display_name: actor.actor_display_name,
      actor_role: actor.actor_role,
      event_type: input.eventType,
      category: definition.category,
      visibility: input.visibility || definition.visibility,
      severity: input.severity || definition.severity,
      entity_type: input.entityType || definition.entityType,
      entity_id: input.entityId === null || input.entityId === undefined ? null : String(input.entityId),
      contact_phone: input.contactPhone || null,
      summary,
      previous_state: previousState,
      new_state: newState,
      changed_fields: changedFields && changedFields.length ? changedFields : null,
      metadata,
      ip: clientIP(input),
      user_agent: clientUserAgent(input),
      request_id: requestID(input),
      fingerprint: input.fingerprint || null
    },
    definition
  };
}

/**
 * Write one audit row.
 *
 * @param {object} input
 * @param {string} input.eventType        key of lib/audit/event-types.js
 * @param {object} [input.req]            Express request, for actor/ip/user-agent
 * @param {object} [input.actor]          explicit actor, overrides req.actor
 * @param {'system'} [input.actorType]    force the system actor for webhooks/jobs
 * @param {string} [input.summary]        pre-rendered sentence, written once
 * @param {string|number} [input.entityId]
 * @param {string} [input.contactPhone]   full E.164, deliberately not masked
 * @param {object} [input.previousState]
 * @param {object} [input.newState]
 * @param {string[]} [input.changedFields]
 * @param {object} [input.metadata]       filtered by the allowlist in redact.js
 * @param {string} [input.fingerprint]    idempotency key for retried handlers
 * @param {object} [options]
 * @param {object} [options.client]       Supabase client (injected in tests)
 * @param {Function} [options.broadcast]
 * @returns {Promise<{recorded: boolean, id: number|null, reason?: string}>}
 */
async function logAudit(input = {}, options = {}) {
  const { row, definition } = buildRow(input);
  const client = resolveClient(options.client);
  const emit = options.broadcast || defaultBroadcast;

  try {
    const { data, error } = await client
      .from('sms_audit_log')
      .insert(row)
      .select('id')
      .maybeSingle();

    if (error) throw error;

    // Carry the row id so a client that has drifted can catch up by cursor
    // instead of refetching the feed from the head.
    //
    // A dedicated event, NOT the analytics `analytics_changed` event: a client
    // sitting on the Analytics tab would otherwise refetch the entire revenue
    // overview every time somebody cancelled a queued SMS.
    emit({
      type: 'audit_changed',
      id: data?.id ?? null,
      category: row.category,
      visibility: row.visibility,
      occurred_at: row.occurred_at
    });

    return { recorded: true, id: data?.id ?? null };
  } catch (error) {
    // A fingerprint collision means the event is already recorded — that is the
    // point of the fingerprint, so it is a success for the caller, including a
    // consent-bearing one.
    if (error?.code === '23505') return { recorded: false, id: null, reason: 'duplicate' };

    // ORDER MATTERS, and it is the opposite of what it looks like.
    //
    // The missing-schema check MUST come before the consent-bearing throw.
    // Otherwise, in the window between deploying this code and applying
    // scripts/audit-migration.sql, `contact.opted_out` throws — and its only
    // caller is markOptedOut(), whose only caller is the Telnyx STOP branch in
    // routes/webhook.js. The throw propagates into that handler's outer catch
    // and every statement after markOptedOut is skipped: the queued sequences
    // are never cancelled, the STOP message is never recorded, and the opt_out
    // broadcast never fires. A customer who texted STOP keeps receiving
    // automation SMS.
    //
    // That is the exact failure this release fixed twice already, and putting
    // the consent check first reintroduces it through a third mechanism. The
    // migration not being applied yet is an operator sequencing problem, not
    // evidence that consent went unrecorded — so fail open on it, and reserve
    // the hard failure for a table that exists and refused the write.
    if (isMissingAuditSchema(error)) {
      warnMissingOnce(error);
      return { recorded: false, id: null, reason: 'schema_missing' };
    }

    if (definition.consentBearing) {
      console.error(`[AUDIT] Consent event ${row.event_type} could not be recorded: ${error?.code || error?.message || 'unknown'}`);
      throw new AuditWriteError(
        `Consent audit record for ${row.event_type} could not be written; the action must not proceed unrecorded.`,
        error
      );
    }

    console.error(`[AUDIT] Write failed for ${row.event_type}: ${error?.code || error?.message || 'unknown'}`);
    return { recorded: false, id: null, reason: 'write_failed' };
  }
}

/**
 * logAudit, but it cannot throw for a non-consent-bearing event.
 *
 * logAudit already fails open on a failed INSERT, but it throws before the
 * insert on an unknown or reserved event type, and buildRow can throw on a
 * malformed input. At a call site that has already changed the world — a role
 * granted, a bulk SMS sent, a background sync latch taken — that throw
 * propagates into the handler and turns a completed action into a 500, or
 * worse: in routes/sync.js it left `syncRunning = true` for the life of the
 * process, so no sync could ever be triggered again until a restart.
 *
 * An audit write must never be able to wedge the feature it describes. Use
 * this at any call site where the audit follows the effect.
 *
 * A consent-bearing event still throws, deliberately and unchanged: a consent
 * record that could not be written must stop the action. Nothing here weakens
 * that path.
 */
async function logAuditSafely(input = {}, options = {}) {
  try {
    return await logAudit(input, options);
  } catch (error) {
    if (isConsentBearing(input.eventType)) throw error;
    console.error(`[AUDIT] Non-fatal audit failure for ${input.eventType || 'unknown event'}: ${error?.code || error?.message || 'unknown'}`);
    return { recorded: false, id: null, reason: 'threw' };
  }
}

module.exports = {
  AuditWriteError,
  LEGACY_ACTOR,
  SYSTEM_ACTOR,
  WORKSPACE_ID,
  buildRow,
  diffFields,
  logAudit,
  logAuditSafely,
  resetMissingSchemaWarning,
  sanitiseState
};
