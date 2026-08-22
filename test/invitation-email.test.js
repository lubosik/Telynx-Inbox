'use strict';
/**
 * test/invitation-email.test.js — POST /api/invitations sends the email, and
 * POST /api/invitations/:id/resend sends it again.
 *
 * WHY THIS FILE EXISTS
 *   The endpoint returned a one-time link and told the admin to pass it on by
 *   hand. The product owner assumed an email went out, so for a while the
 *   product's behaviour and its owner's understanding of it disagreed, and the
 *   symptom would have been invitees who never heard anything.
 *
 * THE TWO PROPERTIES THAT MATTER
 *   1. THE INVITATION SURVIVES A MAIL FAILURE. The token is displayed exactly
 *      once and is not recoverable, so an email failure that rolled the request
 *      back would destroy a working credential nobody had seen. Every failure
 *      mode below asserts a 201, an intact invitation, and a usable link.
 *   2. THE RESPONSE NEVER LIES. `emailSent` is the flag a UI uses to choose
 *      between "we emailed them" and "copy this link and send it yourself".
 *      Reporting an optimistic `true` is worse than reporting `false`, because
 *      the admin then does nothing and the invitee is never contacted. There is
 *      a test for each reason a send can fail, and each one asserts
 *      `emailSent: false` with a reason that names the cause.
 *
 * Offline: the stores are fakes and the mail sender is injected. Nothing here
 * reaches Maton, Gmail, Supabase or the network.
 */

process.env.SUPABASE_URL ||= 'https://unit-test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'unit-test-service-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const createInvitationsRouter = require('../routes/invitations');
const { hashToken } = require('../routes/invitations');

// ── Fixtures ───────────────────────────────────────────────────────────────

const ROLE_CATALOGUE = Object.freeze([
  { key: 'owner', display_name: 'Owner', rank: 30, is_assignable: true },
  { key: 'admin', display_name: 'Admin', rank: 20, is_assignable: true },
  { key: 'agent', display_name: 'Support Agent', rank: 10, is_assignable: true }
]);

const APP_URL = 'https://inbox.example.com';
const NOW = Date.parse('2026-08-22T09:00:00.000Z');
const INVITATION_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

const ADMIN = {
  id: 7, displayName: 'Dominic', role: 'admin', permissions: new Set(['user.manage'])
};

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

function makeRequest({ params = {}, body = {}, actor = ADMIN } = {}) {
  return {
    params,
    body,
    actor,
    ip: '203.0.113.9',
    get: name => (name === 'user-agent' ? 'ViciInbox/1.4 (iPhone)' : null)
  };
}

/** An invitation store with real-enough behaviour and no database. */
function makeInvitationStore({ seed = [] } = {}) {
  const state = { invitations: [...seed], writes: [] };
  return {
    state,
    async list() { return state.invitations; },
    async getById(id) { return state.invitations.find(row => row.id === id) || null; },
    async findOpenByEmail() { return null; },
    async matchesToken(id, tokenHash) {
      const row = state.invitations.find(entry => entry.id === id);
      return Boolean(row) && row.token_hash === tokenHash;
    },
    async create(row) {
      const created = { id: INVITATION_ID, invited_at: new Date(NOW).toISOString(), ...row };
      state.invitations.push(created);
      state.writes.push({ op: 'create', row: created });
      return created;
    },
    async revoke(id) {
      const row = state.invitations.find(entry => entry.id === id);
      row.revoked_at = new Date(NOW).toISOString();
      state.writes.push({ op: 'revoke', id });
      return row;
    }
  };
}

function makeUserStore() {
  return {
    async findByEmail() { return null; },
    async listRoles() { return ROLE_CATALOGUE.map(role => ({ ...role })); }
  };
}

/** A mail sender that records what it was asked to send and answers to order. */
function recordingMailer(outcome = { sent: true, id: 'msg_1' }) {
  const sent = [];
  const impl = async message => {
    sent.push(message);
    return typeof outcome === 'function' ? outcome(message) : outcome;
  };
  impl.sent = sent;
  return impl;
}

function fixture({ mailer = recordingMailer(), seed = [], emailConfigured = () => true } = {}) {
  const auditRows = [];
  const store = makeInvitationStore({ seed });
  const router = createInvitationsRouter({
    store,
    userStore: makeUserStore(),
    now: () => NOW,
    // `req` is dropped deliberately. It is a handler argument, not row content:
    // lib/audit/log.js reads only the IP, user-agent and request id off it and
    // never serialises it. Keeping it here would put `req.body.token` into what
    // these tests inspect and fail the "nothing token-shaped" assertion for a
    // reason that has nothing to do with the audit trail. The real writer, and
    // therefore the real row shape, is exercised in test/audit-team.test.js.
    audit: async ({ req, ...row }) => { auditRows.push(row); },
    sendMail: mailer,
    emailConfigured
  });
  return { store, router, auditRows, mailer };
}

