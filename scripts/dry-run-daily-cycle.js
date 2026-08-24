#!/usr/bin/env node
'use strict';

/**
 * scripts/dry-run-daily-cycle.js
 *
 * READ-ONLY, AGGREGATE-ONLY rehearsal of the whole daily cycle against LIVE
 * DATA. It executes exactly the code path the scheduler will, up to but never
 * including anything that writes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IT WRITES: NOTHING.
 *
 *   NOT segment membership. `runCycle({ dryRun: true })` never calls
 *     `segments.recompute()`, which is the only writer of
 *     `sms_campaign_segment_members` and `sms_campaign_segment_runs`. It reports
 *     what it WOULD recompute and stops. To make the movement numbers real
 *     without writing, it computes each segment's membership IN MEMORY, from
 *     the same detectors the recompute uses, and diffs it against the stored
 *     member list.
 *   NOT the run ledger. No claim is made, so running this cannot consume the
 *     day and cannot stop the real cycle firing later.
 *   NOT a proposal. The drafter is never constructed, so no model is called.
 *   NOT a notification. The digest is COMPOSED so its wording can be read, and
 *     `send` is never invoked.
 *   NOT a send gate, a consent row, or a customer message. It holds no
 *     messaging provider client at all.
 *
 * WHAT IT READS: `sms_orders`, `sms_contacts`, the campaign source tables, the
 *   saved segments and their members, and the WooCommerce catalogue. Exactly
 *   what the real pass reads.
 *
 * WHAT IT PRINTS: counts, segment keys, our own segment names, catalogue
 *   product names, and the exact notification copy. NO customer identity: no
 *   phone number, no name, no email, no order id, no message body. People are
 *   counted; people are not printed.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Usage:
 *   node scripts/dry-run-daily-cycle.js
 *   node scripts/dry-run-daily-cycle.js --json
 *   node scripts/dry-run-daily-cycle.js --at 2026-08-25T08:35:00Z
 */

require('dotenv').config();

const { supabase } = require('../db');
const { IN_CHUNK_SIZE } = require('../lib/fetch-all-rows');
const { createSegmentService } = require('../lib/campaigns/segment-service');
const {
  createOpportunityPortfolioService
} = require('../lib/campaigns/opportunity-portfolio');
const { computedSetDigest, reconcileSegmentMembership } =
  require('../lib/campaigns/segment-membership');
const { computeSegmentMembers, segmentDefinition, BUYER_COHORT_SOURCE } =
  require('../lib/campaigns/segment-definitions');
const { buildBuyerCohortFacts } = require('../lib/campaigns/buyer-cohorts');
const {
  buildSegmentationInput,
  readAuthoritativeGenerationSources
} = require('../lib/campaigns/generation-service');
const { opportunityFromFinding } = require('../lib/campaigns/opportunity-contract');
const { prepareDailyDigest, materialityThresholds, segmentMateriality } =
  require('../lib/notifications/daily-digest');
const { cycleSchedule, digestTarget, digestWeekdaysOnly, proposalFloor } =
  require('../lib/daily-cycle');
const { dueAt, localDayKey, nextFireAfter, scheduleZone } =
  require('../lib/notifications/daily-schedule');
const { effectiveTimeZoneId } = require('../lib/timezones');

const WORKSPACE_ID = 'vici';
const DB_PAGE_SIZE = 1000;
const MAX_MEMBER_ROWS = 100000;

const args = process.argv.slice(2);
const asJSON = args.includes('--json');
const atIndex = args.indexOf('--at');
const NOW = atIndex >= 0 && args[atIndex + 1] ? new Date(args[atIndex + 1]) : new Date();
if (!Number.isFinite(NOW.getTime())) {
  console.error('--at must be a parseable date.');
  process.exit(1);
}

function heading(text) {
  if (asJSON) return;
  console.log(`\n${'─'.repeat(78)}\n${text}\n${'─'.repeat(78)}`);
}

function line(text = '') {
  if (!asJSON) console.log(text);
}

