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
      // PostgREST reads `or=(a.ilike.%x%,b.ilike.%x%)` as structure, not as an
      // escaped value. The fake parses it the same crude way so a test can
      // prove the search term is stripped before it gets here.
      or(expression) { state.filters.push(['or', expression]); return chain; },
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
            if (kind === 'or') {
              return String(column).split(',').some(clause => {
                const [field, operator, ...rest] = clause.split('.');
                if (operator !== 'ilike') return false;
                const needle = rest.join('.').replace(/%/g, '').toLowerCase();
                return String(row[field] ?? '').toLowerCase().includes(needle);
              });
            }
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
    last_run_id: null,
    purpose: null,
    archived_at: null,
    archive_reason: null,
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
    ['delete', '/:id/overrides/:phone'], ['post', '/:id/recompute'],
    ['get', '/:id/candidates'], ['delete', '/:id'], ['post', '/:id/restore']
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
    ['DELETE', '/api/segments/abc'],
    ['POST', '/api/segments/abc/restore'],
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
    [
      'one_time_above_typical_spend', 'one_time_buyers', 'one_time_first_month',
      'one_time_lapsed', 'one_time_multi_product', 'one_time_slipping',
      'reorder_approaching', 'reorder_due', 'winback_qualified'
    ]
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

// ── The purpose of a manual segment ────────────────────────────────────────
//
// The owner's words: "maybe we do one reason if we're doing a manual segment,
// and then that reason appears for everybody." So it is asked once, it is
// required, and it is stored on the SEGMENT. It is not the per-person reason,
// which still exists on a member row and on an override and answers a
// different question. These tests assert that both survive.

test('a manual segment cannot be created without saying what it is for', async () => {
  const client = fakeClient({ tables: { sms_campaign_segments: [] } });
  await assert.rejects(
    () => createSegmentService({ client }).createManual({ name: 'December restock' }, { id: 1 }),
    error => error.code === 'SEGMENT_PURPOSE_REQUIRED' && error.status === 400
  );
  assert.equal(client.calls.rpc.length, 0, 'nothing may be written before the purpose is given');

  await assert.rejects(
    () => createSegmentService({ client })
      .createManual({ name: 'December restock', purpose: '   ' }, { id: 1 }),
    error => error.code === 'SEGMENT_PURPOSE_REQUIRED',
    'whitespace is not a purpose'
  );
});

test('the purpose reaches the RPC as the segment field, and an automatic segment has none', async () => {
  const created = segmentRow({
    segment_kind: 'manual', definition: {}, purpose: 'Asked about the December restock'
  });
  const client = fakeClient({
    tables: { sms_campaign_segments: [] },
    rpc: { create_sms_campaign_segment: () => ({ data: created, error: null }) }
  });
  const result = await createSegmentService({ client }).createManual({
    name: 'December restock',
    purpose: 'Asked about the December restock',
    members: [{ phone: '+15550000001', reason: 'rang on 12 Aug' }]
  }, { id: 1 });

  const call = client.calls.rpc.at(-1);
  assert.equal(call.args.p_purpose, 'Asked about the December restock');
  assert.equal(result.segment.purpose, 'Asked about the December restock');

  // The per-person reason is still there, and it is somewhere else. Collapsing
  // the two would lose "added at her request on 12 Aug" the moment a segment
  // gained a purpose.
  assert.equal(call.args.p_members[0].inclusionEvidence.reason, 'rang on 12 Aug');

  const automaticClient = fakeClient({
    tables: { sms_campaign_segments: [] },
    rpc: { create_sms_campaign_segment: () => ({ data: segmentRow(), error: null }) }
  });
  await createSegmentService({ client: automaticClient })
    .createAutomatic({ definitionKey: 'reorder_due' }, { id: 1 });
  assert.equal(
    automaticClient.calls.rpc.at(-1).args.p_purpose, null,
    'an automatic segment detector definition is its purpose; a second one would be two answers to one question'
  );
});

test('the per-person override reason is untouched by the segment purpose', async () => {
  const overrideRow = {
    id: 'o1', segment_id: 's0000000-0000-4000-8000-000000000001', workspace_id: 'vici',
    contact_phone: '+15550000001', override_type: 'exclude',
    reason: 'she asked us to stop', created_at: 'now', revoked_at: null
  };
  const client = fakeClient({
    tables: { sms_campaign_segments: [segmentRow()] },
    rpc: { set_sms_campaign_segment_override: () => ({ data: overrideRow, error: null }) }
  });
  const result = await createSegmentService({ client }).setOverride(
    's0000000-0000-4000-8000-000000000001',
    { phone: '+15550000001', overrideType: 'exclude', reason: 'she asked us to stop' },
    { id: 1 }
  );
  assert.equal(result.override.reason, 'she asked us to stop');
  assert.equal(client.calls.rpc.at(-1).args.p_reason, 'she asked us to stop');
});

