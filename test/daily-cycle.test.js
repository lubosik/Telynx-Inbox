'use strict';
/**
 * The daily cycle: idempotency, partial failure, and the flags.
 *
 * THREE THINGS ARE BEING PROTECTED, and each is a specific way this feature
 * could ship broken.
 *
 *   1. IDEMPOTENCY IS A DATABASE CONSTRAINT, NOT APPLICATION LOGIC. A redeploy,
 *      a second instance during a rolling deploy, and a manual run on the same
 *      day must all lose the same UNIQUE constraint. The fake below enforces
 *      that constraint the way Postgres does, with a 23505, so the tests
 *      exercise the real code path and not a mock of the decision.
 *
 *   2. IT FAILS LOUDLY IN THE LOG AND QUIETLY TO THE USER. One segment throwing
 *      must not stop the other eleven, must not half-update anything, and must
 *      not let the digest report a clean run.
 *
 *   3. THE FLAGS GATE DELIVERY, NOT ARITHMETIC. With every flag off the pass
 *      must still recompute, still decide materiality, and still record what it
 *      would have done. A scheduler that is invisible when its flags are off is
 *      a scheduler nobody can verify before turning it on.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ledger = require('../lib/notifications/run-ledger');
const {
  cycleSchedule,
  digestTarget,
  digestWeekdaysOnly,
  recomputeAll,
  runCycle,
  runDueCycle,
  runDueDigests
} = require('../lib/daily-cycle');

const SILENT = { log() {}, warn() {}, error() {} };

/**
 * A Supabase stand-in for `sms_daily_cycle_runs` that enforces the UNIQUE
 * constraint exactly as Postgres does.
 *
 * The whole point of the ledger is that the constraint decides, so a fake that
 * merely remembered what it had been asked would be testing the test.
 */
function ledgerClient({ now = () => new Date() } = {}) {
  const rows = [];
  let nextID = 1;

  function claimKey(row) {
    return `${row.workspace_id}|${row.scope}|${row.scope_key}|${row.local_day}`;
  }

  function from(table) {
    if (table !== 'sms_daily_cycle_runs') throw new Error(`unexpected table ${table}`);
    const op = { action: 'select', filters: [], values: null, limit: null };
    const matches = row => op.filters.every(([kind, column, value]) => {
      if (kind === 'eq') return String(row[column]) === String(value);
      if (kind === 'lt') return new Date(row[column]) < new Date(value);
      if (kind === 'gte') return new Date(row[column]) >= new Date(value);
      if (kind === 'in') return value.includes(row[column]);
      return true;
    });
    const builder = {
      insert(values) { op.action = 'insert'; op.values = values; return builder; },
      update(values) { op.action = 'update'; op.values = values; return builder; },
      select() { return builder; },
      eq(column, value) { op.filters.push(['eq', column, value]); return builder; },
      lt(column, value) { op.filters.push(['lt', column, value]); return builder; },
      gte(column, value) { op.filters.push(['gte', column, value]); return builder; },
      in(column, value) { op.filters.push(['in', column, value]); return builder; },
      order() { return builder; },
      limit(value) { op.limit = value; return builder; },
      maybeSingle() { op.single = true; return builder; },
      then(onFulfilled, onRejected) {
        return Promise.resolve().then(() => {
          if (op.action === 'insert') {
            const row = { id: nextID, ...op.values };
            if (rows.some(existing => claimKey(existing) === claimKey(row))) {
              // Exactly what PostgREST returns for a unique violation.
              return { data: null, error: { code: '23505', message: 'duplicate key value' } };
            }
            nextID += 1;
            rows.push(row);
            return { data: { id: row.id }, error: null };
          }
          if (op.action === 'update') {
            const hit = rows.filter(matches);
            for (const row of hit) Object.assign(row, op.values);
            return { data: op.single ? (hit[0] ? { id: hit[0].id } : null) : hit, error: null };
          }
          const found = rows.filter(matches)
            .sort((a, b) => String(b.local_day).localeCompare(String(a.local_day)));
          const sliced = op.limit ? found.slice(0, op.limit) : found;
          return { data: op.single ? (sliced[0] || null) : sliced, error: null };
        }).then(onFulfilled, onRejected);
      }
    };
    return builder;
  }

  return { from, rows, now };
}

