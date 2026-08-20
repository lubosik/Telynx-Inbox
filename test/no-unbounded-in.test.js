'use strict';
/**
 * Structural guard against the bug that took the inbox down on 20 August 2026.
 *
 * routes/conversations.js passed all 907 contact phone numbers into `.in()`.
 * Supabase-js serialises those into the URL, producing an ~11,800-character
 * filter, which overflows Node's HTTP header limit (UND_ERR_HEADERS_OVERFLOW).
 * The request failed after ~10 seconds, the error was swallowed, and every
 * conversation came back with lastMessage: null — so the inbox showed phone
 * numbers where message previews belong, and the 25-second response made the
 * app give up with "Inbox error: cancelled".
 *
 * It broke "suddenly" only because the contact list crossed a length threshold.
 * It had been growing toward this for months.
 *
 * Two rules, enforced here rather than remembered:
 *   1. Never pass a computed array straight into `.in()` — use selectIn(),
 *      which chunks.
 *   2. Never read a table without paging — PostgREST silently caps at 1000
 *      rows, so an unpaged read goes blind rather than failing.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['routes', 'flows', 'lib', 'sync'];
const ALLOWLIST = new Set(['lib/fetch-all-rows.js']);

/**
 * A site may opt out by putting `bounded:` and a reason in a comment on the
 * `.in(` line or the line above it. That keeps each exception a deliberate,
 * reviewed decision instead of a silent pass, and any NEW unbounded `.in()`
 * still fails this test.
 */
const BOUNDED_MARKER = /bounded:/i;

function sourceFiles() {
  const out = [];
  for (const dir of SCAN_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (name.endsWith('.js')) out.push(path.join(dir, name));
    }
  }
  return out;
}

function findUnboundedIn() {
  const failures = [];

  for (const rel of sourceFiles()) {
    if (ALLOWLIST.has(rel)) continue;
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');

    text.split('\n').forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    const inCall = code.match(/\.in\(\s*['"`][^'"`]+['"`]\s*,\s*([^)]+)\)/);
    if (!inCall) return;

    const arg = inCall[1].trim();
    // A literal array of fixed values (statuses, flow types) is bounded and fine.
    if (arg.startsWith('[') && !arg.includes('...')) return;

    const lines = text.split('\n');
    // Look back a few lines: a chained Supabase call often spans several, so the
    // justification sits above `.from(...)` rather than directly above `.in(`.
    const justified = [line, lines[i - 1], lines[i - 2], lines[i - 3]]
      .some(l => BOUNDED_MARKER.test(l || ''));
    if (justified) return;

    // A named variable holding a computed list is the dangerous shape.
    failures.push(`${rel}:${i + 1}  .in(..., ${arg})  — use selectIn(), or add a \`bounded:\` comment saying why this list cannot grow`);
  });
}

  return failures;
}

test('no unbounded .in() filters — they overflow the request URL at scale', () => {
  const failures = findUnboundedIn();
  assert.deepStrictEqual(
    failures, [],
    '\n\nUnbounded .in() filters found. Each serialises every value into the URL, ' +
    'which overflows the HTTP header limit once the list grows:\n\n  ' +
    failures.join('\n  ') +
    '\n\nUse selectIn() from lib/fetch-all-rows.js, which chunks, or add a ' +
    '`bounded:` comment explaining why the list cannot grow.\n'
  );
});

module.exports = { findUnboundedIn };
