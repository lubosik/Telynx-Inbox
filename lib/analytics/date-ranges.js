'use strict';

const DEFAULT_TIME_ZONE = 'America/New_York';
const PERIODS = new Set(['today', 'week', 'month', 'year', 'all', 'custom']);

function dateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  });
  const values = Object.fromEntries(formatter.formatToParts(date)
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, Number(part.value)]));
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour === 24 ? 0 : values.hour,
    minute: values.minute,
    second: values.second
  };
}

function offsetAt(date, timeZone) {
  const parts = dateParts(date, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - date.getTime();
}

function zonedDateTimeToUTC(parts, timeZone) {
  const naive = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0);
  let result = naive - offsetAt(new Date(naive), timeZone);
  // Offsets can differ at DST boundaries; a second pass resolves that edge.
  result = naive - offsetAt(new Date(result), timeZone);
  return new Date(result);
}

function civilDate(parts) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
}

function addCivilDays(parts, days) {
  const date = civilDate(parts);
  date.setUTCDate(date.getUTCDate() + days);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function shiftCivilMonths(parts, months) {
  const first = new Date(Date.UTC(parts.year, parts.month - 1 + months, 1));
  const year = first.getUTCFullYear();
  const month = first.getUTCMonth() + 1;
  return { year, month, day: Math.min(parts.day, daysInMonth(year, month)) };
}

function parseCivilDate(value, label) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) throw new Error(`${label} must use YYYY-MM-DD.`);
  const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const date = civilDate(parts);
  if (date.getUTCFullYear() !== parts.year || date.getUTCMonth() + 1 !== parts.month || date.getUTCDate() !== parts.day) {
    throw new Error(`${label} is not a valid date.`);
  }
  return parts;
}

function localDayKey(value, timeZone = DEFAULT_TIME_ZONE) {
  const parts = dateParts(new Date(value), timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function rangeForPeriod({
  period = 'month',
  customStart,
  customEnd,
  now = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
  reliableFrom = '2026-01-17'
} = {}) {
  if (!PERIODS.has(period)) throw new Error('Unsupported analytics period.');
  // Throws immediately for invalid IANA zones rather than silently switching.
  dateParts(now, timeZone);

  const today = dateParts(now, timeZone);
  const todayCivil = { year: today.year, month: today.month, day: today.day };
  let startParts;
  let end;

  if (period === 'custom') {
    startParts = parseCivilDate(customStart, 'start');
    const endParts = parseCivilDate(customEnd, 'end');
    if (civilDate(startParts) > civilDate(endParts)) throw new Error('Custom start must not be after end.');
    end = zonedDateTimeToUTC(addCivilDays(endParts, 1), timeZone);
  } else if (period === 'today') {
    startParts = todayCivil;
    end = now;
  } else if (period === 'week') {
    const weekday = civilDate(todayCivil).getUTCDay();
    startParts = addCivilDays(todayCivil, -(weekday === 0 ? 6 : weekday - 1));
    end = now;
  } else if (period === 'month') {
    startParts = { year: today.year, month: today.month, day: 1 };
    end = now;
  } else if (period === 'year') {
    startParts = { year: today.year, month: 1, day: 1 };
    end = now;
  } else {
    startParts = parseCivilDate(reliableFrom, 'reliableFrom');
    end = now;
  }

  const start = zonedDateTimeToUTC(startParts, timeZone);
  if (start >= end) throw new Error('Analytics range is empty.');

  let previous = null;
  if (period !== 'all' && period !== 'custom') {
    let previousStartParts;
    let previousEndDate;
    const wallTime = { hour: today.hour, minute: today.minute, second: today.second };
    if (period === 'today') {
      previousStartParts = addCivilDays(todayCivil, -1);
      previousEndDate = { ...previousStartParts, ...wallTime };
    } else if (period === 'week') {
      previousStartParts = addCivilDays(startParts, -7);
      previousEndDate = { ...addCivilDays(todayCivil, -7), ...wallTime };
    } else if (period === 'month') {
      previousStartParts = shiftCivilMonths(startParts, -1);
      previousEndDate = { ...shiftCivilMonths(todayCivil, -1), ...wallTime };
    } else {
      previousStartParts = { year: startParts.year - 1, month: 1, day: 1 };
      const comparable = { year: today.year - 1, month: today.month, day: today.day };
      comparable.day = Math.min(comparable.day, daysInMonth(comparable.year, comparable.month));
      previousEndDate = { ...comparable, ...wallTime };
    }
    previous = {
      start: zonedDateTimeToUTC(previousStartParts, timeZone),
      end: zonedDateTimeToUTC(previousEndDate, timeZone)
    };
  }

  return { period, start, end, previous, timeZone };
}

module.exports = {
  DEFAULT_TIME_ZONE,
  PERIODS,
  localDayKey,
  rangeForPeriod,
  zonedDateTimeToUTC
};
