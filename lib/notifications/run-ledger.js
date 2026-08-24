'use strict';
/**
 * lib/notifications/run-ledger.js — the claim that makes the daily cycle
 * idempotent, and the only writer of `sms_daily_cycle_runs`.
 *
 * THE GUARD IS A UNIQUE CONSTRAINT, NOT A CHECK-THEN-ACT
 *   `claim()` INSERTs a row and reads the answer. A 23505 unique violation on
 *   `sms_daily_cycle_runs_claim` IS the verdict "this scope already ran today",
 *   and it is returned as `{claimed: false, reason: 'already_claimed'}` rather
 *   than as an error. That ordering has no window in it. The obvious
 *   alternative — SELECT to see whether today exists, then INSERT — has a gap
 *   between the two statements, and Railway keeps the old instance alive while
 *   the new one boots during a rolling deploy, so both are ticking and both
 *   would pass the SELECT.
 *
 * TAKING OVER A DEAD CLAIM
 *   A process killed mid-cycle leaves `status = 'running'` and would otherwise
 *   kill the day for good. `claim()` retries once through a conditional UPDATE
 *   matched on BOTH `status = 'running'` AND `started_at < cutoff`. That is a
 *   compare and swap: two takers race, one matches zero rows, and only one
 *   proceeds. It never takes over a `succeeded`, `partial`, `failed` or
 *   `skipped` row, so a completed day stays completed however old it is.
 *
 * A MISSING TABLE IS "NOT READY", NEVER "BROKEN"
 *   Before scripts/daily-cycle-runs-migration.sql is applied, every call
 *   answers `{claimed: false, reason: 'not_ready'}`. The scheduler logs that
 *   once and does nothing, exactly as it should during the window between a
 *   deploy and a migration. It does not throw, because a background job that
 *   crashes the process on an unapplied migration is a crash loop on a service
 *   that also carries the inbox, the dialler and order SMS.
 *
 * NO CUSTOMER IDENTITY GOES IN `summary`
 *   Counts, segment keys, our own segment names and error codes. Nothing else.
 *   `test/daily-cycle.test.js` asserts the shape actually written.
 *
 * SUPABASE RULES THIS FILE OBEYS
 *   No `.catch()` on a query builder: a builder is a thenable with `then` only
 *   and `.catch()` throws a TypeError before the query is sent. No unbounded
 *   `.in()`: there is no `.in()` here at all. No unpaged full-table read: every
 *   read below is bounded by an explicit `.limit()`.
 */

const { missingRelation } = require('./preferences');

const TABLE = 'sms_daily_cycle_runs';
const WORKSPACE_ID = 'vici';

/**
 * The LEASE. A `running` claim older than this may be taken over.
 *
 * Ten minutes, per docs/notifications/DIGEST-AND-SETTINGS-RESEARCH.md D6. Long
 * enough that a genuinely slow pass is never stolen from itself; short enough
 * that a process killed mid-run does not cost the whole day. A COMPLETED run is
 * never retried however old it is, because the status is part of the match.
 */
const DEFAULT_STALE_CLAIM_MS = 10 * 60 * 1000;
const MIN_STALE_CLAIM_MS = 60 * 1000;
const MAX_STALE_CLAIM_MS = 6 * 60 * 60 * 1000;

const UNIQUE_VIOLATION = '23505';

