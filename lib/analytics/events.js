'use strict';

const { supabase } = require('../../db');
const { broadcast } = require('../broadcaster');
const { normalisePhone } = require('../phone');
const { wooGet } = require('../../woocommerce');
const {
  DEFAULT_WINDOWS,
  PAYMENT_REMINDER_FLOWS,
  classifyPaymentRecovery
} = require('./attribution');
const { isExcludedIdentity } = require('./exclusions');
const { PAGE_SIZE, IN_CHUNK_SIZE } = require('../fetch-all-rows');
const { stageAttributionCandidate } = require('./reconciliation');
const { reconcileCampaignAttributionsForOrder } = require('../campaigns/attribution-generator');

const WORKSPACE_ID = 'vici';
const METHODOLOGY_VERSION = 'vici-revenue-v1';
let warnedMissingMigration = false;

function isMissingAnalyticsSchema(error) {
  return ['42P01', 'PGRST205', 'PGRST204', 'PGRST202'].includes(error?.code) ||
    /analytics_|revenue_attributions|message_sentiment|stage_revenue_attribution_candidate/i.test(error?.message || '');
}

function warnMissingOnce(error) {
  if (warnedMissingMigration) return;
  warnedMissingMigration = true;
  console.warn(`[ANALYTICS] Schema is not ready; source workflow continues safely (${error?.code || 'unknown'}).`);
}

function wooTimestamp(value) {
  if (!value) return null;
  if (/Z$|[+-]\d\d:\d\d$/.test(value)) return value;
  return `${value}Z`;
}

function refundedAmount(order) {
  const gross = Math.max(0, Number(order?.total) || 0);
  const total = (order?.refunds || []).reduce((sum, refund) => sum + Math.abs(Number(refund?.total) || 0), 0);
  return Math.min(gross, Number(total.toFixed(2)));
}

function eventTypeForStatus(status) {
  if (status === 'processing') return 'payment_completed';
  if (status === 'completed') return 'order_completed';
  if (status === 'refunded') return 'order_refunded';
  if (status === 'cancelled') return 'order_cancelled';
  if (status === 'failed' || status === 'on-hold') return 'payment_pending';
  return 'order_status_changed';
}

function eventOccurredAt(order, eventType) {
  if (eventType === 'payment_completed') {
    return wooTimestamp(order?.date_paid_gmt || order?.date_paid) ||
      wooTimestamp(order?.date_modified_gmt || order?.date_modified);
  }
  return wooTimestamp(order?.date_modified_gmt || order?.date_modified || order?.date_created_gmt || order?.date_created) ||
    new Date().toISOString();
}

function attributionInvalidation(order, assessment, now = new Date()) {
  const status = String(order?.status || '').toLowerCase();
  if (status === 'cancelled') {
    return { invalidatedAt: now.toISOString(), reason: 'Authoritative order was cancelled.' };
  }
  if (status === 'refunded') {
    return { invalidatedAt: now.toISOString(), reason: 'Authoritative order status is refunded.' };
  }
  if (assessment.netAmount === 0 && assessment.refundedAmount > 0) {
    return { invalidatedAt: now.toISOString(), reason: 'Order was fully refunded.' };
  }
  return { invalidatedAt: null, reason: null };
}

async function analyticsRules() {
  const { data, error } = await supabase
    .from('analytics_attribution_rules')
    .select('business_timezone,currency,methodology_version,payment_strong_seconds,payment_maximum_seconds')
    .eq('workspace_id', WORKSPACE_ID)
    .maybeSingle();
  if (error) throw error;
  return data || {
    business_timezone: 'America/New_York',
    currency: 'USD',
    methodology_version: METHODOLOGY_VERSION,
    payment_strong_seconds: DEFAULT_WINDOWS.paymentRecoveryStrongSeconds,
    payment_maximum_seconds: DEFAULT_WINDOWS.paymentRecoveryMaximumSeconds
  };
}

// ---------------------------------------------------------------------------
// Paged and chunked reads
//
// Both of the shapes that took the inbox down on 20 August 2026 were live in
// this file:
//
//   1. An unpaged `.select()`. PostgREST silently caps a response at 1000 rows,
//      so the query does not fail — it just stops seeing data past row 1000.
//   2. A computed array passed straight into `.in()`. supabase-js serialises
//      every value into the URL, and a long enough list overflows Node's HTTP
//      header limit (UND_ERR_HEADERS_OVERFLOW) after a ~10 second stall.
//
// `lib/fetch-all-rows.js` solves both, but its `fetchAllRows`/`selectIn` take
// no additional filters and these queries need several `.eq()`s each. So the
// same two techniques are applied here, reusing that module's page and chunk
// sizes rather than inventing new ones.
// ---------------------------------------------------------------------------