async function call(router, method, routePath, request) {
  const res = responseRecorder();
  await handlerFor(router, method, routePath)(request, res);
  return res;
}

function invite(router, body = { email: 'sarah@example.com', displayName: 'Sarah Chen', role: 'agent' }) {
  return call(router, 'POST', '/', makeRequest({ body }));
}

/** An open invitation whose raw token the test knows. */
function openInvitation(rawToken = 'known-raw-token-abc123') {
  return {
    row: {
      id: INVITATION_ID,
      email: 'sarah@example.com',
      display_name: 'Sarah Chen',
      role_key: 'agent',
      token_hash: hashToken(rawToken),
      token_prefix: hashToken(rawToken).slice(0, 8),
      invited_at: new Date(NOW).toISOString(),
      expires_at: new Date(NOW + 86400000).toISOString(),
      accepted_at: null,
      revoked_at: null
    },
    rawToken
  };
}

// ── The happy path ─────────────────────────────────────────────────────────

test('creating an invitation sends the email and says so', async () => {
  process.env.APP_URL = APP_URL;
  const { router, mailer } = fixture();

  const res = await invite(router);

  assert.equal(res.statusCode, 201);
  assert.equal(res.payload.emailSent, true);
  assert.equal(res.payload.emailReason, null);
  assert.equal(mailer.sent.length, 1, 'exactly one email per invitation');

  const [message] = mailer.sent;
  assert.equal(message.to, 'sarah@example.com');
  assert.ok(message.subject.includes('Dominic'), 'the subject names the inviter');
  assert.ok(message.text, 'a plain-text part is always sent');
  assert.ok(message.html, 'an HTML part is always sent');
});

test('the emailed link is exactly the accept URL returned to the admin', async () => {
  process.env.APP_URL = APP_URL;
  const { router, mailer } = fixture();

  const res = await invite(router);
  const expected = `${APP_URL}/accept-invite?token=${encodeURIComponent(res.payload.token)}`;

  assert.equal(res.payload.acceptUrl, expected);
  assert.ok(mailer.sent[0].text.includes(expected), 'the text part must carry the accept URL');
  assert.ok(mailer.sent[0].html.includes(expected), 'the HTML part must carry the accept URL');
});

test('the email names the role in human words, not as the database key', async () => {
  process.env.APP_URL = APP_URL;
  const { router, mailer } = fixture();

  await invite(router);

  assert.ok(mailer.sent[0].text.includes('Support Agent'));
  assert.ok(mailer.sent[0].html.includes('Support Agent'));
});

test('the link is returned even on the happy path, so the admin can always fall back', async () => {
  process.env.APP_URL = APP_URL;
  const { router } = fixture();

  const res = await invite(router);

  assert.ok(res.payload.token, 'the one-time token is always returned');
  assert.ok(res.payload.acceptUrl, 'the accept URL is always returned');
});

// ── A mail failure must not cost the invitation ────────────────────────────

test('a provider failure still creates the invitation and reports emailSent false', async () => {
  process.env.APP_URL = APP_URL;
  const mailer = recordingMailer({ sent: false, reason: 'provider_error', status: 500 });
  const { router, store, auditRows } = fixture({ mailer });

  const res = await invite(router);

  assert.equal(res.statusCode, 201, 'a mail failure must not fail the request');
  assert.equal(store.state.invitations.length, 1, 'the invitation row still exists');
  assert.equal(res.payload.emailSent, false);
  assert.equal(res.payload.emailReason, 'provider_error');
  assert.ok(res.payload.token, 'the link must still be returned so it can be sent by hand');
  assert.ok(res.payload.acceptUrl);
  assert.match(res.payload.note, /No email was sent/i);
  assert.equal(
    auditRows.filter(row => row.eventType === 'team.member.invited').length, 1,
    'the invitation itself is still audited'
  );
});

