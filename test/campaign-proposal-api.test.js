'use strict';
/**
 * The campaign proposal API.
 *
 * No network, no database, no model: the service and the drafter are both
 * injected. What this file proves is the behaviour of the ROUTE, which is
 * the last thing between a stored row and somebody's screen.
 *
 * THREE THINGS IT EXISTS TO PROVE
 *   1. A stored proposal whose copy does not pass validation is withheld even
 *      from a read. The guard is applied on the way out, not only on the way
 *      in, so a bad row written by a future code path still never reaches a
 *      reviewer.
 *   2. Accepting writes an audit row BEFORE the response, and a failure to
 *      record it fails the request.
 *   3. There is no approve, schedule or send endpoint on this router, and
 *      there must never be one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const createCampaignProposalRouter = require('../routes/campaign-proposals');

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

const ACTOR = { id: 7, displayName: 'Owner' };

function proposal(overrides = {}) {
  return {
    id: 'p-1',
    opportunityId: 'one_time_buyers',
    opportunityKind: 'repeat_purchase',
    mechanism: 'plain_check_in',
    mechanismLabel: 'Plain check-in, no offer',
    segmentKey: 'one_time_buyers',
    offer: { kind: 'none' },
    copy: {
      text: 'Vici: we are here if you need anything from us. Reply STOP to opt out.',
      septets: 70, validated: true, failedChecks: [], copyRulesVersion: '2026-08-23'
    },
    status: 'proposed',
    dismissedReason: null,
    ...overrides
  };
}

test('the router exposes drafting, review and the two decisions, and nothing else', () => {
  const noop = async () => ({});
  const router = createCampaignProposalRouter({ service: new Proxy({}, { get: () => noop }) });
  const paths = router.stack.filter(entry => entry.route).map(entry => {
    const method = Object.keys(entry.route.methods).find(key => entry.route.methods[key]);
    return `${method.toUpperCase()} ${entry.route.path}`;
  }).sort();
  assert.deepEqual(paths, [
    'GET /',
    'GET /:id',
    'POST /:id/accept',
    'POST /:id/dismiss',
    'POST /draft'
  ]);
});

test('the router source contains no approve, schedule or send path', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'campaign-proposals.js'), 'utf8');
  for (const forbidden of ["'/:id/approve'", "'/:id/schedule'", "'/:id/send'", "'/:id/launch'"]) {
    assert.equal(source.includes(forbidden), false, `${forbidden} must not exist on this router`);
  }
});

// ── Drafting ────────────────────────────────────────────────────────────────

test('drafting refuses an unknown body key rather than filtering it', async () => {
  const router = createCampaignProposalRouter({
    service: {},
    proposalDrafter: async () => { throw new Error('the drafter must not run'); }
  });
  const res = response();
  await handler(router, 'post', '/draft')({ body: { recipients: ['+15550001111'] }, actor: ACTOR }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.code, 'CAMPAIGN_PROPOSALS_INPUT_REJECTED');
});

test('with no detector wired, an opportunity must be supplied and is marked client_supplied', async () => {
  const calls = [];
  const router = createCampaignProposalRouter({
    service: {},
    proposalDrafter: async input => {
      calls.push(input);
      return {
        opportunity: { id: 'o-1' }, opportunitySource: input.opportunitySource,
        schemaVersion: 'v', catalogueVersion: 'c', requested: 4, returned: 1,
        proposals: [proposal()], refused: [], model: 'test/model', reviewRequirements: []
      };
    }
  });
  const missing = response();
  await handler(router, 'post', '/draft')({ body: {}, actor: ACTOR }, missing);
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.payload.code, 'CAMPAIGN_PROPOSALS_NO_DETECTOR');

  const res = response();
  await handler(router, 'post', '/draft')({ body: { opportunity: { id: 'o-1' } }, actor: ACTOR }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls[0].opportunitySource, 'client_supplied');
  assert.equal(res.payload.opportunitySource, 'client_supplied');
});

test('with a detector wired, the opportunity is server-owned and a supplied one is refused', async () => {
  const router = createCampaignProposalRouter({
    service: {},
    opportunityReader: async id => (id === 'o-1' ? { id: 'o-1' } : null),
    proposalDrafter: async input => ({
      opportunity: { id: 'o-1' }, opportunitySource: input.opportunitySource,
      schemaVersion: 'v', catalogueVersion: 'c', requested: 1, returned: 0,
      proposals: [], refused: [], model: null, reviewRequirements: []
    })
  });
  const rejected = response();
  await handler(router, 'post', '/draft')({ body: { opportunity: { id: 'o-1' } }, actor: ACTOR }, rejected);
  assert.equal(rejected.statusCode, 400);
  assert.match(rejected.payload.error, /server-owned/);

  const missing = response();
  await handler(router, 'post', '/draft')({ body: { opportunityId: 'nope' }, actor: ACTOR }, missing);
  assert.equal(missing.statusCode, 404);

  const found = response();
  await handler(router, 'post', '/draft')({ body: { opportunityId: 'o-1' }, actor: ACTOR }, found);
  assert.equal(found.statusCode, 200);
  assert.equal(found.payload.opportunitySource, 'detector');
});

test('drafting saves nothing unless commit is true', async () => {
  const saved = [];
  const router = createCampaignProposalRouter({
    service: { saveBatch: async items => { saved.push(items); return { saved: [proposal()], skipped: [] }; } },
    proposalDrafter: async () => ({
      opportunity: { id: 'o-1' }, opportunitySource: 'client_supplied',
      schemaVersion: 'v', catalogueVersion: 'c', requested: 4, returned: 1,
      proposals: [proposal()], refused: [], model: 'm', reviewRequirements: []
    })
  });
  const dry = response();
  await handler(router, 'post', '/draft')({ body: { opportunity: { id: 'o-1' } }, actor: ACTOR }, dry);
  assert.equal(dry.payload.committed, false);
  assert.equal(saved.length, 0);

  const wet = response();
  await handler(router, 'post', '/draft')({ body: { opportunity: { id: 'o-1' }, commit: true }, actor: ACTOR }, wet);
  assert.equal(wet.payload.committed, true);
  assert.deepEqual(wet.payload.saved, ['p-1']);
  assert.equal(saved.length, 1);
});

test('a refusal reaches the reviewer as rule identity, never as rejected text', async () => {
  const router = createCampaignProposalRouter({
    service: {},
    proposalDrafter: async () => ({
      opportunity: { id: 'o-1' }, opportunitySource: 'client_supplied',
      schemaVersion: 'v', catalogueVersion: 'c', requested: 2, returned: 0,
      proposals: [],
      refused: [{
        mechanism: 'free_shipping', stage: 'copy_validator',
        failedChecks: ['no_banned_terms'], reasons: ['No banned health term.'], bannedTerms: ['cure']
      }],
      model: 'm', reviewRequirements: []
    })
  });
  const res = response();
  await handler(router, 'post', '/draft')({ body: { opportunity: { id: 'o-1' } }, actor: ACTOR }, res);
  assert.equal(res.payload.refused[0].failedChecks[0], 'no_banned_terms');
  assert.equal('text' in res.payload.refused[0], false);
  assert.equal('message' in res.payload.refused[0], false);
});

// ── Reading, and the surfacing guard ────────────────────────────────────────

test('MUTATION: a stored proposal that fails the guard is withheld from the list', async () => {
  const bad = proposal({ id: 'p-2', copy: { text: 'anything', validated: false, failedChecks: [] } });
  const router = createCampaignProposalRouter({
    service: { list: async () => ({ items: [proposal(), bad], page: 1, pageSize: 50, total: 2 }) }
  });
  const res = response();
  await handler(router, 'get', '/')({ query: {}, actor: ACTOR }, res);
  assert.deepEqual(res.payload.items.map(item => item.id), ['p-1']);
  assert.equal(res.payload.withheld, 1);
  assert.equal(JSON.stringify(res.payload).includes('p-2'), false);
});

test('MUTATION: a stored proposal that fails the guard is withheld from a direct read', async () => {
  const router = createCampaignProposalRouter({
    service: { get: async () => proposal({ copy: { text: 'x', validated: true, failedChecks: ['no_banned_terms'] } }) }
  });
  const res = response();
  await handler(router, 'get', '/:id')({ params: { id: 'p-1' }, actor: ACTOR }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, 'PROPOSAL_COPY_REJECTED');
  assert.equal('proposal' in res.payload, false, 'no proposal body is returned');
  assert.deepEqual(Object.keys(res.payload).sort(), ['code', 'error']);
});

test('a clean proposal reads back in full, with no caching', async () => {
  const router = createCampaignProposalRouter({ service: { get: async () => proposal() } });
  const res = response();
  await handler(router, 'get', '/:id')({ params: { id: 'p-1' }, actor: ACTOR }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store, private');
  assert.equal(res.payload.proposal.id, 'p-1');
});

// ── Accepting ───────────────────────────────────────────────────────────────

function acceptResult() {
  return {
    proposal: proposal({ status: 'accepted' }),
    campaign: { id: 'c-9', status: 'draft' },
    recipientCount: 2,
    segment: { id: 's-1', key: 'one_time_buyers', name: 'One-time buyers' },
    campaignStatus: 'draft',
    nextSteps: ['review_and_edit_the_message']
  };
}

test('accepting audits the decision and reports a DRAFT, never an approval', async () => {
  let audited = null;
  const router = createCampaignProposalRouter({
    service: { accept: async () => acceptResult() },
    acceptAuditWriter: async input => { audited = input; return { recorded: true, id: 1 }; }
  });
  const res = response();
  await handler(router, 'post', '/:id/accept')({ params: { id: 'p-1' }, actor: ACTOR }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.campaignStatus, 'draft');
  assert.equal(audited.eventType, 'campaign.proposal.accepted');
  assert.equal(audited.metadata.campaign_id, 'c-9');
  assert.equal(audited.metadata.mechanism, 'plain_check_in');
  assert.equal(audited.metadata.offer_kind, 'none');
  // The message body is never in an audit row. Length and digest only.
  assert.equal(typeof audited.metadata.message_digest, 'string');
  assert.equal(JSON.stringify(audited.metadata).includes('we are here'), false);
});

test('the acceptance audit event type and its metadata keys are both registered', () => {
  const { EVENT_TYPES } = require('../lib/audit/event-types');
  const { redactMetadata } = require('../lib/audit/redact');
  assert.ok(EVENT_TYPES['campaign.proposal.accepted']);
  assert.ok(EVENT_TYPES['campaign.proposal.dismissed']);
  // Registering the type is only half of it: without a METADATA_ALLOWLIST
  // entry every field is silently dropped and the row lands empty.
  const { metadata } = redactMetadata('campaign.proposal.accepted', {
    proposal_id: 'p-1', mechanism: 'plain_check_in', campaign_id: 'c-9', recipient_count: 2
  });
  assert.equal(metadata.proposal_id, 'p-1');
  assert.equal(metadata.campaign_id, 'c-9');
  const dismissal = redactMetadata('campaign.proposal.dismissed', {
    proposal_id: 'p-1', reason: 'Not worth the margin'
  }).metadata;
  assert.equal(dismissal.reason, 'Not worth the margin');
});

test('MUTATION: if the acceptance audit is not recorded, the request fails', async () => {
  const router = createCampaignProposalRouter({
    service: { accept: async () => acceptResult() },
    acceptAuditWriter: async () => ({ recorded: false, reason: 'schema_missing' })
  });
  const res = response();
  await handler(router, 'post', '/:id/accept')({ params: { id: 'p-1' }, actor: ACTOR }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.code, 'PROPOSAL_ACCEPT_AUDIT_REQUIRED');
});

test('a duplicate audit row is not a failure', async () => {
  const router = createCampaignProposalRouter({
    service: { accept: async () => acceptResult() },
    acceptAuditWriter: async () => ({ recorded: false, reason: 'duplicate' })
  });
  const res = response();
  await handler(router, 'post', '/:id/accept')({ params: { id: 'p-1' }, actor: ACTOR }, res);
  assert.equal(res.statusCode, 200);
});

test('a guard refusal from the service is reported with its own status and code', async () => {
  const { ProposalGuardError } = require('../lib/campaigns/proposal-guards');
  const router = createCampaignProposalRouter({
    service: {
      accept: async () => {
        throw new ProposalGuardError('Not open.', 'PROPOSAL_NOT_OPEN', 409);
      }
    },
    acceptAuditWriter: async () => { throw new Error('no audit may be written for a refused acceptance'); }
  });
  const res = response();
  await handler(router, 'post', '/:id/accept')({ params: { id: 'p-1' }, actor: ACTOR }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, 'PROPOSAL_NOT_OPEN');
});

// ── Dismissing ──────────────────────────────────────────────────────────────

test('dismissing records the reason on the audit row', async () => {
  let audited = null;
  const router = createCampaignProposalRouter({
    service: {
      dismiss: async (id, reason) => proposal({ status: 'dismissed', dismissedReason: reason })
    },
    dismissAuditWriter: async input => { audited = input; return { recorded: true }; }
  });
  const res = response();
  await handler(router, 'post', '/:id/dismiss')({
    params: { id: 'p-1' }, body: { reason: 'Discounting trains this cohort to wait' }, actor: ACTOR
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(audited.eventType, 'campaign.proposal.dismissed');
  assert.equal(audited.metadata.reason, 'Discounting trains this cohort to wait');
});

test('an unexpected internal failure never leaks its detail to the client', async () => {
  const router = createCampaignProposalRouter({
    service: { list: async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:5432'); } }
  });
  const res = response();
  await handler(router, 'get', '/')({ query: {}, actor: ACTOR }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.payload.code, 'PROPOSAL_REQUEST_FAILED');
  assert.equal(JSON.stringify(res.payload).includes('10.0.0.1'), false);
});
