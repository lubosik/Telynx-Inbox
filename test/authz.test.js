'use strict';
/**
 * Authorisation behaviour, offline.
 *
 * The rules being defended here, in the order they matter:
 *
 *   1. Authority comes from the database, never from the cookie. A correctly
 *      signed cookie claiming `"role":"owner"` must change nothing.
 *   2. A Support Agent denied an admin action must not merely see a 403 — the
 *      underlying handler must never run, so there is no state to change.
 *   3. A permission change lands on the very next request, not when a cache
 *      feels like expiring.
 *   4. An unknown email and a wrong password are indistinguishable.
 *   5. An invitation token is single-use even under concurrency, and never
 *      exists in the database in a form that can be replayed.
 *
 * No network, no live database, no Supabase project. The fakes below implement
 * only the query shapes the production code actually uses; anything else
 * throws rather than quietly returning empty, so a change in query shape shows
 * up here instead of in production.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://offline.test.invalid';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'offline-test-key';

const { createAuthz } = require('../lib/authz');
const { createPolicyEnforcer, assertPolicyPermissionsExist, normalisePath } = require('../lib/enforce-policy');
const { ROUTE_POLICY } = require('../lib/route-policy');
const createUsersRouter = require('../routes/users');
const createInvitationsRouter = require('../routes/invitations');
const { hashToken } = require('../routes/invitations');
const { createAuthRouter } = require('../routes/auth');
const { hashPassword } = require('../lib/password');

// ── The migration is the source of truth for grants ─────────────────────────
// Parsing it here means this suite cannot drift away from the SQL that will
// actually be applied. If somebody quietly adds analytics.read to the agent
// role, these tests start failing, which is the entire point.

const MIGRATION = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'rbac-migration.sql'), 'utf8');

function permissionCatalogueFromMigration() {
  const block = MIGRATION.split('INSERT INTO sms_permissions')[1].split('ON CONFLICT')[0];
  const keys = [...block.matchAll(/^\s*\('([a-z][a-z0-9.]*)',/gm)].map(m => m[1]);
  assert.ok(keys.length > 20, 'failed to parse the permission catalogue out of the migration');
  return keys;
}

function agentGrantsFromMigration() {
  const block = MIGRATION
    .split("SELECT 'agent', key FROM sms_permissions WHERE key IN (")[1]
    .split(')')[0];
  const keys = [...block.matchAll(/'([a-z][a-z0-9.]*)'/g)].map(m => m[1]);
  assert.ok(keys.length > 5, 'failed to parse the agent grants out of the migration');
  return keys;
}

const CATALOGUE = permissionCatalogueFromMigration();
const AGENT_PERMISSIONS = agentGrantsFromMigration();
const ADMIN_PERMISSIONS = CATALOGUE.filter(key => key !== 'user.manage.owner');

// ── Fakes ────────────────────────────────────────────────────────────────────

/**
 * A Supabase stand-in covering exactly the chains lib/authz.js and
 * routes/auth.js build. Unsupported operators throw on purpose.
 */
function makeSupabase(tables = {}) {
  const seen = [];

  function from(table) {
    if (!tables[table]) tables[table] = [];
    const state = { table, filters: [], mode: 'select', payload: null, single: null, limit: null };

    function matching() {
      return tables[state.table].filter(row => state.filters.every(predicate => predicate(row)));
    }

    function run() {
      seen.push(`${state.mode} ${state.table}`);
      if (state.mode === 'insert') {
        const rows = Array.isArray(state.payload) ? state.payload : [state.payload];
        const stored = rows.map(row => ({ id: tables[state.table].length + 1, ...row }));
        tables[state.table].push(...stored);
        return { data: stored, error: null };
      }
      if (state.mode === 'update') {
        const rows = matching();
        for (const row of rows) Object.assign(row, state.payload);
        return { data: rows, error: null };
      }
      let rows = matching();
      if (state.limit !== null) rows = rows.slice(0, state.limit);
      if (state.single === 'maybe') return { data: rows[0] ?? null, error: null };
      if (state.single === 'one') {
        return rows.length === 1
          ? { data: rows[0], error: null }
          : { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } };
      }
      return { data: rows, error: null };
    }

    const api = {
      select() { return api; },
      eq(column, value) { state.filters.push(row => row[column] === value); return api; },
      ilike(column, value) {
        const needle = String(value).replace(/\\(.)/g, '$1').toLowerCase();
        state.filters.push(row => String(row[column] ?? '').toLowerCase() === needle);
        return api;
      },
      is(column, value) { state.filters.push(row => (row[column] ?? null) === value); return api; },
      order() { return api; },
      limit(count) { state.limit = count; return api; },
      insert(payload) { state.mode = 'insert'; state.payload = payload; return api; },
      update(payload) { state.mode = 'update'; state.payload = payload; return api; },
      maybeSingle() { state.single = 'maybe'; return api; },
      single() { state.single = 'one'; return api; },
      then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); }
    };
    return api;
  }

  return { from, tables, seen, async rpc() { throw new Error('rpc not stubbed'); } };
}

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(payload) { this.payload = payload; return this; }
  };
}

function makeRequest({ method = 'GET', url = '/api/conversations', session = {}, body = {}, params = {}, actor } = {}) {
  return {
    method,
    url,
    originalUrl: url,
    path: normalisePath(url),
    session,
    body,
    params,
    query: {},
    actor,
    ip: '198.51.100.7',
    socket: { remoteAddress: '198.51.100.7' },
    get(name) {
      const headers = { 'user-agent': 'node-test', 'x-vici-client': 'test' };
      return headers[String(name).toLowerCase()] ?? null;
    }
  };
}

