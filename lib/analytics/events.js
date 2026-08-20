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

const WORKSPACE_ID = 'vici';
const METHODOLOGY_VERSION = 'vici-revenue-v1';
let warnedMissingMigration = false;

function isMissingAnalyticsSchema(error) {
  return ['42P01', 'PGRST205', 'PGRST204'].includes(error?.code) ||
    /analytics_|revenue_attributions|message_sentiment/i.test(error?.message || '');
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

function sameTime(left, right) {
  if (!left && !right) return true;
  return Date.parse(left) === Date.parse(right);
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

async function deliveredReminders(orderID) {
  const { data: logs, error } = await supabase
    .from('sms_sent_log')
    .select('id,order_id,flow_type,phone,message_body,telnyx_message_id,sent_at')
    .eq('order_id', String(orderID))
    .in('flow_type', [...PAYMENT_REMINDER_FLOWS])
    .not('telnyx_message_id', 'is', null)
    .order('sent_at', { ascending: true });
  if (error) throw error;
  const ids = [...new Set((logs || []).map(row => row.telnyx_message_id).filter(Boolean))];
  if (!ids.length) return [];
  const { data: messages, error: messageError } = await supabase
    .from('analytics_message_events')
    .select('message_id,status,occurred_at')
    .eq('workspace_id', WORKSPACE_ID)
    .eq('provider', 'telnyx')
    .eq('trusted', true)
    .in('message_id', ids)
    .order('occurred_at', { ascending: false });
  if (messageError) throw messageError;
  const status = new Map();
  for (const message of messages || []) {
    if (!status.has(message.message_id)) status.set(message.message_id, message.status);
  }
  return (logs || []).map(row => ({ ...row, delivery_status: status.get(row.telnyx_message_id) || null }));
}

async function inboundEvidence(phone, startAt, endAt) {
  if (!phone || !startAt || !endAt) return [];
  const { data, error } = await supabase
    .from('sms_messages')
    .select('id,telnyx_message_id,body,created_at')
    .eq('contact_phone', phone)
    .eq('direction', 'inbound')
    .gte('created_at', startAt)
    .lte('created_at', endAt)
    .order('created_at', { ascending: true });
  if (error) throw error;
  const messages = data || [];
  const ids = messages.map(row => row.telnyx_message_id).filter(Boolean);
  if (!ids.length) return [];
  const { data: trusted, error: trustError } = await supabase
    .from('analytics_message_events')
    .select('message_id')
    .eq('workspace_id', WORKSPACE_ID)
    .eq('provider', 'telnyx')
    .eq('event_type', 'message.received')
    .eq('trusted', true)
    .in('message_id', ids);
  if (trustError) throw trustError;
  const trustedIDs = new Set((trusted || []).map(row => row.message_id));
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

async function assessPaidOrder(order, source = 'live') {
  const orderID = String(order?.id || '');
  if (!orderID) return null;
  const rules = await analyticsRules();
  const reminders = await deliveredReminders(orderID);
  const orderPhone = normalisePhone(order?.billing?.phone || order?.shipping?.phone);
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

  const { data: existing, error: existingError } = await supabase
    .from('revenue_attributions')
    .select('id,confidence_level,confidence_score,gross_amount,refunded_amount,net_amount,originating_action_id,action_at,conversion_at,methodology_version,invalidated_at')
    .eq('workspace_id', WORKSPACE_ID)
    .eq('order_id', orderID)
    .maybeSingle();
  if (existingError) throw existingError;
  const unchanged = existing &&
    existing.confidence_level === payload.confidence_level &&
    Number(existing.confidence_score) === Number(payload.confidence_score) &&
    Number(existing.gross_amount) === Number(payload.gross_amount) &&
    Number(existing.refunded_amount) === Number(payload.refunded_amount) &&
    Number(existing.net_amount) === Number(payload.net_amount) &&
    existing.originating_action_id === payload.originating_action_id &&
    sameTime(existing.action_at, payload.action_at) &&
    sameTime(existing.conversion_at, payload.conversion_at) &&
    existing.methodology_version === payload.methodology_version &&
    Boolean(existing.invalidated_at) === Boolean(payload.invalidated_at);
  if (unchanged) return existing;

  const { data, error } = await supabase
    .from('revenue_attributions')
    .upsert(payload, { onConflict: 'workspace_id,order_id' })
    .select('id,confidence_level,net_amount')
    .maybeSingle();
  if (error) throw error;
  return data;
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
    if (!insertedEvent) return { recorded: false, reason: 'duplicate' };

    if (['processing', 'completed', 'refunded', 'cancelled'].includes(status)) {
      await assessPaidOrder(order);
    }
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
  attributionInvalidation,
  eventTypeForStatus,
  markMetricChanged,
  recordTelnyxMessageEvent,
  reconcileAttributionForDeliveredMessage,
  recordWooOrderEvent,
  refundedAmount
};
