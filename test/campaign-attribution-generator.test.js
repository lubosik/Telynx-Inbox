'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  REQUIRED_WORKFLOWS,
  classifyTrustedTouch,
  frozenTargetProducts,
  loadActivePolicies,
  reconcileCampaignAttributionsForOrder
} = require('../lib/campaigns/attribution-generator');

function policies() {
  return REQUIRED_WORKFLOWS.map(workflow => ({
    workflow_category: workflow,
    policy_version: 1,
    methodology_version: 'vici-campaign-revenue-v1',
    strong_window_seconds: workflow.startsWith('reorder') ? 604800 : 259200,
    maximum_window_seconds: workflow.startsWith('reorder') ? 1209600 : 604800,
    product_identity_required: ['back_in_stock', 'back_in_stock_requested', 'back_in_stock_repeat_buyer', 'reorder', 'reorder_personal', 'reorder_personal_high', 'manual_exact_product'].includes(workflow),
    allowed_direct_evidence: [], active: true, workspace_id: 'vici'
  }));
}

function fakeClient(seed, { missingPolicies = false, policyError = null } = {}) {
  const rpcCalls = [];
  function builder(table) {
    let rows = [...(seed[table] || [])];
    let error = table === 'campaign_attribution_policies'
      ? (policyError || (missingPolicies
        ? { code: '42P01', message: 'relation campaign_attribution_policies does not exist' }
        : null))
      : null;
    const query = {
      select() { return this; },
      eq(column, value) { rows = rows.filter(row => row[column] === value); return this; },
      in(column, values) { rows = rows.filter(row => values.map(String).includes(String(row[column]))); return this; },
      order(column, { ascending = true } = {}) {
        rows.sort((a, b) => String(a[column] || '').localeCompare(String(b[column] || '')) * (ascending ? 1 : -1));
        return this;
      },
      range(from, to) { return Promise.resolve({ data: error ? null : rows.slice(from, to + 1), error }); }
    };
    return query;
  }
  return {
    rpcCalls,
    from: builder,
    rpc: async (name, args) => {
      rpcCalls.push({ name, args });
      return { data: { order_id: args.p_candidate.order_id }, error: null };
    }
  };
}

function order(overrides = {}) {
  return {
    id: 18472, customer_id: 99, status: 'processing', currency: 'USD', total: '219.00',
    date_paid_gmt: '2026-08-22T12:30:00', date_modified_gmt: '2026-08-22T12:30:01',
    billing: { phone: '+15551234567' }, refunds: [],
    line_items: [{ product_id: 42, variation_id: 7, quantity: 1, total: '219.00' }],
    ...overrides
  };
}

function seed(overrides = {}) {
  return {
    campaign_attribution_policies: policies(),
    sms_campaign_recipients: [{
      id: '11111111-1111-4111-8111-111111111111', campaign_id: '22222222-2222-4222-8222-222222222222',
      workspace_id: 'vici', contact_phone: '+15551234567',
      inclusion_reason: { productID: '42', variationID: '7', wooCustomerID: '99' },
      state: 'delivered', selected: true, approved_in_audience: true,
      approval_revision: 3, provider_message_id: 'telnyx-message-1', delivered_at: '2026-08-22T12:00:00Z'
    }],
    sms_campaigns: [{
      id: '22222222-2222-4222-8222-222222222222', workspace_id: 'vici',
      workflow_category: 'reorder', status: 'completed', revision: 3,
      audience_definition: { frozen: true }, created_at: '2026-08-22T11:00:00Z'
    }],
    sms_campaign_recipient_events: [{
      id: 1, recipient_id: '11111111-1111-4111-8111-111111111111',
      campaign_id: '22222222-2222-4222-8222-222222222222', workspace_id: 'vici',
      event_type: 'provider.delivered', occurred_at: '2026-08-22T12:00:00Z',
      provider: 'telnyx', provider_event_id: 'telnyx-event-1', provider_message_id: 'telnyx-message-1',
      trusted: true, trust_source: 'telnyx_ed25519_v2'
    }],
    ...overrides
  };
}

test('frozen product evidence accepts only positive exact IDs and preserves variation zero as parent', () => {
  assert.deepEqual(frozenTargetProducts({ inclusion_reason: { productID: 42, variationID: 7 } }), [{ productID: '42', variationID: '7' }]);
  assert.deepEqual(frozenTargetProducts({ inclusion_reason: { productID: 42, variationID: 0 } }), [{ productID: '42', variationID: null }]);
  assert.deepEqual(frozenTargetProducts({ inclusion_reason: { productName: 'looks similar', sku: 'X' } }), []);
  assert.deepEqual(frozenTargetProducts({ inclusion_reason: { productID: -1 } }), []);
});

