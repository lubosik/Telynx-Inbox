'use strict';
/**
 * The segments HTTP surface, its permissions, and the service that backs it.
 *
 * The Supabase client is a hand-written fake rather than a mock library,
 * because the shapes this repository has been burned by are shapes a mock
 * would hide: a builder that is a thenable with no `.catch()`, a read that
 * silently stops at 1000 rows, and an `.in()` long enough to overflow the URL.
 * The fake reproduces all three faithfully.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://offline.test.invalid';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'offline-test-key';

const createSegmentRouter = require('../routes/segments');
const { ROUTE_POLICY } = require('../lib/route-policy');
const { findPolicy } = require('../lib/enforce-policy');
const { createSegmentService } = require('../lib/campaigns/segment-service');
const { SEGMENT_RULE_VERSION } = require('../lib/campaigns/segment-definitions');

function handler(router, method, routePath) {
  const layer = router.stack.find(entry => entry.route?.path === routePath && entry.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${routePath} exists`);
  return layer.route.stack[0].handle;
}

function response() {
  return {
    statusCode: 200, payload: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(value) { this.payload = value; return this; }
  };
}

/**
 * A Supabase-shaped fake.
 *
 * `then` and nothing else, exactly like the real builder, so any `.catch()`
 * added to production code fails here the same way it fails in production.
 */
function fakeClient({ tables = {}, rpc = {} } = {}) {
  const calls = { rpc: [], select: [], inSizes: [] };

  function builder(table) {
    const state = { table, filters: [], range: null, columns: '*', count: false };
    const chain = {
      select(columns, options) {
        state.columns = columns;
        state.count = options?.count === 'exact';
        return chain;
      },
      eq(column, value) { state.filters.push(['eq', column, value]); return chain; },
      is(column, value) { state.filters.push(['is', column, value]); return chain; },
      not(column, op, value) { state.filters.push(['not', column, op, value]); return chain; },
      in(column, values) {
        calls.inSizes.push(values.length);
        state.filters.push(['in', column, values]);
        return chain;
      },
      order() { return chain; },
      limit(value) { state.limit = value; return chain; },
      range(from, to) { state.range = [from, to]; return chain; },
      maybeSingle() { state.single = true; return chain; },
      then(resolve, reject) {
        calls.select.push({ ...state });
        let result;
        try {
          const source = tables[table];
          const rows = typeof source === 'function' ? source(state) : (source || []);
          const filtered = rows.filter(row => state.filters.every(filter => {
            const [kind, column, value] = filter;
            if (kind === 'eq') return String(row[column]) === String(value);
            if (kind === 'is') return row[column] === value;
            if (kind === 'not') return row[column] !== null && row[column] !== undefined;
            if (kind === 'in') return value.includes(row[column]);
            return true;
          }));
          const paged = state.range
            ? filtered.slice(state.range[0], state.range[1] + 1)
            : filtered;
          result = state.single
            ? { data: paged[0] || null, error: null }
            : { data: paged, error: null, count: state.count ? filtered.length : null };
        } catch (error) {
          return reject ? reject(error) : Promise.reject(error);
        }
        return Promise.resolve(result).then(resolve, reject);
      }
      // No `catch`, no `finally`. That is the point.
    };
    return chain;
  }

  return {
    calls,
    from: builder,
    rpc(name, args) {
      calls.rpc.push({ name, args });
      const handlerFn = rpc[name];
      if (!handlerFn) return Promise.resolve({ data: null, error: { code: '42883', message: `no rpc ${name}` } });
      return Promise.resolve(handlerFn(args));
    }
  };
}

function segmentRow(overrides = {}) {
  return {
    id: 's0000000-0000-4000-8000-000000000001',
    workspace_id: 'vici',
    segment_key: 'reorder_due_high_confidence',
    name: 'Due to reorder, best timing',
    description: 'Engine computed.',
    segment_kind: 'automatic',
    definition: { detector: 'reorder', definitionKey: 'reorder_due_high_confidence' },
    rule_version: SEGMENT_RULE_VERSION,
    member_count: 2,
    last_computed_at: null,
    archived_at: null,
    created_at: '2026-08-23T00:00:00.000Z',
    updated_at: '2026-08-23T00:00:00.000Z',
    ...overrides
  };
}

// ── Routes and permissions ──────────────────────────────────────────────────

test('the router exposes the full segment surface', () => {
  const noop = async () => ({});
  const router = createSegmentRouter({
    service: new Proxy({ catalogue: () => ({ items: [] }) }, {
      get: (target, key) => (key in target ? target[key] : noop)
    })
  });
  for (const [method, routePath] of [
    ['get', '/'], ['get', '/catalogue'], ['post', '/'], ['get', '/:id'],
    ['get', '/:id/members/:phone'], ['post', '/:id/members'],
    ['delete', '/:id/members/:phone'], ['post', '/:id/overrides'],
    ['delete', '/:id/overrides/:phone'], ['post', '/:id/recompute']
  ]) handler(router, method, routePath);
});

