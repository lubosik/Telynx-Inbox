'use strict';
/**
 * A Supabase query builder is a thenable, not a Promise. It implements `then`
 * and nothing else — `catch` and `finally` are undefined. So this shape:
 *
 *     await supabase.from('t').insert({...}).catch(() => {});
 *
 * does not "ignore errors". It throws `TypeError: ...insert(...).catch is not
 * a function` BEFORE the request is ever dispatched, and every statement after
 * it in the same block is skipped.
 *
 * That is not hypothetical. It sat in `markOptedOut` and in the Telnyx STOP
 * branch of routes/webhook.js, so an inbound STOP died at its first statement:
 * no opt-out sentinel written, no queued sequences cancelled, no record of the
 * message, and no broadcast. Both looked like deliberate best-effort error
 * handling, and the webhook's outer try/catch hid the crash.
 *
 * PostgREST reports failures in `error`, never as a rejection, so the correct
 * shape is a try/catch around the await and a check of `error`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['routes', 'flows', 'lib', 'sync', 'scripts'];

/**
 * What a Supabase query builder chain can be rooted in, in THIS repository.
 *
 * The pattern used to require the literal identifier `supabase`. That covered
 * the two historical bugs and nothing else: 26 live builder chains are rooted
 * in `db()` (the lazy accessor in routes/auth.js, routes/users.js,
 * routes/invitations.js and lib/authz.js), in a `client` parameter (all of
 * lib/analytics/, lib/apns-notify.js, lib/private-recordings.js,
 * scripts/backfill-*.js), or in `injected` (the test seam in
 * routes/invitations.js). Every one of those is the same thenable-with-no-catch
 * as `supabase` itself, and every one of them is in code added by this release
 * — the exact place a new instance of the bug would appear.
 *
 * Deliberately narrow: matching *any* identifier before `.from(` would flag
 * ordinary Promise-returning helpers and train people to ignore this test.
 */
const BUILDER_ROOTS = ['supabase', 'db\\(\\)', 'client', 'injected'];
const BUILDER_ROOT_PATTERN = new RegExp(
  `(?:^|[^\\w$])(?:${BUILDER_ROOTS.join('|')})\\s*\\.?\\s*\\n?\\s*\\.(from|rpc)\\s*\\(`
);

/** Recursive — subdirectories count. */
function sourceFiles(dir) {
  const absolute = path.join(ROOT, dir);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules') return [];
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(relative);
    return entry.isFile() && entry.name.endsWith('.js') ? [relative] : [];
  });
}

