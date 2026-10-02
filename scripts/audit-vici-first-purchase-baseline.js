'use strict';

/**
 * Read-only refresh of the 1 October registered/no-paid snapshot against Woo.
 * It does not calculate a storewide registration conversion rate: the input
 * contains nonbuyers only, not every registration in the denominator.
 */
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const { csvRows } = require('./audit-vici-registration-consent');
const { normalisePhone } = require('../lib/phone');

const SOURCE = '/Users/ghost/Desktop/Vici_Registration_Omnisend_Woo_Verified_2026-10-01.csv';
const PAID = new Set(['processing', 'completed', 'shipped', 'delivered']);

function sourceIndex(rows) {
  const byID = new Map();
  const byEmail = new Map();
  for (const row of rows) {
    const id = Number(row.wp_user_id);
    if (!Number.isSafeInteger(id) || id < 1 || Number(row.woo_paid_order_count) !== 0 || byID.has(id)) {
      throw new Error('Invalid or duplicate cohort WordPress user ID.');
    }
    byID.set(id, row);
    const email = String(row.email || '').trim().toLowerCase();
    if (email) {
      byEmail.set(email, byEmail.has(email) ? null : row);
    }
  }
  return { byID, byEmail };
}

function paidOrderMatches(order, index) {
  if (!PAID.has(String(order?.status || '').toLowerCase()) || (!order?.date_paid && !order?.date_paid_gmt)) return null;
  const customerID = Number(order.customer_id);
  if (customerID > 0) return index.byID.get(customerID) || null;
  const email = String(order?.billing?.email || '').trim().toLowerCase();
  return email ? index.byEmail.get(email) || null : null;
}

function summarize(rows, orders) {
  const index = sourceIndex(rows);
  const matched = new Map();
  for (const order of orders) {
    const row = paidOrderMatches(order, index);
    if (!row) continue;
    const id = Number(row.wp_user_id);
    const prior = matched.get(id);
    const paidAt = Date.parse(order.date_paid_gmt || order.date_paid || '');
    if (!Number.isFinite(paidAt)) continue;
    if (!prior || paidAt < prior.paidAt) matched.set(id, { paidAt, orderID: order.id });
  }
  const phoneUsers = rows.filter(row => Boolean(normalisePhone(row.phone)));
  return { sourceCohort: rows.length, sourcePhoneUsers: phoneUsers.length,
    nowWithFirstPaidOrder: matched.size,
    phoneUsersNowWithFirstPaidOrder: phoneUsers.filter(row => matched.has(Number(row.wp_user_id))).length,
    stillWithoutPaidOrder: rows.length - matched.size,
    phoneUsersStillWithoutPaidOrder: phoneUsers.filter(row => !matched.has(Number(row.wp_user_id))).length,
    note: 'This is a refreshed fixed nonbuyer cohort, not a registration-to-purchase conversion rate.' };
}

async function readWooOrders(env = process.env) {
  if (!env.WC_CONSUMER_KEY || !env.WC_CONSUMER_SECRET) throw new Error('Woo read credentials are required.');
  const base = new URL(env.WC_URL || 'https://vicipeptides.com/wp-json/wc/v3');
  if (base.protocol !== 'https:') throw new Error('Woo order audit requires HTTPS.');
  const auth = Buffer.from(`${env.WC_CONSUMER_KEY}:${env.WC_CONSUMER_SECRET}`).toString('base64');
  const orders = [];
  for (let page = 1; page <= 1000; page++) {
    const url = new URL(base.toString().replace(/\/$/, '') + '/orders');
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    url.searchParams.set('orderby', 'id');
    url.searchParams.set('order', 'asc');
    const response = await fetch(url, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Woo order audit failed: HTTP ${response.status}.`);
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error('Woo returned an invalid order page.');
    orders.push(...batch);
    const pages = Number(response.headers.get('x-wp-totalpages')) || page;
    if (page >= pages || batch.length === 0) return orders;
  }
  throw new Error('Woo order audit exceeded the 1,000-page safety limit.');
}

async function main() {
  const rows = csvRows(fs.readFileSync(SOURCE, 'utf8'));
  const orders = await readWooOrders();
  console.log(JSON.stringify({ auditedAt: new Date().toISOString(), wooOrdersRead: orders.length,
    ...summarize(rows, orders) }, null, 2));
}

if (require.main === module) main().catch(error => {
  console.error(`First-purchase audit stopped: ${error.message}`);
  process.exitCode = 1;
});

module.exports = { sourceIndex, paidOrderMatches, summarize };
