'use strict';
/**
 * test/email-change.test.js — confirmed self-service email changes.
 *
 * WHY THIS FILE EXISTS
 *   An unconfirmed email change is account takeover. An address is half a
 *   credential and the whole of an account-recovery path, so if
 *   POST /api/users/me/email changed anything by itself, a borrowed session or
 *   an unlocked phone would become permanent ownership of the account — and the
 *   person who lost it would find out when they could no longer sign in.
 *
 *   Everything below is an assertion about that: the address does not move
 *   until somebody proves they can read mail at the new one, the proof is a
 *   token that exists nowhere in the database, and every way of presenting a
 *   token that should not work is refused with a code that says which way it
 *   was.
 *
 * WHAT IS ASSERTED, AND WHY IT IS NOT JUST THE STATUS CODE
 *   A refusal proves the response was refused. It does not prove the handler
 *   refused BEFORE it wrote anything. So every refusal here also asserts on the
 *   fixture: the user row is unchanged, no pending row was written, no session
 *   epoch was bumped, and no mail carrying a live link went out. The status code
 *   is checked as well, never instead.
 *
 * THE FAKE STORE IS NOT A SHORTCUT
 *   `makeEmailChangeStore` mirrors confirm_sms_email_change in
 *   scripts/email-change-migration.sql clause for clause, including the row
 *   lock: `serialise` queues confirmations so two concurrent calls interleave
 *   the way SELECT ... FOR UPDATE makes them. A fake that let both through
 *   would pass a test the database would fail, which is worse than no test.
 *
 * Offline: the stores are fakes, there is no database, no network and no mail
 * provider. `send` is a collector.
 */

process.env.SUPABASE_URL ||= 'https://unit-test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'unit-test-service-key';
// Read at call time by lib/email.js:appUrl(), so it must be set before a
// handler runs rather than before the module is required.
process.env.APP_URL = 'https://inbox.example.com';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const createUsersRouter = require('../routes/users');
const { createAuthRouter } = require('../routes/auth');
const { hashToken } = require('../routes/invitations');
const { hashPassword } = require('../lib/password');
const { confirmationErrorFrom, EMAIL_CHANGE_TTL_HOURS } = require('../routes/users');

// ── Fixtures ───────────────────────────────────────────────────────────────

const CORRECT_PASSWORD = 'a-perfectly-fine-password';
/** Hashed once. scrypt at production parameters is deliberately slow. */
let CORRECT_HASH;

const ROLE_CATALOGUE = Object.freeze([
  { key: 'owner', display_name: 'Owner', rank: 30, is_assignable: true },
  { key: 'admin', display_name: 'Admin', rank: 20, is_assignable: true },
  { key: 'agent', display_name: 'Support Agent', rank: 10, is_assignable: true },
  { key: 'legacy', display_name: 'Team (shared password)', rank: 5, is_assignable: false }
]);

/**
 * The live workspace, as described in the handover: the shared `Team` row, two
 * Owners, and an Agent to stand in for somebody with no management permission
 * at all. `taken@example.com` exists so the collision path has something real
 * to collide with.
 */
function team() {
  return [
    {
      id: 1, email: 'legacy@vici.local', display_name: 'Team', role: 'legacy',
      is_legacy_shared: true, password_hash: null
    },
    { id: 3, email: 'dominic@example.com', display_name: 'Dominic', role: 'owner', password_hash: null },
    { id: 4, email: 'lubosi@example.com', display_name: 'Lubosi', role: 'owner' },
    { id: 5, email: 'sarah@example.com', display_name: 'Sarah', role: 'agent' },
    { id: 6, email: 'taken@example.com', display_name: 'Already Here', role: 'agent' }
  ];
}

