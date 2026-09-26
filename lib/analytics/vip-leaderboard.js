'use strict';

const crypto = require('crypto');
const { fetchAllRows } = require('../fetch-all-rows');
const { normalisePhone } = require('../phone');
const { buildCustomerFacts } = require('../campaigns/segment-facts');
const { automaticVIP, VIP_SEGMENT_KEY } = require('../vip-customers');
const { analyticsExclusions, isExcludedIdentity } = require('./exclusions');
const { DEFAULT_TIME_ZONE, rangeForPeriod } = require('./date-ranges');

const PAID_STATUSES = new Set(['processing', 'completed', 'shipped', 'delivered']);
const WORKSPACE_ID = 'vici';
const SCORE_VERSION = 'vip_value_rank_v1';

function money(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) / 100 : 0;
}

function orderKey(order) {
  const value = order?.woo_order_id ?? order?.id;
  return value === null || value === undefined ? null : String(value);
}

function publicCustomerID(phone, fact = {}) {
  if (Number.isSafeInteger(Number(fact.contactID)) && Number(fact.contactID) > 0) {
    return `contact-${Number(fact.contactID)}`;
  }
  return `customer-${crypto.createHash('sha256').update(phone).digest('hex').slice(0, 20)}`;
}

function eligibleOrders(orders, exclusions) {
  const byPhoneAndOrder = new Map();
  for (const order of orders || []) {
    const phone = normalisePhone(order?.contact_phone);
    const id = orderKey(order);
    const created = Date.parse(order?.created_at);
    if (!phone || !id || !Number.isFinite(created)) continue;
    if (!PAID_STATUSES.has(String(order?.status || '').toLowerCase())) continue;
    if (isExcludedIdentity({ phone, orderID: id }, exclusions)) continue;
    // Woo order id is authoritative. Later rows replace earlier sync states,
    // without letting a duplicated webhook inflate spend or frequency.
    byPhoneAndOrder.set(`${phone}\u0000${id}`, {
      ...order, contact_phone: phone, _created: created, _total: money(order.total)
    });
  }
  return [...byPhoneAndOrder.values()];
}

function buildVIPLeaderboard({ contacts = [], orders = [], manuallyIncluded = new Set(), range, exclusions }) {
  const safeOrders = eligibleOrders(orders, exclusions);
  const safeContacts = (contacts || []).filter(contact => {
    const phone = normalisePhone(contact?.phone);
    return phone && !isExcludedIdentity({ phone }, exclusions);
  });
  const facts = buildCustomerFacts({ contacts: safeContacts, orders: safeOrders }, { now: range.end }).facts;
  const factsByPhone = new Map(facts.map(fact => [fact.contactPhone, fact]));
  const names = new Map(safeContacts.map(contact => [
    normalisePhone(contact.phone),
    String(contact.name || [contact.first_name, contact.last_name].filter(Boolean).join(' ') || '').trim() || 'Customer'
  ]));
  const vipPhones = new Set(facts
    .filter(fact => automaticVIP(fact) || manuallyIncluded.has(fact.contactPhone))
    .map(fact => fact.contactPhone));
  for (const phone of manuallyIncluded) {
    if (!isExcludedIdentity({ phone }, exclusions)) vipPhones.add(phone);
  }

  const periodByPhone = new Map();
  for (const order of safeOrders) {
    if (!vipPhones.has(order.contact_phone)) continue;
    if (order._created < range.start.getTime() || order._created >= range.end.getTime()) continue;
    if (!periodByPhone.has(order.contact_phone)) periodByPhone.set(order.contact_phone, []);
    periodByPhone.get(order.contact_phone).push(order);
  }

  const rows = [...periodByPhone].map(([phone, periodOrders]) => {
    const fact = factsByPhone.get(phone) || {};
    const totalSpend = Math.round(periodOrders.reduce((sum, order) => sum + order._total, 0) * 100) / 100;
    const paidOrders = periodOrders.length;
    return {
      id: publicCustomerID(phone, fact),
      customerName: names.get(phone) || fact.contactName || 'Customer',
      paidOrders,
      totalSpend,
      averageOrderValue: paidOrders ? Math.round((totalSpend / paidOrders) * 100) / 100 : 0,
      lifetimePaidOrders: Number(fact.orderCount || 0),
      lifetimeSpend: money(fact.lifetimeSpend),
      lastPaidAt: fact.lastOrderAt || null
    };
  });

  const maxOrders = Math.max(1, ...rows.map(row => row.paidOrders));
  const maxSpend = Math.max(1, ...rows.map(row => row.totalSpend));
  const maxAverage = Math.max(1, ...rows.map(row => row.averageOrderValue));
  for (const row of rows) {
    const raw = ((row.paidOrders / maxOrders) +
      (row.totalSpend / maxSpend) +
      (row.averageOrderValue / maxAverage)) / 3;
    row.score = Math.round(raw * 1000) / 10;
  }
  rows.sort((a, b) => b.score - a.score || b.totalSpend - a.totalSpend ||
    b.paidOrders - a.paidOrders || b.lifetimeSpend - a.lifetimeSpend ||
    String(b.lastPaidAt || '').localeCompare(String(a.lastPaidAt || '')) ||
    a.id.localeCompare(b.id));

  return {
    totalVipCustomers: vipPhones.size,
    activeVipCustomers: rows.length,
    leaders: rows.slice(0, 10).map((row, index) => ({ rank: index + 1, ...row }))
  };
}

