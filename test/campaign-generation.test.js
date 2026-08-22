'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CampaignGenerationError,
  authoritativeSupportState,
  buildGenerationInput,
  createAuthoritativeWooRefetch,
  createCampaignGenerationService,
  pageRows,
  selectedWorkflows
} = require('../lib/campaigns/generation-service');

test('workflow selection is an exact allowlist', () => {
  assert.deepEqual(selectedWorkflows(['reorder', 'reorder', 'winback']), ['reorder', 'winback']);
  assert.throws(() => selectedWorkflows([]), CampaignGenerationError);
  assert.throws(() => selectedWorkflows(['manual']), /Unsupported/);
});

test('authoritative support state fails closed when absent, stale or future-dated', () => {
  const now = new Date('2026-08-22T12:00:00.000Z');
  assert.equal(authoritativeSupportState(null, now), 'unknown');
  assert.equal(authoritativeSupportState({ status: 'clear', observed_at: '2026-08-21T11:59:00Z' }, now), 'unknown');
  assert.equal(authoritativeSupportState({ status: 'clear', observed_at: '2026-08-22T12:01:00Z' }, now), 'unknown');
  assert.equal(authoritativeSupportState({ status: 'clear', observed_at: '2026-08-22T11:00:00Z' }, now), 'clear');
  assert.equal(authoritativeSupportState({
    status: 'clear', observed_at: '2026-08-22T11:00:00Z', expires_at: '2026-08-22T11:30:00Z'
  }, now), 'unknown');
});

test('paginated source reads do not silently truncate a full page', async () => {
  const pages = [Array.from({ length: 1000 }, (_, id) => ({ id })), [{ id: 1000 }]];
  const ranges = [];
  const rows = await pageRows(() => ({
    range: async (from, to) => {
      ranges.push([from, to]);
      return { data: pages.shift(), error: null };
    }
  }), 'source');
  assert.equal(rows.length, 1001);
  assert.deepEqual(ranges, [[0, 999], [1000, 1999]]);
});

test('generation input uses exact product identities and suppresses unknown support state', () => {
  const now = new Date('2026-08-22T12:00:00.000Z');
  const sources = {
    orders: [{
      id: 1, woo_order_id: 99, contact_phone: '+15555550123', status: 'completed',
      created_at: '2026-07-01T12:00:00Z', total: 90,
      items: [{ product_id: 42, variation_id: 7, name: 'Exact' }, { name: 'No identity' }]
    }],
    contacts: [{ id: 5, phone: '+15555550123' }],
    inventory: [{
      product_id: 42, variation_id: 7, name: 'Exact', stock_status: 'instock',
      stock_quantity: 2, updated_at: '2026-08-22T11:00:00Z'
    }],
    support: [], supportAvailable: true,
    ledger: [], suppressions: [], opportunities: [], restockEvents: []
  };
  const input = buildGenerationInput(sources, { now, workflows: ['reorder'] });
  assert.equal(input.reorderCandidates.length, 0);
  assert.equal(input.sourceCoverage.nonExactOrderItems, 1);
  assert.equal(input.sourceSuppressions[0].reasons[0], 'support_state_unknown');

  sources.support = [{
    contact_phone: '+15555550123', status: 'clear', source: 'support_sync',
    evidence_ref: 'case-snapshot:1', observed_at: '2026-08-22T11:00:00Z'
  }];
  const clear = buildGenerationInput(sources, { now, workflows: ['reorder'] });
  assert.equal(clear.reorderCandidates.length, 1);
  assert.equal(clear.reorderCandidates[0].productID, 42);
  assert.equal(clear.reorderCandidates[0].variationID, 7);
});

test('Woo refetch verifies the exact parent and variation identity', async () => {
  const paths = [];
  const refetch = createAuthoritativeWooRefetch(async path => {
    paths.push(path);
    return { data: { id: 7, parent_id: 42, stock_status: 'instock', stock_quantity: 3 } };
  });
  const exact = await refetch({ productID: 42, variationID: 7 });
  assert.equal(exact.trusted, true);
  assert.equal(exact.snapshot.product_id, 42);
  assert.equal(exact.snapshot.variation_id, 7);
  assert.deepEqual(paths, ['/products/42/variations/7']);

  const mismatch = await createAuthoritativeWooRefetch(async () => ({
    data: { id: 8, parent_id: 42, stock_status: 'instock' }
  }))({ productID: 42, variationID: 7 });
  assert.equal(mismatch.trusted, false);
  assert.equal(mismatch.snapshot, null);
});