function makeUserStore(seed = team()) {
  const state = {
    users: seed.map(row => ({
      is_active: true,
      is_legacy_shared: false,
      must_change_password: false,
      phone: null,
      session_epoch: 1,
      password_hash: CORRECT_HASH,
      created_at: '2026-01-01T00:00:00.000Z',
      ...row
    })),
    epochBumps: [],
    updates: [],
    invalidated: []
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

/**
 * A stand-in for sms_email_changes plus confirm_sms_email_change.
 *
 * Two behaviours are copied deliberately rather than simplified:
 *
 *   * `create` refuses a second OPEN row for one user, which is the partial
 *     unique index sms_email_changes_one_open_per_user_idx. The handler is
 *     supposed to supersede first; if it ever stops doing so, this throws
 *     rather than quietly allowing two live confirmation links.
 *   * `confirm` runs inside `serialise` with a forced yield, which is the row
 *     lock. Without it a concurrency test proves nothing, because two awaits on
 *     synchronous array code cannot interleave.
 */
function makeEmailChangeStore(userStore) {
  const state = { rows: [] };
  let queue = Promise.resolve();
  const serialise = task => {
    const next = queue.then(task, task);
    queue = next.then(() => {}, () => {});
    return next;
  };

  const isOpen = row => !row.confirmed_at && !row.cancelled_at;

  return {
    state,
    async openForUser(userId) {
      return state.rows.find(row => row.user_id === Number(userId) && isOpen(row)) || null;
    },
    async cancelOpenForUser(userId) {
      const open = state.rows.filter(row => row.user_id === Number(userId) && isOpen(row));
      for (const row of open) row.cancelled_at = new Date().toISOString();
      return open.length;
    },
    async create(row) {
      if (state.rows.some(entry => entry.user_id === Number(row.user_id) && isOpen(entry))) {
        throw Object.assign(
          new Error('duplicate key value violates unique constraint "sms_email_changes_one_open_per_user_idx"'),
          { code: 'EMAIL_CHANGE_STORE_FAILED' }
        );
      }
      const created = {
        id: crypto.randomUUID(),
        confirmed_at: null,
        cancelled_at: null,
        requested_at: new Date().toISOString(),
        ...row
      };
      state.rows.push(created);
      return created;
    },
    async confirm(tokenHash) {
      return serialise(async () => {
        // Forces the two concurrent callers to actually interleave.
        await new Promise(resolve => setImmediate(resolve));

        const row = state.rows.find(entry => entry.token_hash === tokenHash);
        if (!row) throw new Error('EMAIL_CHANGE_NOT_FOUND');
        if (row.confirmed_at) throw new Error('EMAIL_CHANGE_USED');
        if (row.cancelled_at) throw new Error('EMAIL_CHANGE_CANCELLED');
        if (new Date(row.expires_at).getTime() <= Date.now()) throw new Error('EMAIL_CHANGE_EXPIRED');

        const user = userStore.state.users.find(entry => entry.id === Number(row.user_id));
        if (!user) throw new Error('EMAIL_CHANGE_USER_NOT_FOUND');
        if (user.is_legacy_shared) throw new Error('LEGACY_USER_IMMUTABLE');
        if (!user.is_active) throw new Error('EMAIL_CHANGE_USER_INACTIVE');
        const clash = userStore.state.users.some(entry =>
          entry.id !== user.id && entry.email.toLowerCase() === String(row.new_email).toLowerCase());
        if (clash) throw new Error('EMAIL_ALREADY_EXISTS');

        const previousEmail = user.email;
        user.email = row.new_email;
        user.session_epoch = (user.session_epoch || 1) + 1;
        row.confirmed_at = new Date().toISOString();
        return {
          change_id: row.id,
          user_id: user.id,
          previous_email: previousEmail,
          new_email: row.new_email,
          session_epoch: user.session_epoch,
          confirmed_at: row.confirmed_at
        };
      });
    }
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

/**
 * Users router + auth router over one shared pair of stores, so a request made
 * through the API can be confirmed through the public endpoint and both see the
 * same rows — which is the flow this feature actually is.
 */
function fixture(seed) {
  const sent = [];
  const auditRows = [];
  const invalidated = [];
  const users = makeUserStore(seed);
  const emailChanges = makeEmailChangeStore(users);
  const authz = { invalidate(id) { invalidated.push(Number(id)); } };
  const send = async message => {
    sent.push(message);
    return { sent: true, id: `stub-${sent.length}` };
  };

  const router = createUsersRouter({
    store: users,
    emailChangeStore: emailChanges,
    authz,
    audit: async input => { auditRows.push(input); },
    sendMail: send
  });

  const authRouter = createAuthRouter({
    authz: {
      invalidate(id) { invalidated.push(Number(id)); },
      logAuthEvent: async () => {},
      loadLegacyUser: async () => null,
      loadUserById: async () => null,
      permissionsFor: async () => new Set()
    },
    emailChangeStore: emailChanges,
    invitationStore: { async redeem() { throw new Error('unused'); }, async noteAttempt() {} },
    audit: async input => { auditRows.push(input); },
    limiter: (req, res, next) => next()
  });

  return { users, emailChanges, router, authRouter, sent, auditRows, invalidated };
}

async function call(router, method, routePath, request) {
  const res = responseRecorder();
  await handlerFor(router, method, routePath)(request, res);
  return res;
}

const LUBOSI = actorFrom({ id: 4, displayName: 'Lubosi', role: 'owner', permissions: ['user.manage', 'user.manage.owner'] });
const SARAH = actorFrom({ id: 5, displayName: 'Sarah', role: 'agent' });
const LEGACY = actorFrom({
  id: 1, displayName: 'Team', role: 'legacy', permissions: ['user.manage'],
  isLegacyShared: true, viaLegacySession: true
});

/** Request an email change and return the response plus the token from the mail. */
async function requestChange(context, { actor = SARAH, newEmail, currentPassword = CORRECT_PASSWORD } = {}) {
  const res = await call(context.router, 'POST', '/me/email',
    makeRequest({ actor, body: { newEmail, currentPassword } }));
  return { res, token: tokenFromLastConfirmation(context) };
}

/**
 * Pull the raw token out of the confirmation email, the way a recipient does.
 *
 * Deliberately parsed out of the message body rather than returned by the
 * handler: the handler MUST NOT return it, and reading it from the mail is the
 * only path a real user has.
 */
function tokenFromLastConfirmation(context) {
  for (let index = context.sent.length - 1; index >= 0; index -= 1) {
    const found = /confirm-email-change\?token=([A-Za-z0-9_-]+)/.exec(context.sent[index].text || '');
    if (found) return decodeURIComponent(found[1]);
  }
  return null;
}

test.before(async () => {
  CORRECT_HASH = await hashPassword(CORRECT_PASSWORD);
});

// ── The token ──────────────────────────────────────────────────────────────

test('the confirmation token is stored only as a hash and the raw value is nowhere in the row', async () => {
  const context = fixture();
  const { res, token } = await requestChange(context, { newEmail: 'sarah.new@example.com' });

  assert.equal(res.statusCode, 200);
  assert.ok(token, 'the confirmation email must carry a link');
  assert.ok(token.length >= 40, 'a 256-bit token should be at least 40 base64url characters');

  assert.equal(context.emailChanges.state.rows.length, 1);
  const stored = context.emailChanges.state.rows[0];
  const serialised = JSON.stringify(stored);

  assert.equal(serialised.includes(token), false, 'the raw token must never be stored');
  assert.equal(stored.token_hash, hashToken(token));
  assert.match(stored.token_hash, /^[0-9a-f]{64}$/);
  // The prefix is a prefix OF THE HASH, so not even a fragment of the live
  // secret is written down. Copied from the invitation pattern on purpose.
  assert.equal(stored.token_prefix, hashToken(token).slice(0, 8));
  assert.equal(token.includes(stored.token_prefix), false);
});

test('the response body never carries the token, the hash, or the prefix', async () => {
  const context = fixture();
  const { res, token } = await requestChange(context, { newEmail: 'sarah.new@example.com' });
  const body = JSON.stringify(res.payload);

  assert.equal(body.includes(token), false);
  assert.equal(body.includes(hashToken(token)), false);
  assert.equal(body.includes(context.emailChanges.state.rows[0].token_prefix), false);
});

test('the heads-up to the old address carries no link and no token', async () => {
  const context = fixture();
  const { token } = await requestChange(context, { newEmail: 'sarah.new@example.com' });

  const notice = context.sent.find(message => message.to === 'sarah@example.com');
  assert.ok(notice, 'the current address must be told');
  assert.equal(`${notice.text}${notice.html}`.includes(token), false,
    'the notice goes to a mailbox that may already be compromised; it must not carry the credential');
  assert.equal(notice.text.includes('confirm-email-change'), false);
  // It must still name the destination, or the victim cannot tell what is
  // being taken from them.
  assert.match(notice.text, /sarah\.new@example\.com/);
  assert.match(notice.text, /cancel/i);
});

// ── Nothing changes until confirmation ─────────────────────────────────────

test('requesting a change alters nothing on the account', async () => {
  const context = fixture();
  const before = JSON.parse(JSON.stringify(context.users.state.users.find(row => row.id === 5)));

  const { res } = await requestChange(context, { newEmail: 'sarah.new@example.com' });
  assert.equal(res.statusCode, 200);

  assert.deepEqual(
    context.users.state.users.find(row => row.id === 5), before,
    'the user row must be untouched until the new address is confirmed'
  );
  assert.deepEqual(context.users.state.updates, [], 'no write may be issued to sms_users');
  assert.deepEqual(context.users.state.epochBumps, [], 'no session may be revoked by a mere request');
});

test('confirming moves the address, bumps the epoch, and drops the permission cache', async () => {
  const context = fixture();
  const { token } = await requestChange(context, { newEmail: 'sarah.new@example.com' });
  const epochBefore = context.users.state.users.find(row => row.id === 5).session_epoch;

  const res = await call(context.authRouter, 'POST', '/email-change/confirm',
    makeRequest({ body: { token } }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.success, true);
  assert.equal(res.payload.email, 'sarah.new@example.com');

  const sarah = context.users.state.users.find(row => row.id === 5);
  assert.equal(sarah.email, 'sarah.new@example.com');
  assert.equal(sarah.session_epoch, epochBefore + 1,
    'the address is part of who this account is, so other sessions must re-establish');
  assert.ok(context.invalidated.includes(5),
    'bumping the epoch without dropping the cached permissions leaves a stale entry answering for the TTL');
  assert.equal(context.emailChanges.state.rows[0].confirmed_at !== null, true);
});

test('the previous address is not echoed back to whoever opened the link', async () => {
  // On the hijack path the person opening the link is the attacker. Telling
  // them which account they just failed to take is a free gift.
  const context = fixture();
  const { token } = await requestChange(context, { newEmail: 'sarah.new@example.com' });
  const res = await call(context.authRouter, 'POST', '/email-change/confirm', makeRequest({ body: { token } }));

  assert.equal(JSON.stringify(res.payload).includes('sarah@example.com'), false);
});

// ── Every way a token can fail ─────────────────────────────────────────────

/** The user row and the pending rows, for before/after comparison. */
function snapshot(context) {
  return JSON.stringify({
    users: context.users.state.users,
    changes: context.emailChanges.state.rows
  });
}

async function assertConfirmRefused(context, token, { status, code }) {
  const before = snapshot(context);
  const res = await call(context.authRouter, 'POST', '/email-change/confirm', makeRequest({ body: { token } }));
  assert.equal(res.statusCode, status, `expected HTTP ${status}, got ${res.statusCode}`);
  assert.equal(res.payload?.code, code, `expected code ${code}, got ${res.payload?.code}`);
  assert.ok(res.payload?.error, 'a refusal must carry a human-readable message');
  assert.equal(snapshot(context), before, 'a refused confirmation must change nothing');
  return res;
}

test('an unknown token is refused, with its own code', async () => {
  const context = fixture();
  await requestChange(context, { newEmail: 'sarah.new@example.com' });
  await assertConfirmRefused(context, 'x'.repeat(43), { status: 404, code: 'EMAIL_CHANGE_NOT_FOUND' });
  assert.equal(context.users.state.users.find(row => row.id === 5).email, 'sarah@example.com');
});

test('a malformed token is answered exactly like an unknown one', async () => {
  const context = fixture();
  const short = await call(context.authRouter, 'POST', '/email-change/confirm', makeRequest({ body: { token: 'tiny' } }));
  const missing = await call(context.authRouter, 'POST', '/email-change/confirm', makeRequest({ body: {} }));
  const unknown = await call(context.authRouter, 'POST', '/email-change/confirm',
    makeRequest({ body: { token: 'x'.repeat(43) } }));

  // Identical, so the shape check is not itself an oracle for the token format.
  assert.deepEqual(short.payload, unknown.payload);
  assert.deepEqual(missing.payload, unknown.payload);
  assert.equal(short.statusCode, unknown.statusCode);
  assert.equal(missing.statusCode, unknown.statusCode);
});

test('an expired token is refused, with its own code, and the address does not move', async () => {
  const context = fixture();
  const { token } = await requestChange(context, { newEmail: 'sarah.new@example.com' });
  // Reach into the row rather than wait 24 hours. Expiry is enforced by the
  // stored timestamp, so moving it is exactly what the clock would have done.
  context.emailChanges.state.rows[0].expires_at = new Date(Date.now() - 1000).toISOString();

  await assertConfirmRefused(context, token, { status: 410, code: 'EMAIL_CHANGE_EXPIRED' });
  assert.equal(context.users.state.users.find(row => row.id === 5).email, 'sarah@example.com');
});

test('a token cannot be reused: the second confirmation is refused with its own code', async () => {
  const context = fixture();
  const { token } = await requestChange(context, { newEmail: 'sarah.new@example.com' });

  const first = await call(context.authRouter, 'POST', '/email-change/confirm', makeRequest({ body: { token } }));
  assert.equal(first.statusCode, 200);

  await assertConfirmRefused(context, token, { status: 409, code: 'EMAIL_CHANGE_USED' });
});

test('a cancelled token is refused, with its own code, and the link is dead the moment it is cancelled', async () => {
  const context = fixture();
  const { token } = await requestChange(context, { newEmail: 'sarah.new@example.com' });

  const cancelled = await call(context.router, 'POST', '/me/email/cancel', makeRequest({ actor: SARAH }));
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.payload.cancelled, true);

  await assertConfirmRefused(context, token, { status: 409, code: 'EMAIL_CHANGE_CANCELLED' });
  assert.equal(context.users.state.users.find(row => row.id === 5).email, 'sarah@example.com');
});

test('cancelling with nothing pending is the same 200, so it cannot be used to probe', async () => {
  const context = fixture();
  const first = await call(context.router, 'POST', '/me/email/cancel', makeRequest({ actor: SARAH }));
  assert.equal(first.statusCode, 200);
  assert.equal(first.payload.cancelled, false);
});

test('a token for a deactivated account is refused, with its own code', async () => {
  const context = fixture();
  const { token } = await requestChange(context, { newEmail: 'sarah.new@example.com' });
  const sarah = context.users.state.users.find(row => row.id === 5);
  sarah.is_active = false;
  sarah.deactivated_at = new Date().toISOString();

  await assertConfirmRefused(context, token, { status: 409, code: 'EMAIL_CHANGE_USER_INACTIVE' });
});

test('an address taken between the send and the click is refused, with its own code', async () => {
  const context = fixture();
  const { token } = await requestChange(context, { newEmail: 'racer@example.com' });
  // Somebody else registers it while the link sits in a mailbox.
  context.users.state.users.push({
    id: 77, email: 'racer@example.com', display_name: 'Racer', role: 'agent',
    is_active: true, is_legacy_shared: false, session_epoch: 1
  });

  await assertConfirmRefused(context, token, { status: 409, code: 'EMAIL_ALREADY_EXISTS' });
});

test('confirmationErrorFrom tells EMAIL_CHANGE_USED apart from EMAIL_CHANGE_USER_INACTIVE', () => {
  // The two share a prefix. An unordered substring scan reports whichever it
  // happens to reach first, and "already used" versus "your account is
  // disabled" send a person in completely different directions.
  assert.equal(confirmationErrorFrom(new Error('EMAIL_CHANGE_USED')).code, 'EMAIL_CHANGE_USED');
  assert.equal(confirmationErrorFrom(new Error('EMAIL_CHANGE_USER_INACTIVE')).code, 'EMAIL_CHANGE_USER_INACTIVE');
  assert.equal(confirmationErrorFrom(new Error('EMAIL_CHANGE_USER_NOT_FOUND')).code, 'EMAIL_CHANGE_USER_NOT_FOUND');
  assert.equal(confirmationErrorFrom(new Error('something else entirely')), null);
});

// ── Concurrency ────────────────────────────────────────────────────────────

test('two simultaneous confirmations of one token yield exactly one change', async () => {
  const context = fixture();
  const { token } = await requestChange(context, { newEmail: 'sarah.new@example.com' });
  const epochBefore = context.users.state.users.find(row => row.id === 5).session_epoch;

  const confirm = handlerFor(context.authRouter, 'POST', '/email-change/confirm');
  const responses = [responseRecorder(), responseRecorder()];
  await Promise.all(responses.map(res => confirm(makeRequest({ body: { token } }), res)));

  const successes = responses.filter(res => res.statusCode === 200);
  const refusals = responses.filter(res => res.statusCode !== 200);
  assert.equal(successes.length, 1, 'exactly one confirmation may succeed');
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].payload.code, 'EMAIL_CHANGE_USED');

  const sarah = context.users.state.users.find(row => row.id === 5);
  assert.equal(sarah.email, 'sarah.new@example.com');
  assert.equal(sarah.session_epoch, epochBefore + 1,
    'the epoch must move once, not once per racing request');
  assert.equal(context.emailChanges.state.rows.length, 1);
});

// ── The password check, and the enumeration guard ──────────────────────────

test('a wrong current password is refused and writes nothing', async () => {
  const context = fixture();
  const before = snapshot(context);

  const res = await call(context.router, 'POST', '/me/email', makeRequest({
    actor: SARAH,
    body: { newEmail: 'sarah.new@example.com', currentPassword: 'not-the-password' }
  }));

  assert.equal(res.statusCode, 401);
  assert.equal(res.payload.code, 'CURRENT_PASSWORD_INCORRECT');
  assert.equal(snapshot(context), before, 'a refused request must write nothing');
  assert.deepEqual(context.sent, [], 'and must send nothing, to either address');
});

test('a wrong password does not reveal whether the target address exists', async () => {
  const context = fixture();

  async function attempt(newEmail) {
    return call(context.router, 'POST', '/me/email', makeRequest({
      actor: SARAH,
      body: { newEmail, currentPassword: 'not-the-password' }
    }));
  }

  // `taken@example.com` is a real account in the fixture; the other is not.
  const existing = await attempt('taken@example.com');
  const available = await attempt('nobody-here@example.com');

  assert.equal(existing.statusCode, available.statusCode);
  assert.deepEqual(existing.payload, available.payload);
  assert.equal(existing.payload.code, 'CURRENT_PASSWORD_INCORRECT');
  // The address is not even looked at before the password is checked, so there
  // is nothing for a timing difference to be made of.
  assert.deepEqual(context.emailChanges.state.rows, []);
});

test('a correct password reveals nothing about the target address either', async () => {
  const context = fixture();

  const available = await call(context.router, 'POST', '/me/email', makeRequest({
    actor: SARAH, body: { newEmail: 'brand-new@example.com', currentPassword: CORRECT_PASSWORD }
  }));
  const taken = await call(context.router, 'POST', '/me/email', makeRequest({
    actor: SARAH, body: { newEmail: 'taken@example.com', currentPassword: CORRECT_PASSWORD }
  }));

  assert.equal(available.statusCode, 200);
  assert.equal(taken.statusCode, 200);
  // Byte-identical, so an Agent who cannot call GET /api/users cannot use this
  // endpoint to enumerate the workspace one guess at a time.
  assert.deepEqual(taken.payload, available.payload);

  // And the difference that DOES exist is invisible from the outside: the
  // collision wrote no pending row and issued no link.
  assert.equal(context.emailChanges.state.rows.length, 1);
  assert.equal(context.emailChanges.state.rows[0].new_email, 'brand-new@example.com');

  // Two messages went out on each path, so `confirmationEmail`/`noticeEmail`
  // report the truth on both without giving the branch away.
  assert.equal(context.sent.length, 4);
  const toTaken = context.sent.filter(message => message.to === 'taken@example.com');
  assert.equal(toTaken.length, 1, 'the owner of a contested address is told somebody tried');
  assert.equal(toTaken[0].text.includes('confirm-email-change'), false,
    'the collision message must carry no link');
});

test('the response reports honestly when a send fails, and does not claim otherwise', async () => {
  const users = makeUserStore();
  const emailChanges = makeEmailChangeStore(users);
  const router = createUsersRouter({
    store: users,
    emailChangeStore: emailChanges,
    authz: { invalidate() {} },
    audit: async () => {},
    // The unconfigured-provider path. lib/email.js resolves like this rather
    // than throwing, and the response must not round it up to "sent".
    sendMail: async () => ({ sent: false, reason: 'not_configured' })
  });

  const res = await call(router, 'POST', '/me/email', makeRequest({
    actor: SARAH, body: { newEmail: 'sarah.new@example.com', currentPassword: CORRECT_PASSWORD }
  }));

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.confirmationEmail, { sent: false, reason: 'not_configured' });
  assert.deepEqual(res.payload.noticeEmail, { sent: false, reason: 'not_configured' });
  // The row still exists. The token is real and the change is still pending;
  // the only thing that failed is the courtesy that carried the link.
  assert.equal(emailChanges.state.rows.length, 1);
});

test('the stated expiry matches the row, and is enforced from the row', async () => {
  const context = fixture();
  const requestedAt = Date.now();
  const { token } = await requestChange(context, { newEmail: 'sarah.new@example.com' });

  const stored = context.emailChanges.state.rows[0];
  const ttlMs = new Date(stored.expires_at).getTime() - requestedAt;
  assert.ok(Math.abs(ttlMs - EMAIL_CHANGE_TTL_HOURS * 3600 * 1000) < 5000,
    `expected roughly ${EMAIL_CHANGE_TTL_HOURS}h, got ${ttlMs}ms`);

  const confirmation = context.sent.find(message => (message.text || '').includes(token));
  assert.ok(confirmation, 'the confirmation mail must carry the link');
  assert.match(confirmation.text, /expires on /, 'the window has to be stated in the email');
});

// ── Superseding ────────────────────────────────────────────────────────────

test('asking a second time supersedes the first link rather than leaving two live', async () => {
  const context = fixture();
  const first = await requestChange(context, { newEmail: 'one@example.com' });
  const second = await requestChange(context, { newEmail: 'two@example.com' });

  assert.equal(second.res.statusCode, 200);
  assert.notEqual(first.token, second.token);
  assert.equal(context.emailChanges.state.rows.length, 2);
  assert.equal(context.emailChanges.state.rows[0].cancelled_at !== null, true,
    'the older request must be closed, or two links point at two different addresses');

  await assertConfirmRefused(context, first.token, { status: 409, code: 'EMAIL_CHANGE_CANCELLED' });

  const ok = await call(context.authRouter, 'POST', '/email-change/confirm',
    makeRequest({ body: { token: second.token } }));
  assert.equal(ok.statusCode, 200);
  assert.equal(context.users.state.users.find(row => row.id === 5).email, 'two@example.com');
});

// ── The legacy shared identity ─────────────────────────────────────────────

test('the shared team login cannot request, cancel or confirm an email change', async () => {
  const context = fixture();

  for (const route of ['/me/email', '/me/email/cancel']) {
    const res = await call(context.router, 'POST', route, makeRequest({
      actor: LEGACY, body: { newEmail: 'hijack@example.com', currentPassword: CORRECT_PASSWORD }
    }));
    assert.equal(res.statusCode, 409, `${route} must refuse the shared identity`);
    assert.equal(res.payload.code, 'LEGACY_USER_IMMUTABLE');
  }
  assert.deepEqual(context.emailChanges.state.rows, []);
  assert.equal(context.users.state.users.find(row => row.id === 1).email, 'legacy@vici.local');

  // And even a row planted directly against it cannot be confirmed. The
  // migration refuses it in SQL for the same reason: syncLegacySharedRole()
  // exits the process at boot if that identity is not where it expects.
  const rawToken = 'z'.repeat(43);
  context.emailChanges.state.rows.push({
    id: crypto.randomUUID(),
    user_id: 1,
    new_email: 'hijack@example.com',
    token_hash: hashToken(rawToken),
    token_prefix: hashToken(rawToken).slice(0, 8),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    confirmed_at: null,
    cancelled_at: null
  });
  const res = await call(context.authRouter, 'POST', '/email-change/confirm',
    makeRequest({ body: { token: rawToken } }));
  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, 'LEGACY_USER_IMMUTABLE');
  assert.equal(context.users.state.users.find(row => row.id === 1).email, 'legacy@vici.local');
});

