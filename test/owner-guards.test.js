'use strict';
/**
 * test/owner-guards.test.js — an Owner may not act on another Owner.
 *
 * WHY THIS FILE EXISTS
 *   `ownerTransitionError` in routes/users.js asked one question: does the
 *   ACTOR hold `user.manage.owner`? An Owner always does. So Owner was a role
 *   that could dismantle itself — any Owner could demote, deactivate or reset
 *   the password of a peer Owner, and because every one of those paths revokes
 *   the target's sessions in the same request, the loser was locked out
 *   immediately and could not undo it. The product owner's rule is the
 *   opposite: "an owner can edit the role of an admin or support agent, but it
 *   cannot edit the role or deactivate another owner."
 *
 * WHAT THESE TESTS ASSERT, AND WHY IT IS NOT JUST THE STATUS CODE
 *   A 403 proves the response was refused. It does not prove the handler
 *   refused BEFORE it wrote anything, and this handler has mutating calls
 *   (`upsertGrant`, `deleteGrant`, `update`, `bumpEpoch`) scattered through it.
 *   A guard placed one line too low returns the right status and still demotes
 *   the user. So every refusal here asserts on the fixture: the target row is
 *   byte-for-byte what it was, no grant was written, and no session epoch was
 *   bumped. The status code is checked as well, never instead.
 *
 *   The refusal must also be silent in the audit trail. An action that did not
 *   happen must not be recorded as if it had, so each refusal asserts zero
 *   rows reached the sink.
 *
 * WHAT MUST KEEP WORKING
 *   Promotion TO Owner — the product owner explicitly wants a second Owner.
 *   Self-service — an Owner stepping down.
 *   The last-administrator guard — the workspace can never be left with no
 *   Owner or Admin, including via a self-demotion.
 *
 * Offline: the stores are fakes, there is no database and no network.
 */

process.env.SUPABASE_URL ||= 'https://unit-test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'unit-test-service-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const createUsersRouter = require('../routes/users');

// ── Fixtures ───────────────────────────────────────────────────────────────

const ROLE_CATALOGUE = Object.freeze([
  { key: 'owner', display_name: 'Owner', rank: 30, is_assignable: true },
  { key: 'admin', display_name: 'Admin', rank: 20, is_assignable: true },
  { key: 'agent', display_name: 'Support Agent', rank: 10, is_assignable: true }
]);

/**
 * Two Owners on purpose. The database permits it and the product wants it, so
 * the fixture has to contain the exact situation the guard is about.
 */
function team() {
  return [
    { id: 9, email: 'lubosi@example.com', display_name: 'Lubosi', role: 'owner' },
    { id: 8, email: 'second@example.com', display_name: 'Second Owner', role: 'owner' },
    { id: 7, email: 'dominic@example.com', display_name: 'Dominic', role: 'admin' },
    { id: 4, email: 'sarah@example.com', display_name: 'Sarah', role: 'agent' }
  ];
}

function makeUserStore(seed = team()) {
  const state = {
    users: seed.map(row => ({
      is_active: true,
      is_legacy_shared: false,
      must_change_password: false,
      password_hash: `scrypt$1$fixed-salt-${row.id}$fixed-hash-${row.id}`,
      created_at: '2026-01-01T00:00:00.000Z',
      ...row
    })),
    grants: [],
    deletedGrants: [],
    epochBumps: [],
    updates: []
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
      state.updates.push({ id: Number(id), patch });
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
      state.deletedGrants.push({ userId, key });
      state.grants = state.grants.filter(row => !(row.user_id === userId && row.permission_key === key));
      return true;
    }
  };
}

function actorFrom({ id, displayName, role, permissions }) {
  return { id, displayName, role, permissions: new Set(permissions) };
}

const OWNER = actorFrom({
  id: 9, displayName: 'Lubosi', role: 'owner', permissions: ['user.manage', 'user.manage.owner']
});
const SECOND_OWNER = actorFrom({
  id: 8, displayName: 'Second Owner', role: 'owner', permissions: ['user.manage', 'user.manage.owner']
});
const ADMIN = actorFrom({
  id: 7, displayName: 'Dominic', role: 'admin', permissions: ['user.manage']
});

const NO_OP_AUTHZ = { invalidate() {} };

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

