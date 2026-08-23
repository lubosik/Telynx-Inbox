'use strict';
/**
 * POST /api/campaigns/copy-suggestions — the drafting aid.
 *
 * The thing being proved here is mostly negative: this endpoint returns
 * wording and does nothing else. It must not create a campaign, submit one for
 * review, approve, schedule, cancel or send, and it must sit behind
 * campaigns.manage so a Support Agent cannot reach it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const createCampaignRouter = require('../routes/campaigns');
const { ROUTE_POLICY } = require('../lib/route-policy');
const { findPolicy } = require('../lib/enforce-policy');
const { RULES } = require('../lib/campaigns/copy-rules');
const { CopyDraftError } = require('../lib/campaigns/copy-writer');

const OPT_OUT = RULES.optOut.exactSuffix;
const PATH = '/copy-suggestions';

function handler(router, method, routePath) {
  const layer = router.stack.find(entry => entry.route?.path === routePath && entry.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${routePath} exists`);
  return layer.route.stack[0].handle;
}

function response() {
  return {
    statusCode: 200, payload: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(value) { this.payload = value; return this; }
  };
}

/** A service proxy that records any campaign method the handler dares to call. */
function recordingService(touched) {
  return new Proxy({}, {
    get: (_target, name) => async (...args) => {
      touched.push(String(name));
      return { campaign: { id: 1, revision: 1 }, recipientCount: 0, args };
    }
  });
}

function routerWith(copyDrafter, touched = []) {
  return {
    router: createCampaignRouter({ service: recordingService(touched), generationService: {}, copyDrafter }),
    touched
  };
}

const DRAFT_RESULT = {
  workflowType: 'back_in_stock',
  brandName: 'Vici',
  requested: 3,
  returned: 1,
  candidates: [{ text: `Vici: your product is back in stock. ${OPT_OUT}`, septets: 62 }],
  rejected: [{ failedChecks: ['no_exclamation_marks'], reasons: ['x'], bannedTerms: [] }],
  model: 'anthropic/claude-haiku-4.5',
  copyStatus: 'human_review_required',
  reviewRequirements: ['verify_promotional_consent_scope']
};

