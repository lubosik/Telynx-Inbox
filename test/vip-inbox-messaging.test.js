'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  configuredVIPNumber,
  isVIPCustomer,
  isVIPInboxNumber,
  resetVIPMembershipCache,
  senderNumberFor
} = require('../lib/vip-inbox-messaging');
const { sendSMS } = require('../telnyx');
const webhookSource = fs.readFileSync(path.join(__dirname, '../routes/webhook.js'), 'utf8');

function fakeClient(tables = {}, errors = {}) {
  return {
    from(table) {
      const filters = [];
      const query = {
        select() { return query; },
        eq(key, value) { filters.push(row => row[key] === value); return query; },
        is(key, value) { filters.push(row => row[key] === value); return query; },
        maybeSingle() {
          if (errors[table]) return Promise.resolve({ data: null, error: errors[table] });
          const rows = (tables[table] || []).filter(row => filters.every(filter => filter(row)));
          return Promise.resolve({ data: rows[0] || null, error: null });
        },
        then(resolve, reject) {
          if (errors[table]) return Promise.resolve({ data: null, error: errors[table] }).then(resolve, reject);
          const rows = (tables[table] || []).filter(row => filters.every(filter => filter(row)));
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        }
      };
      return query;
    }
  };
}

const env = {
  TELNYX_PHONE_NUMBER: '+18666450593',
  VIP_INBOX_PHONE_NUMBER: '+19177254009'
};

test('the configured VIP inbox number is exact and normalised', () => {
  assert.equal(configuredVIPNumber(env), '+19177254009');
  assert.equal(isVIPInboxNumber('+1 (917) 725-4009', env), true);
  assert.equal(isVIPInboxNumber('+18666450593', env), false);
});

test('the signed inbound webhook derives VIP status from the receiving number', () => {
  assert.match(webhookSource, /inboundToPhone/);
  assert.match(webhookSource, /isVIPInboxNumber\(inboundToPhone\)/);
  assert.match(webhookSource, /`👑 VIP · \$\{senderName\}`/);
  assert.match(webhookSource, /isVIP: isVIPMessage/);
});

test('three paid orders and $500 lifetime spend select the VIP sending number', async () => {
  resetVIPMembershipCache();
  const client = fakeClient({
    sms_orders: [
      { id: 1, woo_order_id: 11, contact_phone: '+15555550100', status: 'completed', total: '200.00' },
      { id: 2, woo_order_id: 12, contact_phone: '+15555550100', status: 'processing', total: '175.00' },
      { id: 3, woo_order_id: 13, contact_phone: '+15555550100', status: 'shipped', total: '150.00' }
    ]
  });
  assert.equal(await isVIPCustomer({ client, phone: '+15555550100' }), true);
  assert.equal(await senderNumberFor({ client, phone: '+15555550100', env }), '+19177254009');
});

test('a manual VIP member also selects the VIP number', async () => {
  resetVIPMembershipCache();
  const client = fakeClient({
    sms_orders: [],
    sms_campaign_segments: [
      { id: 'vip-segment', workspace_id: 'vici', segment_key: 'best_repeat_customers', archived_at: null }
    ],
    sms_campaign_segment_members: [
      { workspace_id: 'vici', segment_id: 'vip-segment', contact_phone: '+15555550101' }
    ]
  });
  assert.equal(await senderNumberFor({ client, phone: '+15555550101', env }), '+19177254009');
});

test('a standard customer and an unreadable VIP lookup fail closed to the main number', async () => {
  resetVIPMembershipCache();
  const standard = fakeClient({ sms_orders: [], sms_campaign_segments: [] });
  assert.equal(await senderNumberFor({ client: standard, phone: '+15555550102', env }), '+18666450593');

  resetVIPMembershipCache();
  const unavailable = fakeClient({}, { sms_orders: { code: 'read_failed' } });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await senderNumberFor({ client: unavailable, phone: '+15555550103', env }), '+18666450593');
  } finally {
    console.warn = originalWarn;
  }
});

test('Telnyx uses an explicitly resolved sender without changing the messaging profile', async () => {
  const originalFetch = global.fetch;
  const originalNumber = process.env.TELNYX_PHONE_NUMBER;
  const originalProfile = process.env.TELNYX_MESSAGING_PROFILE_ID;
  const originalKey = process.env.TELNYX_API_KEY;
  let sent;
  global.fetch = async (_url, request) => {
    sent = JSON.parse(request.body);
    return {
      ok: true,
      async json() { return { data: { id: 'msg-1', to: [{ status: 'queued' }] } }; }
    };
  };
  process.env.TELNYX_PHONE_NUMBER = env.TELNYX_PHONE_NUMBER;
  process.env.TELNYX_MESSAGING_PROFILE_ID = 'vici-profile';
  process.env.TELNYX_API_KEY = 'test-only';
  try {
    await sendSMS('+15555550100', 'Hello', null, { from: env.VIP_INBOX_PHONE_NUMBER });
    assert.equal(sent.from, '+19177254009');
    assert.equal(sent.messaging_profile_id, 'vici-profile');
  } finally {
    global.fetch = originalFetch;
    if (originalNumber === undefined) delete process.env.TELNYX_PHONE_NUMBER;
    else process.env.TELNYX_PHONE_NUMBER = originalNumber;
    if (originalProfile === undefined) delete process.env.TELNYX_MESSAGING_PROFILE_ID;
    else process.env.TELNYX_MESSAGING_PROFILE_ID = originalProfile;
    if (originalKey === undefined) delete process.env.TELNYX_API_KEY;
    else process.env.TELNYX_API_KEY = originalKey;
  }
});