function makeRequest({ params = {}, body = {}, actor = null } = {}) {
  return {
    params,
    body,
    actor,
    ip: '203.0.113.9',
    get: name => (name === 'user-agent' ? 'ViciInbox/1.4 (iPhone)' : null)
  };
}

/**
 * A fixture whose audit writer is a plain collector. These tests are about
 * whether a row was written AT ALL, not about its shape — test/audit-team.js
 * owns the shape — so the real writer would only add noise.
 */
function fixture(seed) {
  const auditRows = [];
  const store = makeUserStore(seed);
  const router = createUsersRouter({
    store,
    authz: NO_OP_AUTHZ,
    audit: async input => { auditRows.push(input); }
  });
  return { store, router, auditRows };
}

/** A deep copy of one user row, for before/after comparison. */
function snapshot(store, id) {
  return JSON.parse(JSON.stringify(store.state.users.find(row => row.id === id)));
}

async function call(router, method, routePath, request) {
  const res = responseRecorder();
  await handlerFor(router, method, routePath)(request, res);
  return res;
}

/**
 * The assertion that actually protects the peer Owner: refused, unchanged,
 * un-audited, and no session revoked.
 */
function assertRefusedAndUntouched({ res, store, auditRows, before, targetId, code, status }) {
  assert.equal(res.statusCode, status, `expected HTTP ${status}, got ${res.statusCode}`);
  assert.equal(res.payload?.code, code, `expected code ${code}, got ${res.payload?.code}`);
  assert.ok(res.payload?.error, 'a refusal must carry a human-readable message');

  assert.deepEqual(
    snapshot(store, targetId), before,
    'the target row changed despite the request being refused — the guard runs too late'
  );
  assert.deepEqual(store.state.updates, [], 'no write may be issued for a refused request');
  assert.deepEqual(store.state.grants, [], 'no permission override may be written for a refused request');
  assert.deepEqual(store.state.deletedGrants, [], 'no permission override may be deleted for a refused request');
  assert.deepEqual(
    store.state.epochBumps, [],
    'a refused request must not revoke the target\'s sessions'
  );
  assert.deepEqual(auditRows, [], 'a refused action must not write an audit row');
}

// ── An Owner may not act on a peer Owner ───────────────────────────────────

test('an Owner cannot demote another Owner, and the peer Owner is unchanged', async () => {
  const { store, router, auditRows } = fixture();
  const before = snapshot(store, 8);

  const res = await call(router, 'PATCH', '/:id', makeRequest({
    params: { id: '8' }, body: { role: 'admin' }, actor: OWNER
  }));

  assertRefusedAndUntouched({
    res, store, auditRows, before, targetId: 8,
    status: 409, code: 'CANNOT_MODIFY_PEER_OWNER'
  });
  assert.equal(store.state.users.find(row => row.id === 8).role, 'owner');
});

test('an Owner cannot demote another Owner all the way to agent either', async () => {
  const { store, router, auditRows } = fixture();
  const before = snapshot(store, 8);

  const res = await call(router, 'PATCH', '/:id', makeRequest({
    params: { id: '8' }, body: { role: 'agent' }, actor: OWNER
  }));

  assertRefusedAndUntouched({
    res, store, auditRows, before, targetId: 8,
    status: 409, code: 'CANNOT_MODIFY_PEER_OWNER'
  });
});

test('an Owner cannot deactivate another Owner, and no session is revoked', async () => {
  const { store, router, auditRows } = fixture();
  const before = snapshot(store, 8);

  const res = await call(router, 'POST', '/:id/deactivate', makeRequest({
    params: { id: '8' }, actor: OWNER
  }));

  assertRefusedAndUntouched({
    res, store, auditRows, before, targetId: 8,
    status: 409, code: 'CANNOT_MODIFY_PEER_OWNER'
  });
  assert.equal(store.state.users.find(row => row.id === 8).is_active, true);
});

test('an Owner cannot reset another Owner\'s password, and no credential is minted', async () => {
  const { store, router, auditRows } = fixture();
  const before = snapshot(store, 8);

  const res = await call(router, 'POST', '/:id/reset-password', makeRequest({
    params: { id: '8' }, actor: OWNER
  }));

  assertRefusedAndUntouched({
    res, store, auditRows, before, targetId: 8,
    status: 409, code: 'CANNOT_MODIFY_PEER_OWNER'
  });
  // The most important part of this one: the response cannot leak a temporary
  // password for an account the caller was not allowed to touch.
  assert.equal(res.payload.temporaryPassword, undefined);
  assert.equal(store.state.users.find(row => row.id === 8).password_hash, before.password_hash);
});