/** Grabs a router's own handler, skipping any rate limiter in front of it. */
function handlerFor(router, method, routePath) {
  const layer = router.stack.find(entry =>
    entry.route && entry.route.path === routePath && entry.route.methods[method.toLowerCase()]);
  if (!layer) throw new Error(`No route ${method} ${routePath} on this router`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

const enforce = createPolicyEnforcer();

/** Runs the policy gate. Returns the response and whether the handler was reached. */
/**
 * The routers write audit rows. In a test there is no Supabase to write to, so
 * without an injected writer each audited handler attempts a real network call,
 * fails open, and logs a TypeError. It still passes, but it makes an offline
 * suite hit the resolver — which AGENTS.md forbids, and which quietly turns a
 * unit test into something that behaves differently on a plane.
 */
const noAudit = async () => ({ recorded: false, id: null });

function runPolicy(req) {
  const res = responseRecorder();
  let reached = false;
  enforce(req, res, () => { reached = true; });
  return { res, reached };
}

function actorFrom({ id = 1, role = 'agent', permissions = AGENT_PERMISSIONS, mustChangePassword = false } = {}) {
  const set = new Set(permissions);
  return {
    id,
    email: `${role}@example.com`,
    displayName: role,
    role,
    isLegacyShared: false,
    viaLegacySession: false,
    sessionEpoch: 1,
    mustChangePassword,
    permissions: set,
    can: key => set.has(key)
  };
}

/** `/api/users/:id` -> `/api/users/1`, so a policy path becomes a real URL. */
function concreteUrl(policyPath) {
  return policyPath
    .replace(/:phone/g, '%2B15555550123')
    .replace(/:id/g, '1');
}

// ── Actor resolution ─────────────────────────────────────────────────────────

function seedUsers() {
  return [
    { id: 1, email: 'legacy@vici.local', display_name: 'Team', role: 'legacy', is_active: true, is_legacy_shared: true, session_epoch: 1, must_change_password: false, password_hash: null, failed_login_count: 0, locked_until: null },
    { id: 2, email: 'owner@example.com', display_name: 'Owner', role: 'owner', is_active: true, is_legacy_shared: false, session_epoch: 1, must_change_password: false, password_hash: null, failed_login_count: 0, locked_until: null },
    { id: 3, email: 'agent@example.com', display_name: 'Agent', role: 'agent', is_active: true, is_legacy_shared: false, session_epoch: 4, must_change_password: false, password_hash: null, failed_login_count: 0, locked_until: null }
  ];
}

function seedPermissions() {
  return [
    ...CATALOGUE.map(key => ({ user_id: 1, permission_key: key })).filter(row => row.permission_key !== 'user.manage.owner'),
    ...CATALOGUE.map(key => ({ user_id: 2, permission_key: key })),
    ...AGENT_PERMISSIONS.map(key => ({ user_id: 3, permission_key: key }))
  ];
}

function authzFixture() {
  const tables = { sms_users: seedUsers(), sms_effective_permissions: seedPermissions(), sms_auth_events: [] };
  const client = makeSupabase(tables);
  return { tables, client, authz: createAuthz({ client }) };
}

test('a forged cookie claiming owner is ignored, because authority comes from the database', async () => {
  const { authz } = authzFixture();

  // Correctly signed, so cookie-session would hand this straight through. The
  // extra fields are exactly what an attacker with the session secret, or a
  // future careless refactor, would try to smuggle.
  const req = makeRequest({
    method: 'GET',
    url: '/api/users',
    session: {
      v: 1,
      authenticated: true,
      uid: 3,
      se: 4,
      role: 'owner',
      permissions: ['user.manage', 'admin.backfill', 'analytics.read']
    }
  });
  const res = responseRecorder();
  let reached = false;
  await authz.resolveActor(req, res, () => { reached = true; });

  assert.equal(reached, true);
  assert.equal(req.actor.role, 'agent');
  assert.equal(req.actor.permissions.has('user.manage'), false);
  assert.equal(req.actor.permissions.has('analytics.read'), false);
  assert.equal(req.actor.permissions.has('conversation.read'), true);

  // And the gate agrees.
  const gate = runPolicy(req);
  assert.equal(gate.reached, false);
  assert.equal(gate.res.statusCode, 403);
  assert.equal(gate.res.payload.code, 'FORBIDDEN');
});

test('a role change makes the very next request SESSION_STALE, with 401 so iOS re-authenticates', async () => {
  const { tables, authz } = authzFixture();
  const session = { v: 1, authenticated: true, uid: 3, se: 4 };

  const first = makeRequest({ url: '/api/conversations', session });
  await authz.resolveActor(first, responseRecorder(), () => {});
  assert.equal(first.actor.role, 'agent');

  // An admin promotes them. routes/users.js bumps the epoch and invalidates.
  const target = tables.sms_users.find(user => user.id === 3);
  target.role = 'admin';
  target.session_epoch = 5;
  for (const key of ADMIN_PERMISSIONS) tables.sms_effective_permissions.push({ user_id: 3, permission_key: key });
  authz.invalidate(3);

  const second = makeRequest({ url: '/api/conversations', session: { ...session } });
  const res = responseRecorder();
  let reached = false;
  await authz.resolveActor(second, res, () => { reached = true; });

  assert.equal(reached, false);
  assert.equal(res.statusCode, 401, 'must be 401: a 403 would be a dead end for the iOS client');
  assert.equal(res.payload.code, 'SESSION_STALE');
  assert.equal(second.session, null, 'the stale cookie must be cleared, not left to be retried forever');

  // Signing in again picks the new permissions up immediately.
  const third = makeRequest({ url: '/api/analytics/overview', session: { v: 1, authenticated: true, uid: 3, se: 5 } });
  await authz.resolveActor(third, responseRecorder(), () => {});
  assert.equal(third.actor.role, 'admin');
  assert.equal(third.actor.permissions.has('analytics.read'), true);
});

test('a deactivated account is refused even with an otherwise valid cookie', async () => {
  const { tables, authz } = authzFixture();
  const user = tables.sms_users.find(entry => entry.id === 3);
  user.is_active = false;

  const req = makeRequest({ session: { v: 1, authenticated: true, uid: 3, se: 4 } });
  const res = responseRecorder();
  let reached = false;
  await authz.resolveActor(req, res, () => { reached = true; });

  assert.equal(reached, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.payload.code, 'ACCOUNT_DISABLED');
  assert.equal(req.session, null);
});

test('a pre-existing cookie with no uid resolves to the shared identity — this is what stops the deploy logging everyone out', async () => {
  const { authz } = authzFixture();

  // Exactly what cookie-session already holds in production today.
  const req = makeRequest({ url: '/api/conversations', session: { authenticated: true } });
  const res = responseRecorder();
  let reached = false;
  await authz.resolveActor(req, res, () => { reached = true; });

  assert.equal(reached, true, `expected a legacy cookie to resolve, got ${res.statusCode} ${JSON.stringify(res.payload)}`);
  assert.equal(req.actor.isLegacyShared, true);
  assert.equal(req.actor.viaLegacySession, true);
  assert.equal(req.actor.role, 'legacy');

  // Seeded with admin's grants on purpose, so day one looks identical to today.
  assert.equal(req.actor.permissions.has('analytics.read'), true);
  assert.equal(req.actor.permissions.has('catchup.send'), true);
  assert.equal(req.actor.permissions.has('user.manage.owner'), false);

  // And it carries no epoch, so it must not be epoch-checked into oblivion.
  assert.equal(runPolicy(req).reached, true);
});

test('a missing shared identity fails closed rather than guessing a role', async () => {
  const tables = { sms_users: [], sms_effective_permissions: [], sms_auth_events: [] };
  const authz = createAuthz({ client: makeSupabase(tables) });
  const req = makeRequest({ session: { authenticated: true } });
  const res = responseRecorder();
  let reached = false;
  const originalError = console.error;
  console.error = () => {};
  try { await authz.resolveActor(req, res, () => { reached = true; }); }
  finally { console.error = originalError; }

  assert.equal(reached, false);
  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.code, 'RBAC_NOT_READY');
});

test('permissions are cached briefly but the user row is read on every request', async () => {
  const { tables, client, authz } = authzFixture();
  const session = { v: 1, authenticated: true, uid: 3, se: 4 };

  await authz.resolveActor(makeRequest({ session }), responseRecorder(), () => {});
  const afterFirst = client.seen.filter(entry => entry === 'select sms_effective_permissions').length;
  await authz.resolveActor(makeRequest({ session }), responseRecorder(), () => {});
  const afterSecond = client.seen.filter(entry => entry === 'select sms_effective_permissions').length;
  assert.equal(afterSecond, afterFirst, 'the permission Set is the only thing cached');

  // Deactivation must not wait for a cache to expire.
  tables.sms_users.find(user => user.id === 3).is_active = false;
  const res = responseRecorder();
  await authz.resolveActor(makeRequest({ session }), res, () => {});
  assert.equal(res.payload.code, 'ACCOUNT_DISABLED');
});

// ── The policy gate ──────────────────────────────────────────────────────────

test('an /api request matching no policy entry is denied, not answered with the SPA shell', () => {
  // Today this exact request falls past every mount to the catch-all at
  // server.js:112 and returns index.html with HTTP 200, so a client fetching a
  // mistyped endpoint gets a page of HTML and reports success.
  const req = makeRequest({ method: 'GET', url: '/api/there-is-no-such-thing', actor: actorFrom({ role: 'owner', permissions: CATALOGUE }) });
  const { res, reached } = runPolicy(req);
  assert.equal(reached, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.code, 'POLICY_MISSING');
});

test('the gate never passes a request it cannot classify', () => {
  // The enforcer is mounted on '/api' and nowhere else (server.js), so in
  // production it only ever sees API traffic. It used to call next() for a path
  // that did not start with '/api' — and because Express route matching is
  // case-INSENSITIVE by default, `GET /API/users` reached this middleware,
  // failed its own case-sensitive prefix test, and was waved straight through
  // to the handler with no permission check at all. Uppercasing one letter
  // defeated every boundary in the policy table.
  //
  // So the contract is now: reaching this middleware and failing to classify is
  // a broken routing assumption, and the answer is deny. A middleware whose job
  // is to say no must not have a branch that says yes by accident. Webhooks and
  // the SPA are protected by the MOUNT, which is asserted separately below —
  // not by a pass-through branch in here.
  for (const url of ['/', '/index.html', '/health', '/auth/login', '/webhook/telnyx', '/apixyz']) {
    const { res, reached } = runPolicy(makeRequest({ method: 'GET', url }));
    assert.equal(reached, false, `${url} must not reach a handler through the gate`);
    assert.equal(res.statusCode, 403, url);
  }
});

test('case cannot be used to walk around the policy', () => {
  // The regression test for the bypass above. Every casing of a real,
  // admin-only endpoint must resolve to the same policy entry and be refused
  // for an actor that does not hold the permission.
  const agent = {
    id: '9', role: 'agent', displayName: 'Support Agent',
    permissions: new Set(AGENT_PERMISSIONS), mustChangePassword: false
  };
  for (const url of ['/api/users', '/API/users', '/ApI/users', '/api/USERS']) {
    const { res, reached } = runPolicy(makeRequest({ method: 'GET', url, actor: agent }));
    assert.equal(reached, false, `${url} reached the handler`);
    assert.equal(res.statusCode, 403, url);
    assert.equal(res.payload.code, 'FORBIDDEN', url);
  }
});

test('the gate is mounted on /api only, so webhooks stay unauthenticated', () => {
  // What actually keeps inbound SMS, delivery receipts, Woo order flows,
  // shipping updates and inbound calls working is the mount, not a branch
  // inside the enforcer. Assert the mount, and that it is registered after
  // every webhook and before every /api route.
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  assert.match(server, /app\.use\('\/api', requireAuth, resolveActor, createPolicyEnforcer\(\)\)/);
  assert.ok(!/app\.use\(\s*requireAuth/.test(server),
    'the gate must never be registered bare — that would guard the webhooks too');

  const gate = server.indexOf("app.use('/api', requireAuth, resolveActor, createPolicyEnforcer())");
  for (const webhook of ["app.use('/webhook',", "app.use('/webhooks/voice'"]) {
    // Voice webhooks are mounted after the gate but on a different prefix, so
    // only the shared '/webhook' prefix ordering matters here.
    if (webhook === "app.use('/webhook',") {
      assert.ok(server.indexOf(webhook) < gate, 'webhook mounts come before the gate');
    }
    assert.ok(server.includes(webhook), `${webhook} is still mounted`);
  }
  assert.ok(gate < server.indexOf("app.use('/api/sse'"), 'the gate precedes every /api mount');
});

test('a Support Agent is refused every policy entry their role does not grant, and the handler never runs', () => {
  const agentGrants = new Set(AGENT_PERMISSIONS);
  const shouldDeny = ROUTE_POLICY.filter(entry => entry.permission !== null && !agentGrants.has(entry.permission));
  assert.ok(shouldDeny.length >= 20, 'expected a substantial admin-only surface to exist');

  const failures = [];
  let handlerRuns = 0;

  for (const entry of shouldDeny) {
    const req = makeRequest({
      method: entry.method,
      url: concreteUrl(entry.path),
      actor: actorFrom({ id: 3, role: 'agent' })
    });
    const res = responseRecorder();
    enforce(req, res, () => { handlerRuns += 1; });
    if (res.statusCode !== 403 || res.payload?.code !== 'FORBIDDEN') {
      failures.push(`${entry.method} ${entry.path} -> ${res.statusCode} ${res.payload?.code}`);
    }
  }

  assert.deepEqual(failures, [], `\n\nA Support Agent reached these:\n  ${failures.join('\n  ')}\n`);
  // The strongest offline form of "the underlying state did not change": the
  // handler that would have changed it was never invoked.
  assert.equal(handlerRuns, 0, 'a denied request must never reach its handler');
});

test('a Support Agent is allowed every policy entry their role does grant', () => {
  const agentGrants = new Set(AGENT_PERMISSIONS);
  const shouldAllow = ROUTE_POLICY.filter(entry => entry.permission === null || agentGrants.has(entry.permission));
  const failures = [];

  for (const entry of shouldAllow) {
    const req = makeRequest({
      method: entry.method,
      url: concreteUrl(entry.path),
      actor: actorFrom({ id: 3, role: 'agent' })
    });
    const { res, reached } = runPolicy(req);
    if (!reached) failures.push(`${entry.method} ${entry.path} -> ${res.statusCode} ${res.payload?.code}`);
  }

  assert.deepEqual(failures, [], `\n\nA Support Agent was blocked from their own job:\n  ${failures.join('\n  ')}\n`);
  // Spot-check the classification decisions that matter most.
  assert.equal(agentGrants.has('automation.cancel'), false);
  assert.equal(agentGrants.has('analytics.read'), false);
  assert.equal(agentGrants.has('catchup.send'), false);
  assert.equal(agentGrants.has('catchup.preview'), false);
  assert.equal(agentGrants.has('sync.run'), false);
  assert.equal(agentGrants.has('user.manage'), false);
  assert.equal(agentGrants.has('audit.read'), false);
  assert.equal(agentGrants.has('admin.backfill'), false);
});

test('must_change_password locks everything except reading yourself and setting a new password', () => {
  const actor = actorFrom({ id: 3, role: 'admin', permissions: ADMIN_PERMISSIONS, mustChangePassword: true });

  for (const [method, url] of [['GET', '/api/conversations'], ['POST', '/api/send'], ['GET', '/api/users']]) {
    const { res, reached } = runPolicy(makeRequest({ method, url, actor }));
    assert.equal(reached, false, `${method} ${url}`);
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.code, 'PASSWORD_CHANGE_REQUIRED');
  }

  assert.equal(runPolicy(makeRequest({ method: 'GET', url: '/api/users/me', actor })).reached, true);
  assert.equal(runPolicy(makeRequest({ method: 'POST', url: '/api/users/me/password', actor })).reached, true);
});

test('a policy match with no resolved actor is refused rather than allowed through', () => {
  const req = makeRequest({ method: 'GET', url: '/api/conversations' });
  const { res, reached } = runPolicy(req);
  assert.equal(reached, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.payload.code, 'NO_ACTOR');
});

test('every permission key in the policy table exists in the migration catalogue', async () => {
  const client = makeSupabase({ sms_permissions: CATALOGUE.map(key => ({ key })) });
  const result = await assertPolicyPermissionsExist({ client });
  assert.ok(result.checked > 20);

  // A typo must fail startup, not silently become a permission nobody holds.
  const missing = makeSupabase({ sms_permissions: CATALOGUE.filter(key => key !== 'analytics.read').map(key => ({ key })) });
  await assert.rejects(
    () => assertPolicyPermissionsExist({ client: missing }),
    /Unknown permission key\(s\).*analytics\.read/s
  );
});

// ── User management guards ───────────────────────────────────────────────────

function makeUserStore(users) {
  const state = { users, roles: [
    { key: 'owner', display_name: 'Owner', rank: 300, is_assignable: true },
    { key: 'admin', display_name: 'Admin', rank: 200, is_assignable: true },
    { key: 'agent', display_name: 'Support Agent', rank: 100, is_assignable: true },
    { key: 'legacy', display_name: 'Team (shared password)', rank: 90, is_assignable: false }
  ], mutations: [] };

  return {
    state,
    async list() { return state.users; },
    async getById(id) { return state.users.find(user => user.id === id) || null; },
    async findByEmail(email) {
      return state.users.find(user => user.email.toLowerCase() === String(email).toLowerCase()) || null;
    },
    async create(row) {
      state.mutations.push({ op: 'create', row });
      const created = { id: 900 + state.users.length, is_active: true, is_legacy_shared: false, session_epoch: 1, ...row };
      state.users.push(created);
      return created;
    },
    async update(id, patch) {
      state.mutations.push({ op: 'update', id, patch });
      const user = state.users.find(entry => entry.id === id);
      Object.assign(user, patch);
      return user;
    },
    async countActiveAdministrators() {
      return state.users.filter(user => user.is_active && ['owner', 'admin'].includes(user.role)).length;
    },
    /** Deactivation revokes push registrations; recorded so a test can assert it. */
    async revokePushDevices(id) { (state.revokedDevices ||= []).push(Number(id)); return 1; },
    async bumpEpoch(id) {
      state.mutations.push({ op: 'bumpEpoch', id });
      const user = state.users.find(entry => entry.id === id);
      user.session_epoch = (user.session_epoch || 1) + 1;
      return user.session_epoch;
    },
    async listRoles() { return state.roles; },
    async listPermissionKeys() { return CATALOGUE; },
    async listGrants() { return []; },
    async upsertGrant(row) { state.mutations.push({ op: 'upsertGrant', row }); return row; },
    async deleteGrant(userId, key) { state.mutations.push({ op: 'deleteGrant', userId, key }); return true; }
  };
}

function teamFixture() {
  return [
    { id: 1, email: 'legacy@vici.local', display_name: 'Team', role: 'legacy', is_active: true, is_legacy_shared: true, session_epoch: 1, must_change_password: false, password_hash: null },
    { id: 2, email: 'owner@example.com', display_name: 'Owner', role: 'owner', is_active: true, is_legacy_shared: false, session_epoch: 1, must_change_password: false, password_hash: 'scrypt$1$N=1024,r=8,p=1,len=64$c2FsdA==$aGFzaA==' },
    { id: 3, email: 'admin@example.com', display_name: 'Admin', role: 'admin', is_active: true, is_legacy_shared: false, session_epoch: 1, must_change_password: false, password_hash: 'scrypt$1$N=1024,r=8,p=1,len=64$c2FsdA==$aGFzaA==' },
    { id: 4, email: 'agent@example.com', display_name: 'Agent', role: 'agent', is_active: true, is_legacy_shared: false, session_epoch: 1, must_change_password: false, password_hash: 'scrypt$1$N=1024,r=8,p=1,len=64$c2FsdA==$aGFzaA==' }
  ];
}

function usersFixture() {
  const store = makeUserStore(teamFixture());
  const invalidated = [];
  const router = createUsersRouter({ store, authz: { invalidate: id => invalidated.push(id) }, audit: noAudit });
  return { store, router, invalidated };
}

test('a Support Agent cannot reach any user-management handler, so no user state can change', async () => {
  const { store, router } = usersFixture();
  const before = JSON.stringify(store.state.users);

  const adminOnly = [
    ['GET', '/api/users', '/'],
    ['POST', '/api/users', '/'],
    ['PATCH', '/api/users/4', '/:id'],
    ['POST', '/api/users/4/deactivate', '/:id/deactivate'],
    ['POST', '/api/users/4/reset-password', '/:id/reset-password']
  ];

  for (const [method, url] of adminOnly) {
    const req = makeRequest({ method, url, actor: actorFrom({ id: 4, role: 'agent' }), body: { role: 'owner' } });
    const res = responseRecorder();
    let reached = false;
    enforce(req, res, () => { reached = true; });
    assert.equal(reached, false, `${method} ${url} reached its handler`);
    assert.equal(res.statusCode, 403);
  }

  assert.equal(store.state.mutations.length, 0, 'no write was attempted');
  assert.equal(JSON.stringify(store.state.users), before, 'the user table is byte-for-byte unchanged');

  // The handlers do exist and do work — the gate is what stopped them.
  const ownerReq = makeRequest({ method: 'GET', url: '/api/users', actor: actorFrom({ id: 2, role: 'owner', permissions: CATALOGUE }) });
  assert.equal(runPolicy(ownerReq).reached, true);
  const res = responseRecorder();
  await handlerFor(router, 'GET', '/')(ownerReq, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.users.length, 4);
});

test('no response body ever carries a password hash', async () => {
  const { router } = usersFixture();
  const actor = actorFrom({ id: 2, role: 'owner', permissions: CATALOGUE });

  const list = responseRecorder();
  await handlerFor(router, 'GET', '/')(makeRequest({ url: '/api/users', actor }), list);
  const serialised = JSON.stringify(list.payload);
  assert.equal(serialised.includes('password_hash'), false);
  assert.equal(serialised.includes('scrypt$'), false);
  assert.equal(list.payload.users.every(user => typeof user.hasPassword === 'boolean'), true);

  const created = responseRecorder();
  await handlerFor(router, 'POST', '/')(
    makeRequest({ method: 'POST', url: '/api/users', actor, body: { email: 'new@example.com', displayName: 'New', role: 'agent', password: 'a-perfectly-fine-password' } }),
    created
  );
  assert.equal(created.statusCode, 201);
  assert.equal(JSON.stringify(created.payload).includes('scrypt$'), false);
  assert.equal(created.payload.user.hasPassword, true);
});

test('only an Owner may grant or revoke Owner', async () => {
  const { store, router } = usersFixture();
  const admin = actorFrom({ id: 3, role: 'admin', permissions: ADMIN_PERMISSIONS });

  // An Admin promoting somebody to Owner.
  const promote = responseRecorder();
  await handlerFor(router, 'PATCH', '/:id')(
    makeRequest({ method: 'PATCH', url: '/api/users/4', params: { id: '4' }, actor: admin, body: { role: 'owner' } }),
    promote
  );
  assert.equal(promote.statusCode, 403);
  assert.equal(promote.payload.code, 'OWNER_ROLE_REQUIRES_OWNER');
  assert.equal(store.state.users.find(user => user.id === 4).role, 'agent', 'the role must be untouched');

  // An Admin demoting the Owner.
  const demote = responseRecorder();
  await handlerFor(router, 'PATCH', '/:id')(
    makeRequest({ method: 'PATCH', url: '/api/users/2', params: { id: '2' }, actor: admin, body: { role: 'admin' } }),
    demote
  );
  assert.equal(demote.statusCode, 403);
  assert.equal(store.state.users.find(user => user.id === 2).role, 'owner');
  assert.equal(store.state.mutations.length, 0);

  // An Owner may.
  const owner = actorFrom({ id: 2, role: 'owner', permissions: CATALOGUE });
  const allowed = responseRecorder();
  await handlerFor(router, 'PATCH', '/:id')(
    makeRequest({ method: 'PATCH', url: '/api/users/4', params: { id: '4' }, actor: owner, body: { role: 'owner' } }),
    allowed
  );
  assert.equal(allowed.statusCode, 200);
  assert.equal(store.state.users.find(user => user.id === 4).role, 'owner');
});

test('a role change, deactivation or override change revokes that person sessions immediately', async () => {
  const { store, router, invalidated } = usersFixture();
  const owner = actorFrom({ id: 2, role: 'owner', permissions: CATALOGUE });

  const before = store.state.users.find(user => user.id === 4).session_epoch;
  const res = responseRecorder();
  await handlerFor(router, 'PATCH', '/:id')(
    makeRequest({ method: 'PATCH', url: '/api/users/4', params: { id: '4' }, actor: owner, body: { role: 'admin' } }),
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.sessionsRevoked, true);
  assert.equal(store.state.users.find(user => user.id === 4).session_epoch, before + 1);
  assert.deepEqual(invalidated, [4], 'the cached permission Set must be dropped alongside the epoch bump');

  // Granting a per-user override does the same.
  const grant = responseRecorder();
  await handlerFor(router, 'PATCH', '/:id')(
    makeRequest({ method: 'PATCH', url: '/api/users/4', params: { id: '4' }, actor: owner, body: { grants: [{ permissionKey: 'analytics.read', effect: 'deny', reason: 'under review' }] } }),
    grant
  );
  assert.equal(grant.statusCode, 200);
  assert.equal(grant.payload.sessionsRevoked, true);
  assert.deepEqual(invalidated, [4, 4]);
  assert.ok(store.state.mutations.some(entry => entry.op === 'upsertGrant' && entry.row.effect === 'deny'));

  // A pure cosmetic edit does not.
  const rename = responseRecorder();
  await handlerFor(router, 'PATCH', '/:id')(
    makeRequest({ method: 'PATCH', url: '/api/users/4', params: { id: '4' }, actor: owner, body: { displayName: 'Renamed' } }),
    rename
  );
  assert.equal(rename.payload.sessionsRevoked, false);
  assert.deepEqual(invalidated, [4, 4]);
});

test('the last active Owner or Admin cannot be demoted or deactivated, and it is a 409 not a 500', async () => {
  const store = makeUserStore([
    { id: 1, email: 'legacy@vici.local', display_name: 'Team', role: 'legacy', is_active: true, is_legacy_shared: true, session_epoch: 1, must_change_password: false, password_hash: null },
    { id: 2, email: 'owner@example.com', display_name: 'Owner', role: 'owner', is_active: true, is_legacy_shared: false, session_epoch: 1, must_change_password: false, password_hash: null },
    { id: 4, email: 'agent@example.com', display_name: 'Agent', role: 'agent', is_active: true, is_legacy_shared: false, session_epoch: 1, must_change_password: false, password_hash: null }
  ]);
  const router = createUsersRouter({ store, authz: { invalidate() {} }, audit: noAudit });
  const owner = actorFrom({ id: 2, role: 'owner', permissions: CATALOGUE });

  const demote = responseRecorder();
  await handlerFor(router, 'PATCH', '/:id')(
    makeRequest({ method: 'PATCH', url: '/api/users/2', params: { id: '2' }, actor: owner, body: { role: 'agent' } }),
    demote
  );
  assert.equal(demote.statusCode, 409);
  assert.equal(demote.payload.code, 'CANNOT_DEACTIVATE_LAST_OWNER');
  assert.equal(store.state.users.find(user => user.id === 2).role, 'owner');

  const deactivate = responseRecorder();
  await handlerFor(router, 'POST', '/:id/deactivate')(
    makeRequest({ method: 'POST', url: '/api/users/2/deactivate', params: { id: '2' }, actor: owner }),
    deactivate
  );
  assert.equal(deactivate.statusCode, 409);
  assert.equal(deactivate.payload.code, 'CANNOT_DEACTIVATE_LAST_OWNER');
  assert.equal(store.state.users.find(user => user.id === 2).is_active, true);
  assert.equal(store.state.mutations.length, 0);

  // With a second administrator present it goes through.
  store.state.users.push({ id: 5, email: 'admin2@example.com', display_name: 'Second', role: 'admin', is_active: true, is_legacy_shared: false, session_epoch: 1, must_change_password: false, password_hash: null });
  const now = responseRecorder();
  await handlerFor(router, 'POST', '/:id/deactivate')(
    makeRequest({ method: 'POST', url: '/api/users/2/deactivate', params: { id: '2' }, actor: owner }),
    now
  );
  assert.equal(now.statusCode, 200);
  assert.equal(store.state.users.find(user => user.id === 2).is_active, false);
  assert.ok(store.state.users.find(user => user.id === 2).deactivated_at);
});

test('the shared identity is immutable through the API, because two people are signed in as it right now', async () => {
  const { store, router } = usersFixture();
  const owner = actorFrom({ id: 2, role: 'owner', permissions: CATALOGUE });

  for (const [method, routePath] of [['PATCH', '/:id'], ['POST', '/:id/deactivate'], ['POST', '/:id/reset-password']]) {
    const res = responseRecorder();
    await handlerFor(router, method, routePath)(
      makeRequest({ method, url: '/api/users/1', params: { id: '1' }, actor: owner, body: { role: 'agent' } }),
      res
    );
    assert.equal(res.statusCode, 409, `${method} ${routePath}`);
    assert.equal(res.payload.code, 'LEGACY_USER_IMMUTABLE');
  }
  assert.equal(store.state.mutations.length, 0);
  assert.equal(store.state.users.find(user => user.id === 1).role, 'legacy');
});

test('an admin password reset forces a rotation, revokes sessions, and shows the temporary password once', async () => {
  const { store, router, invalidated } = usersFixture();
  const owner = actorFrom({ id: 2, role: 'owner', permissions: CATALOGUE });

  const res = responseRecorder();
  await handlerFor(router, 'POST', '/:id/reset-password')(
    makeRequest({ method: 'POST', url: '/api/users/4/reset-password', params: { id: '4' }, actor: owner }),
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(typeof res.payload.temporaryPassword, 'string');
  assert.ok(res.payload.temporaryPassword.length >= 16);

  const target = store.state.users.find(user => user.id === 4);
  assert.equal(target.must_change_password, true);
  assert.equal(target.session_epoch, 2);
  assert.deepEqual(invalidated, [4]);
  // Only the hash is stored, and the plaintext is nowhere in the row.
  assert.ok(target.password_hash.startsWith('scrypt$1$'));
  assert.equal(JSON.stringify(target).includes(res.payload.temporaryPassword), false);
});

test('the roles a person cannot be given are refused rather than written', async () => {
  const { store, router } = usersFixture();
  const owner = actorFrom({ id: 2, role: 'owner', permissions: CATALOGUE });

  for (const role of ['legacy', 'superuser', '']) {
    const res = responseRecorder();
    await handlerFor(router, 'PATCH', '/:id')(
      makeRequest({ method: 'PATCH', url: '/api/users/4', params: { id: '4' }, actor: owner, body: { role } }),
      res
    );
    assert.equal(res.statusCode, 400, `role: ${role}`);
    assert.equal(res.payload.code, 'ROLE_NOT_ASSIGNABLE');
  }
  assert.equal(store.state.mutations.length, 0);
});

test('changing your own password re-stamps this session and revokes the others', async () => {
  const store = makeUserStore(teamFixture());
  const invalidated = [];
  const router = createUsersRouter({ store, authz: { invalidate: id => invalidated.push(id) }, audit: noAudit });
  const target = store.state.users.find(user => user.id === 4);
  target.password_hash = await hashPassword('the-original-password', { N: 1024, r: 8, p: 1, len: 64 });
  target.must_change_password = true;

  const session = { v: 1, authenticated: true, uid: 4, se: 1 };
  const actor = { ...actorFrom({ id: 4, role: 'agent', mustChangePassword: true }) };

  const wrong = responseRecorder();
  await handlerFor(router, 'POST', '/me/password')(
    makeRequest({ method: 'POST', url: '/api/users/me/password', actor, session, body: { currentPassword: 'not-the-password', newPassword: 'a-brand-new-password' } }),
    wrong
  );
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.payload.code, 'CURRENT_PASSWORD_INCORRECT');
  assert.equal(store.state.mutations.length, 0);

  const weak = responseRecorder();
  await handlerFor(router, 'POST', '/me/password')(
    makeRequest({ method: 'POST', url: '/api/users/me/password', actor, session, body: { currentPassword: 'the-original-password', newPassword: 'short' } }),
    weak
  );
  assert.equal(weak.statusCode, 400);
  assert.equal(weak.payload.code, 'PASSWORD_TOO_WEAK');

  const ok = responseRecorder();
  await handlerFor(router, 'POST', '/me/password')(
    makeRequest({ method: 'POST', url: '/api/users/me/password', actor, session, body: { currentPassword: 'the-original-password', newPassword: 'a-brand-new-password' } }),
    ok
  );
  assert.equal(ok.statusCode, 200);
  assert.equal(target.must_change_password, false);
  assert.equal(target.session_epoch, 2);
  assert.equal(session.se, 2, 'the caller keeps the device they just used');
  assert.deepEqual(invalidated, [4]);
});

test('the shared login has no personal password to change', async () => {
  const { router } = usersFixture();
  const actor = { ...actorFrom({ id: 1, role: 'legacy' }), isLegacyShared: true, viaLegacySession: true };
  const res = responseRecorder();
  await handlerFor(router, 'POST', '/me/password')(
    makeRequest({ method: 'POST', url: '/api/users/me/password', actor, body: { currentPassword: 'x'.repeat(12), newPassword: 'y'.repeat(12) } }),
    res
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.code, 'LEGACY_SESSION_NO_PASSWORD');
});

// ── Invitations ──────────────────────────────────────────────────────────────

/**
 * Mimics redeem_sms_invitation: one serialised critical section, which is what
 * SELECT ... FOR UPDATE buys in the real function. The atomicity guarantee
 * lives in SQL; what is asserted here is that Node does not undermine it with
 * a read-then-write of its own, and that the error mapping is right.
 */
function makeInvitationStore(rows = []) {
  const state = { rows, users: [], attempts: [], lock: Promise.resolve() };

  async function serialise(work) {
    const previous = state.lock;
    let release;
    state.lock = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }

  return {
    state,
    async list() { return state.rows; },
    async getById(id) { return state.rows.find(row => row.id === id) || null; },
    async findOpenByEmail(email) {
      return state.rows.find(row =>
        row.email.toLowerCase() === String(email).toLowerCase() && !row.accepted_at && !row.revoked_at) || null;
    },
    async create(row) {
      const created = { id: crypto.randomUUID(), attempt_count: 0, accepted_at: null, revoked_at: null, ...row };
      state.rows.push(created);
      return created;
    },
    async revoke(id, by) {
      const row = state.rows.find(entry => entry.id === id);
      row.revoked_at = new Date().toISOString();
      row.revoked_by = by;
      return row;
    },
    async redeem(tokenHash, passwordHash) {
      return serialise(async () => {
        await new Promise(resolve => setImmediate(resolve));
        const row = state.rows.find(entry => entry.token_hash === tokenHash);
        if (!row) throw new Error('INVITATION_NOT_FOUND');
        if (row.revoked_at) throw new Error('INVITATION_REVOKED');
        if (row.accepted_at) throw new Error('INVITATION_USED');
        if (new Date(row.expires_at).getTime() <= Date.now()) throw new Error('INVITATION_EXPIRED');
        const userId = 500 + state.users.length;
        // Mirrors redeem_sms_invitation in scripts/rbac-migration.sql, which sets
        // must_change_password = false — the invitee chose this password
        // themselves. __mustChange lets a test stand in for a database where
        // the fix migration has NOT been applied.
        const mustChange = row.__mustChange === true;
        state.users.push({ id: userId, email: row.email, password_hash: passwordHash, must_change_password: mustChange });
        row.accepted_at = new Date().toISOString();
        row.accepted_user_id = userId;
        // { userId, email } — the real store echoes the address back so the
        // sign-in form can prefill it.
        return { userId, email: row.email, mustChangePassword: mustChange };
      });
    },
    async noteAttempt(tokenHash) { state.attempts.push(tokenHash); }
  };
}

function invitationsFixture(rows) {
  const store = makeInvitationStore(rows);
  const userStore = makeUserStore(teamFixture());
  const router = createInvitationsRouter({ store, userStore, audit: noAudit });
  const authRouter = createAuthRouter({
    authz: { logAuthEvent: async () => {}, loadLegacyUser: async () => null, loadUserById: async () => null, permissionsFor: async () => new Set() },
    invitationStore: store,
    limiter: (req, res, next) => next()
  });
  return { store, userStore, router, authRouter };
}

test('the raw invitation token is shown once and never lands in the stored row', async () => {
  const { store, router } = invitationsFixture();
  const owner = actorFrom({ id: 2, role: 'owner', permissions: CATALOGUE });

  const res = responseRecorder();
  await handlerFor(router, 'POST', '/')(
    makeRequest({ method: 'POST', url: '/api/invitations', actor: owner, body: { email: 'newbie@example.com', displayName: 'Newbie', role: 'agent' } }),
    res
  );
  assert.equal(res.statusCode, 201);

  const rawToken = res.payload.token;
  assert.equal(typeof rawToken, 'string');
  assert.ok(rawToken.length >= 40, 'a 256-bit token should be at least 40 base64url characters');

  const stored = store.state.rows[0];
  const serialised = JSON.stringify(stored);
  assert.equal(serialised.includes(rawToken), false, 'the raw token must not be stored');
  assert.equal(stored.token_hash, hashToken(rawToken));
  // The prefix is taken from the hash, not the token, so not even a fragment
  // of the live secret is written down.
  assert.equal(stored.token_prefix, hashToken(rawToken).slice(0, 8));
  assert.equal(rawToken.includes(stored.token_prefix), false);

  // Nor does it appear in the listing.
  const list = responseRecorder();
  await handlerFor(router, 'GET', '/')(makeRequest({ url: '/api/invitations', actor: owner }), list);
  assert.equal(JSON.stringify(list.payload).includes(rawToken), false);
  assert.equal(JSON.stringify(list.payload).includes(stored.token_hash), false);
});

test('two simultaneous redemptions of one invitation yield exactly one account', async () => {
  const rawToken = 'a'.repeat(43);
  const { store, authRouter } = invitationsFixture([{
    id: crypto.randomUUID(),
    email: 'newbie@example.com',
    display_name: 'Newbie',
    role_key: 'agent',
    token_hash: hashToken(rawToken),
    token_prefix: hashToken(rawToken).slice(0, 8),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    accepted_at: null,
    revoked_at: null,
    attempt_count: 0
  }]);

  const accept = handlerFor(authRouter, 'POST', '/invitation/accept');
  const responses = [responseRecorder(), responseRecorder()];
  await Promise.all(responses.map(res => accept(
    makeRequest({ method: 'POST', url: '/auth/invitation/accept', body: { token: rawToken, password: 'a-perfectly-fine-password' } }),
    res
  )));

  const codes = responses.map(res => res.statusCode).sort();
  assert.deepEqual(codes, [201, 409], `got ${JSON.stringify(responses.map(r => [r.statusCode, r.payload]))}`);
  assert.equal(store.state.users.length, 1, 'exactly one account may be created');
  assert.equal(responses.find(res => res.statusCode === 409).payload.code, 'INVITATION_USED');

  // The invitee DOES set their own final password here — they typed it into
  // the accept-invite page moments ago and nobody else has ever seen it. An
  // immediate forced rotation protected nothing and turned joining into a
  // two-step chore. The admin-set paths (POST /api/users, /reset-password)
  // still set the flag, because there the password WAS seen by someone else.
  assert.equal(responses.find(res => res.statusCode === 201).payload.mustChangePassword, false);
  assert.equal(store.state.users[0].must_change_password, false);

  // The address is echoed back so the sign-in form can prefill it. Without it
  // the invitee is asked to recall which address they were invited on, in the
  // one flow where they have no account to recover from.
  assert.equal(responses.find(res => res.statusCode === 201).payload.email, 'newbie@example.com');
  assert.ok(store.state.users[0].password_hash.startsWith('scrypt$1$'));
});

test('the accept response reports the stored flag rather than assuming it', async () => {
  // must_change_password is set by a database function, and the application
  // cannot know which version of that function is deployed. So it reads the
  // flag back from the row it just created rather than asserting a value.
  //
  // Hardcoding `false` would let the app tell an invitee "you can sign in now"
  // while the database quietly flags the account for rotation — the response
  // and the truth diverging on the one screen where a brand new person has no
  // way to judge which of the two to believe.
  for (const stored of [true, false]) {
    const rawToken = 'z'.repeat(43);
    const { authRouter } = invitationsFixture([{
      id: crypto.randomUUID(),
      email: 'flagcheck@example.com',
      display_name: 'Flag Check',
      role_key: 'agent',
      token_hash: hashToken(rawToken),
      token_prefix: hashToken(rawToken).slice(0, 8),
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      accepted_at: null,
      revoked_at: null,
      attempt_count: 0,
      __mustChange: stored
    }]);

    const accept = handlerFor(authRouter, 'POST', '/invitation/accept');
    const res = responseRecorder();
    await accept(makeRequest({
      method: 'POST', url: '/auth/invitation/accept',
      body: { token: rawToken, password: 'a-perfectly-fine-password' }
    }), res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.payload.mustChangePassword, stored,
      `the response must mirror the stored flag (${stored}), never a hardcoded value`);
    assert.equal(res.payload.email, 'flagcheck@example.com');
  }
});

test('unknown, revoked and expired invitation tokens are each refused', async () => {
  const revokedToken = 'r'.repeat(43);
  const expiredToken = 'e'.repeat(43);
  const { authRouter } = invitationsFixture([
    {
      id: crypto.randomUUID(), email: 'revoked@example.com', display_name: 'Revoked', role_key: 'agent',
      token_hash: hashToken(revokedToken), token_prefix: hashToken(revokedToken).slice(0, 8),
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      accepted_at: null, revoked_at: new Date().toISOString(), attempt_count: 0
    },
    {
      id: crypto.randomUUID(), email: 'expired@example.com', display_name: 'Expired', role_key: 'agent',
      token_hash: hashToken(expiredToken), token_prefix: hashToken(expiredToken).slice(0, 8),
      expires_at: new Date(Date.now() - 1000).toISOString(),
      accepted_at: null, revoked_at: null, attempt_count: 0
    }
  ]);

  const accept = handlerFor(authRouter, 'POST', '/invitation/accept');
  const cases = [
    ['u'.repeat(43), 404, 'INVITATION_NOT_FOUND'],
    [revokedToken, 409, 'INVITATION_REVOKED'],
    [expiredToken, 410, 'INVITATION_EXPIRED'],
    ['tiny', 404, 'INVITATION_NOT_FOUND']
  ];

  for (const [token, status, code] of cases) {
    const res = responseRecorder();
    await accept(
      makeRequest({ method: 'POST', url: '/auth/invitation/accept', body: { token, password: 'a-perfectly-fine-password' } }),
      res
    );
    assert.equal(res.statusCode, status, `${code}: got ${JSON.stringify(res.payload)}`);
    assert.equal(res.payload.code, code);
  }
});

test('an Admin cannot invite an Owner, but an Owner can', async () => {
  const { store, router } = invitationsFixture();
  const admin = actorFrom({ id: 3, role: 'admin', permissions: ADMIN_PERMISSIONS });

  const refused = responseRecorder();
  await handlerFor(router, 'POST', '/')(
    makeRequest({ method: 'POST', url: '/api/invitations', actor: admin, body: { email: 'boss@example.com', displayName: 'Boss', role: 'owner' } }),
    refused
  );
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.payload.code, 'OWNER_ROLE_REQUIRES_OWNER');
  assert.equal(store.state.rows.length, 0, 'no invitation row may be written');

  const owner = actorFrom({ id: 2, role: 'owner', permissions: CATALOGUE });
  const allowed = responseRecorder();
  await handlerFor(router, 'POST', '/')(
    makeRequest({ method: 'POST', url: '/api/invitations', actor: owner, body: { email: 'boss@example.com', displayName: 'Boss', role: 'owner' } }),
    allowed
  );
  assert.equal(allowed.statusCode, 201);
  assert.equal(store.state.rows.length, 1);
});

