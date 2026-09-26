'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createCampaignService } = require('../lib/campaigns/service');

const ROOT = path.join(__dirname, '..');

test('rescheduling calls the atomic workspace-aware RPC with the exact instant and actor', async () => {
  let called;
  const client = {
    async rpc(name, args) {
      called = { name, args };
      return { data: [{ id: args.p_campaign_id, status: 'scheduled',
        scheduled_for: args.p_scheduled_for }], error: null };
    }
  };
  const service = createCampaignService({ client, env: {}, workspaceID: 'vici' });
  const result = await service.reschedule(
    '11111111-1111-4111-8111-111111111111',
    '2026-09-27T22:00:00.000Z',
    { id: 7 }
  );
  assert.equal(called.name, 'reschedule_sms_campaign');
  assert.deepEqual(called.args, {
    p_campaign_id: '11111111-1111-4111-8111-111111111111',
    p_workspace_id: 'vici',
    p_actor_user_id: 7,
    p_scheduled_for: '2026-09-27T22:00:00.000Z'
  });
  assert.equal(result.scheduled_for, '2026-09-27T22:00:00.000Z');
});

test('rescheduling refuses an invalid time before touching the database', async () => {
  const service = createCampaignService({
    client: { rpc: async () => { throw new Error('must not run'); } }, env: {}
  });
  await assert.rejects(service.reschedule('id', 'not-a-date', { id: 7 }),
    error => error.code === 'CAMPAIGN_SCHEDULE_TIME_INVALID');
});

test('a database clock rejection is still explained as an invalid send time', async () => {
  const service = createCampaignService({
    client: { rpc: async () => ({ data: null, error: {
      code: 'P0001', message: 'campaign_schedule_time_invalid'
    } }) }, env: {}
  });
  await assert.rejects(
    service.reschedule('id', new Date(Date.now() + 60_000).toISOString(), { id: 7 }),
    error => error.code === 'CAMPAIGN_SCHEDULE_TIME_INVALID'
      && /current or future/.test(error.message)
  );
});

test('the migration changes only pending work and refuses a campaign that started', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'scripts/campaign-reschedule-migration.sql'), 'utf8');
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.reschedule_sms_campaign/);
  assert.match(sql, /state IN \('claimed','sending','sent','delivered','reconciliation_required'\)/);
  assert.match(sql, /state IN \('pending','deferred'\)/);
  assert.match(sql, /scheduled_by = p_actor_user_id/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.reschedule_sms_campaign[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE[\s\S]*TO service_role/);
  assert.match(sql, /changes no existing schedule by itself/);
});

test('the iPhone makes rescheduling discoverable and shows both authoritative time zones', () => {
  const view = fs.readFileSync(path.join(ROOT, 'ios/ViciInbox/UI/CampaignsView.swift'), 'utf8');
  const api = fs.readFileSync(path.join(ROOT, 'ios/ViciInbox/Core/APIClient.swift'), 'utf8');
  const model = fs.readFileSync(path.join(ROOT, 'ios/ViciInbox/App/CampaignViewModels.swift'), 'utf8');
  assert.match(view, /Button\("Reschedule Campaign"\)/);
  assert.match(view, /LabeledContent\("Customer time"/);
  assert.match(view, /LabeledContent\("Your time"/);
  assert.match(view, /LabeledContent\("Recorded as", value: actorName\)/);
  assert.match(view, /businessTimeZone\.identifier/);
  assert.match(view, /viewerTimeZone/);
  assert.match(api, /\/reschedule/);
  assert.match(model, /func reschedule\(for date: Date\)/);
});

test('quick message edits validate against the campaign workflow, preserving VIP footer policy', () => {
  const model = fs.readFileSync(path.join(ROOT, 'ios/ViciInbox/App/CampaignViewModels.swift'), 'utf8');
  assert.match(model, /couponCode: campaign\.couponCode,[\s\S]{0,100}workflowCategory: campaign\.workflowCategory/);
});

test('automatic check-ins stay in Automations instead of appearing as manual campaigns', () => {
  const service = fs.readFileSync(path.join(ROOT, 'lib/campaigns/service.js'), 'utf8');
  assert.match(service, /includeAutomations = false/);
  assert.match(service, /query = query\.neq\('workflow_category', 'checkin_21d'\)/);
  assert.match(service, /reviewCount[\s\S]*?neq\('workflow_category', 'checkin_21d'\)/);
});
