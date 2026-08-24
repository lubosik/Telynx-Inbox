'use strict';
/**
 * lib/daily-cycle.js — the clock that makes segmentation automatic.
 *
 * THE GAP THIS CLOSES
 *   Twelve segments are live and hold about sixteen hundred memberships. The
 *   opportunity detector refreshes every six hours. The delivery worker ticks
 *   every two minutes when it is enabled. Segment RECOMPUTE and proposal
 *   generation were on demand only: new orders arrived and nobody moved between
 *   groups until a person opened the app and pressed a button. This runs that
 *   pass once a day, on its own, and says what changed.
 *
 * WHAT ONE CYCLE DOES, IN ORDER
 *   1. recompute every non-archived AUTOMATIC segment from live data
 *   2. record which of those movements are material
 *   3. refresh the portfolio opportunity detector
 *   4. draft proposals for the findings that are significant
 *   5. record everything in the ledger, so the digest can report it later
 *
 *   The digest is deliberately NOT step six. It runs on its own schedule, per
 *   person, in that person's own time zone, and reads the ledger row this pass
 *   wrote. See `runDueDigests()`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT FAILS LOUDLY IN THE LOG AND QUIETLY TO THE USER
 *
 *   Every segment recompute is wrapped individually. A throw records the
 *   segment key and an error CODE and the pass moves to the next segment, so
 *   one segment with an invalid saved rule cannot stop the other eleven. There
 *   is no half-update: `recompute()` applies its result through a single RPC,
 *   so a throw before that call leaves that segment's membership exactly as it
 *   was, and a throw after it means the write landed and only the bookkeeping
 *   did not.
 *
 *   A pass with any failure is recorded `partial` rather than `succeeded`, the
 *   failures travel through to the digest, and the digest SAYS SO. It never
 *   reports a clean run on a day when something threw. The one thing this
 *   feature must not do is tell an owner everything is fine while a detector is
 *   broken.
 *
 *   Nothing here throws out to the caller. It runs inside a process that also
 *   carries the inbox, the dialler and order SMS, and a customer-base analysis
 *   may never interrupt any of those.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHICH CODE PATHS WRITE, AND WHICH DO NOT
 *
 *   WRITES, and they are real production writes:
 *     * `segments.recompute()` writes `sms_campaign_segment_members` and
 *       `sms_campaign_segment_runs` through
 *       `apply_sms_campaign_segment_recompute`.
 *     * the run ledger, `sms_daily_cycle_runs`.
 *     * `proposals.saveBatch()`, and ONLY when
 *       CAMPAIGN_OPPORTUNITY_PROPOSALS_ENABLED is exactly "true".
 *     * the APNs push itself, and ONLY when DAILY_DIGEST_NOTIFICATIONS_ENABLED
 *       is exactly "true".
 *
 *   DOES NOT WRITE:
 *     * the opportunity detector refresh. It has no table by design.
 *     * everything, when `dryRun: true` is passed. In that mode no recompute is
 *       called, no ledger row is claimed, no proposal is saved and no push is
 *       prepared for delivery. `scripts/dry-run-daily-cycle.js` is the only
 *       caller that sets it and it is how this was validated against live data
 *       before it shipped.
 *
 *   NOTHING HERE TOUCHES A SEND GATE. It cannot enable delivery, cannot write
 *   consent, cannot schedule a customer message and holds no messaging provider
 *   client. An accepted proposal still produces an ordinary campaign `draft`
 *   through the existing path and is subject to every brake after it.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TIME ZONES: DISPLAY AND DELIVERY TIMING, NEVER QUIET HOURS
 *
 *   The cycle is anchored on DAILY_CYCLE_TIMEZONE, an operational choice about
 *   when our own recompute runs, like the hour a backup starts. The digest is
 *   delivered at a local hour in each ACCOUNT's own `sms_users.timezone`,
 *   because the two operators are five hours apart and nine in the morning has
 *   to mean nine in the morning for each of them.
 *
 *   Campaign quiet hours are a different question with a different answer:
 *   when may a CUSTOMER be texted. They are enforced in SQL inside
 *   `claim_sms_campaign_batch` against
 *   `sms_campaign_settings.business_timezone`, and nothing in this file, in
 *   `lib/notifications/`, or in `sms_daily_cycle_runs` is read by that
 *   predicate, by the delivery worker, or by any send gate.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * FEATURE FLAGS, AND WHAT "RUN WITH THEM OFF" MEANS
 *   SEGMENT_CHANGE_NOTIFICATIONS_ENABLED    off. Recomputes still run and
 *                                           materiality is still decided and
 *                                           logged; only the push is held.
 *   CAMPAIGN_OPPORTUNITY_PROPOSALS_ENABLED  off. The detector still runs, the
 *                                           adapter still decides which
 *                                           findings would produce proposals,
 *                                           and the count is recorded; only the
 *                                           drafting and the save are held.
 *   DAILY_DIGEST_NOTIFICATIONS_ENABLED      off by default, this feature's own
 *                                           flag, read as `=== 'true'`. The
 *                                           digest is still composed and its
 *                                           decision is still recorded; only
 *                                           the delivery is held.
 *
 *   With all three off the whole cycle runs and is fully observable in the log
 *   and in the ledger. Nothing reaches a phone.
 */