test('versioned policies must be complete and internally valid', async () => {
  const complete = await loadActivePolicies(fakeClient(seed()), 'vici');
  assert.equal(complete.size, REQUIRED_WORKFLOWS.length);
  await assert.rejects(() => loadActivePolicies(fakeClient(seed({
    campaign_attribution_policies: policies().slice(1)
  })), 'vici'), /not ready/i);
});

test('exact signed delivery plus frozen customer/product and Woo payment stages Strong once', async () => {
  const client = fakeClient(seed());
  const result = await reconcileCampaignAttributionsForOrder({
    client, order: order(), workspaceID: 'vici', financialObservedAt: '2026-08-22T12:30:01Z'
  });
  assert.deepEqual(result, { ready: true, candidates: 1, staged: 1 });
  assert.equal(client.rpcCalls.length, 1);
  const staged = client.rpcCalls[0].args.p_candidate;
  assert.equal(staged.confidence_level, 'strong');
  assert.equal(staged.confidence_score, '0.90');
  assert.equal(staged.campaign_id, '22222222-2222-4222-8222-222222222222');
  assert.deepEqual(staged.supporting_evidence.codes.includes('exact_target_product'), true);
  assert.equal(JSON.stringify(staged).includes('message body'), false);
});

test('untrusted delivery, mismatched variation and missing schema never invent revenue', async () => {
  const unsafe = seed();
  unsafe.sms_campaign_recipient_events[0].trusted = false;
  const unsafeClient = fakeClient(unsafe);
  assert.deepEqual(await reconcileCampaignAttributionsForOrder({
    client: unsafeClient, order: order(), financialObservedAt: '2026-08-22T12:30:01Z'
  }), { ready: true, candidates: 0, staged: 0 });
  assert.equal(unsafeClient.rpcCalls.length, 0);

  const mismatchClient = fakeClient(seed());
  await reconcileCampaignAttributionsForOrder({
    client: mismatchClient,
    order: order({ line_items: [{ product_id: 42, variation_id: 8, total: '219.00' }] }),
    financialObservedAt: '2026-08-22T12:30:01Z'
  });
  assert.equal(mismatchClient.rpcCalls[0].args.p_candidate.confidence_level, 'unattributed');

  const missing = fakeClient(seed(), { missingPolicies: true });
  const unavailable = await reconcileCampaignAttributionsForOrder({
    client: missing, order: order(), financialObservedAt: '2026-08-22T12:30:01Z'
  });
  assert.equal(unavailable.ready, false);
  assert.equal(missing.rpcCalls.length, 0);
});

test('permission failures are not disguised as missing schema', async () => {
  const denied = fakeClient(seed(), {
    policyError: { code: '42501', message: 'permission denied for table campaign_attribution_policies' }
  });
  await assert.rejects(() => reconcileCampaignAttributionsForOrder({
    client: denied, order: order(), financialObservedAt: '2026-08-22T12:30:01Z'
  }), error => error?.code === '42501');
});

test('cancelling a partially delivered campaign does not erase its trusted historical touch', async () => {
  const data = seed();
  data.sms_campaigns[0].status = 'cancelled';
  const client = fakeClient(data);
  const result = await reconcileCampaignAttributionsForOrder({
    client, order: order(), financialObservedAt: '2026-08-22T12:30:01Z'
  });
  assert.deepEqual(result, { ready: true, candidates: 1, staged: 1 });
});

test('policy migration is versioned, tenant scoped, RLS protected and Direct-default-off', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'campaign-attribution-policy-migration.sql'), 'utf8');
  assert.match(sql, /UNIQUE \(workspace_id, workflow_category, policy_version\)/);
  assert.match(sql, /to_regprocedure\('public\.stage_revenue_attribution_candidate\(jsonb\)'\)/);
  assert.match(sql, /WHERE active = true/);
  assert.match(sql, /allowed_direct_evidence[\s\S]*DEFAULT '\{\}'::text\[\]/);
  assert.match(sql, /maximum_window_seconds >= strong_window_seconds/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.campaign_attribution_policies FROM PUBLIC, anon, authenticated/);
});

test('Woo reconciliation invokes campaign attribution only after trusted order capture', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'analytics', 'events.js'), 'utf8');
  const insert = source.indexOf("from('analytics_order_events').upsert");
  const campaign = source.indexOf('await reconcileCampaignAttributionsForOrder');
  assert.ok(insert >= 0 && campaign > insert);
});