function staleClaimMs(env = process.env) {
  const parsed = Number.parseInt(env?.DAILY_CYCLE_STALE_CLAIM_MS, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_STALE_CLAIM_MS;
  return Math.min(MAX_STALE_CLAIM_MS, Math.max(MIN_STALE_CLAIM_MS, parsed));
}

function notReady(error) {
  return { claimed: false, reason: 'not_ready', code: error?.code || 'missing_relation' };
}

/**
 * Claim one (scope, scopeKey, localDay) for this process.
 *
 * @param {object} options
 * @param {object} options.client
 * @param {'cycle'|'digest'} options.scope
 * @param {string} options.scopeKey
 * @param {string} options.localDay   `YYYY-MM-DD`
 * @param {string} options.timeZone
 * @param {Date}   [options.now]
 * @param {object} [options.env]
 * @returns {Promise<{claimed: boolean, id?: string, takenOver?: boolean,
 *                    reason?: string, code?: string}>} never throws.
 */
async function claim({
  client,
  scope,
  scopeKey,
  localDay,
  timeZone,
  now = new Date(),
  env = process.env,
  workspaceID = WORKSPACE_ID
} = {}) {
  if (!client) return { claimed: false, reason: 'no_client' };

  const row = {
    workspace_id: workspaceID,
    scope,
    scope_key: String(scopeKey),
    local_day: localDay,
    time_zone: timeZone,
    status: 'running',
    started_at: now.toISOString(),
    summary: {}
  };

  let data;
  let error;
  try {
    ({ data, error } = await client.from(TABLE).insert(row).select('id').maybeSingle());
  } catch (thrown) {
    return { claimed: false, reason: 'claim_threw', code: thrown?.code || 'unknown' };
  }
  if (!error && data) return { claimed: true, id: String(data.id), takenOver: false };
  if (missingRelation(error)) return notReady(error);
  if (error?.code !== UNIQUE_VIOLATION) {
    return { claimed: false, reason: 'claim_failed', code: error?.code || 'unknown' };
  }

  // Somebody holds today. The only case in which we may take it is a `running`
  // row abandoned by a dead process. Matched on status AND age in one
  // statement, so two takers cannot both win.
  const cutoff = new Date(now.getTime() - staleClaimMs(env)).toISOString();
  let recovered;
  let recoverError;
  try {
    ({ data: recovered, error: recoverError } = await client.from(TABLE)
      .update({ started_at: now.toISOString(), error: null })
      .eq('workspace_id', workspaceID)
      .eq('scope', scope)
      .eq('scope_key', String(scopeKey))
      .eq('local_day', localDay)
      .eq('status', 'running')
      .lt('started_at', cutoff)
      .select('id')
      .maybeSingle());
  } catch (thrown) {
    return { claimed: false, reason: 'already_claimed', code: thrown?.code || 'unknown' };
  }
  if (recoverError) return { claimed: false, reason: 'already_claimed', code: recoverError.code || 'unknown' };
  if (recovered) return { claimed: true, id: String(recovered.id), takenOver: true };
  return { claimed: false, reason: 'already_claimed' };
}

/**
 * Close a claimed run.
 *
 * Never throws and never reverses the effect it is recording. A failed ledger
 * write leaves the row `running`, which the stale-claim path will later take
 * over, and that is strictly better than a job that undoes real work because
 * its bookkeeping failed.
 *
 * @param {'succeeded'|'partial'|'failed'|'skipped'} status
 */
async function complete({
  client,
  id,
  status,
  summary = {},
  error = null,
  now = new Date()
} = {}) {
  if (!client || !id) return { recorded: false, reason: 'no_client_or_id' };
  let writeError;
  try {
    ({ error: writeError } = await client.from(TABLE).update({
      status,
      summary,
      error: error ? String(error).slice(0, 500) : null,
      completed_at: now.toISOString()
    }).eq('id', id));
  } catch (thrown) {
    console.error('[DAILY] Could not close the run ledger row:', thrown?.code || 'unknown');
    return { recorded: false, reason: 'complete_threw' };
  }
  if (writeError) {
    console.error('[DAILY] Could not close the run ledger row:', writeError.code || 'unknown');
    return { recorded: false, reason: 'complete_failed' };
  }
  return { recorded: true };
}

/**
 * The most recent local day this scope/key was claimed for, or null.
 *
 * Read BEFORE the claim so the scheduler can answer "waiting" or "done" without
 * writing anything on the overwhelming majority of ticks. It is a hint, not the
 * guard: the guard is the unique constraint inside `claim()`.
 */
async function lastClaimedDay({
  client, scope, scopeKey, workspaceID = WORKSPACE_ID
} = {}) {
  if (!client) return { available: false, localDay: null, reason: 'no_client' };
  let data;
  let error;
  try {
    ({ data, error } = await client.from(TABLE)
      .select('local_day, status')
      .eq('workspace_id', workspaceID)
      .eq('scope', scope)
      .eq('scope_key', String(scopeKey))
      .order('local_day', { ascending: false })
      .limit(1)
      .maybeSingle());
  } catch (thrown) {
    return { available: false, localDay: null, reason: thrown?.code || 'read_threw' };
  }
  if (error) {
    if (missingRelation(error)) return { available: false, localDay: null, reason: 'not_ready' };
    return { available: false, localDay: null, reason: error.code || 'read_failed' };
  }
  return { available: true, localDay: data?.local_day || null, status: data?.status || null };
}

/**
 * The most recent COMPLETED cycle, so a digest can report it.
 *
 * `succeeded` or `partial` only. A `failed` cycle produced no trustworthy
 * numbers and a digest built from it would be a summary of nothing; a `running`
 * one has not finished. Bounded by `.limit(1)` and by `maxAgeMs`, so a digest
 * can never report a cycle from last week as if it were this morning's.
 */
async function latestCycle({
  client, now = new Date(), maxAgeMs = 20 * 60 * 60 * 1000, workspaceID = WORKSPACE_ID
} = {}) {
  if (!client) return { available: false, run: null, reason: 'no_client' };
  const since = new Date(now.getTime() - maxAgeMs).toISOString();
  let data;
  let error;
  try {
    ({ data, error } = await client.from(TABLE)
      .select('id, local_day, time_zone, status, completed_at, summary')
      .eq('workspace_id', workspaceID)
      .eq('scope', 'cycle')
      .in('status', ['succeeded', 'partial'])
      .gte('completed_at', since)
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle());
  } catch (thrown) {
    return { available: false, run: null, reason: thrown?.code || 'read_threw' };
  }
  if (error) {
    if (missingRelation(error)) return { available: false, run: null, reason: 'not_ready' };
    return { available: false, run: null, reason: error.code || 'read_failed' };
  }
  return { available: true, run: data || null, reason: data ? null : 'no_recent_cycle' };
}

/**
 * Recent digest outcomes for one account, newest first.
 *
 * Feeds GATE 3 (novelty): the headline hashes of the last few days, so a claim
 * that is substantially the same as one already sent is suppressed rather than
 * repeated every morning for a fortnight. Also feeds the "Last digest" line on
 * the Settings screen, which is a free health indicator: a scheduler that has
 * silently stopped shows up as a date that stopped moving.
 *
 * Bounded by an explicit `.limit()`, so there is no unpaged read here.
 */
async function recentDigests({
  client, scopeKey, limit = 7, workspaceID = WORKSPACE_ID
} = {}) {
  if (!client) return { available: false, runs: [], reason: 'no_client' };
  const safeLimit = Math.min(30, Math.max(1, Number.parseInt(limit, 10) || 7));
  let data;
  let error;
  try {
    ({ data, error } = await client.from(TABLE)
      .select('local_day, status, completed_at, summary')
      .eq('workspace_id', workspaceID)
      .eq('scope', 'digest')
      .eq('scope_key', String(scopeKey))
      .order('local_day', { ascending: false })
      .limit(safeLimit));
  } catch (thrown) {
    return { available: false, runs: [], reason: thrown?.code || 'read_threw' };
  }
  if (error) {
    if (missingRelation(error)) return { available: false, runs: [], reason: 'not_ready' };
    return { available: false, runs: [], reason: error.code || 'read_failed' };
  }
  return { available: true, runs: data || [], reason: null };
}

module.exports = {
  DEFAULT_STALE_CLAIM_MS,
  MAX_STALE_CLAIM_MS,
  MIN_STALE_CLAIM_MS,
  TABLE,
  UNIQUE_VIOLATION,
  WORKSPACE_ID,
  claim,
  complete,
  lastClaimedDay,
  latestCycle,
  recentDigests,
  staleClaimMs
};