test('every failure reason is passed through verbatim rather than flattened', async () => {
  process.env.APP_URL = APP_URL;
  for (const reason of ['not_configured', 'provider_error', 'timeout', 'network_error', 'invalid_message']) {
    const { router } = fixture({ mailer: recordingMailer({ sent: false, reason }) });
    const res = await invite(router);
    assert.equal(res.statusCode, 201);
    assert.equal(res.payload.emailSent, false);
    assert.equal(res.payload.emailReason, reason, `the reason "${reason}" must reach the caller`);
  }
});

test('with no mail provider configured the invitation still works and admits nothing was sent', async () => {
  // The state this ships in: MATON_API_KEY is not set in Railway yet.
  process.env.APP_URL = APP_URL;
  const { router } = fixture({ mailer: recordingMailer({ sent: false, reason: 'not_configured' }) });

  const res = await invite(router);

  assert.equal(res.statusCode, 201);
  assert.equal(res.payload.emailSent, false);
  assert.equal(res.payload.emailReason, 'not_configured');
  assert.ok(res.payload.acceptUrl);
});

test('with APP_URL unset no email is attempted, because there would be no link in it', async () => {
  delete process.env.APP_URL;
  const { router, mailer } = fixture();

  const res = await invite(router);

  assert.equal(res.statusCode, 201);
  assert.equal(mailer.sent.length, 0, 'an invitation with no accept link must not be sent');
  assert.equal(res.payload.emailSent, false);
  assert.equal(res.payload.emailReason, 'no_app_url');
  assert.equal(res.payload.acceptUrl, null);
  assert.ok(res.payload.token, 'the token is still returned so the admin has something to work with');
  process.env.APP_URL = APP_URL;
});

test('the response never claims a send that did not happen', async () => {
  process.env.APP_URL = APP_URL;
  const outcomes = [
    [{ sent: true, id: 'x' }, true],
    [{ sent: false, reason: 'provider_error' }, false],
    // A malformed answer from the mail layer must read as "not sent", never as
    // truthy-therefore-sent.
    [{}, false],
    [{ sent: 'yes' }, false]
  ];

  for (const [outcome, expected] of outcomes) {
    const { router } = fixture({ mailer: recordingMailer(outcome) });
    const res = await invite(router);
    assert.equal(res.payload.emailSent, expected, `outcome ${JSON.stringify(outcome)}`);
    assert.equal(typeof res.payload.emailSent, 'boolean', 'emailSent must be a strict boolean');
    if (expected) assert.match(res.payload.note, /email was sent/i);
    else assert.match(res.payload.note, /No email was sent/i);
  }
});

test('the invitation is created BEFORE the email is attempted', async () => {
  process.env.APP_URL = APP_URL;
  const order = [];
  const store = makeInvitationStore();
  const originalCreate = store.create;
  store.create = async row => { order.push('create'); return originalCreate(row); };

  const router = createInvitationsRouter({
    store,
    userStore: makeUserStore(),
    now: () => NOW,
    audit: async () => { order.push('audit'); },
    sendMail: async () => { order.push('email'); return { sent: true }; },
    emailConfigured: () => true
  });

  await invite(router);

  assert.deepEqual(order, ['create', 'audit', 'email'],
    'the row and its audit must exist before a mail is attempted');
});

test('a mail sender that throws cannot take the invitation down with it', async () => {
  // lib/email.js promises never to reject. This asserts the route does not
  // depend on that promise being kept by a future edit.
  process.env.APP_URL = APP_URL;
  const { router, store } = fixture({
    mailer: async () => { throw new Error('provider exploded'); }
  });

  const res = await invite(router);

  assert.equal(store.state.invitations.length, 1, 'the invitation must survive');
  assert.notEqual(res.payload?.emailSent, true, 'a throwing sender must never report success');
});

// ── Resend ─────────────────────────────────────────────────────────────────

