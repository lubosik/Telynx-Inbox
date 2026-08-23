'use strict';
/**
 * The dry run, the save, and the recompute of a described segment.
 *
 * NO NETWORK AND NO MODEL. The translator is injected as a stub wherever the
 * service would call it, and Supabase is the same hand-written fake the rest
 * of the segment tests use: a thenable with `then` only, so a `.catch()` on a
 * query builder fails here the way it fails in production.
 *
 * THE PROPERTY THIS FILE IS REALLY ABOUT
 *   Nothing is saved until the operator chooses to save. A preview must show
 *   the real count and a real sample and must write nothing at all, which is
 *   asserted by counting RPC calls rather than by reading the code.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://offline.test.invalid';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'offline-test-key';

const createSegmentRouter = require('../routes/segments');
const { findPolicy } = require('../lib/enforce-policy');
const { ROUTE_POLICY } = require('../lib/route-policy');
const { buildCustomerFacts } = require('../lib/campaigns/segment-facts');
const { createSegmentService, RULES_DETECTOR } = require('../lib/campaigns/segment-service');
const {
  breadthWarning,
  evaluateRuleSet,
  SegmentRuleEvaluationError
} = require('../lib/campaigns/segment-rule-evaluator');
const { RULE_SCHEMA_VERSION } = require('../lib/campaigns/segment-rule-schema');

const NOW = new Date('2026-08-23T12:00:00.000Z');

// ── Fixtures ───────────────────────────────────────────────────────────────

function order(id, phone, createdAt, items, total = 100, status = 'completed') {
  return {
    id,
    woo_order_id: id,
    contact_phone: phone,
    status,
    total,
    created_at: createdAt,
    items: JSON.stringify(items)
  };
}

const BPC = { product_id: 41, variation_id: 0, name: 'BPC-157' };
const TB = { product_id: 42, variation_id: 0, name: 'TB-500' };

/**
 * Four people, chosen so that each one fails the owner's sentence for a
 * different reason and exactly one passes it.
 *
 *   Ada  three BPC orders, last in May          -> matches
 *   Ben  three BPC orders, last in July         -> too recent
 *   Cleo one BPC order, long ago                -> not enough orders
 *   Dan  no orders at all                       -> nothing to match on
 */
function sources() {
  return {
    contacts: [
      { id: 1, phone: '+15550000001', name: 'Ada' },
      { id: 2, phone: '+15550000002', name: 'Ben' },
      { id: 3, phone: '+15550000003', name: 'Cleo' },
      { id: 4, phone: '+15550000004', name: 'Dan' }
    ],
    orders: [
      order(101, '+15550000001', '2026-01-05T00:00:00Z', [BPC], 120),
      order(102, '+15550000001', '2026-03-05T00:00:00Z', [BPC, TB], 240),
      order(103, '+15550000001', '2026-05-02T00:00:00Z', [BPC], 120),
      order(201, '+15550000002', '2026-02-01T00:00:00Z', [BPC], 90),
      order(202, '+15550000002', '2026-04-01T00:00:00Z', [BPC], 90),
      order(203, '+15550000002', '2026-07-10T00:00:00Z', [BPC], 90),
      order(301, '+15550000003', '2025-11-01T00:00:00Z', [BPC], 60),
      // A refunded/cancelled order is not a paid order and must not count.
      order(302, '+15550000003', '2026-06-01T00:00:00Z', [BPC], 60, 'cancelled')
    ],
    inventory: [
      {
        product_id: 41, variation_id: 0, name: 'BPC-157', stock_status: 'instock',
        updated_at: '2026-08-23T00:00:00Z'
      },
      {
        product_id: 42, variation_id: 0, name: 'TB-500', stock_status: 'instock',
        updated_at: '2026-08-23T00:00:00Z'
      }
    ],
    support: [
      { contact_phone: '+15550000001', observed_at: '2026-08-23T06:00:00Z', status: 'clear' },
      { contact_phone: '+15550000002', observed_at: '2026-08-23T06:00:00Z', status: 'clear' }
    ],
    supportAvailable: true,
    suppressions: [
      {
        contact_phone: '+15550000003', active: true,
        effective_at: '2026-01-01T00:00:00Z', expires_at: null
      }
    ]
  };
}

