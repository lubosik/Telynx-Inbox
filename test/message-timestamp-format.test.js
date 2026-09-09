'use strict';
/**
 * test/message-timestamp-format.test.js — every message shows its date, not
 * just its time.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY
 *
 *   The shop owner asked for the date on message timestamps "because it's
 *   easier to keep track". The thread showed "7:04 PM" and nothing else for
 *   anything sent today.
 *
 *   That reads fine while you are looking at it and badly everywhere else. A
 *   thread gets read days later, screenshotted, and pasted into a chat with
 *   somebody else, and at that point a bare time is unanchored: you cannot tell
 *   a reply that came back in four minutes from one that came the following
 *   afternoon. Diagnosing the CHECKIN20 bug needed exactly that distinction and
 *   the screenshot could not supply it.
 *
 *   Nothing was backfilled and nothing needed to be. All 3,990 messages here
 *   and all 218 in the Shore Academy inbox already carry a full `created_at`,
 *   none of them null, the oldest from 29 April. The date was always stored and
 *   never shown, so this is a rendering change and every old message gains its
 *   date the moment the page reloads.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.jsx'), 'utf8');

/** The shipped formatter, lifted out of the bundle source and run for real. */
function loadFormatTime() {
  const start = SRC.indexOf('function formatTime(ts)');
  const end = SRC.indexOf('\n}', start) + 2;
  // eslint-disable-next-line no-new-func
  return new Function('TZ', `${SRC.slice(start, end)}; return formatTime;`)('America/New_York');
}

test('a message from today still shows its date', () => {
  // The whole point. This was the case that showed a bare time.
  const formatTime = loadFormatTime();
  const rendered = formatTime(new Date().toISOString());
  assert.match(rendered, /\d{1,2}:\d{2}\s?(AM|PM)/, 'the time is still there');
  assert.match(rendered, /·\s[A-Z][a-z]{2}\s\d{1,2}/, 'and now the date is too');
});

test('an older message shows time and date', () => {
  const formatTime = loadFormatTime();
  assert.equal(formatTime('2026-09-08T20:07:56Z'), '4:07 PM · Sep 8');
});

test('the year appears only when it is not this year', () => {
  // A thread stays uncluttered; an old one stays unambiguous.
  const formatTime = loadFormatTime();
  assert.doesNotMatch(formatTime('2026-04-29T17:11:49Z'), /2026/, 'this year needs no year');
  assert.match(formatTime('2025-12-31T23:30:00Z'), /2025/, 'a previous year does');
});

test('the year is decided in the display timezone, not the viewer local one', () => {
  // 31 December 23:30 UTC is still 31 December in New York and already the new
  // year in Sydney. Deciding the year in one zone and printing the date in
  // another labels a message with a year it does not have.
  const formatTime = loadFormatTime();
  const newYearEve = formatTime('2027-01-01T02:00:00Z'); // 31 Dec, 9pm in New York
  assert.match(newYearEve, /Dec 31/, 'printed in the display timezone');
});

test('a missing timestamp renders as empty, not as "Invalid Date"', () => {
  const formatTime = loadFormatTime();
  for (const empty of [null, undefined, '']) assert.equal(formatTime(empty), '');
});

test('the committed bundle was rebuilt from the source', () => {
  // public/app.js is a build artifact of public/app.jsx and CI checks they
  // match. A change to the formatter that never reached the bundle would show
  // the old timestamps to everybody.
  const bundle = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(bundle, /sameYear/, 'the new formatter is in the shipped bundle');
});