// ── Delete versus archive ──────────────────────────────────────────────────

function lifecycleClient({ segment, runs = [], overrides = [], members = [], campaigns = [], rpc = {} } = {}) {
  return fakeClient({
    tables: {
      sms_campaign_segments: [segment],
      sms_campaign_segment_runs: runs,
      sms_campaign_segment_overrides: overrides,
      sms_campaign_segment_members: members,
      sms_campaigns: campaigns
    },
    rpc
  });
}

const MANUAL = segmentRow({
  segment_kind: 'manual', definition: {}, segment_key: 'manual:test:abc',
  name: 'Test audience', purpose: 'Trying the feature out', member_count: 3
});

test('a hand-made list that records no decision about anybody is destructible', async () => {
  const client = lifecycleClient({
    segment: MANUAL,
    members: [1, 2, 3].map(index => ({
      segment_id: MANUAL.id, workspace_id: 'vici',
      contact_phone: `+1555000000${index}`, inclusion_evidence: { source: 'manual_selection' }
    }))
  });
  const preview = await createSegmentService({ client }).deletionPreview(MANUAL.id);
  assert.deepEqual(preview.blockers, []);
  assert.equal(preview.destructible, true);
});

test('anything that is part of who did we message and why is archived instead', async () => {
  const cases = [
    ['recompute_history', { runs: [{ id: 'r1', segment_id: MANUAL.id, workspace_id: 'vici' }] }],
    ['override_history', {
      overrides: [{
        id: 'o1', segment_id: MANUAL.id, workspace_id: 'vici', contact_phone: '+15550000001',
        override_type: 'exclude', reason: 'she asked us to stop',
        created_at: 'now', revoked_at: 'later', revoke_reason: 'changed her mind'
      }]
    }],
    ['member_reasons', {
      members: [{
        segment_id: MANUAL.id, workspace_id: 'vici', contact_phone: '+15550000001',
        inclusion_evidence: { source: 'manual_selection', reason: 'added at her request on 12 Aug' }
      }]
    }],
    ['engine_has_run', { segment: { ...MANUAL, last_computed_at: '2026-08-23T00:00:00.000Z' } }],
    ['already_archived', { segment: { ...MANUAL, archived_at: '2026-08-23T00:00:00.000Z' } }]
  ];

  for (const [expected, extra] of cases) {
    const client = lifecycleClient({ segment: MANUAL, ...extra });
    const preview = await createSegmentService({ client }).deletionPreview(MANUAL.id);
    assert.ok(
      preview.blockers.includes(expected),
      `${expected} must block destruction, got ${JSON.stringify(preview.blockers)}`
    );
    assert.equal(preview.destructible, false);
  }
});

test('a REVOKED override still blocks destruction, because the reversal is itself a record', async () => {
  // The overrides table keeps revoked rows on purpose: who decided what and who
  // undid it both stay readable. Destroying the segment would destroy both.
  const client = lifecycleClient({
    segment: MANUAL,
    overrides: [{
      id: 'o1', segment_id: MANUAL.id, workspace_id: 'vici', contact_phone: '+15550000001',
      override_type: 'include', reason: null, created_at: 'a', revoked_at: 'b'
    }]
  });
  const preview = await createSegmentService({ client }).deletionPreview(MANUAL.id);
  assert.deepEqual(preview.blockers, ['override_history']);
});

test('member rows are only read when nothing cheaper has already decided the answer', async () => {
  const client = lifecycleClient({
    segment: MANUAL,
    runs: [{ id: 'r1', segment_id: MANUAL.id, workspace_id: 'vici' }]
  });
  await createSegmentService({ client }).deletionPreview(MANUAL.id);
  assert.equal(
    client.calls.select.filter(call => call.table === 'sms_campaign_segment_members').length, 0,
    'an automatic segment can hold 100,000 member rows; the run check answers first'
  );
});