/** Every member phone of one saved segment, paged. An unpaged read caps at 1000. */
async function storedMembers(segmentID) {
  const rows = [];
  for (let from = 0; from < MAX_MEMBER_ROWS; from += DB_PAGE_SIZE) {
    const { data, error } = await supabase.from('sms_campaign_segment_members')
      .select('contact_phone,membership_source,inclusion_evidence,engine_matched')
      .eq('segment_id', segmentID).eq('workspace_id', WORKSPACE_ID)
      .order('contact_phone', { ascending: true })
      .range(from, from + DB_PAGE_SIZE - 1);
    if (error) throw new Error(`member page at ${from}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < DB_PAGE_SIZE) break;
  }
  return rows;
}

async function storedOverrides(segmentID) {
  const rows = [];
  for (let from = 0; from < MAX_MEMBER_ROWS; from += DB_PAGE_SIZE) {
    const { data, error } = await supabase.from('sms_campaign_segment_overrides')
      .select('id,contact_phone,override_type,reason,created_at,revoked_at')
      .eq('segment_id', segmentID).eq('workspace_id', WORKSPACE_ID)
      .order('created_at', { ascending: true })
      .range(from, from + DB_PAGE_SIZE - 1);
    if (error) throw new Error(`override page at ${from}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < DB_PAGE_SIZE) break;
  }
  return rows;
}

/** The accounts that would receive a digest, and the zone each is scheduled in. */
async function digestRecipients(segments) {
  const users = await segments.notificationUsers();
  if (!users.length) return [];
  const zones = new Map();
  const ids = users.map(user => user.id);
  for (let index = 0; index < ids.length; index += IN_CHUNK_SIZE) {
    const chunk = ids.slice(index, index + IN_CHUNK_SIZE);
    // bounded: `chunk` is a slice capped at IN_CHUNK_SIZE (200).
    const { data, error } = await supabase.from('sms_users').select('id, timezone').in('id', chunk);
    if (error) break;
    for (const row of data || []) zones.set(String(row.id), row.timezone || null);
  }
  return users.map(user => {
    const stored = zones.get(String(user.id)) ?? null;
    return {
      ...user,
      timeZone: effectiveTimeZoneId(stored),
      // Reported separately from the resolved identifier ON PURPOSE. Both
      // resolve to the same string, and printing only the string would say
      // "Europe/London" for somebody in Miami who has simply never opened the
      // picker, which is the exact confusion this whole feature exists to
      // remove. The distinction has to survive to the screen.
      timeZoneChosen: stored !== null
    };
  });
}

/** The most recent completed cycle, if the ledger migration has been applied. */
async function previousCycle() {
  const { data, error } = await supabase.from('sms_daily_cycle_runs')
    .select('id, local_day, status, completed_at, summary')
    .eq('workspace_id', WORKSPACE_ID).eq('scope', 'cycle')
    .in('status', ['succeeded', 'partial'])
    .order('completed_at', { ascending: false }).limit(1).maybeSingle();
  if (error) return { applied: false, run: null, reason: error.code || 'unknown' };
  return { applied: true, run: data || null, reason: null };
}

