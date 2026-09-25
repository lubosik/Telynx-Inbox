'use strict';

const { normalisePhone } = require('./phone');
const { PAID_STATUSES } = require('./campaigns/segment-facts');
const {
  VIP_MIN_LIFETIME_SPEND,
  VIP_MIN_PAID_ORDERS,
  VIP_SEGMENT_KEY
} = require('./vip-customers');

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 2_000;
const membershipCache = new Map();

function configuredVIPNumber(env = process.env) {
  return normalisePhone(env.VIP_INBOX_PHONE_NUMBER);
}

function isVIPInboxNumber(value, env = process.env) {
  const configured = configuredVIPNumber(env);
  return Boolean(configured && normalisePhone(value) === configured);
}

function cached(phone, now) {
  const entry = membershipCache.get(phone);
  if (!entry || entry.expiresAt <= now) {
    membershipCache.delete(phone);
    return null;
  }
  return entry.value;
}

function remember(phone, value, now) {
  if (membershipCache.size >= MAX_CACHE_ENTRIES) {
    membershipCache.delete(membershipCache.keys().next().value);
  }
  membershipCache.set(phone, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

async function automaticMembership(client, phone) {
  const { data, error } = await client
    .from('sms_orders')
    .select('id,woo_order_id,status,total,created_at')
    .eq('contact_phone', phone);
  if (error) throw error;

  const orders = new Map();
  for (const row of data || []) {
    if (!PAID_STATUSES.has(String(row.status || '').toLowerCase())) continue;
    const orderID = String(row.woo_order_id ?? row.id ?? '');
    if (!orderID || orders.has(orderID)) continue;
    const total = Number(row.total);
    orders.set(orderID, Number.isFinite(total) && total > 0 ? total : 0);
  }
  const lifetimeSpend = [...orders.values()].reduce((sum, value) => sum + value, 0);
  return orders.size >= VIP_MIN_PAID_ORDERS && lifetimeSpend >= VIP_MIN_LIFETIME_SPEND;
}

async function manualMembership(client, phone) {
  const segmentResult = await client
    .from('sms_campaign_segments')
    .select('id')
    .eq('workspace_id', 'vici')
    .eq('segment_key', VIP_SEGMENT_KEY)
    .is('archived_at', null)
    .maybeSingle();
  if (segmentResult.error) throw segmentResult.error;
  if (!segmentResult.data?.id) return false;

  const memberResult = await client
    .from('sms_campaign_segment_members')
    .select('contact_phone')
    .eq('workspace_id', 'vici')
    .eq('segment_id', segmentResult.data.id)
    .eq('contact_phone', phone)
    .maybeSingle();
  if (memberResult.error) throw memberResult.error;
  return Boolean(memberResult.data);
}

/**
 * Resolve the same permanent VIP definition the inbox shows from authoritative
 * paid-order and segment records. A client cannot select the sending number.
 */
async function isVIPCustomer({ client, phone, now = Date.now() }) {
  const normalised = normalisePhone(phone);
  if (!normalised) return false;
  const hit = cached(normalised, now);
  if (hit !== null) return hit;

  try {
    const automatic = await automaticMembership(client, normalised);
    if (automatic) return remember(normalised, true, now);
    return remember(normalised, await manualMembership(client, normalised), now);
  } catch (error) {
    // Sender selection must fail closed to the established main number. It
    // must never block a permitted reply or guess that somebody is a VIP.
    console.warn(`[VIP INBOX] Using the main number because membership could not be checked (${error.code || 'read_failed'}).`);
    return false;
  }
}

async function senderNumberFor({ client, phone, env = process.env }) {
  const main = normalisePhone(env.TELNYX_PHONE_NUMBER);
  const vip = configuredVIPNumber(env);
  if (!vip || vip === main) return main;
  return await isVIPCustomer({ client, phone }) ? vip : main;
}

function resetVIPMembershipCache() {
  membershipCache.clear();
}

module.exports = {
  configuredVIPNumber,
  isVIPCustomer,
  isVIPInboxNumber,
  resetVIPMembershipCache,
  senderNumberFor
};
