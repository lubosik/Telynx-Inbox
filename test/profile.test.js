'use strict';
/**
 * test/profile.test.js — self-service profile editing, administrative
 * corrections, and removing a team member.
 *
 * THREE THINGS ARE BEING PROTECTED HERE
 *
 *   1. SCOPE. `PATCH /api/users/me` is one of only a handful of endpoints with
 *      `permission: null`, which means every Support Agent can call it. It must
 *      therefore be able to change a display name and a phone number and
 *      NOTHING else. A body carrying `role`, `email` or `isActive` has to be
 *      ignored rather than obeyed, because "the handler happens not to read
 *      that key" is one careless spread away from a privilege escalation.
 *
 *   2. THE LEGACY IDENTITY. Two people share id 1. Neither of them gets to
 *      rename or re-address what the other sees, and the row is load-bearing at
 *      boot besides: syncLegacySharedRole() calls process.exit(1) when it
 *      cannot find it, so anything that could remove or rewrite it is a
 *      production crash loop rather than a bad edit.
 *
 *   3. REMOVAL. The owner asked for "deactivate, keep history", so that the
 *      Activity Center keeps reading "Sarah cancelled Payment Reminder" rather
 *      than "Unknown". Rows are never deleted. Deactivation must genuinely end
 *      access — the epoch moves, the permission cache is dropped, and the
 *      account cannot sign in — and the existing guards (peer Owner, last
 *      Owner, legacy) must all still hold on the new endpoint as well as the
 *      old one.
 *
 * Every refusal asserts on the fixture as well as the status code: a guard
 * placed one line too low returns the right code and still writes the change.
 *
 * Offline: the stores are fakes, there is no database, no network and no mail
 * provider.
 */

process.env.SUPABASE_URL ||= 'https://unit-test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'unit-test-service-key';
process.env.APP_URL ||= 'https://inbox.example.com';

const test = require('node:test');
const assert = require('node:assert/strict');

const createUsersRouter = require('../routes/users');
const { createAuthRouter } = require('../routes/auth');
const { hashPassword } = require('../lib/password');
const { PROFILE_UPDATED_EVENT, EMAIL_CHANGED_EVENT } = require('../routes/users');
const { eventDefinition } = require('../lib/audit/event-types');
const { redactMetadata } = require('../lib/audit/redact');

// ── Fixtures ───────────────────────────────────────────────────────────────

const CORRECT_PASSWORD = 'a-perfectly-fine-password';
let CORRECT_HASH;

const ROLE_CATALOGUE = Object.freeze([
  { key: 'owner', display_name: 'Owner', rank: 30, is_assignable: true },
  { key: 'admin', display_name: 'Admin', rank: 20, is_assignable: true },
  { key: 'agent', display_name: 'Support Agent', rank: 10, is_assignable: true },
  { key: 'legacy', display_name: 'Team (shared password)', rank: 5, is_assignable: false }
]);

/** The live workspace: the shared row, two Owners, an Admin, and an Agent. */
function team() {
  return [
    {
      id: 1, email: 'legacy@vici.local', display_name: 'Team', role: 'legacy',
      is_legacy_shared: true, password_hash: null
    },
    { id: 3, email: 'dominic@example.com', display_name: 'Dominic', role: 'owner', password_hash: null },
    { id: 4, email: 'lubosi@example.com', display_name: 'Lubosi', role: 'owner' },
    { id: 7, email: 'admin@example.com', display_name: 'Ade', role: 'admin' },
    { id: 5, email: 'sarah@example.com', display_name: 'Sarah', role: 'agent', phone: '+15551234567' }
  ];
}

