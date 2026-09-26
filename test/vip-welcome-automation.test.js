'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCopy } = require('../lib/campaigns/copy-validator');
const { loadCampaignSettings } = require('../lib/campaigns/eligibility');
const {
  WELCOME_MESSAGE,
  dueVIPWelcomes,
  runVIPWelcomeSweep
} = require('../lib/campaigns/vip-welcome-automation');
const {
  deliverBatch,
  vipWelcomeConversationFence
} = require('../lib/campaigns/delivery-worker');

const NOW = new Date('2026-09-26T16:00:00.000Z');

function database(tables) {
  return {
    from(table) {
      const filters = [];
      let lower = 0;
      let upper = Infinity;
      let limit = null;
      const query = {
        select() { return query; },
        eq(column, value) { filters.push(row => row[column] === value); return query; },
        is(column, value) { filters.push(row => row[column] === value); return query; },
        in(column, values) { filters.push(row => values.includes(row[column])); return query; },
        lte(column, value) { filters.push(row => String(row[column]) <= String(value)); return query; },
        gte(column, value) { filters.push(row => String(row[column]) >= String(value)); return query; },
        order() { return query; },
        range(from, to) { lower = from; upper = to; return Promise.resolve(result()); },
        limit(value) { limit = value; return query; },
        maybeSingle() {
          const rows = result().data;
          return Promise.resolve({ data: rows[0] || null, error: null });
        },
        then(resolve) { return Promise.resolve(result()).then(resolve); }
      };
      function result() {
        let rows = (tables[table] || []).filter(row => filters.every(filter => filter(row)));
        if (limit !== null) rows = rows.slice(0, limit);
        rows = rows.slice(lower, upper === Infinity ? undefined : upper + 1);
        return { data: rows, error: null };
      }
      return query;
    }
  };
}

test('the stored VIP welcome is concise and passes the real VIP copy gate', () => {
  const verdict = validateCopy(WELCOME_MESSAGE, { requireOptOut: false });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.failures));
  assert.match(WELCOME_MESSAGE, /most loyal researchers/i);
  assert.match(WELCOME_MESSAGE, /VIP access/i);
  assert.match(WELCOME_MESSAGE, /private code/i);
  assert.match(WELCOME_MESSAGE, /1:1 research support/i);
  assert.match(WELCOME_MESSAGE, /24\/7/);
});

test('only a named VIP beyond 24 hours, never welcomed and quiet for two hours, is due', async () => {
  const due = '+15550000001';
  const reached = '+15550000002';
  const recent = '+15550000003';
  const future = '+15550000004';
  const noName = '+15550000005';
  const client = database({
    sms_campaign_segments: [{ id: 'vip', workspace_id: 'vici', segment_key: 'best_repeat_customers', archived_at: null }],
    sms_campaign_segment_members: [
      due, reached, recent, noName
    ].map((phone, index) => ({
      workspace_id: 'vici', segment_id: 'vip', contact_phone: phone,
      contact_id: index + 1, contact_name_snapshot: phone === noName ? null : `Person ${index}`,
      first_seen_at: '2026-09-24T12:00:00.000Z', membership_source: 'computed'
    })).concat([{
      workspace_id: 'vici', segment_id: 'vip', contact_phone: future, contact_id: 9,
      contact_name_snapshot: 'Future Person', first_seen_at: '2026-09-26T12:00:00.000Z',
      membership_source: 'computed'
    }]),
    sms_campaigns: [{ id: 'old', workspace_id: 'vici', workflow_category: 'vip_welcome' }],
    sms_campaign_recipients: [{ workspace_id: 'vici', campaign_id: 'old', contact_phone: reached }],
    sms_contacts: [
      { id: 1, phone: due, name: 'Alex Smith', first_name: 'Alex' },
      { id: 2, phone: reached, name: 'Jo Reed', first_name: 'Jo' },
      { id: 3, phone: recent, name: 'Sam West', first_name: 'Sam' },
      { id: 9, phone: future, name: 'Terry Lane', first_name: 'Terry' },
      { id: 5, phone: noName, name: null, first_name: null }
    ],
    sms_messages: [{ contact_phone: recent, created_at: '2026-09-26T15:00:00.000Z' }]
  });

  const result = await dueVIPWelcomes({ client, now: NOW });
  assert.deepEqual(result.due.map(row => row.phone), [due]);
  assert.equal(result.candidates, 4, 'the not-yet-24-hour member is not a candidate yet');
  assert.equal(result.reasons.already_enrolled, 1);
  assert.equal(result.reasons.recent_conversation, 1);
  assert.equal(result.reasons.missing_name, 1);
  assert.equal(result.due[0].reason.first_seen_at, '2026-09-24T12:00:00.000Z');
});