// ── Login ────────────────────────────────────────────────────────────────────

function authFixture({ users, legacyPassword = 'the-shared-team-password' } = {}) {
  const tables = { sms_users: users || seedUsers(), sms_effective_permissions: seedPermissions(), sms_auth_events: [] };
  const client = makeSupabase(tables);
  const authz = createAuthz({ client });
  const router = createAuthRouter({ authz, client, invitationStore: makeInvitationStore(), limiter: (req, res, next) => next() });
  process.env.INBOX_PASSWORD = legacyPassword;
  return { tables, client, authz, router, login: handlerFor(router, 'POST', '/login') };
}

test('an unknown email, a wrong password, and an account with no password set are indistinguishable', async () => {
  const users = seedUsers();
  // Production-cost parameters on purpose: the point of the test is that the
  // unknown-email branch does the SAME scrypt work as a real verification.
  users.find(user => user.id === 3).password_hash = await hashPassword('the-real-password');
  const { login } = authFixture({ users });

  async function attempt(email) {
    const res = responseRecorder();
    const startedAt = process.hrtime.bigint();
    await login(makeRequest({ method: 'POST', url: '/auth/login', body: { email, password: 'whatever-they-typed' } }), res);
    return { res, ms: Number(process.hrtime.bigint() - startedAt) / 1e6 };
  }

  const unknown = await attempt('nobody@example.com');        // no such row
  const wrong = await attempt('agent@example.com');           // real row, wrong password
  const noPassword = await attempt('owner@example.com');      // real row, password_hash NULL

  // Status and body must be byte-identical across all three.
  assert.equal(unknown.res.statusCode, 401);
  assert.equal(wrong.res.statusCode, 401);
  assert.equal(noPassword.res.statusCode, 401);
  assert.deepEqual(unknown.res.payload, wrong.res.payload);
  assert.deepEqual(unknown.res.payload, noPassword.res.payload);
  assert.equal(unknown.res.payload.code, 'INVALID_CREDENTIALS');
  // The message names both fields, so it cannot say which one was wrong.
  assert.match(unknown.res.payload.error, /email or password/i);

  // And timing must not give it away. Without verifyAgainstDummy() on the
  // unknown-email branch this ratio is roughly a thousand to one, so a very
  // generous band still catches a short circuit without being flaky.
  const slowest = Math.max(unknown.ms, wrong.ms, noPassword.ms);
  const fastest = Math.min(unknown.ms, wrong.ms, noPassword.ms);
  assert.ok(
    fastest > 1 && slowest / fastest < 6,
    `login branches must cost the same scrypt work: unknown=${unknown.ms.toFixed(1)}ms wrong=${wrong.ms.toFixed(1)}ms noPassword=${noPassword.ms.toFixed(1)}ms`
  );
});

