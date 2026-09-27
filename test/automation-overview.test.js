'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { automationOverview } = require('../lib/automation/overview');

function fakeClient(tables, failures = {}) {
  const campaigns = tables.sms_campaigns || [...new Map((tables.sms_campaign_recipients || [])
    .map(row => [row.campaign_id, {
      id: row.campaign_id, workspace_id: row.workspace_id,
      workflow_category: row.sms_campaigns.workflow_category,
      status: row.sms_campaigns.status
    }])).values()];
  return {
    from(table) {
      const filters = [];
      let head = false;
      let range = null;
      return {
        select(columns, options) {
          assert.doesNotMatch(columns, /!inner/, 'overview must not use the live-breaking embedded join');
          head = options?.head === true;
          return this;
        },
        eq(field, value) { filters.push(row => valueFor(row, field) === value); return this; },
        in(field, values) { filters.push(row => values.includes(valueFor(row, field))); return this; },
        order() { return this; },
        range(from, to) { range = [from, to]; return this; },
        is(field, value) { filters.push(row => valueFor(row, field) == value); return this; },
        not(field, operator, value) {
          assert.equal(operator, 'is');
          filters.push(row => valueFor(row, field) != value); return this;
        },
        gte(field, value) { filters.push(row => valueFor(row, field) >= value); return this; },
        lt(field, value) { filters.push(row => valueFor(row, field) < value); return this; },
        then(resolve) {
          const rows = (table === 'sms_campaigns' ? campaigns : tables[table] || [])
            .filter(row => filters.every(predicate => predicate(row)));
          const page = range ? rows.slice(range[0], range[1] + 1) : rows;
          return Promise.resolve(failures[table]
            ? { count: null, error: { message: failures[table] } }
            : { count: head ? page.length : null, data: head ? null : page, error: null }).then(resolve);
        }
      };
    }
  };
}

function valueFor(row, field) {
  return field.startsWith('sms_campaigns.')
    ? row.sms_campaigns?.[field.slice('sms_campaigns.'.length)] : row[field];
}

function campaignRows(category, count, state = 'pending', extras = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${category}-${index}`, campaign_id: category,
    workspace_id: 'vici', selected: true, state,
    sms_campaigns: { workflow_category: category, status: 'scheduled' },
    ...extras
  }));
}

const NOW = new Date('2026-09-27T16:00:00Z');

test('unified pending total includes all 104 VIP and 13 check-ins with no double count', async () => {
  const client = fakeClient({
    sms_campaign_recipients: [
      ...campaignRows('vip_welcome', 104), ...campaignRows('checkin_21d', 13),
      ...campaignRows('ordinary_promo', 9)
    ],
    sms_scheduled: [], sms_sent_log: [], luko_cart_recoveries: [], luko_cart_voice_attempts: []
  });
  const result = await automationOverview({ client, now: NOW, timeZone: 'America/New_York' });
  assert.equal(result.pending, 117);
  assert.equal(result.breakdown.vipWelcome.pending, 104);
  assert.equal(result.breakdown.checkIns.pending, 13);
  assert.equal(result.breakdown.paymentAndOrders.pending, 0);
  assert.equal(result.sentToday, 0);
});

test('payment, card retry and distinct cart SMS, push and voice actions are included', async () => {
  const client = fakeClient({
    sms_scheduled: [
      { id: 'hold', status: 'pending' }, { id: 'retry', status: 'pending' }
    ],
    sms_sent_log: [], sms_campaign_recipients: [], luko_cart_voice_attempts: [],
    luko_cart_recoveries: [{
      id: 'cart', workspace_id: 'vici', status: 'active', order_id: null,
      consent_granted: true, sms_status: 'QUEUED',
      customer_push_permission: true, push_due_at: '2026-09-29T00:00:00Z', push_status: 'QUEUED',
      voice_marketing_consent: true, ai_voice_consent: true,
      voice_due_at: '2026-09-27T20:00:00Z', voice_status: 'QUEUED'
    }]
  });
  const result = await automationOverview({ client, now: NOW });
  assert.equal(result.pending, 5);
  assert.equal(result.breakdown.paymentAndOrders.pending, 2);
  assert.equal(result.breakdown.abandonedCart.pending, 3);
  assert.deepEqual(Object.values(result.breakdown.abandonedCart.channels).map(x => x.pending), [1, 1, 1]);
});

test('sent, failed and cancelled use the New York day and one category each', async () => {
  const start = '2026-09-27T04:00:00Z';
  const before = '2026-09-27T03:59:59Z';
  const during = '2026-09-27T15:00:00Z';
  const client = fakeClient({
    sms_scheduled: [
      { id: 'failed', status: 'failed', send_at: during },
      { id: 'cancelled', status: 'cancelled', created_at: during }
    ],
    sms_sent_log: [
      { id: 'today', sent_at: start, telnyx_message_id: 'msg-1' },
      { id: 'yesterday', sent_at: before, telnyx_message_id: 'msg-2' },
      { id: 'backfill-sentinel', sent_at: during, telnyx_message_id: null }
    ],
    sms_campaign_recipients: [
      ...campaignRows('vip_welcome', 1, 'delivered', { sent_at: during }),
      ...campaignRows('checkin_21d', 1, 'failed', { failed_at: during }),
      ...campaignRows('checkin_21d', 1, 'cancelled', { updated_at: before })
    ],
    luko_cart_recoveries: [{
      id: 'cart', workspace_id: 'vici', status: 'sent',
      sms_status: 'SENT', sent_at: during, dry_run: false,
      push_status: 'CANCELLED_PURCHASED', updated_at: during
    }],
    luko_cart_voice_attempts: []
  });
  const result = await automationOverview({ client, now: NOW });
  assert.equal(result.sentToday, 3);
  assert.equal(result.failedToday, 2);
  assert.equal(result.cancelledToday, 2);
  assert.equal(result.pending, 0);
});

test('a failed count query fails closed instead of presenting an invented zero', async () => {
  const client = fakeClient({ sms_campaign_recipients: campaignRows('vip_welcome', 1) },
    { sms_campaign_recipients: 'permission denied' });
  await assert.rejects(() => automationOverview({ client, now: NOW }), /permission denied/);
});