// ── Input validation ───────────────────────────────────────────────────────

test('an invalid address is refused before the password is even checked', async () => {
  const context = fixture();
  for (const newEmail of ['', 'not-an-email', 'no@domain', `${'a'.repeat(250)}@example.com`]) {
    const res = await call(context.router, 'POST', '/me/email',
      makeRequest({ actor: SARAH, body: { newEmail, currentPassword: CORRECT_PASSWORD } }));
    assert.equal(res.statusCode, 400, `"${newEmail.slice(0, 20)}" should be refused`);
    assert.equal(res.payload.code, 'INVALID_EMAIL');
  }
  assert.deepEqual(context.emailChanges.state.rows, []);
});

test('asking to move to the address you already hold is a plain refusal, not a pending change', async () => {
  const context = fixture();
  const res = await call(context.router, 'POST', '/me/email', makeRequest({
    actor: SARAH, body: { newEmail: 'SARAH@example.com', currentPassword: CORRECT_PASSWORD }
  }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.code, 'EMAIL_UNCHANGED');
  assert.deepEqual(context.emailChanges.state.rows, [],
    'this must not consume the one open slot the partial unique index allows');
});

test('an account with no password set cannot open an email change', async () => {
  // id 3, Dominic, is seeded with password_hash NULL exactly as production has
  // him. There is nothing to check the request against, so it is refused rather
  // than waved through.
  const context = fixture();
  const dominic = actorFrom({ id: 3, displayName: 'Dominic', role: 'owner', permissions: ['user.manage'] });
  const res = await call(context.router, 'POST', '/me/email',
    makeRequest({ actor: dominic, body: { newEmail: 'd@example.com', currentPassword: '' } }));

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.code, 'PASSWORD_NOT_SET');
  assert.deepEqual(context.emailChanges.state.rows, []);
});
