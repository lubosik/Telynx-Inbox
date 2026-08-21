'use strict';
/**
 * test/audit-api.test.js — the read API.
 *
 * The fake Supabase client below throws if `.in()` is ever called. That is
 * deliberate: the 20 August 2026 inbox outage was an `.in()` holding 907 values,
 * which overflowed the request URL. This API must reach the same data with
 * `.eq()` on stored columns and keyset pagination, and a future edit that
 * reintroduces the dangerous shape fails here as well as in
 * test/no-unbounded-in.test.js.
 *
 * Offline: no network, no live database.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const createAuditRouter = require('../routes/audit');

function routeHandler(router, routePath) {
  const layer = router.stack.find(entry => entry.route?.path === routePath);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function routeMethods(router) {
  return router.stack
    .filter(entry => entry.route)
    .flatMap(entry => Object.keys(entry.route.methods));
}

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(payload) { this.payload = payload; return this; }
  };
}

/**
 * @param {object[]} rows      the table contents
 * @param {object|null} error  an error every query should return instead
 */
function fakeAuditClient(rows, error = null) {
  const seen = { filters: [], selects: [] };

  function builder() {
    const predicates = [];
    let limit = Infinity;
    let ascending = false;
    let head = false;
    let counting = false;

    const self = {
      select(columns, options) {
        seen.selects.push(columns);
        if (options?.head) head = true;
        if (options?.count) counting = true;
        return self;
      },
      eq(column, value) {
        seen.filters.push(['eq', column, value]);
        predicates.push(row => row[column] === value);
        return self;
      },
      neq(column, value) {
        seen.filters.push(['neq', column, value]);
        predicates.push(row => row[column] !== value);
        return self;
      },
      lt(column, value) {
        seen.filters.push(['lt', column, value]);
        predicates.push(row => row[column] < value);
        return self;
      },
      gte(column, value) {
        predicates.push(row => String(row[column]) >= String(value));
        return self;
      },
      lte(column, value) {
        predicates.push(row => String(row[column]) <= String(value));
        return self;
      },
      in() {
        throw new Error('.in() must never be used by the audit read API — it serialises every value into the request URL.');
      },
      range() {
        throw new Error('.range() must never be used by the audit feed — offsets duplicate and skip rows on an append-head list.');
      },
      order(column, options) {
        assert.equal(column, 'id', 'the feed must order by the keyset column');
        ascending = Boolean(options?.ascending);
        return self;
      },
      limit(value) { limit = value; return self; },
      then(onFulfilled, onRejected) {
        return Promise.resolve().then(() => {
          if (error) return { data: null, error, count: null };
          let matched = rows.filter(row => predicates.every(predicate => predicate(row)));
          matched.sort((a, b) => (ascending ? a.id - b.id : b.id - a.id));
          if (head || counting) return { data: null, error: null, count: matched.length };
          return { data: matched.slice(0, limit), error: null, count: matched.length };
        }).then(onFulfilled, onRejected);
      }
    };
    return self;
  }

  return { seen, from: () => builder() };
}

function auditRow(id, overrides = {}) {
  return {
    id,
    workspace_id: 'vici',
    occurred_at: new Date(Date.UTC(2026, 7, 1, 0, 0, id % 60)).toISOString(),
    actor_type: 'user',
    actor_user_id: 7,
    actor_display_name: 'Dominic',
    actor_role: 'admin',
    event_type: 'automation.queue_item.cancelled',
    category: 'automations',
    visibility: 'feed',
    severity: 'notice',
    entity_type: 'scheduled_message',
    entity_id: String(id),
    contact_phone: '+13055551234',
    summary: `Cancelled queued message ${id}`,
    previous_state: { status: 'pending' },
    new_state: { status: 'cancelled' },
    changed_fields: ['status'],
    metadata: { scheduled_id: id },
    ip: null,
    user_agent: null,
    request_id: null,
    ...overrides
  };
}

// ── Shape ──────────────────────────────────────────────────────────────────

test('the audit trail exposes no write methods', () => {
  const router = createAuditRouter({ client: fakeAuditClient([]) });
  const methods = new Set(routeMethods(router));
  assert.deepEqual([...methods], ['get']);
  assert.equal(methods.has('post'), false);
  assert.equal(methods.has('patch'), false);
  assert.equal(methods.has('delete'), false);
});

// ── Feed ───────────────────────────────────────────────────────────────────

