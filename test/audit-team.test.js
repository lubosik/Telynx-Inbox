'use strict';
/**
 * test/audit-team.test.js — the `team` audit category.
 *
 * WHY THIS FILE EXISTS
 *   The stated purpose of the audit subsystem is that one Admin can see what
 *   another Admin did. Until this release the `team` category was declared in
 *   lib/audit/event-types.js and permitted by the sms_audit_log CHECK
 *   constraint, and then used by nothing: routes/users.js and
 *   routes/invitations.js contained no audit calls at all. The single most
 *   sensitive class of admin action — granting and revoking access — was
 *   invisible, and sms_auth_events does not cover it because it records
 *   sign-ins, not authority changes.
 *
 *   So these tests drive the REAL handlers, not hand-built rows. A future edit
 *   that quietly stops auditing a role change fails here.
 *
 * THE ASSERTION THAT MATTERS MOST
 *   No password hash, no invitation token, and no token hash may ever reach a
 *   row in a table with REVOKE DELETE and an immutability trigger. That is
 *   asserted against the serialised row, not against a key list, so a value
 *   smuggled in under a different name still fails.
 *
 * Offline: no network, no live database.
 */

process.env.SUPABASE_URL ||= 'https://unit-test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'unit-test-service-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const db = require('../db');
const { logAudit } = require('../lib/audit/log');
const createUsersRouter = require('../routes/users');
const createInvitationsRouter = require('../routes/invitations');
const { createInvitationStore, hashToken } = require('../routes/invitations');

// ── Fakes ──────────────────────────────────────────────────────────────────

const ROLE_CATALOGUE = Object.freeze([
  { key: 'owner', display_name: 'Owner', rank: 30, is_assignable: true },
  { key: 'admin', display_name: 'Admin', rank: 20, is_assignable: true },
  { key: 'agent', display_name: 'Support Agent', rank: 10, is_assignable: true }
]);

/** A chainable stand-in for a PostgREST query builder. */
function chain(resolve) {
  const self = {
    select: () => self,
    eq: () => self,
    is: () => self,
    ilike: () => self,
    order: () => self,
    limit: () => self,
    insert: () => self,
    upsert: () => self,
    update: () => self,
    delete: () => self,
    maybeSingle: async () => resolve(),
    single: async () => resolve(),
    then: (onFulfilled, onRejected) => Promise.resolve().then(resolve).then(onFulfilled, onRejected)
  };
  return self;
}

/**
 * Collects every sms_audit_log insert. Anything else resolves empty rather
 * than throwing, because these tests are about the audit rows, not the stores.
 */
function auditSink({ auditError = null } = {}) {
  const rows = [];
  const client = {
    rows,
    from(table) {
      if (table === 'sms_audit_log') {
        return {
          insert(row) {
            if (!auditError) rows.push(row);
            return chain(() => (auditError
              ? { data: null, error: auditError }
              : { data: { id: rows.length }, error: null }));
          }
        };
      }
      return chain(() => ({ data: null, error: null }));
    }
  };
  return client;
}

/**
 * The audit writer the routers are given. Runs the REAL lib/audit/log.js — so
 * the allowlist, the state screen and the row shape are all exercised — but
 * against the sink instead of Supabase.
 */