/**
 * Read every matching row, one page at a time.
 *
 * @param {(builder: object) => object} applyFilters  receives a FRESH builder
 *   per page; must return it. Called once per page because a supabase-js
 *   builder cannot be reused after it has been awaited.
 */
async function pagedSelect(client, table, columns, applyFilters, { maxRows = 100000 } = {}) {
  const rows = [];
  for (let from = 0; from < maxRows; from += PAGE_SIZE) {
    const { data, error } = await applyFilters(client.from(table).select(columns))
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
  console.warn(`[ANALYTICS] ${table} hit the ${maxRows}-row ceiling; evidence for this assessment is truncated.`);
  return rows;
}

/**
 * Run a filtered `.in(column, values)` query in URL-safe chunks.
 *
 * @param {(builder: object) => object} applyFilters  receives a FRESH builder
 *   per chunk, with the `.in()` already applied, and must return it. The
 *   `.in()` goes on first deliberately: `.order()` returns a transform builder
 *   in supabase-js v2, and a transform builder has no filter methods, so a
 *   caller that ends its filters with `.order()` would otherwise crash here.
 *
 * Chunking does not disturb a per-value `.order()`: every value lands in
 * exactly one chunk, so ordering within a chunk is ordering within that
 * value's complete result set.
 */
async function chunkedIn(client, table, columns, applyFilters, column, values, chunkSize = IN_CHUNK_SIZE) {
  const unique = [...new Set(values)].filter(value => value !== null && value !== undefined);
  if (!unique.length) return [];
  const rows = [];
  for (let i = 0; i < unique.length; i += chunkSize) {
    // bounded: `chunk` is at most chunkSize (IN_CHUNK_SIZE, 200) values by
    // construction, which is the whole point of this loop.
    const chunk = unique.slice(i, i + chunkSize);
    const { data, error } = await applyFilters(client.from(table).select(columns).in(column, chunk));
    if (error) throw error;
    rows.push(...(data || []));
  }
  return rows;
}

async function deliveredReminders(orderID, client = supabase) {
  const logs = await pagedSelect(
    client,
    'sms_sent_log',
    'id,order_id,flow_type,phone,message_body,telnyx_message_id,sent_at',
    builder => builder
      .eq('order_id', String(orderID))
      // bounded: PAYMENT_REMINDER_FLOWS is a module-level Set of 7 flow-type
      // string literals in lib/analytics/attribution.js — a hand-written
      // vocabulary, not a computed list, so it cannot grow with data volume.
      .in('flow_type', [...PAYMENT_REMINDER_FLOWS])
      .not('telnyx_message_id', 'is', null)
      .order('sent_at', { ascending: true })
  );
  const ids = [...new Set(logs.map(row => row.telnyx_message_id).filter(Boolean))];
  if (!ids.length) return [];
  const messages = await chunkedIn(
    client,
    'analytics_message_events',
    'message_id,status,occurred_at',
    builder => builder
      .eq('workspace_id', WORKSPACE_ID)
      .eq('provider', 'telnyx')
      .eq('trusted', true)
      .order('occurred_at', { ascending: false }),
    'message_id',
    ids
  );
  const status = new Map();
  for (const message of messages) {
    if (!status.has(message.message_id)) status.set(message.message_id, message.status);
  }
  return logs.map(row => ({ ...row, delivery_status: status.get(row.telnyx_message_id) || null }));
}

async function inboundEvidence(phone, startAt, endAt, client = supabase) {
  if (!phone || !startAt || !endAt) return [];
  const messages = await pagedSelect(
    client,
    'sms_messages',
    'id,telnyx_message_id,body,created_at',
    builder => builder
      .eq('contact_phone', phone)
      .eq('direction', 'inbound')
      .gte('created_at', startAt)
      .lte('created_at', endAt)
      .order('created_at', { ascending: true })
  );
  const ids = messages.map(row => row.telnyx_message_id).filter(Boolean);
  if (!ids.length) return [];
  const trusted = await chunkedIn(
    client,
    'analytics_message_events',
    'message_id',
    builder => builder
      .eq('workspace_id', WORKSPACE_ID)
      .eq('provider', 'telnyx')
      .eq('event_type', 'message.received')
      .eq('trusted', true),
    'message_id',
    ids
  );
  const trustedIDs = new Set(trusted.map(row => row.message_id));
  return messages.filter(row => trustedIDs.has(row.telnyx_message_id));
}

async function recordTelnyxMessageEvent(event, { signatureValid, status = null } = {}) {
  if (!signatureValid) return { recorded: false, trusted: false, reason: 'unverified' };
  const providerEventID = String(event?.id || '');
  const messageID = String(event?.payload?.id || '');
  const eventType = String(event?.event_type || '');
  const occurredAt = event?.occurred_at || event?.payload?.received_at || new Date().toISOString();
  if (!providerEventID || !messageID || !eventType) {
    return { recorded: false, trusted: false, reason: 'malformed' };
  }
  const { data, error } = await supabase.from('analytics_message_events').upsert({
    workspace_id: WORKSPACE_ID,
    provider: 'telnyx',
    provider_event_id: providerEventID,
    message_id: messageID,
    event_type: eventType,
    status,
    occurred_at: occurredAt,
    trusted: true
  }, { onConflict: 'workspace_id,provider,provider_event_id', ignoreDuplicates: true })
    .select('id').maybeSingle();
  if (error) throw error;
  return { recorded: Boolean(data), trusted: true };
}

async function assessPaidOrder(order, source = 'live', { financialObservedAt = null } = {}) {
  const orderID = String(order?.id || '');
  if (!orderID) return null;
  const candidatePhone = normalisePhone(order?.billing?.phone || order?.shipping?.phone);
  if (isExcludedIdentity({ phone: candidatePhone, orderID })) return null;
  const rules = await analyticsRules();
  const reminders = await deliveredReminders(orderID);
  const orderPhone = candidatePhone;
  const reminderPhones = new Set(reminders.map(row => normalisePhone(row.phone)).filter(Boolean));
  const identityMatched = Boolean(orderPhone && reminderPhones.has(orderPhone));
  const delivered = reminders.filter(row => row.delivery_status === 'delivered');
  const earliest = delivered.map(row => row.sent_at).filter(Boolean).sort()[0];
  const paidAt = wooTimestamp(order?.date_paid_gmt || order?.date_paid);
  const inboundMessages = await inboundEvidence(orderPhone, earliest, paidAt);
  const ambiguousOrderMatch = delivered.some(row => /\b(two orders|both orders|orders\s+#|lock them both)\b/i.test(row.message_body || ''));

  const assessment = classifyPaymentRecovery({
    order: {
      id: orderID,
      total: order?.total,
      refunded_amount: refundedAmount(order),
      date_paid_gmt: paidAt
    },
    reminders,
    inboundMessages,
    identityMatched,
    ambiguousOrderMatch,
    windows: {
      paymentRecoveryStrongSeconds: rules.payment_strong_seconds,
      paymentRecoveryMaximumSeconds: rules.payment_maximum_seconds
    }
  });
  const invalidation = attributionInvalidation(order, assessment);

  const payload = {
    workspace_id: WORKSPACE_ID,
    order_id: orderID,
    customer_id: order?.customer_id ? String(order.customer_id) : null,
    contact_phone: orderPhone,
    currency: order?.currency || rules.currency || 'USD',
    gross_amount: assessment.grossAmount.toFixed(2),
    refunded_amount: assessment.refundedAmount.toFixed(2),
    net_amount: assessment.netAmount.toFixed(2),
    category: assessment.category,
    workflow: assessment.workflow,
    originating_action_type: assessment.action ? 'sms' : null,
    originating_action_id: assessment.action?.messageID || assessment.action?.id || null,
    action_at: assessment.action?.occurredAt || null,
    conversion_at: assessment.conversionAt,
    attribution_window_seconds: assessment.attributionWindowSeconds,
    confidence_level: assessment.confidenceLevel,
    confidence_score: assessment.confidenceScore.toFixed(2),
    reason: assessment.reason,
    supporting_evidence: assessment.evidence,
    methodology_version: rules.methodology_version || METHODOLOGY_VERSION,
    source,
    is_refunded: assessment.refundedAmount > 0,
    invalidated_at: invalidation.invalidatedAt,
    invalidation_reason: invalidation.reason
  };

  return stageAttributionCandidate(supabase, payload, {
    sourceType: 'payment_recovery',
    sourceKey: `payment-recovery:${orderID}`,
    financialStatus: order?.status,
    financialObservedAt: financialObservedAt ||
      eventOccurredAt(order, eventTypeForStatus(String(order?.status || 'unknown')))
  });
}

async function reconcileAttributionForDeliveredMessage(messageID) {
  if (!messageID) return null;
  try {
    const { data: log, error } = await supabase
      .from('sms_sent_log')
      .select('order_id,flow_type')
      .eq('telnyx_message_id', messageID)
      .maybeSingle();
    if (error) throw error;
    if (!log || !PAYMENT_REMINDER_FLOWS.has(log.flow_type) || !/^\d+$/.test(String(log.order_id))) return null;
    const { data: order } = await wooGet(`/orders/${encodeURIComponent(log.order_id)}`);
    if (!order?.date_paid_gmt && !order?.date_paid) return null;
    const assessment = await assessPaidOrder(order);
    if (!assessment) return null;
    await bumpState('revenue_attribution', order.date_paid_gmt || order.date_paid);
    return assessment;
  } catch (error) {
    if (isMissingAnalyticsSchema(error)) warnMissingOnce(error);
    else console.error('[ANALYTICS] Delivery reconciliation failed:', error.message);
    return null;
  }
}

async function bumpState(metric, occurredAt) {
  const { data, error } = await supabase.rpc('bump_analytics_state', { p_workspace_id: WORKSPACE_ID });
  if (error) throw error;
  broadcast({ type: 'analytics_changed', version: data, metric, occurred_at: occurredAt });
  return data;
}

/**
 * Capture a trusted, minimal Woo event and reconcile its one order.
 * This function is best-effort by design: analytics must never interrupt the
 * existing order/payment messaging flow during rollout or migration ordering.
 */
async function recordWooOrderEvent(order, { deliveryID, topic, signatureValid }) {
  if (!signatureValid) {
    console.warn(`[ANALYTICS] Unverified Woo event excluded | order=${order?.id || 'unknown'}`);
    return { recorded: false, reason: 'unverified' };
  }
  try {
    const status = String(order?.status || 'unknown');
    const eventType = eventTypeForStatus(status);
    const occurredAt = eventOccurredAt(order, eventType);
    const dedupKey = deliveryID
      ? `woo:${deliveryID}`
      : `woo:${order?.id}:${status}:${wooTimestamp(order?.date_modified_gmt || order?.date_modified) || occurredAt}`;
    const gross = Math.max(0, Number(order?.total) || 0);
    const refunded = refundedAmount(order);
    const phone = normalisePhone(order?.billing?.phone || order?.shipping?.phone);
    if (isExcludedIdentity({ phone, orderID: order?.id })) {
      return { recorded: false, reason: 'excluded_internal_or_test' };
    }
    const { data: insertedEvent, error } = await supabase.from('analytics_order_events').upsert({
      workspace_id: WORKSPACE_ID,
      provider: 'woocommerce',
      provider_event_id: deliveryID || null,
      dedup_key: dedupKey,
      event_type: eventType,
      order_id: String(order?.id),
      customer_id: order?.customer_id ? String(order.customer_id) : null,
      contact_phone: phone,
      financial_status: status,
      currency: order?.currency || 'USD',
      gross_amount: gross.toFixed(2),
      refunded_amount: refunded.toFixed(2),
      occurred_at: occurredAt,
      trusted: true,
      evidence: {
        topic: topic || null,
        paidTimestampPresent: Boolean(order?.date_paid_gmt || order?.date_paid),
        refundCount: Array.isArray(order?.refunds) ? order.refunds.length : 0
      }
    }, { onConflict: 'workspace_id,dedup_key', ignoreDuplicates: true }).select('id').maybeSingle();
    if (error) throw error;
    // A verified duplicate may be the first retry after the reconciliation
    // migration became available. Re-run the idempotent order reconciliation
    // before returning, while avoiding a duplicate realtime/version bump.
    if (['processing', 'completed', 'refunded', 'cancelled'].includes(status)) {
      await assessPaidOrder(order, 'live', { financialObservedAt: occurredAt });
      // Campaign attribution is evidence-driven and best-effort. The reader
      // returns not-ready when its additive schema is absent and stages nothing
      // unless an exact canonical signed delivery exists for this order/customer.
      await reconcileCampaignAttributionsForOrder({
        client: supabase,
        order,
        workspaceID: WORKSPACE_ID,
        financialObservedAt: occurredAt
      });
    }
    if (!insertedEvent) return { recorded: false, reason: 'duplicate' };
    const version = await bumpState(eventType, occurredAt);
    return { recorded: true, version };
  } catch (error) {
    if (isMissingAnalyticsSchema(error)) warnMissingOnce(error);
    else console.error('[ANALYTICS] Woo event capture failed:', error.message);
    return { recorded: false, reason: 'error' };
  }
}

async function markMetricChanged(metric, occurredAt = new Date().toISOString()) {
  try { return await bumpState(metric, occurredAt); }
  catch (error) {
    if (isMissingAnalyticsSchema(error)) warnMissingOnce(error);
    else console.error('[ANALYTICS] State update failed:', error.message);
    return null;
  }
}

module.exports = {
  METHODOLOGY_VERSION,
  WORKSPACE_ID,
  assessPaidOrder,
  chunkedIn,
  deliveredReminders,
  inboundEvidence,
  pagedSelect,
  attributionInvalidation,
  eventTypeForStatus,
  markMetricChanged,
  recordTelnyxMessageEvent,
  reconcileAttributionForDeliveredMessage,
  recordWooOrderEvent,
  refundedAmount
};
