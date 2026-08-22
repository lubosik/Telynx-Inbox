'use strict';

process.env.SUPABASE_URL ||= 'https://unit-test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'unit-test-service-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  campaignReviewPayload,
  sendCampaignReadyNotifications
} = require('../lib/apns-notify');
const { prepareCampaignReadyNotifications } = require('../lib/campaigns/campaign-ready-notifications');

function preparation(overrides = {}) {
  return {
    userID: '7',
    channel: 'native_push_preparation',
    eventType: 'campaigns.ready_for_review',
    collapseID: 'vici-campaigns-ready-for-review',
    payload: {
      aps: {
        alert: { title: 'Campaign draft ready', body: 'Review it before approval.' },
        sound: 'custom-not-allowed',
        badge: 999
      },
      screen: 'campaigns',
      reviewCount: 1,
      campaignID: 'campaign-42',
      destination: 'review',
      phone: '+13055550123'
    },
    ...overrides
  };
}

function device(id, userID) {
  return {
    id,
    device_token: `${id}`.padStart(64, 'a'),
    environment: 'production',
    bundle_id: 'com.vicipeptides.inbox',
    user_id: userID,
    storage: 'dedicated'
  };
}

test('campaign review payload keeps only the approved navigation and alert fields', () => {
  assert.deepEqual(campaignReviewPayload(preparation()), {
    aps: {
      alert: { title: 'Campaign draft ready', body: 'Review it before approval.' },
      sound: 'default',
      'thread-id': 'vici-campaign-review'
    },
    screen: 'campaigns',
    reviewCount: 1,
    campaignID: 'campaign-42',
    destination: 'review'
  });
});

test('real campaign review delivery is default-off before device lookup', async () => {
  let loads = 0;
  const result = await sendCampaignReadyNotifications([preparation()], { dryRun: false }, {
    env: {},
    loadDevices: async () => { loads += 1; return { devices: [], error: null }; }
  });
  assert.deepEqual(result, {
    sent: 0, targeted: 0, disabled: true, reason: 'feature_flag_disabled'
  });
  assert.equal(loads, 0);
});

test('dry run targets only explicitly authorised owned devices', async () => {
  const notifications = prepareCampaignReadyNotifications({
    generatedAt: '2026-08-22T12:00:00Z',
    drafts: [{ id: 'campaign-42', status: 'draft', workflowCategory: 'reorder' }],
    users: [
      { id: 7, role: 'owner', isActive: true, canApproveCampaigns: true },
      { id: 8, role: 'agent', isActive: true, canApproveCampaigns: false }
    ]
  });
  const result = await sendCampaignReadyNotifications(notifications, { dryRun: true }, {
    env: {},
    loadDevices: async () => ({
      devices: [device(1, '7'), device(2, '8'), device(3, null)],
      error: null
    })
  });
  assert.equal(result.targeted, 1);
  assert.equal(result.targets[0].user_id, '7');
  assert.equal(result.targets[0].device_token, undefined);
});

test('enabled delivery reuses APNs transport without widening the prepared audience', async () => {
  let delivered;
  const result = await sendCampaignReadyNotifications([preparation()], { dryRun: false }, {
    env: { CAMPAIGN_REVIEW_NOTIFICATIONS_ENABLED: 'true' },
    authorization: 'unit-test-provider-token',
    loadDevices: async () => ({
      devices: [device(1, '7'), device(2, '8'), device(3, null)],
      error: null
    }),
    deliver: async (targets, payload, headers, options) => {
      delivered = { targets, payload, headers, authorization: options.authorization };
      return { sent: targets.length, failed: 0 };
    }
  });
  assert.equal(result.sent, 1);
  assert.deepEqual(delivered.targets.map(row => row.user_id), ['7']);
  assert.equal(delivered.payload.screen, 'campaigns');
  assert.equal(delivered.payload.phone, undefined);
  assert.equal(delivered.headers['apns-collapse-id'], 'vici-campaigns-ready-for-review');
  assert.equal(delivered.authorization, 'unit-test-provider-token');
});

test('mixed preparations cannot accidentally share the wrong deep link', async () => {
  const result = await sendCampaignReadyNotifications([
    preparation(),
    preparation({ userID: '8', payload: { ...preparation().payload, campaignID: 'campaign-99' } })
  ]);
  assert.equal(result.error, 'invalid_campaign_notification_preparation');
});