/** A client that reports every table as missing, like an unapplied migration. */
function missingTableClient() {
  return {
    from() {
      const builder = new Proxy({}, {
        get(_target, property) {
          if (property === 'then') {
            return (onFulfilled, onRejected) => Promise.resolve()
              .then(() => ({ data: null, error: { code: '42P01', message: 'relation does not exist' } }))
              .then(onFulfilled, onRejected);
          }
          return () => builder;
        }
      });
      return builder;
    }
  };
}

function segmentsService({ items = [], recompute } = {}) {
  const calls = [];
  return {
    calls,
    async list() { return { items, page: 1, pageSize: 200, total: items.length }; },
    async recompute(id, actor, options) {
      calls.push({ id, options });
      if (typeof recompute === 'function') return recompute(id, actor, options);
      return { run: { memberCount: 10, joinedCount: 1, leftCount: 0, replayed: false }, material: false };
    },
    async notificationUsers() { return []; }
  };
}

function portfolioService(payload = {}) {
  return {
    async refreshNow() {
      return {
        detectorVersion: 'test-detector',
        computedAt: '2026-08-24T06:00:00.000Z',
        findings: [],
        refusals: [],
        coverage: { customers: 900, buyers: 781 },
        ...payload
      };
    }
  };
}

function segment(overrides = {}) {
  return {
    id: 's1', key: 'one_time_buyers', name: 'Bought once and never came back',
    kind: 'automatic', memberCount: 504, archivedAt: null,
    lastComputedAt: '2026-08-23T06:00:00.000Z',
    ...overrides
  };
}

// ── The claim ───────────────────────────────────────────────────────────────

test('a second claim on the same local day loses the unique constraint', async () => {
  const client = ledgerClient();
  const now = new Date('2026-08-24T06:00:00.000Z');
  const args = { client, scope: 'cycle', scopeKey: 'workspace', localDay: '2026-08-24', timeZone: 'Europe/London', now };

  const first = await ledger.claim(args);
  assert.equal(first.claimed, true);
  const second = await ledger.claim(args);
  assert.equal(second.claimed, false);
  assert.equal(second.reason, 'already_claimed');
  assert.equal(client.rows.length, 1);
});

test('a completed day is never re-run, however old the row is', async () => {
  const client = ledgerClient();
  const claimed = await ledger.claim({
    client, scope: 'cycle', scopeKey: 'workspace', localDay: '2026-08-24',
    timeZone: 'Europe/London', now: new Date('2026-08-24T06:00:00.000Z')
  });
  await ledger.complete({ client, id: claimed.id, status: 'succeeded', summary: {} });

  // A year later. The stale-claim path must not touch a finished row.
  const retry = await ledger.claim({
    client, scope: 'cycle', scopeKey: 'workspace', localDay: '2026-08-24',
    timeZone: 'Europe/London', now: new Date('2027-08-24T06:00:00.000Z')
  });
  assert.equal(retry.claimed, false);
  assert.equal(retry.reason, 'already_claimed');
});

test('a claim abandoned by a dead process is taken over after the lease', async () => {
  const client = ledgerClient();
  const started = new Date('2026-08-24T06:00:00.000Z');
  const first = await ledger.claim({
    client, scope: 'cycle', scopeKey: 'workspace', localDay: '2026-08-24',
    timeZone: 'Europe/London', now: started
  });
  assert.equal(first.claimed, true);

  // Five minutes later, inside the ten-minute lease: still somebody else's.
  const tooSoon = await ledger.claim({
    client, scope: 'cycle', scopeKey: 'workspace', localDay: '2026-08-24',
    timeZone: 'Europe/London', now: new Date(started.getTime() + 5 * 60_000)
  });
  assert.equal(tooSoon.claimed, false);

  // Fifteen minutes later, past it: taken over, and still exactly one row.
  const taken = await ledger.claim({
    client, scope: 'cycle', scopeKey: 'workspace', localDay: '2026-08-24',
    timeZone: 'Europe/London', now: new Date(started.getTime() + 15 * 60_000)
  });
  assert.equal(taken.claimed, true);
  assert.equal(taken.takenOver, true);
  assert.equal(client.rows.length, 1);
});

test('an unapplied migration is not ready and never a throw', async () => {
  const client = missingTableClient();
  const claim = await ledger.claim({
    client, scope: 'cycle', scopeKey: 'workspace', localDay: '2026-08-24', timeZone: 'Europe/London'
  });
  assert.equal(claim.reason, 'not_ready');
  assert.equal((await ledger.lastClaimedDay({ client, scope: 'cycle', scopeKey: 'workspace' })).reason, 'not_ready');
  assert.equal((await ledger.latestCycle({ client })).reason, 'not_ready');
  assert.equal((await ledger.recentDigests({ client, scopeKey: '1' })).reason, 'not_ready');
});

