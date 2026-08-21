'use strict';
/**
 * test/analytics-paging.test.js — the 20 August 2026 outage shape, in
 * lib/analytics/events.js.
 *
 * WHY THIS FILE EXISTS
 *   `inboundEvidence()` read every inbound message for one contact inside an
 *   attribution window with a single unpaged `.select()`, then passed the
 *   resulting `telnyx_message_id` array straight into `.in()`. Both halves are
 *   the outage:
 *
 *     * PostgREST caps a response at 1000 rows and does not say so, so the read
 *       silently went blind past row 1000 — quietly UNDER-counting the evidence
 *       a revenue claim rests on, which is the worst possible failure mode for
 *       an attribution system that is supposed to be conservative.
 *     * `.in()` serialises every value into the URL. At 907 contact phone
 *       numbers that was an 11,801-character filter and an
 *       UND_ERR_HEADERS_OVERFLOW. Telnyx message ids are 36-character UUIDs, so
 *       the same ceiling arrives at roughly 300 messages — well inside "an
 *       all-time range for a chatty customer".
 *
 *   `test/no-unbounded-in.test.js` existed the whole time and never saw it,
 *   because its scan was not recursive and `lib/analytics/` is nested.
 *
 * Offline: no network, no live database. Every client here is a fake.
 */

process.env.SUPABASE_URL ||= 'https://unit-test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'unit-test-service-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { chunkedIn, pagedSelect, inboundEvidence, deliveredReminders } = require('../lib/analytics/events');
const { PAGE_SIZE, IN_CHUNK_SIZE } = require('../lib/fetch-all-rows');

/**
 * A fake PostgREST builder. Records the filters applied to it and resolves
 * whatever `respond` returns, given the recorded state.
 */
function builder(state, respond) {
  const self = {
    eq(column, value) { state.filters.push(['eq', column, value]); return self; },
    gte(column, value) { state.filters.push(['gte', column, value]); return self; },
    lte(column, value) { state.filters.push(['lte', column, value]); return self; },
    not(column, op, value) { state.filters.push(['not', column, op, value]); return self; },
    in(column, values) { state.ins.push({ column, values }); return self; },
    order(column, options) { state.orders.push([column, options]); return self; },
    range(from, to) { state.range = [from, to]; return self; },
    then(resolve, reject) { return Promise.resolve(respond(state)).then(resolve, reject); }
  };
  return self;
}

function fakeClient(respond) {
  const calls = [];
  return {
    calls,
    from(table) {
      return {
        select(columns) {
          const state = { table, columns, filters: [], ins: [], orders: [], range: null };
          calls.push(state);
          return builder(state, respond);
        }
      };
    }
  };
}

function rows(count, prefix = 'id') {
  return Array.from({ length: count }, (_, index) => ({
    id: index,
    telnyx_message_id: `${prefix}-${index}`,
    message_id: `${prefix}-${index}`,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
  }));
}

// ── pagedSelect ────────────────────────────────────────────────────────────

test('pagedSelect keeps reading past the silent 1000-row PostgREST cap', async () => {
  const total = PAGE_SIZE * 2 + 137;
  const client = fakeClient(state => {
    const [from, to] = state.range;
    return { data: rows(total).slice(from, to + 1), error: null };
  });

  const result = await pagedSelect(client, 'sms_messages', 'id', b => b.eq('direction', 'inbound'));

  assert.equal(result.length, total, 'every row, not the first page');
  assert.equal(client.calls.length, 3, 'three pages for 2137 rows');
  assert.deepEqual(client.calls.map(call => call.range), [
    [0, PAGE_SIZE - 1],
    [PAGE_SIZE, PAGE_SIZE * 2 - 1],
    [PAGE_SIZE * 2, PAGE_SIZE * 3 - 1]
  ]);
  // Filters must be reapplied per page. A builder cannot be reused after it is
  // awaited, and a page fetched without the filters is a page of other
  // customers' messages.
  for (const call of client.calls) {
    assert.deepEqual(call.filters, [['eq', 'direction', 'inbound']]);
  }
});

test('pagedSelect stops on a short page rather than requesting forever', async () => {
  const client = fakeClient(() => ({ data: rows(3), error: null }));
  const result = await pagedSelect(client, 'sms_messages', 'id', b => b);
  assert.equal(result.length, 3);
  assert.equal(client.calls.length, 1);
});

test('pagedSelect surfaces an error instead of returning a short list', async () => {
  // The outage looked like "no data" rather than "a failure". A swallowed error
  // here would silently zero out a revenue claim's supporting evidence.
  const client = fakeClient(() => ({ data: null, error: { message: 'boom', code: '57014' } }));
  await assert.rejects(
    () => pagedSelect(client, 'sms_messages', 'id', b => b),
    error => error.message === 'boom'
  );
});

