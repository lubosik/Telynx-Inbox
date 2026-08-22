'use strict';

const crypto = require('crypto');
const { normalisePhone } = require('../phone');
const { qualifyBackInStockTransition, inventoryIdentity } = require('./back-in-stock');
const { calculateReorderCadence } = require('./reorder-cadence');
const { qualifyWinback } = require('./winback');
const { resolveOpportunityCollision } = require('./opportunity-policy');
const { prepareDraftCopy } = require('./draft-copy');
const { prepareCampaignReadyNotifications } = require('./campaign-ready-notifications');

const RULE_VERSION = 'opportunity-orchestration-v1';
const MINIMUM_RESTOCK_DEBOUNCE_SECONDS = 300;

function validDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be a valid date.`);
  return date;
}

function cleanID(value) {
  const out = String(value ?? '').trim();
  return out || null;
}

function positiveContactID(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function phoneFor(value) {
  if (value === null || value === undefined) return null;
  return normalisePhone(String(value));
}

function stableKey(parts) {
  return `opp:v1:${crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}

function opportunityFeatureFlags(env = process.env) {
  return {
    opportunityDraftsEnabled: env.CAMPAIGN_OPPORTUNITY_DRAFTS_ENABLED === 'true',
    detectors: {
      back_in_stock: env.CAMPAIGN_BACK_IN_STOCK_DETECTOR_ENABLED === 'true',
      reorder: env.CAMPAIGN_REORDER_DETECTOR_ENABLED === 'true',
      winback: env.CAMPAIGN_WINBACK_DETECTOR_ENABLED === 'true'
    }
  };
}

function candidateIdentity(candidate) {
  const explicit = inventoryIdentity({
    productID: candidate?.productID ?? candidate?.product_id,
    variationID: candidate?.variationID ?? candidate?.variation_id
  });
  if (explicit.productID) return explicit;
  return inventoryIdentity(candidate?.authoritative || candidate?.observed || candidate?.previous || {});
}

function productGroupKey(opportunity) {
  const productID = opportunity.structuredContext.productID || 'unknown';
  const variationID = opportunity.structuredContext.variationID || 'parent';
  return opportunity.opportunityType === 'winback'
    ? 'winback:general'
    : `${opportunity.opportunityType}:${productID}:${variationID}`;
}

function opportunityRecord({
  workspaceID,
  type,
  sourceType,
  sourceID,
  dedupeKey,
  phone,
  contactID,
  customerID,
  detectedAt,
  expiresAt,
  productID,
  variationID,
  productName,
  explanation,
  evidence,
  scores = {}
}) {
  return {
    id: `prepared:${dedupeKey}`,
    workspaceID,
    opportunityType: type,
    sourceType,
    sourceID: sourceID || null,
    dedupeKey,
    status: 'open',
    contactPhone: phone,
    contactID: positiveContactID(contactID),
    detectedAt,
    expiresAt,
    explanation,
    intentScore: Number(scores.intentScore || 0),
    relevanceScore: Number(scores.relevanceScore || 0),
    cadenceConfidence: Number(scores.cadenceConfidence || 0),
    structuredContext: {
      ruleVersion: RULE_VERSION,
      contactPhone: phone,
      contactID: positiveContactID(contactID),
      wooCustomerID: positiveContactID(customerID),
      productID: productID || null,
      variationID: variationID || null,
      productName: productName || null,
      evidence
    }
  };
}

function suppress(input, reasons, stage) {
  return {
    candidateRef: cleanID(input?.id || input?.sourceID || input?.deliveryID) || 'unidentified',
    contactPhone: phoneFor(input?.phone || input?.contactPhone),
    stage,
    reasons: [...new Set(reasons)]
  };
}