test('the automation is off before migration and whenever standing authorisation is off', async () => {
  const common = { client: {}, service: {}, audit: async () => ({}), readDue: async () => ({ due: [] }) };
  const missing = await runVIPWelcomeSweep({
    ...common, loadSettings: async () => ({ vipWelcomeAutomationAvailable: false })
  });
  assert.equal(missing.reason, 'migration_required');
  const disabled = await runVIPWelcomeSweep({
    ...common, loadSettings: async () => ({ vipWelcomeAutomationAvailable: true, vip_welcome_automation_enabled: false })
  });
  assert.equal(disabled.reason, 'automation_disabled');
});

test('a Railway deploy before the additive migration keeps existing campaign settings readable', async () => {
  const selected = [];
  const client = {
    from() {
      const query = {
        select(columns) { selected.push(columns); query.columns = columns; return query; },
        eq() { return query; },
        maybeSingle() {
          if (query.columns.includes('vip_welcome_automation_enabled')) {
            return Promise.resolve({
              data: null,
              error: { code: 'PGRST204', message: "Could not find the 'vip_welcome_automation_enabled' column" }
            });
          }
          return Promise.resolve({
            data: { workspace_id: 'vici', checkin_automation_enabled: true, business_timezone: 'America/New_York' },
            error: null
          });
        }
      };
      return query;
    }
  };
  const settings = await loadCampaignSettings(client);
  assert.equal(selected.length, 2);
  assert.equal(settings.checkin_automation_enabled, true, 'the existing automation remains readable');
  assert.equal(settings.vipWelcomeAutomationAvailable, false);
  assert.equal(settings.vip_welcome_automation_enabled, false);
});

test('an enabled sweep uses the audited campaign state machine in order', async () => {
  const calls = [];
  const service = {
    async create(input) { calls.push(['create', input]); return { campaign: { id: 'welcome-1' } }; },
    async submitReview(id) { calls.push(['submit', id]); },
    async approve(id) {
      calls.push(['approve', id]);
      return { campaign: { id, revision: 1, title: 'VIP welcome', final_message: WELCOME_MESSAGE }, recipientCount: 1, audienceHash: 'a', messageHash: 'm' };
    },
    async finalizeApproval(id, revision, proof) { calls.push(['finalize', id, revision, proof.fingerprint]); },
    async schedule(id, at) { calls.push(['schedule', id, at]); return { scheduled_for: at }; }
  };
  const result = await runVIPWelcomeSweep({
    client: {}, service, now: NOW,
    loadSettings: async () => ({
      vipWelcomeAutomationAvailable: true,
      vip_welcome_automation_enabled: true,
      vip_welcome_message_template: WELCOME_MESSAGE
    }),
    readDue: async () => ({ candidates: 1, reasons: {}, due: [{ phone: '+15550000001', name: 'Alex' }] }),
    audit: async () => { calls.push(['audit']); return { fingerprint: 'proof' }; }
  });
  assert.equal(result.reason, 'scheduled');
  assert.deepEqual(calls.map(row => row[0]), ['create', 'submit', 'approve', 'audit', 'finalize', 'schedule']);
  assert.equal(calls[0][1].workflowCategory, 'vip_welcome');
  assert.equal(calls[0][1].message, WELCOME_MESSAGE);
  assert.equal(calls.at(-1)[2], '2026-09-26T16:01:00.000Z');
});

test('the delivery fence waits until two hours after the latest conversation', async () => {
  const client = database({
    sms_campaigns: [{ id: 'c1', workspace_id: 'vici', workflow_category: 'vip_welcome' }],
    sms_messages: [{ contact_phone: '+15550000001', created_at: '2026-09-26T15:30:00.000Z' }]
  });
  const result = await vipWelcomeConversationFence({
    client,
    recipient: { campaign_id: 'c1', workspace_id: 'vici', contact_phone: '+15550000001' },
    now: NOW
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'vip_welcome_recent_conversation');
  assert.equal(result.retryAt.toISOString(), '2026-09-26T17:30:00.000Z');
});

test('a fenced claimed welcome is deferred and never reaches the provider', async () => {
  const calls = [];
  const client = {
    async rpc(name) {
      calls.push(name);
      if (name === 'claim_sms_campaign_recipients') return { data: [{
        id: 'r1', campaign_id: 'c1', workspace_id: 'vici', claim_token: 'token',
        contact_phone: '+15550000001', rendered_message: 'Hello'
      }], error: null };
      return { data: 0, error: null };
    }
  };
  let sent = 0;
  let deferred = 0;
  const summary = await deliverBatch({
    client, env: { CAMPAIGNS_LIVE_SEND_ENABLED: 'true' },
    send: async () => { sent += 1; return { messageId: 'bad' }; },
    conversationFence: async () => ({
      allowed: false, reason: 'vip_welcome_recent_conversation', retryAt: new Date(NOW.getTime() + 1000)
    }),
    deferClaim: async () => { deferred += 1; },
    log: { error() {} }
  });
  assert.equal(sent, 0);
  assert.equal(deferred, 1);
  assert.equal(summary.skipped, 1);
  assert.deepEqual(summary.reasons, { vip_welcome_recent_conversation: 1 });
  assert.equal(calls.includes('begin_sms_campaign_provider_attempt'), false);
});