test('a resend mails the same link again without minting a token or moving the expiry', async () => {
  process.env.APP_URL = APP_URL;
  const { row, rawToken } = openInvitation();
  const { router, store, mailer, auditRows } = fixture({ seed: [row] });
  const before = JSON.parse(JSON.stringify(row));

  const res = await call(router, 'POST', '/:id/resend', makeRequest({
    params: { id: INVITATION_ID }, body: { token: rawToken }
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.emailSent, true);
  assert.equal(res.payload.expiresAt, before.expires_at);

  // The row is untouched: same token hash, same expiry, and no write issued.
  assert.deepEqual(store.state.invitations[0], before, 'a resend must not modify the invitation');
  assert.deepEqual(store.state.writes, [], 'a resend must issue no database write at all');

  assert.equal(mailer.sent.length, 1);
  assert.ok(
    mailer.sent[0].text.includes(`${APP_URL}/accept-invite?token=${encodeURIComponent(rawToken)}`),
    'the original link must be the one re-sent'
  );
  assert.equal(auditRows.length, 1, 'a resend is audited');
  assert.equal(auditRows[0].eventType, 'team.member.invited');
  assert.match(auditRows[0].summary, /re-sent/i);
});

test('a resend reads as a reminder rather than as a brand-new invitation', async () => {
  process.env.APP_URL = APP_URL;
  const { row, rawToken } = openInvitation();
  const { router, mailer } = fixture({ seed: [row] });

  await call(router, 'POST', '/:id/resend', makeRequest({
    params: { id: INVITATION_ID }, body: { token: rawToken }
  }));

  assert.match(mailer.sent[0].subject, /reminder/i);
});

test('a resend with no token refuses rather than issuing a new credential', async () => {
  // Only sha256(token) is stored, so the server genuinely cannot rebuild the
  // link. Minting a fresh token would invalidate a link the admin may already
  // have sent, which is exactly what a resend must not do.
  process.env.APP_URL = APP_URL;
  const { row } = openInvitation();
  const { router, store, mailer, auditRows } = fixture({ seed: [row] });
  const before = JSON.parse(JSON.stringify(row));

  const res = await call(router, 'POST', '/:id/resend', makeRequest({ params: { id: INVITATION_ID } }));

  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, 'TOKEN_NOT_RECOVERABLE');
  assert.match(res.payload.error, /hash/i, 'the message must explain why, not just refuse');
  assert.deepEqual(store.state.invitations[0], before);
  assert.equal(mailer.sent.length, 0);
  assert.deepEqual(auditRows, [], 'a refused resend writes no audit row');
});

test('a resend with the wrong token is refused and mails nothing', async () => {
  process.env.APP_URL = APP_URL;
  const { row } = openInvitation();
  const { router, mailer, auditRows } = fixture({ seed: [row] });

  const res = await call(router, 'POST', '/:id/resend', makeRequest({
    params: { id: INVITATION_ID }, body: { token: 'a-different-token' }
  }));

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.code, 'TOKEN_MISMATCH');
  assert.equal(mailer.sent.length, 0);
  assert.deepEqual(auditRows, []);
});

test('an accepted, revoked or expired invitation cannot be resent', async () => {
  process.env.APP_URL = APP_URL;
  const cases = [
    [{ accepted_at: new Date(NOW).toISOString() }, 409, 'INVITATION_USED'],
    [{ revoked_at: new Date(NOW).toISOString() }, 409, 'INVITATION_REVOKED'],
    [{ expires_at: new Date(NOW - 1000).toISOString() }, 410, 'INVITATION_EXPIRED']
  ];

  for (const [patch, status, code] of cases) {
    const { row, rawToken } = openInvitation();
    const { router, mailer, auditRows } = fixture({ seed: [{ ...row, ...patch }] });

    const res = await call(router, 'POST', '/:id/resend', makeRequest({
      params: { id: INVITATION_ID }, body: { token: rawToken }
    }));

    assert.equal(res.statusCode, status, `${code}: expected ${status}, got ${res.statusCode}`);
    assert.equal(res.payload.code, code);
    assert.equal(mailer.sent.length, 0, `${code}: nothing may be mailed`);
    assert.deepEqual(auditRows, [], `${code}: nothing may be audited`);
  }
});

test('an expired invitation is refused rather than quietly given a new expiry', async () => {
  process.env.APP_URL = APP_URL;
  const { row, rawToken } = openInvitation();
  const expired = { ...row, expires_at: new Date(NOW - 1000).toISOString() };
  const { router, store } = fixture({ seed: [expired] });
  const before = JSON.parse(JSON.stringify(expired));

  await call(router, 'POST', '/:id/resend', makeRequest({
    params: { id: INVITATION_ID }, body: { token: rawToken }
  }));

  assert.equal(store.state.invitations[0].expires_at, before.expires_at,
    'a resend must never extend an expiry');
  assert.deepEqual(store.state.writes, []);
});

test('a resend with no mail provider configured says so instead of no-opping quietly', async () => {
  process.env.APP_URL = APP_URL;
  const { row, rawToken } = openInvitation();
  const { router, mailer, auditRows } = fixture({ seed: [row], emailConfigured: () => false });

  const res = await call(router, 'POST', '/:id/resend', makeRequest({
    params: { id: INVITATION_ID }, body: { token: rawToken }
  }));

  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.code, 'EMAIL_NOT_CONFIGURED');
  assert.equal(mailer.sent.length, 0);
  assert.deepEqual(auditRows, [], 'nothing was sent, so nothing is audited');
});

