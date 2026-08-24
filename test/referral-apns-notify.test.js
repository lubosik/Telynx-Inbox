'use strict';

process.env.SUPABASE_URL ||= 'https://unit-test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'unit-test-service-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const { referralPayload, sendReferralNotifications } = require('../lib/apns-notify');

function preparation(overrides = {}) {
  return {
    userID: '8', channel: 'native_push_preparation', eventType: 'referrals.assigned',
    collapseID: 'referral-one',
    payload: {
      aps: { alert: { title: 'Gregory referred Nessa', body: 'Pricing question' }, badge: 999 },
      screen: 'conversation', referralID: 'referral-one', phone: '+13055550123', extra: 'drop me'
    },
    ...overrides
  };
}

function device(id, userID) {
  return {
    id, device_token: `${id}`.padStart(64, 'a'), environment: 'production',
    bundle_id: 'com.vicipeptides.inbox', user_id: userID, storage: 'dedicated'
  };
}

function preferenceClient(rows) {
  return {
    from() {
      const builder = {
        select() { return builder; },
        in() { return builder; },
        then(resolve) { return Promise.resolve({ data: rows, error: null }).then(resolve); }
      };
      return builder;
    }
  };
}

test('referral payload keeps only alert and typed conversation route, with no badge', () => {
  assert.deepEqual(referralPayload(preparation()), {
    aps: {
      alert: { title: 'Gregory referred Nessa', body: 'Pricing question' },
      sound: 'default', category: 'REFERRAL', 'thread-id': 'vici-referral-referral-one'
    },
    screen: 'conversation', referralID: 'referral-one', phone: '+13055550123'
  });
});

test('real referral delivery is default-off before device lookup', async () => {
  let loads = 0;
  const result = await sendReferralNotifications([preparation()], { dryRun: false }, {
    env: {}, loadDevices: async () => { loads += 1; return { devices: [], error: null }; }
  });
  assert.equal(result.disabled, true);
  assert.equal(loads, 0);
});

test('dry run targets only the named owned device and excludes compatibility devices', async () => {
  const result = await sendReferralNotifications([preparation()], { dryRun: true }, {
    client: preferenceClient([]),
    loadDevices: async () => ({ devices: [device(1, '8'), device(2, '9'), device(3, null)], error: null })
  });
  assert.equal(result.targeted, 1);
  assert.equal(result.targets[0].user_id, '8');
  assert.equal(result.targets[0].device_token, undefined);
});

test('a stored referral opt-out stops delivery at the last APNs boundary', async () => {
  let delivered = false;
  const result = await sendReferralNotifications([preparation()], { dryRun: false }, {
    env: { REFERRAL_NOTIFICATIONS_ENABLED: 'true' },
    authorization: 'unit-test-token',
    client: preferenceClient([{ user_id: '8', referrals: false }]),
    loadDevices: async () => ({ devices: [device(1, '8')], error: null }),
    deliver: async () => { delivered = true; return { sent: 1, failed: 0 }; }
  });
  assert.equal(result.targeted, 0);
  assert.equal(delivered, false);
});

test('enabled delivery keeps the conversation deep link intact', async () => {
  let delivered;
  const result = await sendReferralNotifications([preparation()], { dryRun: false }, {
    env: { REFERRAL_NOTIFICATIONS_ENABLED: 'true' },
    authorization: 'unit-test-token', client: preferenceClient([]),
    loadDevices: async () => ({ devices: [device(1, '8'), device(2, null)], error: null }),
    deliver: async (targets, payload, headers) => {
      delivered = { targets, payload, headers };
      return { sent: targets.length, failed: 0 };
    }
  });
  assert.equal(result.sent, 1);
  assert.deepEqual(delivered.targets.map(row => row.user_id), ['8']);
  assert.equal(delivered.payload.phone, '+13055550123');
  assert.equal(delivered.headers['apns-collapse-id'], 'referral-one');
});