const {
  DEFAULT_CATCHUP_MINUTES,
  dueAt,
  localDayKey,
  nextFireAfter,
  scheduleZone,
  targetTime,
  tickIntervalFrom
} = require('./notifications/daily-schedule');
const { prepareDailyDigest } = require('./notifications/daily-digest');
const ledger = require('./notifications/run-ledger');

const WORKSPACE_ID = 'vici';
const DB_PAGE_SIZE = 200;
const MAX_SEGMENT_PAGES = 50;

/** The recompute anchor and the digest hour, each with a stated default. */
const DEFAULT_CYCLE_HOUR = 6;
/** 08:30 in the recipient's own zone, per research D3. */
const DEFAULT_DIGEST_HOUR = 8;
const DEFAULT_DIGEST_MINUTE = 30;

/**
 * How significant a finding must be before the cycle would draft proposals for
 * it. `COHORT_CALIBRATION.actionableFloorPeople` is 100 and is the size below
 * which a cohort's own observed rate is consistent with almost any true rate.
 * Drafting campaign copy for a population smaller than that is asking a model
 * to write about a group nobody can measure.
 */
const DEFAULT_PROPOSAL_FLOOR_PEOPLE = 100;

function flagOn(env, name) {
  return env?.[name] === 'true';
}

function errorCode(error) {
  return String(error?.code || error?.name || 'internal_error').slice(0, 80);
}

/** The cycle's own anchor zone and hour. Never the business time zone. */
function cycleSchedule(env = process.env) {
  const zone = scheduleZone(env?.DAILY_CYCLE_TIMEZONE);
  return {
    zone: zone.id,
    zoneIsDefault: zone.isDefault,
    target: targetTime(env?.DAILY_CYCLE_HOUR, env?.DAILY_CYCLE_MINUTE, { defaultHour: DEFAULT_CYCLE_HOUR })
  };
}

/** The digest hour, applied in each ACCOUNT's own zone. */
function digestTarget(env = process.env) {
  return targetTime(env?.DAILY_DIGEST_HOUR, env?.DAILY_DIGEST_MINUTE, {
    defaultHour: DEFAULT_DIGEST_HOUR, defaultMinute: DEFAULT_DIGEST_MINUTE
  });
}

/**
 * Monday to Friday by default, per research D3. Set
 * DAILY_DIGEST_WEEKDAYS_ONLY=false to include the weekend; anything else,
 * including unset, keeps weekdays only.
 */
function digestWeekdaysOnly(env = process.env) {
  return env?.DAILY_DIGEST_WEEKDAYS_ONLY !== 'false';
}

function proposalFloor(env = process.env) {
  const parsed = Number.parseInt(env?.DAILY_CYCLE_PROPOSAL_FLOOR_PEOPLE, 10);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_PROPOSAL_FLOOR_PEOPLE;
  return parsed;
}

/**
 * Every non-archived automatic segment, paged.
 *
 * An unpaged read caps silently at 1000 rows. There are twelve today and this
 * pages anyway, because the day somebody saves a hundred described segments is
 * not the day to discover the ceiling.
 */