test('an Owner cannot add a permission override to another Owner', async () => {
  const { store, router, auditRows } = fixture();
  const before = snapshot(store, 8);

  const res = await call(router, 'PATCH', '/:id', makeRequest({
    params: { id: '8' },
    body: { grants: [{ permissionKey: 'analytics.read', effect: 'deny' }] },
    actor: OWNER
  }));

  assertRefusedAndUntouched({
    res, store, auditRows, before, targetId: 8,
    status: 409, code: 'CANNOT_MODIFY_PEER_OWNER'
  });
});

test('an Owner cannot revoke a permission override from another Owner', async () => {
  const { store, router, auditRows } = fixture();
  const before = snapshot(store, 8);

  const res = await call(router, 'PATCH', '/:id', makeRequest({
    params: { id: '8' }, body: { revokeGrants: ['analytics.read'] }, actor: OWNER
  }));

  assertRefusedAndUntouched({
    res, store, auditRows, before, targetId: 8,
    status: 409, code: 'CANNOT_MODIFY_PEER_OWNER'
  });
});

test('an Owner cannot reactivate a deactivated peer Owner', async () => {
  const seed = team();
  seed.find(row => row.id === 8).role = 'owner';
  const { store, router, auditRows } = fixture(seed);
  store.state.users.find(row => row.id === 8).is_active = false;
  const before = snapshot(store, 8);

  const res = await call(router, 'PATCH', '/:id', makeRequest({
    params: { id: '8' }, body: { isActive: true }, actor: OWNER
  }));

  assertRefusedAndUntouched({
    res, store, auditRows, before, targetId: 8,
    status: 409, code: 'CANNOT_MODIFY_PEER_OWNER'
  });
});

test('the refusal is symmetric: the second Owner cannot act on the first either', async () => {
  const { store, router, auditRows } = fixture();
  const before = snapshot(store, 9);

  const res = await call(router, 'PATCH', '/:id', makeRequest({
    params: { id: '9' }, body: { role: 'admin' }, actor: SECOND_OWNER
  }));

  assertRefusedAndUntouched({
    res, store, auditRows, before, targetId: 9,
    status: 409, code: 'CANNOT_MODIFY_PEER_OWNER'
  });
});

test('the refusal explains itself in words an admin can act on', async () => {
  const { router } = fixture();
  const res = await call(router, 'PATCH', '/:id', makeRequest({
    params: { id: '8' }, body: { role: 'admin' }, actor: OWNER
  }));

  assert.match(res.payload.error, /Owner/);
  assert.match(res.payload.error, /themselves|step down/i,
    'the message must say what the caller can do instead');
});

// ── What must keep working ─────────────────────────────────────────────────

test('an Owner CAN promote an admin to Owner — a second Owner is a supported action', async () => {
  const { store, router, auditRows } = fixture();

  const res = await call(router, 'PATCH', '/:id', makeRequest({
    params: { id: '7' }, body: { role: 'owner' }, actor: OWNER
  }));

  assert.equal(res.statusCode, 200, `expected the promotion to succeed, got ${res.statusCode}`);
  assert.equal(store.state.users.find(row => row.id === 7).role, 'owner');
  assert.deepEqual(store.state.epochBumps, [7], 'the promotion must land on their next request');
  const roleRows = auditRows.filter(row => row.eventType === 'team.member.role_changed');
  assert.equal(roleRows.length, 1, 'a successful promotion is audited');
  assert.equal(roleRows[0].previousState.role, 'admin');
  assert.equal(roleRows[0].newState.role, 'owner');
});

