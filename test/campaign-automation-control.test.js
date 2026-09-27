'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createCampaignService } = require('../lib/campaigns/service');

const root = path.join(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

test('one recipient cancel calls only the atomic per-recipient RPC', async () => {
  const calls = [];
  const service = createCampaignService({
    client: { rpc: async (name, args) => {
      calls.push({ name, args });
      return { data: { id: args.p_recipient_id, state: 'cancelled' }, error: null };
    } },
    env: {}, workspaceID: 'vici'
  });
  const row = await service.cancelRecipient('campaign-1', 'recipient-2', { id: 7 });
  assert.equal(row.state, 'cancelled');
  assert.deepEqual(calls, [{ name: 'cancel_sms_campaign_recipient', args: {
    p_campaign_id: 'campaign-1', p_recipient_id: 'recipient-2',
    p_workspace_id: 'vici', p_actor_user_id: 7
  } }]);
});

test('pause and resume use workspace-scoped atomic RPCs and an explicit new time', async () => {
  const calls = [];
  const service = createCampaignService({
    client: { rpc: async (name, args) => {
      calls.push({ name, args });
      return { data: { id: args.p_campaign_id, status: name === 'pause_sms_campaign' ? 'paused' : 'scheduled' }, error: null };
    } }, env: {}, workspaceID: 'vici'
  });
  await service.pause('campaign-1', { id: 7 });
  const future = new Date(Date.now() + 3600000).toISOString();
  await service.resume('campaign-1', future, { id: 7 });
  assert.equal(calls[0].name, 'pause_sms_campaign');
  assert.equal(calls[1].name, 'resume_sms_campaign');
  assert.equal(calls[1].args.p_scheduled_for, future);
  await assert.rejects(service.resume('campaign-1', 'yesterday', { id: 7 }),
    error => error.code === 'CAMPAIGN_SCHEDULE_TIME_INVALID');
  assert.equal(calls.length, 2);
});

test('database fences prevent late individual cancellations and new sends while paused', () => {
  const sql = source('scripts/campaign-automation-control-migration.sql');
  assert.match(sql, /SELECT \* INTO v_campaign[\s\S]*FOR UPDATE;/);
  assert.match(sql, /state NOT IN \('pending', 'deferred', 'claimed'\)/);
  assert.match(sql, /provider_attempt_started_at IS NOT NULL/);
  assert.match(sql, /UPDATE public\.sms_campaign_recipients SET state = 'cancelled'/);
  assert.match(sql, /UPDATE public\.sms_campaigns SET status = 'paused'/);
  assert.match(sql, /UPDATE public\.sms_campaigns SET status = 'scheduled'/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.cancel_sms_campaign_recipient/);
  const providerFence = source('scripts/campaigns-migration.sql');
  assert.match(providerFence, /v_campaign\.status NOT IN \('scheduled', 'sending'\)/);
});

test('app exposes per-person cancel and batch pause, resume, cancel', () => {
  const queue = source('ios/ViciInbox/UI/WorkspaceViews.swift');
  const detail = source('ios/ViciInbox/UI/CampaignsView.swift');
  assert.match(queue, /\.swipeActions\(edge: \.trailing, allowsFullSwipe: false\)/);
  assert.match(queue, /cancelCampaignRecipient\(/);
  assert.match(detail, /Pause Remaining Messages/);
  assert.match(detail, /Resume With New Send Time/);
  assert.match(detail, /Cancel Campaign/);
});

test('a cancelled VIP welcome is not silently requeued by the next sweep', () => {
  const welcome = source('lib/campaigns/vip-welcome-automation.js');
  assert.match(welcome, /const individuallyCancelled = !retired && state === 'cancelled'/);
  assert.match(welcome, /const operatorCancelled = campaign\.cancelled_by != null/);
});