async function manualVIPPhones(client, workspace) {
  try {
    const { data: segment, error } = await client.from('sms_campaign_segments')
      .select('id').eq('workspace_id', workspace).eq('segment_key', VIP_SEGMENT_KEY)
      .is('archived_at', null).maybeSingle();
    if (error) throw error;
    if (!segment) return new Set();
    const rows = await fetchAllRows(client, 'sms_campaign_segment_members', 'contact_phone,membership_source', {
      filter: query => query.eq('workspace_id', workspace).eq('segment_id', segment.id),
      orderBy: 'contact_phone', ascending: true
    });
    return new Set(rows.filter(row => row.membership_source === 'forced_include')
      .map(row => normalisePhone(row.contact_phone)).filter(Boolean));
  } catch (error) {
    // The leaderboard remains useful from the permanent paid-order rule if the
    // optional manual segment seed is unavailable.
    console.warn(`[VIP leaderboard] Manual membership unavailable (${error.code || 'read_failed'}).`);
    return new Set();
  }
}

function publicRange(range) {
  return {
    period: range.period,
    start: range.start.toISOString(),
    end: range.end.toISOString(),
    timeZone: range.timeZone,
    previous: range.previous ? {
      start: range.previous.start.toISOString(), end: range.previous.end.toISOString()
    } : null
  };
}

function createVIPLeaderboardService({ client, now = () => new Date(), workspace = WORKSPACE_ID,
  reliableFrom = process.env.ANALYTICS_RELIABLE_FROM || '2026-01-16' } = {}) {
  if (!client) throw new TypeError('VIP leaderboard client is required.');
  return {
    async overview(params = {}) {
      const { data: rules, error } = await client.from('analytics_attribution_rules')
        .select('business_timezone,currency').eq('workspace_id', workspace).maybeSingle();
      if (error) throw error;
      const timeZone = rules?.business_timezone || DEFAULT_TIME_ZONE;
      const range = rangeForPeriod({
        period: params.period || 'month', customStart: params.start, customEnd: params.end,
        now: now(), timeZone, reliableFrom
      });
      const [contacts, orders, manuallyIncluded] = await Promise.all([
        fetchAllRows(client, 'sms_contacts', 'id,phone,name', { orderBy: 'id', ascending: true }),
        fetchAllRows(client, 'sms_orders', 'id,contact_phone,status,created_at,woo_order_id,total', { thenBy: 'id' }),
        manualVIPPhones(client, workspace)
      ]);
      const result = buildVIPLeaderboard({
        contacts, orders, manuallyIncluded, range, exclusions: analyticsExclusions()
      });
      return {
        generatedAt: now().toISOString(),
        range: publicRange(range),
        currency: rules?.currency || 'USD',
        methodology: {
          version: SCORE_VERSION,
          explanation: 'Equal weight to paid-order frequency, total paid spend and average paid order value in the selected period.',
          components: [
            { key: 'paid_order_frequency', label: 'Order frequency', weight: 1 / 3 },
            { key: 'total_paid_spend', label: 'Total spend', weight: 1 / 3 },
            { key: 'average_order_value', label: 'Average order value', weight: 1 / 3 }
          ]
        },
        ...result
      };
    }
  };
}

module.exports = {
  SCORE_VERSION,
  buildVIPLeaderboard,
  createVIPLeaderboardService,
  eligibleOrders,
  publicRange
};