test('a correct password signs in and issues a cookie carrying no authority', async () => {
  const users = seedUsers();
  users.find(user => user.id === 3).password_hash = await hashPassword('the-real-password', { N: 1024, r: 8, p: 1, len: 64 });
  const { login, tables } = authFixture({ users });

  const req = makeRequest({ method: 'POST', url: '/auth/login', body: { email: 'agent@example.com', password: 'the-real-password' } });
  const res = responseRecorder();
  await login(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.success, true, 'the shipped web bundle and iOS binary read this shape');
  assert.equal(res.payload.actor.role, 'agent');

  // The cookie carries an identifier and an epoch. Nothing else.
  assert.deepEqual(Object.keys(req.session).sort(), ['authenticated', 'se', 'uid', 'v']);
  assert.equal(req.session.uid, 3);
  assert.equal(req.session.se, 4);
  assert.equal('role' in req.session, false);
  assert.equal('permissions' in req.session, false);

  assert.equal(tables.sms_auth_events.filter(event => event.outcome === 'success').length, 1);
});

test('an account locks after repeated failures and stays locked even when the password is right', async () => {
  const users = seedUsers();
  const target = users.find(user => user.id === 3);
  target.password_hash = await hashPassword('the-real-password', { N: 1024, r: 8, p: 1, len: 64 });
  const { login, tables } = authFixture({ users });

  const attempt = (password) => {
    const res = responseRecorder();
    return login(makeRequest({ method: 'POST', url: '/auth/login', body: { email: 'agent@example.com', password } }), res).then(() => res);
  };

  for (let i = 0; i < 4; i += 1) {
    const res = await attempt('wrong-password-here');
    assert.equal(res.statusCode, 401, `attempt ${i + 1}`);
  }
  assert.equal(target.failed_login_count, 4);

  const fifth = await attempt('wrong-password-here');
  assert.equal(fifth.statusCode, 401);
  assert.ok(target.locked_until, 'the fifth failure sets the lock');

  // The correct password now returns 429, not 200. Otherwise the lock is a
  // free oracle telling an attacker they guessed right.
  const correct = await attempt('the-real-password');
  assert.equal(correct.statusCode, 429);
  assert.equal(correct.payload.code, 'ACCOUNT_LOCKED');
  assert.ok(correct.payload.retryAfterSeconds > 0);

  assert.equal(tables.sms_auth_events.filter(event => event.code === 'ACCOUNT_LOCKED').length, 1);
  assert.equal(tables.sms_auth_events.every(event => event.outcome === 'failure'), true);
});