// ── Redeploy and double fire ────────────────────────────────────────────────

test('ticking every five minutes all day produces exactly one cycle', async () => {
  const client = ledgerClient();
  const segments = segmentsService({ items: [segment()] });
  const day = Date.UTC(2026, 7, 24, 0, 0, 0);
  let ran = 0;

  for (let minute = 0; minute < 24 * 60; minute += 5) {
    const result = await runDueCycle({
      client, segments, portfolio: portfolioService(),
      now: new Date(day + minute * 60_000),
      env: { DAILY_CYCLE_TIMEZONE: 'Europe/London', DAILY_CYCLE_HOUR: '6' },
      log: SILENT
    });
    if (result.ran) ran += 1;
  }

  assert.equal(ran, 1, 'exactly one cycle for the day');
  assert.equal(segments.calls.length, 1, 'the segment was recomputed once');
  const cycles = client.rows.filter(row => row.scope === 'cycle');
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].status, 'succeeded');
});

test('two instances ticking together during a rolling deploy still produce one cycle', async () => {
  const client = ledgerClient();
  const oldInstance = segmentsService({ items: [segment()] });
  const newInstance = segmentsService({ items: [segment()] });
  const now = new Date('2026-08-24T06:00:00.000Z');
  const env = { DAILY_CYCLE_TIMEZONE: 'Europe/London', DAILY_CYCLE_HOUR: '6' };

  const [a, b] = await Promise.all([
    runDueCycle({ client, segments: oldInstance, portfolio: portfolioService(), now, env, log: SILENT }),
    runDueCycle({ client, segments: newInstance, portfolio: portfolioService(), now, env, log: SILENT })
  ]);

  assert.equal([a.ran, b.ran].filter(Boolean).length, 1, 'exactly one instance wins the claim');
  assert.equal(oldInstance.calls.length + newInstance.calls.length, 1);
});

test('a run too late in the day is recorded as skipped rather than fired stale', async () => {
  const client = ledgerClient();
  const segments = segmentsService({ items: [segment()] });
  // 18:00 London, twelve hours past a 06:00 target.
  const result = await runDueCycle({
    client, segments, portfolio: portfolioService(),
    now: new Date('2026-08-24T17:00:00.000Z'),
    env: { DAILY_CYCLE_TIMEZONE: 'Europe/London', DAILY_CYCLE_HOUR: '6' },
    log: SILENT
  });
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'too_late');
  assert.equal(segments.calls.length, 0, 'nothing was recomputed');
  assert.equal(client.rows[0].status, 'skipped', 'the missed day is a record, not a hole');
});

// ── Partial failure ─────────────────────────────────────────────────────────

test('one segment throwing does not stop the others and is reported', async () => {
  const items = [
    segment({ id: 's1', key: 'a', name: 'A' }),
    segment({ id: 's2', key: 'b', name: 'B' }),
    segment({ id: 's3', key: 'c', name: 'C' })
  ];
  const segments = segmentsService({
    items,
    recompute: id => {
      if (id === 's2') throw Object.assign(new Error('rules invalid'), { code: 'SEGMENT_RULES_INVALID' });
      return { run: { memberCount: 10, joinedCount: 1, leftCount: 0, replayed: false } };
    }
  });

  const outcome = await runCycle({ segments, portfolio: portfolioService(), log: SILENT, env: {} });
  assert.equal(outcome.status, 'partial', 'a failure must not be recorded as success');
  assert.equal(outcome.summary.segmentsRecomputed, 2);
  assert.deepEqual(outcome.summary.failures, [{ key: 'b', name: 'B', code: 'SEGMENT_RULES_INVALID' }]);
});

test('an opportunity refresh failure degrades the run and does not throw', async () => {
  const outcome = await runCycle({
    segments: segmentsService({ items: [] }),
    portfolio: { async refreshNow() { throw Object.assign(new Error('woo down'), { code: 'WOO_UNAVAILABLE' }); } },
    log: SILENT, env: {}
  });
  assert.equal(outcome.status, 'partial');
  assert.equal(outcome.summary.opportunities.available, false);
  assert.equal(outcome.summary.opportunities.code, 'WOO_UNAVAILABLE');
});

// ── Cold start ──────────────────────────────────────────────────────────────

