'use strict';

const { normalisePhone } = require('../phone');
const { wooOrderItems } = require('../woocommerce-order-items');
const { isExcludedIdentity } = require('../analytics/exclusions');
const { stageAttributionCandidate } = require('../analytics/reconciliation');
const {
  METHODOLOGY_VERSION,
  classifyCampaignOrder
} = require('./attribution-policy');

const PAGE_SIZE = 500;
const CHUNK_SIZE = 200;
const MAX_MATCHING_ROWS = 10000;
const REQUIRED_WORKFLOWS = Object.freeze([
  'back_in_stock', 'back_in_stock_requested', 'back_in_stock_repeat_buyer',
  'reorder', 'reorder_personal', 'reorder_personal_high', 'winback',
  'manual_exact_product', 'manual', 'generic_promotion'
]);
const PRODUCT_REQUIRED_WORKFLOWS = new Set([
  'back_in_stock', 'back_in_stock_requested', 'back_in_stock_repeat_buyer',
  'reorder', 'reorder_personal', 'reorder_personal_high', 'manual_exact_product'
]);
const ALLOWED_DIRECT_EVIDENCE = new Set([
  'verified_recipient_order_link',
  'verified_unique_recipient_coupon',
  'trusted_rule_based_purchase_confirmation'
]);

class CampaignAttributionNotReadyError extends Error {
  constructor(reason = 'campaign_attribution_not_ready') {
    super('Campaign attribution generation is not ready.');
    this.name = 'CampaignAttributionNotReadyError';
    this.code = 'CAMPAIGN_ATTRIBUTION_NOT_READY';
    this.reason = reason;
  }
}

function missingSchema(error) {
  if (['42P01', 'PGRST202', 'PGRST204', 'PGRST205'].includes(error?.code)) return true;
  const message = String(error?.message || '');
  return /does not exist|could not find|schema cache/i.test(message) &&
    /campaign_attribution_policies|sms_campaign_/i.test(message);
}

function asISO(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function wooDate(order, gmtKey, localKey) {
  const gmt = order?.[gmtKey];
  if (gmt) return asISO(/Z$|[+-]\d\d:\d\d$/.test(String(gmt)) ? gmt : `${gmt}Z`);
  return asISO(order?.[localKey]);
}

function positiveID(value, { allowZero = false } = {}) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && (allowZero ? parsed >= 0 : parsed > 0) ? String(parsed) : null;
}

function frozenTargetProducts(recipient = {}) {
  const reason = recipient.inclusion_reason;
  if (!reason || typeof reason !== 'object' || Array.isArray(reason)) return [];
  const productID = positiveID(reason.productID ?? reason.product_id);
  if (!productID) return [];
  const variationID = positiveID(reason.variationID ?? reason.variation_id, { allowZero: true });
  return [{ productID, variationID: variationID === '0' ? null : variationID }];
}

function frozenCustomerID(recipient = {}) {
  const reason = recipient.inclusion_reason;
  if (!reason || typeof reason !== 'object' || Array.isArray(reason)) return null;
  return positiveID(reason.wooCustomerID ?? reason.woo_customer_id ?? reason.customerID ?? reason.customer_id);
}

async function pagedQuery(build, { maxRows = MAX_MATCHING_ROWS } = {}) {
  const rows = [];
  for (let from = 0; from < maxRows; from += PAGE_SIZE) {
    const size = Math.min(PAGE_SIZE, maxRows - from);
    const { data, error } = await build().range(from, from + size - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < size) return rows;
  }
  throw new CampaignAttributionNotReadyError('bounded_read_truncated');
}

