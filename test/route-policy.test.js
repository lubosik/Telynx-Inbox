'use strict';
/**
 * Bijection between lib/route-policy.js and the endpoints actually registered
 * on the Express app.
 *
 * The point is that adding an endpoint without a policy fails CI rather than
 * shipping open, and that deleting an endpoint without deleting its policy
 * leaves a dangling rule nobody notices. Both directions are asserted.
 *
 * server.js is read as text and its `/api` mounts are parsed out, rather than
 * required. Requiring it would call app.listen(), connect to Supabase, and
 * start four background jobs, none of which belongs in an offline unit test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Route modules construct a Supabase client at require time. These are
// syntactically valid placeholders; nothing in this file makes a request.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://offline.test.invalid';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'offline-test-key';

const { ROUTE_POLICY, PASSWORD_CHANGE_EXEMPT } = require('../lib/route-policy');
const { compilePolicy, findPolicy, normalisePath } = require('../lib/enforce-policy');

const ROOT = path.join(__dirname, '..');
const SERVER_SOURCE = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

/**
 * Routers whose policy entries exist but whose `app.use` line is added by the
 * server.js wiring diff handed over with this change.
 *
 * DELETE AN ENTRY THE MOMENT server.js MOUNTS IT. The first test below fails
 * if a router is listed here AND already mounted, so this list cannot rot into
 * a permanent exemption.
 */
const AWAITING_SERVER_WIRING = [];

/** Arguments good enough to construct each router factory offline. */
function factoryArguments(moduleName) {
  switch (moduleName) {
    case 'sse': return [new Set()];
    case 'send':
    case 'react': return [() => {}];
    default: return [];
  }
}

function loadRouter(moduleName) {
  const loaded = require(path.join(ROOT, 'routes', `${moduleName}.js`));
  // An Express Router is itself a function, so `typeof` cannot tell a router
  // from a factory. A router has a middleware stack; a factory does not.
  if (loaded && Array.isArray(loaded.stack)) return loaded;
  return loaded(...factoryArguments(moduleName));
}

/** Every `app.use('/api/...', ..., require('./routes/x')...)` line in server.js. */
function parseServerMounts(source) {
  const pattern = /app\.use\(\s*'(\/api[^']*)'[^\n]*?require\('\.\/routes\/([\w-]+)'\)/g;
  const mounts = [];
  let found;
  while ((found = pattern.exec(source)) !== null) {
    mounts.push({ mount: found[1], module: found[2] });
  }
  return mounts;
}

/** mount + router stack -> the full method/path pairs the app answers. */
function registeredEndpoints(mounts) {
  const endpoints = [];
  for (const { mount, module: moduleName } of mounts) {
    const router = loadRouter(moduleName);
    for (const layer of router.stack) {
      if (!layer.route) continue;
      const suffix = layer.route.path === '/' ? '' : layer.route.path;
      for (const [method, enabled] of Object.entries(layer.route.methods)) {
        if (!enabled || method === '_all') continue;
        endpoints.push({
          method: method.toUpperCase(),
          path: normalisePath(`${mount}${suffix}`),
          source: `routes/${moduleName}.js`
        });
      }
    }
  }
  return endpoints;
}

function signature(entry) {
  return `${entry.method} ${entry.path}`;
}

function allMounts() {
  const fromServer = parseServerMounts(SERVER_SOURCE);
  const mountedPaths = new Set(fromServer.map(entry => entry.mount));
  const pending = AWAITING_SERVER_WIRING.filter(entry => !mountedPaths.has(entry.mount));
  return [...fromServer, ...pending];
}

test('AWAITING_SERVER_WIRING contains only routers server.js has not mounted yet', () => {
  const mountedPaths = new Set(parseServerMounts(SERVER_SOURCE).map(entry => entry.mount));
  const stale = AWAITING_SERVER_WIRING.filter(entry => mountedPaths.has(entry.mount));
  assert.deepEqual(
    stale, [],
    '\n\nThese routers are mounted in server.js and must be removed from ' +
    'AWAITING_SERVER_WIRING in this file:\n  ' +
    stale.map(entry => entry.mount).join('\n  ') + '\n'
  );
});

