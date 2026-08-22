'use strict';

const { normalisePhone } = require('../phone');

const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * HOUR_SECONDS;

const METHODOLOGY_VERSION = 'vici-campaign-revenue-v1';

const CONFIDENCE = Object.freeze({
  direct: 1,
  strong: 0.9,
  influenced: 0.6,
  unattributed: 0
});

// Product defaults, not statements of law or universal marketing truth. They
// must ultimately be loaded from central tenant configuration. A caller can
// replace a workflow's complete window, but malformed overrides fail closed.
const DEFAULT_WINDOWS_BY_WORKFLOW = Object.freeze({
  back_in_stock: Object.freeze({ strongSeconds: 3 * DAY_SECONDS, maximumSeconds: 7 * DAY_SECONDS }),
  back_in_stock_requested: Object.freeze({ strongSeconds: 3 * DAY_SECONDS, maximumSeconds: 7 * DAY_SECONDS }),
  back_in_stock_repeat_buyer: Object.freeze({ strongSeconds: 3 * DAY_SECONDS, maximumSeconds: 7 * DAY_SECONDS }),
  reorder: Object.freeze({ strongSeconds: 7 * DAY_SECONDS, maximumSeconds: 14 * DAY_SECONDS }),
  reorder_personal: Object.freeze({ strongSeconds: 7 * DAY_SECONDS, maximumSeconds: 14 * DAY_SECONDS }),
  reorder_personal_high: Object.freeze({ strongSeconds: 7 * DAY_SECONDS, maximumSeconds: 14 * DAY_SECONDS }),
  winback: Object.freeze({ strongSeconds: 3 * DAY_SECONDS, maximumSeconds: 14 * DAY_SECONDS }),
  manual_exact_product: Object.freeze({ strongSeconds: 3 * DAY_SECONDS, maximumSeconds: 7 * DAY_SECONDS }),
  manual: Object.freeze({ strongSeconds: 3 * DAY_SECONDS, maximumSeconds: 3 * DAY_SECONDS }),
  generic_promotion: Object.freeze({ strongSeconds: 3 * DAY_SECONDS, maximumSeconds: 3 * DAY_SECONDS })
});

const PRODUCT_SPECIFIC_WORKFLOWS = new Set([
  'back_in_stock',
  'back_in_stock_requested',
  'back_in_stock_repeat_buyer',
  'reorder',
  'reorder_personal',
  'reorder_personal_high',
  'manual_exact_product'
]);

const FINAL_CANCELLED_STATUSES = new Set(['cancelled', 'failed', 'refunded', 'trash']);

