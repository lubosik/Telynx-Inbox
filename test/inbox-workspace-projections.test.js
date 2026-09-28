'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAudience, readInboxAudience, readAllInboxRows } = require('../lib/inbox-audience');
const { aggregateInboxOverview } = require('../lib/automation/inbox-overview');
const { scopedRecoveryMetrics, recoveryCursor, afterRecoveryCursor } = require('../lib/cart-recovery/inbox-dashboard');

const VIP = '+15555550120';
const MAIN = '+15555550121';
const NOW = new Date('2026-09-28T16:00:00Z');
const TODAY = '2026-09-28T10:00:00Z';
const YESTERDAY = '2026-09-28T03:59:59Z'; // Before New York's midnight.

function context(audience = 'vip') {
  const includes = phone => audience === 'all' || (phone === VIP) === (audience === 'vip');
  return { audience, includes, filter: (rows, key = 'contact_phone') => rows.filter(row => includes(row[key])) };
}

function fakeClient(tables = {}, errors = {}) {
  return { from(table) {
    let bounds; let single = false; const filters = []; const ordering = [];
    const query = {
      select() { return query; },
      eq(key, value) { filters.push(row => row[key] === value); return query; },
      is(key, value) { filters.push(row => (row[key] ?? null) === value); return query; },
      order(key, options = {}) { ordering.push([key, options.ascending !== false]); return query; },
      range(from, to) { bounds = [from, to]; return query; },
      maybeSingle() { single = true; return query; },
      then(resolve, reject) {
        if (errors[table]) return Promise.resolve({ data: null, error: errors[table] }).then(resolve, reject);
        let rows = (tables[table] || []).filter(row => filters.every(filter => filter(row)));
        rows.sort((a, b) => {
          for (const [key, ascending] of ordering) {
            if (a[key] === b[key]) continue;
            return (a[key] > b[key] ? 1 : -1) * (ascending ? 1 : -1);
          }
          return 0;
        });
        if (bounds) rows = rows.slice(bounds[0], bounds[1] + 1);
        return Promise.resolve({ data: single ? rows[0] || null : rows, error: null }).then(resolve, reject);
      }
    };
    return query;
  } };
}

function customerTables() {
  return { sms_contacts: [{ id: 1, phone: VIP }, { id: 2, phone: MAIN }],
    sms_orders: Array.from({ length: 3 }, (_, id) => ({ id: id + 1, woo_order_id: id + 1,
      contact_phone: VIP, total: 200, status: 'completed', created_at: TODAY })),
    sms_campaign_segments: [], sms_campaign_segment_members: [] };
}

test('audience grammar defaults legacy readers to all and rejects malformed scope', () => {
  assert.equal(parseAudience(undefined), 'all');
  assert.equal(parseAudience(''), 'all');
  for (const audience of ['all', 'main', 'vip']) assert.equal(parseAudience(audience), audience);
  for (const value of ['VIP', 'other', ['vip'], {}]) assert.throws(() => parseAudience(value), error => error.status === 400);
});

test('canonical customer scopes are disjoint, normalize phones and retain unknown callers in Main', async () => {
  const client = fakeClient(customerTables());
  const main = await readInboxAudience(client, 'main');
  const vip = await readInboxAudience(client, 'vip');
  assert.equal(vip.includes('+1 (555) 555-0120'), true);
  assert.equal(main.includes(VIP), false);
  assert.equal(vip.includes(MAIN), false);
  assert.equal(main.includes('+15555550199'), true);
  assert.equal(vip.tier(VIP), 'vip');
  assert.deepEqual(vip.filter([{ phone: VIP }, { phone: MAIN }], 'phone'), [{ phone: VIP }]);
});

test('all scope requires no customer lookup and preserves legacy rows', async () => {
  const all = await readInboxAudience({ from() { throw new Error('Must not query'); } }, 'all');
  const rows = [{ contact_phone: VIP }, { contact_phone: MAIN }];
  assert.equal(all.filter(rows), rows);
  assert.equal(all.tier(VIP), null);
});

test('transient membership failures cannot reclassify VIP customers as Main', async () => {
  await assert.rejects(readInboxAudience(fakeClient(customerTables(), {
    sms_campaign_segments: { code: '08006', message: 'Database unavailable' }
  }), 'main'), error => error.code === 'INBOX_AUDIENCE_UNAVAILABLE' && error.status === 503);
});

test('complete population reader rejects its safety ceiling rather than reporting truncated totals', async () => {
  await assert.rejects(readAllInboxRows(fakeClient({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }] }),
    'rows', '*', { orderBy: 'id', maxRows: 3 }), error => error.code === 'INBOX_AUDIENCE_INCOMPLETE');
});

