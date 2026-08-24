'use strict';
/**
 * The scheduling arithmetic behind the daily segmentation cycle.
 *
 * THREE THINGS ARE BEING PROTECTED HERE, and all three have a specific failure
 * they exist to prevent.
 *
 *   1. REDEPLOY DRIFT. The decision must be a pure function of the wall clock
 *      and a persisted claim, so that restarting the process at any moment
 *      cannot move the fire time. A `setInterval(fn, 86_400_000)` fires 24
 *      hours after BOOT, and `main` auto-deploys to Railway, so the digest hour
 *      would wander around the clock at the pace of the release cadence. The
 *      tests below run the same clock through a simulated day of restarts and
 *      assert the answer never depends on when the process started.
 *
 *   2. THE `>=` COMPARISON. A tick eaten by a redeploy, a slow pass or a paused
 *      container must self-heal on the next tick. `=== target` would fire only
 *      if a tick landed exactly on the minute, so one missed tick would lose
 *      the day silently.
 *
 *   3. TIME ZONES, WHICH ARE NOT A CONSTANT OFFSET. The UK and the United
 *      States change clocks on different dates, so the London to New York gap
 *      is four hours for two to three weeks in March and about a week around
 *      the end of October, and five hours the rest of the year. Any code that
 *      computed an offset once and reused it would be an hour wrong for several
 *      weeks a year and would look like an intermittent bug. The tests pin real
 *      instants inside those windows.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_CATCHUP_MINUTES,
  DEFAULT_TICK_MS,
  MAX_TICK_MS,
  MIN_TICK_MS,
  dueAt,
  instantForLocalTime,
  isWeekday,
  localDayKey,
  localMinuteOfDay,
  localWeekday,
  nextFireAfter,
  scheduleZone,
  targetTime,
  tickIntervalFrom
} = require('../lib/notifications/daily-schedule');

const LONDON = 'Europe/London';
const NEW_YORK = 'America/New_York';
const TARGET = { hour: 8, minute: 30 };

// ── The zone, and the fact that it is never an offset ───────────────────────

test('a zone is validated through the runtime and falls back visibly', () => {
  assert.deepEqual(scheduleZone(LONDON), { id: LONDON, isDefault: false });
  // Aliases and case are resolved by Intl, not by a table in this repository.
  assert.deepEqual(scheduleZone('us/eastern'), { id: NEW_YORK, isDefault: false });
  // A bare offset is exactly the value this must refuse. It resolves to itself
  // and is therefore not a member of the accepted set.
  assert.deepEqual(scheduleZone('+01:00'), { id: LONDON, isDefault: true });
  assert.deepEqual(scheduleZone('Mars/Olympus'), { id: LONDON, isDefault: true });
  assert.deepEqual(scheduleZone(null), { id: LONDON, isDefault: true });
});

test('the London to New York gap is four hours in the March window and five otherwise', () => {
  // 2026: the UK springs forward on 29 March, the US on 8 March. Between those
  // two dates the gap is FOUR hours, not five.
  const inTheGap = new Date('2026-03-15T12:00:00.000Z');
  assert.equal(localMinuteOfDay(inTheGap, LONDON), 12 * 60);
  assert.equal(localMinuteOfDay(inTheGap, NEW_YORK), 8 * 60);

  // Deep summer: both on daylight time, five hours apart.
  const summer = new Date('2026-07-15T12:00:00.000Z');
  assert.equal(localMinuteOfDay(summer, LONDON), 13 * 60);
  assert.equal(localMinuteOfDay(summer, NEW_YORK), 8 * 60);

  // 2026: the UK falls back on 25 October, the US on 1 November. Four hours
  // again for that week.
  const october = new Date('2026-10-28T12:00:00.000Z');
  assert.equal(localMinuteOfDay(october, LONDON), 12 * 60);
  assert.equal(localMinuteOfDay(october, NEW_YORK), 8 * 60);
});

test('the local day and weekday are read in the zone, not in UTC', () => {
  // 03:30 UTC on a Saturday is still Friday evening in New York, and a Friday
  // is a working day. Reading `getUTCDay()` here would skip a real weekday and
  // fire on a real weekend.
  const lateFridayInNewYork = new Date('2026-08-22T03:30:00.000Z');
  assert.equal(localDayKey(lateFridayInNewYork, NEW_YORK), '2026-08-21');
  assert.equal(localWeekday(lateFridayInNewYork, NEW_YORK), 'Fri');
  assert.equal(isWeekday(lateFridayInNewYork, NEW_YORK), true);
  assert.equal(localDayKey(lateFridayInNewYork, LONDON), '2026-08-22');
  assert.equal(isWeekday(lateFridayInNewYork, LONDON), false);
});

test('a local wall time maps back to the right instant across a DST boundary', () => {
  // 08:30 New York on a winter day is 13:30 UTC; on a summer day it is 12:30.
  assert.equal(
    instantForLocalTime('2026-01-15', TARGET, NEW_YORK).toISOString(),
    '2026-01-15T13:30:00.000Z'
  );
  assert.equal(
    instantForLocalTime('2026-07-15', TARGET, NEW_YORK).toISOString(),
    '2026-07-15T12:30:00.000Z'
  );
  // And the round trip holds: the instant reads back as the same wall time.
  for (const day of ['2026-01-15', '2026-03-15', '2026-07-15', '2026-10-28']) {
    for (const zone of [LONDON, NEW_YORK]) {
      const instant = instantForLocalTime(day, TARGET, zone);
      assert.equal(localDayKey(instant, zone), day);
      assert.equal(localMinuteOfDay(instant, zone), 8 * 60 + 30);
    }
  }
});

// ── The decision ────────────────────────────────────────────────────────────

test('it waits before the target and runs at or after it', () => {
  const before = new Date('2026-08-24T07:00:00.000Z'); // 08:00 London
  assert.equal(dueAt({ now: before, zone: LONDON, target: TARGET }).verdict, 'waiting');

  const exactly = new Date('2026-08-24T07:30:00.000Z'); // 08:30 London
  assert.equal(dueAt({ now: exactly, zone: LONDON, target: TARGET }).verdict, 'run');

  const after = new Date('2026-08-24T08:05:00.000Z'); // 09:05 London
  assert.equal(dueAt({ now: after, zone: LONDON, target: TARGET }).verdict, 'run');
});

test('a missed tick self-heals, which is why the comparison is >= and not ==', () => {
  // Five-minute ticks, and the one that would have landed on 08:30 never
  // happened. Every subsequent tick inside the catch-up window must still say
  // run, or the day is lost in silence.
  for (const minutes of [31, 35, 40, 55, 120, 179]) {
    const now = new Date(Date.UTC(2026, 7, 24, 7, 0, 0) + minutes * 60_000);
    assert.equal(
      dueAt({ now, zone: LONDON, target: TARGET }).verdict, 'run',
      `${minutes} minutes past 08:00 London must still be runnable`
    );
  }
});

test('too late is a recorded skip, not a stale notification', () => {
  // Down all morning. 13:00 London is four and a half hours past 08:30, past
  // the three-hour ceiling, and a "here is what changed this morning" push at
  // that point is stale.
  const tooLate = new Date('2026-08-24T12:00:00.000Z');
  const verdict = dueAt({ now: tooLate, zone: LONDON, target: TARGET });
  assert.equal(verdict.verdict, 'skip');
  assert.ok(verdict.minutesLate > DEFAULT_CATCHUP_MINUTES);
  assert.equal(DEFAULT_CATCHUP_MINUTES, 180);
});

test('a claimed day is done, and the claim is what makes that true', () => {
  const now = new Date('2026-08-24T09:00:00.000Z');
  assert.equal(
    dueAt({ now, zone: LONDON, target: TARGET, lastClaimedDay: '2026-08-24' }).verdict, 'done');
  // Yesterday's claim does not satisfy today.
  assert.equal(
    dueAt({ now, zone: LONDON, target: TARGET, lastClaimedDay: '2026-08-23' }).verdict, 'run');
});

test('weekends are an off day and are not recorded as a miss', () => {
  const saturday = new Date('2026-08-22T09:00:00.000Z');
  assert.equal(localWeekday(saturday, LONDON), 'Sat');
  assert.equal(
    dueAt({ now: saturday, zone: LONDON, target: TARGET, weekdaysOnly: true }).verdict, 'off_day');
  // Without the option it is an ordinary day, which is what the RECOMPUTE uses.
  assert.equal(
    dueAt({ now: saturday, zone: LONDON, target: TARGET, weekdaysOnly: false }).verdict, 'run');
});

test('a claimed weekend day still reads as done rather than off_day', () => {
  // Ordering matters: `done` is checked first so that a day claimed under a
  // previous configuration is never re-run when the weekday rule changes.
  const saturday = new Date('2026-08-22T09:00:00.000Z');
  assert.equal(
    dueAt({
      now: saturday, zone: LONDON, target: TARGET,
      weekdaysOnly: true, lastClaimedDay: '2026-08-22'
    }).verdict,
    'done'
  );
});

// ── The property that actually matters ──────────────────────────────────────

test('the verdict never depends on when the process started', () => {
  // THE REGRESSION THIS FILE EXISTS FOR. Simulate a whole day of five-minute
  // ticks and, separately, the same day with the process restarting every
  // twenty minutes. A `setInterval(fn, 24h)` would produce a different fire
  // time in the second case; this must produce exactly the same one.
  const day = Date.UTC(2026, 7, 24, 0, 0, 0);
  const fireMinutes = [];
  let claimed = null;

  for (let minute = 0; minute < 24 * 60; minute += 5) {
    const now = new Date(day + minute * 60_000);
    const verdict = dueAt({ now, zone: LONDON, target: TARGET, lastClaimedDay: claimed });
    if (verdict.verdict === 'run') {
      fireMinutes.push(minute);
      claimed = verdict.localDay;
    }
  }

  // 08:30 London on 24 August is 07:30 UTC, which is minute 450.
  assert.deepEqual(fireMinutes, [450], 'exactly one fire, at the target minute');

  // Now with restarts. Every twenty minutes the "process" starts fresh, which
  // means its timer phase resets. The claim is persisted, as it is in the
  // database, so the answer must be identical.
  const withRestarts = [];
  claimed = null;
  for (let restart = 0; restart < 24 * 60; restart += 20) {
    for (let offset = 0; offset < 20; offset += 5) {
      const now = new Date(day + (restart + offset) * 60_000);
      const verdict = dueAt({ now, zone: LONDON, target: TARGET, lastClaimedDay: claimed });
      if (verdict.verdict === 'run') {
        withRestarts.push(restart + offset);
        claimed = verdict.localDay;
      }
    }
  }
  assert.deepEqual(withRestarts, fireMinutes, 'a redeploy must not move the fire time');
});

test('two accounts five hours apart fire on their own local mornings', () => {
  const day = Date.UTC(2026, 7, 24, 0, 0, 0);
  const fired = { [LONDON]: [], [NEW_YORK]: [] };
  const claimed = { [LONDON]: null, [NEW_YORK]: null };

  for (let minute = 0; minute < 24 * 60; minute += 5) {
    const now = new Date(day + minute * 60_000);
    for (const zone of [LONDON, NEW_YORK]) {
      const verdict = dueAt({ now, zone, target: TARGET, lastClaimedDay: claimed[zone] });
      if (verdict.verdict === 'run') {
        fired[zone].push(minute);
        claimed[zone] = verdict.localDay;
      }
    }
  }
  // 08:30 London = 07:30 UTC = minute 450. 08:30 New York = 12:30 UTC = 750.
  assert.deepEqual(fired[LONDON], [450]);
  assert.deepEqual(fired[NEW_YORK], [750]);
  assert.equal(fired[NEW_YORK][0] - fired[LONDON][0], 300, 'five hours apart in August');
});

test('in the March window the same two accounts are four hours apart', () => {
  // 15 March 2026: the US has sprung forward, the UK has not. This is the
  // fortnight a cached offset would be wrong for.
  const day = Date.UTC(2026, 2, 15, 0, 0, 0);
  const fired = { [LONDON]: null, [NEW_YORK]: null };
  for (let minute = 0; minute < 24 * 60; minute += 5) {
    const now = new Date(day + minute * 60_000);
    for (const zone of [LONDON, NEW_YORK]) {
      if (fired[zone] !== null) continue;
      if (dueAt({ now, zone, target: TARGET }).verdict === 'run') fired[zone] = minute;
    }
  }
  assert.equal(fired[NEW_YORK] - fired[LONDON], 240, 'four hours apart in the March window');
});

// ── Configuration ───────────────────────────────────────────────────────────

test('the tick interval is clamped and a typo degrades to the default', () => {
  assert.equal(tickIntervalFrom({}), DEFAULT_TICK_MS);
  assert.equal(tickIntervalFrom({ DAILY_CYCLE_TICK_MS: 'nonsense' }), DEFAULT_TICK_MS);
  assert.equal(tickIntervalFrom({ DAILY_CYCLE_TICK_MS: '0' }), DEFAULT_TICK_MS);
  assert.equal(tickIntervalFrom({ DAILY_CYCLE_TICK_MS: '1' }), MIN_TICK_MS);
  assert.equal(tickIntervalFrom({ DAILY_CYCLE_TICK_MS: '999999999' }), MAX_TICK_MS);
  assert.equal(tickIntervalFrom({ DAILY_CYCLE_TICK_MS: '60000' }), 60_000);
});

test('a bad target hour falls back rather than stopping the scheduler', () => {
  assert.deepEqual(targetTime('x', 'y', { defaultHour: 8, defaultMinute: 30 }), { hour: 8, minute: 30 });
  assert.deepEqual(targetTime('99', '99', { defaultHour: 8 }), { hour: 23, minute: 59 });
  assert.deepEqual(targetTime('0', '0', { defaultHour: 8 }), { hour: 0, minute: 0 });
});

test('the next fire time is reported for the log and never scheduled against', () => {
  const beforeTarget = new Date('2026-08-24T06:00:00.000Z'); // 07:00 London
  assert.equal(
    nextFireAfter({ now: beforeTarget, zone: LONDON, target: TARGET }).toISOString(),
    '2026-08-24T07:30:00.000Z'
  );
  const afterTarget = new Date('2026-08-24T10:00:00.000Z'); // 11:00 London
  assert.equal(
    nextFireAfter({ now: afterTarget, zone: LONDON, target: TARGET }).toISOString(),
    '2026-08-25T07:30:00.000Z'
  );
});

test('an invalid clock throws rather than being silently coerced', () => {
  assert.throws(() => dueAt({ now: 'not a date', zone: LONDON, target: TARGET }), /valid date/);
});
