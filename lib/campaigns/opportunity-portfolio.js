'use strict';
/**
 * lib/campaigns/opportunity-portfolio.js — keep the portfolio picture current,
 * on a schedule and on demand.
 *
 * WHAT IT DOES NOT DO
 *   It writes nothing. There is no table, no migration and no persisted
 *   snapshot. The whole computation is a pure function of the authoritative
 *   sources, so the honest cache is an in-process one that can be thrown away
 *   at any moment and rebuilt from the database. Persisting it would create a
 *   second copy of the truth that could disagree with the first, and would
 *   need a migration to fix every time a finding changed shape.
 *
 * WHY IT IS CACHED AT ALL
 *   One refresh reads every paid order, every contact, the campaign source
 *   tables and the WooCommerce catalogue. That is not a per-request cost. The
 *   cache holds one payload per workspace with a time to live, and a forced
 *   refresh is debounced so that a client holding down a refresh control
 *   cannot turn a screen into a load test against WooCommerce.
 *
 * ONE READER
 *   readAuthoritativeGenerationSources() is the only source read, exactly as
 *   the generator and the segment service use it, and the catalogue comes from
 *   the shared cache inside it. Nothing here opens a second path to the data.
 *
 * FAILURE IS NOT SILENCE
 *   A refresh that fails leaves the previous payload in place and reports the
 *   failure alongside it, with `stale: true` and the age of what is being
 *   shown. A screen showing yesterday's picture and saying so is useful. A
 *   screen showing yesterday's picture and claiming it is current is not, and
 *   an empty screen when the last read failed is worse than both.
 */

const { buildBuyerCohortFacts } = require('./buyer-cohorts');
const { detectOpportunities } = require('./opportunity-detector');

const WORKSPACE_ID = 'vici';
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MIN_REFRESH_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;

function positiveMilliseconds(value, fallback, ceiling) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, ceiling);
}

function ttlFrom(env) {
  return positiveMilliseconds(env?.CAMPAIGN_OPPORTUNITY_TTL_MS, DEFAULT_TTL_MS, MAX_TTL_MS);
}

function minimumRefreshFrom(env) {
  return positiveMilliseconds(
    env?.CAMPAIGN_OPPORTUNITY_MIN_REFRESH_MS, DEFAULT_MIN_REFRESH_MS, MAX_TTL_MS);
}

/**
 * @param {object} [options]
 * @param {object} [options.client] Supabase client. Resolved lazily so that
 *   constructing the service in a test needs no credentials.
 * @param {function} [options.sourceReader] Injectable seam for tests. Defaults
 *   to readAuthoritativeGenerationSources.
 * @param {function} [options.wooGet] Injectable WooCommerce reader.
 */