test('the route exists and returns candidates for a human to choose from', async () => {
  const calls = [];
  const { router, touched } = routerWith(async input => { calls.push(input); return DRAFT_RESULT; });
  const res = response();
  await handler(router, 'post', PATH)(
    { body: { workflowType: 'back_in_stock', productName: 'Recovery Blend' }, actor: { id: 9 } }, res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store, private');
  assert.equal(res.payload.candidates.length, 1);
  assert.equal(res.payload.copyStatus, 'human_review_required');
  assert.deepEqual(calls, [{ workflowType: 'back_in_stock', productName: 'Recovery Blend' }]);
  assert.deepEqual(touched, [], 'the drafting route must not call any campaign service method');
});

test('drafting writes nothing: no campaign, no review, no approval, no schedule, no send', async () => {
  const { router, touched } = routerWith(async () => DRAFT_RESULT);
  await handler(router, 'post', PATH)({ body: { workflowType: 'winback' }, actor: { id: 9 } }, response());
  assert.deepEqual(touched, []);

  // And the handler body itself contains none of the state-changing calls.
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes/campaigns.js'), 'utf8');
  const start = source.indexOf("router.post('/copy-suggestions'");
  assert.ok(start > -1);
  const body = source.slice(start, source.indexOf('router.post(\'/\'', start));
  for (const forbidden of [
    'campaigns.create', 'campaigns.edit', 'campaigns.submitReview', 'campaigns.approve',
    'campaigns.schedule', 'campaigns.cancel', 'campaigns.reject', 'finalizeApproval',
    'logAudit', 'notifyCampaignReview'
  ]) {
    assert.equal(body.includes(forbidden), false, `the drafting handler calls ${forbidden}`);
  }
});

test('the endpoint is behind campaigns.manage, so Support Agents cannot reach it', () => {
  const policy = findPolicy('POST', '/api/campaigns/copy-suggestions');
  assert.ok(policy, 'the endpoint has no policy entry and would be denied as POLICY_MISSING');
  assert.equal(policy.permission, 'campaigns.manage');
  assert.notEqual(policy.permission, null);

  // The agent role's grants live in scripts/rbac-migration.sql. campaigns.manage
  // is deliberately not among them; campaigns.read is.
  const migration = fs.readFileSync(path.join(__dirname, '..', 'scripts/rbac-migration.sql'), 'utf8');
  // Anchor on the grant statement, not the first mention of 'agent' — the
  // role is declared long before its permissions are granted, and slicing from
  // the declaration reads the owner/admin block instead.
  const anchor = migration.indexOf("SELECT 'agent', key FROM sms_permissions WHERE key IN (");
  assert.ok(anchor > -1, 'the agent grant block moved');
  const block = migration.slice(anchor, migration.indexOf('ON CONFLICT', anchor));
  assert.ok(block.includes("'campaigns.read'"));
  assert.equal(block.includes("'campaigns.manage'"), false);
});

test('the literal path is not shadowed by a parameterised campaign route', () => {
  assert.equal(findPolicy('POST', '/api/campaigns/copy-suggestions').permission, 'campaigns.manage');
  assert.equal(findPolicy('POST', '/api/campaigns/copy-suggestions/').permission, 'campaigns.manage');
  assert.equal(findPolicy('POST', '//api//campaigns//copy-suggestions').permission, 'campaigns.manage');
});

test('the entry appears exactly once and is not flagged as audited', () => {
  const entries = ROUTE_POLICY.filter(entry =>
    entry.method === 'POST' && entry.path === '/api/campaigns/copy-suggestions');
  assert.equal(entries.length, 1);
  // The flag asserts "this handler writes an audit row". This one writes
  // nothing at all, so claiming it would be the decorative-flag fault that
  // test/route-policy.test.js exists to catch.
  assert.notEqual(entries[0].audit, true);
});

test('recipient and customer evidence in the body is refused', async () => {
  const drafted = [];
  const { router } = routerWith(async input => { drafted.push(input); return DRAFT_RESULT; });
  for (const body of [
    { workflowType: 'winback', recipients: [{ phone: '+15615550100' }] },
    { workflowType: 'winback', contactId: 42 },
    { workflowType: 'winback', brandName: 'Someone Else' },
    { workflowType: 'winback', validator: 'always-pass' }
  ]) {
    const res = response();
    await handler(router, 'post', PATH)({ body, actor: { id: 9 } }, res);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res.payload.code, 'CAMPAIGN_AI_COPY_INPUT_REJECTED');
  }
  assert.deepEqual(drafted, [], 'rejected bodies must never reach the drafter');
});

test('the brand is server-owned and cannot be set by the caller', async () => {
  // A caller-chosen brand would let somebody draft in another business's name
  // on this number, which is a 10DLC registration problem, not a cosmetic one.
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes/campaigns.js'), 'utf8');
  const keys = source.match(/const COPY_SUGGESTION_BODY_KEYS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(keys);
  assert.equal(keys[1].includes('brandName'), false);
});

test('the disabled flag surfaces as a clean 503 with its code', async () => {
  const { router } = routerWith(async () => {
    throw new CopyDraftError('AI campaign copy drafting is disabled.', 'CAMPAIGN_AI_COPY_DISABLED', 503);
  });
  const res = response();
  await handler(router, 'post', PATH)({ body: { workflowType: 'winback' }, actor: { id: 9 } }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.code, 'CAMPAIGN_AI_COPY_DISABLED');
  assert.ok(res.payload.error);
});

test('an unexpected failure does not leak internals to the caller', async () => {
  const { router } = routerWith(async () => { throw new Error('supabase said no at 10.0.0.4'); });
  const res = response();
  await handler(router, 'post', PATH)({ body: { workflowType: 'winback' }, actor: { id: 9 } }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.payload.code, 'CAMPAIGN_REQUEST_FAILED');
  assert.equal(res.payload.error.includes('10.0.0.4'), false);
});

test('the existing campaign lifecycle routes are untouched', () => {
  const router = createCampaignRouter({ service: new Proxy({}, { get: () => async () => ({}) }) });
  for (const [method, routePath] of [
    ['get', '/'], ['get', '/review-count'], ['post', '/generate'], ['post', '/'], ['get', '/:id'],
    ['patch', '/:id'], ['get', '/:id/recipients'], ['post', '/:id/submit-review'],
    ['get', '/:id/performance'], ['post', '/:id/reject'], ['post', '/:id/approve'],
    ['post', '/:id/schedule'], ['post', '/:id/cancel'], ['post', '/:id/dry-run']
  ]) handler(router, method, routePath);
});