async function readAutomaticSegments(segments) {
  const items = [];
  for (let page = 1; page <= MAX_SEGMENT_PAGES; page += 1) {
    const result = await segments.list({ page, pageSize: DB_PAGE_SIZE, kind: 'automatic' });
    items.push(...(result.items || []));
    if (!result.items || result.items.length < DB_PAGE_SIZE) break;
  }
  return items.filter(segment => !segment.archivedAt);
}

/**
 * Recompute every automatic segment, one at a time, and never let one failure
 * become twelve.
 *
 * Sequential rather than concurrent on purpose. Each recompute reads every paid
 * order, every contact and the WooCommerce catalogue through the shared source
 * reader; twelve of those in parallel is twelve times the provider load for no
 * benefit, and the whole pass has a whole day to finish.
 */
async function recomputeAll({ segments, actor, now, dryRun, log }) {
  const list = await readAutomaticSegments(segments);
  const results = [];
  const failures = [];

  for (const segment of list) {
    const previousCount = Number(segment.memberCount || 0);
    // COLD START, per segment. A segment that has never been computed has no
    // prior state, so every member of it will look like an arrival. Recorded
    // and excluded from materiality rather than reported: without this the
    // owner's first digest is "487 people moved into 12 segments" and his first
    // impression of the feature is that it is broken. Research S5.4.
    const baseline = !segment.lastComputedAt;
    if (dryRun) {
      // A dry run may not write segment membership. It reports what it would
      // recompute and stops there; see the header.
      results.push({
        key: segment.key,
        name: segment.name,
        previousCount,
        memberCount: previousCount,
        joinedCount: 0,
        leftCount: 0,
        replayed: null,
        baseline,
        wouldRecompute: true
      });
      continue;
    }
    try {
      const outcome = await segments.recompute(segment.id, actor, { now });
      results.push({
        key: segment.key,
        name: segment.name,
        previousCount,
        memberCount: Number(outcome.run?.memberCount || 0),
        joinedCount: Number(outcome.run?.joinedCount || 0),
        leftCount: Number(outcome.run?.leftCount || 0),
        replayed: outcome.run?.replayed === true,
        baseline,
        // The per-segment verdict from lib/campaigns/segment-membership.js,
        // kept alongside the digest's own stricter one so the two can be
        // compared in the ledger rather than only inferred.
        materialPerSegment: outcome.material === true
      });
    } catch (error) {
      const code = errorCode(error);
      // LOUD. The whole point of the pass is that somebody finds out.
      // LOUD, and with the stack, because an async callback that rejects
      // quietly is the most common way a scheduled job goes silent. The stack
      // goes to the SERVICE LOG only; nothing about it reaches a person.
      log.error(`[DAILY] Recompute failed for segment ${segment.key}: ${code}`,
        error?.stack || error?.message || '');
      failures.push({ key: segment.key, name: segment.name, code });
    }
  }

  return { results, failures, considered: list.length };
}

/**
 * Refresh the portfolio detector and decide which findings are significant.
 *
 * Read-only. It has no table by design, so this cannot half-write anything.
 * The significance decision runs whether or not the proposal flag is on, so the
 * cycle is observable with the brake engaged.
 */
async function detectOpportunities({ portfolio, env, log }) {
  const { opportunityFromFinding } = require('./campaigns/opportunity-contract');
  const floor = proposalFloor(env);
  try {
    const payload = await portfolio.refreshNow({ now: new Date() });
    const findings = payload?.findings || [];
    const significant = [];
    const skipped = [];
    for (const finding of findings) {
      const population = Number(finding?.population || 0);
      const adapted = opportunityFromFinding(finding, {
        detectorVersion: payload?.detectorVersion || null,
        detectedAt: payload?.computedAt || null
      });
      if (!adapted.ok) {
        skipped.push({ key: String(finding?.key || 'unknown'), reason: adapted.reason });
        continue;
      }
      if (population < floor) {
        skipped.push({ key: String(finding.key), reason: 'below_actionable_floor', population });
        continue;
      }
      significant.push({ key: String(finding.key), population, opportunity: adapted.opportunity });
    }
    return {
      available: true,
      findingCount: findings.length,
      refusalCount: (payload?.refusals || []).length,
      // The size of the customer base this pass saw. Compared against the
      // previous pass to detect a bulk import, which must never masquerade as
      // organic customer movement. Research S5.4.
      customerCount: Number(payload?.coverage?.customers || 0),
      buyerCount: Number(payload?.coverage?.buyers || 0),
      significant,
      skipped,
      floor
    };
  } catch (error) {
    const code = errorCode(error);
    log.error(`[DAILY] Opportunity refresh failed: ${code}`);
    return {
      available: false, findingCount: 0, refusalCount: 0,
      customerCount: null, buyerCount: null,
      significant: [], skipped: [], floor, code
    };
  }
}