test('a failed resend reports the failure and writes no audit row', async () => {
  process.env.APP_URL = APP_URL;
  const { row, rawToken } = openInvitation();
  const { router, store, auditRows } = fixture({
    seed: [row],
    mailer: recordingMailer({ sent: false, reason: 'timeout' })
  });
  const before = JSON.parse(JSON.stringify(row));

  const res = await call(router, 'POST', '/:id/resend', makeRequest({
    params: { id: INVITATION_ID }, body: { token: rawToken }
  }));

  assert.equal(res.statusCode, 502);
  assert.equal(res.payload.code, 'EMAIL_SEND_FAILED');
  assert.equal(res.payload.emailSent, false);
  assert.equal(res.payload.emailReason, 'timeout');
  assert.deepEqual(auditRows, [], 'an audit row would claim a delivery that did not happen');
  assert.deepEqual(store.state.invitations[0], before, 'the invitation is still valid and unchanged');
});

test('a resend for an unknown invitation is a 404 and mails nothing', async () => {
  process.env.APP_URL = APP_URL;
  const { router, mailer } = fixture();

  const res = await call(router, 'POST', '/:id/resend', makeRequest({
    params: { id: INVITATION_ID }, body: { token: 'anything' }
  }));

  assert.equal(res.statusCode, 404);
  assert.equal(res.payload.code, 'INVITATION_NOT_FOUND');
  assert.equal(mailer.sent.length, 0);
});

test('a malformed invitation id is rejected before anything is looked up', async () => {
  process.env.APP_URL = APP_URL;
  const { router, mailer } = fixture();

  const res = await call(router, 'POST', '/:id/resend', makeRequest({
    params: { id: 'not-a-uuid' }, body: { token: 'anything' }
  }));

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.code, 'INVALID_INVITATION_ID');
  assert.equal(mailer.sent.length, 0);
});

// ── Secrets stay out of the log ────────────────────────────────────────────

test('neither creating nor resending writes the token to a log line', async () => {
  process.env.APP_URL = APP_URL;
  const lines = [];
  const levels = ['log', 'warn', 'error', 'info', 'debug'];
  const originals = {};
  for (const level of levels) {
    originals[level] = console[level];
    console[level] = (...args) => { lines.push(args.map(String).join(' ')); };
  }

  try {
    const { row, rawToken } = openInvitation(`secret-${crypto.randomBytes(8).toString('hex')}`);

    const created = fixture({ mailer: recordingMailer({ sent: false, reason: 'provider_error' }) });
    const createdRes = await invite(created.router);

    const resent = fixture({ seed: [row], mailer: recordingMailer({ sent: false, reason: 'timeout' }) });
    await call(resent.router, 'POST', '/:id/resend', makeRequest({
      params: { id: INVITATION_ID }, body: { token: rawToken }
    }));

    const log = lines.join('\n');
    assert.equal(log.includes(rawToken), false, 'the raw token reached a log line');
    assert.equal(log.includes(createdRes.payload.token), false, 'the new token reached a log line');
    assert.equal(log.includes(row.token_hash), false, 'the token hash reached a log line');
    assert.equal(log.includes(createdRes.payload.acceptUrl), false, 'the accept URL reached a log line');
  } finally {
    for (const level of levels) console[level] = originals[level];
  }
});

test('no audit row for an invitation or a resend contains anything token-shaped', async () => {
  process.env.APP_URL = APP_URL;
  const { row, rawToken } = openInvitation();

  const created = fixture();
  await invite(created.router);

  const resent = fixture({ seed: [row] });
  await call(resent.router, 'POST', '/:id/resend', makeRequest({
    params: { id: INVITATION_ID }, body: { token: rawToken }
  }));

  // The resend handler RECEIVES the raw token in its request body, so this is a
  // live risk rather than a theoretical one: anything it copies into an audit
  // row would put a working credential into an append-only table.
  const serialised = JSON.stringify([...created.auditRows, ...resent.auditRows]);
  assert.equal(serialised.includes(rawToken), false);
  assert.equal(serialised.includes(row.token_hash), false);
  assert.equal(serialised.includes(row.token_prefix), false, 'token_prefix is a prefix of the hash');
  assert.equal(/token_hash|"token"|token_prefix/.test(serialised), false);
});
