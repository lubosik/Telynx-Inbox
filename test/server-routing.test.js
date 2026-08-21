'use strict';
/**
 * The only test in this suite that mounts a real Express app.
 *
 * That gap is why the RBAC bypass survived 244 green tests: every other test
 * fabricates a `req` object and calls the middleware directly, so the
 * interaction between Express's mount matching (case-INSENSITIVE by default)
 * and our own path handling was invisible. The bug lived exactly there.
 *
 * This mounts the same three pieces server.js mounts, in the same order, and
 * fires real HTTP requests at them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { collapseDuplicateSlashes, rejectMiscasedApiPaths } = require('../lib/request-normalise');
const { createPolicyEnforcer } = require('../lib/enforce-policy');

const AGENT = {
  id: '9', role: 'agent', displayName: 'Support Agent',
  permissions: new Set(['conversation.read']), mustChangePassword: false
};

/** A faithful miniature of server.js's ordering. */
function buildApp({ actor = AGENT } = {}) {
  const app = express();
  app.set('case sensitive routing', true);
  app.use(collapseDuplicateSlashes);
  app.use(rejectMiscasedApiPaths);

  // Public webhook, mounted BEFORE the gate — as in server.js.
  app.post('/webhook/telnyx', (_req, res) => res.json({ webhook: 'ok' }));

  app.use('/api', (req, _res, next) => { req.actor = actor; next(); }, createPolicyEnforcer());

  // Echoes the query so the slash-collapse test can inspect it. Must be a path
  // that genuinely exists in lib/route-policy.js — an invented one is correctly
  // refused with POLICY_MISSING, which would make the test pass for the wrong
  // reason or fail for an unrelated one.
  app.get('/api/conversations', (req, res) => res.json({ allowed: true, query: req.query }));
  app.get('/api/users', (_req, res) => res.json({ users: ['SECRET TEAM LIST'] }));

  app.get('/{*splat}', (_req, res) => res.status(200).send('SPA_INDEX_HTML'));
  return app;
}

async function request(app, path, method = 'GET') {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method });
    return { status: res.status, body: await res.text() };
  } finally {
    server.close();
  }
}

test('no casing or slash variant reaches an admin handler', async () => {
  const app = buildApp();
  const variants = [
    '/api/users', '/API/users', '/ApI/users', '/api/USERS', '/Api/Users',
    '//api/users', '/api//users', '///api///users', '/api/./users'
  ];
  for (const path of variants) {
    const { status, body } = await request(app, path);
    assert.ok(!body.includes('SECRET TEAM LIST'), `${path} leaked the team list`);
    assert.ok(status === 403 || status === 404, `${path} answered ${status}`);
  }
});

test('a miscased API path answers JSON, never the SPA shell', async () => {
  // Returning index.html with HTTP 200 hands a client asking for JSON a web
  // page and tells it the request succeeded.
  for (const path of ['/API/users', '/Api/Conversations']) {
    const { status, body } = await request(buildApp(), path);
    assert.equal(status, 404, path);
    assert.equal(JSON.parse(body).code, 'NOT_FOUND');
  }
});

test('a permitted endpoint still works, in every equivalent spelling', async () => {
  const app = buildApp();
  for (const path of ['/api/conversations', '//api/conversations', '/api/./conversations']) {
    const { status, body } = await request(app, path);
    assert.equal(status, 200, path);
    assert.equal(JSON.parse(body).allowed, true);
  }
});

test('slash collapsing does not corrupt the query string', async () => {
  const { body } = await request(buildApp(), '//api/conversations?next=https://example.com/x');
  assert.equal(JSON.parse(body).query.next, 'https://example.com/x');
});

test('a malformed percent-escape is a client error, not a 500 from the gate', async () => {
  // decodeURIComponent throws URIError on `%zz`; if the policy matcher does not
  // guard it, the security middleware itself returns 500 with a stack trace.
  for (const path of ['/api/conversations/%zz', '/api/conversations/%']) {
    const { status } = await request(buildApp(), path);
    assert.ok(status < 500, `${path} answered ${status} — the gate must never 500`);
  }
});

test('public webhooks and the SPA are untouched by the gate', async () => {
  const app = buildApp();
  const webhook = await request(app, '/webhook/telnyx', 'POST');
  assert.equal(webhook.status, 200, 'inbound SMS must keep working');
  assert.equal(JSON.parse(webhook.body).webhook, 'ok');

  for (const path of ['/', '/index.html', '/apixyz']) {
    const { status, body } = await request(app, path);
    assert.equal(status, 200, path);
    assert.equal(body, 'SPA_INDEX_HTML', `${path} must still reach the SPA`);
  }
});
