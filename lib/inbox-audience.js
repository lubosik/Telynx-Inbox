'use strict';

const { fetchAllRows } = require('./fetch-all-rows');
const { enrichVIPContacts, readVIPManualMembership } = require('./vip-inbox-snapshot');
const { normalisePhone } = require('./phone');

function parseAudience(value) {
  if (value === undefined || value === null || value === '') return 'all';
  if (typeof value === 'string' && ['all', 'main', 'vip'].includes(value)) return value;
  throw Object.assign(new Error('Choose Main, VIP or All Customers, then try again.'), {
    status: 400, code: 'INVALID_INBOX_AUDIENCE'
  });
}

// Full-population counts must not silently become a truncated page. Preserve
// the existing reader's stable ordering and reject its explicit safety ceiling.
async function readAllInboxRows(client, table, columns, options = {}) {
  const maxRows = options.maxRows ?? 100000;
  const rows = await fetchAllRows(client, table, columns, { ...options, maxRows });
  if (rows.length >= maxRows) {
    throw Object.assign(new Error('This customer view is too large to load completely. Please contact support; no messages or schedules have been changed.'), {
      status: 503, code: 'INBOX_AUDIENCE_INCOMPLETE'
    });
  }
  return rows;
}

async function readInboxAudience(client, raw) {
  const audience = parseAudience(raw);
  if (audience === 'all') {
    return { audience, includes: () => true, tier: () => null,
      filter: rows => rows, vipPhones: new Set() };
  }
  try {
    const contacts = await readAllInboxRows(client, 'sms_contacts', 'id,phone', {
      orderBy: 'id', ascending: true
    });
    const [orders, membership] = await Promise.all([
      readAllInboxRows(client, 'sms_orders', 'id,contact_phone,status,created_at,woo_order_id,total', { thenBy: 'id' }),
      readVIPManualMembership(client)
    ]);
    const snapshot = enrichVIPContacts(contacts, orders, membership);
    const vipPhones = new Set(snapshot.filter(contact => contact.customer_tier === 'vip')
      .map(contact => normalisePhone(contact.phone)).filter(Boolean));
    const tier = phone => vipPhones.has(normalisePhone(phone)) ? 'vip' : 'standard';
    const includes = phone => (tier(phone) === 'vip') === (audience === 'vip');
    return { audience, tier, includes, vipPhones,
      filter: (rows, phoneField = 'contact_phone') => rows.filter(row => includes(row[phoneField])) };
  } catch (error) {
    if (error.code === 'INBOX_AUDIENCE_INCOMPLETE') throw error;
    throw Object.assign(new Error('We could not verify the Main and VIP customer lists. Please refresh and try again; no messages or schedules have been changed.'), {
      status: 503, code: 'INBOX_AUDIENCE_UNAVAILABLE', cause: error
    });
  }
}

module.exports = { parseAudience, readAllInboxRows, readInboxAudience };
