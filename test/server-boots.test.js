'use strict';
/**
 * test/server-boots.test.js — does the thing start?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS TEST EXISTS
 *
 *   1947 tests passed and `node server.js` died before binding a port:
 *
 *     ReferenceError: Cannot access 'sharedOpportunityPortfolio'
 *     before initialization
 *
 *   A shared opportunity-portfolio singleton was declared with `let` below the
 *   first `app.use` that called it. The FUNCTION was hoisted, so the call
 *   looked fine; the `let` was still in its temporal dead zone, so the body
 *   was not. Every route in the app was down, not just the new one.
 *
 *   No existing test could catch it. The suite requires routers and libraries
 *   directly, deliberately, so that route tests need no credentials — which
 *   means nothing ever loaded server.js itself. The one file whose whole job
 *   is wiring everything together was the one file never exercised.
 *
 *   Found by a reviewing subagent, not by the suite. This is the suite
 *   catching it next time.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * HOW IT RUNS
 *
 *   In a child process, because server.js registers timers and an Express app
 *   at import and there is no way to unwind that inside the test runner. The
 *   child requires the module and exits 0 if it survives; any throw at load
 *   is a non-zero exit and the stderr is reported verbatim.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('server.js loads without throwing', () => {
  let stderr = '';
  try {
    execFileSync(
      process.execPath,
      ['-e', 'require(process.argv[1]); process.exit(0);', path.join(ROOT, 'server.js')],
      {
        cwd: ROOT,
        timeout: 60_000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Port 0 so a developer already running the server locally does not
          // fail this with EADDRINUSE, which would be a false red.
          PORT: '0',
          NODE_ENV: 'test'
        }
      }
    );
  } catch (error) {
    stderr = String(error.stderr || error.stdout || error.message);
    assert.fail(
      'server.js could not be loaded, so the deployed app would not start.\n\n'
      + stderr.split('\n').slice(0, 25).join('\n')
    );
  }
});

test('no route is mounted with a value that is not yet initialised', () => {
  // The specific shape of the bug, guarded structurally as well as by the boot
  // above: anything a mount CALLS must be declared before the mount runs.
  // `function` declarations hoist and `let`/`const` do not, so a helper that
  // closes over a `let` is only safe if that `let` is above the first caller.
  const fs = require('node:fs');
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const lines = source.split('\n');

  const firstMount = lines.findIndex(line => /^app\.use\('\/api\//.test(line));
  assert.ok(firstMount > 0, 'expected at least one API mount');

  // Every module-level `let`/`const` that a mount line calls as a function.
  const called = new Set();
  for (const line of lines.slice(firstMount)) {
    for (const match of line.matchAll(/\b([a-z][A-Za-z0-9]*)\(\)/g)) called.add(match[1]);
  }

  for (const name of called) {
    const declared = lines.findIndex(line =>
      new RegExp(`^(?:let|const|var)\\s+${name}\\b`).test(line));
    if (declared === -1) continue; // a function declaration, which hoists
    assert.ok(declared < firstMount,
      `server.js declares "${name}" on line ${declared + 1}, after the first route mount on `
      + `line ${firstMount + 1}, but a mount calls it. let and const do not hoist, so this `
      + 'throws a ReferenceError at boot and takes the whole app down.');
  }
});
