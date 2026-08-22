'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  MINIMUM_RESTOCK_DEBOUNCE_SECONDS,
  opportunityFeatureFlags,
  persistPreparedDraftRun,
  prepareOpportunityDraftRun
} = require('../lib/campaigns/opportunity-orchestrator');
const { prepareCampaignReadyNotifications } = require('../lib/campaigns/campaign-ready-notifications');
const { prepareDraftCopy } = require('../lib/campaigns/draft-copy');
const { summary } = require('../scripts/dry-run-campaign-opportunities');

const NOW = '2026-08-22T12:00:00.000Z';
const PHONE = '+13055550123';

test('opportunity persistence feature flags are strict and default off', () => {
  assert.deepEqual(opportunityFeatureFlags({}), {
    opportunityDraftsEnabled: false,
    detectors: { back_in_stock: false, reorder: false, winback: false }
  });
  assert.deepEqual(opportunityFeatureFlags({
    CAMPAIGN_OPPORTUNITY_DRAFTS_ENABLED: 'true',
    CAMPAIGN_REORDER_DETECTOR_ENABLED: 'TRUE'
  }), {
    opportunityDraftsEnabled: true,
    detectors: { back_in_stock: false, reorder: false, winback: false }
  });
});

test('documented opportunity detector feature flags remain off by default', () => {
  const envExample = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  for (const name of [
    'CAMPAIGN_OPPORTUNITY_DRAFTS_ENABLED',
    'CAMPAIGN_BACK_IN_STOCK_DETECTOR_ENABLED',
    'CAMPAIGN_REORDER_DETECTOR_ENABLED',
    'CAMPAIGN_WINBACK_DETECTOR_ENABLED',
    'CAMPAIGN_REVIEW_NOTIFICATIONS_ENABLED'
  ]) {
    assert.match(envExample, new RegExp(`^${name}=false$`, 'm'));
  }
});

function available(overrides = {}) {
  return {
    productID: 42,
    variationID: 7,
    stockStatus: 'instock',
    manageStock: true,
    stockQuantity: 10,
    purchasable: true,
    publicationStatus: 'publish',
    ...overrides
  };
}

function unavailable(overrides = {}) {
  return available({ stockStatus: 'outofstock', stockQuantity: 0, purchasable: false, ...overrides });
}

function restockCandidate(overrides = {}) {
  return {
    id: 'restock-1',
    phone: PHONE,
    contactID: 9,
    customerID: 99,
    deliveryID: 'woo-delivery-1',
    previous: unavailable(),
    observed: available(),
    observedAt: '2026-08-22T11:50:00.000Z',
    webhookTrusted: true,
    previousSnapshotTrusted: true,
    requestedProduct: true,
    productName: 'Product Alpha',
    ...overrides
  };
}

function reorderCandidate(overrides = {}) {
  return {
    id: 'reorder-1',
    phone: PHONE,
    contactID: 9,
    productID: 42,
    variationID: 7,
    productName: 'Product Alpha',
    productAvailable: true,
    purchases: [
      '2026-04-01T00:00:00Z',
      '2026-05-01T00:00:00Z',
      '2026-05-31T00:00:00Z',
      '2026-06-30T00:00:00Z'
    ],
    ...overrides
  };
}

function winbackCandidate(overrides = {}) {
  return {
    id: 'winback-1',
    phone: PHONE,
    contactID: 9,
    productID: 42,
    productName: 'Product Alpha',
    productAvailable: true,
    cadence: { reliable: true, confidence: 'high', medianDays: 30 },
    lastPurchaseAt: '2026-04-01T00:00:00Z',
    lifetimePurchaseCount: 5,
    ...overrides
  };
}

function trustedRefetch(snapshot = available(), recheckedAt = NOW) {
  return async () => ({ snapshot, trusted: true, recheckedAt });
}

test('restock requires the minimum debounce and does not refetch early', async () => {
  let refetches = 0;
  const run = await prepareOpportunityDraftRun({
    now: NOW,
    restockDebounceSeconds: 1,
    backInStockCandidates: [restockCandidate({ observedAt: '2026-08-22T11:59:00.000Z' })]
  }, {
    authoritativeProductRefetch: async () => { refetches += 1; return { snapshot: available(), trusted: true, recheckedAt: NOW }; }
  });
  assert.equal(MINIMUM_RESTOCK_DEBOUNCE_SECONDS, 300);
  assert.equal(refetches, 0);
  assert.equal(run.opportunities.length, 0);
  assert.deepEqual(run.suppressed[0].reasons, ['debounce_not_elapsed']);
});