function makeUserStore(seed = team()) {
  const state = {
    users: seed.map(row => ({
      is_active: true,
      is_legacy_shared: false,
      must_change_password: false,
      phone: null,
      deactivated_at: null,
      session_epoch: 1,
      password_hash: CORRECT_HASH,
      created_at: '2026-01-01T00:00:00.000Z',
      ...row
    })),
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
    async emailIsTaken(email, exceptUserId = null) {
      const except = exceptUserId === null ? null : Number(exceptUserId);
      return state.users.some(row =>
        row.email.toLowerCase() === String(email).toLowerCase()
        && (except === null || Number(row.id) !== except));
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
    /** Deactivation revokes push registrations; recorded so a test can assert it. */
    async revokePushDevices(id) { (state.revokedDevices ||= []).push(Number(id)); return 1; },
    async bumpEpoch(id) {
      state.epochBumps.push(Number(id));
      const row = state.users.find(entry => entry.id === Number(id));
      if (row) row.session_epoch = (row.session_epoch || 1) + 1;
      return row ? row.session_epoch : 1;
    },
    async listRoles() { return ROLE_CATALOGUE.map(role => ({ ...role })); },
    async listPermissionKeys() { return ['user.manage', 'user.manage.owner']; },
    async listGrants() { return []; },
    async upsertGrant(row) { return row; },
    async deleteGrant() { return true; }
  };
}

/** Just enough of sms_email_changes for the admin-correction path. */
function makeEmailChangeStore() {
  const state = { rows: [], cancelledFor: [] };
  const isOpen = row => !row.confirmed_at && !row.cancelled_at;
  return {
    state,
    async openForUser(userId) {
      return state.rows.find(row => row.user_id === Number(userId) && isOpen(row)) || null;
    },
    async cancelOpenForUser(userId) {
      state.cancelledFor.push(Number(userId));
      const open = state.rows.filter(row => row.user_id === Number(userId) && isOpen(row));
      for (const row of open) row.cancelled_at = new Date().toISOString();
      return open.length;
    },
    async create(row) {
      const created = { id: `change-${state.rows.length}`, confirmed_at: null, cancelled_at: null, ...row };
      state.rows.push(created);
      return created;
    },
    async confirm() { throw new Error('EMAIL_CHANGE_NOT_FOUND'); }
  };
}

function actorFrom({ id, displayName, role, permissions = [], isLegacyShared = false, viaLegacySession = false }) {
  return { id, displayName, role, permissions: new Set(permissions), isLegacyShared, viaLegacySession };
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

function makeRequest({ params = {}, body = {}, actor = null } = {}) {
  return {
    params,
    body,
    actor,
    ip: '203.0.113.9',
    get: name => (name === 'user-agent' ? 'ViciInbox/1.4 (iPhone)' : null)
  };
}

function fixture(seed) {
  const sent = [];
  const auditRows = [];
  const invalidated = [];
  const warnings = [];
  const users = makeUserStore(seed);
  const emailChanges = makeEmailChangeStore();
  const router = createUsersRouter({
    store: users,
    emailChangeStore: emailChanges,
    authz: { invalidate(id) { invalidated.push(Number(id)); } },
    audit: async input => { auditRows.push(input); },
    sendMail: async message => { sent.push(message); return { sent: true }; }
  });
  return { users, emailChanges, router, sent, auditRows, invalidated, warnings };
}

async function call(router, method, routePath, request) {
  const res = responseRecorder();
  await handlerFor(router, method, routePath)(request, res);
  return res;
}

/** A deep copy of one user row, for before/after comparison. */
function snapshot(store, id) {
  return JSON.parse(JSON.stringify(store.state.users.find(row => row.id === id)));
}

const LUBOSI = actorFrom({ id: 4, displayName: 'Lubosi', role: 'owner', permissions: ['user.manage', 'user.manage.owner'] });
const ADMIN = actorFrom({ id: 7, displayName: 'Ade', role: 'admin', permissions: ['user.manage'] });
const SARAH = actorFrom({ id: 5, displayName: 'Sarah', role: 'agent' });
const LEGACY = actorFrom({
  id: 1, displayName: 'Team', role: 'legacy', permissions: ['user.manage'],
  isLegacyShared: true, viaLegacySession: true
});

test.before(async () => {
  CORRECT_HASH = await hashPassword(CORRECT_PASSWORD);
});

// ── PATCH /api/users/me ────────────────────────────────────────────────────

test('a Support Agent can correct their own name and phone without asking anybody', async () => {
  const context = fixture();
  const res = await call(context.router, 'PATCH', '/me', makeRequest({
    actor: SARAH, body: { displayName: 'Sarah Okonkwo', phone: '+15559990000' }
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.user.displayName, 'Sarah Okonkwo');
  assert.equal(res.payload.user.phone, '+15559990000');

  const sarah = snapshot(context.users, 5);
  assert.equal(sarah.display_name, 'Sarah Okonkwo');
  assert.equal(sarah.phone, '+15559990000');
  // Nothing authority-bearing moved.
  assert.equal(sarah.role, 'agent');
  assert.equal(sarah.is_active, true);
});

test('editing your own profile does not sign you out', async () => {
  // A rename that ended somebody's shift would be a worse bug than the typo
  // they were fixing. Nothing here changes what they can do, so nothing
  // revokes a session.
  const context = fixture();
  await call(context.router, 'PATCH', '/me', makeRequest({ actor: SARAH, body: { displayName: 'Sarah O' } }));

  assert.deepEqual(context.users.state.epochBumps, []);
  assert.deepEqual(context.invalidated, []);
  assert.equal(snapshot(context.users, 5).session_epoch, 1);
});

test('PATCH /me can change the name and the phone and nothing else', async () => {
  const context = fixture();
  const before = snapshot(context.users, 5);

  const res = await call(context.router, 'PATCH', '/me', makeRequest({
    actor: SARAH,
    body: {
      displayName: 'Sarah O',
      // Every one of these must be ignored. This endpoint is open to every
      // authenticated actor, so obeying any of them is a privilege escalation
      // reachable by the least privileged role in the product.
      role: 'owner',
      email: 'sarah@attacker.example',
      isActive: false,
      is_active: false,
      password_hash: 'nope',
      must_change_password: true,
      is_legacy_shared: true,
      id: 4,
      grants: [{ permissionKey: 'user.manage', effect: 'allow' }]
    }
  }));

  assert.equal(res.statusCode, 200);
  const after = snapshot(context.users, 5);
  assert.equal(after.role, before.role);
  assert.equal(after.email, before.email);
  assert.equal(after.is_active, true);
  assert.equal(after.password_hash, before.password_hash);
  assert.equal(after.must_change_password, false);
  assert.equal(after.is_legacy_shared, false);
  assert.equal(after.display_name, 'Sarah O');

  // And the only write issued carried exactly the two permitted keys.
  assert.equal(context.users.state.updates.length, 1);
  assert.deepEqual(Object.keys(context.users.state.updates[0].patch), ['display_name']);
  assert.equal(context.users.state.updates[0].id, 5, 'the id comes from the session, never from the body');
});

test('PATCH /me can only ever touch the caller, whatever the body says', async () => {
  const context = fixture();
  const lubosiBefore = snapshot(context.users, 4);

  await call(context.router, 'PATCH', '/me', makeRequest({
    actor: SARAH, params: { id: 4 }, body: { id: 4, userId: 4, displayName: 'Not Lubosi' }
  }));

  assert.deepEqual(snapshot(context.users, 4), lubosiBefore);
  assert.equal(snapshot(context.users, 5).display_name, 'Not Lubosi');
});

test('a nonsense display name is refused and writes nothing', async () => {
  const context = fixture();
  for (const displayName of ['', '   ', 'x'.repeat(121)]) {
    const res = await call(context.router, 'PATCH', '/me',
      makeRequest({ actor: SARAH, body: { displayName } }));
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.code, 'INVALID_DISPLAY_NAME');
  }
  assert.deepEqual(context.users.state.updates, []);
});

test('an empty PATCH /me is refused rather than silently doing nothing', async () => {
  const context = fixture();
  const res = await call(context.router, 'PATCH', '/me', makeRequest({ actor: SARAH, body: {} }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.code, 'NOTHING_TO_UPDATE');
  // The message has to point at the right endpoint for an address, or the
  // caller assumes `email` was accepted and ignored.
  assert.match(res.payload.error, /\/api\/users\/me\/email/);
  assert.deepEqual(context.users.state.updates, []);
});

test('clearing the phone is a supported edit, not a validation failure', async () => {
  const context = fixture();
  const res = await call(context.router, 'PATCH', '/me',
    makeRequest({ actor: SARAH, body: { phone: null } }));
  assert.equal(res.statusCode, 200);
  assert.equal(snapshot(context.users, 5).phone, null);
});

test('the shared team login cannot rename itself', async () => {
  const context = fixture();
  const before = snapshot(context.users, 1);

  const res = await call(context.router, 'PATCH', '/me',
    makeRequest({ actor: LEGACY, body: { displayName: 'Mine Now' } }));

  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, 'LEGACY_USER_IMMUTABLE');
  assert.deepEqual(snapshot(context.users, 1), before);
  assert.deepEqual(context.users.state.updates, []);
});

test('an unauthenticated request to PATCH /me is refused before anything is read', async () => {
  const context = fixture();
  const res = await call(context.router, 'PATCH', '/me',
    makeRequest({ actor: null, body: { displayName: 'Nobody' } }));
  assert.equal(res.statusCode, 401);
  assert.deepEqual(context.users.state.updates, []);
});

// ── The audit catalogue gap ────────────────────────────────────────────────

test('a profile edit is audited, with the metadata surviving redaction', async () => {
  // This replaces a test that asserted these types were ABSENT and was written
  // to fail the moment they were registered. They now are, so the assertion is
  // inverted: the edit must actually write a row.
  assert.notEqual(eventDefinition(PROFILE_UPDATED_EVENT), null,
    `${PROFILE_UPDATED_EVENT} must stay registered or profile edits go unrecorded`);
  assert.notEqual(eventDefinition(EMAIL_CHANGED_EVENT), null,
    `${EMAIL_CHANGED_EVENT} must stay registered or an email change is invisible`);

  const context = fixture();
  const res = await call(context.router, 'PATCH', '/me',
    makeRequest({ actor: SARAH, body: { displayName: 'Sarah O' } }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.audited, true, 'the response reports that a row was written');
  assert.equal(context.auditRows.length, 1);
  assert.equal(context.auditRows[0].eventType, PROFILE_UPDATED_EVENT);
  assert.ok(context.auditRows[0].changedFields.includes('display_name'));

  // Registering a type is only half of it. METADATA_ALLOWLIST is keyed by event
  // type, so without a matching entry every metadata field is silently dropped
  // and the row lands with an empty object.
  const { metadata } = redactMetadata(PROFILE_UPDATED_EVENT, {
    user_id: 4, email: 'sarah@example.com', changed_fields: ['display_name'], via: 'self'
  });
  assert.equal(metadata.user_id, 4, 'metadata must survive the redactor, not be dropped');
  assert.deepEqual(metadata.changed_fields, ['display_name']);
});

// ── An Admin editing somebody else ─────────────────────────────────────────

test('an Admin can correct somebody else\'s display name and address', async () => {
  const context = fixture();
  const res = await call(context.router, 'PATCH', '/:id', makeRequest({
    actor: ADMIN, params: { id: '5' },
    body: { displayName: 'Sarah Okonkwo', email: 'sarah.okonkwo@example.com' }
  }));

  assert.equal(res.statusCode, 200);
  const sarah = snapshot(context.users, 5);
  assert.equal(sarah.display_name, 'Sarah Okonkwo');
  assert.equal(sarah.email, 'sarah.okonkwo@example.com');
});

test('an administrative address change skips confirmation but ends their sessions', async () => {
  const context = fixture();
  const res = await call(context.router, 'PATCH', '/:id', makeRequest({
    actor: ADMIN, params: { id: '5' }, body: { email: 'sarah.new@example.com' }
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.sessionsRevoked, true);
  // Applied immediately: an admin correcting a typo cannot be made to confirm
  // from a mailbox that does not work, which is the case it exists for.
  assert.equal(snapshot(context.users, 5).email, 'sarah.new@example.com');
  assert.deepEqual(context.emailChanges.state.rows, [], 'no pending row, no token, no link');
  // But the address is still identity, so every other device re-establishes.
  assert.ok(context.users.state.epochBumps.includes(5));
  assert.ok(context.invalidated.includes(5));
});

test('an administrative address change tells the old address as well as the new one', async () => {
  const context = fixture();
  const res = await call(context.router, 'PATCH', '/:id', makeRequest({
    actor: ADMIN, params: { id: '5' }, body: { email: 'sarah.new@example.com' }
  }));

  const recipients = context.sent.map(message => message.to).sort();
  assert.deepEqual(recipients, ['sarah.new@example.com', 'sarah@example.com'],
    'the address being taken away is the one that matters — it is the only warning the person gets');

  const toOld = context.sent.find(message => message.to === 'sarah@example.com');
  assert.match(toOld.text, /sarah\.new@example\.com/, 'it has to say where the account went');
  assert.match(toOld.text, /Ade/, 'and who moved it');

  // Reported honestly, per recipient, so an admin who could not reach them
  // knows to pick up the phone.
  assert.deepEqual(res.payload.emailNotifications, {
    previousAddress: { sent: true },
    newAddress: { sent: true }
  });
});

test('an administrative address change voids a self-service request already in flight', async () => {
  // Otherwise their pending link fires later and quietly undoes a correction
  // nobody would think to re-check.
  const context = fixture();
  await context.emailChanges.create({
    user_id: 5,
    new_email: 'sarah.chosen@example.com',
    token_hash: 'f'.repeat(64),
    token_prefix: 'ffffffff',
    expires_at: new Date(Date.now() + 3600_000).toISOString()
  });

  await call(context.router, 'PATCH', '/:id', makeRequest({
    actor: ADMIN, params: { id: '5' }, body: { email: 'sarah.corrected@example.com' }
  }));

  assert.ok(context.emailChanges.state.cancelledFor.includes(5));
  assert.equal(context.emailChanges.state.rows[0].cancelled_at !== null, true);
});

test('an Admin cannot move somebody onto an address that is taken', async () => {
  const context = fixture();
  const before = snapshot(context.users, 5);

  const res = await call(context.router, 'PATCH', '/:id', makeRequest({
    actor: ADMIN, params: { id: '5' }, body: { email: 'admin@example.com' }
  }));

  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, 'EMAIL_ALREADY_EXISTS');
  assert.deepEqual(snapshot(context.users, 5), before);
  assert.deepEqual(context.users.state.updates, []);
  assert.deepEqual(context.sent, []);
});

test('an invalid address is refused before anything is written', async () => {
  const context = fixture();
  const res = await call(context.router, 'PATCH', '/:id', makeRequest({
    actor: ADMIN, params: { id: '5' }, body: { displayName: 'Fine', email: 'not-an-email' }
  }));

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.code, 'INVALID_EMAIL');
  // The display name in the same body must not have been applied either.
  assert.equal(snapshot(context.users, 5).display_name, 'Sarah');
  assert.deepEqual(context.users.state.updates, []);
});

test('re-submitting the address somebody already has is a no-op, not a collision', async () => {
  const context = fixture();
  const res = await call(context.router, 'PATCH', '/:id', makeRequest({
    actor: ADMIN, params: { id: '5' }, body: { email: 'SARAH@example.com', displayName: 'Sarah O' }
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.sessionsRevoked, false, 'nothing moved, so nothing may be revoked');
  assert.equal(snapshot(context.users, 5).email, 'sarah@example.com');
  assert.deepEqual(context.sent, [], 'and nobody is emailed about a change that did not happen');
});

test('an Owner cannot re-address a peer Owner', async () => {
  const context = fixture();
  const before = snapshot(context.users, 3);

  const res = await call(context.router, 'PATCH', '/:id', makeRequest({
    actor: LUBOSI, params: { id: '3' }, body: { email: 'dominic@attacker.example' }
  }));

  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, 'CANNOT_MODIFY_PEER_OWNER');
  assert.deepEqual(snapshot(context.users, 3), before);
  assert.deepEqual(context.users.state.updates, []);
  assert.deepEqual(context.sent, []);
  assert.deepEqual(context.users.state.epochBumps, []);
});

test('the shared team login cannot be re-addressed by an Admin either', async () => {
  const context = fixture();
  const before = snapshot(context.users, 1);

  const res = await call(context.router, 'PATCH', '/:id', makeRequest({
    actor: ADMIN, params: { id: '1' }, body: { email: 'mine@attacker.example', displayName: 'Mine' }
  }));

  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, 'LEGACY_USER_IMMUTABLE');
  assert.deepEqual(snapshot(context.users, 1), before);
});

// ── Deactivate ─────────────────────────────────────────────────────────────

test('deactivating a person ends their sessions and drops their cached permissions', async () => {
  const context = fixture();
  const res = await call(context.router, 'POST', '/:id/deactivate',
    makeRequest({ actor: ADMIN, params: { id: '5' } }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.sessionsRevoked, true);

  const sarah = snapshot(context.users, 5);
  assert.equal(sarah.is_active, false);
  assert.ok(sarah.deactivated_at, 'sms_users CHECKs that is_active = (deactivated_at IS NULL)');
  assert.equal(sarah.session_epoch, 2, 'every live session must stop matching');
  assert.ok(context.invalidated.includes(5));

  // The row is still there. "Deactivate, keep history" is the whole reason
  // this is not a DELETE: the Activity Center must keep reading "Sarah
  // cancelled Payment Reminder" rather than "Unknown".
  assert.ok(context.users.state.users.some(row => row.id === 5));
  assert.equal(sarah.display_name, 'Sarah');
});

test('an Owner cannot deactivate a peer Owner', async () => {
  const context = fixture();
  const before = snapshot(context.users, 3);

  const res = await call(context.router, 'POST', '/:id/deactivate',
    makeRequest({ actor: LUBOSI, params: { id: '3' } }));

  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, 'CANNOT_MODIFY_PEER_OWNER');
  assert.deepEqual(snapshot(context.users, 3), before);
  assert.deepEqual(context.users.state.updates, []);
  assert.deepEqual(context.users.state.epochBumps, []);
  assert.deepEqual(context.auditRows, []);
});

test('the last active Owner or Admin cannot be removed', async () => {
  const context = fixture([
    { id: 4, email: 'lubosi@example.com', display_name: 'Lubosi', role: 'owner' },
    { id: 5, email: 'sarah@example.com', display_name: 'Sarah', role: 'agent' }
  ]);
  const before = snapshot(context.users, 4);

  const res = await call(context.router, 'POST', '/:id/deactivate',
    makeRequest({ actor: LUBOSI, params: { id: '4' } }));

  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, 'CANNOT_DEACTIVATE_LAST_OWNER');
  assert.deepEqual(snapshot(context.users, 4), before);
  assert.deepEqual(context.users.state.updates, []);
});

test('the shared team login cannot be deactivated through the API', async () => {
  // syncLegacySharedRole() calls process.exit(1) when this row is missing or
  // unreadable, so anything that could switch it off is a crash loop on the
  // next deploy rather than a bad edit.
  const context = fixture();
  const before = snapshot(context.users, 1);

  const res = await call(context.router, 'POST', '/:id/deactivate',
    makeRequest({ actor: ADMIN, params: { id: '1' } }));

  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, 'LEGACY_USER_IMMUTABLE');
  assert.deepEqual(snapshot(context.users, 1), before);
  assert.match(res.payload.error, /LEGACY_SHARED_LOGIN/, 'the message must name the actual remedy');
});

// ── Reactivate ─────────────────────────────────────────────────────────────

test('a removed person can be brought back with their history intact', async () => {
  const context = fixture();
  await call(context.router, 'POST', '/:id/deactivate', makeRequest({ actor: ADMIN, params: { id: '5' } }));

  const res = await call(context.router, 'POST', '/:id/reactivate',
    makeRequest({ actor: ADMIN, params: { id: '5' } }));

  assert.equal(res.statusCode, 200);
  const sarah = snapshot(context.users, 5);
  assert.equal(sarah.is_active, true);
  assert.equal(sarah.deactivated_at, null, 'sms_users CHECKs that is_active = (deactivated_at IS NULL)');
  assert.equal(sarah.id, 5, 'the same row, so every audit and activity reference still resolves');
  assert.equal(sarah.display_name, 'Sarah');
});

test('reactivation writes a registered audit row, unlike the two missing types', async () => {
  const context = fixture();
  await call(context.router, 'POST', '/:id/deactivate', makeRequest({ actor: ADMIN, params: { id: '5' } }));
  context.auditRows.length = 0;

  await call(context.router, 'POST', '/:id/reactivate', makeRequest({ actor: ADMIN, params: { id: '5' } }));

  assert.equal(context.auditRows.length, 1);
  const row = context.auditRows[0];
  assert.equal(row.eventType, 'team.member.reactivated');
  assert.equal(row.entityId, 5);
  // Spelled with the catalogue display name, not the raw key: the summary is
  // rendered once and has to still read correctly years later.
  assert.match(row.summary, /Ade reactivated Sarah as Support Agent/);
  assert.equal(row.metadata.logins_revoked, true);
  // Nothing password-shaped or token-shaped may reach a row.
  const serialised = JSON.stringify(row);
  assert.equal(/password|token/i.test(serialised), false);
});

test('reactivating somebody who is already active is a no-op, not a second epoch bump', async () => {
  const context = fixture();
  const res = await call(context.router, 'POST', '/:id/reactivate',
    makeRequest({ actor: ADMIN, params: { id: '5' } }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.alreadyActive, true);
  assert.deepEqual(context.users.state.updates, []);
  assert.deepEqual(context.users.state.epochBumps, []);
  assert.deepEqual(context.auditRows, []);
});

test('an Owner cannot reactivate a peer Owner, and an Admin cannot reactivate any Owner', async () => {
  const context = fixture([
    { id: 4, email: 'lubosi@example.com', display_name: 'Lubosi', role: 'owner' },
    { id: 3, email: 'dominic@example.com', display_name: 'Dominic', role: 'owner', is_active: false, deactivated_at: '2026-08-01T00:00:00.000Z' },
    { id: 7, email: 'admin@example.com', display_name: 'Ade', role: 'admin' }
  ]);

  const byAdmin = await call(context.router, 'POST', '/:id/reactivate',
    makeRequest({ actor: ADMIN, params: { id: '3' } }));
  assert.equal(byAdmin.statusCode, 403);
  assert.equal(byAdmin.payload.code, 'OWNER_ROLE_REQUIRES_OWNER');

  const byOwner = await call(context.router, 'POST', '/:id/reactivate',
    makeRequest({ actor: LUBOSI, params: { id: '3' } }));
  assert.equal(byOwner.statusCode, 409);
  assert.equal(byOwner.payload.code, 'CANNOT_MODIFY_PEER_OWNER');

  assert.equal(snapshot(context.users, 3).is_active, false);
  assert.deepEqual(context.users.state.updates, []);
});

test('the shared team login cannot be reactivated through the API', async () => {
  const context = fixture();
  const res = await call(context.router, 'POST', '/:id/reactivate',
    makeRequest({ actor: ADMIN, params: { id: '1' } }));
  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, 'LEGACY_USER_IMMUTABLE');
  assert.deepEqual(context.users.state.updates, []);
});

test('a bad user id is refused on both endpoints before any lookup', async () => {
  const context = fixture();
  for (const route of ['/:id/deactivate', '/:id/reactivate']) {
    for (const id of ['me', '0', '-1', 'abc', '1e3']) {
      const res = await call(context.router, 'POST', route, makeRequest({ actor: ADMIN, params: { id } }));
      assert.equal(res.statusCode, 400, `${route} with id "${id}"`);
      assert.equal(res.payload.code, 'INVALID_USER_ID');
    }
  }
  assert.deepEqual(context.users.state.updates, []);
});

// ── A deactivated account cannot sign in ───────────────────────────────────

/**
 * A minimal auth fixture. `createAuthz` is not used: these tests are about the
 * handler's decisions, and a fake authz makes the account state an input rather
 * than something to set up through a fake Postgres.
 */
function authFixture(users) {
  const events = [];
  const state = { users };
  const authz = {
    invalidate() {},
    async logAuthEvent(event) { events.push(event); },
    async loadLegacyUser() { return state.users.find(row => row.is_legacy_shared) || null; },
    async loadUserById(id) { return state.users.find(row => row.id === Number(id)) || null; },
    async loadUserByEmail(email) {
      return state.users.find(row => row.email.toLowerCase() === String(email).toLowerCase()) || null;
    },
    async permissionsFor() { return new Set(['conversation.read']); }
  };
  // Only ever used for the failed/succeeded-login counter writes.
  const client = { from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }) };
  const router = createAuthRouter({
    authz,
    client,
    invitationStore: { async redeem() { throw new Error('unused'); }, async noteAttempt() {} },
    emailChangeStore: makeEmailChangeStore(),
    audit: async () => {},
    limiter: (req, res, next) => next()
  });
  return { router, events, state };
}

