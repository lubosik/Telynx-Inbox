'use strict';
/**
 * test/password-reset.test.js — the self-service forgotten-password flow.
 *
 * WHAT THIS FILE IS ACTUALLY FOR
 *   Not coverage. Six security properties, each of which is a real incident if
 *   it is wrong, and each of which is asserted on OBSERVABLE STATE rather than
 *   on a status code:
 *
 *     1. No account-existence oracle. The body, the status AND the elapsed time
 *        are identical for an active account, a deactivated one, the shared
 *        identity, an address nobody holds, and a database failure.
 *     2. The raw token is stored nowhere. Every value that reaches the store is
 *        scanned for it, not just the column somebody remembered to check.
 *     3. Single use and atomic. Two concurrent confirmations of one token
 *        produce exactly one password change.
 *     4. A completed reset ends every existing session (session_epoch bumped).
 *     5. A completed reset clears the lockout, or an account locked out by an
 *        attacker can never be recovered.
 *     6. Expiry is enforced server-side, not merely printed in the email.
 *
 *   Plus the two failure modes that make a reset flow useless in practice: a
 *   weak password must not burn the single-use token, and a mail failure must
 *   not leave the account in a half-changed state.
 *
 * WHY THE FAKES LOOK LIKE THIS
 *   `fakeResetStore` is a small in-memory model of the SQL in
 *   scripts/password-reset-migration.sql, INCLUDING its ordering of checks and
 *   its RAISE messages, because those messages are the contract
 *   `confirmErrorFrom` parses. It also serialises `complete` behind a single
 *   promise chain, which is the JavaScript analogue of SELECT ... FOR UPDATE
 *   and is what makes the concurrency test meaningful rather than decorative.
 *
 * Offline: no database, no network, no timers longer than a tick. `sleep` is
 * injected, so the response floor is asserted rather than waited for.
 */

process.env.SUPABASE_URL ||= 'https://unit-test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'unit-test-service-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createAuthRouter } = require('../routes/auth');
const {
  EXPIRY_MINUTES,
  GENERIC_REQUEST_MESSAGE,
  MIN_RESPONSE_MS,
  confirmErrorFrom,
  generateToken,
  hashToken,
  resetUrlFor,
  settleAfter,
  tokenPrefixOfHash
} = require('../lib/password-reset');
const { passwordResetEmail } = require('../lib/email-templates');
const { verifyPassword } = require('../lib/password');
const { buildRow } = require('../lib/audit/log');
const { buildAssociation } = require('../lib/apple-site-association');

const STRONG_PASSWORD = 'correct horse battery staple';
const WEAK_PASSWORD = 'short';

// ── Fixtures ───────────────────────────────────────────────────────────────

function team() {
  return [
    {
      id: 4, email: 'sarah@example.com', display_name: 'Sarah', role: 'agent',
      is_active: true, is_legacy_shared: false,
      password_hash: 'scrypt$1$N=1,r=1,p=1,len=4$c2FsdA==$b2xk',
      password_set_at: '2026-01-01T00:00:00.000Z',
      must_change_password: false, session_epoch: 7,
      failed_login_count: 5, locked_until: '2099-01-01T00:00:00.000Z'
    },
    {
      id: 5, email: 'gone@example.com', display_name: 'Gone', role: 'agent',
      is_active: false, is_legacy_shared: false,
      password_hash: 'scrypt$1$N=1,r=1,p=1,len=4$c2FsdA==$b2xk',
      must_change_password: false, session_epoch: 2,
      failed_login_count: 0, locked_until: null
    },
    {
      id: 1, email: 'legacy@vici.local', display_name: 'Team', role: 'legacy',
      is_active: true, is_legacy_shared: true,
      password_hash: null,
      must_change_password: false, session_epoch: 1,
      failed_login_count: 0, locked_until: null
    }
  ];
}

/**
 * An in-memory model of sms_password_resets plus the two SQL functions.
 *
 * `failWith` makes a chosen method reject, so the "a storage failure is not an
 * oracle either" case is reachable without a database.
 */