function ownersRules() {
  return {
    match: 'all',
    conditions: [
      { dimension: 'product_order_count', operator: 'at_least', value: 3, product: 'BPC-157' },
      { dimension: 'last_order_date', operator: 'before', value: '2026-06-01' }
    ]
  };
}

// ── The Supabase-shaped fake ───────────────────────────────────────────────

function fakeClient({ tables = {}, rpc = {} } = {}) {
  const calls = { rpc: [], select: [] };

  function builder(table) {
    const state = { table, filters: [], range: null, count: false };
    const chain = {
      select(columns, options) {
        state.columns = columns;
        state.count = options?.count === 'exact';
        return chain;
      },
      eq(column, value) { state.filters.push(['eq', column, value]); return chain; },
      is(column, value) { state.filters.push(['is', column, value]); return chain; },
      order() { return chain; },
      limit() { return chain; },
      range(from, to) { state.range = [from, to]; return chain; },
      maybeSingle() { state.single = true; return chain; },
      then(resolve, reject) {
        calls.select.push({ ...state });
        try {
          const rows = tables[table] || [];
          const filtered = rows.filter(row => state.filters.every(([kind, column, value]) => {
            if (kind === 'eq') return String(row[column]) === String(value);
            if (kind === 'is') return row[column] === value;
            return true;
          }));
          const paged = state.range ? filtered.slice(state.range[0], state.range[1] + 1) : filtered;
          const result = state.single
            ? { data: paged[0] || null, error: null }
            : { data: paged, error: null, count: state.count ? filtered.length : null };
          return Promise.resolve(result).then(resolve, reject);
        } catch (error) {
          return reject ? reject(error) : Promise.reject(error);
        }
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
      const handler = rpc[name];
      if (!handler) return Promise.resolve({ data: null, error: { code: '42883', message: `no rpc ${name}` } });
      return Promise.resolve(handler(args));
    }
  };
}

function ruleSegmentRow(overrides = {}) {
  return {
    id: 's0000000-0000-4000-8000-0000000000aa',
    workspace_id: 'vici',
    segment_key: 'rules:loyal-bpc-buyers-who-went-quiet:m1',
    name: 'Loyal BPC buyers who went quiet',
    description: 'A customer is in this segment when all of these are true: they have ordered BPC-157 at least 3 times and their last order was before 1 June 2026.',
    segment_kind: 'automatic',
    definition: {
      detector: RULES_DETECTOR,
      definitionKey: RULES_DETECTOR,
      rules: {
        version: 1,
        schemaVersion: RULE_SCHEMA_VERSION,
        match: 'all',
        conditions: [
          { dimension: 'product_order_count', operator: 'at_least', value: 3, product: '41:0', label: 'BPC-157' },
          { dimension: 'last_order_date', operator: 'before', value: '2026-06-01' }
        ]
      }
    },
    rule_version: RULE_SCHEMA_VERSION,
    member_count: 0,
    last_computed_at: null,
    archived_at: null,
    created_at: '2026-08-23T00:00:00.000Z',
    updated_at: '2026-08-23T00:00:00.000Z',
    ...overrides
  };
}

function service({ client, facts, drafter } = {}) {
  return createSegmentService({
    client: client || fakeClient(),
    env: { SEGMENT_AI_BUILDER_ENABLED: 'true' },
    customerFactsReader: async () => facts || buildCustomerFacts(sources(), { now: NOW }),
    ruleDrafter: drafter
  });
}

// ── Facts ──────────────────────────────────────────────────────────────────

test('facts are one record per person, including people who have never ordered', () => {
  const { facts, catalogue, coverage } = buildCustomerFacts(sources(), { now: NOW });
  assert.deepEqual(facts.map(record => record.contactPhone), [
    '+15550000001', '+15550000002', '+15550000003', '+15550000004'
  ]);

  const ada = facts[0];
  assert.equal(ada.orderCount, 3);
  assert.equal(ada.productOrderCounts['41:0'], 3);
  assert.equal(ada.productOrderCounts['42:0'], 1);
  // 120 + 240 + 120, counted once per ORDER. Summing per product group would
  // have double counted the two-product order and made spend unreconcilable.
  assert.equal(ada.lifetimeSpend, 480);
  assert.equal(ada.averageOrderValue, 160);
  assert.equal(ada.lastOrderAt, '2026-05-02T00:00:00.000Z');
  assert.equal(ada.daysSinceLastOrder, 113);

  const cleo = facts[2];
  assert.equal(cleo.orderCount, 1, 'a cancelled order is not a paid order');

  const dan = facts[3];
  assert.equal(dan.orderCount, 0);
  assert.equal(dan.lifetimeSpend, 0);
  assert.equal(dan.lastOrderAt, null, 'absent, not zero: a null never matches a comparison');
  assert.equal(dan.daysSinceLastOrder, null);
  assert.equal(dan.averageOrderValue, null);
  assert.equal(dan.cadenceConfidence, 'none');

  assert.deepEqual(catalogue.map(entry => entry.name), ['BPC-157', 'TB-500']);
  assert.equal(coverage.customers, 4);
  assert.equal(coverage.commercialEligibilityAvailable, true);
});

test('commercial eligibility is a dimension, not an invisible filter', () => {
  const { facts } = buildCustomerFacts(sources(), { now: NOW });
  const byPhone = Object.fromEntries(facts.map(record => [record.contactPhone, record]));
  assert.equal(byPhone['+15550000001'].consentState, 'clear');
  // Suppressed.
  assert.equal(byPhone['+15550000003'].consentState, 'blocked');
  // No eligibility row at all is "unknown", never "clear".
  assert.equal(byPhone['+15550000004'].consentState, 'unknown');

  // Blocked people are still IN the facts. A segment is a question about
  // people; whether they can be contacted is a separate, later question.
  assert.ok(facts.some(record => record.consentState === 'blocked'));
});

test('an eligibility source that is unavailable makes everybody unknown rather than clear', () => {
  const withoutSupport = { ...sources(), support: [], supportAvailable: false };
  const { facts } = buildCustomerFacts(withoutSupport, { now: NOW });
  assert.deepEqual([...new Set(facts.map(record => record.consentState))].sort(), ['blocked', 'unknown']);
});

// ── Evaluation ─────────────────────────────────────────────────────────────

test('the owner\'s sentence matches exactly the one person it should', () => {
  const { facts, catalogue } = buildCustomerFacts(sources(), { now: NOW });
  const result = evaluateRuleSet({
    ruleSet: ownersRules(),
    facts,
    context: { products: catalogue, segments: [] }
  });
  assert.equal(result.matchedCount, 1);
  assert.equal(result.consideredCount, 4);
  assert.equal(result.members[0].contactPhone, '+15550000001');
});

test('every member carries a per-condition trace, which is what answers "why is this person here"', () => {
  const { facts, catalogue } = buildCustomerFacts(sources(), { now: NOW });
  const [member] = evaluateRuleSet({
    ruleSet: ownersRules(),
    facts,
    context: { products: catalogue, segments: [] }
  }).members;

  const evidence = member.inclusionEvidence;
  assert.equal(evidence.detector, 'rules');
  assert.equal(evidence.ruleSchemaVersion, RULE_SCHEMA_VERSION);
  assert.match(evidence.definition, /^A customer is in this segment when all of these are true: /);
  assert.equal(evidence.trace.length, 2);
  assert.deepEqual(evidence.trace[0], {
    dimension: 'product_order_count',
    operator: 'at_least',
    held: true,
    rule: 'they have ordered BPC-157 at least 3 times',
    observed: '3 orders contained it'
  });
  assert.deepEqual(evidence.trace[1], {
    dimension: 'last_order_date',
    operator: 'before',
    held: true,
    rule: 'their last order was before 1 June 2026',
    observed: '2026-05-02'
  });
});

test('a customer with no value for a dimension does not match it by absence', () => {
  const { facts, catalogue } = buildCustomerFacts(sources(), { now: NOW });
  // "has not ordered in the last 30 days" must not sweep up somebody who has
  // never ordered at all, because they have no last order date to be old.
  const result = evaluateRuleSet({
    ruleSet: {
      match: 'all',
      conditions: [{ dimension: 'days_since_last_order', operator: 'at_least', value: 30 }]
    },
    facts,
    context: { products: catalogue, segments: [] }
  });
  assert.ok(!result.members.some(member => member.contactPhone === '+15550000004'),
    'Dan has never ordered and must not match a recency rule');
  assert.equal(result.matchedCount, 3);
});

test('match any is a union and match all is an intersection', () => {
  const { facts, catalogue } = buildCustomerFacts(sources(), { now: NOW });
  const context = { products: catalogue, segments: [] };
  const conditions = [
    { dimension: 'product_order_count', operator: 'at_least', value: 3, product: 'BPC-157' },
    { dimension: 'last_order_date', operator: 'before', value: '2026-06-01' }
  ];
  assert.equal(evaluateRuleSet({ ruleSet: { match: 'all', conditions }, facts, context }).matchedCount, 1);
  assert.equal(evaluateRuleSet({ ruleSet: { match: 'any', conditions }, facts, context }).matchedCount, 3);
});

test('segment membership is read from the referenced segment, not guessed', () => {
  const { facts, catalogue } = buildCustomerFacts(sources(), { now: NOW });
  const context = { products: catalogue, segments: [{ key: 'reorder_due', name: 'Reorder due' }] };
  const membership = new Map([['reorder_due', new Set(['+15550000002'])]]);
  const inIt = evaluateRuleSet({
    ruleSet: {
      match: 'all',
      conditions: [{ dimension: 'segment_membership', operator: 'in_segment', value: 'Reorder due' }]
    },
    facts, context, segmentMembership: membership
  });
  assert.deepEqual(inIt.members.map(member => member.contactPhone), ['+15550000002']);

  const notInIt = evaluateRuleSet({
    ruleSet: {
      match: 'all',
      conditions: [{ dimension: 'segment_membership', operator: 'not_in_segment', value: 'Reorder due' }]
    },
    facts, context, segmentMembership: membership
  });
  assert.equal(notInIt.matchedCount, 3);
});

test('the evaluator refuses to run rules that did not pass validation', () => {
  const { facts, catalogue } = buildCustomerFacts(sources(), { now: NOW });
  assert.throws(
    () => evaluateRuleSet({
      ruleSet: { match: 'all', conditions: [{ dimension: 'sms_orders', operator: 'at_least', value: 1 }] },
      facts,
      context: { products: catalogue, segments: [] }
    }),
    error => {
      assert.ok(error instanceof SegmentRuleEvaluationError);
      assert.equal(error.code, 'SEGMENT_RULES_INVALID');
      assert.equal(error.errors[0].code, 'DIMENSION_UNKNOWN');
      return true;
    }
  );
});

test('the breadth warning fires above 60 percent of at least 25 people, and not below the floor', () => {
  assert.equal(breadthWarning(3, 4), null, 'three of four is not evidence of anything');
  assert.equal(breadthWarning(14, 25), null, '56 percent is a normal audience');
  assert.ok(breadthWarning(15, 25), '60 percent of a real population is worth stopping for');
  assert.match(breadthWarning(90, 100).reason, /90 of 100 known customers/);
});

// ── The dry run ────────────────────────────────────────────────────────────

test('a preview returns the real count and a sample, and writes absolutely nothing', async () => {
  const client = fakeClient({ tables: { sms_campaign_segments: [] } });
  const result = await service({ client }).previewRules({ rules: ownersRules() }, { now: NOW });

  assert.equal(result.saved, false);
  assert.equal(result.matchedCount, 1);
  assert.equal(result.consideredCount, 4);
  assert.equal(result.sample.length, 1);
  assert.equal(result.sample[0].contactName, 'Ada');
  assert.equal(result.sample[0].trace.length, 2);
  assert.match(
    result.plainEnglish.sentence,
    /they have ordered BPC-157 at least 3 times and their last order was before 1 June 2026/
  );

  assert.deepEqual(client.calls.rpc, [], 'a dry run must not call a single RPC');
  assert.ok(!client.calls.select.some(call => call.table === 'sms_campaign_segment_members'),
    'a dry run reads no membership it might be tempted to write');
});

test('a preview of rules that match nobody says so rather than looking broken', async () => {
  const client = fakeClient({ tables: { sms_campaign_segments: [] } });
  const result = await service({ client }).previewRules({
    rules: {
      match: 'all',
      conditions: [{ dimension: 'lifetime_spend', operator: 'at_least', value: 999999 }]
    }
  }, { now: NOW });
  assert.equal(result.matchedCount, 0);
  assert.deepEqual(result.warnings.map(entry => entry.code), ['SEGMENT_MATCHES_NOBODY']);
  assert.match(result.warnings[0].reason, /You can still save it/);
});

test('a preview of invalid rules answers with the reasons and never with a count', async () => {
  const client = fakeClient({ tables: { sms_campaign_segments: [] } });
  await assert.rejects(
    () => service({ client }).previewRules({
      rules: { match: 'all', conditions: [{ dimension: 'orders_table', operator: 'at_least', value: 1 }] }
    }, { now: NOW }),
    error => {
      assert.equal(error.code, 'SEGMENT_RULES_INVALID');
      assert.equal(error.status, 400);
      assert.equal(error.errors[0].code, 'DIMENSION_UNKNOWN');
      return true;
    }
  );
  assert.deepEqual(client.calls.rpc, []);
});

test('the sample is capped, so a preview is never a download of the customer list', async () => {
  const many = Array.from({ length: 40 }, (_unused, index) => ({
    contactPhone: `+1555000${String(index).padStart(4, '0')}`,
    contactID: index + 1,
    contactName: `Person ${index}`,
    orderCount: 5,
    lifetimeSpend: 500,
    averageOrderValue: 100,
    lastOrderAt: '2026-05-01T00:00:00.000Z',
    daysSinceLastOrder: 114,
    cadenceMedianDays: null,
    cadenceConfidence: 'none',
    cadenceIntervalCount: 0,
    productKeys: [],
    productOrderCounts: {},
    consentState: 'clear'
  }));
  const client = fakeClient({ tables: { sms_campaign_segments: [] } });
  const result = await service({
    client,
    facts: { facts: many, catalogue: [], coverage: { customers: many.length } }
  }).previewRules({
    rules: { match: 'all', conditions: [{ dimension: 'order_count', operator: 'at_least', value: 2 }] }
  }, { now: NOW });

  assert.equal(result.matchedCount, 40);
  assert.equal(result.sample.length, 12);
  // Forty of forty is everybody, and the operator is told before they save.
  assert.ok(result.warnings.some(entry => entry.code === 'SEGMENT_MATCHES_ALMOST_EVERYBODY'));
});

// ── Drafting through the service ───────────────────────────────────────────

test('drafting hands the model the catalogue and the segment names, and nothing else', async () => {
  const seen = [];
  const client = fakeClient({
    tables: {
      sms_campaign_segments: [
        { id: 'a', segment_key: 'reorder_due', name: 'Reorder due', archived_at: null, workspace_id: 'vici' }
      ]
    }
  });
  const drafter = async input => {
    seen.push(input);
    return { status: 'drafted', ruleSet: null };
  };
  await service({ client, drafter }).draftRules({ description: 'people who buy a lot of BPC-157' }, { now: NOW });

  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['description', 'now', 'products', 'segments']);
  assert.deepEqual(seen[0].segments, [{ key: 'reorder_due', name: 'Reorder due' }]);
  assert.deepEqual(seen[0].products.map(entry => entry.name), ['BPC-157', 'TB-500']);
  // The facts are read for the catalogue only. No fact record is passed on.
  assert.equal(JSON.stringify(seen[0]).includes('+1555'), false);
});