async function main() {
  line('DAILY CYCLE DRY RUN');
  line(`Clock: ${NOW.toISOString()}`);
  line('READ ONLY. No recompute, no ledger claim, no proposal, no notification.');

  const segments = createSegmentService({ client: supabase, env: process.env });
  const portfolio = createOpportunityPortfolioService({ client: supabase, env: process.env });

  // ── The schedule ─────────────────────────────────────────────────────────
  heading('1. THE SCHEDULE');
  const schedule = cycleSchedule(process.env);
  const target = digestTarget(process.env);
  const weekdaysOnly = digestWeekdaysOnly(process.env);
  line(`Recompute anchor: ${String(schedule.target.hour).padStart(2, '0')}:`
    + `${String(schedule.target.minute).padStart(2, '0')} ${schedule.zone}`
    + `${schedule.zoneIsDefault ? ' (default)' : ''}`);
  line(`Next recompute:   ${nextFireAfter({ now: NOW, zone: schedule.zone, target: schedule.target }).toISOString()}`);
  line(`Digest hour:      ${String(target.hour).padStart(2, '0')}:${String(target.minute).padStart(2, '0')} `
    + `in each account's own zone${weekdaysOnly ? ', weekdays only' : ''}`);
  const cycleVerdict = dueAt({ now: NOW, zone: schedule.zone, target: schedule.target });
  line(`Cycle right now:  ${cycleVerdict.verdict} (${cycleVerdict.localDay}, `
    + `${cycleVerdict.minutesLate} minutes past the target)`);

  const ledgerState = await previousCycle();
  line(`Run ledger:       ${ledgerState.applied
    ? (ledgerState.run
      ? `last completed cycle ${ledgerState.run.local_day} (${ledgerState.run.status})`
      : 'applied, no cycle has run yet, so today would be a COLD START')
    : `NOT APPLIED (${ledgerState.reason}). Run scripts/daily-cycle-runs-migration.sql.`}`);

  line('');
  line('Flags:');
  for (const flag of [
    'DAILY_DIGEST_NOTIFICATIONS_ENABLED',
    'SEGMENT_CHANGE_NOTIFICATIONS_ENABLED',
    'CAMPAIGN_OPPORTUNITY_PROPOSALS_ENABLED',
    'CAMPAIGN_REVIEW_NOTIFICATIONS_ENABLED'
  ]) {
    line(`  ${process.env[flag] === 'true' ? 'ON ' : 'off'}  ${flag}`);
  }

  // ── What it would recompute ──────────────────────────────────────────────
  heading('2. WHAT IT WOULD RECOMPUTE');
  const listed = [];
  for (let page = 1; page <= 50; page += 1) {
    const result = await segments.list({ page, pageSize: 200, kind: 'automatic' });
    listed.push(...(result.items || []));
    if (!result.items || result.items.length < 200) break;
  }
  const active = listed.filter(entry => !entry.archivedAt);
  line(`${active.length} non-archived automatic segment(s).`);

  // ONE read of the authoritative sources, reused for every segment, exactly as
  // the real pass does. Computing membership in memory is what lets this report
  // real movement numbers without writing a single row.
  const sources = await readAuthoritativeGenerationSources({
    client: supabase, now: NOW, workspaceID: WORKSPACE_ID
  });
  const engineInput = buildSegmentationInput(sources, { now: NOW, workspaceID: WORKSPACE_ID });
  const cohortFacts = buildBuyerCohortFacts(sources, { now: NOW });

  const movements = [];
  const failures = [];
  for (const saved of active) {
    const definitionKey = saved.definition?.definitionKey || saved.key;
    try {
      const definition = segmentDefinition(definitionKey);
      if (!definition) {
        failures.push({ key: saved.key, name: saved.name, code: 'SEGMENT_DEFINITION_UNKNOWN' });
        continue;
      }
      const input = definition.source === BUYER_COHORT_SOURCE
        ? { buyerCohorts: cohortFacts }
        : engineInput;
      const computed = computeSegmentMembers(definitionKey, input, { now: NOW });
      const existing = await storedMembers(saved.id);
      const overrides = await storedOverrides(saved.id);
      const reconciled = reconcileSegmentMembership({
        existing: existing.map(row => ({
          contactPhone: row.contact_phone,
          membershipSource: row.membership_source,
          inclusionEvidence: row.inclusion_evidence,
          engineMatched: row.engine_matched
        })),
        computed,
        overrides
      });
      movements.push({
        key: saved.key,
        name: saved.name,
        previousCount: existing.length,
        memberCount: reconciled.summary.memberCount ?? reconciled.members.length,
        joinedCount: reconciled.summary.joinedCount ?? 0,
        leftCount: reconciled.summary.leftCount ?? 0,
        baseline: !saved.lastComputedAt,
        digest: computedSetDigest(computed).slice(0, 12)
      });
    } catch (error) {
      failures.push({
        key: saved.key, name: saved.name,
        code: String(error?.code || error?.message || 'internal_error').slice(0, 80)
      });
    }
  }

  const width = Math.max(...movements.map(row => row.key.length), 12);
  line('');
  line(`${'segment'.padEnd(width)}  ${'stored'.padStart(7)} ${'would be'.padStart(9)} `
    + `${'join'.padStart(5)} ${'left'.padStart(5)}  note`);
  for (const row of movements.sort((a, b) => b.memberCount - a.memberCount)) {
    line(`${row.key.padEnd(width)}  ${String(row.previousCount).padStart(7)} `
      + `${String(row.memberCount).padStart(9)} ${String(row.joinedCount).padStart(5)} `
      + `${String(row.leftCount).padStart(5)}  ${row.baseline ? 'never computed (baseline)' : ''}`);
  }
  if (failures.length) {
    line('');
    line('FAILURES (these would be reported in the digest, never rounded down):');
    for (const row of failures) line(`  ${row.key}: ${row.code}`);
  }

  // ── Materiality ──────────────────────────────────────────────────────────
  heading('3. WHAT IT WOULD CONSIDER MATERIAL');
  const thresholds = materialityThresholds(process.env);
  line(`Gate 2: delta >= ${thresholds.absoluteFloor} AND delta >= `
    + `${Math.round(thresholds.relativeFloor * 100)}% of the prior size.`);
  line(`Revenue critical (delta >= ${thresholds.criticalFloor}): `
    + `${thresholds.criticalSegments.join(', ')}`);
  line('');
  // Computed per segment rather than read off the digest, because the digest
  // short-circuits on cold start, a bulk import or the circuit breaker and
  // returns an empty list. The point of this section is to show the verdict for
  // every segment even on a day when the whole digest is suppressed.
  const verdicts = movements
    .map(row => ({ ...row, ...segmentMateriality(row, thresholds) }))
    .sort((a, b) => b.delta - a.delta || a.key.localeCompare(b.key));
  const nameWidth = Math.max(...verdicts.map(row => row.key.length), 12);
  for (const row of verdicts) {
    line(`  ${row.material ? 'MATERIAL' : '        '}  ${row.key.padEnd(nameWidth)}  `
      + `delta ${String(row.delta).padStart(4)} of ${String(row.required).padStart(4)} required  `
      + `${row.reason}`);
  }

  // The comparison that makes the threshold argument concrete rather than
  // asserted. `SEGMENT_CHANGE_NOTIFICATION_MIN_DELTA` defaults to 1, and one is
  // the right floor for the push somebody gets after pressing Recompute. Run
  // daily across twelve overlapping segments it is a push every single morning.
  const naive = movements.filter(row => !row.baseline && (row.joinedCount + row.leftCount) >= 1);
  line('');
  line(`At a flat threshold of 1, ${naive.length} of ${movements.length} segment(s) would count `
    + `as material today, totalling ${naive.reduce((sum, row) => sum + row.joinedCount + row.leftCount, 0)} `
    + 'movements, and a push would fire.');
  line(`At the conjoined gates, ${verdicts.filter(row => row.material).length} do.`);

  // ── Opportunities and proposals ──────────────────────────────────────────
  heading('4. WHAT PROPOSALS IT WOULD DRAFT');
  const floor = proposalFloor(process.env);
  let opportunities = null;
  try {
    opportunities = await portfolio.refreshNow({ now: NOW });
  } catch (error) {
    line(`Opportunity refresh FAILED: ${error?.code || error?.message}`);
  }
  if (opportunities) {
    line(`${opportunities.findings.length} finding(s), `
      + `${opportunities.refusals.length} refused to size. Actionable floor: ${floor} people.`);
    line('');
    for (const finding of opportunities.findings) {
      const adapted = opportunityFromFinding(finding, {
        detectorVersion: opportunities.detectorVersion,
        detectedAt: opportunities.computedAt
      });
      const population = Number(finding.population || 0);
      let verdict;
      if (!adapted.ok) verdict = `skipped: ${adapted.reason}`;
      else if (population < floor) verdict = 'skipped: below the actionable floor';
      else verdict = `WOULD DRAFT proposals as kind "${adapted.opportunity.kind}"`;
      line(`  ${String(population).padStart(5)}  ${finding.key.padEnd(38)}  ${verdict}`);
    }
    line('');
    line(process.env.CAMPAIGN_OPPORTUNITY_PROPOSALS_ENABLED === 'true'
      ? 'CAMPAIGN_OPPORTUNITY_PROPOSALS_ENABLED is ON, so the real pass would draft and save.'
      : 'CAMPAIGN_OPPORTUNITY_PROPOSALS_ENABLED is off, so the real pass would draft nothing.');
  }

  // ── The digest ───────────────────────────────────────────────────────────
  heading('5. WHAT THE DIGEST WOULD SAY');
  const recipients = await digestRecipients(segments);
  if (!recipients.length) {
    line('No eligible recipient: an active Owner or Admin holding campaigns.manage is required.');
  }
  const unchosen = recipients.filter(user => !user.timeZoneChosen).length;
  if (unchosen) {
    line(`${unchosen} of ${recipients.length} eligible account(s) have never chosen a timezone, `
      + 'so their digest is scheduled in the workspace default. Anybody who is not in that zone '
      + 'will receive it at the wrong hour until they set their own on Account.');
    line('');
  }
  for (const user of recipients) {
    const zone = scheduleZone(user.timeZone);
    const verdict = dueAt({
      now: NOW, zone: zone.id, target, lastClaimedDay: null,
      catchUpMinutes: 180, weekdaysOnly
    });
    line(`Account ${user.id} (${user.role}, ${zone.id}`
      + `${user.timeZoneChosen ? '' : ', NEVER CHOSEN so the workspace default is used'})`);
    line(`  right now: ${verdict.verdict} on ${verdict.localDay} (${verdict.weekday}), `
      + `${verdict.minutesLate} minutes past ${String(target.hour).padStart(2, '0')}:`
      + `${String(target.minute).padStart(2, '0')} local`);
    line(`  next fire: ${nextFireAfter({ now: NOW, zone: zone.id, target }).toISOString()}`);
  }

  const composed = prepareDailyDigest({
    users: recipients.length ? recipients : [
      { id: 0, role: 'owner', isActive: true, canManageCampaigns: true }
    ],
    segments: movements,
    proposalsDrafted: 0,
    failures,
    coldStart: ledgerState.applied && !ledgerState.run,
    localDay: localDayKey(NOW, schedule.zone),
    env: process.env,
    generatedAt: NOW
  });

  line('');
  if (!composed.send) {
    line(`NOTHING WOULD BE SENT. Reason: ${composed.reason}`);
    line('Silence is the designed outcome when nothing passed the gates. A daily');
    line('"no changes" push is 100 per cent noise by construction.');
  } else {
    line('IT WOULD SEND:');
    line(`  title: ${composed.title}`);
    line(`  body:  ${composed.body}`);
    line(`  level: ${composed.notifications[0].payload.aps['interruption-level']} `
      + `(relevance ${composed.notifications[0].payload.aps['relevance-score']}, no badge)`);
    line(`  to:    ${composed.notifications.map(row => `account ${row.userID}`).join(', ')}`);
    line(`  collapse ids: ${composed.notifications.map(row => row.collapseID).join(', ')}`);
    line(process.env.DAILY_DIGEST_NOTIFICATIONS_ENABLED === 'true'
      ? '  DAILY_DIGEST_NOTIFICATIONS_ENABLED is ON, so this would reach a phone.'
      : '  DAILY_DIGEST_NOTIFICATIONS_ENABLED is off, so nothing would reach a phone.');
  }

  heading('NOTHING WAS WRITTEN');
  line('No segment membership, no run ledger row, no proposal, no notification.');

  if (asJSON) {
    console.log(JSON.stringify({
      at: NOW.toISOString(),
      schedule: { ...schedule, digest: target, weekdaysOnly },
      ledgerApplied: ledgerState.applied,
      coldStart: ledgerState.applied && !ledgerState.run,
      segments: movements,
      failures,
      materiality: { thresholds, considered: verdicts },
      findings: (opportunities?.findings || []).map(finding => ({
        key: finding.key, population: finding.population
      })),
      digest: composed.send
        ? { send: true, title: composed.title, body: composed.body }
        : { send: false, reason: composed.reason }
    }, null, 2));
  }
}

main().catch(error => {
  console.error('\nDRY RUN FAILED:', error?.message || error);
  console.error(error?.stack || '');
  process.exit(1);
});