test('a caller can ask for the archive and can never ask for the destruction', async () => {
  const seen = [];
  const client = lifecycleClient({
    segment: MANUAL,
    rpc: {
      delete_sms_campaign_segment: args => {
        seen.push(args.p_mode);
        return {
          data: {
            outcome: 'archived', segmentId: MANUAL.id, blockers: [],
            name: MANUAL.name, kind: 'manual'
          },
          error: null
        };
      }
    }
  });
  const service = createSegmentService({ client });
  await service.remove(MANUAL.id, { mode: 'archive' }, { id: 1 });
  await service.remove(MANUAL.id, { mode: 'force_delete' }, { id: 1 });
  await service.remove(MANUAL.id, {}, { id: 1 });
  assert.deepEqual(seen, ['archive', 'auto', 'auto'],
    'anything that is not "archive" is "auto"; there is no third mode to ask for');
});

test('the destruction audit row is written BEFORE the row is destroyed, and refuses it if it fails', async () => {
  const calls = [];
  const service = {
    deletionPreview: async () => ({
      segment: {
        id: MANUAL.id, key: MANUAL.segment_key, name: MANUAL.name,
        kind: 'manual', memberCount: 3
      },
      blockers: [], destructible: true
    }),
    remove: async () => {
      calls.push('remove');
      return { outcome: 'deleted', segmentId: MANUAL.id, blockers: [], membersRemoved: 3 };
    }
  };

  const refusing = createSegmentRouter({
    service,
    segmentRemovalAuditWriter: async () => {
      calls.push('audit');
      return { recorded: false, reason: 'schema_missing' };
    }
  });
  const refused = response();
  await handler(refusing, 'delete', '/:id')(
    { params: { id: MANUAL.id }, body: {}, actor: { id: 1 } }, refused
  );
  assert.equal(refused.statusCode, 503);
  assert.equal(refused.payload.code, 'SEGMENT_DELETE_AUDIT_REQUIRED');
  assert.deepEqual(calls, ['audit'], 'no audit row, no delete');

  calls.length = 0;
  const recording = createSegmentRouter({
    service,
    segmentRemovalAuditWriter: async input => {
      calls.push(input.eventType);
      return { recorded: true };
    }
  });
  const ok = response();
  await handler(recording, 'delete', '/:id')(
    { params: { id: MANUAL.id }, body: {}, actor: { id: 1 } }, ok
  );
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.payload.outcome, 'deleted');
  assert.deepEqual(calls, ['campaign.segment.deleted', 'remove'], 'the row is written first');
});

test('the archive path is audited as an archive and never as a deletion', async () => {
  const written = [];
  const router = createSegmentRouter({
    service: {
      deletionPreview: async () => ({
        segment: {
          id: MANUAL.id, key: MANUAL.segment_key, name: MANUAL.name,
          kind: 'manual', memberCount: 3
        },
        blockers: ['override_history'], destructible: false
      }),
      remove: async () => ({
        outcome: 'archived', segmentId: MANUAL.id, blockers: ['override_history'],
        name: MANUAL.name, kind: 'manual', membersRemoved: 0
      })
    },
    segmentRemovalAuditWriter: async input => { written.push(input.eventType); return { recorded: true }; }
  });
  const res = response();
  await handler(router, 'delete', '/:id')(
    { params: { id: MANUAL.id }, body: {}, actor: { id: 1 } }, res
  );
  assert.equal(res.payload.outcome, 'archived');
  assert.deepEqual(res.payload.blockers, ['override_history']);
  assert.deepEqual(written, [], 'the pre-write logger is only for the destructive path');
});

test('the removal body accepts a mode and a reason and refuses anything else', async () => {
  const router = createSegmentRouter({ service: { deletionPreview: async () => ({}) } });
  const res = response();
  await handler(router, 'delete', '/:id')({
    params: { id: MANUAL.id }, body: { mode: 'archive', force: true }, actor: { id: 1 }
  }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.code, 'SEGMENT_INPUT_REJECTED');
});

test('an archived segment leaves the working list without leaving the database', async () => {
  const archived = { ...MANUAL, archived_at: '2026-08-23T00:00:00.000Z' };
  const client = fakeClient({ tables: { sms_campaign_segments: [archived] } });
  const service = createSegmentService({ client });

  const live = await service.list({});
  assert.deepEqual(live.items, [], 'archived segments are hidden by default');
  const withArchived = await service.list({ archived: 'true' });
  assert.equal(withArchived.items.length, 1);
  assert.equal(withArchived.items[0].archivedAt, '2026-08-23T00:00:00.000Z');
});