async function detectRestocks(candidates, context) {
  const found = [];
  const suppressed = [];
  const debounceSeconds = Math.max(
    MINIMUM_RESTOCK_DEBOUNCE_SECONDS,
    Number(context.restockDebounceSeconds) || MINIMUM_RESTOCK_DEBOUNCE_SECONDS
  );

  for (const candidate of candidates || []) {
    const phone = phoneFor(candidate.phone || candidate.contactPhone);
    if (!phone) {
      suppressed.push(suppress(candidate, ['contact_phone_invalid'], 'back_in_stock'));
      continue;
    }
    let observedAt;
    try {
      observedAt = validDate(candidate.observedAt, 'observedAt');
    } catch {
      suppressed.push(suppress(candidate, ['stability_timestamp_missing'], 'back_in_stock'));
      continue;
    }
    if (context.now.getTime() < observedAt.getTime() + debounceSeconds * 1000) {
      suppressed.push(suppress(candidate, ['debounce_not_elapsed'], 'back_in_stock'));
      continue;
    }
    if (typeof context.authoritativeProductRefetch !== 'function') {
      suppressed.push(suppress(candidate, ['authoritative_refetch_unavailable'], 'back_in_stock'));
      continue;
    }

    let refetch;
    try {
      refetch = await context.authoritativeProductRefetch({
        workspaceID: context.workspaceID,
        ...candidateIdentity(candidate)
      });
    } catch {
      suppressed.push(suppress(candidate, ['authoritative_refetch_failed'], 'back_in_stock'));
      continue;
    }
    let recheckedAt;
    try {
      recheckedAt = validDate(refetch?.recheckedAt || context.now, 'authoritative recheckedAt');
    } catch {
      suppressed.push(suppress(candidate, ['stability_timestamp_missing'], 'back_in_stock'));
      continue;
    }
    const result = qualifyBackInStockTransition({
      previous: candidate.previous,
      observed: candidate.observed,
      authoritative: refetch?.snapshot,
      webhookTrusted: candidate.webhookTrusted === true,
      previousSnapshotTrusted: candidate.previousSnapshotTrusted === true,
      authoritativeRefetchTrusted: refetch?.trusted === true,
      deliveryID: candidate.deliveryID,
      deliveryAlreadyProcessed: candidate.deliveryAlreadyProcessed === true,
      existingOpenOpportunity: candidate.existingOpenOpportunity === true,
      observedAt: observedAt.toISOString(),
      recheckedAt: recheckedAt.toISOString(),
      debounceSeconds
    });
    if (!result.qualifies) {
      suppressed.push(suppress(candidate, result.reasons, 'back_in_stock'));
      continue;
    }
    const requested = candidate.requestedProduct === true;
    const repeatBuyer = candidate.repeatBuyer === true;
    const type = requested ? 'back_in_stock_requested' : repeatBuyer ? 'back_in_stock_repeat_buyer' : 'back_in_stock';
    const dedupeKey = stableKey([context.workspaceID, type, phone, result.transitionKey]);
    if (context.existingDedupeKeys.has(dedupeKey)) {
      suppressed.push(suppress(candidate, ['opportunity_dedupe_key_exists'], 'back_in_stock'));
      continue;
    }
    found.push(opportunityRecord({
      workspaceID: context.workspaceID,
      type,
      sourceType: 'woocommerce_product_restock',
      sourceID: cleanID(candidate.deliveryID),
      dedupeKey,
      phone,
      contactID: candidate.contactID,
      customerID: candidate.customerID ?? candidate.customer_id,
      detectedAt: recheckedAt.toISOString(),
      expiresAt: new Date(recheckedAt.getTime() + 7 * 86400000).toISOString(),
      productID: result.productID,
      variationID: result.variationID,
      productName: candidate.productName,
      explanation: 'Exact product changed from unavailable to available and remained available after an authoritative post-debounce WooCommerce refetch.',
      evidence: {
        deliveryID: String(candidate.deliveryID),
        transitionKey: result.transitionKey,
        observedAt: observedAt.toISOString(),
        recheckedAt: recheckedAt.toISOString(),
        debounceSeconds,
        webhookTrusted: true,
        previousSnapshotTrusted: true,
        authoritativeRefetchTrusted: true
      },
      scores: {
        intentScore: requested ? 1 : 0,
        relevanceScore: requested || repeatBuyer ? 1 : 0.75
      }
    }));
  }
  return { found, suppressed };
}