async function loadActivePolicies(client, workspaceID) {
  let rows;
  try {
    rows = await pagedQuery(() => client.from('campaign_attribution_policies')
      .select('workflow_category,policy_version,methodology_version,strong_window_seconds,maximum_window_seconds,product_identity_required,allowed_direct_evidence')
      .eq('workspace_id', workspaceID).eq('active', true)
      .order('workflow_category', { ascending: true }), { maxRows: 100 });
  } catch (error) {
    if (missingSchema(error)) throw new CampaignAttributionNotReadyError('policy_schema_missing');
    throw error;
  }
  const byWorkflow = new Map(rows.map(row => [String(row.workflow_category), row]));
  const complete = REQUIRED_WORKFLOWS.every(workflow => byWorkflow.has(workflow));
  if (!complete) throw new CampaignAttributionNotReadyError('active_policy_incomplete');
  for (const policy of byWorkflow.values()) {
    const strong = Number(policy.strong_window_seconds);
    const maximum = Number(policy.maximum_window_seconds);
    if (!Number.isInteger(strong) || strong <= 0 || !Number.isInteger(maximum) || maximum < strong) {
      throw new CampaignAttributionNotReadyError('active_policy_invalid');
    }
    const workflow = String(policy.workflow_category);
    if (Boolean(policy.product_identity_required) !== PRODUCT_REQUIRED_WORKFLOWS.has(workflow)) {
      throw new CampaignAttributionNotReadyError('product_requirement_policy_invalid');
    }
    const directCodes = Array.isArray(policy.allowed_direct_evidence) ? policy.allowed_direct_evidence : [];
    if (directCodes.some(code => !ALLOWED_DIRECT_EVIDENCE.has(String(code)))) {
      throw new CampaignAttributionNotReadyError('direct_evidence_policy_invalid');
    }
  }
  return byWorkflow;
}

async function campaignAttributionGenerationReady(client, workspaceID = 'vici') {
  try {
    await loadActivePolicies(client, workspaceID);
    return true;
  } catch (error) {
    if (error instanceof CampaignAttributionNotReadyError) return false;
    throw error;
  }
}

async function fetchRecipientRows(client, workspaceID, phone) {
  return pagedQuery(() => client.from('sms_campaign_recipients')
    .select('id,campaign_id,workspace_id,contact_phone,inclusion_reason,state,selected,approved_in_audience,approval_revision,provider_message_id,delivered_at')
    .eq('workspace_id', workspaceID).eq('contact_phone', phone)
    .eq('selected', true).eq('approved_in_audience', true).eq('state', 'delivered')
    .order('delivered_at', { ascending: false }));
}

async function fetchByChunks(client, table, columns, column, values, workspaceID, extraFilters) {
  const unique = [...new Set(values.map(String).filter(Boolean))];
  const rows = [];
  for (let offset = 0; offset < unique.length; offset += CHUNK_SIZE) {
    const chunk = unique.slice(offset, offset + CHUNK_SIZE);
    const found = await pagedQuery(() => {
      let query = client.from(table).select(columns).eq('workspace_id', workspaceID)
        .in(column, chunk); // bounded: chunk contains no more than 200 exact identifiers.
      if (extraFilters) query = extraFilters(query);
      return query.order('created_at', { ascending: true });
    });
    rows.push(...found);
  }
  return rows;
}