test('every registered /api endpoint has exactly one policy entry', () => {
  const registered = registeredEndpoints(allMounts());
  const policed = new Set(ROUTE_POLICY.map(signature));

  const unpoliced = registered
    .filter(entry => !policed.has(signature(entry)))
    .map(entry => `${signature(entry)}  (${entry.source})`);

  assert.deepEqual(
    unpoliced, [],
    '\n\nEndpoints with no authorisation policy. Each one is DENIED at runtime ' +
    'with POLICY_MISSING until it is added to lib/route-policy.js:\n\n  ' +
    unpoliced.join('\n  ') + '\n'
  );
});

test('every policy entry corresponds to a registered endpoint', () => {
  const registered = new Set(registeredEndpoints(allMounts()).map(signature));
  const dangling = ROUTE_POLICY
    .map(signature)
    .filter(entry => !registered.has(entry));

  assert.deepEqual(
    dangling, [],
    '\n\nPolicy entries with no matching route. Either the endpoint was removed ' +
    'and its policy was not, or the path is a typo:\n\n  ' +
    dangling.join('\n  ') + '\n'
  );
});

test('the policy table compiles, with no duplicates and no implicit permission', () => {
  assert.doesNotThrow(() => compilePolicy());

  assert.throws(
    () => compilePolicy([
      { method: 'GET', path: '/api/thing', permission: null },
      { method: 'GET', path: '/api/thing', permission: 'user.read' }
    ]),
    /Duplicate policy entry/
  );

  // A missing `permission` key must be a boot failure, never a silent
  // "anybody may do this". Writing `permission: null` is how you say that.
  assert.throws(
    () => compilePolicy([{ method: 'GET', path: '/api/thing' }]),
    /has no `permission` key/
  );
});

test('literal paths win over parameterised ones regardless of table order', () => {
  // GET /api/voice/logs/:id would happily swallow /api/voice/logs/seen.
  const shadowed = [
    { method: 'GET', path: '/api/voice/logs/:id', permission: 'call.read' },
    { method: 'GET', path: '/api/voice/logs/seen', permission: 'user.manage' }
  ];
  assert.equal(findPolicy('GET', '/api/voice/logs/seen', shadowed).path, '/api/voice/logs/seen');
  assert.equal(findPolicy('GET', '/api/voice/logs/1234', shadowed).path, '/api/voice/logs/:id');

  // And in the live table, which lists the parameterised entry first.
  assert.equal(findPolicy('POST', '/api/voice/logs/seen').permission, 'call.read');
  assert.equal(findPolicy('GET', '/api/voice/logs/9').permission, 'call.read');
  assert.equal(findPolicy('GET', '/api/users/me').permission, null);
  assert.equal(findPolicy('PATCH', '/api/users/7').permission, 'user.manage');
  assert.equal(findPolicy('POST', '/api/users/me/password').permission, null);
  assert.equal(findPolicy('POST', '/api/users/7/deactivate').permission, 'user.manage');
});

test('the only endpoints open to any authenticated actor act on the caller\'s own account', () => {
  // This list is exhaustive and hardcoded on purpose: `permission: null` is the
  // one way to ship an endpoint every Support Agent can call, so growing the
  // set has to be a deliberate edit here rather than a line quietly added to
  // the table. Two properties must hold for every entry, and both are asserted
  // rather than described.
  const open = ROUTE_POLICY.filter(entry => entry.permission === null).map(signature).sort();
  assert.deepEqual(open, [
    'GET /api/users/me',
    // The IANA picker list. A constant document with no account state in it,
    // open because choosing your own display time zone is open, and under /me
    // because every open endpoint in this table has to be.
    'GET /api/users/me/timezones',
    'PATCH /api/users/me',
    'POST /api/users/me/email',
    'POST /api/users/me/email/cancel',
    'POST /api/users/me/onboarding',
    'POST /api/users/me/password'
  ]);

  // 1. Every one of them is under /api/users/me. An open endpoint that took a
  //    :id would let an Agent act on somebody else.
  for (const entry of open) {
    assert.ok(
      entry.includes(' /api/users/me'),
      `${entry} is open to every actor but is not an /api/users/me endpoint`
    );
    assert.ok(
      !entry.includes('/:'),
      `${entry} is open to every actor and takes a path parameter, so it can be pointed at another person`
    );
  }

  // 2. The password-rotation escape hatch is still there. A must_change_password
  //    account can reach exactly these two and nothing else, so the forced
  //    rotation is not a dead end.
  assert.deepEqual(
    PASSWORD_CHANGE_EXEMPT.map(entry => `${entry.method} ${entry.path}`).sort(),
    ['GET /api/users/me', 'POST /api/users/me/password']
  );
});

