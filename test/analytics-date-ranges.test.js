'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { localDayKey, rangeForPeriod } = require('../lib/analytics/date-ranges');

test('today uses midnight in the business timezone and compares equal duration', () => {
  const range = rangeForPeriod({
    period: 'today',
    now: new Date('2026-08-20T15:30:00.000Z'),
    timeZone: 'America/New_York'
  });
  assert.equal(range.start.toISOString(), '2026-08-20T04:00:00.000Z');
  assert.equal(range.end.toISOString(), '2026-08-20T15:30:00.000Z');
  assert.equal(range.previous.start.toISOString(), '2026-08-19T04:00:00.000Z');
  assert.equal(range.previous.end.toISOString(), '2026-08-19T15:30:00.000Z');
});

test('month compares the same elapsed portion of the previous calendar month', () => {
  const range = rangeForPeriod({
    period: 'month',
    now: new Date('2026-08-20T15:30:00.000Z'),
    timeZone: 'America/New_York'
  });
  assert.equal(range.previous.start.toISOString(), '2026-07-01T04:00:00.000Z');
  assert.equal(range.previous.end.toISOString(), '2026-07-20T15:30:00.000Z');
});

test('week starts on Monday in the business timezone', () => {
  const range = rangeForPeriod({
    period: 'week',
    now: new Date('2026-08-20T15:30:00.000Z'),
    timeZone: 'America/New_York'
  });
  assert.equal(range.start.toISOString(), '2026-08-17T04:00:00.000Z');
});

test('custom end date is inclusive and DST-safe', () => {
  const range = rangeForPeriod({
    period: 'custom',
    customStart: '2026-03-07',
    customEnd: '2026-03-09',
    timeZone: 'America/New_York'
  });
  assert.equal(range.start.toISOString(), '2026-03-07T05:00:00.000Z');
  assert.equal(range.end.toISOString(), '2026-03-10T04:00:00.000Z');
  assert.equal(range.previous, null);
});

test('all time defaults to the earliest reliable business-local date', () => {
  const range = rangeForPeriod({
    period: 'all',
    now: new Date('2026-08-20T00:00:00.000Z'),
    timeZone: 'America/New_York'
  });
  assert.equal(range.start.toISOString(), '2026-01-16T05:00:00.000Z');
  assert.equal(range.previous, null);
});

test('rejects malformed or inverted custom ranges', () => {
  assert.throws(() => rangeForPeriod({ period: 'custom', customStart: '2026-02-30', customEnd: '2026-03-01' }));
  assert.throws(() => rangeForPeriod({ period: 'custom', customStart: '2026-03-02', customEnd: '2026-03-01' }));
});

test('local day keys respect business timezone boundaries', () => {
  assert.equal(localDayKey('2026-08-20T02:00:00.000Z', 'America/New_York'), '2026-08-19');
  assert.equal(localDayKey('2026-08-20T05:00:00.000Z', 'America/New_York'), '2026-08-20');
});