test('the shared password still works, and still resolves through the database', async () => {
  const { login, tables } = authFixture();
  delete process.env.LEGACY_SHARED_LOGIN;

  const req = makeRequest({ method: 'POST', url: '/auth/login', body: { password: 'the-shared-team-password' } });
  const res = responseRecorder();
  await login(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.success, true);
  assert.equal(res.payload.actor.isLegacyShared, true);
  assert.equal(req.session.uid, 1);
  assert.equal('role' in req.session, false);
  assert.equal(tables.sms_auth_events.some(event => event.method === 'legacy' && event.outcome === 'success'), true);

  const wrong = responseRecorder();
  await login(makeRequest({ method: 'POST', url: '/auth/login', body: { password: 'not-the-shared-password' } }), wrong);
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.payload.code, 'INVALID_CREDENTIALS');
});

test('the shared password can be switched off with one environment variable', async () => {
  const { login } = authFixture();
  process.env.LEGACY_SHARED_LOGIN = 'disabled';
  try {
    const res = responseRecorder();
    await login(makeRequest({ method: 'POST', url: '/auth/login', body: { password: 'the-shared-team-password' } }), res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.code, 'LEGACY_LOGIN_DISABLED');
  } finally {
    delete process.env.LEGACY_SHARED_LOGIN;
  }
});

