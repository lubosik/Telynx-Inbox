'use strict';
/**
 * lib/llm-runner.js — the operational shell around the privacy boundary.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A SEPARATE FILE FROM openrouter-private.js
 *
 *   `privateCompletion` is the privacy boundary: it tokenises, it pins the
 *   model and the providers, it demands Zero Data Retention, and it refuses to
 *   hand back a response still carrying an unresolved token. Everything it
 *   does is a rule about what may leave this process, and it is short enough
 *   that a reviewer can read all of it in one sitting and be sure.
 *
 *   That property is worth protecting. Concurrency limits, retries, backoff
 *   and spend caps are operational concerns — they decide how OFTEN we call,
 *   never WHAT we send — so putting them in the same file would double its
 *   length and bury the four lines that actually matter for privacy inside
 *   forty lines of queue bookkeeping.
 *
 *   So: this file wraps that one, and never reaches inside it. It cannot
 *   choose a model (`privateCompletion` takes no model argument and
 *   `approvedModel()` throws on anything unapproved), it cannot disable the
 *   tokeniser, and it cannot see a request body it did not receive.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A "RUN" IS
 *
 *   One runner instance is one run — one backfill, one sweep, one request
 *   handler. The per-run budget is therefore per-instance, and the per-day
 *   budget is shared by every runner in the process through a module-level
 *   ledger. Creating a runner is free; reusing one across unrelated work is
 *   what makes its budget meaningless.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * RETRY, AND THE ONE THING IT MUST NOT DO
 *
 *   Retrying is only ever correct when the SAME request could plausibly
 *   succeed the second time. That is true of 429 (rate limited), 5xx (the
 *   provider is unwell) and an aborted timeout. It is emphatically not true of
 *   a response the caller could not parse, or one that failed a validation
 *   assertion: those are deterministic properties of the prompt, the second
 *   attempt produces the same rejection, and the only thing that changed is
 *   that the budget is now half gone.
 *
 *   That is why the retry decision lives HERE and looks only at transport
 *   failures. A caller whose parse failed simply does not call again; there is
 *   no "retryable: true" flag it can pass, on purpose.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 *   It does not write an audit row. Nothing here knows which table an audit
 *   belongs in, and a library that writes to a database it was not given is
 *   how a module ends up with two owners. `stats()` returns the numbers; the
 *   caller that owns a run owns recording it.
 *
 *   It does not report model token usage, because `privateCompletion` does not
 *   return `usage` and this file will not start parsing OpenRouter response
 *   bodies behind the boundary's back. `privateTokensRedacted` counts values
 *   the TOKENISER replaced — a privacy measure, not a cost measure — and is
 *   named so it cannot be mistaken for one.
 */

const { privateCompletion } = require('./openrouter-private');

/**
 * Defaults, all overridable from the environment.
 *
 * The budgets are deliberately finite rather than unlimited-by-default. The
 * whole population this exists for is ~150 narrative backfills plus a handful
 * a week; a runaway loop is far more likely than a legitimate thousandth call,
 * and a cap that has to be REMEMBERED at deploy time is not a cap.
 */
const DEFAULTS = Object.freeze({
  concurrency: 2,
  attempts: 2,
  runCallBudget: 250,
  dailyCallBudget: 1000
});

/**
 * Backoff before attempt 2, then before attempt 3, and so on holding at the
 * last value. Short on purpose: this sits behind a background sweep, not a
 * user waiting on a page, but a minute of sleeping still stalls a worker
 * that could be doing the next contact.
 */
const BACKOFF_MS = Object.freeze([500, 1500]);

class LlmRunnerError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = 'LlmRunnerError';
    this.code = code || 'LLM_CALL_FAILED';
    if (cause) this.cause = cause;
  }
}

// ── Environment ────────────────────────────────────────────────────────────

/**
 * A positive integer setting, or the default.
 *
 * An UNSET or blank variable must fall back rather than read as zero:
 * `Number('')` is 0, which is finite, and a budget of zero would silently turn
 * the whole feature off while every log line said the calls were "over
 * budget". Zero is not offered as a way to disable anything — LLM_KILL_SWITCH
 * is the one answer to that question, and one answer is the point.
 */
function positiveInt(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.trunc(value);
}

/** This repository's flag convention: the exact string `true`, nothing else. */
function flagOn(raw) {
  return String(raw ?? '') === 'true';
}