test('scoped automation overview counts actions across every category using New York event dates', () => {
  const sources = {
    scheduled: [{ phone: VIP, status: 'pending' }, { phone: MAIN, status: 'pending' },
      { phone: VIP, status: 'failed', send_at: TODAY }, { phone: VIP, status: 'failed', send_at: YESTERDAY },
      { phone: VIP, status: 'cancelled', created_at: TODAY }],
    sent: [{ phone: VIP, telnyx_message_id: 'paid-message', sent_at: TODAY },
      { phone: VIP, telnyx_message_id: null, sent_at: TODAY }],
    campaigns: [{ id: 'vip-welcome', workflow_category: 'vip_welcome', status: 'scheduled' },
      { id: 'check-in', workflow_category: 'checkin_21d', status: 'sending' },
      { id: 'paused', workflow_category: 'checkin_21d', status: 'paused' }],
    recipients: [{ campaign_id: 'vip-welcome', contact_phone: VIP, selected: true, state: 'pending' },
      { campaign_id: 'check-in', contact_phone: VIP, selected: true, state: 'deferred' },
      { campaign_id: 'check-in', contact_phone: MAIN, selected: true, state: 'pending' },
      { campaign_id: 'paused', contact_phone: VIP, selected: true, state: 'pending' },
      { campaign_id: 'vip-welcome', contact_phone: VIP, selected: false, state: 'pending' }],
    carts: [{ id: 'cart-vip', contact_phone: VIP, status: 'active', order_id: null,
      consent_granted: true, sms_status: 'QUEUED', customer_push_permission: true,
      push_due_at: TODAY, push_status: 'QUEUED', voice_marketing_consent: true,
      ai_voice_consent: true, voice_due_at: TODAY, voice_status: 'QUEUED' }],
    voiceAttempts: [{ recovery_id: 'cart-vip', dry_run: false, initiated_at: TODAY },
      { recovery_id: 'cart-other', dry_run: false, initiated_at: TODAY }]
  };
  const result = aggregateInboxOverview(sources, context(), { now: NOW, timeZone: 'America/New_York' });
  assert.equal(result.pending, 6); // Payment + welcome + check-in + SMS/push/voice.
  assert.equal(result.sentToday, 2); // Payment SMS + one actual voice attempt.
  assert.equal(result.failedToday, 1);
  assert.equal(result.cancelledToday, 1);
  assert.equal(result.breakdown.checkIns.pending, 1);
  assert.equal(result.breakdown.abandonedCart.pending, 3);
  const all = aggregateInboxOverview(sources, context('all'), { now: NOW, timeZone: 'America/New_York' });
  const main = aggregateInboxOverview(sources, context('main'), { now: NOW, timeZone: 'America/New_York' });
  assert.equal(result.pending + main.pending, all.pending);
});

test('recovery metrics use persisted paid-order net, including refunds, never cart totals', () => {
  const result = scopedRecoveryMetrics({
    carts: [{ id: 'cart', contact_phone: VIP, abandoned_cart_value: 999999, status: 'active', due_at: TODAY }],
    recoveredOrders: [{ id: 'paid-1', contact_phone: VIP, order_paid_at: TODAY, order_currency: 'USD',
      gross_recovered_revenue: 135, refund_amount: 20, net_recovered_revenue: 115 },
    { id: 'paid-2', contact_phone: VIP, order_currency: 'USD', gross_recovered_revenue: 100,
      refund_amount: 100, net_recovered_revenue: 0 },
    { id: 'main-paid', contact_phone: MAIN, order_currency: 'USD', net_recovered_revenue: 1000 }],
    voiceAttempts: []
  }, context(), NOW);
  assert.equal(result.recovered_revenue, 115);
  assert.equal(result.recovered_orders, 2);
  assert.equal(result.currency, 'USD');
});

test('mixed or incomplete recovered-order currency data refuses an aggregate amount', () => {
  for (const orders of [
    [{ contact_phone: VIP, order_currency: 'USD', net_recovered_revenue: 1 },
      { contact_phone: VIP, order_currency: 'GBP', net_recovered_revenue: 1 }],
    [{ contact_phone: VIP, net_recovered_revenue: 1 }],
    [{ contact_phone: VIP, order_currency: 'USD', net_recovered_revenue: null }]
  ]) assert.throws(() => scopedRecoveryMetrics({ carts: [], recoveredOrders: orders, voiceAttempts: [] }, context()),
    error => error.code === 'RECOVERY_CURRENCY_BREAKDOWN_REQUIRED');
});

test('tuple recovery cursor retains equal timestamps without skipping or duplicating journeys', () => {
  const rows = ['00000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001']
    .map(id => ({ id, last_activity_at: TODAY }));
  const next = afterRecoveryCursor(rows, recoveryCursor(rows[1]));
  assert.deepEqual(next.map(row => row.id), [rows[2].id]);
  assert.deepEqual(afterRecoveryCursor(rows, recoveryCursor(rows[2])), []);
  assert.deepEqual(afterRecoveryCursor(rows, TODAY), []); // Legacy timestamp cursor.
});

test('malformed recovery cursors produce a plain-English refresh error', () => {
  for (const value of ['garbage', Buffer.from(JSON.stringify({ at: TODAY, id: 'bad-id' })).toString('base64url')]) {
    assert.throws(() => afterRecoveryCursor([], value), error => error.status === 400 && /Refresh/.test(error.message));
  }
});