function asTime(value) {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function normaliseID(value) {
  if (value === null || value === undefined || value === '' || String(value) === '0') return null;
  return String(value);
}

function moneyToCents(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : 0;
}

function centsToMoney(value) {
  return Math.round(value) / 100;
}

function orderIdentity(order = {}) {
  return {
    customerID: normaliseID(order.customerID ?? order.customer_id),
    phone: normalisePhone(order.phone ?? order.contactPhone ?? order.contact_phone ?? order.billing?.phone ?? order.shipping?.phone)
  };
}

function recipientIdentity(touch = {}) {
  return {
    customerID: normaliseID(touch.customerID ?? touch.customer_id ?? touch.recipientCustomerID),
    phone: normalisePhone(touch.phone ?? touch.contactPhone ?? touch.contact_phone ?? touch.recipientPhone)
  };
}

/**
 * Match a recipient to an order without ever joining guest customer ID zero.
 * Conflicting non-zero customer IDs are disqualifying even when phones match.
 */
function matchRecipientToOrder(order, touch) {
  const authoritative = orderIdentity(order);
  const recipient = recipientIdentity(touch);
  if (authoritative.customerID && recipient.customerID) {
    if (authoritative.customerID !== recipient.customerID) {
      return { matched: false, method: null, reason: 'customer_id_conflict' };
    }
    return { matched: true, method: 'customer_id', reason: null };
  }
  if (authoritative.phone && recipient.phone && authoritative.phone === recipient.phone) {
    return { matched: true, method: 'phone', reason: null };
  }
  return { matched: false, method: null, reason: 'recipient_identity_not_exact' };
}

function productIdentity(value = {}) {
  const variationID = normaliseID(value.variationID ?? value.variation_id);
  const productID = normaliseID(value.productID ?? value.product_id ?? value.parentID ?? value.parent_id);
  return { productID, variationID };
}

/**
 * Product IDs are authoritative. SKU/name similarity is never silently
 * upgraded to an exact match. A variation target requires the same variation;
 * a parent-product target may match any of its variations.
 */
function matchTargetProducts(targetProducts = [], lineItems = []) {
  const targets = (targetProducts || []).map(productIdentity);
  const lines = (lineItems || []).map(productIdentity);
  if (!targets.length) return { required: false, matched: false, matches: [], reason: null };
  if (targets.some(target => !target.productID)) {
    return { required: true, matched: false, matches: [], reason: 'target_product_id_missing' };
  }
  const matches = [];
  for (const target of targets) {
    const line = lines.find(item => item.productID === target.productID &&
      (!target.variationID || item.variationID === target.variationID));
    if (line) matches.push({ ...target });
  }
  return {
    required: true,
    matched: matches.length > 0,
    matches,
    reason: matches.length ? null : 'target_product_not_in_order'
  };
}

function resolveWindow(workflow, windowsByWorkflow = DEFAULT_WINDOWS_BY_WORKFLOW) {
  const selected = windowsByWorkflow?.[workflow] || windowsByWorkflow?.default || null;
  const strongSeconds = Number(selected?.strongSeconds);
  const maximumSeconds = Number(selected?.maximumSeconds);
  if (!Number.isInteger(strongSeconds) || strongSeconds <= 0 ||
      !Number.isInteger(maximumSeconds) || maximumSeconds < strongSeconds) return null;
  return { strongSeconds, maximumSeconds };
}

function campaignReferenceMatches(evidence, touch) {
  return String(evidence?.campaignID ?? evidence?.campaign_id ?? '') === String(touch?.campaignID ?? touch?.campaign_id ?? '') &&
    String(evidence?.recipientID ?? evidence?.recipient_id ?? '') === String(touch?.recipientID ?? touch?.recipient_id ?? '');
}

function isSequencedEvidence(event, deliveredTime, paidTime) {
  const occurred = asTime(event?.occurredAt ?? event?.occurred_at ?? event?.clickedAt ?? event?.clicked_at);
  return occurred !== null && occurred >= deliveredTime && occurred <= paidTime;
}

function verifiedDirectEvidence({ order, touch, deliveredTime, paidTime, productMatch, linkEvents, couponEvidence, inboundIntents }) {
  const orderID = String(order?.id ?? order?.orderID ?? order?.order_id ?? '');

  const link = (linkEvents || []).find(event =>
    event?.trusted === true && event?.recipientBound === true && event?.orderBound === true &&
    String(event?.orderID ?? event?.order_id ?? '') === orderID &&
    campaignReferenceMatches(event, touch) && isSequencedEvidence(event, deliveredTime, paidTime));
  if (link) return { code: 'verified_recipient_order_link', id: String(link.id || link.tokenID || '') || null };

  const orderCoupons = new Set((order?.couponCodes || order?.coupon_codes || order?.coupon_lines || [])
    .map(value => String(typeof value === 'string' ? value : value?.code || '').trim().toLowerCase())
    .filter(Boolean));
  const coupon = (couponEvidence || []).find(event => {
    const code = String(event?.code || '').trim().toLowerCase();
    const assignedTime = asTime(event?.assignedAt ?? event?.assigned_at);
    return code && orderCoupons.has(code) && event?.trusted === true && event?.recipientBound === true &&
      event?.singleUse === true && campaignReferenceMatches(event, touch) &&
      assignedTime !== null && assignedTime <= deliveredTime;
  });
  if (coupon) return { code: 'verified_unique_recipient_coupon', id: String(coupon.id || coupon.code || '') || null };

  const intent = (inboundIntents || []).find(event =>
    event?.trusted === true && event?.ruleBased === true && event?.intentCode === 'purchase_confirmed' &&
    campaignReferenceMatches(event, touch) && isSequencedEvidence(event, deliveredTime, paidTime) &&
    (!PRODUCT_SPECIFIC_WORKFLOWS.has(String(touch?.workflow || touch?.workflowCategory || '').toLowerCase()) || productMatch.matched));
  if (intent) return { code: 'trusted_rule_based_purchase_confirmation', id: String(intent.id || eventID(intent) || '') || null };

  return null;
}

function eventID(event) {
  return event?.eventID ?? event?.event_id ?? event?.messageID ?? event?.message_id ?? null;
}

function classificationBase({ order, touch, workflow }) {
  const orderID = String(order?.id ?? order?.orderID ?? order?.order_id ?? '');
  const grossCents = moneyToCents(order?.grossAmount ?? order?.gross_amount ?? order?.total);
  const refundedCents = Math.min(grossCents, moneyToCents(order?.refundedAmount ?? order?.refunded_amount));
  return {
    workspaceID: String(touch?.workspaceID ?? touch?.workspace_id ?? order?.workspaceID ?? order?.workspace_id ?? '') || null,
    orderID,
    customerID: orderIdentity(order).customerID,
    sourceType: 'campaign',
    category: workflow || null,
    workflow: workflow || null,
    campaignID: normaliseID(touch?.campaignID ?? touch?.campaign_id),
    recipientID: normaliseID(touch?.recipientID ?? touch?.recipient_id),
    actionID: normaliseID(touch?.providerMessageID ?? touch?.provider_message_id ?? touch?.actionID),
    actionAt: touch?.deliveredAt ?? touch?.delivered_at ?? null,
    conversionAt: order?.paidAt ?? order?.paid_at ?? order?.date_paid_gmt ?? order?.date_paid ?? null,
    grossAmount: centsToMoney(grossCents),
    refundedAmount: centsToMoney(refundedCents),
    netAmount: centsToMoney(Math.max(0, grossCents - refundedCents)),
    methodologyVersion: METHODOLOGY_VERSION
  };
}

function classifyCampaignOrder({
  order = {},
  touch = {},
  linkEvents = [],
  couponEvidence = [],
  inboundIntents = [],
  windowsByWorkflow = DEFAULT_WINDOWS_BY_WORKFLOW,
  internalOrTestIdentity = false,
  contradictoryEvidence = []
} = {}) {
  const workflow = String(touch.workflow ?? touch.workflowCategory ?? touch.campaignType ?? '').trim().toLowerCase();
  const base = classificationBase({ order, touch, workflow });
  const evidenceCodes = [];
  const unattributed = (reason, code) => ({
    ...base,
    confidenceLevel: 'unattributed',
    confidenceScore: CONFIDENCE.unattributed,
    attributionWindowSeconds: null,
    reason,
    supportingEvidence: { codes: code ? [...evidenceCodes, code] : evidenceCodes },
    invalidated: false
  });

  if (!base.orderID) return unattributed('Order identifier is missing.', 'order_id_missing');
  const orderWorkspace = String(order?.workspaceID ?? order?.workspace_id ?? '');
  const touchWorkspace = String(touch?.workspaceID ?? touch?.workspace_id ?? '');
  if (!orderWorkspace || !touchWorkspace) {
    return unattributed('Authoritative order and campaign workspace identifiers are required.', 'workspace_id_missing');
  }
  if (orderWorkspace !== touchWorkspace) {
    return unattributed('Campaign and order belong to different workspaces.', 'workspace_id_conflict');
  }
  if (internalOrTestIdentity) return {
    ...unattributed('Configured staff or test activity is excluded.', 'internal_or_test_identity'),
    excluded: true,
    exclusionReason: 'internal_or_test_identity'
  };
  if (FINAL_CANCELLED_STATUSES.has(String(order?.status || '').toLowerCase())) {
    return unattributed('The authoritative order is cancelled, failed, refunded, or otherwise non-revenue.', 'order_not_revenue');
  }
  const paidTime = asTime(base.conversionAt);
  if (paidTime === null) return unattributed('No authoritative payment timestamp is available.', 'payment_timestamp_missing');
  if (base.grossAmount <= 0 || base.netAmount <= 0) return unattributed('The authoritative order has no positive net revenue.', 'net_revenue_not_positive');
  if (!base.campaignID || !base.recipientID || !base.actionID) {
    return unattributed('Campaign, recipient, and provider message identifiers are required.', 'campaign_action_incomplete');
  }
  if (touch.deliveryTrusted !== true || String(touch.providerStatus || touch.provider_status || '').toLowerCase() !== 'delivered') {
    return unattributed('Provider acceptance or an untrusted status is not delivery evidence.', 'trusted_delivery_required');
  }
  const deliveredTime = asTime(base.actionAt);
  if (deliveredTime === null) return unattributed('A trusted delivery timestamp is required.', 'delivery_timestamp_missing');
  if (deliveredTime >= paidTime) return unattributed('The order was paid before the campaign was delivered.', 'conversion_not_after_delivery');
  evidenceCodes.push('trusted_provider_delivery');

  const identity = matchRecipientToOrder(order, touch);
  if (!identity.matched) return unattributed('The campaign recipient does not exactly match the authoritative order customer.', identity.reason);
  evidenceCodes.push(`exact_recipient_${identity.method}`);

  const window = resolveWindow(workflow, windowsByWorkflow);
  if (!window) return unattributed('No valid central attribution window exists for this campaign workflow.', 'attribution_window_invalid');
  const elapsedSeconds = Math.floor((paidTime - deliveredTime) / 1000);
  if (elapsedSeconds > window.maximumSeconds) {
    return unattributed('Payment occurred outside the configured campaign attribution window.', 'outside_attribution_window');
  }
  evidenceCodes.push('inside_attribution_window');

  const productMatch = matchTargetProducts(
    touch.targetProducts ?? touch.target_products ?? [],
    order.lineItems ?? order.line_items ?? []
  );
  if (PRODUCT_SPECIFIC_WORKFLOWS.has(workflow) && !productMatch.required) {
    return unattributed('This workflow requires a frozen exact-product target.', 'target_product_evidence_missing');
  }
  if (productMatch.required && !productMatch.matched) {
    return unattributed('The paid order does not contain the campaign target product or variation.', productMatch.reason);
  }
  if (productMatch.matched) evidenceCodes.push('exact_target_product');

  if ((contradictoryEvidence || []).length) {
    return unattributed('Contradictory or ambiguous evidence prevents a fair campaign claim.', 'contradictory_evidence');
  }

  const structuredEvidence = {
    codes: evidenceCodes,
    providerMessageID: base.actionID,
    deliveryEventID: normaliseID(touch.deliveryEventID ?? touch.delivery_event_id),
    identityMethod: identity.method,
    productMatches: productMatch.matches,
    window: { strongSeconds: window.strongSeconds, maximumSeconds: window.maximumSeconds }
  };

  const directEvidence = verifiedDirectEvidence({
    order, touch, deliveredTime, paidTime, productMatch, linkEvents, couponEvidence, inboundIntents
  });
  if (directEvidence) {
    return {
      ...base,
      confidenceLevel: 'direct',
      confidenceScore: CONFIDENCE.direct,
      attributionWindowSeconds: elapsedSeconds,
      reason: 'A trusted delivered campaign action and recipient-bound conversion signal link the exact customer and paid order.',
      supportingEvidence: {
        ...structuredEvidence,
        codes: [...evidenceCodes, directEvidence.code],
        directEvidenceID: directEvidence.id
      },
      invalidated: false
    };
  }

  if (productMatch.matched && elapsedSeconds <= window.strongSeconds) {
    return {
      ...base,
      confidenceLevel: 'strong',
      confidenceScore: CONFIDENCE.strong,
      attributionWindowSeconds: elapsedSeconds,
      reason: 'The exact recipient bought the exact campaign product shortly after trusted delivery, without a direct conversion signal.',
      supportingEvidence: structuredEvidence,
      invalidated: false
    };
  }

  return {
    ...base,
    confidenceLevel: 'influenced',
    confidenceScore: CONFIDENCE.influenced,
    attributionWindowSeconds: elapsedSeconds,
    reason: productMatch.matched
      ? 'The exact recipient bought the campaign product inside the wider attribution window, but direct causality is not established.'
      : 'The exact recipient purchased inside the campaign window, but no exact product or direct conversion signal supports a stronger claim.',
    supportingEvidence: structuredEvidence,
    invalidated: false
  };
}

function evidenceRank(candidate = {}) {
  const evidence = candidate?.supportingEvidence || candidate?.supporting_evidence || {};
  const codes = new Set(evidence.codes || []);
  if ((candidate?.category === 'payment_recovery' || candidate?.workflow === 'payment_recovery') &&
      evidence.exactOrderMatch === true && evidence.paymentConfirmationMessageID) return 700;
  if (codes.has('exact_payment_reminder') && codes.has('trusted_payment_confirmation')) return 700;
  if (codes.has('verified_unique_recipient_coupon')) return 650;
  if (codes.has('verified_recipient_order_link')) return 640;
  if (codes.has('trusted_rule_based_purchase_confirmation')) return 620;
  if ((candidate?.category === 'payment_recovery' || candidate?.workflow === 'payment_recovery') &&
      evidence.exactOrderMatch === true) return 550;
  if (codes.has('exact_payment_reminder')) return 550;
  if (codes.has('exact_target_product')) return 400;
  return 100;
}

const SOURCE_RANK = Object.freeze({ payment_recovery: 4, campaign: 3, call: 2, conversation: 1 });

function candidateSource(candidate = {}) {
  if (candidate.sourceType) return candidate.sourceType;
  if (candidate.category === 'payment_recovery' || candidate.workflow === 'payment_recovery') return 'payment_recovery';
  if (candidate.campaignID || candidate.campaign_id) return 'campaign';
  return null;
}

function winnerSort(left, right) {
  const confidenceDifference = (CONFIDENCE[right.confidenceLevel] ?? -1) - (CONFIDENCE[left.confidenceLevel] ?? -1);
  if (confidenceDifference) return confidenceDifference;
  const evidenceDifference = evidenceRank(right) - evidenceRank(left);
  if (evidenceDifference) return evidenceDifference;
  const sourceDifference = (SOURCE_RANK[candidateSource(right)] || 0) - (SOURCE_RANK[candidateSource(left)] || 0);
  if (sourceDifference) return sourceDifference;
  const leftElapsed = Number(left.attributionWindowSeconds);
  const rightElapsed = Number(right.attributionWindowSeconds);
  if (Number.isFinite(leftElapsed) && Number.isFinite(rightElapsed) && leftElapsed !== rightElapsed) return leftElapsed - rightElapsed;
  const actionDifference = (asTime(right.actionAt) || 0) - (asTime(left.actionAt) || 0);
  if (actionDifference) return actionDifference;
  return String(left.actionID || left.originatingActionID || '').localeCompare(String(right.actionID || right.originatingActionID || ''));
}

/** Select one reproducible winner for one workspace/order. */
function chooseAttributionWinner(candidates = []) {
  if (!Array.isArray(candidates)) throw new Error('candidates must be an array.');
  const orderIDs = new Set(candidates.map(item => String(item?.orderID ?? item?.order_id ?? '')).filter(Boolean));
  const workspaceIDs = new Set(candidates.map(item => String(item?.workspaceID ?? item?.workspace_id ?? '')).filter(Boolean));
  if (orderIDs.size !== 1) throw new Error('winner candidates must belong to exactly one order.');
  if (workspaceIDs.size !== 1) throw new Error('winner candidates must belong to exactly one workspace.');
  const eligible = candidates.filter(item =>
    ['direct', 'strong', 'influenced'].includes(item?.confidenceLevel) &&
    item.excluded !== true &&
    !item.invalidated && !item.invalidatedAt && !item.invalidated_at &&
    moneyToCents(item.netAmount ?? item.net_amount) > 0
  ).sort(winnerSort);
  const winner = eligible[0] || null;
  return {
    orderID: [...orderIDs][0] || null,
    workspaceID: [...workspaceIDs][0] || null,
    classification: winner?.confidenceLevel || 'unattributed',
    winner,
    displaced: eligible.slice(1).map(candidate => ({
      candidate,
      reason: CONFIDENCE[candidate.confidenceLevel] < CONFIDENCE[winner.confidenceLevel]
        ? 'lower_confidence'
        : evidenceRank(candidate) < evidenceRank(winner)
          ? 'weaker_evidence'
          : 'deterministic_tiebreak'
    }))
  };
}

function reconcileCampaignAttribution(attribution, order, { now = new Date(), reason = null } = {}) {
  const grossCents = moneyToCents(order?.grossAmount ?? order?.gross_amount ?? order?.total ?? attribution?.grossAmount);
  const refundedCents = Math.min(grossCents, moneyToCents(order?.refundedAmount ?? order?.refunded_amount));
  const netCents = Math.max(0, grossCents - refundedCents);
  const status = String(order?.status || '').toLowerCase();
  const fullyInvalid = FINAL_CANCELLED_STATUSES.has(status) || netCents === 0;
  const reconciliationTime = asTime(now);
  if (fullyInvalid && reconciliationTime === null) throw new Error('now must be a valid date.');
  return {
    ...attribution,
    grossAmount: centsToMoney(grossCents),
    refundedAmount: centsToMoney(refundedCents),
    netAmount: centsToMoney(netCents),
    isRefunded: refundedCents > 0,
    invalidated: fullyInvalid,
    invalidatedAt: fullyInvalid ? new Date(reconciliationTime).toISOString() : null,
    invalidationReason: fullyInvalid
      ? (reason || (status ? `Authoritative order status is ${status}.` : 'Authoritative order has no remaining net revenue.'))
      : null,
    effectiveConfidenceLevel: fullyInvalid ? 'unattributed' : attribution?.confidenceLevel,
    reconciliationReason: fullyInvalid ? 'attribution_invalidated' : refundedCents > 0 ? 'partial_refund_reconciled' : 'authoritative_order_reconciled'
  };
}

function summariseCampaignPerformance({ campaignID, recipients = [], attributions = [] } = {}) {
  const requestedCampaignID = String(campaignID || '');
  if (!requestedCampaignID) throw new Error('campaignID is required.');
  const uniqueRecipients = new Map();
  for (const recipient of recipients || []) {
    const id = String(recipient?.recipientID ?? recipient?.recipient_id ?? recipient?.id ?? '');
    if (id && !uniqueRecipients.has(id)) uniqueRecipients.set(id, recipient);
  }
  const values = [...uniqueRecipients.values()];
  const trustedDelivered = values.filter(item => item.deliveryTrusted === true && asTime(item.deliveredAt ?? item.delivered_at) !== null);
  const grouped = new Map();
  for (const attribution of attributions || []) {
    const orderID = String(attribution?.orderID ?? attribution?.order_id ?? '');
    if (!orderID) continue;
    if (!grouped.has(orderID)) grouped.set(orderID, []);
    grouped.get(orderID).push(attribution);
  }
  // Select the global order winner first, including competing payment/call
  // candidates. Only then count orders actually won by this campaign.
  const winners = [...grouped.values()]
    .map(group => chooseAttributionWinner(group).winner)
    .filter(winner => winner && candidateSource(winner) === 'campaign' &&
      String(winner.campaignID ?? winner.campaign_id ?? '') === requestedCampaignID);
  const convertedRecipients = new Set(winners.map(item => String(item.recipientID ?? item.recipient_id ?? '')).filter(Boolean));
  const ordersByConfidence = {
    direct: winners.filter(item => item.confidenceLevel === 'direct').length,
    strong: winners.filter(item => item.confidenceLevel === 'strong').length,
    influenced: winners.filter(item => item.confidenceLevel === 'influenced').length
  };
  const revenueCents = { direct: 0, strong: 0, influenced: 0 };
  for (const winner of winners) revenueCents[winner.confidenceLevel] += moneyToCents(winner.netAmount ?? winner.net_amount);
  const states = state => values.filter(item => String(item.state || '').toLowerCase() === state).length;
  const accepted = values.filter(item => asTime(item.providerAcceptedAt ?? item.provider_accepted_at ?? item.sentAt ?? item.sent_at) !== null).length;
  const replies = values.filter(item => item.replyTrusted === true && asTime(item.repliedAt ?? item.replied_at) !== null).length;
  const optOuts = values.filter(item => item.optOutTrusted === true && asTime(item.optedOutAt ?? item.opted_out_at) !== null).length;
  const direct = centsToMoney(revenueCents.direct);
  const strong = centsToMoney(revenueCents.strong);
  const influenced = centsToMoney(revenueCents.influenced);
  return {
    recipients: values.length,
    providerAccepted: accepted,
    delivered: trustedDelivered.length,
    queued: ['pending', 'deferred', 'claimed', 'sending'].reduce((sum, state) => sum + states(state), 0),
    failed: states('failed'),
    skipped: states('suppressed'),
    cancelled: states('cancelled'),
    replies,
    optOuts,
    revenueImpactOrders: winners.length,
    attributedOrders: ordersByConfidence.direct + ordersByConfidence.strong,
    influencedOrders: ordersByConfidence.influenced,
    ordersByConfidence,
    convertedRecipients: convertedRecipients.size,
    conversionRate: trustedDelivered.length ? convertedRecipients.size / trustedDelivered.length : null,
    conversionRateBasis: 'trusted_delivered_recipients',
    revenue: {
      direct,
      strong,
      influenced,
      attributed: centsToMoney(revenueCents.direct + revenueCents.strong),
      totalImpact: centsToMoney(revenueCents.direct + revenueCents.strong + revenueCents.influenced)
    }
  };
}

module.exports = {
  CONFIDENCE,
  DEFAULT_WINDOWS_BY_WORKFLOW,
  METHODOLOGY_VERSION,
  PRODUCT_SPECIFIC_WORKFLOWS,
  candidateSource,
  chooseAttributionWinner,
  classifyCampaignOrder,
  evidenceRank,
  matchRecipientToOrder,
  matchTargetProducts,
  reconcileCampaignAttribution,
  resolveWindow,
  summariseCampaignPerformance
};