function createOpportunityPortfolioService({
  client,
  env = process.env,
  workspaceID = WORKSPACE_ID,
  sourceReader,
  wooGet
} = {}) {
  let injected = client || null;
  function db() {
    if (!injected) injected = require('../../db').supabase;
    return injected;
  }

  /** { computedAt: number, payload: object } or null. */
  let cached = null;
  /** Set while a refresh is in flight, so concurrent callers share one read. */
  let inFlight = null;
  let lastAttemptAt = 0;
  let lastFailure = null;

  async function readSources(now) {
    if (typeof sourceReader === 'function') return sourceReader({ now, workspaceID });
    const { readAuthoritativeGenerationSources } = require('./generation-service');
    return readAuthoritativeGenerationSources({
      client: db(),
      now,
      workspaceID,
      wooGet: wooGet || ((...args) => require('../../woocommerce').wooGet(...args)),
      env
    });
  }

  async function compute(now) {
    const sources = await readSources(now);
    const cohortFacts = buildBuyerCohortFacts(sources, { now });
    return detectOpportunities(cohortFacts, { env });
  }

  /**
   * Recompute now. Concurrent callers join the single in-flight read rather
   * than each opening their own; two simultaneous refreshes of the same
   * workspace would otherwise double every provider call for no benefit.
   */
  async function refreshNow({ now = new Date() } = {}) {
    if (inFlight) return inFlight;
    lastAttemptAt = now.getTime();
    inFlight = (async () => {
      try {
        const payload = await compute(now);
        cached = { computedAt: now.getTime(), payload };
        lastFailure = null;
        return payload;
      } catch (error) {
        // Recorded, never swallowed, and never allowed to discard a good
        // previous answer.
        lastFailure = {
          at: new Date().toISOString(),
          code: error?.code || 'OPPORTUNITY_REFRESH_FAILED',
          message: error?.message || 'The opportunity portfolio could not be recomputed.'
        };
        throw error;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  /**
   * The current picture.
   *
   * @param {object} [options]
   * @param {boolean} [options.refresh] force a recompute, subject to the
   *   debounce interval.
   */
  async function current({ refresh = false, now = new Date() } = {}) {
    const at = now instanceof Date ? now : new Date(now);
    const ttl = ttlFrom(env);
    const minimumInterval = minimumRefreshFrom(env);
    const age = cached ? at.getTime() - cached.computedAt : null;
    const expired = !cached || age >= ttl;
    const debounced = refresh && !expired
      && (at.getTime() - lastAttemptAt) < minimumInterval;

    if (expired || (refresh && !debounced)) {
      try {
        await refreshNow({ now: at });
      } catch (error) {
        if (!cached) throw error;
        // Fall through and serve the previous payload, labelled.
      }
    }

    if (!cached) {
      throw Object.assign(new Error('The opportunity portfolio is not available.'), {
        code: lastFailure?.code || 'OPPORTUNITY_PORTFOLIO_UNAVAILABLE', status: 503
      });
    }

    const servedAge = at.getTime() - cached.computedAt;
    return {
      ...cached.payload,
      freshness: {
        computedAt: new Date(cached.computedAt).toISOString(),
        ageSeconds: Math.max(0, Math.round(servedAge / 1000)),
        timeToLiveSeconds: Math.round(ttl / 1000),
        stale: servedAge >= ttl,
        refreshDebounced: debounced,
        minimumRefreshSeconds: Math.round(minimumInterval / 1000),
        lastRefreshFailure: lastFailure
      }
    };
  }

  /** Inspectable state, for a diagnostic. Contains no customer identity. */
  function cacheState({ now = new Date() } = {}) {
    return {
      hasPayload: Boolean(cached),
      computedAt: cached ? new Date(cached.computedAt).toISOString() : null,
      ageSeconds: cached ? Math.max(0, Math.round((now.getTime() - cached.computedAt) / 1000)) : null,
      refreshInFlight: Boolean(inFlight),
      lastRefreshFailure: lastFailure
    };
  }

  /** Drop the cache. Used by a scheduled rebuild and by tests. */
  function invalidate() {
    cached = null;
  }

  return { cacheState, current, invalidate, refreshNow };
}

/**
 * The scheduled rebuild.
 *
 * Read-only, so it is safe to run unconditionally: it cannot send, cannot
 * write and cannot touch a send gate. It is wrapped so that a WooCommerce
 * outage or an unapplied migration logs and returns rather than taking down
 * the inbox, the dialler or order SMS with it.
 *
 * Returns the timers so a caller can clear them; the server does not, because
 * the process ending is the intended way for them to stop.
 */
function startOpportunityPortfolioRefresh({
  service,
  env = process.env,
  log = console
} = {}) {
  const portfolio = service || createOpportunityPortfolioService({ env });
  const interval = ttlFrom(env);

  const run = async reason => {
    try {
      const payload = await portfolio.refreshNow({ now: new Date() });
      log.log(`[OPPORTUNITIES] ${reason}: ${payload.findings.length} findings, `
        + `${payload.refusals.length} refused to size.`);
    } catch (error) {
      log.error(`[OPPORTUNITIES] ${reason} failed:`, error?.code || error?.message || 'unknown');
    }
  };

  // Sixty seconds after boot, so it never competes with the queue and shipment
  // jobs that start in the first fifteen.
  const startup = setTimeout(() => { void run('startup refresh'); }, 60 * 1000);
  const repeating = setInterval(() => { void run('scheduled refresh'); }, interval);
  if (typeof startup.unref === 'function') startup.unref();
  if (typeof repeating.unref === 'function') repeating.unref();
  return { portfolio, startup, repeating };
}

module.exports = {
  DEFAULT_MIN_REFRESH_MS,
  DEFAULT_TTL_MS,
  createOpportunityPortfolioService,
  startOpportunityPortfolioRefresh
};
