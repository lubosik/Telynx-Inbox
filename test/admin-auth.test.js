'use strict';
/**
 * Offline tests for the two authorization defects that let an unset environment
 * variable turn a protected endpoint into a public one.
 *
 *   routes/admin.js      — `if (!password) return next();` on endpoints that
 *                          send bulk recovery SMS to real customers.
 *   routes/webhook-send.js — `if (!process.env.WEBHOOK_SECRET) return true;` on
 *                          an endpoint that sends an SMS to any number in the
 *                          request body.
 *
 * Both now deny. Neither test sends anything: `../db` is replaced in the require
 * cache before the routes load, so no Supabase client is ever constructed, and
 * the release notifier is a stub.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const databaseModulePath = require.resolve('../db');
require.cache[databaseModulePath] = {
  id: databaseModulePath,
  filename: databaseModulePath,
  loaded: true,
  exports: {
    supabase: { from() { throw new Error('no database access in tests'); } },
    verifyConnection: async () => {},
    insertSmsMessage: async () => ({ id: 1 })
  }
};

const admin = require('../routes/admin');
const webhookSend = require('../routes/webhook-send');

const { requireAdmin, releaseNotifyHandler, secretsMatch } = admin;

const SECRET_KEYS = ['ADMIN_API_TOKEN', 'INBOX_PASSWORD', 'WEBHOOK_SECRET', 'GHL_WEBHOOK_SECRET'];
const savedEnvironment = {};

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = code => { res.statusCode = code; return res; };
  res.json = payload => { res.body = payload; return res; };
  return res;
}

function makeReq({ headers = {}, body = {}, query = {} } = {}) {
  return {
    headers,
    body,
    query,
    get(name) { return headers[String(name).toLowerCase()]; }
  };
}

async function withConsole(run) {
  const lines = { log: [], warn: [], error: [] };
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => lines.log.push(args.join(' '));
  console.warn = (...args) => lines.warn.push(args.join(' '));
  console.error = (...args) => lines.error.push(args.join(' '));
  try {
    return { value: await run(), lines };
  } finally {
    Object.assign(console, original);
  }
}

test.beforeEach(() => {
  // routes/admin.js pulls in a module that calls dotenv.config(), so the real
  // .env is already in process.env by now. Take control of it explicitly.
  for (const key of SECRET_KEYS) {
    savedEnvironment[key] = process.env[key];
    delete process.env[key];
  }
});

test.afterEach(() => {
  for (const key of SECRET_KEYS) {
    if (savedEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnvironment[key];
  }
});

// ── requireAdmin ─────────────────────────────────────────────────────────────

test('denies with 503 when no admin secret is configured', async () => {
  let nextCalled = false;
  const res = makeRes();

  await withConsole(async () => requireAdmin(
    makeReq({ headers: { authorization: 'Bearer anything' } }),
    res,
    () => { nextCalled = true; }
  ));

  // The old behaviour here was next(). One renamed Railway variable and every
  // bulk-SMS endpoint would have been open, silently.
  assert.equal(nextCalled, false, 'an unconfigured secret must never grant access');
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: 'Admin API is not configured' });
});

test('denies with 503 even when the request carries no credential at all', async () => {
  let nextCalled = false;
  const res = makeRes();
  await withConsole(async () => requireAdmin(makeReq(), res, () => { nextCalled = true; }));
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 503);
});

test('an empty-string secret counts as unconfigured, not as a valid empty password', async () => {
  process.env.ADMIN_API_TOKEN = '';
  process.env.INBOX_PASSWORD = '';
  let nextCalled = false;
  const res = makeRes();

  await withConsole(async () => requireAdmin(
    makeReq({ headers: { authorization: 'Bearer ' } }), res, () => { nextCalled = true; }
  ));

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 503);
});

test('accepts the configured ADMIN_API_TOKEN and rejects anything else', () => {
  process.env.ADMIN_API_TOKEN = 'admin-token-value';

  let nextCalled = false;
  const allowed = makeRes();
  requireAdmin(
    makeReq({ headers: { authorization: 'Bearer admin-token-value' } }),
    allowed,
    () => { nextCalled = true; }
  );
  assert.equal(nextCalled, true);
  assert.equal(allowed.body, null);

  for (const wrong of ['Bearer admin-token-valu', 'Bearer admin-token-value-extra', 'Bearer ', '']) {
    let called = false;
    const res = makeRes();
    requireAdmin(makeReq({ headers: { authorization: wrong } }), res, () => { called = true; });
    assert.equal(called, false, `must reject ${JSON.stringify(wrong)}`);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'Unauthorised' });
  }
});

test('falls back to INBOX_PASSWORD so the current deployment keeps working', () => {
  process.env.INBOX_PASSWORD = 'legacy-password';
  let nextCalled = false;
  requireAdmin(
    makeReq({ headers: { authorization: 'Bearer legacy-password' } }),
    makeRes(),
    () => { nextCalled = true; }
  );
  assert.equal(nextCalled, true);
});

test('once ADMIN_API_TOKEN is set, the inbox password stops being an admin credential', () => {
  process.env.ADMIN_API_TOKEN = 'admin-token-value';
  process.env.INBOX_PASSWORD = 'legacy-password';

  let nextCalled = false;
  const res = makeRes();
  requireAdmin(
    makeReq({ headers: { authorization: 'Bearer legacy-password' } }),
    res,
    () => { nextCalled = true; }
  );

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('a bare token without the Bearer prefix is still accepted', () => {
  process.env.ADMIN_API_TOKEN = 'admin-token-value';
  let nextCalled = false;
  requireAdmin(
    makeReq({ headers: { authorization: 'admin-token-value' } }),
    makeRes(),
    () => { nextCalled = true; }
  );
  assert.equal(nextCalled, true);
});

test('the comparison is length-safe as well as constant-time', () => {
  // crypto.timingSafeEqual throws on unequal lengths; hashing first is what
  // makes a short guess return false instead of a 500.
  assert.equal(secretsMatch('short', 'a-much-longer-secret'), false);
  assert.equal(secretsMatch('a-much-longer-secret', 'short'), false);
  assert.equal(secretsMatch('same', 'same'), true);
  assert.equal(secretsMatch('', 'same'), false);
  assert.equal(secretsMatch(undefined, 'same'), false);
  assert.equal(secretsMatch(null, 'same'), false);
  assert.equal(secretsMatch({ toString: () => 'same' }, 'same'), false);
});

// ── POST /admin/release-notify ───────────────────────────────────────────────

function stubNotifier(calls, result = {}) {
  return async params => {
    calls.push(params);
    if (params.dryRun) {
      return {
        sent: 0,
        dryRun: true,
        targeted: 1,
        apnsConfigured: true,
        targets: [{ id: 1, storage: 'compatibility', environment: 'production', user_id: '42', app_build: '20', device_token_suffix: 'aaaaaaaa' }],
        ...result
      };
    }
    return { sent: 1, targeted: 1, targets: [], ...result };
  };
}

test('a dry run returns the target list and sends nothing', async () => {
  const calls = [];
  const res = makeRes();
  const handler = releaseNotifyHandler({ sendReleaseNotification: stubNotifier(calls) });

  await withConsole(() => handler(
    makeReq({ body: { userId: '42', belowBuild: 21, title: 'Build 21', body: 'Notes', dryRun: true } }),
    res
  ));

  assert.equal(calls.length, 1);
  assert.deepEqual(
    { userId: calls[0].userId, belowBuild: calls[0].belowBuild, dryRun: calls[0].dryRun },
    { userId: '42', belowBuild: 21, dryRun: true }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dryRun, true);
  assert.equal(res.body.sent, 0);
  assert.equal(res.body.targeted, 1);
  assert.equal(res.body.targets[0].device_token_suffix, 'aaaaaaaa');
});

test('dry run is the default: an omitted flag must not send', async () => {
  const calls = [];
  const res = makeRes();
  const handler = releaseNotifyHandler({ sendReleaseNotification: stubNotifier(calls) });

  await withConsole(() => handler(makeReq({ body: { title: 'Build 21', body: 'Notes' } }), res));

  assert.equal(calls[0].dryRun, true, 'only an explicit dryRun:false may send');
  assert.equal(res.body.sent, 0);
});

test('an explicit dryRun:false is the only thing that sends', async () => {
  const calls = [];
  const res = makeRes();
  const handler = releaseNotifyHandler({ sendReleaseNotification: stubNotifier(calls) });

  await withConsole(() => handler(
    makeReq({ body: { title: 'Build 21', body: 'Notes', dryRun: false, belowBuild: '21' } }),
    res
  ));

  assert.equal(calls[0].dryRun, false);
  assert.equal(calls[0].belowBuild, 21);
  assert.equal(res.body.sent, 1);
});

test('a real send without copy is refused before anything is targeted', async () => {
  const calls = [];
  const res = makeRes();
  const handler = releaseNotifyHandler({ sendReleaseNotification: stubNotifier(calls) });

  await handler(makeReq({ body: { dryRun: false, belowBuild: 21 } }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
});

test('a malformed belowBuild is refused rather than silently ignored', async () => {
  const calls = [];
  const handler = releaseNotifyHandler({ sendReleaseNotification: stubNotifier(calls) });

  for (const belowBuild of ['21.4', 'latest', '-1', '1234567890', {}]) {
    const res = makeRes();
    await handler(makeReq({ body: { belowBuild, title: 't', body: 'b' } }), res);
    assert.equal(res.statusCode, 400, `must refuse belowBuild ${JSON.stringify(belowBuild)}`);
  }
  assert.equal(calls.length, 0);

  // An absent filter is not an error: it means "every registered device".
  const res = makeRes();
  await withConsole(() => handler(makeReq({ body: { title: 't', body: 'b' } }), res));
  assert.equal(res.statusCode, 200);
  assert.equal(calls[0].belowBuild, null);
  assert.equal(calls[0].userId, null);
});

test('a notifier failure is reported, not swallowed into a fake success', async () => {
  const res = makeRes();
  const handler = releaseNotifyHandler({
    sendReleaseNotification: async () => ({ sent: 0, error: 'statement timeout' })
  });

  await withConsole(() => handler(makeReq({ body: { title: 't', body: 'b' } }), res));

  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { error: 'statement timeout', code: 502 });
});

test('a thrown notifier becomes a structured 500 rather than an unhandled rejection', async () => {
  const res = makeRes();
  const handler = releaseNotifyHandler({
    sendReleaseNotification: async () => { throw new Error('boom'); }
  });

  await withConsole(() => handler(makeReq({ body: { title: 't', body: 'b' } }), res));

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'boom', code: 500 });
});

// ── POST /webhook/send ───────────────────────────────────────────────────────

test('webhook send refuses when no secret is configured', async () => {
  const { value, lines } = await withConsole(async () => ({
    first: webhookSend.authorize(makeReq({ headers: { 'x-webhook-secret': 'anything' } })),
    second: webhookSend.authorize(makeReq())
  }));

  // The old behaviour returned true here — an open SMS relay on the company's
  // Telnyx account, reachable by anyone who knew the path.
  assert.equal(value.first, 'unconfigured');
  assert.equal(value.second, 'unconfigured');
  assert.equal(
    lines.error.filter(line => line.includes('/webhook/send refused')).length, 1,
    'the misconfiguration notice must be said once, not once per request'
  );
});

test('webhook send accepts the secret from the header, the body or the query', () => {
  process.env.WEBHOOK_SECRET = 'live-webhook-secret';

  assert.equal(webhookSend.authorize(makeReq({ headers: { 'x-webhook-secret': 'live-webhook-secret' } })), true);
  assert.equal(webhookSend.authorize(makeReq({ body: { webhookSecret: 'live-webhook-secret' } })), true);
  assert.equal(webhookSend.authorize(makeReq({ query: { secret: 'live-webhook-secret' } })), true);
  assert.equal(webhookSend.authorize(makeReq({ query: { secret: 'wrong' } })), 'mismatch');
  assert.equal(webhookSend.authorize(makeReq()), 'mismatch');
});

test('webhook send also accepts a dedicated GHL_WEBHOOK_SECRET, so the two can be split', () => {
  process.env.WEBHOOK_SECRET = 'telnyx-v1-signing-secret';
  process.env.GHL_WEBHOOK_SECRET = 'ghl-only-secret';

  assert.equal(webhookSend.authorize(makeReq({ headers: { 'x-webhook-secret': 'ghl-only-secret' } })), true);
  // The legacy value keeps working through the deploy that introduces the split.
  assert.equal(webhookSend.authorize(makeReq({ headers: { 'x-webhook-secret': 'telnyx-v1-signing-secret' } })), true);
  assert.equal(webhookSend.authorize(makeReq({ headers: { 'x-webhook-secret': 'neither' } })), 'mismatch');
});
