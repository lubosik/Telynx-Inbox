'use strict';

const { normalisePhone } = require('./phone');
const { fetchAllRows } = require('./fetch-all-rows');
const { buildCustomerFacts } = require('./campaigns/segment-facts');
const {
  automaticVIP,
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

function cached(phone, now, client) {
  const entry = membershipCache.get(phone);
  if (!entry || entry.client !== client || entry.expiresAt <= now) {
    membershipCache.delete(phone);
    return null;
  }
  return entry.value;
}

function remember(phone, value, now, client) {
  if (membershipCache.size >= MAX_CACHE_ENTRIES) {
    membershipCache.delete(membershipCache.keys().next().value);
  }
  membershipCache.set(phone, { value, client, expiresAt: now + CACHE_TTL_MS });
  return value;
}

async function automaticMembership(client, phone) {
  const data = await fetchAllRows(client, 'sms_orders',
    'id,contact_phone,woo_order_id,status,total,created_at', {
      filter: query => query.eq('contact_phone', phone),
      orderBy: 'created_at', thenBy: 'id'
    });

  const { facts } = buildCustomerFacts({ contacts: [{ phone }], orders: data });
  return automaticVIP(facts.find(fact => fact.contactPhone === phone));
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
    .eq('membership_source', 'forced_include')
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
  const hit = cached(normalised, now, client);
  if (hit !== null) return hit;

  try {
    const automatic = await automaticMembership(client, normalised);
    if (automatic) return remember(normalised, true, now, client);
    return remember(normalised, await manualMembership(client, normalised), now, client);
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

function invalidateVIPMembership(phone) {
  const normalised = normalisePhone(phone);
  if (normalised) membershipCache.delete(normalised);
}

module.exports = {
  configuredVIPNumber,
  isVIPCustomer,
  isVIPInboxNumber,
  invalidateVIPMembership,
  resetVIPMembershipCache,
  senderNumberFor
};