test('the previously ungated backfill endpoint now requires admin.backfill', () => {
  // POST /api/voice/backfill-recordings ran the same job as
  // /admin/backfill/recordings but sat behind session auth only, so any signed
  // in browser could pull every recording in the Telnyx account.
  assert.equal(findPolicy('POST', '/api/voice/backfill-recordings').permission, 'admin.backfill');
});

test('query strings, trailing slashes and doubled slashes cannot dodge the policy', () => {
  assert.equal(normalisePath('/api/conversations?page=2'), '/api/conversations');
  assert.equal(normalisePath('/api/conversations/'), '/api/conversations');
  assert.equal(normalisePath('//api//conversations'), '/api/conversations');
  assert.equal(findPolicy('GET', '/api/analytics/overview?period=year').permission, 'analytics.read');
  assert.equal(findPolicy('GET', '//api//analytics//overview/').permission, 'analytics.read');
});

// ── The `audit: true` flag ─────────────────────────────────────────────────

/**
 * `audit: true` was decorative. `lib/enforce-policy.js` copies it onto
 * `req.policy` and does nothing else with it, so the flag only means anything
 * if the handler writes the row itself — and
 * `POST /api/voice/backfill-recordings` carried the flag with no audit call at
 * all. That is the worst kind of wrong: the policy table, which is meant to be
 * the single readable answer to "what is covered?", asserted coverage that did
 * not exist, and there was no way to tell the real entries from the decorative
 * ones without opening every handler.
 *
 * So the flag is enforced here instead of trusted.
 */