function limitsFrom(env = process.env) {
  return {
    concurrency: positiveInt(env.LLM_MAX_CONCURRENCY, DEFAULTS.concurrency),
    attempts: positiveInt(env.LLM_MAX_ATTEMPTS, DEFAULTS.attempts),
    runCallBudget: positiveInt(env.LLM_RUN_CALL_BUDGET, DEFAULTS.runCallBudget),
    dailyCallBudget: positiveInt(env.LLM_DAILY_CALL_BUDGET, DEFAULTS.dailyCallBudget)
  };
}

// ── Failure classification ─────────────────────────────────────────────────

/**
 * The HTTP status behind a failure, or null.
 *
 * `privateCompletion` throws `OpenRouter request failed (429)` and carries no
 * status property, so the string is the only evidence there is. That coupling
 * is stated here rather than hidden: if that message ever changes, retries
 * stop happening, which is the safe direction to fail in — a missed retry
 * costs one narrative, a wrongly-retried request costs budget and could
 * duplicate work.
 *
 * `error.status` is checked first so an injected completion (every test, and
 * any future caller) can be explicit instead of imitating a message.
 */
function statusOf(error) {
  const explicit = Number(error?.status ?? error?.statusCode);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const match = String(error?.message || '').match(/\((\d{3})\)/);
  return match ? Number(match[1]) : null;
}

/**
 * Only 429, 5xx and an aborted request. Everything else — a parse failure, a
 * validation assertion, a missing API key, an unresolved private token — is
 * deterministic and would fail identically on the second attempt.
 */
function isRetryable(error) {
  if (!error) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  // `AbortController.abort()` surfaces as a DOMException in Node's fetch, and
  // as a plain Error with this message in some polyfills.
  if (/\baborted?\b|The operation was aborted/i.test(String(error.message || ''))) return true;
  const status = statusOf(error);
  if (status === null) return false;
  return status === 429 || (status >= 500 && status <= 599);
}

// ── Concurrency ────────────────────────────────────────────────────────────

/**
 * A FIFO semaphore.
 *
 * The slot is TRANSFERRED on release rather than freed and re-acquired. The
 * obvious implementation — decrement, then wake a waiter — lets a caller that
 * arrives in between see a free slot and take it, so the woken waiter pushes
 * the count past the limit. With a limit of 2 and a provider that rate-limits
 * at 2 that is not a rounding error, it is the thing the limit exists to stop.
 */
function createSemaphore(limit) {
  const size = Math.max(1, Math.trunc(limit) || 1);
  let active = 0;
  const waiting = [];

  return {
    async acquire() {
      // The queue check keeps it fair: a newcomer cannot jump a waiter.
      if (active < size && waiting.length === 0) { active += 1; return; }
      await new Promise(resolve => waiting.push(resolve));
      // The releasing caller handed its slot over without decrementing, so
      // `active` already accounts for this one.
    },
    release() {
      const next = waiting.shift();
      if (next) { next(); return; }
      active -= 1;
    },
    get active() { return active; },
    get queued() { return waiting.length; },
    get size() { return size; }
  };
}

// ── Daily ledger ───────────────────────────────────────────────────────────

/**
 * Calls made today, across every runner in this process.
 *
 * IN-PROCESS ONLY, and that is a real limitation rather than an oversight: a
 * second Railway replica keeps its own count, so the true daily ceiling is
 * `LLM_DAILY_CALL_BUDGET × replicas`. A shared counter would need a table and
 * a round trip on every call, which is a worse trade for a cap whose job is to
 * stop a runaway loop rather than to bill anybody.
 *
 * The day boundary is UTC, so a run that straddles midnight London time does
 * not reset mid-sweep in summer and does in winter.
 */
function createDailyLedger() {
  let day = null;
  let calls = 0;

  function rollover(nowMs) {
    const today = new Date(nowMs).toISOString().slice(0, 10);
    if (today !== day) { day = today; calls = 0; }
  }

  return {
    count(nowMs) { rollover(nowMs); return calls; },
    record(nowMs) { rollover(nowMs); calls += 1; return calls; },
    get day() { return day; }
  };
}

/** The shared ledger. Tests pass their own, so they cannot poison each other. */
const processDailyLedger = createDailyLedger();

// ── The runner ─────────────────────────────────────────────────────────────

/**
 * @param {object}   [options]
 * @param {function} [options.completion] the boundary. Injected in tests so no
 *                                        test can make a real call.
 * @param {object}   [options.env]
 * @param {function} [options.now]        milliseconds, for the daily ledger.
 * @param {function} [options.sleep]      injected so backoff is instant in tests.
 * @param {object}   [options.ledger]     see createDailyLedger.
 * @param {string}   [options.label]      names this run in stats() and errors.
 */