function detectReorders(candidates, context) {
  const found = [];
  const suppressed = [];
  for (const candidate of candidates || []) {
    const phone = phoneFor(candidate.phone || candidate.contactPhone);
    if (!phone) {
      suppressed.push(suppress(candidate, ['contact_phone_invalid'], 'reorder'));
      continue;
    }
    const cadence = calculateReorderCadence({
      purchases: candidate.purchases,
      productCadence: candidate.productCadence,
      now: context.now,
      productAvailable: candidate.productAvailable === true,
      alreadyContactedForLastPurchase: candidate.alreadyContactedForLastPurchase === true,
      personalPolicy: candidate.personalPolicy,
      productPolicy: candidate.productPolicy
    });
    if (!cadence.eligible) {
      suppressed.push(suppress(candidate, [cadence.reason], 'reorder'));
      continue;
    }
    const identity = candidateIdentity(candidate);
    if (!identity.productID) {
      suppressed.push(suppress(candidate, ['exact_product_identity_required'], 'reorder'));
      continue;
    }
    const type = cadence.source === 'personal' && cadence.cadence.confidence === 'high'
      ? 'reorder_personal_high'
      : 'reorder_personal';
    const dedupeKey = stableKey([context.workspaceID, type, phone, identity.productID, identity.variationID, cadence.cycleKey]);
    if (context.existingDedupeKeys.has(dedupeKey)) {
      suppressed.push(suppress(candidate, ['opportunity_dedupe_key_exists'], 'reorder'));
      continue;
    }
    found.push(opportunityRecord({
      workspaceID: context.workspaceID,
      type,
      sourceType: 'woocommerce_order_cadence',
      sourceID: cleanID(candidate.sourceID),
      dedupeKey,
      phone,
      contactID: candidate.contactID,
      customerID: candidate.customerID ?? candidate.customer_id,
      detectedAt: context.now.toISOString(),
      // The expected range explains when the reorder became due; it is not the
      // lifetime of a newly detected opportunity. Give the first persisted
      // cycle a bounded 21-day review window, while its stable cycle key stops
      // daily detector runs from manufacturing a fresh opportunity.
      expiresAt: new Date(context.now.getTime() + 21 * 86400000).toISOString(),
      productID: identity.productID,
      variationID: identity.variationID,
      productName: candidate.productName,
      explanation: 'A deterministic purchase cadence reached its reorder window for this exact product.',
      evidence: {
        cadenceSource: cadence.source,
        cadenceConfidence: cadence.cadence.confidence,
        purchaseCount: cadence.purchaseCount,
        intervalCount: cadence.cadence.intervalCount,
        medianDays: cadence.cadence.medianDays,
        lastPurchaseAt: cadence.lastPurchaseAt,
        expectedAt: cadence.expectedAt,
        expectedRange: cadence.expectedRange,
        cycleKey: cadence.cycleKey
      },
      scores: { cadenceConfidence: cadence.cadence.confidence === 'high' ? 1 : 0.75 }
    }));
  }
  return { found, suppressed };
}

function detectWinbacks(candidates, context) {
  const found = [];
  const suppressed = [];
  for (const candidate of candidates || []) {
    const phone = phoneFor(candidate.phone || candidate.contactPhone);
    if (!phone) {
      suppressed.push(suppress(candidate, ['contact_phone_invalid'], 'winback'));
      continue;
    }
    const result = qualifyWinback({ ...candidate, now: context.now });
    if (!result.qualifies) {
      suppressed.push(suppress(candidate, result.reasons, 'winback'));
      continue;
    }
    const identity = candidateIdentity(candidate);
    const lastPurchaseAt = validDate(candidate.lastPurchaseAt, 'lastPurchaseAt').toISOString();
    const dedupeKey = stableKey([
      context.workspaceID,
      'winback',
      phone,
      identity.productID,
      identity.variationID,
      lastPurchaseAt,
      result.eligibleAt
    ]);
    if (context.existingDedupeKeys.has(dedupeKey)) {
      suppressed.push(suppress(candidate, ['opportunity_dedupe_key_exists'], 'winback'));
      continue;
    }
    found.push(opportunityRecord({
      workspaceID: context.workspaceID,
      type: 'winback',
      sourceType: 'woocommerce_customer_cadence',
      sourceID: cleanID(candidate.sourceID),
      dedupeKey,
      phone,
      contactID: candidate.contactID,
      customerID: candidate.customerID ?? candidate.customer_id,
      detectedAt: context.now.toISOString(),
      expiresAt: result.expiresAt,
      productID: identity.productID,
      variationID: identity.variationID,
      productName: candidate.productName,
      explanation: 'A repeat customer is lapsed beyond their supported purchase cadence and passed the customer-experience and cooldown gates.',
      evidence: {
        cadenceConfidence: candidate.cadence.confidence,
        medianDays: candidate.cadence.medianDays,
        lifetimePurchaseCount: Number(candidate.lifetimePurchaseCount),
        lastPurchaseAt,
        eligibleAt: result.eligibleAt,
        cooldownEndsAt: result.cooldownEndsAt
      },
      scores: { cadenceConfidence: candidate.cadence.confidence === 'high' ? 1 : 0.75 }
    }));
  }
  return { found, suppressed };
}