function auditWriter(sink) {
  return (input, options = {}) => logAudit(input, { ...options, client: sink, broadcast: () => {} });
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

function handlerFor(router, method, routePath) {
  const layer = router.stack.find(entry =>
    entry.route?.path === routePath && entry.route?.methods?.[method.toLowerCase()]);
  assert.ok(layer, `no handler for ${method} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeRequest({ params = {}, body = {}, actor = null, ip = '203.0.113.9' } = {}) {
  return {
    params,
    body,
    actor,
    ip,
    get: name => (name === 'user-agent' ? 'ViciInbox/1.4 (iPhone)' : null)
  };
}

function actorFrom({ id, displayName, role, permissions = [] }) {
  return { id, displayName, role, permissions: new Set(permissions) };
}

const OWNER = actorFrom({
  id: 9, displayName: 'Lubosi', role: 'owner', permissions: ['user.manage', 'user.manage.owner']
});
const ADMIN = actorFrom({ id: 7, displayName: 'Dominic', role: 'admin', permissions: ['user.manage'] });

/**
 * A user store with real-enough behaviour. Every user carries a password_hash
 * so the "no hash in the audit row" assertions have something to catch.
 */
function makeUserStore(seed = []) {
  const state = {
    users: seed.map(row => ({
      is_active: true,
      is_legacy_shared: false,
      must_change_password: false,
      password_hash: `scrypt$1$${crypto.randomBytes(16).toString('hex')}$${crypto.randomBytes(32).toString('hex')}`,
      created_at: '2026-01-01T00:00:00.000Z',
      ...row
    })),
    grants: [],
    epochBumps: []
  };
  return {
    state,
    async list() { return state.users; },
    async getById(id) { return state.users.find(row => row.id === Number(id)) || null; },
    async findByEmail(email) {
      return state.users.find(row => row.email.toLowerCase() === String(email).toLowerCase()) || null;
    },
    async create(row) {
      const created = { id: 100 + state.users.length, is_active: true, is_legacy_shared: false, ...row };
      state.users.push(created);
      return created;
    },
    async update(id, patch) {
      const row = state.users.find(entry => entry.id === Number(id));
      Object.assign(row, patch);
      return row;
    },
    async countActiveAdministrators() {
      return state.users.filter(row => row.is_active && ['owner', 'admin'].includes(row.role)).length;
    },
    async bumpEpoch(id) { state.epochBumps.push(Number(id)); return state.epochBumps.length; },
    async listRoles() { return ROLE_CATALOGUE.map(role => ({ ...role })); },
    async listPermissionKeys() { return ['automation.cancel', 'analytics.read', 'user.manage.owner']; },
    async listGrants() { return state.grants; },
    async upsertGrant(row) { state.grants.push(row); return row; },
    async deleteGrant(userId, key) {
      state.grants = state.grants.filter(row => !(row.user_id === userId && row.permission_key === key));
      return true;
    }
  };
}

const NO_OP_AUTHZ = { invalidate() {} };

function usersFixture(seed) {
  const sink = auditSink();
  const store = makeUserStore(seed);
  const router = createUsersRouter({ store, authz: NO_OP_AUTHZ, audit: auditWriter(sink) });
  return { sink, store, router };
}

/** The team as it stands in every test below. */
function team() {
  return [
    { id: 9, email: 'lubosi@example.com', display_name: 'Lubosi', role: 'owner' },
    { id: 7, email: 'dominic@example.com', display_name: 'Dominic', role: 'admin' },
    { id: 4, email: 'sarah@example.com', display_name: 'Sarah', role: 'agent' }
  ];
}

/**
 * Every credential-shaped string that exists anywhere in the fixture. No audit
 * row may contain any of them, under any key.
 */
function credentialsIn(store) {
  return store.state.users.map(row => row.password_hash).filter(Boolean);
}

function assertNoCredentials(rows, secrets) {
  const serialised = JSON.stringify(rows);
  for (const secret of secrets) {
    assert.equal(serialised.includes(secret), false, `a credential reached the audit trail: ${secret.slice(0, 12)}...`);
  }
  assert.equal(/password_hash/.test(serialised), false, 'the key password_hash must not appear');
  assert.equal(/token_hash/.test(serialised), false, 'the key token_hash must not appear');
  assert.equal(/"token"/.test(serialised), false, 'the key token must not appear');
}

// ── The flagship: a role change ────────────────────────────────────────────

test('promoting an agent writes one team.member.role_changed row that reads like a sentence', async () => {
  const { sink, store, router } = usersFixture(team());

  const res = responseRecorder();
  await handlerFor(router, 'PATCH', '/:id')(
    makeRequest({ params: { id: '4' }, actor: OWNER, body: { role: 'admin' } }),
    res
  );
  assert.equal(res.statusCode, 200);

  assert.equal(sink.rows.length, 1, 'one role change must produce exactly one audit row');
  const row = sink.rows[0];

  assert.equal(row.event_type, 'team.member.role_changed');
  assert.equal(row.category, 'team', 'the team category must finally be in use');
  assert.equal(row.entity_type, 'user');
  assert.equal(row.entity_id, '4');
  assert.equal(row.visibility, 'feed');
  assert.equal(row.severity, 'warning');

  // Named actor, named target, catalogue display names on both sides. This is
  // the sentence somebody reads in two years with no other context.
  assert.equal(row.summary, 'Lubosi changed Sarah from Support Agent to Admin');
  assert.equal(row.summary.includes('agent'), false, 'the raw role key must not appear in the summary');

  assert.equal(row.actor_user_id, 9);
  assert.equal(row.actor_display_name, 'Lubosi');
  assert.equal(row.actor_role, 'owner');

  assert.deepEqual(row.previous_state, { role: 'agent' });
  assert.deepEqual(row.new_state, { role: 'admin' });
  assert.deepEqual(row.changed_fields, ['role']);

  // Machine-readable keys alongside the human-readable names.
  assert.equal(row.metadata.previous_role, 'agent');
  assert.equal(row.metadata.new_role, 'admin');
  assert.equal(row.metadata.previous_role_display_name, 'Support Agent');
  assert.equal(row.metadata.new_role_display_name, 'Admin');
  assert.equal(row.metadata.user_id, 4);
  assert.equal(row.metadata.logins_revoked, true);

  assertNoCredentials(sink.rows, credentialsIn(store));
});

test('the role display names come from the catalogue, not from a hardcoded map', async () => {
  const { sink, router, store } = usersFixture(team());
  // Rename the role. A row written after the rename must use the new name.
  store.listRoles = async () => [
    { key: 'admin', display_name: 'Administrator', is_assignable: true },
    { key: 'agent', display_name: 'Front Desk', is_assignable: true }
  ];

  await handlerFor(router, 'PATCH', '/:id')(
    makeRequest({ params: { id: '4' }, actor: OWNER, body: { role: 'admin' } }),
    responseRecorder()
  );

  assert.equal(sink.rows[0].summary, 'Lubosi changed Sarah from Front Desk to Administrator');
});

test('a PATCH that changes no role and no grants writes no team row', async () => {
  const { sink, router } = usersFixture(team());
  const res = responseRecorder();
  await handlerFor(router, 'PATCH', '/:id')(
    makeRequest({ params: { id: '4' }, actor: OWNER, body: { displayName: 'Sarah Chen' } }),
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(sink.rows.length, 0, 'a rename is not an authority change');
});

test('a refused role change writes nothing: there is no state to audit', async () => {
  const { sink, router } = usersFixture(team());
  const res = responseRecorder();
  await handlerFor(router, 'PATCH', '/:id')(
    // Admin cannot grant Owner.
    makeRequest({ params: { id: '4' }, actor: ADMIN, body: { role: 'owner' } }),
    res
  );
  assert.equal(res.statusCode, 403);
  assert.equal(sink.rows.length, 0);
});

// ── Activation, deactivation, reactivation ─────────────────────────────────

test('creating an account writes team.member.activated naming actor, target and role', async () => {
  const { sink, store, router } = usersFixture(team());

  const res = responseRecorder();
  await handlerFor(router, 'POST', '/')(
    makeRequest({
      actor: OWNER,
      body: { email: 'newbie@example.com', displayName: 'Newbie', role: 'agent', password: 'a-perfectly-fine-password' }
    }),
    res
  );
  assert.equal(res.statusCode, 201);

  assert.equal(sink.rows.length, 1);
  const row = sink.rows[0];
  assert.equal(row.event_type, 'team.member.activated');
  assert.equal(row.category, 'team');
  assert.equal(row.summary, 'Lubosi created the account for Newbie (newbie@example.com) as Support Agent');
  assert.equal(row.metadata.via, 'direct_creation');
  assert.equal(row.metadata.can_sign_in, true);
  assert.equal(row.new_state.role, 'agent');

  // The account was created WITH a password, so a hash exists. It must not be
  // anywhere on the row, and neither must the plaintext.
  assertNoCredentials(sink.rows, credentialsIn(store));
  assert.equal(JSON.stringify(sink.rows).includes('a-perfectly-fine-password'), false);
});

test('deactivating a person writes team.member.deactivated with before/after', async () => {
  const { sink, store, router } = usersFixture(team());

  const res = responseRecorder();
  await handlerFor(router, 'POST', '/:id/deactivate')(
    makeRequest({ params: { id: '4' }, actor: ADMIN }),
    res
  );
  assert.equal(res.statusCode, 200);

  const row = sink.rows[0];
  assert.equal(row.event_type, 'team.member.deactivated');
  assert.equal(row.severity, 'warning');
  assert.equal(row.summary, 'Dominic deactivated Sarah (Support Agent) and ended their sessions');
  assert.equal(row.previous_state.is_active, true);
  assert.equal(row.new_state.is_active, false);
  assert.deepEqual(row.changed_fields, ['is_active']);
  assert.equal(row.metadata.logins_revoked, true);
  assertNoCredentials(sink.rows, credentialsIn(store));
});

test('a refused deactivation of the last administrator writes nothing', async () => {
  const { sink, router } = usersFixture([
    { id: 9, email: 'lubosi@example.com', display_name: 'Lubosi', role: 'owner' }
  ]);
  const res = responseRecorder();
  await handlerFor(router, 'POST', '/:id/deactivate')(
    makeRequest({ params: { id: '9' }, actor: OWNER }),
    res
  );
  assert.equal(res.statusCode, 409);
  assert.equal(sink.rows.length, 0);
});

test('reactivating a person writes team.member.reactivated, not another role change', async () => {
  const seed = team();
  seed[2].is_active = false;
  const { sink, router } = usersFixture(seed);

  const res = responseRecorder();
  await handlerFor(router, 'PATCH', '/:id')(
    makeRequest({ params: { id: '4' }, actor: OWNER, body: { isActive: true } }),
    res
  );
  assert.equal(res.statusCode, 200);

  assert.equal(sink.rows.length, 1);
  assert.equal(sink.rows[0].event_type, 'team.member.reactivated');
  assert.equal(sink.rows[0].summary, 'Lubosi reactivated Sarah as Support Agent');
  assert.equal(sink.rows[0].previous_state.is_active, false);
  assert.equal(sink.rows[0].new_state.is_active, true);
});

// ── Password reset ─────────────────────────────────────────────────────────

test('an admin password reset is audited, and neither the temporary password nor its hash is', async () => {
  const { sink, store, router } = usersFixture(team());

  const res = responseRecorder();
  await handlerFor(router, 'POST', '/:id/reset-password')(
    makeRequest({ params: { id: '4' }, actor: ADMIN }),
    res
  );
  assert.equal(res.statusCode, 200);

  const temporaryPassword = res.payload.temporaryPassword;
  assert.equal(typeof temporaryPassword, 'string');
  assert.ok(temporaryPassword.length >= 16);

  const row = sink.rows[0];
  assert.equal(row.event_type, 'team.member.password_reset');
  assert.equal(row.severity, 'warning');
  assert.equal(row.summary, 'Dominic reset the password for Sarah (Support Agent) and ended their sessions');
  assert.equal(row.metadata.reset_method, 'admin_temporary_password');
  assert.equal(row.metadata.must_rotate_on_next_sign_in, true);

  const serialised = JSON.stringify(sink.rows);
  assert.equal(serialised.includes(temporaryPassword), false, 'the temporary password must never be stored');
  assertNoCredentials(sink.rows, credentialsIn(store));
});

// ── Permission overrides ───────────────────────────────────────────────────

test('per-user permission overrides are audited one row each, granted and revoked separately', async () => {
  const { sink, router } = usersFixture(team());

  const res = responseRecorder();
  await handlerFor(router, 'PATCH', '/:id')(
    makeRequest({
      params: { id: '4' },
      actor: OWNER,
      body: {
        grants: [{ permissionKey: 'automation.cancel', effect: 'allow', reason: 'covering the holidays' }],
        revokeGrants: ['analytics.read']
      }
    }),
    res
  );
  assert.equal(res.statusCode, 200);

  assert.equal(sink.rows.length, 2);
  const granted = sink.rows.find(row => row.event_type === 'team.permission_override.granted');
  const revoked = sink.rows.find(row => row.event_type === 'team.permission_override.revoked');

  assert.equal(granted.category, 'team');
  assert.equal(granted.entity_type, 'user_permission_grant');
  assert.equal(granted.summary, 'Lubosi added a per-user "allow" override for automation.cancel on Sarah');
  assert.equal(granted.metadata.permission_key, 'automation.cancel');
  assert.equal(granted.metadata.effect, 'allow');
  assert.equal(granted.metadata.reason, 'covering the holidays');

  assert.equal(revoked.summary, 'Lubosi removed the per-user override for analytics.read from Sarah');
  assert.equal(revoked.metadata.permission_key, 'analytics.read');
});

// ── Invitations ────────────────────────────────────────────────────────────

function makeInvitationStore(rows = []) {
  const state = { rows };
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
    async revoke(id) {
      const row = state.rows.find(entry => entry.id === id);
      row.revoked_at = new Date().toISOString();
      return row;
    },
    async redeem() { throw new Error('not used in this test'); },
    async noteAttempt() {}
  };
}

test('inviting somebody is audited, and not one byte of the token or its hash goes with it', async () => {
  const sink = auditSink();
  const store = makeInvitationStore();
  const router = createInvitationsRouter({
    store, userStore: makeUserStore(team()), audit: auditWriter(sink)
  });

  const res = responseRecorder();
  await handlerFor(router, 'POST', '/')(
    makeRequest({ actor: OWNER, body: { email: 'newbie@example.com', displayName: 'Newbie', role: 'agent' } }),
    res
  );
  assert.equal(res.statusCode, 201);

  const rawToken = res.payload.token;
  const tokenHash = hashToken(rawToken);
  const tokenPrefix = tokenHash.slice(0, 8);

  assert.equal(sink.rows.length, 1);
  const row = sink.rows[0];
  assert.equal(row.event_type, 'team.member.invited');
  assert.equal(row.category, 'team');
  assert.equal(row.entity_type, 'user_invitation');
  assert.match(row.summary, /^Lubosi invited newbie@example\.com to join as Support Agent, expiring /);
  assert.equal(row.metadata.email, 'newbie@example.com');
  assert.equal(row.metadata.role_display_name, 'Support Agent');
  assert.equal(row.metadata.ttl_hours, 168);

  const serialised = JSON.stringify(sink.rows);
  assert.equal(serialised.includes(rawToken), false, 'the raw invitation token must never be audited');
  assert.equal(serialised.includes(tokenHash), false, 'the token hash must never be audited');
  assert.equal(serialised.includes(tokenPrefix), false, 'not even the hash prefix may be audited');
  assert.equal(serialised.includes('token'), false, 'no token-shaped key may appear at all');
});

test('revoking an invitation is audited with before/after status', async () => {
  const sink = auditSink();
  const id = crypto.randomUUID();
  const store = makeInvitationStore([{
    id,
    email: 'newbie@example.com',
    display_name: 'Newbie',
    role_key: 'agent',
    token_hash: hashToken('a'.repeat(43)),
    token_prefix: hashToken('a'.repeat(43)).slice(0, 8),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    accepted_at: null,
    revoked_at: null
  }]);
  const router = createInvitationsRouter({
    store, userStore: makeUserStore(team()), audit: auditWriter(sink)
  });

  const res = responseRecorder();
  await handlerFor(router, 'POST', '/:id/revoke')(makeRequest({ params: { id }, actor: ADMIN }), res);
  assert.equal(res.statusCode, 200);

  const row = sink.rows[0];
  assert.equal(row.event_type, 'team.invitation.revoked');
  assert.equal(row.summary, 'Dominic revoked the unused invitation for newbie@example.com (Support Agent)');
  assert.deepEqual(row.previous_state, { invitation_status: 'open' });
  assert.deepEqual(row.new_state, { invitation_status: 'revoked' });
  assert.equal(JSON.stringify(sink.rows).includes(store.state.rows[0].token_hash), false);
});

test('an already-revoked invitation is not audited twice', async () => {
  const sink = auditSink();
  const id = crypto.randomUUID();
  const store = makeInvitationStore([{
    id,
    email: 'newbie@example.com',
    role_key: 'agent',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    accepted_at: null,
    revoked_at: new Date().toISOString()
  }]);
  const router = createInvitationsRouter({
    store, userStore: makeUserStore(team()), audit: auditWriter(sink)
  });

  const res = responseRecorder();
  await handlerFor(router, 'POST', '/:id/revoke')(makeRequest({ params: { id }, actor: ADMIN }), res);
  assert.equal(res.payload.alreadyRevoked, true);
  assert.equal(sink.rows.length, 0);
});

// ── Redemption ─────────────────────────────────────────────────────────────

/**
 * Redemption is audited inside createInvitationStore.redeem() rather than at
 * POST /auth/invitation/accept, because that is the only seam this change is
 * allowed to touch and it is where the account actually comes into existence.
 * This exercises the real store against a fake Supabase client.
 */
test('redeeming an invitation writes team.member.activated with the invitee as the actor', async () => {
  const rawToken = 'b'.repeat(43);
  const invitation = {
    id: crypto.randomUUID(),
    email: 'newbie@example.com',
    display_name: 'Newbie',
    role_key: 'agent'
  };
  const auditRows = [];

  const client = {
    from(table) {
      if (table === 'sms_audit_log') {
        return {
          insert(row) {
            auditRows.push(row);
            return chain(() => ({ data: { id: auditRows.length }, error: null }));
          }
        };
      }
      if (table === 'sms_invitations') return chain(() => ({ data: invitation, error: null }));
      if (table === 'sms_roles') {
        return chain(() => ({ data: { key: 'agent', display_name: 'Support Agent' }, error: null }));
      }
      return chain(() => ({ data: null, error: null }));
    },
    async rpc() { return { data: 501, error: null }; }
  };

  // logAuditSafely inside the store resolves the shared singleton, so the
  // singleton is what has to be swapped. Same approach as audit-log.test.js.
  const originalFrom = db.supabase.from;
  db.supabase.from = client.from.bind(client);
  let userId;
  try {
    userId = await createInvitationStore({ client }).redeem(hashToken(rawToken), 'scrypt$1$deadbeef$cafebabe');
  } finally {
    db.supabase.from = originalFrom;
  }

  assert.equal(userId, 501, 'redemption must still return the new user id');
  assert.equal(auditRows.length, 1);
  const row = auditRows[0];
  assert.equal(row.event_type, 'team.member.activated');
  assert.equal(row.category, 'team');
  assert.equal(row.actor_user_id, 501, 'the invitee is the actor');
  assert.equal(row.actor_display_name, 'Newbie');
  assert.equal(row.summary, 'Newbie accepted their invitation and activated an account as Support Agent');
  assert.equal(row.metadata.via, 'invitation');
  assert.equal(row.metadata.invitation_id, invitation.id);

  const serialised = JSON.stringify(auditRows);
  assert.equal(serialised.includes(rawToken), false);
  assert.equal(serialised.includes(hashToken(rawToken)), false);
  assert.equal(serialised.includes('scrypt$1$deadbeef$cafebabe'), false, 'the password hash must not be audited');
});

test('a failed audit never blocks a redemption: the account is already created', async () => {
  const client = {
    from(table) {
      if (table === 'sms_invitations') return chain(() => ({ data: null, error: { message: 'boom' } }));
      return chain(() => ({ data: null, error: null }));
    },
    async rpc() { return { data: 777, error: null }; }
  };

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const userId = await createInvitationStore({ client }).redeem('a'.repeat(64), 'hash');
    assert.equal(userId, 777);
  } finally {
    console.warn = originalWarn;
  }
});

// ── The whole category, end to end ─────────────────────────────────────────

test('every declared team.* event type is emittable and lands in the team category', async () => {
  const { EVENT_TYPES } = require('../lib/audit/event-types');
  const teamTypes = Object.keys(EVENT_TYPES).filter(name => name.startsWith('team.'));

  assert.ok(teamTypes.length >= 9, `the team category must not be empty, found ${teamTypes.length}`);
  for (const eventType of teamTypes) {
    assert.equal(EVENT_TYPES[eventType].category, 'team', `${eventType} must be in the team category`);
    assert.equal(EVENT_TYPES[eventType].reserved, undefined, `${eventType} must not be reserved`);

    const sink = auditSink();
    await logAudit(
      { eventType, summary: 'probe' },
      { client: sink, broadcast: () => {} }
    );
    assert.equal(sink.rows.length, 1, `${eventType} must be writable`);
    assert.equal(sink.rows[0].category, 'team');
  }
});

test('an audit failure never breaks a role change: the change has already landed', async () => {
  const store = makeUserStore(team());
  const sink = auditSink({ auditError: { code: 'XX000', message: 'connection reset' } });
  const router = createUsersRouter({ store, authz: NO_OP_AUTHZ, audit: auditWriter(sink) });

  const originalError = console.error;
  console.error = () => {};
  let res;
  try {
    res = responseRecorder();
    await handlerFor(router, 'PATCH', '/:id')(
      makeRequest({ params: { id: '4' }, actor: OWNER, body: { role: 'admin' } }),
      res
    );
  } finally {
    console.error = originalError;
  }

  assert.equal(res.statusCode, 200, 'the caller must still be told the change succeeded');
  assert.equal(store.state.users.find(row => row.id === 4).role, 'admin');
});

test('redemption records the IP, user-agent and request id of the activation', async () => {
  // `auditRedemption` took no `req`, so the ONE row marking the creation of a
  // new sign-in identity carried no IP, no user-agent and no request id. It is
  // also the only unauthenticated write in the team category, which is exactly
  // where "activated from where?" is worth being able to answer.
  //
  // Passing `req` alongside the explicit invitee actor is safe by construction:
  // resolveActor in lib/audit/log.js prefers `input.actor` over `req.actor`,
  // while clientIP/clientUserAgent/requestID read `req` and nothing else.
  const rawToken = 'c'.repeat(43);
  const invitation = {
    id: crypto.randomUUID(),
    email: 'ip@example.com',
    display_name: 'Traceable',
    role_key: 'agent'
  };
  const auditRows = [];

  const client = {
    from(table) {
      if (table === 'sms_audit_log') {
        return {
          insert(row) {
            auditRows.push(row);
            return chain(() => ({ data: { id: auditRows.length }, error: null }));
          }
        };
      }
      if (table === 'sms_invitations') return chain(() => ({ data: invitation, error: null }));
      if (table === 'sms_roles') {
        return chain(() => ({ data: { key: 'agent', display_name: 'Support Agent' }, error: null }));
      }
      return chain(() => ({ data: null, error: null }));
    },
    async rpc() { return { data: 902, error: null }; }
  };

  const headers = { 'user-agent': 'ViciInbox/1.0 (iPhone)', 'x-request-id': 'req-abc-123' };
  const req = {
    ip: '203.0.113.7',
    // Deliberately populated, and deliberately NOT the actor on the row: an
    // Admin holding the invitation link must not be recorded as the invitee.
    actor: { type: 'user', id: 1, displayName: 'Some Admin', role: 'admin' },
    get: name => headers[String(name).toLowerCase()] || null
  };

  const originalFrom = db.supabase.from;
  db.supabase.from = client.from.bind(client);
  try {
    await createInvitationStore({ client }).redeem(hashToken(rawToken), 'scrypt$1$aa$bb', req);
  } finally {
    db.supabase.from = originalFrom;
  }

  assert.equal(auditRows.length, 1);
  const row = auditRows[0];
  assert.equal(row.ip, '203.0.113.7');
  assert.equal(row.user_agent, 'ViciInbox/1.0 (iPhone)');
  assert.equal(row.request_id, 'req-abc-123');
  assert.equal(row.actor_user_id, 902, 'the invitee is still the actor, not req.actor');
  assert.equal(row.actor_display_name, 'Traceable');
  assert.equal(row.actor_role, 'agent');
});

test('redemption without a req still succeeds, with null request context', async () => {
  // The third argument is optional so existing callers keep working.
  const invitation = { id: crypto.randomUUID(), email: 'x@example.com', display_name: 'X', role_key: 'agent' };
  const auditRows = [];
  const client = {
    from(table) {
      if (table === 'sms_audit_log') {
        return { insert(row) { auditRows.push(row); return chain(() => ({ data: { id: 1 }, error: null })); } };
      }
      if (table === 'sms_invitations') return chain(() => ({ data: invitation, error: null }));
      return chain(() => ({ data: null, error: null }));
    },
    async rpc() { return { data: 903, error: null }; }
  };

  const originalFrom = db.supabase.from;
  db.supabase.from = client.from.bind(client);
  try {
    assert.equal(await createInvitationStore({ client }).redeem('d'.repeat(64), 'hash'), 903);
  } finally {
    db.supabase.from = originalFrom;
  }
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].ip, null);
  assert.equal(auditRows[0].user_agent, null);
  assert.equal(auditRows[0].request_id, null);
});