test('restock fails closed without a trusted authoritative refetch or exact transition', async () => {
  const missing = await prepareOpportunityDraftRun({
    now: NOW,
    backInStockCandidates: [restockCandidate()]
  });
  assert.ok(missing.suppressed[0].reasons.includes('authoritative_refetch_unavailable'));

  const untrusted = await prepareOpportunityDraftRun({
    now: NOW,
    backInStockCandidates: [restockCandidate()]
  }, { authoritativeProductRefetch: async () => ({ snapshot: available(), trusted: false, recheckedAt: NOW }) });
  assert.ok(untrusted.suppressed[0].reasons.includes('authoritative_refetch_untrusted'));

  const ordinaryEdit = await prepareOpportunityDraftRun({
    now: NOW,
    backInStockCandidates: [restockCandidate({ previous: available({ stockQuantity: 4 }) })]
  }, { authoritativeProductRefetch: trustedRefetch() });
  assert.ok(ordinaryEdit.suppressed[0].reasons.includes('previous_state_not_definitely_unavailable'));
});

test('trusted unavailable-to-available restock prepares an open opportunity and draft only', async () => {
  const run = await prepareOpportunityDraftRun({
    now: NOW,
    workspaceID: 'vici',
    backInStockCandidates: [restockCandidate()]
  }, { authoritativeProductRefetch: trustedRefetch() });
  assert.equal(run.opportunities.length, 1);
  assert.equal(run.opportunities[0].opportunityType, 'back_in_stock_requested');
  assert.equal(run.opportunities[0].status, 'open');
  assert.equal(run.drafts.length, 1);
  assert.equal(run.drafts[0].status, 'draft');
  assert.equal(run.drafts[0].audienceDefinition.frozen, false);
  assert.equal(run.drafts[0].recipients[0].inclusionReason.productID, '42');
  assert.equal(run.drafts[0].recipients[0].inclusionReason.variationID, '7');
  assert.equal(run.drafts[0].recipients[0].inclusionReason.wooCustomerID, 99);
  assert.match(run.drafts[0].proposedMessage, /STOP to opt out/);
  assert.deepEqual(run.safety, {
    providerCalled: false,
    notificationDispatched: false,
    databaseWritten: false,
    maximumPreparedCampaignStatus: 'draft'
  });
});

test('reorder and win-back are deterministic, deduped and cooldown-aware', async () => {
  const first = await prepareOpportunityDraftRun({ now: NOW, reorderCandidates: [reorderCandidate()] });
  const second = await prepareOpportunityDraftRun({ now: NOW, reorderCandidates: [reorderCandidate()] });
  assert.equal(first.opportunities[0].dedupeKey, second.opportunities[0].dedupeKey);

  const duplicate = await prepareOpportunityDraftRun({
    now: NOW,
    reorderCandidates: [reorderCandidate(), reorderCandidate({ id: 'retry' })]
  });
  assert.equal(duplicate.opportunities.length, 1);
  assert.ok(duplicate.suppressed.some(row => row.reasons.includes('duplicate_candidate_in_run')));

  const existing = await prepareOpportunityDraftRun({
    now: NOW,
    existingDedupeKeys: [first.opportunities[0].dedupeKey],
    reorderCandidates: [reorderCandidate()]
  });
  assert.equal(existing.opportunities.length, 0);
  assert.ok(existing.suppressed[0].reasons.includes('opportunity_dedupe_key_exists'));

  const cooldown = await prepareOpportunityDraftRun({
    now: NOW,
    winbackCandidates: [winbackCandidate({ lastWinbackRejectedAt: '2026-08-01T00:00:00Z' })]
  });
  assert.equal(cooldown.opportunities.length, 0);
  assert.ok(cooldown.suppressed[0].reasons.includes('winback_cooldown_active'));
});

test('collision resolution chooses restock over reorder and active payment recovery chooses neither', async () => {
  const input = {
    now: NOW,
    backInStockCandidates: [restockCandidate()],
    reorderCandidates: [reorderCandidate()],
    winbackCandidates: [winbackCandidate()]
  };
  const run = await prepareOpportunityDraftRun(input, { authoritativeProductRefetch: trustedRefetch() });
  assert.equal(run.opportunities.length, 1);
  assert.equal(run.opportunities[0].opportunityType, 'back_in_stock_requested');
  assert.equal(run.collisionSuppressions.length, 2);
  assert.ok(run.collisionSuppressions.every(row => row.reason === 'lower_priority_collision'));

  const blocked = await prepareOpportunityDraftRun({
    ...input,
    activePaymentRecoveryPhones: [PHONE]
  }, { authoritativeProductRefetch: trustedRefetch() });
  assert.equal(blocked.opportunities.length, 0);
  assert.equal(blocked.collisionSuppressions.length, 3);
  assert.ok(blocked.collisionSuppressions.every(row => row.reason === 'active_payment_recovery'));
});