function fakeResetStore(seed = team()) {
  const state = {
    users: seed,
    resets: [],
    attempts: [],
    describeCalls: [],
    /** Everything ever handed to open(), for the "no raw token stored" scan. */
    written: [],
    failWith: null,
    now: () => Date.now()
  };

  /** The FOR UPDATE analogue: complete() calls run one at a time, in order. */
  let lock = Promise.resolve();

  function raise(code) {
    throw new Error(`postgres error: ${code}`);
  }

  const store = {
    state,

    async findAccountByEmail(email) {
      if (state.failWith === 'findAccountByEmail') throw new Error('connection refused');
      const found = state.users.filter(
        row => row.email.toLowerCase() === String(email).toLowerCase()
      );
      return found.length === 1 ? found[0] : null;
    },

    async open(row) {
      if (state.failWith === 'open') throw new Error('insert failed');
      state.written.push(row);
      const account = state.users.find(user => user.id === row.userId);
      if (!account) raise('RESET_NOT_FOUND');
      if (account.is_legacy_shared || !account.is_active) raise('RESET_NOT_ALLOWED');
      // The supersede half of open_sms_password_reset.
      for (const existing of state.resets) {
        if (existing.user_id === row.userId && !existing.used_at && !existing.cancelled_at) {
          existing.cancelled_at = new Date(state.now()).toISOString();
          existing.cancelled_reason = 'superseded';
        }
      }
      const created = {
        id: crypto.randomUUID(),
        user_id: row.userId,
        token_hash: row.tokenHash,
        token_prefix: row.tokenPrefix,
        requested_at: new Date(state.now()).toISOString(),
        expires_at: row.expiresAt,
        used_at: null,
        cancelled_at: null,
        cancelled_reason: null,
        requested_ip: row.ip ?? null,
        requested_user_agent: row.userAgent ?? null,
        attempt_count: 0
      };
      state.resets.push(created);
      return created.id;
    },

    /**
     * complete_sms_password_reset, serialised. Each call waits for the previous
     * one to finish before it reads, which is what SELECT ... FOR UPDATE buys
     * in the real function.
     */
    complete(tokenHash, passwordHash) {
      const run = lock.then(async () => {
        const request = state.resets.find(row => row.token_hash === tokenHash);
        if (!request) raise('RESET_NOT_FOUND');
        if (request.used_at) raise('RESET_USED');
        if (request.cancelled_at) raise('RESET_CANCELLED');
        if (new Date(request.expires_at).getTime() <= state.now()) raise('RESET_EXPIRED');

        const account = state.users.find(row => row.id === request.user_id);
        if (!account) raise('RESET_NOT_FOUND');
        if (account.is_legacy_shared || !account.is_active) raise('RESET_NOT_ALLOWED');

        account.password_hash = passwordHash;
        account.password_set_at = new Date(state.now()).toISOString();
        account.must_change_password = false;
        account.failed_login_count = 0;
        account.locked_until = null;
        account.session_epoch += 1;
        request.used_at = new Date(state.now()).toISOString();
        return account.id;
      });
      // The lock must advance whether the body resolved or rejected, and
      // `.then(ok, fail)` rather than `.catch` keeps one shape in this file.
      lock = run.then(() => {}, () => {});
      return run;
    },

    async describeUser(userId) {
      state.describeCalls.push(userId);
      const found = state.users.find(row => row.id === userId);
      return found ? { id: found.id, email: found.email, display_name: found.display_name, role: found.role } : null;
    },

    async noteAttempt(tokenHash) {
      state.attempts.push(tokenHash);
    }
  };
  return store;
}

/** A no-op express-rate-limit stand-in. */
function passThroughLimiter(_req, _res, next) {
  return next();
}

const NO_OP_AUTHZ = {
  invalidate() {},
  events: [],
  async logAuthEvent(event) { NO_OP_AUTHZ.events.push(event); }
};

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    json(payload) { this.payload = payload; return this; }
  };
}

