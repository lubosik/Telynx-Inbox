'use strict';
/**
 * lib/notifications/daily-schedule.js — the arithmetic that turns "once a day
 * at nine in the morning, where that person is" into an instant and a claim
 * key. Pure: no database, no clock of its own, no side effects, so all of it is
 * testable offline.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A DAILY JOB CANNOT BE A `setInterval`, AND WHAT IS DONE INSTEAD
 *
 *   Every other background job in this repository is `setInterval(fn, N)`
 *   started from `app.listen`. At five minutes that is fine: the phase resets
 *   on every deploy and nobody can tell. At twenty-four hours it is not, for
 *   two separate reasons.
 *
 *     1. PHASE. `setInterval(fn, 86_400_000)` fires 24 hours after BOOT. Deploy
 *        at 09:00 and the job runs at 09:00; deploy again at 16:20 and it now
 *        runs at 16:20 forever, until the next deploy moves it again. `main`
 *        auto-deploys to Railway, so the fire time would wander around the
 *        clock at the pace of the release cadence. A digest that arrives at a
 *        different hour every few days is one the owner switches off.
 *     2. DRIFT AND LOSS. A long timer drifts against wall clock, and a process
 *        that restarts 23 hours in loses the day entirely with no record that
 *        it did.
 *
 *   The fix is to stop asking a timer to remember anything. A short TICK runs
 *   every few minutes and asks a question of the WALL CLOCK and a PERSISTED
 *   CLAIM: is it past the target local time today, and has today already been
 *   claimed? The timer's phase is then irrelevant by construction, because the
 *   timer no longer decides anything. Restarting at 06:03 changes nothing: the
 *   tick at 06:05 sees no claim and runs. Restarting at 14:00 after a 06:00 run
 *   sees the claim and does not. Worst-case lateness is one tick interval, not
 *   one deploy cycle.
 *
 *   `dueAt()` below is that question, and it is a pure function of (now, zone,
 *   target, last claimed day) so it can be exhaustively tested against a fake
 *   clock.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TIME ZONES HERE ARE DISPLAY AND DELIVERY TIMING. THEY ARE NOT QUIET HOURS.
 *
 *   Two zones appear in this module and neither is the business zone.
 *
 *     * The CYCLE anchor, DAILY_CYCLE_TIMEZONE, decides when a recompute runs.
 *       That is an operational choice about our own server, like the hour a
 *       backup starts. It contacts nobody.
 *     * A PERSON'S zone, `sms_users.timezone`, decides when THEIR summary push
 *       is delivered. One operator is in Europe/London and one is in
 *       America/New_York, and nine in the morning has to mean nine in the
 *       morning for each of them.
 *
 *   Campaign quiet hours — when a CUSTOMER may lawfully be texted — are
 *   enforced in SQL inside `claim_sms_campaign_batch` against
 *   `sms_campaign_settings.business_timezone`, and nothing in this file, in
 *   lib/daily-cycle.js, or in the tables they write is read by that predicate,
 *   by the delivery worker, or by any send gate. Crossing the two would let one
 *   member of staff move the hours in which customers are textable by editing
 *   their own profile. `test/user-timezone.test.js` guards both directions
 *   against the source text and this module is deliberately OUTSIDE
 *   `lib/campaigns/` so that guard keeps working.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { DEFAULT_TIME_ZONE, canonicalTimeZone, offsetMinutesAt } = require('../timezones');

/** The scheduler asks its question this often. See the header. */
const DEFAULT_TICK_MS = 5 * 60 * 1000;
/** Never tick faster than this, whatever configuration says. */
const MIN_TICK_MS = 30 * 1000;
/** Never tick slower than this: lateness is bounded by the tick interval. */
const MAX_TICK_MS = 60 * 60 * 1000;

/**
 * How late is too late.
 *
 * Three hours, per docs/notifications/DIGEST-AND-SETTINGS-RESEARCH.md D6. If
 * the process was down over the target, catching up an hour later is useful and
 * catching up eleven hours later is not: a "here is what changed this morning"
 * push arriving at four in the afternoon is stale, and the same news will be in
 * tomorrow's digest anyway. Past this many minutes the day is CLAIMED and
 * recorded as `skipped`, and the skip is logged, so the ledger says the day was
 * missed rather than leaving a hole that looks like a bug.
 */
const DEFAULT_CATCHUP_MINUTES = 180;