test('restoring is the exact inverse of archiving', async () => {
  const restored = { ...MANUAL, archived_at: null };
  const client = fakeClient({
    tables: { sms_campaign_segments: [restored] },
    rpc: { restore_sms_campaign_segment: () => ({ data: restored, error: null }) }
  });
  const router = createSegmentRouter({
    service: createSegmentService({ client }),
    auditWriter: async () => ({ recorded: true })
  });
  const res = response();
  await handler(router, 'post', '/:id/restore')(
    { params: { id: MANUAL.id }, body: {}, actor: { id: 1 } }, res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.segment.archivedAt, null);
});

// ── The add-someone picker ─────────────────────────────────────────────────

function contactRow(index, extra = {}) {
  return {
    id: index,
    phone: `+1555000${String(index).padStart(4, '0')}`,
    first_name: `Person${String(index).padStart(4, '0')}`,
    last_name: 'Example',
    name: null,
    ...extra
  };
}

test('somebody already in the segment is never offered again, on any page', async () => {
  // The papercut: the owner added three people, reopened Add, and all three
  // were still listed. Filtering the visible page would have hidden the ones on
  // screen and left the rest one scroll away.
  const contacts = Array.from({ length: 120 }, (_, index) => contactRow(index + 1));
  const memberPhones = ['+15550000001', '+15550000060', '+15550000120'];
  const client = fakeClient({
    tables: {
      sms_campaign_segments: [MANUAL],
      sms_contacts: contacts,
      sms_campaign_segment_members: memberPhones.map(phone => ({
        segment_id: MANUAL.id, workspace_id: 'vici', contact_phone: phone
      })),
      sms_campaign_segment_overrides: []
    }
  });
  const service = createSegmentService({ client });

  const first = await service.candidates(MANUAL.id, { page: 1, pageSize: 50 });
  const second = await service.candidates(MANUAL.id, { page: 2, pageSize: 50 });
  const third = await service.candidates(MANUAL.id, { page: 3, pageSize: 50 });
  const offered = [...first.candidates.items, ...second.candidates.items, ...third.candidates.items]
    .map(entry => entry.contactPhone);

  assert.equal(offered.length, 117);
  for (const phone of memberPhones) {
    assert.ok(!offered.includes(phone), `${phone} is already in the segment and must not be offered`);
  }
  assert.equal(first.candidates.total, 117, 'the total counts what can be added, not what exists');
  assert.equal(first.candidates.hasMore, true);
  assert.equal(third.candidates.hasMore, false);
  assert.equal(first.alreadyInCount, 3, 'the interface can say where the missing three went');
});

test('an active exclude override is shown as held out, not hidden and not offered', async () => {
  const client = fakeClient({
    tables: {
      sms_campaign_segments: [segmentRow()],
      sms_contacts: [contactRow(1), contactRow(2)],
      sms_campaign_segment_members: [],
      sms_campaign_segment_overrides: [{
        id: 'o1', segment_id: segmentRow().id, workspace_id: 'vici',
        contact_phone: '+15550000002', override_type: 'exclude',
        reason: 'she asked us to stop', created_by: 7,
        created_at: '2026-08-12T00:00:00.000Z', revoked_at: null
      }]
    }
  });
  const result = await createSegmentService({ client }).candidates(segmentRow().id, {});

  assert.deepEqual(result.candidates.items.map(entry => entry.contactPhone), ['+15550000001']);
  assert.equal(result.held.length, 1);
  assert.equal(result.held[0].contactPhone, '+15550000002');
  assert.equal(result.held[0].state, 'held_out');
  assert.equal(result.held[0].contactName, 'Person0002 Example');
  // The decision travels with them. "Not a member" and "a person decided to
  // hold them out" are different answers, and re-adding them is a real thing
  // somebody might want to do, so the reason has to be on screen.
  assert.equal(result.held[0].override.reason, 'she asked us to stop');
  assert.equal(result.held[0].override.overrideType, 'exclude');
});

test('a revoked exclusion puts somebody back among the people you can add', async () => {
  const client = fakeClient({
    tables: {
      sms_campaign_segments: [segmentRow()],
      sms_contacts: [contactRow(1)],
      sms_campaign_segment_members: [],
      sms_campaign_segment_overrides: [{
        id: 'o1', segment_id: segmentRow().id, workspace_id: 'vici',
        contact_phone: '+15550000001', override_type: 'exclude', reason: null,
        created_at: 'a', revoked_at: 'b', revoke_reason: 'she changed her mind'
      }]
    }
  });
  const result = await createSegmentService({ client }).candidates(segmentRow().id, {});
  assert.deepEqual(result.candidates.items.map(entry => entry.contactPhone), ['+15550000001']);
  assert.deepEqual(result.held, []);
});