test('reading a segment needs campaigns.read and changing one needs campaigns.manage', () => {
  const reads = [
    ['GET', '/api/segments'],
    ['GET', '/api/segments/catalogue'],
    ['GET', '/api/segments/abc'],
    ['GET', '/api/segments/abc/members/+15550000001']
  ];
  for (const [method, routePath] of reads) {
    assert.equal(
      findPolicy(method, routePath).permission, 'campaigns.read',
      `${method} ${routePath} must be readable by a Support Agent`
    );
  }

  const writes = [
    ['POST', '/api/segments'],
    ['POST', '/api/segments/abc/members'],
    ['DELETE', '/api/segments/abc/members/+15550000001'],
    ['POST', '/api/segments/abc/overrides'],
    ['DELETE', '/api/segments/abc/overrides/+15550000001'],
    ['POST', '/api/segments/abc/recompute'],
    ['DELETE', '/api/campaigns/abc']
  ];
  for (const [method, routePath] of writes) {
    const entry = findPolicy(method, routePath);
    assert.equal(entry.permission, 'campaigns.manage', `${method} ${routePath} must require campaigns.manage`);
    assert.equal(entry.audit, true, `${method} ${routePath} changes state and must be audited`);
  }
});

test('the literal catalogue path is never shadowed by /:id', () => {
  assert.equal(findPolicy('GET', '/api/segments/catalogue').path, '/api/segments/catalogue');
  assert.equal(findPolicy('GET', '/api/segments/anything-else').path, '/api/segments/:id');
});

test('no segment endpoint is open to any authenticated actor', () => {
  const open = ROUTE_POLICY.filter(entry =>
    entry.path.startsWith('/api/segments') && entry.permission === null);
  assert.deepEqual(open, []);
});

// ── Input handling ──────────────────────────────────────────────────────────

test('unknown body keys are refused rather than ignored', async () => {
  const router = createSegmentRouter({ service: { createManual: async () => ({}) } });
  const res = response();
  await handler(router, 'post', '/')({
    body: { name: 'VIPs', recipients: [{ phone: '+15550000001' }] }, actor: { id: 1 }
  }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.code, 'SEGMENT_INPUT_REJECTED');
});

test('a bad phone is a 400, not a row with a broken key', async () => {
  const client = fakeClient({ tables: { sms_campaign_segments: [segmentRow()] } });
  const service = createSegmentService({ client });
  await assert.rejects(
    () => service.addMember('s1', { phone: 'not a phone' }, { id: 1 }),
    error => error.code === 'SEGMENT_INVALID' && error.status === 400
  );
});

// ── The service ─────────────────────────────────────────────────────────────

test('listing tells the operator which catalogue segments are not saved yet', async () => {
  const client = fakeClient({ tables: { sms_campaign_segments: [segmentRow()] } });
  const result = await createSegmentService({ client }).list({});
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].kind, 'automatic');
  assert.deepEqual(
    result.available.map(entry => entry.key).sort(),
    ['reorder_approaching', 'reorder_due', 'winback_qualified']
  );
  assert.equal(result.ruleVersion, SEGMENT_RULE_VERSION);
});

test('saving an automatic segment twice returns the first one instead of duplicating it', async () => {
  const existing = segmentRow();
  const client = fakeClient({
    tables: { sms_campaign_segments: [existing] },
    rpc: { create_sms_campaign_segment: () => ({ data: existing, error: null }) }
  });
  const result = await createSegmentService({ client })
    .createAutomatic({ definitionKey: 'reorder_due_high_confidence' }, { id: 1 });
  assert.equal(result.created, false);
  assert.equal(result.segment.id, existing.id);
  assert.equal(client.calls.rpc.length, 0, 'an existing segment must not be re-created');
});

test('an unknown definition key is refused before any write', async () => {
  const client = fakeClient({ tables: { sms_campaign_segments: [] } });
  await assert.rejects(
    () => createSegmentService({ client }).createAutomatic({ definitionKey: 'made_up' }, { id: 1 }),
    error => error.code === 'SEGMENT_DEFINITION_UNKNOWN'
  );
  assert.equal(client.calls.rpc.length, 0);
});

test('a manual segment cannot be recomputed', async () => {
  const client = fakeClient({
    tables: { sms_campaign_segments: [segmentRow({ segment_kind: 'manual', definition: {} })] }
  });
  await assert.rejects(
    () => createSegmentService({ client }).recompute('s0000000-0000-4000-8000-000000000001', { id: 1 }),
    error => error.code === 'SEGMENT_NOT_RECOMPUTABLE' && error.status === 409
  );
});

