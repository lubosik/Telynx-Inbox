'use strict';

const { fetchAllRows } = require('./fetch-all-rows');
const { buildCustomerFacts } = require('./campaigns/segment-facts');
const { normalisePhone } = require('./phone');
const { classifyVIPCustomer, VIP_SEGMENT_KEY } = require('./vip-customers');

let warnedVIPRead = false;

// Optional manual membership may be unavailable before the seed migration.
// Automatic membership remains derived from paid orders, not consent or UI state.
async function readVIPManualMembership(client) {
  try {
    const { data: segment, error } = await client.from('sms_campaign_segments')
      .select('id').eq('workspace_id', 'vici').eq('segment_key', VIP_SEGMENT_KEY)
      .is('archived_at', null).maybeSingle();
    if (error) throw error;
    if (!segment) return { segmentID: null, manuallyIncluded: new Set() };
    const members = await fetchAllRows(client, 'sms_campaign_segment_members',
      'contact_phone,membership_source', {
        filter: query => query.eq('workspace_id', 'vici').eq('segment_id', segment.id),
        orderBy: 'contact_phone', ascending: true
      });
    if (members.length >= 100000) throw Object.assign(new Error('VIP membership read exceeded its complete-read ceiling.'), {
      status: 503, code: 'INBOX_AUDIENCE_INCOMPLETE'
    });
    return {
      segmentID: segment.id,
      manuallyIncluded: new Set(members
        .filter(row => row.membership_source === 'forced_include')
        .map(row => normalisePhone(row.contact_phone)).filter(Boolean))
    };
  } catch (error) {
    // An unapplied optional seed may legitimately have no manual members.
    // A network/permission/server error does not mean zero members: retain
    // the client's last good snapshot rather than silently move VIPs to Main.
    const missingSchema = ['42P01', '42703', 'PGRST204', 'PGRST205'].includes(error.code);
    if (!missingSchema) throw error;
    if (!warnedVIPRead) {
      warnedVIPRead = true;
      console.warn(`[VIP] Manual membership unavailable; paid-order membership remains active (${error.code || 'read_failed'}).`);
    }
    return { segmentID: null, manuallyIncluded: new Set() };
  }
}

function enrichVIPContacts(contacts, orders, membership, { env = process.env, now = new Date() } = {}) {
  const { facts } = buildCustomerFacts({ contacts, orders }, { now });
  const byPhone = new Map(facts.map(fact => [fact.contactPhone, fact]));
  return contacts.map(contact => {
    const phone = normalisePhone(contact.phone);
    const vip = classifyVIPCustomer(byPhone.get(phone) || {}, {
      manuallyIncluded: membership.manuallyIncluded.has(phone),
      segmentID: membership.segmentID
    });
    return {
      ...contact, ...vip,
      reply_from_number: vip.customer_tier === 'vip'
        ? (normalisePhone(env.VIP_INBOX_PHONE_NUMBER) || normalisePhone(env.TELNYX_PHONE_NUMBER))
        : normalisePhone(env.TELNYX_PHONE_NUMBER)
    };
  });
}

async function readVIPContactSnapshot(client, contacts, options) {
  if (!contacts.length) return [];
  const [orders, membership] = await Promise.all([
    fetchAllRows(client, 'sms_orders', 'id,contact_phone,status,created_at,woo_order_id,total', {
      thenBy: 'id',
      filter: contacts.length === 1
        ? query => query.eq('contact_phone', normalisePhone(contacts[0].phone)) : null
    }),
    readVIPManualMembership(client)
  ]);
  return enrichVIPContacts(contacts, orders, membership, options);
}

module.exports = { enrichVIPContacts, readVIPContactSnapshot, readVIPManualMembership };