test('pagedSelect respects a maxRows ceiling and warns rather than looping', async () => {
  const client = fakeClient(state => ({ data: rows(PAGE_SIZE, `p${state.range[0]}`), error: null }));
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const result = await pagedSelect(client, 'sms_messages', 'id', b => b, { maxRows: PAGE_SIZE * 2 });
    assert.equal(result.length, PAGE_SIZE * 2);
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1, 'truncation must not be silent');
  assert.match(warnings[0], /truncated/);
});

// ── chunkedIn ──────────────────────────────────────────────────────────────

test('chunkedIn never puts more than IN_CHUNK_SIZE values in one URL', async () => {
  const ids = rows(907).map(row => row.telnyx_message_id); // the outage's exact count
  const client = fakeClient(state => ({
    data: state.ins[0].values.map(value => ({ message_id: value })),
    error: null
  }));

  const result = await chunkedIn(
    client, 'analytics_message_events', 'message_id',
    b => b.eq('trusted', true), 'message_id', ids
  );

  assert.equal(result.length, 907, 'no value is lost to chunking');
  assert.equal(client.calls.length, Math.ceil(907 / IN_CHUNK_SIZE));
  for (const call of client.calls) {
    assert.ok(call.ins[0].values.length <= IN_CHUNK_SIZE,
      `a chunk of ${call.ins[0].values.length} would grow the URL without bound`);
    assert.deepEqual(call.filters, [['eq', 'trusted', true]], 'filters reapplied per chunk');
  }
});

test('chunkedIn applies .in() before the caller filters, so .order() cannot break it', async () => {
  // `.order()` returns a transform builder in supabase-js v2, and a transform
  // builder has no `.in()`. Applying the caller's filters last is what makes an
  // ordered chunked query possible at all.
  const client = fakeClient(state => ({ data: [{ message_id: state.ins[0].values[0] }], error: null }));
  await chunkedIn(
    client, 'analytics_message_events', 'message_id,status',
    b => b.eq('provider', 'telnyx').order('occurred_at', { ascending: false }),
    'message_id', ['a', 'b']
  );
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].ins[0].values, ['a', 'b']);
  assert.deepEqual(client.calls[0].orders, [['occurred_at', { ascending: false }]]);
});

test('chunkedIn dedupes, drops nullish values, and short-circuits on an empty list', async () => {
  const client = fakeClient(state => ({ data: state.ins[0].values.map(v => ({ message_id: v })), error: null }));
  const result = await chunkedIn(
    client, 'analytics_message_events', 'message_id',
    b => b, 'message_id', ['a', 'a', null, 'b', undefined, 'b']
  );
  assert.deepEqual(result.map(row => row.message_id), ['a', 'b']);

  const empty = fakeClient(() => assert.fail('no request should be made for an empty list'));
  assert.deepEqual(await chunkedIn(empty, 't', 'c', b => b, 'c', []), []);
  assert.equal(empty.calls.length, 0);
});

test('chunkedIn surfaces a chunk error rather than returning a partial list', async () => {
  const client = fakeClient(state => (
    state.ins[0].values.includes('id-250')
      ? { data: null, error: { message: 'chunk failed' } }
      : { data: [], error: null }
  ));
  await assert.rejects(
    () => chunkedIn(client, 't', 'c', b => b, 'c', rows(400).map(r => r.telnyx_message_id)),
    error => error.message === 'chunk failed'
  );
});

// ── The real call sites ────────────────────────────────────────────────────

test('inboundEvidence pages the read and chunks the trust lookup', async () => {
  // 2500 inbound messages in one attribution window. Before this change the
  // read returned 1000 of them and the follow-up `.in()` carried 1000
  // 36-character ids into a single URL.
  const total = 2500;
  const all = rows(total, 'msg');
  const client = fakeClient(state => {
    if (state.table === 'sms_messages') {
      const [from, to] = state.range;
      return { data: all.slice(from, to + 1), error: null };
    }
    return { data: state.ins[0].values.map(value => ({ message_id: value })), error: null };
  });

  const evidence = await inboundEvidence(
    '+15551234567', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', client
  );

  assert.equal(evidence.length, total, 'evidence past row 1000 is no longer invisible');

  const reads = client.calls.filter(call => call.table === 'sms_messages');
  const trust = client.calls.filter(call => call.table === 'analytics_message_events');
  assert.equal(reads.length, 3, '2500 rows is three pages');
  assert.equal(trust.length, Math.ceil(total / IN_CHUNK_SIZE));
  for (const call of trust) {
    assert.ok(call.ins[0].values.length <= IN_CHUNK_SIZE);
  }

  // The window filters must survive paging, or the evidence belongs to the
  // wrong customer or the wrong window.
  for (const read of reads) {
    assert.deepEqual(read.filters, [
      ['eq', 'contact_phone', '+15551234567'],
      ['eq', 'direction', 'inbound'],
      ['gte', 'created_at', '2026-01-01T00:00:00Z'],
      ['lte', 'created_at', '2026-02-01T00:00:00Z']
    ]);
  }
});