test('a deactivated person cannot sign in, even with the right password', async () => {
  const sarah = {
    id: 5, email: 'sarah@example.com', display_name: 'Sarah', role: 'agent',
    password_hash: CORRECT_HASH, is_active: false, deactivated_at: '2026-08-01T00:00:00.000Z',
    session_epoch: 2, must_change_password: false, failed_login_count: 0, locked_until: null
  };
  const { router, events } = authFixture([sarah]);

  const req = makeRequest({ body: { email: 'sarah@example.com', password: CORRECT_PASSWORD } });
  const res = await call(router, 'POST', '/login', req);

  assert.equal(res.statusCode, 401);
  assert.equal(res.payload.code, 'ACCOUNT_DISABLED');
  assert.equal(req.session, undefined, 'no session may be issued to a removed account');
  assert.ok(events.some(event => event.code === 'ACCOUNT_DISABLED' && event.outcome === 'failure'));
});

test('a session held by a deactivated person stops being valid on their next request', async () => {
  // Two independent reasons, and both are asserted, because either one alone
  // would be a single point of failure for somebody who has been removed.
  const sarah = {
    id: 5, email: 'sarah@example.com', display_name: 'Sarah', role: 'agent',
    is_active: false, deactivated_at: '2026-08-01T00:00:00.000Z', session_epoch: 2
  };
  const { router } = authFixture([sarah]);
  const check = handlerFor(router, 'GET', '/check');

  // 1. The cookie still carries the pre-deactivation epoch.
  const stale = responseRecorder();
  await check({ ...makeRequest({}), session: { authenticated: true, uid: 5, se: 1 } }, stale);
  assert.equal(stale.payload.authenticated, false);

  // 2. Even a cookie somehow carrying the CURRENT epoch is refused, because
  //    is_active is checked first.
  const current = responseRecorder();
  await check({ ...makeRequest({}), session: { authenticated: true, uid: 5, se: 2 } }, current);
  assert.equal(current.payload.authenticated, false);
});

test('an active person with a current session still checks out, so the guard is not vacuous', async () => {
  const sarah = {
    id: 5, email: 'sarah@example.com', display_name: 'Sarah', role: 'agent',
    is_active: true, deactivated_at: null, session_epoch: 2
  };
  const { router } = authFixture([sarah]);
  const res = responseRecorder();
  await handlerFor(router, 'GET', '/check')(
    { ...makeRequest({}), session: { authenticated: true, uid: 5, se: 2 } }, res);

  assert.equal(res.payload.authenticated, true);
  assert.equal(res.payload.actor.id, 5);
});