async function fetchTrustedTouches(client, { workspaceID, order }) {
  const phone = normalisePhone(order?.billing?.phone || order?.shipping?.phone);
  if (!phone) return [];
  const recipients = await fetchRecipientRows(client, workspaceID, phone);
  if (!recipients.length) return [];
  const campaigns = await fetchByChunks(client, 'sms_campaigns',
    'id,workspace_id,workflow_category,status,revision,audience_definition', 'id',
    recipients.map(row => row.campaign_id), workspaceID);
  // Event rows use occurred_at rather than created_at, so keep this separate
  // from the generic chunk reader while preserving the same URL bound.
  const events = [];
  const recipientIDs = recipients.map(row => row.id);
  for (let offset = 0; offset < recipientIDs.length; offset += CHUNK_SIZE) {
    const chunk = recipientIDs.slice(offset, offset + CHUNK_SIZE);
    const found = await pagedQuery(() => client.from('sms_campaign_recipient_events')
      .select('id,recipient_id,campaign_id,workspace_id,event_type,occurred_at,provider,provider_event_id,provider_message_id,trusted,trust_source')
      .eq('workspace_id', workspaceID)
      .eq('event_type', 'provider.delivered').eq('trusted', true)
      .eq('provider', 'telnyx').eq('trust_source', 'telnyx_ed25519_v2')
      .in('recipient_id', chunk) // bounded: chunk contains no more than 200 recipient IDs.
      .order('occurred_at', { ascending: true }));
    events.push(...found);
  }

  const campaignByID = new Map(campaigns.map(row => [String(row.id), row]));
  const latestEvent = new Map();
  for (const event of events) {
    const key = String(event.recipient_id || '');
    const previous = latestEvent.get(key);
    if (!previous || Date.parse(event.occurred_at) > Date.parse(previous.occurred_at)) latestEvent.set(key, event);
  }
  return recipients.flatMap(recipient => {
    const campaign = campaignByID.get(String(recipient.campaign_id));
    const event = latestEvent.get(String(recipient.id));
    if (!campaign || !event) return [];
    // Cancellation/failure stops unsent recipients; it does not erase a
    // previously trusted delivery. A delivered recipient from a partially
    // completed campaign remains a valid historical touch.
    if (!['scheduled', 'sending', 'completed', 'cancelled', 'failed'].includes(String(campaign.status))) return [];
    if (Number(recipient.approval_revision) !== Number(campaign.revision)) return [];
    if (!event.provider_event_id || event.provider_message_id !== recipient.provider_message_id ||
        String(event.campaign_id) !== String(campaign.id)) return [];
    return [{ recipient, campaign, event }];
  });
}

function windowsFromPolicies(policies) {
  return Object.fromEntries([...policies.entries()].map(([workflow, row]) => [workflow, {
    strongSeconds: Number(row.strong_window_seconds),
    maximumSeconds: Number(row.maximum_window_seconds)
  }]));
}

function classifyTrustedTouch(order, touchRow, policies, { internalOrTestIdentity = false } = {}) {
  const { recipient, campaign, event } = touchRow;
  const workflow = String(campaign.workflow_category || '').toLowerCase();
  const policy = policies.get(workflow);
  if (!policy) throw new CampaignAttributionNotReadyError('workflow_policy_missing');
  const targets = frozenTargetProducts(recipient);
  const policyCodes = Array.isArray(policy.allowed_direct_evidence) ? policy.allowed_direct_evidence : [];
  // No Direct evidence ledger exists in this release. An allowlist in policy
  // cannot manufacture evidence; link/coupon/intent arrays remain empty.
  const classification = classifyCampaignOrder({
    order: {
      workspaceID: recipient.workspace_id,
      id: String(order.id),
      customerID: order?.customer_id ? String(order.customer_id) : null,
      phone: normalisePhone(order?.billing?.phone || order?.shipping?.phone),
      total: order?.total,
      refundedAmount: (order?.refunds || []).reduce((sum, refund) => sum + Math.abs(Number(refund?.total) || 0), 0),
      paidAt: wooDate(order, 'date_paid_gmt', 'date_paid'),
      status: order?.status,
      lineItems: wooOrderItems(order),
      couponCodes: (order?.coupon_lines || []).map(row => row?.code).filter(Boolean)
    },
    touch: {
      workspaceID: recipient.workspace_id,
      campaignID: campaign.id,
      recipientID: recipient.id,
      customerID: frozenCustomerID(recipient),
      phone: recipient.contact_phone,
      providerMessageID: recipient.provider_message_id,
      providerStatus: 'delivered',
      deliveryTrusted: true,
      deliveredAt: event.occurred_at,
      deliveryEventID: event.provider_event_id,
      workflow,
      targetProducts: targets
    },
    windowsByWorkflow: windowsFromPolicies(policies),
    internalOrTestIdentity,
    linkEvents: [], couponEvidence: [], inboundIntents: []
  });
  return {
    ...classification,
    policyVersion: Number(policy.policy_version),
    methodologyVersion: policy.methodology_version || METHODOLOGY_VERSION,
    providerEventID: String(event.provider_event_id),
    allowedDirectEvidence: policyCodes
  };
}