/**
 * Monday to Friday, per D3.
 *
 * The argument is not that nothing happens at the weekend. It is that the
 * digest's honest next step is "open the app and review a proposal", and a
 * notification whose next step nobody is going to take for two days is a
 * notification that gets swiped. The weekend's movement is not lost: it is in
 * Monday's numbers, because the recompute keeps running.
 *
 * `getUTCDay()` is wrong here for the same reason a stored offset is wrong
 * everywhere else in this feature. Saturday 00:30 in New York is Saturday in
 * New York and Saturday 05:30 UTC, but Friday 22:00 in Los Angeles is Saturday
 * 05:00 UTC and is still a working Friday for that person. The weekday has to
 * be read in the same zone the wall clock was.
 */
const WEEKDAYS = Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);

function wholeNumberInRange(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * The tick interval, clamped. A misconfigured value degrades to the default
 * rather than to a hot loop or to a job that never fires.
 */
function tickIntervalFrom(env = process.env) {
  const parsed = Number.parseInt(env?.DAILY_CYCLE_TICK_MS, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_TICK_MS;
  return Math.min(MAX_TICK_MS, Math.max(MIN_TICK_MS, parsed));
}

/**
 * A validated IANA zone, or the documented fallback.
 *
 * Validation is `canonicalTimeZone()` from lib/timezones.js, which resolves
 * through `Intl` against the runtime's own set. A zone this server cannot
 * format is a zone it must not schedule against, and silently scheduling in
 * Europe/London for somebody in Miami is worse than saying so, which is why the
 * fallback is reported rather than applied invisibly.
 *
 * @param {unknown} value
 * @returns {{ id: string, isDefault: boolean }}
 */
function scheduleZone(value) {
  const canonical = canonicalTimeZone(value);
  return canonical ? { id: canonical, isDefault: false } : { id: DEFAULT_TIME_ZONE, isDefault: true };
}

/**
 * The target wall-clock time, as `{ hour, minute }`.
 *
 * Out-of-range or unparseable configuration falls back rather than throwing: a
 * typo in an environment variable must not stop the scheduler starting, and the
 * fallback hour is stated in .env.example.
 */
function targetTime(hourValue, minuteValue, { defaultHour, defaultMinute = 0 } = {}) {
  return {
    hour: wholeNumberInRange(hourValue, defaultHour, 0, 23),
    minute: wholeNumberInRange(minuteValue, defaultMinute, 0, 59)
  };
}

/**
 * The calendar date at `instant`, in `zone`, as `YYYY-MM-DD`.
 *
 * Built from `formatToParts` rather than from a locale string, because a locale
 * that renders `2026-08-24` on one runtime renders `24/08/2026` on another and
 * this value is a database key.
 *
 * @param {Date} instant
 * @param {string} zone  already canonical
 * @returns {string}
 */
function localDayKey(instant, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(instant);
  const find = type => parts.find(part => part.type === type)?.value || '';
  return `${find('year')}-${find('month')}-${find('day')}`;
}

/**
 * Minutes since local midnight at `instant`, in `zone`.
 *
 * `hourCycle: 'h23'` is explicit: without it `hour12` can render midnight as
 * `24`, and "is it past 09:00 yet" would answer yes for the whole of the
 * previous night.
 *
 * @param {Date} instant
 * @param {string} zone  already canonical
 * @returns {number} 0..1439
 */
function localMinuteOfDay(instant, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(instant);
  const find = type => Number.parseInt(parts.find(part => part.type === type)?.value || '0', 10);
  const hour = find('hour') % 24;
  return hour * 60 + find('minute');
}

/**
 * The short weekday name at `instant`, in `zone`. `Mon` .. `Sun`.
 *
 * Read in the zone rather than from `getUTCDay()`, because a UTC day boundary
 * is not a local one and the two disagree for several hours every day.
 *
 * @param {Date} instant
 * @param {string} zone  already canonical
 * @returns {string}
 */
function localWeekday(instant, zone) {
  return new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' }).format(instant);
}

/** Is `instant` a Monday to Friday, where `zone` is? */
function isWeekday(instant, zone) {
  return WEEKDAYS.includes(localWeekday(instant, zone));
}

/**
 * The instant at which a given local date and wall time occurs in `zone`.
 *
 * Iterative because the offset that converts local to UTC depends on the very
 * instant being computed. Two rounds settle every real zone including
 * half-hour and three-quarter-hour ones; a third is there so a hypothetical
 * transition landing exactly on the target still converges rather than
 * oscillating. Exported for tests and for the "when is the next one" reporting
 * on the status payload, never used to decide whether to run — `dueAt()` is.
 *
 * @param {string} dayKey  `YYYY-MM-DD`
 * @param {{hour: number, minute: number}} target
 * @param {string} zone  already canonical
 * @returns {Date}
 */
function instantForLocalTime(dayKey, target, zone) {
  const [year, month, day] = String(dayKey).split('-').map(part => Number.parseInt(part, 10));
  const naive = Date.UTC(year, month - 1, day, target.hour, target.minute, 0, 0);
  let guess = naive;
  for (let round = 0; round < 3; round += 1) {
    const offset = offsetMinutesAt(zone, new Date(guess));
    if (!Number.isFinite(offset)) break;
    const next = naive - offset * 60_000;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

/**
 * Should the daily job run right now, and for which local day?
 *
 * THE WHOLE SCHEDULING DECISION IS THIS FUNCTION. It reads the wall clock and
 * the last claimed day and returns a verdict; it does not know what a segment
 * is, cannot write anything, and has no timer inside it. That is what makes the
 * behaviour under a redeploy testable rather than asserted.
 *
 * Four verdicts and no fifth:
 *   `run`      it is at or past the target today and today is unclaimed.
 *   `skip`     today is unclaimed but the target is more than `catchUpMinutes`
 *              in the past, so the day is recorded as missed rather than fired
 *              late. A stale summary of this morning arriving at four in the
 *              afternoon is worse than silence.
 *   `waiting`  today is unclaimed and the target has not arrived yet.
 *   `done`     today is already claimed.
 *   `off_day`  weekdays only, and today is not one. Nothing is claimed and
 *              nothing is recorded: a Saturday is not a missed run.
 *
 * `minutesLate >= 0` rather than `=== 0` is load-bearing. A tick eaten by a
 * redeploy, a slow pass or a paused container self-heals on the next tick,
 * because the condition stays true until the day is claimed.
 *
 * @param {object} options
 * @param {Date}   options.now
 * @param {string} options.zone            already canonical
 * @param {{hour: number, minute: number}} options.target
 * @param {string|null} [options.lastClaimedDay]  `YYYY-MM-DD`, or null
 * @param {number} [options.catchUpMinutes]
 * @param {boolean}[options.weekdaysOnly]
 * @returns {{verdict: 'run'|'skip'|'waiting'|'done'|'off_day', localDay: string,
 *            minutesLate: number, targetMinute: number, nowMinute: number,
 *            weekday: string}}
 */
function dueAt({
  now,
  zone,
  target,
  lastClaimedDay = null,
  catchUpMinutes = DEFAULT_CATCHUP_MINUTES,
  weekdaysOnly = false
} = {}) {
  const at = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(at.getTime())) throw new Error('now must be a valid date.');

  const localDay = localDayKey(at, zone);
  const nowMinute = localMinuteOfDay(at, zone);
  const weekday = localWeekday(at, zone);
  const targetMinute = target.hour * 60 + target.minute;
  const minutesLate = nowMinute - targetMinute;
  const base = { localDay, minutesLate, targetMinute, nowMinute, weekday };

  if (lastClaimedDay && String(lastClaimedDay) === localDay) return { verdict: 'done', ...base };
  if (weekdaysOnly && !WEEKDAYS.includes(weekday)) return { verdict: 'off_day', ...base };
  if (minutesLate < 0) return { verdict: 'waiting', ...base };
  if (minutesLate > catchUpMinutes) return { verdict: 'skip', ...base };
  return { verdict: 'run', ...base };
}

/**
 * The next instant this job will fire, for the status payload and the log.
 *
 * Reporting only. Nothing schedules against it — see `dueAt()` — because a
 * precomputed fire time is exactly the state that goes wrong across a restart.
 *
 * @returns {Date}
 */
function nextFireAfter({ now, zone, target } = {}) {
  const at = now instanceof Date ? now : new Date(now);
  const todayKey = localDayKey(at, zone);
  const today = instantForLocalTime(todayKey, target, zone);
  if (today.getTime() > at.getTime()) return today;
  const tomorrow = new Date(at.getTime() + 24 * 60 * 60 * 1000);
  return instantForLocalTime(localDayKey(tomorrow, zone), target, zone);
}

module.exports = {
  DEFAULT_CATCHUP_MINUTES,
  DEFAULT_TICK_MS,
  MAX_TICK_MS,
  MIN_TICK_MS,
  WEEKDAYS,
  dueAt,
  isWeekday,
  localWeekday,
  instantForLocalTime,
  localDayKey,
  localMinuteOfDay,
  nextFireAfter,
  scheduleZone,
  targetTime,
  tickIntervalFrom
};
