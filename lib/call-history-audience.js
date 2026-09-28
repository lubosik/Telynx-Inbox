'use strict';

const { readAllInboxRows, readInboxAudience } = require('./inbox-audience');
const { isInternalSIPLog } = require('./call-status');
const { normalisePhone } = require('./phone');

// Scope before pagination. Filtering one mixed 50-call page would incorrectly
// report no VIP history when those calls are simply on the next page.
async function readCallHistory({ client, audience = 'all', phone = null, page = 1, pageSize = 50 }) {
  const scope = await readInboxAudience(client, audience);
  const requestedPhone = phone ? normalisePhone(phone) : null;
  if (phone && !requestedPhone) {
    const error = new Error('Enter a valid customer phone number.');
    error.status = 400;
    throw error;
  }
  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  if (scope.audience === 'all') {
    // Preserve the established cheap legacy history read. Only customer-space
    // views need the whole population to scope before pagination.
    let query = client.from('call_logs').select('*')
      .order('started_at', { ascending: false }).order('id', { ascending: false })
      .range((safePage - 1) * pageSize, safePage * pageSize - 1);
    if (requestedPhone) query = query.eq('contact_phone', requestedPhone);
    const { data, error } = await query;
    if (error) throw error;
    return (data || []).filter(row => !isInternalSIPLog(row));
  }
  const rows = await readAllInboxRows(client, 'call_logs', '*', {
    orderBy: 'started_at', thenBy: 'id',
    filter: requestedPhone ? query => query.eq('contact_phone', requestedPhone) : null
  });
  const matching = scope.filter(rows.filter(row => !isInternalSIPLog(row)));
  return matching.slice((safePage - 1) * pageSize, safePage * pageSize)
    .map(row => ({ ...row, customer_tier: scope.tier(row.contact_phone) }));
}

module.exports = { readCallHistory };
