'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readCallHistory } = require('../lib/call-history-audience');
const { countUnseenMissedCalls, markMissedCallsSeen } = require('../lib/missed-calls');

const VIP = '+15555550100';
const MAIN = '+15555550101';

function fakeClient(extra = {}) {
  const tables = {
    sms_contacts: [{ id: 1, phone: VIP }, { id: 2, phone: MAIN }],
    sms_orders: Array.from({ length: 3 }, (_, index) => ({ id: index + 1,
      woo_order_id: index + 1, contact_phone: VIP, status: 'completed', total: 200,
      created_at: '2026-01-01T12:00:00Z' })),
    sms_campaign_segments: [], sms_campaign_segment_members: [], call_logs: [], ...extra
  };
  return { tables, from(table) {
    const filters = []; const ordering = [];
    let range = null; let patch = null; let single = false;
    const query = {
      select() { return query; },
      eq(key, value) { filters.push(row => row[key] === value); return query; },
      is(key, value) { filters.push(row => (row[key] ?? null) === value); return query; },
      in(key, values) { filters.push(row => values.includes(row[key])); return query; },
      order(key, options = {}) { ordering.push([key, options.ascending !== false]); return query; },
      range(from, to) { range = [from, to]; return query; },
      limit(limit) { range = [0, limit - 1]; return query; },
      update(value) { patch = value; return query; },
      maybeSingle() { single = true; return query; },
      then(resolve, reject) {
        let rows = (tables[table] || []).filter(row => filters.every(filter => filter(row)));
        const count = rows.length;
        rows.sort((a, b) => {
          for (const [key, ascending] of ordering) {
            if (a[key] === b[key]) continue;
            return (a[key] > b[key] ? 1 : -1) * (ascending ? 1 : -1);
          }
          return 0;
        });
        if (range) rows = rows.slice(range[0], range[1] + 1);
        if (patch) for (const row of rows) Object.assign(row, patch);
        return Promise.resolve({ data: single ? rows[0] || null : rows, count, error: null }).then(resolve, reject);
      }
    };
    return query;
  } };
}

function call(id, phone, extra = {}) {
  return { id, contact_phone: phone, direction: 'inbound', status: 'missed',
    started_at: new Date(Date.UTC(2026, 8, 28, 12, 0, id)).toISOString(),
    seen_at: null, from_number: phone, to_number: '+13054043184', ...extra };
}

test('VIP history includes old main-line calls and scopes before paging', async () => {
  const client = fakeClient({ call_logs: [call(1, VIP),
    ...Array.from({ length: 60 }, (_, index) => call(index + 2, MAIN))] });
  const result = await readCallHistory({ client, audience: 'vip', page: 1 });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 1);
  assert.equal(result[0].customer_tier, 'vip');
  assert.equal(result[0].to_number, '+13054043184');
});

test('Main history contains standard and unknown customers without duplicating VIP calls', async () => {
  const unknown = '+15555550199';
  const client = fakeClient({ call_logs: [call(1, VIP), call(2, MAIN), call(3, unknown)] });
  const main = await readCallHistory({ client, audience: 'main' });
  assert.deepEqual(main.map(row => row.id), [3, 2]);
  const all = await readCallHistory({ client });
  assert.equal(all.length, 3);
});

test('scoped missed counts and mark-seen never clear the other inbox', async () => {
  const client = fakeClient({ call_logs: [call(1, VIP), call(2, MAIN),
    call(3, VIP, { status: 'completed' }), call(4, VIP, { direction: 'outbound' })] });
  assert.equal(await countUnseenMissedCalls({ client, audience: 'vip' }), 1);
  assert.equal(await countUnseenMissedCalls({ client }), 2);
  assert.deepEqual(await markMissedCallsSeen({ client, audience: 'vip' }), { marked: 1, ok: true });
  assert.equal(client.tables.call_logs[1].seen_at, null);
  assert.equal(await countUnseenMissedCalls({ client }), 1);
});

test('rendered IDs further restrict mark-seen and cannot cross inbox scope', async () => {
  const client = fakeClient({ call_logs: [call(1, VIP), call(2, VIP), call(3, MAIN)] });
  assert.deepEqual(await markMissedCallsSeen({ client, audience: 'vip', ids: ['1', '3'] }),
    { marked: 1, ok: true });
  assert.equal(client.tables.call_logs[1].seen_at, null);
  assert.equal(client.tables.call_logs[2].seen_at, null);
  assert.deepEqual(await markMissedCallsSeen({ client, audience: 'vip', ids: [] }),
    { marked: 0, ok: true });
});

test('invalid phone history requests fail before any call is exposed', async () => {
  await assert.rejects(readCallHistory({ client: fakeClient(), phone: 'invalid' }),
    error => error.status === 400);
});

test('unverified membership fails scoped history instead of moving VIP calls into Main', async () => {
  const client = { from() { throw new Error('Database unavailable'); } };
  await assert.rejects(readCallHistory({ client, audience: 'main' }),
    error => error.code === 'INBOX_AUDIENCE_UNAVAILABLE');
});

test('unknown audience is rejected rather than interpreted as Main', async () => {
  await assert.rejects(readCallHistory({ client: fakeClient(), audience: 'unknown' }),
    error => error.status === 400);
});

test('invalid mark-seen IDs cannot clear any inbox', async () => {
  const client = fakeClient({ call_logs: [call(1, VIP), call(2, MAIN)] });
  assert.deepEqual(await markMissedCallsSeen({ client, audience: 'vip', ids: ['not-an-id'] }),
    { marked: 0, ok: false });
  assert.ok(client.tables.call_logs.every(row => row.seen_at === null));
});