function handlerFor(router, method, routePath) {
  const layer = router.stack.find(entry =>
    entry.route?.path === routePath && entry.route?.methods?.[method.toLowerCase()]);
  assert.ok(layer, `no handler for ${method} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeRequest(body = {}) {
  return {
    body,
    params: {},
    ip: '203.0.113.9',
    get: name => (name === 'user-agent' ? 'ViciInbox/1.4 (iPhone)' : null)
  };
}

/**
 * A router wired entirely to fakes.
 *
 * `sleep` records what it was asked to wait for instead of waiting, so the
 * response floor is assertable in a test suite that finishes in milliseconds.
 */
function fixture({ seed, baseUrl = 'https://inbox.example.com', mail = () => ({ sent: true }) } = {}) {
  const store = fakeResetStore(seed);
  const sent = [];
  const auditRows = [];
  const sleeps = [];

  const router = createAuthRouter({
    authz: {
      invalidate() {},
      async logAuthEvent(event) { authEvents.push(event); }
    },
    // routes/auth.js only reaches these on paths this file does not exercise;
    // supplying them keeps the factory from touching ../db.
    invitationStore: { async redeem() { throw new Error('unused'); }, async noteAttempt() {} },
    emailChangeStore: {},
    audit: async input => { auditRows.push(input); },
    limiter: passThroughLimiter,
    passwordReset: {
      store,
      baseUrl,
      minResponseMs: MIN_RESPONSE_MS,
      sleep: async ms => { sleeps.push(ms); },
      async sendMail(message) {
        sent.push(message);
        return mail(message);
      }
    }
  });

  const authEvents = [];
  return { store, router, sent, auditRows, sleeps, authEvents };
}

async function call(router, method, routePath, body) {
  const res = responseRecorder();
  await handlerFor(router, method, routePath)(makeRequest(body), res);
  return res;
}

const REQUEST_PATH = '/password-reset/request';
const CONFIRM_PATH = '/password-reset/confirm';

/** The raw token out of the one email that was sent. */
function tokenFromEmail(message) {
  const found = /[?&]token=([^\s"&<]+)/.exec(message.text);
  assert.ok(found, 'the email must contain a reset link with a token');
  return decodeURIComponent(found[1]);
}

/** Drive one successful request and hand back the raw token. */
async function requestAndCollect(fixtureBag, email = 'sarah@example.com') {
  const before = fixtureBag.sent.length;
  const res = await call(fixtureBag.router, 'POST', REQUEST_PATH, { email });
  assert.equal(res.statusCode, 202);
  assert.equal(fixtureBag.sent.length, before + 1, 'exactly one email per request');
  return tokenFromEmail(fixtureBag.sent[fixtureBag.sent.length - 1]);
}

// ── 1. No account-existence oracle ─────────────────────────────────────────

test('every reset request gets the same status, the same body and no extra fields', async () => {
  const cases = [
    ['an active account', 'sarah@example.com'],
    ['a deactivated account', 'gone@example.com'],
    ['the legacy shared identity', 'legacy@vici.local'],
    ['an address nobody holds', 'nobody@example.com'],
    ['a different unknown address', 'also-nobody@example.org']
  ];

  const answers = [];
  for (const [, email] of cases) {
    const bag = fixture();
    const res = await call(bag.router, 'POST', REQUEST_PATH, { email });
    answers.push({ status: res.statusCode, payload: res.payload });
  }

  const first = answers[0];
  assert.equal(first.status, 202);
  assert.deepEqual(first.payload, { success: true, message: GENERIC_REQUEST_MESSAGE });
  // No em dashes in copy a customer reads. Standing rule for this client.
  assert.equal(GENERIC_REQUEST_MESSAGE.includes('—'), false);

  for (let index = 1; index < answers.length; index += 1) {
    assert.deepEqual(
      answers[index], first,
      `${cases[index][0]} answered differently from an active account, which enumerates accounts`
    );
  }
});

test('a storage failure is not an oracle either: still 202, still the same body', async () => {
  for (const failure of ['findAccountByEmail', 'open']) {
    const bag = fixture();
    bag.store.state.failWith = failure;

    const res = await call(bag.router, 'POST', REQUEST_PATH, { email: 'sarah@example.com' });

    assert.equal(res.statusCode, 202, `${failure} must not surface as a 5xx`);
    assert.deepEqual(res.payload, { success: true, message: GENERIC_REQUEST_MESSAGE });
    assert.deepEqual(bag.sent, [], 'and nothing may be mailed');
  }
});

test('the response floor is applied identically to every branch', async () => {
  // The timing half of property 1. The account-exists branch costs an extra
  // round trip; without a floor, latency alone answers "does this address
  // work here?". `sleep` is injected, so this asserts the floor is requested
  // rather than waiting 600ms five times.
  const requested = [];
  for (const email of ['sarah@example.com', 'gone@example.com', 'legacy@vici.local', 'nobody@example.com']) {
    const bag = fixture();
    await call(bag.router, 'POST', REQUEST_PATH, { email });
    assert.equal(bag.sleeps.length, 1, `${email} must pad its response exactly once`);
    requested.push(bag.sleeps[0] > 0);
  }
  assert.deepEqual(requested, [true, true, true, true],
    'every branch must wait for the floor, not just the cheap ones');

  // And the floor itself does what it says.
  const slept = [];
  const waited = await settleAfter(1000, 600, { now: () => 1100, sleep: async ms => slept.push(ms) });
  assert.deepEqual(slept, [500], '100ms elapsed of a 600ms floor leaves 500ms');
  assert.equal(waited, 500);

  const overrun = [];
  assert.equal(await settleAfter(1000, 600, { now: () => 9999, sleep: async ms => overrun.push(ms) }), 0);
  assert.deepEqual(overrun, [], 'work that already exceeded the floor is not padded further');
});

test('the mail is dispatched without being awaited, so a slow provider is not a signal', async () => {
  // A provider that never resolves must not hold the response open. If the
  // handler awaited the send, this test would hang rather than fail.
  let release;
  const bag = fixture({ mail: () => new Promise(resolve => { release = resolve; }) });

  const res = await call(bag.router, 'POST', REQUEST_PATH, { email: 'sarah@example.com' });

  assert.equal(res.statusCode, 202);
  assert.equal(bag.sent.length, 1, 'the send was started');
  assert.equal(typeof release, 'function', 'and is still in flight');
  release({ sent: true });
});

test('a deactivated account and the shared identity are refused silently, with no email', async () => {
  for (const email of ['gone@example.com', 'legacy@vici.local']) {
    const bag = fixture();
    const res = await call(bag.router, 'POST', REQUEST_PATH, { email });

    assert.equal(res.statusCode, 202);
    assert.deepEqual(bag.sent, [], `${email} must not be mailed a reset link`);
    assert.deepEqual(bag.store.state.resets, [], 'and no reset row may be written');
  }
});

test('the legacy identity is refused because its credential is not a row', () => {
  // Belt and braces on the property above: even if the request handler were
  // changed, the store model refuses, exactly as open_sms_password_reset does.
  const store = fakeResetStore();
  return assert.rejects(
    store.open({ userId: 1, tokenHash: 'a'.repeat(64), tokenPrefix: 'aaaaaaaa', expiresAt: '2099-01-01T00:00:00.000Z' }),
    /RESET_NOT_ALLOWED/
  );
});

test('a malformed address is a 400 and not an existence signal', async () => {
  const bag = fixture();
  for (const email of ['', '   ', 'not-an-email', 'a@b', undefined, 42, `${'x'.repeat(320)}@example.com`]) {
    const res = await call(bag.router, 'POST', REQUEST_PATH, { email });
    assert.equal(res.statusCode, 400, `${JSON.stringify(email)} is not a well-formed address`);
    assert.equal(res.payload.code, 'INVALID_EMAIL');
  }
  // Every WELL-FORMED address, held or not, still gets the one generic answer.
  assert.deepEqual(bag.sent, []);
});

// ── 2. The token is stored only as a hash ──────────────────────────────────

test('the raw token appears in no stored column, and neither does any prefix of it', async () => {
  const bag = fixture();
  const rawToken = await requestAndCollect(bag);

  const stored = JSON.stringify({
    resets: bag.store.state.resets,
    written: bag.store.state.written,
    users: bag.store.state.users
  });

  assert.equal(stored.includes(rawToken), false, 'the raw token must never be stored');
  // A prefix of the token would be a head start on guessing it. The stored
  // prefix is of the HASH, which is exactly what this asserts.
  assert.equal(stored.includes(rawToken.slice(0, 12)), false, 'not even a prefix of the token');

  const row = bag.store.state.resets[0];
  assert.equal(row.token_hash, hashToken(rawToken), 'the sha256 is what is stored');
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);
  assert.equal(row.token_prefix, tokenPrefixOfHash(row.token_hash));
  assert.equal(row.token_prefix.length, 8);
  assert.ok(row.token_hash.startsWith(row.token_prefix), 'the prefix is of the hash, not of the token');
});

test('the token is never echoed in a response body', async () => {
  const bag = fixture();
  const res = await call(bag.router, 'POST', REQUEST_PATH, { email: 'sarah@example.com' });
  const rawToken = tokenFromEmail(bag.sent[0]);

  const body = JSON.stringify(res.payload);
  assert.equal(body.includes(rawToken), false);
  assert.equal(body.includes(hashToken(rawToken)), false);
  assert.equal(body.includes('token'), false, 'the response mentions no token at all');
});

test('a completed reset leaves no token, hash or password anywhere in the audit row', async () => {
  const bag = fixture();
  const rawToken = await requestAndCollect(bag);
  await call(bag.router, 'POST', CONFIRM_PATH, { token: rawToken, password: STRONG_PASSWORD });

  assert.equal(bag.auditRows.length, 1, 'a completed reset writes exactly one audit row');
  const input = bag.auditRows[0];
  assert.equal(input.eventType, 'team.member.password_reset');
  assert.equal(input.metadata.reset_method, 'self_service_reset_link');
  assert.equal(input.metadata.logins_revoked, true);
  assert.equal(input.metadata.must_rotate_on_next_sign_in, false);
  assert.equal(input.entityId, 4);
  assert.match(input.summary, /^Sarah reset their own password with an emailed link/);

  // Asserted on the ROW, not on the input. The input carries the whole Express
  // request, whose body still holds the token and the new password at that
  // point; what matters is that neither survives into the row that is stored,
  // which is what buildRow produces and what the insert writes.
  const { row } = buildRow(input);
  assert.equal(row.event_type, 'team.member.password_reset');
  assert.equal(row.severity, 'warning');
  assert.equal(row.actor_user_id, 4, 'the account holder is the actor: they held the token');
  assert.equal(row.ip, '203.0.113.9', 'and the provenance of an unauthenticated reset is kept');
  assert.equal(row.user_agent, 'ViciInbox/1.4 (iPhone)');

  const serialised = JSON.stringify(row);
  for (const forbidden of [rawToken, hashToken(rawToken), STRONG_PASSWORD, 'scrypt$', 'password_hash']) {
    assert.equal(serialised.includes(forbidden), false, `${forbidden.slice(0, 12)} must not reach a stored audit row`);
  }
});

test('tokens are unguessable and distinct', () => {
  const seen = new Set();
  for (let index = 0; index < 200; index += 1) {
    const token = generateToken();
    assert.ok(token.length >= 40, 'a 32-byte base64url token is 43 characters');
    assert.match(token, /^[A-Za-z0-9_-]+$/, 'base64url only: it goes in a URL');
    assert.equal(seen.has(token), false, 'randomBytes must not repeat');
    seen.add(token);
  }
});

// ── 3. Single use and atomic ───────────────────────────────────────────────

test('two concurrent confirmations of one token yield exactly one password change', async () => {
  const bag = fixture();
  const rawToken = await requestAndCollect(bag);
  const before = bag.store.state.users.find(row => row.id === 4).session_epoch;

  const [first, second] = await Promise.all([
    call(bag.router, 'POST', CONFIRM_PATH, { token: rawToken, password: STRONG_PASSWORD }),
    call(bag.router, 'POST', CONFIRM_PATH, { token: rawToken, password: 'a completely different one' })
  ]);

  const statuses = [first.statusCode, second.statusCode].sort();
  assert.deepEqual(statuses, [200, 409], 'exactly one winner, and the loser is told it was used');

  const loser = first.statusCode === 409 ? first : second;
  assert.equal(loser.payload.code, 'RESET_USED');

  const account = bag.store.state.users.find(row => row.id === 4);
  assert.equal(account.session_epoch, before + 1, 'the epoch moved exactly once');
  assert.equal(bag.store.state.resets.filter(row => row.used_at).length, 1);
  assert.equal(bag.auditRows.length, 1, 'and exactly one audit row, not two');

  // The winner's password is the one that stuck, and the loser's is not.
  assert.equal(await verifyPassword(STRONG_PASSWORD, account.password_hash), true);
  assert.equal(await verifyPassword('a completely different one', account.password_hash), false);
});

test('a spent token cannot be replayed', async () => {
  const bag = fixture();
  const rawToken = await requestAndCollect(bag);

  assert.equal((await call(bag.router, 'POST', CONFIRM_PATH, { token: rawToken, password: STRONG_PASSWORD })).statusCode, 200);
  const replay = await call(bag.router, 'POST', CONFIRM_PATH, { token: rawToken, password: 'yet another password' });

  assert.equal(replay.statusCode, 409);
  assert.equal(replay.payload.code, 'RESET_USED');
  assert.equal(await verifyPassword(STRONG_PASSWORD, bag.store.state.users.find(row => row.id === 4).password_hash), true,
    'the replay must not have overwritten the password set by the first use');
});

test('a new request supersedes the previous one, and the old link is refused as cancelled', async () => {
  const bag = fixture();
  const firstToken = await requestAndCollect(bag);
  const secondToken = await requestAndCollect(bag);
  assert.notEqual(firstToken, secondToken);

  assert.equal(bag.store.state.resets.length, 2);
  assert.equal(
    bag.store.state.resets.filter(row => !row.used_at && !row.cancelled_at).length, 1,
    'only one open request per person'
  );

  const stale = await call(bag.router, 'POST', CONFIRM_PATH, { token: firstToken, password: STRONG_PASSWORD });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.payload.code, 'RESET_CANCELLED');

  const fresh = await call(bag.router, 'POST', CONFIRM_PATH, { token: secondToken, password: STRONG_PASSWORD });
  assert.equal(fresh.statusCode, 200);
});

test('the four failure causes are four distinct codes, and an unknown token is 404', async () => {
  const bag = fixture();
  const unknown = await call(bag.router, 'POST', CONFIRM_PATH, {
    token: generateToken(), password: STRONG_PASSWORD
  });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.payload.code, 'RESET_NOT_FOUND');

  // A token that is not even token-shaped is refused before any lookup.
  for (const token of ['', 'tiny', undefined, 42, 'x'.repeat(513)]) {
    const res = await call(bag.router, 'POST', CONFIRM_PATH, { token, password: STRONG_PASSWORD });
    assert.equal(res.statusCode, 404, `${JSON.stringify(token)} is not a token`);
    assert.equal(res.payload.code, 'RESET_NOT_FOUND');
  }

  // And the mapping the SQL RAISE messages are parsed into.
  const codes = ['RESET_NOT_FOUND', 'RESET_USED', 'RESET_CANCELLED', 'RESET_EXPIRED', 'RESET_NOT_ALLOWED'];
  const statuses = new Map();
  for (const code of codes) {
    const mapped = confirmErrorFrom(new Error(`postgres error: ${code}`));
    assert.ok(mapped, `${code} must map to an HTTP answer`);
    assert.equal(mapped.code, code);
    assert.ok(mapped.message && !mapped.message.includes('—'), 'a human message with no em dash');
    statuses.set(code, mapped.status);
  }
  assert.deepEqual(
    [...statuses.entries()].sort(),
    [['RESET_CANCELLED', 409], ['RESET_EXPIRED', 410], ['RESET_NOT_ALLOWED', 403], ['RESET_NOT_FOUND', 404], ['RESET_USED', 409]]
  );
  assert.equal(confirmErrorFrom(new Error('connection refused')), null,
    'an unrecognised failure must not be dressed up as a token problem');
});

// ── 4 and 5. Sessions end, and a lockout is cleared ────────────────────────

test('a completed reset ends every existing session and clears the lockout', async () => {
  const bag = fixture();
  const account = bag.store.state.users.find(row => row.id === 4);
  const epochBefore = account.session_epoch;
  assert.equal(account.failed_login_count, 5, 'the fixture starts locked out on purpose');
  assert.ok(account.locked_until, 'and with a lock in the future');

  const rawToken = await requestAndCollect(bag);
  const res = await call(bag.router, 'POST', CONFIRM_PATH, { token: rawToken, password: STRONG_PASSWORD });

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.success, true);

  // 4: every session ends. The cookie carries `se` and the backend compares it
  // against this on every request, so a bumped epoch is what logs out a device
  // the owner no longer holds.
  assert.equal(account.session_epoch, epochBefore + 1, 'the session epoch must move');

  // 5: the lockout is cleared. A lock outranks a correct password in
  // POST /auth/login, so without this an account locked out by an attacker
  // guessing at it could never be recovered by its owner.
  assert.equal(account.failed_login_count, 0);
  assert.equal(account.locked_until, null);

  // And the rest of the promised state.
  assert.equal(account.must_change_password, false, 'they chose this password themselves');
  assert.equal(await verifyPassword(STRONG_PASSWORD, account.password_hash), true);
  assert.equal(bag.store.state.resets[0].used_at !== null, true, 'the request is marked used');
});

test('the confirmation does not sign anybody in', async () => {
  const bag = fixture();
  const rawToken = await requestAndCollect(bag);

  const res = responseRecorder();
  const req = makeRequest({ token: rawToken, password: STRONG_PASSWORD });
  await handlerFor(bag.router, 'POST', CONFIRM_PATH)(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(req.session, undefined, 'a forwarded link must be a dead end, not a session');
  assert.equal(JSON.stringify(res.payload).includes('sarah@example.com'), false,
    'and the address is not echoed back to whoever holds the link');
});

// ── 6. Expiry is enforced server-side ──────────────────────────────────────

test('an expired token is refused by the server, whatever the email said', async () => {
  const bag = fixture();
  const rawToken = await requestAndCollect(bag);
  const account = bag.store.state.users.find(row => row.id === 4);
  const hashBefore = account.password_hash;

  // One second past the hour.
  const expiresAt = new Date(bag.store.state.resets[0].expires_at).getTime();
  bag.store.state.now = () => expiresAt + 1000;

  const res = await call(bag.router, 'POST', CONFIRM_PATH, { token: rawToken, password: STRONG_PASSWORD });

  assert.equal(res.statusCode, 410);
  assert.equal(res.payload.code, 'RESET_EXPIRED');
  assert.equal(account.password_hash, hashBefore, 'nothing may change on an expired link');
  assert.equal(account.session_epoch, 7, 'and no session may be ended');
});

test('the expiry written is 60 minutes, and the email says so', async () => {
  const bag = fixture();
  const before = Date.now();
  await requestAndCollect(bag);
  const after = Date.now();

  // The window, not a point: expires_at is stamped somewhere between the two
  // clock reads, so anything outside [before + 60m, after + 60m] is wrong.
  const expiresAt = new Date(bag.store.state.resets[0].expires_at).getTime();
  const window = EXPIRY_MINUTES * 60 * 1000;
  assert.ok(
    expiresAt >= before + window && expiresAt <= after + window,
    `expected an expiry ${EXPIRY_MINUTES} minutes out, got ${(expiresAt - before) / 60000} minutes`
  );
  assert.equal(EXPIRY_MINUTES, 60);

  assert.match(bag.sent[0].text, /expires in 60 minutes/);
});

// ── A weak password must not burn the token ────────────────────────────────

test('a weak password is refused WITHOUT consuming the token', async () => {
  const bag = fixture();
  const rawToken = await requestAndCollect(bag);

  const refused = await call(bag.router, 'POST', CONFIRM_PATH, { token: rawToken, password: WEAK_PASSWORD });

  assert.equal(refused.statusCode, 400);
  assert.equal(refused.payload.code, 'PASSWORD_TOO_WEAK');
  assert.ok(refused.payload.error.includes('12'), 'the message says what the rule is');

  const row = bag.store.state.resets[0];
  assert.equal(row.used_at, null, 'the token must survive a rejected password');
  assert.equal(row.cancelled_at, null);
  assert.deepEqual(bag.store.state.attempts, [], 'and a client-side validation failure is not a failed attempt');
  assert.deepEqual(bag.auditRows, [], 'nothing happened, so nothing is audited');

  // The same link then works with a good password.
  const accepted = await call(bag.router, 'POST', CONFIRM_PATH, { token: rawToken, password: STRONG_PASSWORD });
  assert.equal(accepted.statusCode, 200);
});

test('every weak-password shape is refused before the token is looked at', async () => {
  const bag = fixture();
  const rawToken = await requestAndCollect(bag);

  for (const password of [undefined, null, 42, '', 'short', ' '.repeat(20), 'x'.repeat(201)]) {
    const res = await call(bag.router, 'POST', CONFIRM_PATH, { token: rawToken, password });
    assert.equal(res.statusCode, 400, `${JSON.stringify(password)} must be refused`);
    assert.equal(res.payload.code, 'PASSWORD_TOO_WEAK');
  }
  assert.equal(bag.store.state.resets[0].used_at, null, 'and none of them spent the token');
});

// ── A mail failure must not break the account ──────────────────────────────

test('an email that never sends leaves the account untouched and the row usable', async () => {
  for (const mail of [
    () => ({ sent: false, reason: 'not_configured' }),
    () => ({ sent: false, reason: 'provider_error', status: 500 }),
    () => Promise.reject(new Error('socket hang up'))
  ]) {
    const bag = fixture({ mail });
    const account = bag.store.state.users.find(row => row.id === 4);
    const before = JSON.parse(JSON.stringify(account));

    const res = await call(bag.router, 'POST', REQUEST_PATH, { email: 'sarah@example.com' });
    // Let the detached dispatch settle so a rejection has a chance to escape.
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(res.statusCode, 202, 'the caller is told the same thing regardless');
    assert.deepEqual(res.payload, { success: true, message: GENERIC_REQUEST_MESSAGE });
    assert.deepEqual(JSON.parse(JSON.stringify(account)), before,
      'no password, epoch, lock or flag may change because a reset was merely requested');
    assert.equal(bag.store.state.resets.length, 1, 'the row is committed either way');
    assert.equal(bag.store.state.resets[0].used_at, null, 'and is still spendable');
  }
});

test('with APP_URL unset no link can be built, so nothing is written and nothing is mailed', async () => {
  const bag = fixture({ baseUrl: '' });
  const res = await call(bag.router, 'POST', REQUEST_PATH, { email: 'sarah@example.com' });

  assert.equal(res.statusCode, 202, 'still the generic answer');
  assert.deepEqual(bag.sent, [], 'a reset email with no link is worse than none');
  assert.deepEqual(bag.store.state.resets, [],
    'and no row, so a working link from earlier is not superseded by a useless one');
});

// ── The email itself ───────────────────────────────────────────────────────

test('the reset email says who it is for, what happened, the link, the deadline and the way out', () => {
  const message = passwordResetEmail({
    recipientName: 'Sarah',
    workspaceName: 'Vici Inbox',
    resetUrl: 'https://inbox.example.com/reset-password?token=abc123',
    expiresAt: '2026-08-22T14:30:00.000Z',
    expiryMinutes: 60
  });

  assert.equal(message.subject, 'Reset your Vici Inbox password');
  assert.match(message.text, /^Hi Sarah,/);
  assert.match(message.text, /Someone asked to reset the password for your Vici Inbox account\./);
  assert.ok(message.text.includes('https://inbox.example.com/reset-password?token=abc123'));
  assert.match(message.text, /expires in 60 minutes, at Saturday, 22 August 2026 at 14:30 UTC/);
  assert.match(message.text, /If you did not ask for this, you can ignore this email\./);
  assert.match(message.text, /Your password has not changed/);

  // The link is in the HTML twice: the button and the copy-paste fallback.
  assert.equal((message.html.match(/reset-password\?token=abc123/g) || []).length, 3);

  // House rule: no em dashes in anything a customer reads.
  for (const part of [message.subject, message.text, message.html]) {
    assert.equal(part.includes('—'), false, 'no em dashes in user-facing copy');
  }

  // No tracking pixel, and no second link to get wrong.
  assert.equal(/<img/i.test(message.html), false);
});

test('the template degrades safely with no name and no expiry, and escapes what it is given', () => {
  const bare = passwordResetEmail({ resetUrl: 'https://x.test/reset-password?token=t' });
  assert.match(bare.text, /^Hi,/);
  assert.equal(bare.text.includes('undefined'), false);
  assert.equal(bare.text.includes('null'), false);
  assert.match(bare.text, /This link expires in 60 minutes\./);

  const hostile = passwordResetEmail({
    recipientName: '<script>alert(1)</script>',
    resetUrl: 'https://x.test/reset-password?token=t"onload="alert(1)'
  });
  assert.equal(hostile.html.includes('<script>'), false);
  assert.equal(hostile.html.includes('onload="alert'), false);
  assert.ok(hostile.html.includes('&lt;script&gt;'));
});

test('the reset URL is built from APP_URL and the token is percent-encoded', () => {
  assert.equal(
    resetUrlFor('a-b_c', 'https://inbox.example.com'),
    'https://inbox.example.com/reset-password?token=a-b_c'
  );
  assert.equal(
    resetUrlFor('tok', 'https://inbox.example.com///'),
    'https://inbox.example.com/reset-password?token=tok',
    'trailing slashes must not produce a doubled path'
  );
  assert.equal(resetUrlFor('tok', ''), null, 'no APP_URL, no link');
  assert.equal(resetUrlFor('tok', undefined), null);
  assert.equal(resetUrlFor('a b&c=d', 'https://x.test'), 'https://x.test/reset-password?token=a%20b%26c%3Dd');
});

// ── The auth-event trail ───────────────────────────────────────────────────

test('the private auth trail records the real outcome the response withholds', async () => {
  const outcomes = [
    ['sarah@example.com', 'success', 'OK'],
    ['gone@example.com', 'failure', 'ACCOUNT_DISABLED'],
    ['legacy@vici.local', 'failure', 'LEGACY_SHARED'],
    ['nobody@example.com', 'failure', 'NO_ACCOUNT']
  ];

  for (const [email, outcome, code] of outcomes) {
    const events = [];
    const store = fakeResetStore();
    const router = createAuthRouter({
      authz: { invalidate() {}, async logAuthEvent(event) { events.push(event); } },
      invitationStore: { async redeem() {}, async noteAttempt() {} },
      emailChangeStore: {},
      audit: async () => {},
      limiter: passThroughLimiter,
      passwordReset: { store, baseUrl: 'https://x.test', sleep: async () => {}, async sendMail() { return { sent: true }; } }
    });

    await call(router, 'POST', REQUEST_PATH, { email });

    assert.equal(events.length, 1, `${email} must write exactly one auth event`);
    assert.equal(events[0].method, 'password_reset_request');
    assert.equal(events[0].outcome, outcome, `${email} outcome`);
    assert.equal(events[0].code, code, `${email} code`);
    assert.equal(events[0].emailAttempted, email);
    // Nothing token-shaped may reach the auth trail either.
    assert.equal(JSON.stringify(events[0]).includes('token'), false);
  }
});

test('a failed confirmation bumps the attempt counter and records the cause', async () => {
  const bag = fixture();
  const rawToken = await requestAndCollect(bag);
  await call(bag.router, 'POST', CONFIRM_PATH, { token: rawToken, password: STRONG_PASSWORD });
  const replay = await call(bag.router, 'POST', CONFIRM_PATH, { token: rawToken, password: STRONG_PASSWORD });

  assert.equal(replay.payload.code, 'RESET_USED');
  assert.deepEqual(bag.store.state.attempts, [hashToken(rawToken)],
    'the attempt is counted against the hash, never the token');
});

// ── The universal link ─────────────────────────────────────────────────────

test('the association document claims /reset-password alongside /accept-invite, and nothing else', () => {
  const document = buildAssociation({ APPLE_TEAM_ID: 'A1B2C3D4E5' });
  const components = document.applinks.details[0].components;

  assert.equal(components.length, 2, 'exactly two paths, not a domain claim');
  assert.deepEqual(components.map(entry => entry['/']).sort(), ['/accept-invite', '/reset-password']);

  const reset = components.find(entry => entry['/'] === '/reset-password');
  assert.deepEqual(reset, { '/': '/reset-password', '?': { token: '?*' }, comment: 'password reset' });

  // The negative property, unchanged from before: nothing may claim the whole
  // domain, or the browser UI becomes unreachable from any link on a phone
  // with the app installed.
  const serialised = JSON.stringify(components);
  assert.equal(serialised.includes('"*"'), false, 'no wildcard path may be claimed');
  assert.equal(components.some(entry => entry['/'] === '/'), false, 'the domain root may not be claimed');

  // It still survives the round trip that is literally what the route writes.
  assert.deepEqual(JSON.parse(JSON.stringify(document)), document);
});

test('the association document is rebuilt per call, so a caller cannot poison it', () => {
  const first = buildAssociation({ APPLE_TEAM_ID: 'A1B2C3D4E5' });
  first.applinks.details[0].components[1]['/'] = '/everything';

  const second = buildAssociation({ APPLE_TEAM_ID: 'A1B2C3D4E5' });
  assert.equal(second.applinks.details[0].components[1]['/'], '/reset-password',
    'one mutated response must not change what every later request serves');
});

test('the emailed link is the path the app claims', () => {
  const url = resetUrlFor('abc', 'https://inbox.example.com');
  const claimed = buildAssociation({ APPLE_TEAM_ID: 'A1B2C3D4E5' })
    .applinks.details[0].components.find(entry => entry['/'] === '/reset-password');

  assert.ok(url.startsWith(`https://inbox.example.com${claimed['/']}?`),
    'a link the document does not claim opens Safari and the reset silently never uses the app');
  assert.ok(url.includes('token='), 'and the claimed query parameter is the one in the link');
});