/**
 * Draft and save proposals for the significant findings.
 *
 * HELD BY THE FLAG. With CAMPAIGN_OPPORTUNITY_PROPOSALS_ENABLED off this
 * returns the count it WOULD have drafted and does nothing else, so the number
 * is visible in the ledger and in the log without a model call, without a
 * write, and without anything reaching a review queue.
 *
 * A proposal is not a campaign. Accepting one, later, by a named human, creates
 * an ordinary campaign draft and nothing more.
 */
async function draftProposalsFor({ opportunities, proposals, drafter, env, dryRun, log }) {
  const enabled = flagOn(env, 'CAMPAIGN_OPPORTUNITY_PROPOSALS_ENABLED');
  if (!enabled || dryRun || !proposals || !drafter) {
    return {
      drafted: 0,
      saved: 0,
      wouldDraft: opportunities.length,
      disabled: !enabled,
      dryRun: dryRun === true
    };
  }

  let drafted = 0;
  let saved = 0;
  const failures = [];
  for (const entry of opportunities) {
    try {
      const result = await drafter({
        opportunity: entry.opportunity,
        opportunitySource: 'detector'
      });
      drafted += (result.proposals || []).length;
      const batch = await proposals.saveBatch(result.proposals, { model: result.model });
      saved += (batch.saved || []).length;
    } catch (error) {
      const code = errorCode(error);
      log.error(`[DAILY] Proposal drafting failed for ${entry.key}: ${code}`);
      failures.push({ key: entry.key, code });
    }
  }
  return { drafted, saved, wouldDraft: opportunities.length, disabled: false, dryRun: false, failures };
}

/**
 * One whole cycle. Returns a summary; never throws.
 *
 * @param {object} options
 * @param {object} options.segments   segment service
 * @param {object} options.portfolio  opportunity portfolio service
 * @param {object} [options.proposals] proposal service
 * @param {Function} [options.drafter] proposal drafter
 * @param {boolean} [options.dryRun]  read only, writes nothing at all
 */
async function runCycle({
  segments,
  portfolio,
  proposals = null,
  drafter = null,
  actor = { id: null, displayName: 'Daily cycle' },
  now = new Date(),
  env = process.env,
  dryRun = false,
  previousCycle = null,
  log = console
} = {}) {
  const startedAt = Date.now();
  const recomputed = await recomputeAll({ segments, actor, now, dryRun, log });
  const opportunities = await detectOpportunities({ portfolio, env, log });
  const proposalOutcome = await draftProposalsFor({
    opportunities: opportunities.significant, proposals, drafter, env, dryRun, log
  });

  const failed = recomputed.failures.length > 0 || opportunities.available === false;
  const previousSummary = previousCycle?.summary || null;
  const previousCustomerCount = Number.isFinite(Number(previousSummary?.customerCount))
    ? Number(previousSummary.customerCount)
    : null;
  const summary = {
    dryRun: dryRun === true,
    // COLD START for the whole pass: no completed cycle has ever run, so there
    // is nothing to compare today against and every number is a baseline.
    coldStart: !previousCycle,
    customerCount: opportunities.customerCount,
    previousCustomerCount,
    segmentsConsidered: recomputed.considered,
    segmentsRecomputed: recomputed.results.length,
    segments: recomputed.results.map(entry => ({
      key: entry.key,
      name: entry.name,
      previousCount: entry.previousCount,
      memberCount: entry.memberCount,
      joinedCount: entry.joinedCount,
      leftCount: entry.leftCount,
      baseline: entry.baseline === true
    })),
    failures: recomputed.failures,
    opportunities: {
      available: opportunities.available,
      findings: opportunities.findingCount,
      refusals: opportunities.refusalCount,
      significant: opportunities.significant.map(entry => ({
        key: entry.key, population: entry.population
      })),
      skipped: opportunities.skipped,
      floor: opportunities.floor,
      ...(opportunities.code ? { code: opportunities.code } : {})
    },
    proposals: proposalOutcome,
    durationMs: Date.now() - startedAt
  };

  return { status: failed ? 'partial' : 'succeeded', summary };
}