test('malformed and unavailable product records fail closed instead of preparing drafts', async () => {
  const run = await prepareOpportunityDraftRun({
    now: NOW,
    backInStockCandidates: [restockCandidate({ observedAt: 'not-a-time' })],
    reorderCandidates: [reorderCandidate({ productAvailable: false })],
    winbackCandidates: [winbackCandidate({ productAvailable: false })]
  }, { authoritativeProductRefetch: trustedRefetch() });
  assert.equal(run.drafts.length, 0);
  const reasons = run.suppressed.flatMap(row => row.reasons);
  assert.ok(reasons.includes('stability_timestamp_missing'));
  assert.ok(reasons.includes('product_unavailable'));
});

test('campaign-ready notifications require active Owner/Admin and effective approval authority', () => {
  const drafts = [{ id: 'campaign-42', status: 'draft', workflowCategory: 'reorder' }];
  const notifications = prepareCampaignReadyNotifications({
    generatedAt: NOW,
    drafts,
    users: [
      { id: 1, role: 'owner', isActive: true, canApproveCampaigns: true },
      { id: 2, role: 'admin', isActive: true, canApproveCampaigns: true },
      { id: 3, role: 'admin', isActive: true, canApproveCampaigns: false },
      { id: 4, role: 'legacy', isActive: true, canApproveCampaigns: true },
      { id: 5, role: 'owner', isActive: false, canApproveCampaigns: true }
    ]
  });
  assert.deepEqual(notifications.map(row => row.userID), ['1', '2']);
  assert.ok(notifications.every(row => row.channel === 'native_push_preparation'));
  assert.ok(notifications.every(row => row.payload.campaignID === 'campaign-42'));
  assert.ok(notifications.every(row => row.payload.destination === 'review'));
  assert.ok(notifications.every(row => !JSON.stringify(row).includes(PHONE)));
});

test('coalesced campaign-ready notification does not deep-link to the wrong campaign', () => {
  const notifications = prepareCampaignReadyNotifications({
    generatedAt: NOW,
    drafts: [
      { id: 'campaign-1', status: 'draft', workflowCategory: 'reorder' },
      { id: 'campaign-2', status: 'review_required', workflowCategory: 'winback' }
    ],
    users: [{ id: 1, role: 'owner', isActive: true, canApproveCampaigns: true }]
  });
  assert.equal(notifications[0].collapseID, 'vici-campaigns-ready-for-review');
  assert.equal(notifications[0].payload.reviewCount, 2);
  assert.equal(notifications[0].payload.campaignID, undefined);
});

test('persistence boundary permits only draft/review_required and requires one atomic adapter', async () => {
  const run = await prepareOpportunityDraftRun({ now: NOW, reorderCandidates: [reorderCandidate()] });
  let calls = 0;
  const adapter = {
    async persistOpportunityDraftBundle(bundle) {
      calls += 1;
      assert.ok(bundle.drafts.every(draft => draft.status === 'review_required'));
      return { persisted: bundle.drafts.length };
    }
  };
  assert.deepEqual(await persistPreparedDraftRun(run, adapter, {
    destinationStatus: 'review_required',
    featureFlags: { opportunityDraftsEnabled: true, detectors: { reorder: true } }
  }), { persisted: 1 });
  await assert.rejects(
    persistPreparedDraftRun(run, adapter),
    /persistence is disabled/
  );
  await assert.rejects(
    persistPreparedDraftRun(run, adapter, {
      featureFlags: { opportunityDraftsEnabled: true, detectors: { reorder: false } }
    }),
    /reorder detector draft persistence is disabled/
  );
  await assert.rejects(
    persistPreparedDraftRun(run, adapter, {
      destinationStatus: 'scheduled',
      featureFlags: { opportunityDraftsEnabled: true, detectors: { reorder: true } }
    }),
    /only draft or review_required/
  );
  assert.equal(calls, 1);
});

test('starter copy is bounded, opt-out-bearing and dry-run summary contains no recipient identity', async () => {
  const copy = prepareDraftCopy({ opportunityType: 'reorder_personal_high', productName: 'Alpha\nProduct' });
  assert.doesNotMatch(copy.proposedMessage, /\n/);
  assert.match(copy.proposedMessage, /STOP to opt out/);
  assert.equal(copy.copyStatus, 'human_review_required');

  const run = await prepareOpportunityDraftRun({ now: NOW, reorderCandidates: [reorderCandidate()] });
  const report = summary(run);
  assert.equal(report.mode, 'draft_only_no_dispatch');
  assert.equal(report.opportunitiesPrepared, 1);
  assert.doesNotMatch(JSON.stringify(report), /13055550123|Product Alpha/);
});