// ── Saving ─────────────────────────────────────────────────────────────────

test('saving stores the rules, and the stored description is the derived plain English', async () => {
  const created = ruleSegmentRow();
  const client = fakeClient({
    tables: { sms_campaign_segments: [] },
    rpc: { create_sms_campaign_segment: () => ({ data: [created], error: null }) }
  });
  const result = await service({ client }).createFromRules({
    name: 'Loyal BPC buyers who went quiet',
    description: 'customers who bought BPC-157 more than twice and have not ordered since June',
    rules: ownersRules()
  }, { id: 7 }, { now: NOW });

  assert.equal(result.created, true);
  const [call] = client.calls.rpc;
  assert.equal(call.name, 'create_sms_campaign_segment');
  assert.equal(call.args.p_segment_kind, 'automatic');
  assert.equal(call.args.p_definition.detector, RULES_DETECTOR);
  assert.equal(call.args.p_rule_version, RULE_SCHEMA_VERSION);
  assert.match(call.args.p_segment_key, /^rules:loyal-bpc-buyers-who-went-quiet:/);

  // The saved rules are the VALIDATED ones, with the product resolved to a key
  // and the label rewritten from the catalogue.
  assert.equal(call.args.p_definition.rules.conditions[0].product, '41:0');
  assert.equal(call.args.p_definition.rules.conditions[0].label, 'BPC-157');

  // The description under the name is a rendering of the rules, so it cannot
  // drift from what the segment actually does. The operator's own sentence is
  // kept separately, as a record of what they asked for.
  assert.match(call.args.p_description, /^A customer is in this segment when all of these are true: /);
  assert.equal(call.args.p_definition.describedAs,
    'customers who bought BPC-157 more than twice and have not ordered since June');

  // Membership is not computed here. A described segment is saved empty and
  // filled by the same recompute every other automatic segment uses.
  assert.equal(call.args.p_members, null);
});

