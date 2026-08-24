'use strict';
/**
 * lib/daily-scheduler.js — the tick, and the wiring that makes the daily cycle
 * real in a running server.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW REDEPLOY DRIFT IS SOLVED, IN ONE PARAGRAPH
 *
 *   The timer here is NOT the schedule. It fires every five minutes and asks
 *   `lib/daily-cycle.js` a question; the answer comes from the wall clock in a
 *   named zone and from a claim row in `sms_daily_cycle_runs` whose unique
 *   constraint is the actual guard. Because the timer decides nothing, its
 *   phase does not matter, and a Railway redeploy that restarts the process at
 *   an arbitrary moment cannot move the fire time. A `setInterval(fn, 86400000)`
 *   would have fired 24 hours after BOOT, so the digest hour would have wandered
 *   around the clock at the pace of the release cadence. Worst-case lateness
 *   here is one tick, five minutes, not one deploy cycle.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * FAILURE IS CONTAINED
 *   Every tick is wrapped. A throw is logged with a code and the interval keeps
 *   running; a background job may never take down the process that also carries
 *   the inbox, the dialler and order SMS. Construction is wrapped too, so a
 *   missing module or an unapplied migration logs and returns rather than
 *   stopping `app.listen`.
 *
 * TIME ZONES HERE ARE DISPLAY AND DELIVERY TIMING, NEVER QUIET HOURS
 *   `sms_users.timezone` is read here to decide when to deliver ONE PERSON'S
 *   OWN summary push. Campaign quiet hours are enforced in SQL against
 *   `sms_campaign_settings.business_timezone` and nothing in this file is read
 *   by that predicate, by the delivery worker, or by any send gate. This module
 *   is deliberately outside `lib/campaigns/` so the source-text guard in
 *   test/user-timezone.test.js keeps holding.
 */

const { IN_CHUNK_SIZE } = require('./fetch-all-rows');
const { effectiveTimeZoneId } = require('./timezones');
const { cycleSchedule, digestTarget, runDueCycle, runDueDigests, tickIntervalFrom } =
  require('./daily-cycle');
const { nextFireAfter } = require('./notifications/daily-schedule');
const { missingRelation } = require('./notifications/preferences');

/** Ceiling on the account read. Two accounts today; this is slack, not a target. */
const MAX_USERS = 1000;

let warnedAboutTimeZoneColumn = false;

/**
 * Which accounts may receive a digest, and in which zone.
 *
 * Eligibility is the SAME rule the per-segment push already uses:
 * `segments.notificationUsers()` returns active Owners and Admins holding
 * `campaigns.manage`, computed from the effective RBAC decision rather than
 * from a role string. Reimplementing it here would be a second answer that
 * could disagree with the first.
 *
 * The zone is added on top, from `sms_users.timezone`. A read failure or an
 * unapplied timezone migration degrades to "no stored choice", which
 * `effectiveTimeZoneId` resolves to the documented default. That is the same
 * fallback the identity payload already reports, so a person's digest hour and
 * the hour their app renders are decided by one rule.
 */
async function digestRecipients({ client, segments, log = console }) {
  const users = await segments.notificationUsers();
  if (!users.length) return [];

  const zones = new Map();
  const ids = users.map(user => user.id).filter(value => value !== null && value !== undefined);
  for (let index = 0; index < ids.length && index < MAX_USERS; index += IN_CHUNK_SIZE) {
    const chunk = ids.slice(index, index + IN_CHUNK_SIZE);
    let data;
    let error;
    try {
      ({ data, error } = await client.from('sms_users').select('id, timezone')
        // bounded: `chunk` is a slice capped at IN_CHUNK_SIZE (200).
        .in('id', chunk));
    } catch (thrown) {
      error = thrown;
    }
    if (error) {
      if (missingRelation(error) || /timezone/i.test(String(error.message || ''))) {
        if (!warnedAboutTimeZoneColumn) {
          log.warn('[DAILY] sms_users.timezone is not readable, so every digest uses the default '
            + 'zone. Apply scripts/user-timezone-migration.sql.');
          warnedAboutTimeZoneColumn = true;
        }
        break;
      }
      log.error(`[DAILY] Could not read account time zones: ${error.code || 'unknown'}`);
      break;
    }
    for (const row of data || []) zones.set(String(row.id), row.timezone || null);
  }

  return users.map(user => ({
    ...user,
    timeZone: effectiveTimeZoneId(zones.get(String(user.id)) ?? null)
  }));
}

/**
 * One tick. Cycle first, digests second, in that order and never concurrently:
 * a digest composed while the recompute is still running would report a
 * half-finished pass.
 *
 * Never throws. THE STACK IS LOGGED, not just the message: an async callback
 * that rejects with a bare code is the most common way a scheduled job goes
 * quiet, and "[DAILY] tick failed: undefined" is indistinguishable from
 * silence.
 */
async function tick({ client, segments, portfolio, proposals, drafter, send, env, log, now }) {
  const at = now || new Date();
  try {
    await runDueCycle({ client, segments, portfolio, proposals, drafter, now: at, env, log });
  } catch (error) {
    log.error(`[DAILY] Cycle tick failed: ${error?.code || error?.message || 'unknown'}`,
      error?.stack || '');
  }
  try {
    const users = await digestRecipients({ client, segments, log });
    if (users.length) await runDueDigests({ client, users, now: at, env, send, log });
  } catch (error) {
    log.error(`[DAILY] Digest tick failed: ${error?.code || error?.message || 'unknown'}`,
      error?.stack || '');
  }
}