/**
 * The tick's question for the cycle: is it due, and if so, run it once.
 *
 * The CLAIM is what makes this idempotent. A redeploy, a second instance during
 * a rolling deploy, and a manual run on the same day all lose the same unique
 * constraint and are told `already_claimed`. See lib/notifications/run-ledger.js.
 */
async function runDueCycle({
  client, segments, portfolio, proposals, drafter,
  now = new Date(), env = process.env, log = console
} = {}) {
  const schedule = cycleSchedule(env);
  const last = await ledger.lastClaimedDay({ client, scope: 'cycle', scopeKey: 'workspace' });
  if (!last.available && last.reason === 'not_ready') return { ran: false, reason: 'not_ready' };

  // The RECOMPUTE runs every day including the weekend. Only the DIGEST is
  // weekdays only: membership that is two days stale on a Monday morning is a
  // worse product than a notification nobody reads on a Sunday.
  const verdict = dueAt({
    now, zone: schedule.zone, target: schedule.target, lastClaimedDay: last.localDay
  });
  if (verdict.verdict === 'waiting' || verdict.verdict === 'done') {
    return { ran: false, reason: verdict.verdict, localDay: verdict.localDay };
  }

  const claimed = await ledger.claim({
    client, scope: 'cycle', scopeKey: 'workspace',
    localDay: verdict.localDay, timeZone: schedule.zone, now, env
  });
  if (!claimed.claimed) return { ran: false, reason: claimed.reason, localDay: verdict.localDay };

  if (verdict.verdict === 'skip') {
    // The process was down over the target hour and it is now too late for a
    // summary of this morning to be useful. The day is recorded as missed
    // rather than left as a hole that looks like a bug.
    log.log(`[DAILY] Cycle for ${verdict.localDay} skipped: ${verdict.minutesLate} minutes past the target.`);
    await ledger.complete({
      client, id: claimed.id, status: 'skipped', now,
      summary: { reason: 'too_late', minutesLate: verdict.minutesLate }
    });
    return { ran: false, reason: 'too_late', localDay: verdict.localDay };
  }

  log.log(`[DAILY] Cycle starting for ${verdict.localDay} (${schedule.zone})`
    + `${claimed.takenOver ? ', taking over an abandoned claim' : ''}.`);

  // The previous completed pass, so this one can tell a cold start from a
  // normal day and a bulk import from customer behaviour. Read with a wide
  // window: "has a cycle EVER completed" is a different question from "did one
  // complete this morning", and only the second is time-bounded.
  const previous = await ledger.latestCycle({
    client, now, maxAgeMs: 365 * 24 * 60 * 60 * 1000
  });

  let outcome;
  try {
    outcome = await runCycle({
      segments, portfolio, proposals, drafter, now, env, log,
      previousCycle: previous.run || null
    });
  } catch (error) {
    // runCycle is written not to throw. If it ever does, the claim must still
    // be closed or the stale-claim path is the only thing that frees the day.
    const code = errorCode(error);
    log.error(`[DAILY] Cycle threw: ${code}`);
    await ledger.complete({ client, id: claimed.id, status: 'failed', now, error: code, summary: {} });
    return { ran: false, reason: 'threw', code, localDay: verdict.localDay };
  }

  await ledger.complete({
    client, id: claimed.id, status: outcome.status, summary: outcome.summary, now
  });
  const s = outcome.summary;
  log.log(`[DAILY] Cycle ${outcome.status} for ${verdict.localDay}: `
    + `${s.segmentsRecomputed}/${s.segmentsConsidered} segments recomputed, `
    + `${s.failures.length} failed, ${s.opportunities.findings} findings, `
    + `${s.opportunities.significant.length} significant, `
    + `${s.proposals.disabled ? `${s.proposals.wouldDraft} proposals held by the flag` : `${s.proposals.saved} proposals saved`}.`);
  return { ran: true, status: outcome.status, summary: s, localDay: verdict.localDay };
}