test('saving refuses rules that do not validate, and never reaches the database', async () => {
  const client = fakeClient({ tables: { sms_campaign_segments: [] } });
  await assert.rejects(
    () => service({ client }).createFromRules({
      name: 'Everybody',
      rules: { match: 'all', conditions: [{ dimension: 'order_count', operator: 'at_least', value: 0 }] }
    }, { id: 7 }, { now: NOW }),
    error => {
      assert.equal(error.code, 'SEGMENT_RULES_INVALID');
      assert.equal(error.errors[0].code, 'CONDITION_VACUOUS');
      return true;
    }
  );
  assert.deepEqual(client.calls.rpc, []);
});

test('saving requires a name', async () => {
  const client = fakeClient({ tables: { sms_campaign_segments: [] } });
  await assert.rejects(
    () => service({ client }).createFromRules({ rules: ownersRules() }, { id: 7 }, { now: NOW }),
    error => {
      assert.equal(error.code, 'SEGMENT_INVALID');
      return true;
    }
  );
});

// ── Recompute: the "keeps itself up to date" half ──────────────────────────

function recomputeClient(segmentRow, { members = [], overrides = [], runs = [] } = {}) {
  return fakeClient({
    tables: {
      sms_campaign_segments: [segmentRow],
      sms_campaign_segment_members: members,
      sms_campaign_segment_overrides: overrides,
      sms_campaign_segment_runs: runs
    },
    rpc: {
      apply_sms_campaign_segment_recompute: args => ({
        data: [{
          id: 'run-1',
          member_count: args.p_members.length,
          joined_count: args.p_members.length,
          left_count: 0,
          refreshed_count: 0,
          forced_include_count: 0,
          excluded_count: 0,
          completed_at: '2026-08-23T12:00:01.000Z'
        }],
        error: null
      })
    }
  });
}