test('dry-run stays read-only while commit is rejected before source reads when flags are off', async () => {
  let reads = 0;
  const service = createCampaignGenerationService({
    client: {}, env: {},
    sourceReader: async () => {
      reads += 1;
      return {
        orders: [], contacts: [], inventory: [], restockEvents: [], opportunities: [],
        ledger: [], suppressions: [], support: [], supportAvailable: false, notificationUsers: []
      };
    },
    wooGet: async () => { throw new Error('must not refetch without candidates'); }
  });
  const dry = await service.generate({ workflows: ['reorder'] });
  assert.equal(dry.summary.mode, 'authoritative_dry_run');
  assert.equal(reads, 1);
  await assert.rejects(
    service.generate({ workflows: ['reorder'], commit: true, actor: { id: 1 } }),
    error => error.code === 'CAMPAIGN_GENERATION_DISABLED'
  );
  assert.equal(reads, 1, 'disabled persistence must fail before authoritative reads');
});

test('enabled commit freezes exact product evidence and uses one atomic RPC without sending', async () => {
  const now = Date.now();
  let rpcCall;
  const client = {
    rpc: async (name, params) => {
      rpcCall = { name, params };
      return {
        data: {
          campaigns: [{ id: 'campaign-1', status: 'draft', workflow_category: 'back_in_stock' }],
          insertedCampaigns: 1, reusedCampaigns: 0
        }, error: null
      };
    }
  };
  const sourceReader = async () => ({
    orders: [{
      id: 1, woo_order_id: 100, contact_phone: '+15555550123', status: 'completed',
      created_at: new Date(now - 30 * 86400000).toISOString(), total: 100,
      items: [{ product_id: 42, variation_id: 7, name: 'Exact' }]
    }],
    contacts: [{ id: 8, phone: '+15555550123', woo_customer_id: 99 }],
    inventory: [{
      product_id: 42, variation_id: 7, name: 'Exact', stock_status: 'instock',
      stock_quantity: 4, updated_at: new Date(now - 3600000).toISOString()
    }],
    restockEvents: [{
      id: 77, product_id: 42, variation_id: 7, name: 'Exact', delivery_id: 'woo-delivery-77',
      previous_stock_status: 'outofstock', current_stock_status: 'instock',
      previous_quantity: 0, current_quantity: 4, signature_valid: true,
      received_at: new Date(now - 10 * 60000).toISOString()
    }],
    opportunities: [], ledger: [], suppressions: [], supportAvailable: true,
    support: [{
      contact_phone: '+15555550123', status: 'clear', source: 'support_sync',
      evidence_ref: 'snapshot:77', observed_at: new Date(now - 3600000).toISOString()
    }],
    notificationUsers: [{ id: 1, role: 'owner', isActive: true, canApproveCampaigns: true }]
  });
  const service = createCampaignGenerationService({
    client,
    env: {
      CAMPAIGN_OPPORTUNITY_DRAFTS_ENABLED: 'true',
      CAMPAIGN_BACK_IN_STOCK_DETECTOR_ENABLED: 'true'
    },
    sourceReader,
    wooGet: async () => ({
      data: { id: 7, parent_id: 42, name: 'Exact', stock_status: 'instock', stock_quantity: 4 }
    })
  });
  const result = await service.generate({ workflows: ['back_in_stock'], commit: true, actor: { id: 1 } });
  assert.equal(rpcCall.name, 'persist_sms_opportunity_draft_bundle');
  assert.equal(rpcCall.params.p_actor_user_id, 1);
  assert.equal(rpcCall.params.p_drafts.length, 1);
  const recipient = rpcCall.params.p_drafts[0].recipients[0];
  assert.equal(recipient.inclusionReason.productID, '42');
  assert.equal(recipient.inclusionReason.variationID, '7');
  assert.equal(recipient.inclusionReason.wooCustomerID, 99);
  assert.equal(result.summary.persisted.insertedCampaigns, 1);
  assert.equal(result.notifications.length, 1);
});
