'use strict';

process.env.SUPABASE_URL ||= 'https://unit-test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'unit-test-service-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const createUsersRouter = require('../routes/users');

function actor(overrides = {}) {
  return {
    id: 42,
    email: 'new.user@example.com',
    displayName: 'New User',
    role: 'agent',
    permissions: new Set(['conversation.read']),
    isLegacyShared: false,
    viaLegacySession: false,
    mustChangePassword: false,
    ...overrides
  };
}

function storeFor(initial = {}) {
  const state = {
    row: {
      onboarding_status: 'not_started',
      onboarding_version: 1,
      onboarding_decided_at: null,
      ...initial
    },
    decisions: []
  };
  return {
    state,
    async getOnboarding() { return { ...state.row }; },
    async decideOnboarding(id, status, version) {
      state.decisions.push({ id, status, version });
      if (state.row.onboarding_status === 'not_started'
          && state.row.onboarding_version === version) {
        state.row.onboarding_status = status;
        state.row.onboarding_decided_at = '2026-08-22T12:00:00.000Z';
      }
      return { ...state.row };
    }
  };
}

function handlerFor(router, method, routePath) {
  const layer = router.stack.find(entry =>
    entry.route?.path === routePath && entry.route?.methods?.[method.toLowerCase()]);
  assert.ok(layer, `no handler for ${method} ${routePath}`);
  return layer.route.stack.at(-1).handle;
}

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    set() { return this; },
    json(payload) { this.payload = payload; return this; }
  };
}

async function call(router, method, routePath, req) {
  const res = responseRecorder();
  await handlerFor(router, method, routePath)(req, res);
  return res;
}

function fixture(initial) {
  const store = storeFor(initial);
  const router = createUsersRouter({
    store,
    emailChangeStore: {},
    authz: { invalidate() {} },
    audit: async () => {},
    sendMail: async () => ({ sent: true })
  });
  return { store, router };
}

test('GET /me positively marks only a new named account as tour eligible', async () => {
  const { router } = fixture();
  const res = await call(router, 'GET', '/me', { actor: actor() });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.onboarding, {
    status: 'not_started',
    version: 1,
    eligible: true,
    decidedAt: null
  });
});

test('existing ineligible accounts are returned fail-closed', async () => {
  const { router } = fixture({
    onboarding_status: 'ineligible',
    onboarding_decided_at: '2026-08-22T11:00:00.000Z'
  });
  const res = await call(router, 'GET', '/me', { actor: actor() });

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.onboarding.eligible, false);
  assert.equal(res.payload.onboarding.status, 'ineligible');
});

test('shared legacy sessions never receive automatic onboarding state', async () => {
  const { router, store } = fixture();
  store.getOnboarding = async () => { throw new Error('must not read'); };
  const res = await call(router, 'GET', '/me', {
    actor: actor({ id: 1, isLegacyShared: true, viaLegacySession: true })
  });

  assert.equal(res.statusCode, 200);
  assert.equal(Object.hasOwn(res.payload, 'onboarding'), false);
});

test('completion is account-owned and idempotent', async () => {
  const { router, store } = fixture();
  const request = {
    actor: actor(),
    body: { status: 'completed', version: 1, userId: '42' }
  };
  const first = await call(router, 'POST', '/me/onboarding', request);
  const second = await call(router, 'POST', '/me/onboarding', request);

  assert.equal(first.statusCode, 200);
  assert.equal(first.payload.onboarding.status, 'completed');
  assert.equal(second.statusCode, 200);
  assert.equal(store.state.decisions.length, 2);
  assert.ok(store.state.row.onboarding_decided_at);
});

test('a different account id is refused before any write', async () => {
  const { router, store } = fixture();
  const res = await call(router, 'POST', '/me/onboarding', {
    actor: actor(),
    body: { status: 'skipped', version: 1, userId: '99' }
  });

  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, 'ONBOARDING_USER_MISMATCH');
  assert.deepEqual(store.state.decisions, []);
});

test('invalid state and stale versions fail without changing eligibility', async () => {
  const invalid = fixture();
  const bad = await call(invalid.router, 'POST', '/me/onboarding', {
    actor: actor(), body: { status: 'not_started', version: 1, userId: '42' }
  });
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(invalid.store.state.decisions, []);

  const stale = fixture({ onboarding_version: 2 });
  const res = await call(stale.router, 'POST', '/me/onboarding', {
    actor: actor(), body: { status: 'completed', version: 1, userId: '42' }
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, 'ONBOARDING_VERSION_CHANGED');
  assert.equal(stale.store.state.row.onboarding_status, 'not_started');
});

test('the first terminal decision wins instead of silently changing skip to complete', async () => {
  const { router, store } = fixture();
  const skipped = await call(router, 'POST', '/me/onboarding', {
    actor: actor(), body: { status: 'skipped', version: 1, userId: '42' }
  });
  const completed = await call(router, 'POST', '/me/onboarding', {
    actor: actor(), body: { status: 'completed', version: 1, userId: '42' }
  });

  assert.equal(skipped.statusCode, 200);
  assert.equal(completed.statusCode, 409);
  assert.equal(completed.payload.code, 'ONBOARDING_ALREADY_DECIDED');
  assert.equal(store.state.row.onboarding_status, 'skipped');
});

test('the migration protects existing accounts then defaults future accounts to not_started', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'onboarding-migration.sql'),
    'utf8'
  );
  assert.match(sql, /ADD COLUMN onboarding_status text NOT NULL DEFAULT 'ineligible'/);
  assert.match(sql, /ALTER COLUMN onboarding_status SET DEFAULT 'not_started'/);
  assert.match(sql, /WHERE onboarding_status = 'ineligible'/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.decide_sms_user_onboarding/);
  assert.match(sql, /GRANT EXECUTE .* TO service_role/);
});