function prepareDrafts(opportunities, { workspaceID, brandName }) {
  const groups = new Map();
  for (const opportunity of opportunities) {
    const key = productGroupKey(opportunity);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(opportunity);
  }

  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([groupKey, rows]) => {
    const type = rows[0].opportunityType;
    const productName = rows[0].structuredContext.productName;
    const copy = prepareDraftCopy({ opportunityType: type, productName, brandName });
    return {
      preparationID: stableKey([workspaceID, 'draft', groupKey, rows.map(row => row.dedupeKey).sort()]),
      workspaceID,
      status: 'draft',
      campaignType: type,
      workflowCategory: type.startsWith('back_in_stock') ? 'back_in_stock' : type.startsWith('reorder') ? 'reorder' : 'winback',
      title: copy.title,
      proposedMessage: copy.proposedMessage,
      copyStatus: copy.copyStatus,
      reviewRequirements: copy.reviewRequirements,
      audienceDefinition: {
        source: 'deterministic_opportunity_orchestration',
        ruleVersion: RULE_VERSION,
        groupKey,
        opportunityDedupeKeys: rows.map(row => row.dedupeKey).sort(),
        frozen: false,
        requiresCurrentEligibilityAtApprovalAndSend: true
      },
      recipients: rows.map(row => ({
        contactID: row.contactID,
        contactPhone: row.contactPhone,
        inclusionReason: {
          opportunityDedupeKey: row.dedupeKey,
          opportunityType: row.opportunityType,
          ruleVersion: RULE_VERSION,
          // Exact commerce identity is frozen with the approved recipient.
          // Attribution must never reconstruct it later from a mutable name or SKU.
          productID: row.structuredContext.productID,
          variationID: row.structuredContext.variationID,
          wooCustomerID: row.structuredContext.wooCustomerID,
          evidence: row.structuredContext.evidence
        }
      })).sort((a, b) => a.contactPhone.localeCompare(b.contactPhone))
    };
  });
}

/**
 * Detect opportunities and prepare draft bundles. This function never imports
 * a database, APNs, Telnyx, the campaign service, or a queue. Persistence and
 * notification delivery are explicit later boundaries.
 */
