'use strict';
/**
 * lib/assistant/customer-lookup.js — the reads that let somebody talk about a
 * named customer rather than about aggregates.
 *
 * Queries Supabase the same way routes/contacts.js does. There is no contact
 * service to call, and inventing one here would be a second implementation of
 * the same reads that could drift from what the app's own screens show.
 *
 * EVERY READ IS BOUNDED
 *   These feed a language model, and an unbounded result is both a cost and a
 *   privacy problem: the wider the net, the more customer records leave the
 *   building for a question about one person. Limits are small on purpose.
 *
 * WHAT COMES BACK IS SHAPED, NOT RAW
 *   A raw contact row carries GHL ids, sync timestamps and DND flags. None of
 *   it helps the model answer and all of it is more personal data in a prompt.
 */

/**
 * Resolved on first use, never at import.
 *
 * db.js builds its client at module load and throws "supabaseUrl is required"
 * without a .env. CI has no .env, so a top level require here would fail every
 * test that so much as imports this file, for a reason unrelated to any of
 * them. The same trap already caught scripts/seed-product-inventory-baseline.js.
 */
const { selectIn } = require('../fetch-all-rows');

let cachedClient = null;
function defaultClient() {
  if (!cachedClient) cachedClient = require('../../db').supabase;
  return cachedClient;
}

const MAX_MATCHES = 8;
const MAX_ORDERS = 12;
const MAX_MESSAGES = 12;

function digitsOnly(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

/** The values in a payload that should be tokenised before they reach a model. */
function sensitiveValuesIn(payload) {
  const found = new Set();
  const walk = node => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string' && /phone|contactPhone|email/i.test(key) && value.length >= 3) {
        found.add(value);
      } else if (typeof value === 'object') {
        walk(value);
      }
    }
  };
  walk(payload);
  return [...found];
}

/**
 * Find people by name or phone.
 *
 * A phone-shaped query matches on digits so "0414 555 123", "+61414555123" and
 * "414555123" all find the same person. Anything else is a name search.
 */
async function findCustomers({ query, client = defaultClient() }) {
  const raw = String(query || '').trim();
  if (raw.length < 2) return { matches: [], reason: 'query_too_short' };

  const digits = digitsOnly(raw);
  const looksLikePhone = digits.length >= 6;
  const request = client
    .from('sms_contacts')
    .select('phone, name, first_name, last_name, email, city, state, total_messages, last_seen')
    .limit(MAX_MATCHES);

  const { data, error } = looksLikePhone
    ? await request.ilike('phone', `%${digits.slice(-9)}%`)
    : await request.ilike('name', `%${raw}%`);
  if (error) throw new Error(`contact search failed: ${error.message}`);

  return {
    matches: (data || []).map(row => ({
      phone: row.phone,
      name: row.name || [row.first_name, row.last_name].filter(Boolean).join(' ') || null,
      email: row.email || null,
      location: [row.city, row.state].filter(Boolean).join(', ') || null,
      lastSeen: row.last_seen || null
    }))
  };
}

/**
 * One customer: who they are, what they have bought, and when.
 *
 * The order list is what makes this worth having. "What did they last order"
 * is the question somebody actually asks before picking up the phone.
 */
async function customerProfile({ phone, client = defaultClient() }) {
  const normalised = String(phone || '').trim();
  if (!normalised) return { found: false, reason: 'phone_required' };

  const [contactResult, orderResult] = await Promise.all([
    client.from('sms_contacts')
      .select('phone, name, first_name, last_name, email, city, state, total_messages, first_seen, last_seen, opted_out')
      .eq('phone', normalised).maybeSingle(),
    client.from('sms_orders')
      .select('woo_order_id, status, total, items, created_at')
      .eq('contact_phone', normalised)
      .order('created_at', { ascending: false })
      .limit(MAX_ORDERS)
  ]);
  if (contactResult.error) throw new Error(`contact read failed: ${contactResult.error.message}`);
  if (orderResult.error) throw new Error(`order read failed: ${orderResult.error.message}`);
  if (!contactResult.data) return { found: false, reason: 'no_such_customer' };

  const contact = contactResult.data;
  const orders = (orderResult.data || []).map(order => {
    let items = order.items;
    if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = null; } }
    return {
      reference: order.woo_order_id,
      status: order.status,
      total: order.total,
      placedAt: order.created_at,
      bought: (Array.isArray(items) ? items : [])
        .map(item => item?.name)
        .filter(Boolean)
        .slice(0, 6)
    };
  });

  const paid = orders.filter(order => ['processing', 'completed', 'shipped', 'delivered']
    .includes(String(order.status || '').toLowerCase()));

  return {
    found: true,
    customer: {
      phone: contact.phone,
      name: contact.name || [contact.first_name, contact.last_name].filter(Boolean).join(' ') || null,
      email: contact.email || null,
      location: [contact.city, contact.state].filter(Boolean).join(', ') || null,
      optedOut: contact.opted_out === true,
      firstSeen: contact.first_seen || null,
      lastSeen: contact.last_seen || null
    },
    orderCount: paid.length,
    lastOrder: paid[0] || null,
    // Capped rather than complete. A model does not answer better for having
    // forty orders, and every extra one is more of somebody's purchase history
    // in a prompt.
    recentOrders: paid.slice(0, 6)
  };
}

/** The most recent inbound messages, so "what are people saying" has an answer. */
async function recentConversations({ client = defaultClient(), limit = MAX_MESSAGES } = {}) {
  const { data, error } = await client
    .from('sms_messages')
    .select('contact_phone, direction, body, created_at')
    .eq('direction', 'inbound')
    .order('created_at', { ascending: false })
    .limit(Math.min(limit, MAX_MESSAGES));
  if (error) throw new Error(`conversation read failed: ${error.message}`);

  const rows = data || [];

  // NAMES, NOT JUST NUMBERS.
  //
  // Without this the assistant could report what people were asking about and
  // then could not say who any of them were, which makes the answer useless
  // for the thing it is for: deciding who to call back.
  //
  // selectIn chunks, because a bare .in() serialises every value into the URL.
  const phones = [...new Set(rows.map(row => row.contact_phone).filter(Boolean))];
  const contacts = phones.length
    ? await selectIn(client, 'sms_contacts', 'phone, name, first_name, last_name', 'phone', phones)
    : [];
  const nameByPhone = new Map(contacts.map(row => [
    row.phone,
    row.name || [row.first_name, row.last_name].filter(Boolean).join(' ') || null
  ]));

  return {
    messages: rows.map(row => ({
      phone: row.contact_phone,
      name: nameByPhone.get(row.contact_phone) || null,
      // Truncated. The model is summarising activity, not reading mail, and a
      // long message body is the most personal thing in this entire payload.
      said: String(row.body || '').slice(0, 220),
      at: row.created_at
    }))
  };
}

module.exports = {
  MAX_MATCHES,
  MAX_MESSAGES,
  MAX_ORDERS,
  customerProfile,
  findCustomers,
  recentConversations,
  sensitiveValuesIn
};