function handlerSourceFor(entry) {
  const mounts = parseServerMounts(SERVER_SOURCE)
    .filter(mount => entry.path === mount.mount || entry.path.startsWith(`${mount.mount}/`))
    .sort((a, b) => b.mount.length - a.mount.length);
  assert.ok(mounts.length, `${signature(entry)} matches no /api mount in server.js`);

  const { mount, module: moduleName } = mounts[0];
  const relative = entry.path.slice(mount.length) || '/';
  const file = path.join('routes', `${moduleName}.js`);
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');

  const opener = new RegExp(
    `router\\.${entry.method.toLowerCase()}\\(\\s*['\`]${relative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['\`]`
  );
  const start = source.search(opener);
  assert.ok(start > -1, `${signature(entry)} has no matching router.${entry.method.toLowerCase()}() in ${file}`);

  const rest = source.slice(start + 1);
  const nextHandler = rest.search(/\n\s*router\.[a-z]+\s*\(/);
  return { file, body: nextHandler === -1 ? rest : rest.slice(0, nextHandler) };
}

/**
 * Names that write an audit row when called, for one route file.
 *
 * `logAudit`/`logAuditSafely` plus any same-file function that wraps them.
 * routes/sync.js and routes/catchup.js both audit through a local helper
 * (`auditSyncStarted`, `auditCatchupRun`) rather than inline, and treating
 * that as "no audit" would be a false positive that gets this test deleted.
 */
function auditWriterNames(source) {
  const names = new Set(['logAudit', 'logAuditSafely']);
  const declaration = /(?:async\s+)?function\s+(\w+)\s*\(/g;
  let found;
  while ((found = declaration.exec(source)) !== null) {
    const rest = source.slice(found.index + found[0].length);
    const next = rest.search(/\n(?:async\s+)?function\s+\w+\s*\(|\n\s*router\.[a-z]+\s*\(/);
    const body = next === -1 ? rest : rest.slice(0, next);
    if (/\blogAudit(Safely)?\s*\(/.test(body)) names.add(found[1]);
  }
  return names;
}

test('every audit: true route actually writes an audit row', () => {
  const flagged = ROUTE_POLICY.filter(entry => entry.audit === true);
  assert.ok(flagged.length >= 15, `expected the audited set to be substantial, got ${flagged.length}`);

  const decorative = [];
  for (const entry of flagged) {
    const { file, body } = handlerSourceFor(entry);
    const writers = auditWriterNames(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    const writes = [...writers].some(name => new RegExp(`\\b${name}\\s*\\(`).test(body));
    if (!writes) decorative.push(`${signature(entry)}  (${file})`);
  }

  assert.deepStrictEqual(
    decorative, [],
    '\n\nThese routes are marked `audit: true` in lib/route-policy.js but their ' +
    'handlers never call logAudit/logAuditSafely, so the flag records nothing:\n\n  ' +
    decorative.join('\n  ') +
    '\n\nInstrument the handler, or drop the flag. A flag that means nothing ' +
    'teaches the next reader that none of them mean anything.\n'
  );
});

test('the recording backfill is audited as a sync, triggered and finished', () => {
  // It enumerates EVERY recording in the Telnyx account and writes storage
  // paths onto call_logs. One row saying it started is not enough to answer
  // "did it finish, and what did it change?".
  const { body } = handlerSourceFor(findPolicyEntry('POST', '/api/voice/backfill-recordings'));
  for (const eventType of ['settings.sync.triggered', 'settings.sync.completed', 'settings.sync.failed']) {
    assert.ok(body.includes(eventType), `the handler must emit ${eventType}`);
  }
  // logAuditSafely, never logAudit: an audit write must not break the operation
  // it describes, and this one runs inside the same try as the backfill.
  assert.equal(/\blogAudit\s*\(/.test(body), false,
    'use logAuditSafely here so a failed audit cannot fail the backfill');
});

/** ROUTE_POLICY lookup by exact signature, independent of the compiled matcher. */
function findPolicyEntry(method, routePath) {
  const found = ROUTE_POLICY.find(entry => entry.method === method && entry.path === routePath);
  assert.ok(found, `${method} ${routePath} is missing from ROUTE_POLICY`);
  return found;
}

test('the audit-flag detector rejects a handler that writes nothing', () => {
  // Guard the guard. The whole failure mode being fixed is a check that looks
  // green because it cannot see anything, so assert the detector fires on the
  // shape it exists to catch.
  const noAudit = `
    router.post('/backfill-recordings', async (req, res) => {
      const { backfillRecordings } = require('../scripts/backfill-recordings');
      res.json(await backfillRecordings());
    });
  `;
  const writers = auditWriterNames(noAudit);
  assert.deepEqual([...writers], ['logAudit', 'logAuditSafely'],
    'a file with no audit wrapper contributes no extra writer names');
  assert.equal(
    [...writers].some(name => new RegExp(`\\b${name}\\s*\\(`).test(noAudit)),
    false,
    'the exact pre-fix shape of POST /api/voice/backfill-recordings must be flagged'
  );

  // ...and that it still recognises the indirect shape used by routes/sync.js.
  const viaHelper = `
    async function auditSyncStarted(req, syncType) {
      await logAuditSafely({ eventType: 'settings.sync.triggered', req });
    }
    router.post('/ghl', async (req, res) => {
      await auditSyncStarted(req, 'ghl_contacts');
      res.json({ ok: true });
    });
  `;
  const helperWriters = auditWriterNames(viaHelper);
  assert.ok(helperWriters.has('auditSyncStarted'));
  assert.ok([...helperWriters].some(name => new RegExp(`\\b${name}\\s*\\(`).test(viaHelper)));
});