test('an Owner CAN promote a support agent straight to Owner', async () => {
  const { store, router } = fixture();

  const res = await call(router, 'PATCH', '/:id', makeRequest({
    params: { id: '4' }, body: { role: 'owner' }, actor: OWNER
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(store.state.users.find(row => row.id === 4).role, 'owner');
});

test('an Owner CAN step down themselves while another Owner remains', async () => {
  const { store, router, auditRows } = fixture();

  const res = await call(router, 'PATCH', '/:id', makeRequest({
    params: { id: '9' }, body: { role: 'admin' }, actor: OWNER
  }));

  assert.equal(res.statusCode, 200, `an Owner must be able to step down, got ${res.statusCode}`);
  assert.equal(store.state.users.find(row => row.id === 9).role, 'admin');
  assert.equal(auditRows.filter(row => row.eventType === 'team.member.role_changed').length, 1);
});

test('an Owner CAN deactivate their own account while another administrator remains', async () => {
  const { store, router } = fixture();

  const res = await call(router, 'POST', '/:id/deactivate', makeRequest({
    params: { id: '9' }, actor: OWNER
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(store.state.users.find(row => row.id === 9).is_active, false);
});

test('an Owner CAN reset their own password through the admin path', async () => {
  const { store, router } = fixture();
  const before = snapshot(store, 9);

  const res = await call(router, 'POST', '/:id/reset-password', makeRequest({
    params: { id: '9' }, actor: OWNER
  }));

  assert.equal(res.statusCode, 200);
  assert.ok(res.payload.temporaryPassword);
  assert.notEqual(store.state.users.find(row => row.id === 9).password_hash, before.password_hash);
});

test('an Owner can still manage admins and agents normally', async () => {
  const { store, router } = fixture();

  const demote = await call(router, 'PATCH', '/:id', makeRequest({
    params: { id: '7' }, body: { role: 'agent' }, actor: OWNER
  }));
  assert.equal(demote.statusCode, 200);
  assert.equal(store.state.users.find(row => row.id === 7).role, 'agent');

  const deactivate = await call(router, 'POST', '/:id/deactivate', makeRequest({
    params: { id: '4' }, actor: OWNER
  }));
  assert.equal(deactivate.statusCode, 200);
  assert.equal(store.state.users.find(row => row.id === 4).is_active, false);
});

// ── The last-administrator guard still holds ───────────────────────────────

test('the sole Owner cannot demote themselves and strand the workspace', async () => {
  const { store, router, auditRows } = fixture([
    { id: 9, email: 'lubosi@example.com', display_name: 'Lubosi', role: 'owner' },
    { id: 4, email: 'sarah@example.com', display_name: 'Sarah', role: 'agent' }
  ]);
  const before = snapshot(store, 9);

  const res = await call(router, 'PATCH', '/:id', makeRequest({
    params: { id: '9' }, body: { role: 'agent' }, actor: OWNER
  }));

  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, 'CANNOT_DEACTIVATE_LAST_OWNER');
  assert.deepEqual(snapshot(store, 9), before, 'the last Owner must remain an Owner');
  assert.deepEqual(auditRows, []);
});

test('the sole Owner cannot deactivate themselves and strand the workspace', async () => {
  const { store, router, auditRows } = fixture([
    { id: 9, email: 'lubosi@example.com', display_name: 'Lubosi', role: 'owner' },
    { id: 4, email: 'sarah@example.com', display_name: 'Sarah', role: 'agent' }
  ]);
  const before = snapshot(store, 9);

  const res = await call(router, 'POST', '/:id/deactivate', makeRequest({
    params: { id: '9' }, actor: OWNER
  }));

  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, 'CANNOT_DEACTIVATE_LAST_OWNER');
  assert.deepEqual(snapshot(store, 9), before);
  assert.deepEqual(auditRows, []);
});

test('the peer-Owner guard is checked before the last-administrator guard', async () => {
  // Two Owners and nobody else. Deactivating the peer would not strand the
  // workspace, so only the peer guard can refuse it — which is the point: the
  // new rule is not merely a side effect of the old one.
  const { store, router } = fixture([
    { id: 9, email: 'lubosi@example.com', display_name: 'Lubosi', role: 'owner' },
    { id: 8, email: 'second@example.com', display_name: 'Second Owner', role: 'owner' }
  ]);

  const res = await call(router, 'POST', '/:id/deactivate', makeRequest({
    params: { id: '8' }, actor: OWNER
  }));

  assert.equal(res.payload.code, 'CANNOT_MODIFY_PEER_OWNER');
  assert.equal(store.state.users.find(row => row.id === 8).is_active, true);
});

// ── An Admin still cannot touch an Owner ───────────────────────────────────

test('an Admin cannot change an Owner\'s role, and still sees the 403 it always did', async () => {
  const { store, router, auditRows } = fixture();
  const before = snapshot(store, 9);

  const res = await call(router, 'PATCH', '/:id', makeRequest({
    params: { id: '9' }, body: { role: 'admin' }, actor: ADMIN
  }));

  assertRefusedAndUntouched({
    res, store, auditRows, before, targetId: 9,
    status: 403, code: 'OWNER_ROLE_REQUIRES_OWNER'
  });
});

test('an Admin cannot promote anybody to Owner', async () => {
  const { store, router, auditRows } = fixture();
  const before = snapshot(store, 4);

  const res = await call(router, 'PATCH', '/:id', makeRequest({
    params: { id: '4' }, body: { role: 'owner' }, actor: ADMIN
  }));

  assertRefusedAndUntouched({
    res, store, auditRows, before, targetId: 4,
    status: 403, code: 'OWNER_ROLE_REQUIRES_OWNER'
  });
});

test('an Admin cannot deactivate an Owner — the gap that let a lesser role revoke a greater one', async () => {
  // This path had NO Owner guard at all. The role hierarchy was enforced for
  // "change their role" and not for the strictly more severe "end every session
  // they have and switch the account off".
  const { store, router, auditRows } = fixture();
  const before = snapshot(store, 9);

  const res = await call(router, 'POST', '/:id/deactivate', makeRequest({
    params: { id: '9' }, actor: ADMIN
  }));

  assertRefusedAndUntouched({
    res, store, auditRows, before, targetId: 9,
    status: 403, code: 'OWNER_ROLE_REQUIRES_OWNER'
  });
  assert.equal(store.state.users.find(row => row.id === 9).is_active, true);
});

test('an Admin cannot reset an Owner\'s password', async () => {
  const { store, router, auditRows } = fixture();
  const before = snapshot(store, 9);

  const res = await call(router, 'POST', '/:id/reset-password', makeRequest({
    params: { id: '9' }, actor: ADMIN
  }));

  assertRefusedAndUntouched({
    res, store, auditRows, before, targetId: 9,
    status: 403, code: 'OWNER_ROLE_REQUIRES_OWNER'
  });
  assert.equal(res.payload.temporaryPassword, undefined);
});

test('an Admin cannot change an Owner\'s permission overrides', async () => {
  const { store, router, auditRows } = fixture();
  const before = snapshot(store, 9);

  const res = await call(router, 'PATCH', '/:id', makeRequest({
    params: { id: '9' },
    body: { grants: [{ permissionKey: 'analytics.read', effect: 'deny' }] },
    actor: ADMIN
  }));

  assertRefusedAndUntouched({
    res, store, auditRows, before, targetId: 9,
    status: 403, code: 'OWNER_ROLE_REQUIRES_OWNER'
  });
});

test('an Admin can still manage agents and other admins', async () => {
  const { store, router } = fixture();

  const res = await call(router, 'PATCH', '/:id', makeRequest({
    params: { id: '4' }, body: { role: 'admin' }, actor: ADMIN
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(store.state.users.find(row => row.id === 4).role, 'admin');
});

// ── The guard reads the pre-mutation role ──────────────────────────────────

test('the guard uses the role snapshotted on arrival, not a value a patch could move', async () => {
  // A store whose update() mutates the same object getById() returned — the
  // aliasing that caused the earlier bug of this class in this file. If any
  // guard re-read `target.role` after a write, this would let a demotion
  // launder itself past the check.
  const { store, router } = fixture();
  const target = store.state.users.find(row => row.id === 8);

  const res = await call(router, 'PATCH', '/:id', makeRequest({
    params: { id: '8' }, body: { displayName: 'Renamed', role: 'admin' }, actor: OWNER
  }));

  assert.equal(res.payload.code, 'CANNOT_MODIFY_PEER_OWNER');
  assert.equal(target.role, 'owner');
  assert.equal(target.display_name, 'Second Owner',
    'the cosmetic half of a refused patch must not be applied either');
});

// ── Non-Owner targets are unaffected ───────────────────────────────────────

test('nothing about this guard fires when the target is not an Owner', async () => {
  const { store, router } = fixture();

  for (const [id, role] of [[7, 'agent'], [4, 'admin']]) {
    const res = await call(router, 'PATCH', '/:id', makeRequest({
      params: { id: String(id) }, body: { role }, actor: OWNER
    }));
    assert.equal(res.statusCode, 200, `an Owner must still be able to set ${id} to ${role}`);
    assert.equal(store.state.users.find(row => row.id === id).role, role);
  }
});