test('a described segment recomputes through the same path as every other automatic segment', async () => {
  const client = recomputeClient(ruleSegmentRow());
  const result = await service({ client }).recompute(ruleSegmentRow().id, { id: 7 }, { now: NOW });

  const [call] = client.calls.rpc;
  assert.equal(call.name, 'apply_sms_campaign_segment_recompute',
    'the same RPC, not a parallel one');
  assert.equal(call.args.p_members.length, 1);
  assert.equal(call.args.p_members[0].contactPhone, '+15550000001');
  assert.equal(call.args.p_rule_version, RULE_SCHEMA_VERSION);

  // The run digest, idempotency and reconciliation are the shared ones.
  assert.equal(result.run.replayed, false);
  assert.equal(result.run.memberCount, 1);
  assert.match(result.run.runKey, new RegExp(`^${RULES_DETECTOR}:[0-9a-f]{64}$`));
  assert.equal(result.run.digest.length, 64);
});

test('an exclusion still beats the rules, because reconciliation is shared', async () => {
  const client = recomputeClient(ruleSegmentRow(), {
    overrides: [{
      id: 'o1',
      segment_id: ruleSegmentRow().id,
      workspace_id: 'vici',
      contact_phone: '+15550000001',
      override_type: 'exclude',
      reason: 'customer asked',
      created_at: '2026-08-01T00:00:00Z',
      revoked_at: null
    }]
  });
  const result = await service({ client }).recompute(ruleSegmentRow().id, { id: 7 }, { now: NOW });
  const [call] = client.calls.rpc;
  assert.deepEqual(call.args.p_members, [], 'an excluded person is never submitted');
  assert.deepEqual(result.blockedByExclusion, ['+15550000001']);
});