/**
 * Start the tick.
 *
 * Registered unconditionally, exactly like the opportunity refresh: with every
 * flag off it recomputes segments, decides materiality, runs the detector and
 * records the whole pass, and delivers nothing. There is no flag to keep the
 * SCHEDULER off because a segment being recomputed from live data is the
 * correct behaviour of this product; the flags gate what reaches a phone and
 * what reaches a review queue.
 *
 * @returns {{startup: object, repeating: object}|null} timers, or null if it
 *          could not be constructed. Nothing clears them: the process ending is
 *          the intended way for them to stop.
 */
function startDailyCycle({ client, env = process.env, log = console, services } = {}) {
  let segments;
  let portfolio;
  let proposals = null;
  let drafter = null;
  let send = null;
  try {
    if (services) {
      ({ segments, portfolio, proposals = null, drafter = null, send = null } = services);
    } else {
      const { createSegmentService } = require('./campaigns/segment-service');
      const { createOpportunityPortfolioService } = require('./campaigns/opportunity-portfolio');
      segments = createSegmentService({ client, env });
      portfolio = createOpportunityPortfolioService({ client, env });
      // Loaded only when the brake is off, so with the flag engaged there is no
      // model client and no proposal writer in the process at all.
      if (env.CAMPAIGN_OPPORTUNITY_PROPOSALS_ENABLED === 'true') {
        ({ draftProposals: drafter } = require('./campaigns/proposal-writer'));
        const { createProposalService } = require('./campaigns/proposal-service');
        proposals = createProposalService({ client });
      }
      const { sendDailyDigestNotifications } = require('./apns-notify');
      send = sendDailyDigestNotifications;
    }
  } catch (error) {
    log.error('[DAILY] Scheduler not started:', error?.message || 'unknown');
    return null;
  }

  const schedule = cycleSchedule(env);
  const interval = tickIntervalFrom(env);
  const digestHour = digestTarget(env);
  const now = new Date();
  log.log('[DAILY] Segmentation cycle scheduled at '
    + `${String(schedule.target.hour).padStart(2, '0')}:${String(schedule.target.minute).padStart(2, '0')} `
    + `${schedule.zone}${schedule.zoneIsDefault ? ' (default)' : ''}, next at `
    + `${nextFireAfter({ now, zone: schedule.zone, target: schedule.target }).toISOString()}. `
    + `Digests at ${String(digestHour.hour).padStart(2, '0')}:${String(digestHour.minute).padStart(2, '0')} `
    + `in each account's own zone. Digest push is `
    + `${env.DAILY_DIGEST_NOTIFICATIONS_ENABLED === 'true' ? 'ON' : 'OFF'}.`);

  // RE-ENTRANCY GUARD. A recompute of twelve segments against live data can
  // easily outlast a five-minute tick, and two overlapping passes would each
  // read the same segment, compute the same membership and race each other into
  // the same RPC. The ledger claim would stop the SECOND day being started
  // twice, but not two runs of the same claimed day inside one process. This
  // does. It is the `protect` option of a cron library, written out.
  let inFlight = false;
  let shuttingDown = false;

  const run = async () => {
    if (inFlight) {
      log.warn('[DAILY] Previous tick is still running; skipping this one.');
      return;
    }
    if (shuttingDown) return;
    inFlight = true;
    try {
      await tick({ client, segments, portfolio, proposals, drafter, send, env, log });
    } finally {
      inFlight = false;
    }
  };

  // A rejected promise from a detached async callback is the classic way a
  // scheduled job dies without a word. `run()` cannot reject — `tick()` catches
  // everything — but a future edit could make it so, and the cost of saying so
  // out loud is one line.
  const fire = () => { void run().catch(error => {
    log.error('[DAILY] Tick rejected unexpectedly:', error?.stack || error?.message || 'unknown');
  }); };

  // Ninety seconds after boot, after the opportunity refresh at sixty, so a
  // restart during the target hour catches up without competing with the jobs
  // that start in the first fifteen seconds.
  const startup = setTimeout(fire, 90 * 1000);
  const repeating = setInterval(fire, interval);
  if (typeof startup.unref === 'function') startup.unref();
  if (typeof repeating.unref === 'function') repeating.unref();

  // SIGTERM. Railway sends it on every deploy. Stop CLAIMING immediately and
  // let an in-flight pass finish: a process killed between the claim and the
  // completion leaves a `running` row that blocks the day for the whole lease,
  // and ten minutes of a blocked day is ten minutes nobody can explain. The
  // timers are cleared so nothing new starts; the current pass is awaited so
  // its ledger row is closed. Nothing here calls process.exit: Express owns
  // that, and a background job forcing an exit would cut short an in-flight
  // HTTP request.
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(startup);
    clearInterval(repeating);
    if (inFlight) log.log('[DAILY] SIGTERM received; letting the in-flight pass finish.');
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  return { startup, repeating, shutdown, isRunning: () => inFlight };
}

module.exports = { MAX_USERS, digestRecipients, startDailyCycle, tick };