test('the default feed hides audit-only rows and filters category with .eq()', async () => {
  const client = fakeAuditClient([
    auditRow(3),
    auditRow(2, { category: 'calls', event_type: 'recording.played', visibility: 'audit' }),
    auditRow(1, { category: 'contacts', event_type: 'contact.created' })
  ]);
  const router = createAuditRouter({ client });
  const res = responseRecorder();
  await routeHandler(router, '/')({ query: { category: 'automations' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store, private');
  assert.deepEqual(res.payload.items.map(item => item.id), [3]);

  const categoryFilter = client.seen.filters.find(entry => entry[1] === 'category');
  assert.deepEqual(categoryFilter, ['eq', 'category', 'automations']);
  const visibilityFilter = client.seen.filters.find(entry => entry[1] === 'visibility');
  assert.deepEqual(visibilityFilter, ['neq', 'visibility', 'audit']);
});

test('includeAudit=true reveals the compliance-only rows', async () => {
  const client = fakeAuditClient([auditRow(2, { visibility: 'audit' }), auditRow(1)]);
  const router = createAuditRouter({ client });
  const res = responseRecorder();
  await routeHandler(router, '/')({ query: { includeAudit: 'true' } }, res);
  assert.deepEqual(res.payload.items.map(item => item.id), [2, 1]);
});

test('a single actor is filtered with .eq(); multi-actor selection is not offered', async () => {
  const client = fakeAuditClient([auditRow(2, { actor_user_id: 9 }), auditRow(1, { actor_user_id: 7 })]);
  const router = createAuditRouter({ client });
  const res = responseRecorder();
  await routeHandler(router, '/')({ query: { actor: '7' } }, res);
  assert.deepEqual(res.payload.items.map(item => item.id), [1]);
  assert.deepEqual(
    client.seen.filters.find(entry => entry[1] === 'actor_user_id'),
    ['eq', 'actor_user_id', 7]
  );

  const rejected = responseRecorder();
  await routeHandler(router, '/')({ query: { actor: '7,9' } }, rejected);
  assert.equal(rejected.statusCode, 400);
});

test('the actor name and role come off the row, so the read path performs no lookup', async () => {
  const client = fakeAuditClient([auditRow(1)]);
  const router = createAuditRouter({ client });
  const res = responseRecorder();
  await routeHandler(router, '/')({ query: {} }, res);
  assert.equal(res.payload.items[0].actor_display_name, 'Dominic');
  assert.equal(res.payload.items[0].actor_role, 'admin');
  // One table touched, one query issued.
  assert.equal(client.seen.selects.length, 1);
});

test('keyset pagination returns every row exactly once across pages', async () => {
  const rows = Array.from({ length: 250 }, (_, index) => auditRow(index + 1));
  const router = createAuditRouter({ client: fakeAuditClient(rows) });
  const handler = routeHandler(router, '/');

  const collected = [];
  let cursor;
  let pages = 0;
  for (;;) {
    const res = responseRecorder();
    await handler({ query: { limit: '100', ...(cursor ? { cursor: String(cursor) } : {}) } }, res);
    collected.push(...res.payload.items.map(item => item.id));
    pages += 1;
    if (!res.payload.hasMore) break;
    cursor = res.payload.nextCursor;
    assert.ok(cursor, 'hasMore must always come with a usable cursor');
    assert.ok(pages < 10, 'pagination must terminate');
  }

  assert.equal(pages, 3);
  assert.equal(collected.length, 250, 'no rows skipped');
  assert.equal(new Set(collected).size, 250, 'no rows duplicated');
  // Newest first, descending, with no gaps.
  assert.deepEqual(collected, rows.map(row => row.id).sort((a, b) => b - a));
});

test('a row appended mid-pagination cannot duplicate or displace an existing page', async () => {
  const rows = Array.from({ length: 60 }, (_, index) => auditRow(index + 1));
  const client = fakeAuditClient(rows);
  const router = createAuditRouter({ client });
  const handler = routeHandler(router, '/');

  const first = responseRecorder();
  await handler({ query: { limit: '50' } }, first);
  assert.equal(first.payload.items.length, 50);

  // Someone cancels another automation between the two requests. With .range()
  // offsets this is exactly where a row gets shown twice.
  rows.push(auditRow(61));

  const second = responseRecorder();
  await handler({ query: { limit: '50', cursor: String(first.payload.nextCursor) } }, second);
  const overlap = second.payload.items.filter(item => first.payload.items.some(seen => seen.id === item.id));
  assert.deepEqual(overlap, []);
  assert.deepEqual(second.payload.items.map(item => item.id), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
});

test('feed parameters are validated before any query runs', async () => {
  const router = createAuditRouter({ client: fakeAuditClient([]) });
  const handler = routeHandler(router, '/');
  const cases = [
    { limit: '0' },
    { limit: '101' },
    { limit: 'fifty' },
    { cursor: '-1' },
    { cursor: 'abc' },
    { category: 'revenue' },
    { from: 'not-a-date' },
    { from: '2026-08-20', to: '2026-08-01' },
    { includeAudit: 'yes' }
  ];
  for (const query of cases) {
    const res = responseRecorder();
    await handler({ query }, res);
    assert.equal(res.statusCode, 400, `${JSON.stringify(query)} must be rejected`);
    assert.equal(res.payload.code, 'INVALID_AUDIT_REQUEST');
  }
});

test('a date range filters on occurred_at', async () => {
  const rows = [
    auditRow(3, { occurred_at: '2026-08-20T12:00:00.000Z' }),
    auditRow(2, { occurred_at: '2026-08-10T12:00:00.000Z' }),
    auditRow(1, { occurred_at: '2026-07-01T12:00:00.000Z' })
  ];
  const router = createAuditRouter({ client: fakeAuditClient(rows) });
  const res = responseRecorder();
  await routeHandler(router, '/')({ query: { from: '2026-08-05T00:00:00Z', to: '2026-08-15T00:00:00Z' } }, res);
  assert.deepEqual(res.payload.items.map(item => item.id), [2]);
});

// ── Entity, contact, actors, summary ───────────────────────────────────────

test('the entity timeline answers "what happened to this queued message"', async () => {
  const rows = [
    auditRow(2, { entity_type: 'scheduled_message', entity_id: '4821', event_type: 'automation.queue_item.cancelled' }),
    auditRow(1, { entity_type: 'scheduled_message', entity_id: '4821', event_type: 'automation.queue_item.scheduled', visibility: 'detail' }),
    auditRow(3, { entity_type: 'scheduled_message', entity_id: '9999' })
  ];
  const router = createAuditRouter({ client: fakeAuditClient(rows) });
  const res = responseRecorder();
  await routeHandler(router, '/entity/:entityType/:entityId')(
    { params: { entityType: 'scheduled_message', entityId: '4821' }, query: {} },
    res
  );
  assert.deepEqual(res.payload.items.map(item => item.id), [2, 1]);
  assert.equal(res.payload.entity_id, '4821');
});

test('a malformed entity type is rejected rather than passed into a filter', async () => {
  const router = createAuditRouter({ client: fakeAuditClient([]) });
  const res = responseRecorder();
  await routeHandler(router, '/entity/:entityType/:entityId')(
    { params: { entityType: 'scheduled_message; drop table', entityId: '1' }, query: {} },
    res
  );
  assert.equal(res.statusCode, 400);
});

test('the contact export normalises the phone and matches the full stored number', async () => {
  const rows = [auditRow(1, { contact_phone: '+13055551234' }), auditRow(2, { contact_phone: '+13055559999' })];
  const client = fakeAuditClient(rows);
  const router = createAuditRouter({ client });
  const res = responseRecorder();
  await routeHandler(router, '/contact/:phone')({ params: { phone: '(305) 555-1234' }, query: {} }, res);
  assert.equal(res.payload.contact_phone, '+13055551234');
  assert.deepEqual(res.payload.items.map(item => item.id), [1]);

  const rejected = responseRecorder();
  await routeHandler(router, '/contact/:phone')({ params: { phone: '123' }, query: {} }, rejected);
  assert.equal(rejected.statusCode, 400);
});

test('the actor list is deduplicated from a bounded scan', async () => {
  const rows = [
    auditRow(3, { actor_user_id: 7, actor_display_name: 'Dominic' }),
    auditRow(2, { actor_user_id: 9, actor_display_name: 'Lubosi', actor_role: 'owner' }),
    auditRow(1, { actor_user_id: 7, actor_display_name: 'Dominic' })
  ];
  const router = createAuditRouter({ client: fakeAuditClient(rows) });
  const res = responseRecorder();
  await routeHandler(router, '/actors')({ query: {} }, res);
  assert.equal(res.payload.actors.length, 2);
  assert.equal(res.payload.actors[0].actor_user_id, 7);
  assert.equal(res.payload.actors[0].event_count, 2);
  assert.equal(res.payload.scan_limit, 1000);
});

test('the summary counts per category without transferring rows', async () => {
  const rows = [
    auditRow(1),
    auditRow(2),
    auditRow(3, { category: 'contacts', severity: 'warning', event_type: 'contact.phone_changed' })
  ];
  const router = createAuditRouter({ client: fakeAuditClient(rows) });
  const res = responseRecorder();
  await routeHandler(router, '/summary')({ query: {} }, res);
  assert.equal(res.payload.total, 3);
  assert.equal(res.payload.warnings, 1);
  assert.equal(res.payload.by_category.automations, 2);
  assert.equal(res.payload.by_category.contacts, 1);
  assert.equal(res.payload.by_category.campaigns, 0);
});

// ── Failure modes ──────────────────────────────────────────────────────────

test('a missing migration returns 503 rather than an empty, believable feed', async () => {
  const client = fakeAuditClient([], { code: '42P01', message: 'relation "sms_audit_log" does not exist' });
  const router = createAuditRouter({ client });
  const res = responseRecorder();
  await routeHandler(router, '/')({ query: {} }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.code, 'AUDIT_NOT_READY');
  assert.match(res.payload.error, /audit-migration\.sql/);
});

test('database detail is logged, not returned to the client', async () => {
  const client = fakeAuditClient([], { code: 'XX000', message: 'connection to 10.0.0.4 failed for user postgres' });
  const router = createAuditRouter({ client });
  const res = responseRecorder();
  const originalError = console.error;
  console.error = () => {};
  try { await routeHandler(router, '/')({ query: {} }, res); }
  finally { console.error = originalError; }
  assert.equal(res.statusCode, 500);
  assert.equal(JSON.stringify(res.payload).includes('10.0.0.4'), false);
});