test('inboundEvidence still returns only messages with a trusted signed event', async () => {
  // Chunking must not weaken the trust filter. AGENTS.md: never fall back to an
  // unsigned message status for revenue attribution.
  const all = rows(5, 'msg');
  const trustedIDs = new Set(['msg-1', 'msg-3']);
  const client = fakeClient(state => {
    if (state.table === 'sms_messages') {
      const [from, to] = state.range;
      return { data: all.slice(from, to + 1), error: null };
    }
    return {
      data: state.ins[0].values.filter(value => trustedIDs.has(value)).map(value => ({ message_id: value })),
      error: null
    };
  });

  const evidence = await inboundEvidence('+1555', 'a', 'b', client);
  assert.deepEqual(evidence.map(row => row.telnyx_message_id), ['msg-1', 'msg-3']);

  const trust = client.calls.find(call => call.table === 'analytics_message_events');
  assert.deepEqual(trust.filters, [
    ['eq', 'workspace_id', 'vici'],
    ['eq', 'provider', 'telnyx'],
    ['eq', 'event_type', 'message.received'],
    ['eq', 'trusted', true]
  ]);
});

test('inboundEvidence makes no request at all without a phone and a window', async () => {
  const client = fakeClient(() => assert.fail('no query should be issued'));
  assert.deepEqual(await inboundEvidence(null, 'a', 'b', client), []);
  assert.deepEqual(await inboundEvidence('+1555', null, 'b', client), []);
  assert.deepEqual(await inboundEvidence('+1555', 'a', null, client), []);
  assert.equal(client.calls.length, 0);
});

test('deliveredReminders chunks its status lookup and keeps latest-status-wins', async () => {
  const logs = [
    { id: 1, telnyx_message_id: 'm1', flow_type: 'failed-msg1', sent_at: '2026-01-01T00:00:00Z' },
    { id: 2, telnyx_message_id: 'm2', flow_type: 'failed-msg2', sent_at: '2026-01-02T00:00:00Z' },
    { id: 3, telnyx_message_id: null, flow_type: 'hold-msg1', sent_at: '2026-01-03T00:00:00Z' }
  ];
  const events = [
    { message_id: 'm1', status: 'delivered', occurred_at: '2026-01-01T01:00:00Z' },
    { message_id: 'm1', status: 'sent', occurred_at: '2026-01-01T00:30:00Z' },
    { message_id: 'm2', status: 'failed', occurred_at: '2026-01-02T01:00:00Z' }
  ];
  const client = fakeClient(state => {
    if (state.table === 'sms_sent_log') {
      return { data: state.range[0] === 0 ? logs : [], error: null };
    }
    return { data: events.filter(event => state.ins[0].values.includes(event.message_id)), error: null };
  });

  const result = await deliveredReminders('12345', client);

  assert.deepEqual(result.map(row => row.delivery_status), ['delivered', 'failed', null],
    'the first event per id wins, and an id-less row gets no status');

  const read = client.calls.find(call => call.table === 'sms_sent_log');
  assert.deepEqual(read.ins[0].column, 'flow_type');
  assert.equal(read.ins[0].values.length, 7, 'the fixed payment-reminder vocabulary');
  assert.deepEqual(read.filters, [
    ['eq', 'order_id', '12345'],
    ['not', 'telnyx_message_id', 'is', null]
  ]);

  const lookup = client.calls.find(call => call.table === 'analytics_message_events');
  assert.deepEqual(lookup.ins[0].values, ['m1', 'm2'], 'only ids that exist, deduped');
});

test('deliveredReminders makes no status lookup when nothing was ever sent', async () => {
  const client = fakeClient(state => (
    state.table === 'sms_sent_log'
      ? { data: [], error: null }
      : assert.fail('there are no ids to look up')
  ));
  assert.deepEqual(await deliveredReminders('999', client), []);
  assert.equal(client.calls.length, 1);
});

// ── The structural guarantee ───────────────────────────────────────────────

test('lib/analytics/events.js passes no computed array straight into .in()', () => {
  // Belt and braces alongside test/no-unbounded-in.test.js, which now scans
  // this directory. Asserted on the source because the failure mode is a shape,
  // not a behaviour: it only manifests once the list is long enough.
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'analytics', 'events.js'), 'utf8');

  const lines = source.split('\n');
  const offenders = [];
  lines.forEach((line, index) => {
    const code = line.replace(/\/\/.*$/, '');
    const match = code.match(/\.in\(\s*['"`][^'"`]+['"`]\s*,\s*([^)]+)\)/);
    if (!match) return;
    const argument = match[1].trim();
    if (argument.startsWith('[') && !argument.includes('...')) return;
    const justified = [line, lines[index - 1], lines[index - 2], lines[index - 3]]
      .some(candidate => /bounded:/i.test(candidate || ''));
    if (!justified) offenders.push(`${index + 1}: ${line.trim()}`);
  });
  assert.deepStrictEqual(offenders, []);

  // And no unpaged read remains: every `.select(` on a client must reach a
  // `.range(`, which is what pagedSelect provides.
  assert.match(source, /function pagedSelect/);
  assert.match(source, /\.range\(from, from \+ PAGE_SIZE - 1\)/);
});
