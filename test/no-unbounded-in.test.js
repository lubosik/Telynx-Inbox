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
const SCAN_DIRS = ['routes', 'flows', 'lib', 'sync', 'scripts'];

/**
 * Files exempted from the scan, each with the reason it is exempt. A bare list
 * of paths decays into "things somebody once found inconvenient"; the reason is
 * the part that a future reader can disagree with.
 */
const ALLOWLIST = new Map([
  [
    'lib/fetch-all-rows.js',
    'This is the fix. selectIn() is the chunking helper every other call site ' +
    'is told to use, so its own .in() is bounded by construction.'
  ],
  [
    'check-failed-orders.js',
    'Standalone diagnostic, run by hand from a terminal. It is not required by ' +
    'server.js, any route, any flow, or any cron: `grep -rn "check-failed-orders"` ' +
    'matches nothing outside the file itself. Its three .in() calls take phone ' +
    'lists read from sms_sent_log, so they CAN grow and this file WILL eventually ' +
    'fail when run — but it fails in one operator\'s terminal, not in the request ' +
    'path, and rewriting an unwired diagnostic was out of scope for the audit ' +
    'that added this entry. Fix it or delete it before wiring it into anything.'
  ]
]);

/**
 * A site may opt out by putting `bounded:` and a reason in a comment on the
 * `.in(` line or the line above it. That keeps each exception a deliberate,
 * reviewed decision instead of a silent pass, and any NEW unbounded `.in()`
 * still fails this test.
 */
const BOUNDED_MARKER = /bounded:/i;

/**
 * Recursive. It was not, and that is precisely why the live instance of this
 * bug in `lib/analytics/events.js` shipped: the scan read only the top level of
 * each directory, so every file under `lib/analytics/`, `lib/audit/` and
 * `routes/`'s subdirectories was invisible to the guard written to protect
 * them. A guard that cannot see the code it guards is worse than no guard,
 * because it also produces a green tick.
 */
function walk(dir) {
  const absolute = path.join(ROOT, dir);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules') return [];
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(relative);
    return entry.isFile() && entry.name.endsWith('.js') ? [relative] : [];
  });
}

/** Repo-root scripts (`check-failed-orders.js`, `sync-ghl.js`, `telnyx.js`, ...). */
function rootFiles() {
  return fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => entry.name);
}

function sourceFiles() {
  return [...SCAN_DIRS.flatMap(walk), ...rootFiles()];
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

test('the scan reaches nested directories, repo-root scripts, and scripts/', () => {
  // Guard the guard. This scan used to be one level deep, so `lib/analytics/`
  // and `lib/audit/` were never read and a live unbounded `.in()` in
  // lib/analytics/events.js passed CI for its whole life. Assert on the file
  // list itself; a green tick from an empty scan is indistinguishable from a
  // green tick from a clean one.
  const files = sourceFiles();
  for (const expected of [
    path.join('lib', 'analytics', 'events.js'),   // nested — the file that was missed
    path.join('lib', 'audit', 'redact.js'),       // nested
    path.join('lib', 'fetch-all-rows.js'),        // top level of a scanned dir
    path.join('routes', 'conversations.js'),      // the original outage site
    path.join('scripts', 'backfill-analytics.js'),// scripts/ is now scanned
    'sync-ghl.js'                                 // repo root is now scanned
  ]) {
    assert.ok(files.includes(expected), `${expected} must be inside the scan, but is not`);
  }
  assert.ok(files.length > 25, `expected a broad scan, got only ${files.length} files`);
  assert.ok(!files.some(file => file.split(path.sep).includes('node_modules')));
});

test('every allowlist entry states a reason, and none of them is load-bearing code', () => {
  // An allowlist without reasons becomes a place to hide failures.
  //
  // Existence is deliberately NOT asserted. An entry may name a file that is
  // untracked, or deleted, or simply absent from a given checkout —
  // check-failed-orders.js is untracked, so asserting existence passed on the
  // machine that wrote this test and failed in CI on a clean clone. What
  // matters is that the entry is justified and that it does not silence a file
  // the server actually depends on.
  for (const [file, reason] of ALLOWLIST) {
    assert.ok(typeof reason === 'string' && reason.length > 40,
      `${file} is allowlisted without a stated reason`);

    if (!fs.existsSync(path.join(ROOT, file))) continue;

    // An allowlisted file must not be reachable from the running server.
    // Silencing the guard for a hand-run diagnostic is a judgement call;
    // silencing it for something on the request path is how the outage happens
    // again.
    const basename = path.basename(file, '.js');
    const required = sourceFiles()
      .filter(other => other !== file)
      .some(other => new RegExp(`require\\(['"\`][^'"\`]*${basename}['"\`]\\)`)
        .test(fs.readFileSync(path.join(ROOT, other), 'utf8')));

    if (file === 'lib/fetch-all-rows.js') continue; // the helper itself, required everywhere by design
    assert.equal(required, false,
      `${file} is allowlisted but is required by other source — it is on the ` +
      'request path and must be fixed, not silenced');
  }
});

test('the detector still catches the exact shape that took the inbox down', () => {
  // routes/conversations.js: every contact phone, straight into the URL.
  const broken = "    .in('contact_phone', phones)";
  const code = broken.replace(/\/\/.*$/, '');
  const inCall = code.match(/\.in\(\s*['"`][^'"`]+['"`]\s*,\s*([^)]+)\)/);
  assert.ok(inCall, 'the regex must match a computed-array .in()');
  const arg = inCall[1].trim();
  assert.equal(arg.startsWith('['), false, 'a bare identifier is not a literal array');
  assert.equal(BOUNDED_MARKER.test(broken), false, 'and carries no bounded: justification');
});

module.exports = { findUnboundedIn, sourceFiles, ALLOWLIST };