test('a segment that has never been computed is marked as a baseline', async () => {
  const segments = segmentsService({
    items: [segment({ lastComputedAt: null, memberCount: 0 })],
    recompute: () => ({ run: { memberCount: 504, joinedCount: 504, leftCount: 0, replayed: false } })
  });
  const outcome = await runCycle({ segments, portfolio: portfolioService(), log: SILENT, env: {} });
  assert.equal(outcome.summary.segments[0].baseline, true);
  assert.equal(outcome.summary.coldStart, true, 'no previous cycle was supplied');
});

// ── The flags ───────────────────────────────────────────────────────────────

test('with every flag off the pass still runs and records what it would have done', async () => {
  const findings = [{
    key: 'one_time_buyers',
    segmentKey: 'one_time_buyers',
    title: 'Bought once and never came back',
    population: 504,
    evidence: { people: { countedFrom: '2343 paid orders across 781 buyers.' } }
  }];
  const outcome = await runCycle({
    segments: segmentsService({ items: [segment()] }),
    portfolio: portfolioService({ findings }),
    log: SILENT,
    env: {
      SEGMENT_CHANGE_NOTIFICATIONS_ENABLED: 'false',
      CAMPAIGN_OPPORTUNITY_PROPOSALS_ENABLED: 'false',
      DAILY_DIGEST_NOTIFICATIONS_ENABLED: 'false'
    }
  });

  assert.equal(outcome.status, 'succeeded');
  assert.equal(outcome.summary.segmentsRecomputed, 1, 'the recompute is not gated by a flag');
  assert.equal(outcome.summary.opportunities.findings, 1);
  assert.deepEqual(
    outcome.summary.opportunities.significant, [{ key: 'one_time_buyers', population: 504 }],
    'significance is decided and recorded even with proposals switched off'
  );
  assert.equal(outcome.summary.proposals.disabled, true);
  assert.equal(outcome.summary.proposals.wouldDraft, 1, 'the count is observable with the brake on');
  assert.equal(outcome.summary.proposals.saved, 0, 'and nothing was written');
});

test('a finding below the actionable floor is skipped with a reason', async () => {
  const findings = [{
    key: 'one_time_multi_product', segmentKey: 'one_time_multi_product',
    title: 'Bought once, and took more than one product', population: 9,
    evidence: { people: { countedFrom: 'counted per person.' } }
  }];
  const outcome = await runCycle({
    segments: segmentsService({ items: [] }),
    portfolio: portfolioService({ findings }), log: SILENT, env: {}
  });
  assert.deepEqual(outcome.summary.opportunities.skipped,
    [{ key: 'one_time_multi_product', reason: 'below_actionable_floor', population: 9 }]);
});

test('a structural finding is refused as an audience rather than proposed for', async () => {
  const findings = [
    { key: 'contacts_with_no_paid_order', title: 'x', population: 400, evidence: {} },
    { key: 'repeat_behaviour_is_cross_product', title: 'x', population: 200, evidence: {} }
  ];
  const outcome = await runCycle({
    segments: segmentsService({ items: [] }),
    portfolio: portfolioService({ findings }), log: SILENT, env: {}
  });
  assert.deepEqual(
    outcome.summary.opportunities.skipped.map(entry => entry.reason),
    ['not_an_audience', 'not_an_audience']
  );
  assert.equal(outcome.summary.opportunities.significant.length, 0);
});

// ── The dry run ─────────────────────────────────────────────────────────────

test('a dry run recomputes nothing and writes nothing', async () => {
  const segments = segmentsService({ items: [segment(), segment({ id: 's2', key: 'b' })] });
  const outcome = await runCycle({
    segments, portfolio: portfolioService(), dryRun: true, log: SILENT, env: {}
  });
  assert.equal(segments.calls.length, 0, 'recompute is a production write and a dry run must not do it');
  assert.equal(outcome.summary.dryRun, true);
  assert.equal(outcome.summary.segments.length, 2, 'it still reports what it would recompute');
  assert.equal(outcome.summary.proposals.dryRun, true);
});

// ── The digest schedule ─────────────────────────────────────────────────────