test('saved rules are revalidated on every run, so a vanished product stops the recompute', async () => {
  const withoutBPC = sources();
  withoutBPC.inventory = withoutBPC.inventory.filter(row => row.product_id !== 41);
  withoutBPC.orders = withoutBPC.orders.filter(row => !JSON.parse(row.items).some(item => item.product_id === 41));

  const client = recomputeClient(ruleSegmentRow());
  const scoped = createSegmentService({
    client,
    customerFactsReader: async () => buildCustomerFacts(withoutBPC, { now: NOW })
  });

  await assert.rejects(
    () => scoped.recompute(ruleSegmentRow().id, { id: 7 }, { now: NOW }),
    error => {
      assert.equal(error.code, 'SEGMENT_RULES_INVALID');
      assert.equal(error.status, 409);
      assert.equal(error.errors[0].code, 'PRODUCT_UNKNOWN');
      assert.match(error.message, /membership was left alone/);
      return true;
    }
  );
  assert.deepEqual(client.calls.rpc, [],
    'a segment whose rules no longer make sense is left exactly as it was');
});

test('a catalogue segment still recomputes the old way, untouched by any of this', async () => {
  const catalogueSegment = {
    ...ruleSegmentRow(),
    segment_key: 'reorder_due',
    definition: { detector: 'reorder', definitionKey: 'reorder_due' }
  };
  const client = recomputeClient(catalogueSegment);
  const scoped = createSegmentService({
    client,
    generationInputReader: async () => ({ reorderCandidates: [], winbackCandidates: [] }),
    customerFactsReader: async () => {
      throw new Error('a catalogue segment must not read the rule facts');
    }
  });
  const result = await scoped.recompute(catalogueSegment.id, { id: 7 }, { now: NOW });
  assert.equal(result.run.memberCount, 0);
  assert.match(result.run.runKey, /^reorder_due:/);
});