function persistencePayload(classification, order, workspaceID) {
  const refunded = Math.min(Number(classification.grossAmount) || 0, Number(classification.refundedAmount) || 0);
  return {
    workspace_id: workspaceID,
    order_id: String(order.id),
    customer_id: order?.customer_id ? String(order.customer_id) : null,
    contact_phone: normalisePhone(order?.billing?.phone || order?.shipping?.phone),
    currency: order?.currency || 'USD',
    gross_amount: Number(classification.grossAmount || 0).toFixed(2),
    refunded_amount: refunded.toFixed(2),
    net_amount: Number(classification.netAmount || 0).toFixed(2),
    category: classification.category,
    workflow: classification.workflow,
    originating_action_type: 'sms_campaign',
    originating_action_id: classification.actionID,
    campaign_id: classification.campaignID,
    campaign_recipient_id: classification.recipientID,
    action_at: asISO(classification.actionAt),
    conversion_at: asISO(classification.conversionAt),
    attribution_window_seconds: classification.attributionWindowSeconds,
    confidence_level: classification.confidenceLevel,
    confidence_score: Number(classification.confidenceScore).toFixed(2),
    reason: classification.reason,
    supporting_evidence: {
      codes: classification.supportingEvidence?.codes || [],
      directEvidenceID: classification.supportingEvidence?.directEvidenceID || null,
      campaignID: classification.campaignID,
      recipientID: classification.recipientID,
      providerEventID: classification.providerEventID,
      policyVersion: classification.policyVersion
    },
    methodology_version: classification.methodologyVersion,
    source: 'live_campaign',
    is_refunded: refunded > 0,
    invalidated_at: classification.invalidated ? new Date().toISOString() : null,
    invalidation_reason: classification.invalidated ? classification.reason : null
  };
}

async function reconcileCampaignAttributionsForOrder({
  client, order, workspaceID = 'vici', financialObservedAt
} = {}) {
  if (!client) throw new Error('client is required.');
  const orderID = String(order?.id || '');
  if (!orderID) return { ready: true, candidates: 0, staged: 0 };
  const phone = normalisePhone(order?.billing?.phone || order?.shipping?.phone);
  if (isExcludedIdentity({ phone, orderID })) return { ready: true, candidates: 0, staged: 0, excluded: true };
  let policies;
  let touches;
  try {
    policies = await loadActivePolicies(client, workspaceID);
    touches = await fetchTrustedTouches(client, { workspaceID, order });
  } catch (error) {
    if (error instanceof CampaignAttributionNotReadyError || missingSchema(error)) {
      return { ready: false, reason: error.reason || 'campaign_schema_missing', candidates: 0, staged: 0 };
    }
    throw error;
  }
  const observedAt = asISO(financialObservedAt) ||
    wooDate(order, 'date_modified_gmt', 'date_modified') ||
    wooDate(order, 'date_paid_gmt', 'date_paid');
  if (!observedAt) return { ready: false, reason: 'financial_observation_time_missing', candidates: 0, staged: 0 };
  let staged = 0;
  for (const touch of touches) {
    const classification = classifyTrustedTouch(order, touch, policies, {
      internalOrTestIdentity: isExcludedIdentity({ phone, orderID })
    });
    if (classification.excluded) continue;
    const payload = persistencePayload(classification, order, workspaceID);
    await stageAttributionCandidate(client, payload, {
      sourceType: 'campaign',
      sourceKey: `campaign:${classification.campaignID}:${classification.recipientID}`,
      financialStatus: order?.status,
      financialObservedAt: observedAt
    });
    staged += 1;
  }
  return { ready: true, candidates: touches.length, staged };
}

module.exports = {
  CampaignAttributionNotReadyError,
  REQUIRED_WORKFLOWS,
  campaignAttributionGenerationReady,
  classifyTrustedTouch,
  fetchTrustedTouches,
  frozenCustomerID,
  frozenTargetProducts,
  loadActivePolicies,
  persistencePayload,
  reconcileCampaignAttributionsForOrder,
  windowsFromPolicies
};