test('two accounts five hours apart each get one digest, on their own morning', async () => {
  const client = ledgerClient();
  // A completed cycle for them to report, with one material movement.
  const claimed = await ledger.claim({
    client, scope: 'cycle', scopeKey: 'workspace', localDay: '2026-08-24',
    timeZone: 'Europe/London', now: new Date('2026-08-24T05:00:00.000Z')
  });
  await ledger.complete({
    client, id: claimed.id, status: 'succeeded', now: new Date('2026-08-24T05:05:00.000Z'),
    summary: {
      coldStart: false,
      customerCount: 900,
      previousCustomerCount: 899,
      segments: [{
        key: 'one_time_buyers', name: 'Bought once and never came back',
        previousCount: 504, memberCount: 444, joinedCount: 0, leftCount: 60, baseline: false
      }],
      failures: [], proposals: { saved: 0 }
    }
  });

  const users = [
    { id: 1, role: 'owner', isActive: true, canManageCampaigns: true, timeZone: 'Europe/London' },
    { id: 2, role: 'admin', isActive: true, canManageCampaigns: true, timeZone: 'America/New_York' }
  ];
  const sent = [];
  const env = { DAILY_DIGEST_NOTIFICATIONS_ENABLED: 'true' };
  const send = async notifications => { sent.push(notifications[0]); return { sent: 1 }; };

  const day = Date.UTC(2026, 7, 24, 5, 30, 0);
  for (let minute = 0; minute < 20 * 60; minute += 5) {
    await runDueDigests({
      client, users, now: new Date(day + minute * 60_000), env, send, log: SILENT
    });
  }

  assert.equal(sent.length, 2, 'one digest each, and no more');
  assert.deepEqual(sent.map(row => row.userID).sort(), ['1', '2']);
  const digests = client.rows.filter(row => row.scope === 'digest');
  assert.equal(digests.length, 2);
  assert.deepEqual(digests.map(row => row.time_zone).sort(),
    ['America/New_York', 'Europe/London']);
});

test('the digest waits rather than claiming when no cycle has finished', async () => {
  const client = ledgerClient();
  const users = [{ id: 1, role: 'owner', isActive: true, canManageCampaigns: true, timeZone: 'Europe/London' }];
  const result = await runDueDigests({
    client, users, now: new Date('2026-08-24T07:30:00.000Z'), env: {}, log: SILENT
  });
  assert.deepEqual(result.outcomes, [{ userID: '1', reason: 'waiting_for_cycle' }]);
  assert.equal(client.rows.length, 0, 'the day must not be burned while the cycle could still land');
});

test('with the digest flag off the decision is still recorded and nothing is sent', async () => {
  const client = ledgerClient();
  const claimed = await ledger.claim({
    client, scope: 'cycle', scopeKey: 'workspace', localDay: '2026-08-24',
    timeZone: 'Europe/London', now: new Date('2026-08-24T05:00:00.000Z')
  });
  await ledger.complete({
    client, id: claimed.id, status: 'succeeded', now: new Date('2026-08-24T05:05:00.000Z'),
    summary: {
      coldStart: false,
      segments: [{
        key: 'one_time_buyers', name: 'Bought once and never came back',
        previousCount: 504, memberCount: 444, joinedCount: 0, leftCount: 60
      }],
      failures: [], proposals: { saved: 0 }
    }
  });

  let called = 0;
  const result = await runDueDigests({
    client,
    users: [{ id: 1, role: 'owner', isActive: true, canManageCampaigns: true, timeZone: 'Europe/London' }],
    now: new Date('2026-08-24T07:35:00.000Z'),
    env: { DAILY_DIGEST_NOTIFICATIONS_ENABLED: 'false' },
    send: async () => { called += 1; return { sent: 1 }; },
    log: SILENT
  });

  assert.equal(called, 0, 'the flag holds the send');
  assert.equal(result.outcomes[0].disabled, true);
  const digest = client.rows.find(row => row.scope === 'digest');
  assert.equal(digest.status, 'succeeded');
  assert.equal(digest.summary.sent, 0);
  assert.equal(digest.summary.silent, false, 'it was composed; only delivery was held');
  assert.ok(digest.summary.title, 'the wording is recorded so it can be reviewed before the flag flips');
});

