'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const createAssistantRouter = require('../routes/assistant');
const { createPolicyEnforcer, findPolicy } = require('../lib/enforce-policy');

const ROOT = path.join(__dirname, '..');
const MIGRATION = fs.readFileSync(path.join(ROOT, 'scripts', 'rbac-migration.sql'), 'utf8');

function actor(overrides = {}) {
  return {
    id: '2',
    role: 'admin',
    displayName: 'Named Admin',
    isLegacyShared: false,
    viaLegacySession: false,
    mustChangePassword: false,
    permissions: new Set(['assistant.use']),
    ...overrides
  };
}

function request({ requestActor = actor(), env = {} } = {}) {
  const router = createAssistantRouter({ env });
  const layer = router.stack.find(item => item.route?.path === '/status');
  assert.ok(layer, 'assistant status handler is registered');
  const handler = layer.route.stack[0].handle;

  const req = {
    actor: requestActor,
    method: 'GET',
    originalUrl: '/api/assistant/status',
    url: '/status'
  };
  const headers = new Map();
  const result = { status: 200, body: null, headers };
  const res = {
    set(name, value) { headers.set(String(name).toLowerCase(), String(value)); return res; },
    status(value) { result.status = value; return res; },
    json(value) { result.body = value; return res; }
  };

  createPolicyEnforcer()(req, res, () => handler(req, res));
  return result;
}

test('assistant status is covered by assistant.use and mounted in server.js', () => {
  assert.equal(findPolicy('GET', '/api/assistant/status').permission, 'assistant.use');
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /app\.use\('\/api\/assistant',\s+requireAuth,\s+require\('\.\/routes\/assistant'\)\(\)\)/);
});

test('the exact lowercase string true is the only value that enables the pilot', () => {
  const enabled = request({ env: { ASSISTANT_ENABLED: 'true' } });
  assert.equal(enabled.status, 200);
  assert.deepEqual(enabled.body, {
    enabled: true,
    mode: 'on_device_read_only',
    minimumOSMajor: 26,
    reason: null
  });
  assert.match(enabled.headers.get('cache-control') || '', /no-store/);
  assert.match(enabled.headers.get('cache-control') || '', /private/);

  // This table kills common truthiness, case-folding and permissive-default
  // mutations. Boolean true is included because injected test env objects are
  // not constrained to process.env's string values.
  for (const value of [undefined, '', 'false', 'TRUE', 'True', '1', 'yes', true]) {
    const env = value === undefined ? {} : { ASSISTANT_ENABLED: value };
    const disabled = request({ env });
    assert.equal(disabled.status, 200, String(value));
    assert.deepEqual(disabled.body, {
      enabled: false,
      mode: 'on_device_read_only',
      minimumOSMajor: 26,
      reason: 'pilot_disabled'
    }, String(value));
  }
});

test('the status document has only capability fields and no business data', () => {
  const result = request({ env: { ASSISTANT_ENABLED: 'true' } });
  assert.deepEqual(Object.keys(result.body).sort(), [
    'enabled', 'minimumOSMajor', 'mode', 'reason'
  ]);
  const serialised = JSON.stringify(result.body);
  for (const forbidden of ['analytics', 'campaign', 'contact', 'conversation', 'message', 'referral']) {
    assert.equal(serialised.includes(forbidden), false, `status leaked ${forbidden}`);
  }
});

test('Support Agent is refused even if assistant.use is granted accidentally', () => {
  const result = request({
    requestActor: actor({ role: 'agent' }),
    env: { ASSISTANT_ENABLED: 'true' }
  });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'ASSISTANT_NAMED_ADMIN_REQUIRED');
});

test('shared and legacy sessions are refused even if assistant.use is present', () => {
  for (const requestActor of [
    actor({ role: 'legacy', isLegacyShared: true, viaLegacySession: true }),
    actor({ role: 'admin', isLegacyShared: true }),
    actor({ role: 'admin', viaLegacySession: true })
  ]) {
    const result = request({ requestActor, env: { ASSISTANT_ENABLED: 'true' } });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'ASSISTANT_NAMED_ADMIN_REQUIRED');
  }
});

test('named Owner and Admin accounts may read status when policy permission is present', () => {
  for (const role of ['owner', 'admin']) {
    const result = request({
      requestActor: actor({ role }),
      env: { ASSISTANT_ENABLED: 'true' }
    });
    assert.equal(result.status, 200, role);
    assert.equal(result.body.enabled, true, role);
  }
});

test('route policy refuses an otherwise eligible Admin without assistant.use', () => {
  const result = request({
    requestActor: actor({ permissions: new Set() }),
    env: { ASSISTANT_ENABLED: 'true' }
  });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'FORBIDDEN');
  assert.equal(result.body.permission, 'assistant.use');
});

test('RBAC grants assistant.use to Owner/Admin and excludes Agent and legacy', () => {
  assert.match(MIGRATION, /\('assistant\.use',\s+'assistant',\s+'use'/);
  assert.match(MIGRATION, /SELECT 'owner', key FROM sms_permissions/);
  assert.match(MIGRATION, /SELECT 'admin', key FROM sms_permissions WHERE key <> 'user\.manage\.owner'/);

  const legacyBlock = MIGRATION
    .split("SELECT 'legacy', key FROM sms_permissions")[1]
    .split('ON CONFLICT')[0];
  assert.match(legacyBlock, /assistant\.use/);

  const agentBlock = MIGRATION
    .split("SELECT 'agent', key FROM sms_permissions WHERE key IN (")[1]
    .split(')')[0];
  assert.doesNotMatch(agentBlock, /assistant\.use/);
});

test('assistant backend surface is read-only and contains no model or mutation endpoint', () => {
  const source = fs.readFileSync(path.join(ROOT, 'routes', 'assistant.js'), 'utf8');
  assert.match(source, /router\.get\('\/status'/);
  assert.doesNotMatch(source, /router\.(post|put|patch|delete)\s*\(/i);
  assert.doesNotMatch(source, /require\(['"](?:openrouter|foundationmodels|languagemodel)/i);
  assert.doesNotMatch(source, /\b(?:sendMessage|campaignMutation)\s*\(/i);
});