function createLlmRunner({
  completion = privateCompletion,
  env = process.env,
  now = () => Date.now(),
  sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  ledger = processDailyLedger,
  label = 'llm'
} = {}) {
  const limits = limitsFrom(env);
  const semaphore = createSemaphore(limits.concurrency);

  const counters = {
    calls: 0,          // billable attempts, not logical requests
    requests: 0,       // logical requests that reached the queue
    succeeded: 0,
    failed: 0,
    retries: 0,
    refused: 0,        // never reached the provider: kill switch or budget
    privateTokensRedacted: 0
  };

  function stats() {
    const nowMs = now();
    return {
      label,
      ...counters,
      limits: { ...limits },
      runCallsRemaining: Math.max(0, limits.runCallBudget - counters.calls),
      dailyCallsUsed: ledger.count(nowMs),
      dailyCallsRemaining: Math.max(0, limits.dailyCallBudget - ledger.count(nowMs))
    };
  }

  /**
   * A billable attempt, or a refusal.
   *
   * Checked immediately before each attempt rather than once per request,
   * because a retry costs exactly as much as a first try and a budget that
   * only counted first tries would be off by up to the attempt limit.
   */
  function claimCall() {
    if (counters.calls >= limits.runCallBudget) {
      counters.refused += 1;
      throw new LlmRunnerError(
        `${label}: per-run call budget of ${limits.runCallBudget} is spent.`,
        'LLM_RUN_BUDGET_EXHAUSTED'
      );
    }
    const nowMs = now();
    if (ledger.count(nowMs) >= limits.dailyCallBudget) {
      counters.refused += 1;
      throw new LlmRunnerError(
        `${label}: daily call budget of ${limits.dailyCallBudget} is spent.`,
        'LLM_DAILY_BUDGET_EXHAUSTED'
      );
    }
    counters.calls += 1;
    ledger.record(nowMs);
  }

  /**
   * One completion, with concurrency, retry and budget applied.
   *
   * Takes and returns exactly what `privateCompletion` does. Anything this
   * file does not understand is passed through untouched, so a caller needing
   * tools, a tool choice or a different timeout is not blocked on this file
   * learning about it.
   */
  async function run(request = {}) {
    // Read at call time, not at construction: a kill switch that only took
    // effect on the next deploy is not a kill switch.
    if (flagOn(env.LLM_KILL_SWITCH)) {
      counters.refused += 1;
      throw new LlmRunnerError(
        `${label}: LLM_KILL_SWITCH is on; no model calls are being made.`,
        'LLM_KILL_SWITCH'
      );
    }

    counters.requests += 1;
    await semaphore.acquire();
    try {
      let lastError = null;

      for (let attempt = 1; attempt <= limits.attempts; attempt += 1) {
        try {
          claimCall();
        } catch (error) {
          // Budget ran out mid-retry. The budget failure is the one the caller
          // must act on — it means stop the whole run, not retry this one —
          // so it wins, and the transport failure rides along as the cause.
          if (lastError) error.cause = lastError;
          throw error;
        }

        try {
          // `env` is forwarded so the boundary reads the same configuration
          // this runner budgeted against. A caller may still override it.
          const result = await completion({ env, ...request });
          counters.succeeded += 1;
          const redacted = Number(result?.privateTokenCount);
          if (Number.isFinite(redacted)) counters.privateTokensRedacted += redacted;
          return result;
        } catch (error) {
          counters.failed += 1;
          lastError = error;
          if (attempt >= limits.attempts || !isRetryable(error)) break;
          counters.retries += 1;
          await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]);
        }
      }

      const failure = new LlmRunnerError(
        `${label}: completion failed — ${lastError?.message || 'unknown error'}`,
        'LLM_CALL_FAILED',
        lastError
      );
      failure.retryable = isRetryable(lastError);
      failure.status = statusOf(lastError);
      throw failure;
    } finally {
      semaphore.release();
    }
  }

  return {
    run,
    stats,
    limits: () => ({ ...limits }),
    /** Exposed for assertions about queueing; not part of the calling contract. */
    inFlight: () => ({ active: semaphore.active, queued: semaphore.queued })
  };
}

module.exports = {
  BACKOFF_MS,
  DEFAULTS,
  LlmRunnerError,
  createDailyLedger,
  createLlmRunner,
  createSemaphore,
  flagOn,
  isRetryable,
  limitsFrom,
  positiveInt,
  processDailyLedger,
  statusOf
};
