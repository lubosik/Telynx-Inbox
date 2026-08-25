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

// Reasoning moved off the device on 24 Aug 2026, so "no model endpoint" stopped
// being the invariant worth protecting. What replaced it is narrower and more
// important: the assistant may reason and may prepare drafts, and it may not
// send. These assert that, plus that reasoning goes through the ONE privacy
// boundary rather than a second client someone added later.
test('assistant reasoning goes through the private OpenRouter boundary, never a raw provider call', () => {
  const source = fs.readFileSync(path.join(ROOT, 'routes', 'assistant.js'), 'utf8');
  const converse = fs.readFileSync(path.join(ROOT, 'lib', 'assistant', 'converse.js'), 'utf8');
  assert.match(source, /router\.get\('\/status'/);
  assert.match(converse, /require\('\.\.\/openrouter-private'\)/);
  // A direct call to a provider would bypass tokenisation, the approved-model
  // list, and the Zero Data Retention requirement all at once.
  for (const raw of [/api\.openai\.com/, /api\.anthropic\.com/, /generativelanguage\.googleapis/]) {
    assert.doesNotMatch(converse, raw, 'reasoning must not call a provider directly');
    assert.doesNotMatch(source, raw);
  }
});

test('THE ASSISTANT STILL CANNOT SEND. It can only ask for a face.', () => {
  // THIS TEST USED TO ASSERT ABSENCE. It asserted no tool was named send,
  // launch, approve or schedule, on the reasoning that a tool which does not
  // exist cannot be reached by a mistaken permission grant. That was the right
  // shape while nothing had ever been sent.
  //
  // The reorder check-in is the revenue activity, so the capability now
  // exists. Absence has been replaced with a weaker but still real property,
  // and the point of this test is that the replacement is real:
  //
  //   the assistant may PREPARE a send and may not PERFORM one.
  //
  // What follows is the whole of that guarantee, checked mechanically.
  // Comments are stripped before scanning. Both files EXPLAIN at length that
  // they do not touch Telnyx or the approve route, and an unstripped scan
  // fails on the explanation, which would teach the next person to describe
  // the safety property less clearly in order to keep the test green.
  const codeOnly = (file) => fs.readFileSync(path.join(ROOT, 'lib', 'assistant', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
  const tools = codeOnly('tools.js');
  const request = codeOnly('send-request.js');

  // 1. Neither file may name a transport or a commit. This is the line that
  //    matters: a send tool that called finalizeApproval would have all the
  //    same names as the safe one and none of the safety.
  for (const forbidden of [
    /sendSMS\s*\(/, /sendMMS\s*\(/, /telnyx/i, /\.launch\s*\(/,
    /finalizeApproval/, /deliverBatch/, /\.approve\s*\(/, /\.schedule\s*\(/
  ]) {
    assert.doesNotMatch(tools, forbidden, 'tools.js must not reach the delivery path');
    assert.doesNotMatch(request, forbidden, 'send-request.js must not reach the delivery path');
  }

  // 2. No tool may be kind 'execute'. Reads look, prepares write drafts,
  //    requests ask a person. Nothing acts.
  const { buildTools } = require('../lib/assistant/tools');
  const stub = new Proxy({}, { get: () => async () => ({}) });
  const built = buildTools({ segments: stub, campaigns: stub, proposals: stub, referrals: stub, analytics: stub });
  for (const tool of built) {
    assert.notEqual(tool.kind, 'execute', `${tool.name} must not be an executing tool`);
  }

  // 3. Exactly one tool concerns sending, and it says so in its own
  //    description, because the description is what the model reasons from. A
  //    send tool that described itself as sending would be one confused turn
  //    away from the model announcing that a campaign had gone out.
  const senders = built.filter(tool => tool.kind === 'request');
  assert.equal(senders.length, 1);
  assert.equal(senders[0].name, 'request_campaign_send');
  assert.match(senders[0].description, /does NOT send/);
  assert.match(senders[0].description, /Face ID/);
});

test('every assistant tool names a permission, and prepare tools cost campaigns.manage', () => {
  const { buildTools } = require('../lib/assistant/tools');
  const stub = new Proxy({}, { get: () => async () => ({}) });
  const tools = buildTools({
    segments: stub, campaigns: stub, proposals: stub, referrals: stub, analytics: stub
  });
  assert.ok(tools.length > 0);
  for (const tool of tools) {
    assert.ok(typeof tool.permission === 'string' && tool.permission.includes('.'),
      `${tool.name} must name the permission its equivalent route requires`);
    assert.ok(['read', 'prepare', 'request'].includes(tool.kind), `${tool.name} has an unknown kind`);
    // 'execute' is deliberately not a valid kind in this build.
    if (tool.kind === 'prepare') {
      assert.equal(tool.permission, 'campaigns.manage',
        `${tool.name} writes, so it must cost the same permission the write route costs`);
    }
    // A request tool costs what the route it is asking somebody to perform
    // costs. Pricing it lower would let a role that cannot launch a campaign
    // put a launch prompt in front of somebody who can.
    if (tool.kind === 'request') {
      assert.equal(tool.permission, 'campaigns.launch',
        `${tool.name} asks for a send, so it must cost what the send route costs`);
    }
  }
});

test('a tool the actor cannot use is never shown to the model', () => {
  const { buildTools, permittedTools } = require('../lib/assistant/tools');
  const stub = new Proxy({}, { get: () => async () => ({}) });
  const tools = buildTools({ segments: stub, campaigns: stub, proposals: stub, referrals: stub, analytics: stub });

  // A Support Agent holds campaigns.read but not campaigns.manage.
  const agent = { id: 8, permissions: new Set(['campaigns.read', 'referral.read']) };
  const visible = permittedTools(tools, agent).map(tool => tool.name);
  const writeTools = tools.filter(tool => tool.kind === 'prepare').map(tool => tool.name);
  for (const name of writeTools) {
    assert.ok(!visible.includes(name),
      `${name} must not be offered to an actor who cannot perform it`);
  }
  assert.ok(visible.length > 0, 'a read-only actor still gets the read tools');

  // And an actor with nothing gets nothing, rather than a default set.
  assert.deepEqual(permittedTools(tools, { id: 9, permissions: new Set() }), []);
});

test('EVERY TOOL CALLS A METHOD THAT EXISTS ON THE SERVICE IT IS GIVEN', () => {
  // The bug this exists to prevent, which shipped and the owner hit:
  // draft_campaign called proposals.draft() and list_opportunities called
  // proposals.opportunities(). Neither exists. The proposal service exposes
  // accept, dismiss, get, list, saveBatch and resolveSegmentRecipients. Both
  // tools threw at runtime, were caught by the loop's try/catch, and came back
  // to the operator as "that lookup did not succeed" with no hint that the
  // method was imaginary.
  //
  // A stub that answers to everything, like the Proxy used elsewhere in these
  // tests, hides exactly this. So the stub here answers only to the methods the
  // real services actually have, and any call outside that set throws.
  const { buildTools } = require('../lib/assistant/tools');

  const REAL = {
    // Read STATICALLY from the service's own export block rather than by
    // constructing one. Constructing needs a database client, and a stub that
    // is close-but-not-identical makes this guard fail intermittently for
    // reasons that have nothing to do with what it is guarding. Parsing the
    // source keeps it tracking the real surface with no runtime dependency.
    segments: exportedMethodNames('lib/campaigns/segment-service.js'),
    proposals: ['accept', 'dismiss', 'get', 'list', 'saveBatch', 'resolveSegmentRecipients', 'draftProposals'],
    opportunities: ['current', 'read'],
    campaigns: ['list', 'detail', 'performance', 'reviewCount', 'create', 'edit', 'recipients'],
    referrals: ['list'],
    // Constructed rather than parsed. This factory needs no client until a
    // method is called, so building one with a stub is cheap and exact, and the
    // file's many data-shaping `return {` blocks defeat a text parser anyway.
    //
    // Hardcoding this list is what let get_revenue ship calling
    // analytics.overview() on a module that has no overview: the guess in the
    // test agreed with the guess in the tool, so both were wrong together.
    analytics: Object.keys(
      require('../lib/analytics/aggregate').createAnalyticsService({ client: { from: () => ({}) } })
    )
  };

  function strict(name, allowed) {
    return new Proxy({}, {
      get(_target, prop) {
        if (typeof prop !== 'string' || prop === 'then') return undefined;
        assert.ok(allowed.includes(prop),
          `a tool called ${name}.${prop}(), which does not exist. Available: ${allowed.join(', ')}`);
        return async () => ({ items: [], findings: [], refusals: [], proposals: [], segments: { items: [] } });
      }
    });
  }

  const tools = buildTools({
    segments: strict('segments', REAL.segments),
    campaigns: strict('campaigns', REAL.campaigns),
    proposals: strict('proposals', REAL.proposals),
    referrals: strict('referrals', REAL.referrals),
    analytics: strict('analytics', REAL.analytics),
    opportunities: strict('opportunities', REAL.opportunities)
  });
  assert.ok(tools.length > 0);
  return Promise.all(tools.map(async tool => {
    // Arguments shaped so required fields are present; the point is which
    // METHOD gets called, not what it returns.
    const args = {
      audienceId: '1', phone: '+10000000000', opportunityId: 'op_1',
      period: 'week', description: 'people who bought once', name: 'test', box: 'inbox'
    };
    try {
      await tool.run(args, { actor: { id: 1, permissions: new Set() } });
    } catch (error) {
      // A strict-stub violation is the failure this test is for. Anything else
      // is the tool's own logic reacting to empty data, which is fine here.
      if (/does not exist/.test(String(error?.message))) throw error;
    }
  }));
});

/**
 * The names in a service's final `return { ... }` block.
 *
 * Static on purpose: see the comment at the call site. It reads the LAST return
 * object in the file, which is the factory's public surface in every service
 * here.
 */
function exportedMethodNames(relativePath) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  const start = source.lastIndexOf('\n  return {');
  assert.ok(start > 0, `could not find the exported surface of ${relativePath}`);
  const end = source.indexOf('\n  };', start);
  assert.ok(end > start, `could not find the end of the surface of ${relativePath}`);
  const names = source.slice(start, end)
    .split('\n')
    .map(line => line.trim().replace(/[,:].*$/, '').trim())
    .filter(name => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name));
  assert.ok(names.length > 3, `parsed too few methods from ${relativePath}, the parser has drifted`);
  return names;
}