test('a quiet day records the reason and sends nothing', async () => {
  const client = ledgerClient();
  const claimed = await ledger.claim({
    client, scope: 'cycle', scopeKey: 'workspace', localDay: '2026-08-24',
    timeZone: 'Europe/London', now: new Date('2026-08-24T05:00:00.000Z')
  });
  await ledger.complete({
    client, id: claimed.id, status: 'succeeded', now: new Date('2026-08-24T05:05:00.000Z'),
    summary: {
      coldStart: false,
      segments: [{ key: 'one_time_buyers', name: 'X', previousCount: 504, memberCount: 504, joinedCount: 0, leftCount: 0 }],
      failures: [], proposals: { saved: 0 }
    }
  });

  let called = 0;
  await runDueDigests({
    client,
    users: [{ id: 1, role: 'owner', isActive: true, canManageCampaigns: true, timeZone: 'Europe/London' }],
    now: new Date('2026-08-24T07:35:00.000Z'),
    env: { DAILY_DIGEST_NOTIFICATIONS_ENABLED: 'true' },
    send: async () => { called += 1; return { sent: 1 }; },
    log: SILENT
  });

  assert.equal(called, 0, 'silence is a feature, not an all-quiet push');
  const digest = client.rows.find(row => row.scope === 'digest');
  assert.equal(digest.summary.silent, true);
  assert.equal(digest.summary.reason, 'nothing_material');
});

test('a weekend produces no digest and no claim', async () => {
  const client = ledgerClient();
  const users = [{ id: 1, role: 'owner', isActive: true, canManageCampaigns: true, timeZone: 'Europe/London' }];
  // 22 August 2026 is a Saturday.
  const result = await runDueDigests({
    client, users, now: new Date('2026-08-22T09:00:00.000Z'),
    env: { DAILY_DIGEST_WEEKDAYS_ONLY: 'true' }, log: SILENT
  });
  assert.deepEqual(result.outcomes, [{ userID: '1', reason: 'off_day' }]);
  assert.equal(client.rows.length, 0, 'a Saturday is not a missed run');
});

// ── Configuration ───────────────────────────────────────────────────────────

test('the schedule defaults are the documented ones', () => {
  const schedule = cycleSchedule({});
  assert.equal(schedule.zone, 'Europe/London');
  assert.equal(schedule.zoneIsDefault, true);
  assert.deepEqual(schedule.target, { hour: 6, minute: 0 });
  assert.deepEqual(digestTarget({}), { hour: 8, minute: 30 });
  assert.equal(digestWeekdaysOnly({}), true);
  assert.equal(digestWeekdaysOnly({ DAILY_DIGEST_WEEKDAYS_ONLY: 'false' }), false);
  // Anything other than the exact string false keeps weekdays only.
  assert.equal(digestWeekdaysOnly({ DAILY_DIGEST_WEEKDAYS_ONLY: 'FALSE' }), true);
});

test('the cycle anchor is a display concern and never the business zone', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  for (const file of ['lib/daily-cycle.js', 'lib/daily-scheduler.js',
    'lib/notifications/daily-schedule.js', 'lib/notifications/daily-digest.js',
    'lib/notifications/run-ledger.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    // The one thing that must never happen: this feature reading the column
    // that decides when a CUSTOMER may be texted.
    const reads = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(
      /business_timezone/.test(reads), false,
      `${file} references business_timezone outside a comment. Campaign quiet hours are `
      + 'enforced in SQL and nothing in the digest may read or write that column.'
    );
    assert.equal(
      /sms_campaign_settings/.test(reads), false,
      `${file} reaches into sms_campaign_settings. That table decides when customers are contacted.`
    );
  }
});

test('the ledger records counts and reasons, never a customer', async () => {
  const client = ledgerClient();
  const segments = segmentsService({ items: [segment()] });
  await runDueCycle({
    client, segments, portfolio: portfolioService(),
    now: new Date('2026-08-24T06:00:00.000Z'),
    env: { DAILY_CYCLE_TIMEZONE: 'Europe/London', DAILY_CYCLE_HOUR: '6' },
    log: SILENT
  });
  const written = JSON.stringify(client.rows.find(row => row.scope === 'cycle').summary);
  assert.equal(/\+?\d[\d\s().-]{9,}/.test(written), false, 'no phone-shaped run in the ledger');
  assert.equal(/@/.test(written), false, 'no address-shaped text in the ledger');
  assert.equal(/contactPhone|contact_phone/.test(written), false);
});

test('recomputeAll skips an archived segment even if the list returns one', async () => {
  const segments = segmentsService({
    items: [segment(), segment({ id: 's2', key: 'b', archivedAt: '2026-01-01T00:00:00.000Z' })]
  });
  const result = await recomputeAll({
    segments, actor: { id: null }, now: new Date(), dryRun: false, log: SILENT
  });
  assert.equal(result.considered, 1);
  assert.deepEqual(segments.calls.map(call => call.id), ['s1']);
});