function findings() {
  const failures = [];
  const files = [...SCAN_DIRS.flatMap(sourceFiles), 'server.js', 'db.js']
    .filter(file => fs.existsSync(path.join(ROOT, file)));

  for (const file of files) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      const code = line.split('//')[0];
      if (!/\.(catch|finally)\s*\(/.test(code)) return;

      // Walk back to the start of the statement. A builder chain is written
      // across several lines, so the `supabase.from(...)` that opens it is
      // rarely on the same line as the `.catch(` that closes it.
      //
      // The slice must end AT the `.catch(`, not at the end of the line. The
      // line usually ends in `;`, and cutting at the last semicolon in the
      // whole window leaves an empty string — which matches nothing and makes
      // this entire guard silently vacuous.
      const start = Math.max(0, index - 12);
      const statement = lines.slice(start, index + 1).join('\n');
      const catchAt = statement.search(/\.(catch|finally)\s*\(/);
      const tail = statement.slice(statement.lastIndexOf(';', catchAt) + 1, catchAt);

      // Only a chain rooted in a query builder is wrong. `someAsyncFn().catch()`
      // is a real Promise and perfectly fine.
      if (!BUILDER_ROOT_PATTERN.test(tail)) return;
      // ...unless the chain already went through `.then()`, which returns a
      // genuine Promise and makes `.catch` legitimate again.
      if (/\.then\s*\(/.test(tail.slice(tail.search(/\.(from|rpc)\s*\(/)))) return;

      failures.push(
        `${file}:${index + 1}  ${code.trim().slice(0, 80)}` +
        '  — a query builder has no .catch(); use try/catch and check `error`'
      );
    });
  }
  return failures;
}

test('no .catch() on a Supabase query builder — it throws instead of ignoring', () => {
  const failures = findings();
  assert.deepStrictEqual(
    failures,
    [],
    '\n\nA Supabase query builder is a thenable with `then` only. Calling ' +
    '`.catch()` on one throws a TypeError before the query is sent, silently ' +
    'skipping every statement that follows:\n\n  ' +
    failures.join('\n  ') + '\n'
  );
});

/** The slice the real detector feeds to BUILDER_ROOT_PATTERN. */
function tailOf(statement) {
  const catchAt = statement.search(/\.(catch|finally)\s*\(/);
  assert.ok(catchAt > -1, 'the shape must end in .catch( or .finally(');
  return statement.slice(statement.lastIndexOf(';', catchAt) + 1, catchAt);
}

test('the detector recognises the exact shape that broke the STOP branch', () => {
  // Guard the guard: the regression that motivated this file must be caught.
  // Asserted against BUILDER_ROOT_PATTERN, the regex the scan actually uses,
  // so widening that constant can never quietly stop matching this shape.
  const broken = [
    "  await supabase.from('sms_sent_log').upsert({",
    "    order_id: orderId,",
    "    flow_type: 'opted-out'",
    "  }, { onConflict: 'order_id,flow_type' }).catch(() => {});"
  ].join('\n');

  assert.ok(BUILDER_ROOT_PATTERN.test(tailOf(broken)),
    'and the detector traces it back to a query builder');
});

test('the detector also sees chains rooted in db(), client and injected', () => {
  // These three roots hold 26 live builder chains in this repository and were
  // all invisible while the pattern demanded the literal identifier
  // `supabase`. Every new file in this release uses one of them.
  const shapes = [
    "      db().from('sms_users').update(patch).eq('id', user.id).catch(() => {});",
    "      const r = await db().rpc('redeem_sms_invitation', { p: 1 }).catch(() => {});",
    "  await client.from('ios_push_devices').update({ x: 1 }).catch(() => {});",
    "  await client.rpc('promote_analytics_backfill', {}).catch(() => {});",
    "    await injected.from('sms_invitations').select('id').catch(() => {});",
    [
      "  await client",
      "    .from('call_logs')",
      "    .update({ recording_storage_path: null })",
      "    .catch(() => {});"
    ].join('\n')
  ];
  for (const shape of shapes) {
    assert.ok(BUILDER_ROOT_PATTERN.test(tailOf(shape)), `missed: ${shape.split('\n')[0].trim()}`);
  }
});

test('the detector does not flag a real Promise that merely ends in .catch()', () => {
  // A guard that fires on ordinary async helpers gets ignored, and an ignored
  // guard is the same as a deleted one. These shapes are all correct code.
  const fine = [
    "  sendPush(payload).catch(err => console.error(err.message));",
    "  const text = await res.text().catch(() => '');",
    "  main().then(() => process.exit(0)).catch(err => process.exit(1));",
    "  await fetchAllRows(supabase, 'sms_contacts', 'id').catch(() => []);",
    "  await reader.cancel().catch(() => {});",
    "  const clientSecret = await resolve().catch(() => null);"
  ];
  for (const shape of fine) {
    assert.equal(BUILDER_ROOT_PATTERN.test(tailOf(shape)), false, `false positive: ${shape.trim()}`);
  }
});

test('a builder chain that goes through .then() first is still allowed', () => {
  // `.then()` returns a genuine Promise, so `.catch()` after it is valid.
  const viaThen = "  supabase.from('t').select('id').then(handle).catch(err => log(err));";
  const tail = tailOf(viaThen);
  assert.ok(BUILDER_ROOT_PATTERN.test(tail), 'the root is still recognised');
  assert.ok(/\.then\s*\(/.test(tail.slice(tail.search(/\.(from|rpc)\s*\(/))),
    'but the .then() exemption applies');
});

module.exports = { BUILDER_ROOT_PATTERN, findings };