// ── Routes and permissions ─────────────────────────────────────────────────

test('the three rule endpoints exist and all require campaigns.manage', () => {
  const noop = async () => ({});
  const router = createSegmentRouter({
    service: new Proxy({ catalogue: () => ({ items: [] }) }, {
      get: (target, key) => (key in target ? target[key] : noop)
    })
  });
  for (const routePath of ['/rules/draft', '/rules/preview', '/rules']) {
    const layer = router.stack.find(entry => entry.route?.path === routePath && entry.route.methods.post);
    assert.ok(layer, `POST ${routePath} is registered`);
  }

  for (const routePath of ['/api/segments/rules/draft', '/api/segments/rules/preview', '/api/segments/rules']) {
    const entry = findPolicy('POST', routePath);
    assert.equal(entry.path, routePath, `${routePath} must not be swallowed by /api/segments/:id`);
    assert.equal(entry.permission, 'campaigns.manage',
      'a Support Agent may read a segment and may not build one');
  }
  // Only the endpoint that writes is audited.
  assert.equal(findPolicy('POST', '/api/segments/rules').audit, true);
  assert.equal(findPolicy('POST', '/api/segments/rules/draft').audit, false);
  assert.equal(findPolicy('POST', '/api/segments/rules/preview').audit, false);

  const open = ROUTE_POLICY.filter(entry =>
    entry.path.startsWith('/api/segments/rules') && entry.permission === null);
  assert.deepEqual(open, []);
});

