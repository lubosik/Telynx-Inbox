'use strict';

const { summariseCampaignPerformance } = require('./attribution-policy');

// Delivery is intentionally one canonical, structured provider event. Legacy
// aliases are not accepted as financial/operational delivery evidence.
const TRUSTED_DELIVERY_EVENTS = new Set(['provider.delivered']);
const TRUSTED_REPLY_EVENTS = new Set(['customer.replied', 'message.replied']);
const TRUSTED_OPT_OUT_EVENTS = new Set(['recipient.opted_out', 'consent.opted_out']);
const CAMPAIGN_CATEGORIES = new Set([
  'back_in_stock', 'back_in_stock_requested', 'back_in_stock_repeat_buyer',
  'reorder', 'reorder_personal', 'reorder_personal_high', 'winback',
  'manual_exact_product', 'manual', 'generic_promotion', 'campaign'
]);

function moneyToCents(value) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value ?? '0').trim());
  if (!match) return 0n;
  const fraction = (match[2] || '').padEnd(3, '0');
  let cents = BigInt(match[1]) * 100n + BigInt(fraction.slice(0, 2) || '0');
  if (Number(fraction[2] || 0) >= 5) cents += 1n;
  return cents;
}

function centsToDecimal(cents) {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

function asTime(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function eventTrusted(event) {
  if (String(event?.event_type || '').toLowerCase().startsWith('provider.')) {
    return event?.trusted === true && event?.provider === 'telnyx' &&
      typeof event?.provider_event_id === 'string' && event.provider_event_id.trim().length > 0 &&
      event?.trust_source === 'telnyx_ed25519_v2';
  }
  return event?.trusted === true || event?.metadata?.trusted === true;
}

function uniqueEvents(events = []) {
  const seen = new Set();
  return (events || []).filter(event => {
    const key = String(event?.dedupe_key || event?.id || '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function latestTrustedEvent(events, types) {
  return uniqueEvents(events)
    .filter(event => eventTrusted(event) && types.has(String(event.event_type || '').toLowerCase()))
    .filter(event => asTime(event.occurred_at) !== null)
    .sort((left, right) => asTime(right.occurred_at) - asTime(left.occurred_at))[0] || null;
}

/**
 * Produce privacy-minimised per-recipient metric inputs. No phone, contact
 * name, message body, or provider error detail leaves this boundary.
 */
function campaignMetricRecipients(recipients = [], events = []) {
  const eventsByRecipient = new Map();
  for (const event of uniqueEvents(events)) {
    const id = String(event?.recipient_id || '');
    if (!id) continue;
    if (!eventsByRecipient.has(id)) eventsByRecipient.set(id, []);
    eventsByRecipient.get(id).push(event);
  }
  return (recipients || []).filter(row => row?.selected !== false).map(row => {
    const id = String(row?.id || '');
    const ownedEvents = eventsByRecipient.get(id) || [];
    const delivery = latestTrustedEvent(ownedEvents, TRUSTED_DELIVERY_EVENTS);
    const reply = latestTrustedEvent(ownedEvents, TRUSTED_REPLY_EVENTS);
    const optOut = latestTrustedEvent(ownedEvents, TRUSTED_OPT_OUT_EVENTS);
    return {
      recipientID: id,
      state: String(row?.state || 'draft').toLowerCase(),
      providerAcceptedAt: row?.sent_at || null,
      deliveredAt: delivery?.occurred_at || null,
      deliveryTrusted: Boolean(delivery),
      repliedAt: reply?.occurred_at || null,
      replyTrusted: Boolean(reply),
      optedOutAt: optOut?.occurred_at || null,
      optOutTrusted: Boolean(optOut)
    };
  });
}

function campaignOperationalMetrics(recipients = [], events = []) {
  const metricRecipients = campaignMetricRecipients(recipients, events);
  const emptyFinancial = summariseCampaignPerformance({
    campaignID: 'operational-only', recipients: metricRecipients, attributions: []
  });
  return {
    recipients: emptyFinancial.recipients,
    providerAccepted: emptyFinancial.providerAccepted,
    delivered: emptyFinancial.delivered,
    queued: emptyFinancial.queued,
    failed: emptyFinancial.failed,
    skipped: emptyFinancial.skipped,
    cancelled: emptyFinancial.cancelled,
    replies: emptyFinancial.replies,
    optOuts: emptyFinancial.optOuts,
    deliveryDefinition: 'trusted_provider_delivery',
    providerAcceptanceIsDelivery: false
  };
}

function evidenceCampaignID(row) {
  if (row?.campaign_id) return String(row.campaign_id);
  const evidence = row?.supporting_evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return null;
  return String(evidence.campaignID ?? evidence.campaign_id ?? '') || null;
}

function campaignAttributionRows({ campaignID, workspaceID, recipients = [], attributions = [] } = {}) {
  const campaign = String(campaignID || '');
  const workspace = String(workspaceID || '');
  if (!campaign || !workspace) throw new Error('campaignID and workspaceID are required.');
  const actionToRecipient = new Map();
  for (const row of recipients || []) {
    const recipientID = String(row?.id || '');
    for (const action of [row?.provider_message_id, row?.id]) {
      if (action && recipientID) actionToRecipient.set(String(action), recipientID);
    }
  }

  return (attributions || []).filter(row => {
    const actionID = String(row?.originating_action_id || '');
    const category = String(row?.category || row?.workflow || '').toLowerCase();
    const explicitCampaign = evidenceCampaignID(row);
    if (explicitCampaign && explicitCampaign !== campaign) return false;
    return explicitCampaign === campaign || (actionToRecipient.has(actionID) && CAMPAIGN_CATEGORIES.has(category));
  }).map(row => ({
    ...row,
    workspaceID: workspace,
    orderID: String(row.order_id || ''),
    sourceType: 'campaign',
    campaignID: campaign,
    recipientID: String(row.campaign_recipient_id || '') ||
      actionToRecipient.get(String(row.originating_action_id || '')) ||
      String(row?.supporting_evidence?.recipientID ?? row?.supporting_evidence?.recipient_id ?? '') || null,
    actionID: row.originating_action_id || null,
    actionAt: row.action_at || null,
    conversionAt: row.conversion_at || null,
    attributionWindowSeconds: row.attribution_window_seconds,
    confidenceLevel: row.confidence_level,
    netAmount: row.net_amount,
    invalidatedAt: row.invalidated_at || null,
    supportingEvidence: row.supporting_evidence || {}
  }));
}

function campaignFinancialMetrics({ campaignID, workspaceID, recipients = [], events = [], attributions = [] } = {}) {
  const metricRecipients = campaignMetricRecipients(recipients, events);
  const campaignRows = campaignAttributionRows({ campaignID, workspaceID, recipients, attributions });
  const summary = summariseCampaignPerformance({
    campaignID: String(campaignID), recipients: metricRecipients, attributions: campaignRows
  });
  const attributedLevels = new Set(['direct', 'strong', 'influenced']);
  const currentByOrder = new Map();
  for (const row of campaignRows) {
    const orderID = String(row.orderID || '');
    if (orderID && !currentByOrder.has(orderID)) currentByOrder.set(orderID, row);
  }
  let grossCents = 0n;
  let refundedCents = 0n;
  let refundedOrders = 0;
  for (const row of currentByOrder.values()) {
    if (!attributedLevels.has(row.confidenceLevel)) continue;
    grossCents += moneyToCents(row.gross_amount);
    const refund = moneyToCents(row.refunded_amount);
    refundedCents += refund;
    if (refund > 0n || row.is_refunded) refundedOrders += 1;
  }
  return {
    revenueImpactOrders: summary.revenueImpactOrders,
    attributedOrders: summary.attributedOrders,
    influencedOrders: summary.influencedOrders,
    ordersByConfidence: summary.ordersByConfidence,
    convertedRecipients: summary.convertedRecipients,
    conversionRate: summary.conversionRate,
    conversionRateBasis: summary.conversionRateBasis,
    revenue: {
      direct: Number(summary.revenue.direct).toFixed(2),
      strong: Number(summary.revenue.strong).toFixed(2),
      influenced: Number(summary.revenue.influenced).toFixed(2),
      attributed: Number(summary.revenue.attributed).toFixed(2),
      totalImpact: Number(summary.revenue.totalImpact).toFixed(2),
      gross: centsToDecimal(grossCents),
      refunded: centsToDecimal(refundedCents),
      refundedOrders
    },
    attributions: campaignRows
  };
}

module.exports = {
  CAMPAIGN_CATEGORIES,
  TRUSTED_DELIVERY_EVENTS,
  campaignAttributionRows,
  campaignFinancialMetrics,
  campaignMetricRecipients,
  campaignOperationalMetrics,
  eventTrusted
};