async function prepareOpportunityDraftRun(input = {}, dependencies = {}) {
  const now = validDate(input.now || new Date(), 'now');
  const workspaceID = cleanID(input.workspaceID) || 'vici';
  const existingDedupeKeys = new Set((input.existingDedupeKeys || []).map(String));
  const activePaymentRecoveryPhones = new Set(
    (input.activePaymentRecoveryPhones || []).map(phoneFor).filter(Boolean)
  );
  const context = {
    now,
    workspaceID,
    existingDedupeKeys,
    authoritativeProductRefetch: dependencies.authoritativeProductRefetch,
    restockDebounceSeconds: input.restockDebounceSeconds
  };

  const [restocks, reorders, winbacks] = await Promise.all([
    detectRestocks(input.backInStockCandidates, context),
    Promise.resolve(detectReorders(input.reorderCandidates, context)),
    Promise.resolve(detectWinbacks(input.winbackCandidates, context))
  ]);
  const rawCandidates = [...restocks.found, ...reorders.found, ...winbacks.found];
  const candidatesByDedupeKey = new Map();
  const duplicateSuppressions = [];
  for (const candidate of rawCandidates) {
    if (candidatesByDedupeKey.has(candidate.dedupeKey)) {
      duplicateSuppressions.push(suppress(candidate, ['duplicate_candidate_in_run'], 'deduplication'));
      continue;
    }
    candidatesByDedupeKey.set(candidate.dedupeKey, candidate);
  }
  const candidates = [...candidatesByDedupeKey.values()];
  const byPhone = new Map();
  for (const opportunity of candidates) {
    if (!byPhone.has(opportunity.contactPhone)) byPhone.set(opportunity.contactPhone, []);
    byPhone.get(opportunity.contactPhone).push(opportunity);
  }

  const selected = [];
  const closed = [];
  const collisionSuppressions = [];
  for (const phone of [...byPhone.keys()].sort()) {
    const rows = byPhone.get(phone);
    const contextsByID = Object.fromEntries(rows.map(row => [row.id, { productAvailable: true }]));
    const collision = resolveOpportunityCollision(rows.map(row => ({
      ...row,
      type: row.opportunityType,
      createdAt: row.detectedAt
    })), {
      now,
      contextsByID,
      activePaymentRecovery: activePaymentRecoveryPhones.has(phone)
    });
    if (collision.selected) selected.push(collision.selected);
    closed.push(...collision.closed);
    collisionSuppressions.push(...collision.suppressed);
  }

  const drafts = prepareDrafts(selected, { workspaceID, brandName: input.brandName || 'Vici' });
  const notifications = prepareCampaignReadyNotifications({
    users: input.notificationUsers,
    drafts,
    generatedAt: now
  });
  return {
    mode: 'draft_only_no_dispatch',
    ruleVersion: RULE_VERSION,
    generatedAt: now.toISOString(),
    workspaceID,
    opportunities: selected,
    drafts,
    notifications,
    suppressed: [
      ...restocks.suppressed,
      ...reorders.suppressed,
      ...winbacks.suppressed,
      ...duplicateSuppressions
    ],
    collisionSuppressions,
    closed,
    safety: {
      providerCalled: false,
      notificationDispatched: false,
      databaseWritten: false,
      maximumPreparedCampaignStatus: 'draft'
    }
  };
}

/**
 * Optional future persistence boundary. The caller must provide one atomic
 * adapter that records opportunities and drafts together. No campaign service
 * or production database is imported here, and statuses above review_required
 * are rejected before the adapter is invoked.
 */
async function persistPreparedDraftRun(run, adapter, {
  destinationStatus = 'draft',
  featureFlags = opportunityFeatureFlags()
} = {}) {
  if (!['draft', 'review_required'].includes(destinationStatus)) {
    throw new Error('Draft orchestration may persist only draft or review_required campaigns.');
  }
  if (featureFlags.opportunityDraftsEnabled !== true) {
    throw new Error('Opportunity draft persistence is disabled.');
  }
  const requiredDetectors = new Set((run?.drafts || []).map(draft => draft.workflowCategory));
  const detectorFlags = featureFlags.detectors || {};
  for (const workflow of requiredDetectors) {
    if (detectorFlags[workflow] !== true) {
      throw new Error(`${workflow} detector draft persistence is disabled.`);
    }
  }
  if (typeof adapter?.persistOpportunityDraftBundle !== 'function') {
    throw new Error('An atomic persistOpportunityDraftBundle adapter is required.');
  }
  if (run?.mode !== 'draft_only_no_dispatch') throw new Error('Only a validated draft-only run can be persisted.');
  const bundle = {
    workspaceID: run.workspaceID,
    ruleVersion: run.ruleVersion,
    generatedAt: run.generatedAt,
    opportunities: run.opportunities,
    drafts: run.drafts.map(draft => ({ ...draft, status: destinationStatus })),
    closed: run.closed || [],
    collisionSuppressions: run.collisionSuppressions || [],
    notifications: run.notifications || []
  };
  return adapter.persistOpportunityDraftBundle(bundle);
}

module.exports = {
  MINIMUM_RESTOCK_DEBOUNCE_SECONDS,
  RULE_VERSION,
  opportunityFeatureFlags,
  persistPreparedDraftRun,
  prepareOpportunityDraftRun,
  stableKey
};