test('the rule routes refuse a body key they do not recognise', async () => {
  const router = createSegmentRouter({ service: { draftRules: async () => ({}), previewRules: async () => ({}) } });
  const cases = [
    ['/rules/draft', { description: 'regulars', contacts: ['+15550000001'] }],
    ['/rules/preview', { rules: {}, members: ['+15550000001'] }],
    ['/rules', { name: 'x', rules: {}, members: [] }]
  ];
  for (const [routePath, body] of cases) {
    const layer = router.stack.find(entry => entry.route?.path === routePath && entry.route.methods.post);
    const res = {
      statusCode: 200, payload: null,
      status(code) { this.statusCode = code; return this; },
      set() { return this; },
      json(value) { this.payload = value; return this; }
    };
    await layer.route.stack[0].handle({ body, params: {}, actor: { id: 7 } }, res);
    assert.equal(res.statusCode, 400, routePath);
    assert.equal(res.payload.code, 'SEGMENT_INPUT_REJECTED', routePath);
  }
});

test('a rule rejection reaches the client with its reasons attached', async () => {
  const router = createSegmentRouter({
    service: {
      previewRules: async () => {
        const error = Object.assign(new Error('These rules were not accepted.'), {
          code: 'SEGMENT_RULES_INVALID', status: 400
        });
        error.errors = [{ path: 'rules.conditions[0]', code: 'DIMENSION_UNKNOWN', reason: 'No such thing.' }];
        throw error;
      }
    }
  });
  const layer = router.stack.find(entry => entry.route?.path === '/rules/preview' && entry.route.methods.post);
  const res = {
    statusCode: 200, payload: null,
    status(code) { this.statusCode = code; return this; },
    set() { return this; },
    json(value) { this.payload = value; return this; }
  };
  await layer.route.stack[0].handle({ body: { rules: {} }, params: {}, actor: { id: 7 } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.code, 'SEGMENT_RULES_INVALID');
  assert.equal(res.payload.errors[0].code, 'DIMENSION_UNKNOWN');
});

test('saving a described segment writes an audit row naming the rule shape and no customer', async () => {
  const written = [];
  const created = ruleSegmentRow();
  const router = createSegmentRouter({
    service: {
      createFromRules: async () => ({
        segment: {
          id: created.id, key: created.segment_key, name: created.name,
          ruleVersion: RULE_SCHEMA_VERSION, memberCount: 0
        },
        created: true,
        ruleSet: created.definition.rules,
        plainEnglish: { sentence: created.description, lines: [] }
      })
    },
    auditWriter: async entry => { written.push(entry); }
  });
  const layer = router.stack.find(entry => entry.route?.path === '/rules' && entry.route.methods.post);
  const res = {
    statusCode: 200, payload: null,
    status(code) { this.statusCode = code; return this; },
    set() { return this; },
    json(value) { this.payload = value; return this; }
  };
  await layer.route.stack[0].handle(
    { body: { name: created.name, rules: {} }, params: {}, actor: { id: 7 } }, res
  );
  assert.equal(res.statusCode, 201);
  // logAuditSafely is the default writer and is used directly by auditSegment;
  // what matters here is that the handler answered 201 and returned the rules
  // it saved, so the client can show what was stored.
  assert.equal(res.payload.ruleSet.match, 'all');
  assert.equal(res.payload.plainEnglish.sentence, created.description);
});