test('somebody held out who is not in the contacts table is still findable', async () => {
  const client = fakeClient({
    tables: {
      sms_campaign_segments: [segmentRow()],
      sms_contacts: [],
      sms_campaign_segment_members: [],
      sms_campaign_segment_overrides: [{
        id: 'o1', segment_id: segmentRow().id, workspace_id: 'vici',
        contact_phone: '+15550000009', override_type: 'exclude', reason: 'asked us to stop',
        created_at: 'a', revoked_at: null
      }]
    }
  });
  const result = await createSegmentService({ client }).candidates(segmentRow().id, {});
  assert.equal(result.held.length, 1, 'losing them would make the exclusion invisible where you go to undo it');
  assert.equal(result.held[0].contactName, null);
});

test('the search term cannot reshape the PostgREST filter it is interpolated into', async () => {
  const client = fakeClient({
    tables: {
      sms_campaign_segments: [segmentRow()],
      sms_contacts: [contactRow(1)],
      sms_campaign_segment_members: [],
      sms_campaign_segment_overrides: []
    }
  });
  const result = await createSegmentService({ client })
    .candidates(segmentRow().id, { search: 'a),phone.not.is.null,name.ilike.%' });

  for (const character of [',', '(', ')', '%', '"', '*']) {
    assert.ok(
      !result.search.includes(character),
      `${character} is filter structure to PostgREST and must not survive into the query`
    );
  }
  const orFilters = client.calls.select
    .filter(call => call.table === 'sms_contacts')
    .flatMap(call => call.filters.filter(filter => filter[0] === 'or'));
  assert.ok(orFilters.length, 'the search must reach the database, sanitised');
  for (const filter of orFilters) {
    assert.equal(
      String(filter[1]).split(',').length, 5,
      'the or() expression must still be exactly the five columns it was written as'
    );
  }
});

test('the candidate contact scan pages rather than trusting the 1000-row cap', async () => {
  const contacts = Array.from({ length: 2400 }, (_, index) => contactRow(index + 1));
  const client = fakeClient({
    tables: {
      sms_campaign_segments: [MANUAL],
      sms_contacts: contacts,
      sms_campaign_segment_members: [],
      sms_campaign_segment_overrides: []
    }
  });
  const result = await createSegmentService({ client }).candidates(MANUAL.id, { page: 1, pageSize: 50 });
  assert.equal(result.candidates.total, 2400, 'stopping at 1000 would hide 1400 people with no error');

  const scans = client.calls.select.filter(call => call.table === 'sms_contacts' && call.range);
  assert.ok(scans.length >= 3);
  assert.deepEqual(scans[0].range, [0, 999]);
  assert.deepEqual(scans[1].range, [1000, 1999]);
});

test('the candidate picker is the one segment GET a Support Agent cannot call', () => {
  assert.equal(findPolicy('GET', '/api/segments/abc/candidates').permission, 'campaigns.manage');

  const readable = ROUTE_POLICY.filter(entry =>
    entry.method === 'GET' && entry.path.startsWith('/api/segments') &&
    entry.permission === 'campaigns.read').map(entry => entry.path).sort();
  assert.deepEqual(readable, [
    '/api/segments', '/api/segments/:id', '/api/segments/:id/members/:phone', '/api/segments/catalogue'
  ], 'a Support Agent must keep being able to answer "why is this customer being contacted?"');
});

test('the segment lifecycle event types exist and say what they are', () => {
  const { EVENT_TYPES } = require('../lib/audit/event-types');
  assert.equal(EVENT_TYPES['campaign.segment.deleted'].severity, 'warning');
  assert.equal(EVENT_TYPES['campaign.segment.deleted'].visibility, 'feed');
  assert.equal(EVENT_TYPES['campaign.segment.archived'].severity, 'notice');
  assert.equal(EVENT_TYPES['campaign.segment.restored'].severity, 'notice');
  for (const type of ['campaign.segment.deleted', 'campaign.segment.archived', 'campaign.segment.restored']) {
    assert.equal(EVENT_TYPES[type].entityType, 'campaign_segment');
    assert.notEqual(EVENT_TYPES[type].reserved, true);
  }
});