test('auth/check reports a stale or disabled session as simply not authenticated', async () => {
  const { router, authz, tables } = authFixture();
  const check = handlerFor(router, 'GET', '/check');

  // The iOS client reads only `authenticated`; a false answer is what triggers
  // restoreSessionIfNeeded(), so this must never be an error status.
  const good = responseRecorder();
  await check(makeRequest({ url: '/auth/check', session: { v: 1, authenticated: true, uid: 3, se: 4 } }), good);
  assert.equal(good.payload.authenticated, true);
  assert.equal(good.payload.actor.role, 'agent');

  tables.sms_users.find(user => user.id === 3).session_epoch = 5;
  authz.invalidate(3);
  const stale = responseRecorder();
  await check(makeRequest({ url: '/auth/check', session: { v: 1, authenticated: true, uid: 3, se: 4 } }), stale);
  assert.equal(stale.statusCode, 200);
  assert.equal(stale.payload.authenticated, false);

  const legacy = responseRecorder();
  await check(makeRequest({ url: '/auth/check', session: { authenticated: true } }), legacy);
  assert.equal(legacy.payload.authenticated, true);
  assert.equal(legacy.payload.actor.viaLegacySession, true);

  const none = responseRecorder();
  await check(makeRequest({ url: '/auth/check', session: {} }), none);
  assert.deepEqual(none.payload, { authenticated: false });
});