test('the member endpoint returns the stored evidence and the override history', async () => {
  const evidence = {
    detector: 'reorder', confidence: 'high', medianIntervalDays: 30,
    intervalsObserved: 4, lastOrderAt: '2026-07-22T12:00:00.000Z'
  };
  const client = fakeClient({
    tables: {
      sms_campaign_segments: [segmentRow()],
      sms_campaign_segment_members: [{
        segment_id: 's0000000-0000-4000-8000-000000000001', workspace_id: 'vici',
        contact_phone: '+15550000001', contact_id: 5, contact_name_snapshot: 'A',
        membership_source: 'computed', inclusion_evidence: evidence,
        evidence_rule_version: SEGMENT_RULE_VERSION, engine_matched: true,
        engine_evidence: evidence, first_seen_at: 'x', last_seen_at: 'y'
      }],
      sms_campaign_segment_overrides: [{
        id: 'o1', segment_id: 's0000000-0000-4000-8000-000000000001', workspace_id: 'vici',
        contact_phone: '+15550000001', override_type: 'include',
        reason: 'asked for it', created_at: 'a', revoked_at: 'b', revoke_reason: 'no longer needed'
      }]
    }
  });

  const result = await createSegmentService({ client })
    .member('s0000000-0000-4000-8000-000000000001', '+15550000001');
  assert.equal(result.member.membershipSource, 'computed');
  assert.deepEqual(result.member.inclusionEvidence, evidence);
  assert.equal(result.activeOverride, null, 'a revoked override is not active');
  assert.equal(result.overrideHistory.length, 1);
});

test('asking about somebody who is in neither the members nor the overrides is a 404', async () => {
  const client = fakeClient({
    tables: {
      sms_campaign_segments: [segmentRow()],
      sms_campaign_segment_members: [],
      sms_campaign_segment_overrides: []
    }
  });
  await assert.rejects(
    () => createSegmentService({ client })
      .member('s0000000-0000-4000-8000-000000000001', '+15550000099'),
    error => error.code === 'SEGMENT_MEMBER_NOT_FOUND' && error.status === 404
  );
});

test('an unapplied migration is reported as not-ready rather than as a crash', async () => {
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () => ({
              then: resolve => Promise.resolve({
                data: null, error: { code: 'PGRST205', message: 'Could not find the table' }
              }).then(resolve)
            })
          })
        })
      })
    }),
    rpc: () => Promise.resolve({ data: null, error: null })
  };
  await assert.rejects(
    () => createSegmentService({ client }).member('s1', '+15550000001'),
    error => error.code === 'CAMPAIGNS_NOT_READY' && error.status === 503 &&
      /campaign-segments-migration\.sql/.test(error.message)
  );
});

// ── The Supabase rules that have caused outages here ────────────────────────

test('notification targeting never builds an unbounded .in()', async () => {
  const users = Array.from({ length: 950 }, (_, index) => ({
    id: index + 1, role: 'admin', is_active: true
  }));
  const client = fakeClient({
    tables: {
      sms_users: users,
      sms_effective_permissions: users.map(user => ({
        user_id: user.id, permission_key: 'campaigns.manage'
      }))
    }
  });
  const result = await createSegmentService({ client }).notificationUsers();

  assert.equal(result.length, 950);
  assert.ok(client.calls.inSizes.length >= 5, 'the id list must be chunked, not sent whole');
  assert.equal(
    Math.max(...client.calls.inSizes), 200,
    'no .in() may carry more than IN_CHUNK_SIZE values; 907 values is what took the inbox down'
  );
  assert.ok(result.every(user => user.canManageCampaigns === true));
});

test('a read of more than 1000 rows pages instead of silently stopping at the cap', async () => {
  // PostgREST caps a response at 1000 rows and does not say so. An override
  // history read that trusted the default would go blind past row 1000, and the
  // rows it lost would be exclusions, so people the operator had banned would
  // quietly reappear.
  const overrides = Array.from({ length: 2300 }, (_, index) => ({
    id: `o${index}`,
    segment_id: 's0000000-0000-4000-8000-000000000001',
    workspace_id: 'vici',
    contact_phone: `+1555${String(index).padStart(7, '0')}`,
    override_type: index % 2 === 0 ? 'exclude' : 'include',
    reason: null,
    created_at: '2026-08-23T00:00:00.000Z',
    revoked_at: null,
    revoke_reason: null
  }));
  const client = fakeClient({
    tables: {
      sms_campaign_segments: [segmentRow()],
      sms_campaign_segment_members: [],
      sms_campaign_segment_overrides: overrides
    }
  });

  const result = await createSegmentService({ client })
    .detail('s0000000-0000-4000-8000-000000000001', {});
  assert.equal(
    result.overrides.active.length, 2300,
    'every override must be read; stopping at 1000 would resurrect excluded people'
  );

  const overrideReads = client.calls.select
    .filter(call => call.table === 'sms_campaign_segment_overrides' && call.range);
  assert.ok(overrideReads.length >= 3, 'the read must be paged');
  assert.deepEqual(overrideReads[0].range, [0, 999]);
  assert.deepEqual(overrideReads[1].range, [1000, 1999]);
});

test('no Supabase builder in the segment code has a .catch() on it', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const file of [
    'lib/campaigns/segment-service.js',
    'routes/segments.js'
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    // The guard test test/no-builder-catch.test.js scans the whole repository;
    // this is the local, readable restatement of why.
    assert.doesNotMatch(
      source, /\.(from|rpc)\([^)]*\)[\s\S]{0,400}?\.catch\(/,
      `${file} attaches .catch() to a Supabase builder, which throws before the query is sent`
    );
  }
});
