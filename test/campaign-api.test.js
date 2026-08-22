'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const createCampaignRouter = require('../routes/campaigns');
const { CampaignRequestError } = require('../lib/campaigns/service');

function handler(router, method, path) {
  const layer = router.stack.find(entry => entry.route?.path === path && entry.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} exists`);
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

test('campaign router exposes the complete review lifecycle', () => {
  const noop = async () => ({});
  const router = createCampaignRouter({ service: new Proxy({}, { get: () => noop }) });
  for (const [method, path] of [
    ['get', '/'], ['get', '/review-count'], ['post', '/generate'], ['post', '/'], ['get', '/:id'],
    ['patch', '/:id'], ['get', '/:id/recipients'], ['post', '/:id/submit-review'],
    ['get', '/:id/performance'],
    ['post', '/:id/reject'], ['post', '/:id/approve'], ['post', '/:id/schedule'],
    ['post', '/:id/cancel'], ['post', '/:id/dry-run']
  ]) handler(router, method, path);
});

test('opportunity generation accepts control inputs only and defaults to dry-run', async () => {
  const calls = [];
  const router = createCampaignRouter({
    service: {},
    generationService: {
      generate: async input => {
        calls.push(input);
        return { summary: { mode: 'authoritative_dry_run' }, notifications: [] };
      }
    }
  });
  const generate = handler(router, 'post', '/generate');
  const req = { body: { workflows: ['reorder'] }, actor: { id: 9 } };
  const res = response();
  await generate(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store, private');
  assert.deepEqual(calls, [{ workflows: ['reorder'], commit: false, actor: req.actor }]);

  const rejected = response();
  await generate({ body: { workflows: ['reorder'], recipients: [{ phone: '+15555550123' }] }, actor: req.actor }, rejected);
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.payload.code, 'CAMPAIGN_GENERATION_INPUT_REJECTED');
  assert.equal(calls.length, 1, 'client-supplied evidence must never reach the generator');
});

test('committed generation dispatches only prepared review notifications and audits aggregate counts', async () => {
  const notifications = [{ eventType: 'campaigns.ready_for_review', userID: '9' }];
  let notificationInput;
  let auditInput;
  const router = createCampaignRouter({
    service: {},
    generationService: {
      generate: async input => {
        assert.equal(input.commit, true);
        return {
          summary: {
            mode: 'drafts_persisted', generatedAt: '2026-08-22T12:00:00.000Z',
            opportunitiesPrepared: 2, draftsPrepared: 1, byWorkflow: { reorder: 1 },
            persisted: { insertedCampaigns: 1, reusedCampaigns: 0, campaigns: [] }
          },
          notifications
        };
      }
    },
    campaignNotificationSender: async (input, options) => {
      notificationInput = { input, options };
      return { sent: 0, targeted: 0, disabled: true, reason: 'feature_flag_disabled' };
    },
    generationAuditWriter: async input => { auditInput = input; return { recorded: true, id: 1 }; }
  });
  const res = response();
  await handler(router, 'post', '/generate')({ body: { workflows: ['reorder'], commit: true }, actor: { id: 9 } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(notificationInput, { input: notifications, options: { dryRun: false } });
  assert.equal(auditInput.eventType, 'campaign.drafts.generated');
  assert.deepEqual(auditInput.metadata.workflows, ['reorder']);
  assert.equal(auditInput.metadata.campaigns_inserted, 1);
  assert.equal('phone' in auditInput.metadata, false);
  assert.equal(res.payload.notification.disabled, true);
});

test('post-commit notification failure does not report draft persistence as failed', async () => {
  const router = createCampaignRouter({
    service: {},
    generationService: { generate: async () => ({
      summary: {
        mode: 'drafts_persisted', generatedAt: '2026-08-22T12:00:00.000Z',
        opportunitiesPrepared: 1, draftsPrepared: 1, byWorkflow: { winback: 1 },
        persisted: { insertedCampaigns: 1, reusedCampaigns: 0, campaigns: [] }
      },
      notifications: [{ eventType: 'campaigns.ready_for_review', userID: '9' }]
    }) },
    campaignNotificationSender: async () => { throw new Error('APNs unavailable'); },
    generationAuditWriter: async () => ({ recorded: true })
  });
  const res = response();
  await handler(router, 'post', '/generate')({ body: { commit: true }, actor: { id: 9 } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.summary.persisted.insertedCampaigns, 1);
  assert.equal(res.payload.notification.error, 'campaign_notification_dispatch_failed');
});

test('operational campaign performance is non-cacheable and contains no financial claim', async () => {
  const router = createCampaignRouter({ service: {
    performance: async id => ({
      campaign: { id }, operational: { delivered: 0 },
      availability: { operational: true, financial: false }, warnings: []
    })
  } });
  const res = response();
  await handler(router, 'get', '/:id/performance')({ params: { id: 'abc' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store, private');
  assert.equal(res.payload.availability.financial, false);
  assert.equal('revenue' in res.payload, false);
});

test('dry-run returns suppression results and is explicitly non-cacheable', async () => {
  const router = createCampaignRouter({ service: {
    dryRun: async id => ({ campaignId: id, eligible: 0, suppressed: 1 }),
    list: async () => ({}), reviewCount: async () => ({})
  } });
  const res = response();
  await handler(router, 'post', '/:id/dry-run')({ params: { id: 'abc' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store, private');
  assert.deepEqual(res.payload, { campaignId: 'abc', eligible: 0, suppressed: 1 });
});

test('campaign safety errors preserve their stable client code', async () => {
  const router = createCampaignRouter({ service: {
    schedule: async () => { throw new CampaignRequestError('Provider approval required.', 'CAMPAIGN_LIVE_SEND_DISABLED', 409); }
  } });
  const res = response();
  await handler(router, 'post', '/:id/schedule')({ params: { id: 'abc' }, body: {}, actor: {} }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, 'CAMPAIGN_LIVE_SEND_DISABLED');
});

test('an approval audit failure stays unschedulable and the identical retry can finish', async () => {
  let status = 'review_required';
  let finalizeCalls = 0;
  let finalizedProof = null;
  let auditCalls = 0;
  const campaign = { id: 'abc', title: 'Test', revision: 2, final_message: 'Hello' };
  const service = {
    approve: async () => {
      const resumed = status === 'approval_pending';
      status = 'approval_pending';
      return { campaign: { ...campaign, status }, recipientCount: 1, audienceHash: 'aud', messageHash: 'msg', resumed };
    },
    finalizeApproval: async (_id, _revision, proof) => {
      finalizeCalls += 1; finalizedProof = proof; status = 'approved'; return { ...campaign, status };
    },
    schedule: async () => {
      if (status !== 'approved') throw new CampaignRequestError('Approval audit required.', 'CAMPAIGN_NOT_APPROVED', 409);
    }
  };
  const router = createCampaignRouter({
    service,
    auditApprovalWriter: async () => {
      auditCalls += 1;
      if (auditCalls === 1) throw Object.assign(new Error('transient'), { status: 503, code: 'AUDIT_WRITE_FAILED' });
      return { recorded: true, id: 9 };
    }
  });
  const approve = handler(router, 'post', '/:id/approve');
  const first = response();
  await approve({ params: { id: 'abc' }, actor: {} }, first);
  assert.equal(first.statusCode, 503);
  assert.equal(status, 'approval_pending');
  assert.equal(finalizeCalls, 0);

  const scheduledTooEarly = response();
  await handler(router, 'post', '/:id/schedule')({ params: { id: 'abc' }, body: {}, actor: {} }, scheduledTooEarly);
  assert.equal(scheduledTooEarly.statusCode, 409);

  const retry = response();
  await approve({ params: { id: 'abc' }, actor: {} }, retry);
  assert.equal(retry.statusCode, 200);
  assert.equal(status, 'approved');
  assert.equal(finalizeCalls, 1);
  assert.equal(finalizedProof.id, 9);
  assert.equal(finalizedProof.fingerprint, 'campaign-approved:abc:2');
});

test('submit uses a lifecycle predicate and reject uses the locked workspace-aware RPC', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib/campaigns/service.js'), 'utf8');
  assert.match(source, /\.in\('status', \['draft', 'rejected'\]\)/);
  assert.match(source, /rpc\('reject_sms_campaign'/);
  assert.match(source, /p_workspace_id: workspaceID/);
});

test('the legacy intelligence suggestion sender cannot bypass campaign gates', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes/intelligence.js'), 'utf8');
  const gate = source.indexOf('campaignLiveSendEligibility({ client: supabase })');
  const consent = source.indexOf('evaluateSingleRecipient({ client: supabase');
  const send = source.indexOf('await sendSMS(', gate);
  assert.ok(gate > -1 && consent > gate && send > consent,
    'provider gate and recipient consent must both run before sendSMS');
  assert.match(source, /CAMPAIGN_LIVE_SEND_DISABLED/);
});
