'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  configuredVIPNumber,
  isVIPCustomer,
  isVIPInboxNumber,
  invalidateVIPMembership,
  resetVIPMembershipCache,
  senderNumberFor
} = require('../lib/vip-inbox-messaging');
const { sendSMS } = require('../telnyx');
const webhookSource = fs.readFileSync(path.join(__dirname, '../routes/webhook.js'), 'utf8');

function fakeClient(tables = {}, errors = {}) {
  for (const order of tables.sms_orders || []) {
    if (order.created_at === undefined) order.created_at = '2026-01-01T12:00:00Z';
  }
  return {
    from(table) {
      const filters = [];
      let bounds = null;
      const query = {
        select() { return query; },
        range(from, to) { bounds = [from, to]; return query; },
        order() { return query; },
        eq(key, value) { filters.push(row => row[key] === value); return query; },
        is(key, value) { filters.push(row => row[key] === value); return query; },
        maybeSingle() {
          if (errors[table]) return Promise.resolve({ data: null, error: errors[table] });
          let rows = (tables[table] || []).filter(row => filters.every(filter => filter(row)));
          if (bounds) rows = rows.slice(bounds[0], bounds[1] + 1);
          return Promise.resolve({ data: rows[0] || null, error: null });
        },
        then(resolve, reject) {
          if (errors[table]) return Promise.resolve({ data: null, error: errors[table] }).then(resolve, reject);
          let rows = (tables[table] || []).filter(row => filters.every(filter => filter(row)));
          if (bounds) rows = rows.slice(bounds[0], bounds[1] + 1);
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

test('the signed inbound webhook brands notifications by current customer membership after STOP handling', () => {
  assert.match(webhookSource, /inboundToPhone/);
  assert.match(webhookSource, /isVIPCustomer\(\{ client: supabase, phone: fromPhone \}\)/);
  assert.doesNotMatch(webhookSource, /isVIPInboxNumber\(inboundToPhone\)/);
  const classification = webhookSource.indexOf('const isVIPMessage = await isVIPCustomer');
  const suppression = webhookSource.indexOf('await suppressOptOut(fromPhone)');
  assert.ok(classification > suppression);
  assert.match(webhookSource.slice(suppression, classification), /await complete\(\);\s*return;/);
  assert.match(webhookSource, /`👑 VIP · \$\{senderName\}`/);
  assert.match(webhookSource, /isVIP: isVIPMessage/);
});

test('VIP notification membership does not depend on receiving the VIP number', async () => {
  resetVIPMembershipCache();
  const vipPhone = '+15555550111';
  const standardPhone = '+15555550112';
  const client = fakeClient({ sms_orders: Array.from({ length: 3 }, (_, id) => ({
    id, woo_order_id: id, contact_phone: vipPhone, status: 'completed', total: 200
  })), sms_campaign_segments: [] });
  // These are the same membership decisions used in the webhook, regardless
  // of which of the business's two numbers the incoming message targeted.
  assert.equal(await isVIPCustomer({ client, phone: vipPhone }), true);
  assert.equal(await isVIPCustomer({ client, phone: standardPhone }), false);
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
      { workspace_id: 'vici', segment_id: 'vip-segment', contact_phone: '+15555550101', membership_source: 'forced_include' }
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

test('paging includes qualifying paid orders beyond the first thousand rows', async () => {
  resetVIPMembershipCache();
  const phone = '+15555550104';
  const orders = Array.from({ length: 1000 }, (_, id) => ({ id, woo_order_id: id,
    contact_phone: phone, status: 'pending', total: 200 }));
  orders.push(...Array.from({ length: 3 }, (_, index) => ({ id: 1001 + index,
    woo_order_id: 1001 + index, contact_phone: phone, status: 'completed', total: 200 })));
  assert.equal(await isVIPCustomer({ client: fakeClient({ sms_orders: orders }), phone }), true);
});

test('invalidation promotes a newly qualified VIP on the next send', async () => {
  resetVIPMembershipCache();
  const phone = '+15555550105';
  const tables = { sms_orders: [], sms_campaign_segments: [] };
  const client = fakeClient(tables);
  assert.equal(await senderNumberFor({ client, phone, env }), env.TELNYX_PHONE_NUMBER);
  tables.sms_orders = Array.from({ length: 3 }, (_, id) => ({ id, woo_order_id: id,
    contact_phone: phone, status: 'completed', total: 200, created_at: '2026-01-01T12:00:00Z' }));
  invalidateVIPMembership(phone);
  assert.equal(await senderNumberFor({ client, phone, env }), env.VIP_INBOX_PHONE_NUMBER);
});

test('stale computed segment membership alone does not make a customer VIP', async () => {
  resetVIPMembershipCache();
  const phone = '+15555550106';
  const client = fakeClient({ sms_orders: [], sms_campaign_segments: [
    { id: 'vip-segment', workspace_id: 'vici', segment_key: 'best_repeat_customers', archived_at: null }
  ], sms_campaign_segment_members: [
    { workspace_id: 'vici', segment_id: 'vip-segment', contact_phone: phone, membership_source: 'computed' }
  ] });
  assert.equal(await senderNumberFor({ client, phone, env }), env.TELNYX_PHONE_NUMBER);
});

test('sender classification matches canonical facts for invalid dates and rounded spend', async () => {
  resetVIPMembershipCache();
  const phone = '+15555550109';
  const { buildCustomerFacts } = require('../lib/campaigns/segment-facts');
  const { automaticVIP } = require('../lib/vip-customers');
  for (const invalidDate of [false, true]) {
    const orders = Array.from({ length: 3 }, (_, id) => ({ id, woo_order_id: id,
      contact_phone: phone, status: 'completed', total: 166.666,
      created_at: invalidDate && id === 0 ? null : '2026-01-01T12:00:00Z' }));
    const client = fakeClient({ sms_orders: orders, sms_campaign_segments: [] });
    const { facts } = buildCustomerFacts({ contacts: [{ phone }], orders });
    assert.equal(await isVIPCustomer({ client, phone }), automaticVIP(facts[0]));
  }
});

test('membership cache never leaks a VIP result between database clients', async () => {
  resetVIPMembershipCache();
  const phone = '+15555550110';
  const vipClient = fakeClient({ sms_orders: Array.from({ length: 3 }, (_, id) => ({
    id, woo_order_id: id, contact_phone: phone, status: 'completed', total: 200
  })) });
  const standardClient = fakeClient({ sms_orders: [], sms_campaign_segments: [] });
  assert.equal(await isVIPCustomer({ client: vipClient, phone }), true);
  assert.equal(await isVIPCustomer({ client: standardClient, phone }), false);
});

test('transport routes default SMS and MMS by customer without requiring each automation to opt in', async () => {
  resetVIPMembershipCache();
  const originalFetch = global.fetch;
  const phone = '+15555550107';
  const client = fakeClient({ sms_orders: Array.from({ length: 3 }, (_, id) => ({
    id, woo_order_id: id, contact_phone: phone, status: 'completed', total: 200
  })), sms_campaign_segments: [] });
  const bodies = [];
  global.fetch = async (_url, request) => {
    bodies.push(JSON.parse(request.body));
    return { ok: true, json: async () => ({ data: { id: 'transport-test', to: [{ status: 'queued' }] } }) };
  };
  try {
    const result = await sendSMS(phone, 'Payment reminder', null, { env, client });
    assert.equal(result.from, env.VIP_INBOX_PHONE_NUMBER);
    await sendSMS(phone, 'Photo', ['https://example.com/photo.jpg'], { env, client });
    await sendSMS('+15555550108', 'Order confirmation', null, { env, client });
    await sendSMS(phone, 'Already resolved', null, { env, from: env.TELNYX_PHONE_NUMBER });
    assert.deepEqual(bodies.map(body => body.from), [env.VIP_INBOX_PHONE_NUMBER,
      env.VIP_INBOX_PHONE_NUMBER, env.TELNYX_PHONE_NUMBER, env.TELNYX_PHONE_NUMBER]);
    assert.deepEqual(bodies[1].media_urls, ['https://example.com/photo.jpg']);
  } finally { global.fetch = originalFetch; }
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