/**
 * The per-account digest.
 *
 * Each eligible account is scheduled in its OWN zone, so 08:30 means 08:30 in
 * London and 08:30 in New York and the two fire hours apart on the same UTC
 * day. Each has its own claim keyed on its own local day, so one person
 * receiving theirs cannot consume the other's.
 *
 * NOTE ON THE FIVE-HOUR GAP, which is a trap and not a constant. The UK and the
 * United States change clocks on different dates, so for two to three weeks in
 * March and about a week around the end of October the London-to-New-York gap
 * is four hours, not five. Nothing here ever computes an offset and reuses it:
 * every question is asked of `Intl` at the instant it is asked, against the
 * stored IANA identifier. Code that cached an offset would be an hour wrong for
 * several weeks a year and would look like an intermittent bug.
 *
 * It reports the most recent COMPLETED cycle and refuses to invent one. If no
 * cycle has finished recently the digest does not claim the day at all: it
 * waits, and the tick asks again. Once it is too late for the summary to be
 * useful the day is claimed as `skipped` AND LOGGED, which is a record rather
 * than a hole.
 *
 * Weekdays only by default, per research D3. The recompute still runs every
 * day: it is the notification that is Monday to Friday, not the arithmetic.
 */
async function runDueDigests({
  client, users = [], now = new Date(), env = process.env,
  send = null, log = console
} = {}) {
  const target = digestTarget(env);
  const weekdaysOnly = digestWeekdaysOnly(env);
  const enabled = flagOn(env, 'DAILY_DIGEST_NOTIFICATIONS_ENABLED');
  const outcomes = [];

  const cycle = await ledger.latestCycle({ client, now });
  if (!cycle.available && cycle.reason === 'not_ready') return { ran: 0, outcomes, reason: 'not_ready' };

  for (const user of users) {
    const zone = scheduleZone(user.timeZone);
    const history = await ledger.recentDigests({ client, scopeKey: user.id, limit: 7 });
    if (!history.available && history.reason === 'not_ready') {
      return { ran: 0, outcomes, reason: 'not_ready' };
    }
    const lastDay = history.runs[0]?.local_day || null;

    const verdict = dueAt({
      now, zone: zone.id, target, lastClaimedDay: lastDay,
      catchUpMinutes: DEFAULT_CATCHUP_MINUTES, weekdaysOnly
    });
    if (['waiting', 'done', 'off_day'].includes(verdict.verdict)) {
      outcomes.push({ userID: String(user.id), reason: verdict.verdict });
      continue;
    }

    // No cycle to report yet. Do NOT claim: the cycle may still finish inside
    // the catch-up window, and claiming here would burn the person's day.
    if (verdict.verdict === 'run' && !cycle.run) {
      outcomes.push({ userID: String(user.id), reason: 'waiting_for_cycle' });
      continue;
    }

    // THE CLAIM. Everything expensive happens inside it, so the composition
    // work is done once per person per local day however many ticks land on it.
    const claimed = await ledger.claim({
      client, scope: 'digest', scopeKey: user.id,
      localDay: verdict.localDay, timeZone: zone.id, now, env
    });
    if (!claimed.claimed) {
      outcomes.push({ userID: String(user.id), reason: claimed.reason });
      continue;
    }

    if (verdict.verdict === 'skip' || !cycle.run) {
      const skipReason = cycle.run ? 'too_late' : 'no_recent_cycle';
      // LOGGED. A service that was down all morning must not fire a stale 08:30
      // summary at four in the afternoon, and the skip has to be visible or it
      // looks like the scheduler simply stopped.
      log.log(`[DAILY] Digest for account ${user.id} (${zone.id}, ${verdict.localDay}) `
        + `skipped: ${skipReason}, ${verdict.minutesLate} minutes past the target.`);
      await ledger.complete({
        client, id: claimed.id, status: 'skipped', now,
        summary: { reason: skipReason, minutesLate: verdict.minutesLate }
      });
      outcomes.push({ userID: String(user.id), reason: skipReason });
      continue;
    }

    const cycleSummary = cycle.run.summary || {};
    // GATE 3's history. Headline hashes and yesterday's directions, from this
    // account's own recent digests. Only rows that actually SENT count: a day
    // suppressed for being too diffuse never told anybody anything, so it
    // cannot make tomorrow's news stale.
    const sentRuns = history.runs.filter(row => row.summary?.silent === false);
    const recentHashes = sentRuns.map(row => row.summary?.headlineHash).filter(Boolean);
    const recentDirections = sentRuns[0]?.summary?.directions || [];

    let digest;
    try {
      digest = prepareDailyDigest({
        users: [user],
        segments: cycleSummary.segments || [],
        proposalsDrafted: Number(cycleSummary.proposals?.saved || 0),
        failures: cycleSummary.failures || [],
        coldStart: cycleSummary.coldStart === true,
        customerCount: cycleSummary.customerCount,
        previousCustomerCount: cycleSummary.previousCustomerCount,
        recentHashes,
        recentDirections,
        localDay: verdict.localDay,
        env,
        generatedAt: now
      });
    } catch (error) {
      // Composing the digest is pure and is not supposed to throw. If it does,
      // the day is closed as failed rather than left claimed, and NOTHING is
      // sent: a half-composed summary is worse than none.
      const code = errorCode(error);
      log.error(`[DAILY] Digest composition threw for account ${user.id}: ${code}`,
        error?.stack || '');
      await ledger.complete({ client, id: claimed.id, status: 'failed', now, error: code });
      outcomes.push({ userID: String(user.id), reason: 'compose_failed', code });
      continue;
    }

    if (!digest.send) {
      // SILENCE IS MANDATORY, NOT OPTIONAL. Recorded so "why did I get nothing
      // today" has an answer, and nothing is sent. The circuit breaker is
      // logged at error level because it is a signal to a DEVELOPER that a
      // threshold is mistuned or that a data event happened, not news for an
      // owner.
      if (digest.reason === 'circuit_breaker') {
        log.error(`[DAILY] Circuit breaker: ${digest.materialCount} of `
          + `${digest.consideredCount} segments reported material change in one run. `
          + 'Suppressed. That is a bug or a data event, not twelve business developments.');
      } else {
        log.log(`[DAILY] Digest for account ${user.id} (${zone.id}, ${verdict.localDay}): `
          + `silent, ${digest.reason}.`);
      }
      await ledger.complete({
        client, id: claimed.id, status: 'succeeded', now,
        summary: {
          sent: 0, silent: true, reason: digest.reason, cycleRunID: String(cycle.run.id)
        }
      });
      outcomes.push({ userID: String(user.id), reason: digest.reason, sent: 0 });
      continue;
    }

    let sent = 0;
    let disabled = !enabled;
    if (enabled && typeof send === 'function') {
      try {
        const result = await send(digest.notifications, { dryRun: false });
        sent = Number(result?.sent || 0);
        disabled = result?.disabled === true;
      } catch (error) {
        log.error(`[DAILY] Digest delivery failed: ${errorCode(error)}`, error?.stack || '');
      }
    }

    await ledger.complete({
      client, id: claimed.id, status: 'succeeded', now,
      summary: {
        sent,
        disabled,
        silent: false,
        title: digest.title,
        body: digest.body,
        headlineHash: digest.headlineHash,
        directions: digest.directions,
        materialSegments: digest.material.map(entry => ({ key: entry.key, delta: entry.delta })),
        cycleRunID: String(cycle.run.id)
      }
    });
    log.log(`[DAILY] Digest for account ${user.id} (${zone.id}, ${verdict.localDay}): `
      + `${digest.material.length} material, ${disabled ? 'held by the flag' : `${sent} delivered`}.`);
    outcomes.push({ userID: String(user.id), sent, disabled, reason: null, title: digest.title });
  }

  return { ran: outcomes.filter(entry => entry.sent !== undefined).length, outcomes };
}

module.exports = {
  DEFAULT_CYCLE_HOUR,
  DEFAULT_DIGEST_HOUR,
  DEFAULT_PROPOSAL_FLOOR_PEOPLE,
  WORKSPACE_ID,
  DEFAULT_DIGEST_MINUTE,
  cycleSchedule,
  detectOpportunities,
  digestTarget,
  digestWeekdaysOnly,
  draftProposalsFor,
  flagOn,
  nextFireAfter,
  localDayKey,
  proposalFloor,
  readAutomaticSegments,
  recomputeAll,
  runCycle,
  runDueCycle,
  runDueDigests,
  tickIntervalFrom
};
