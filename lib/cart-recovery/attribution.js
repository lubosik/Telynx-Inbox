'use strict';

const { stageAttributionCandidate } = require('../analytics/reconciliation');

const METHODOLOGY_VERSION = 'vici-cart-recovery-v2';
const RECOVERY_COUPON = 'VICI15';
const PAID_STATUSES = new Set(['processing', 'completed']);

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function money(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function within(start, end, milliseconds) {
  return start !== null && end !== null && end >= start && end - start <= milliseconds;
}

function orderFinancials(order) {
  const gross = money(order?.total);
  if (gross === null) return null;
  const refunded = Math.min(gross, money(order?.refunded_amount) ?? 0);
  return {
    gross,
    discount: money(order?.discount_total) ?? 0,
    refunded,
    net: Math.max(0, gross - refunded),
    currency: /^[A-Z]{3}$/.test(String(order?.currency || '')) ? order.currency : null
  };
}

function secondarySignals(cart, order) {
  const couponUsed = order?.coupon_verified === true
    && String(order?.coupon_code || '').toUpperCase() === RECOVERY_COUPON;
  return {
    coupon_used: couponUsed ? RECOVERY_COUPON : null,
    conversation_occurred: Boolean(cart?.conversation_occurred_at || (cart?.reply_status && cart.reply_status !== 'NONE')),
    push_clicked: Boolean(cart?.push_recovery_click_id && cart?.push_clicked_at),
    sms_recovery_link_clicked: Boolean(cart?.sms_recovery_click_id && cart?.clicked_at),
    voice_touch: Boolean(cart?.voice_started_at),
    voice_transfer_connected: Boolean(cart?.voice_transfer_connected_at)
  };
}

function attributionDecision(cart, order, { windowDays = 7, pushShopWindowHours = 24 } = {}) {
  if (!cart || !order || !PAID_STATUSES.has(String(order.status || '').toLowerCase()) || !order.paid_at) return null;
  const paidAt = timestamp(order.paid_at);
  const episodeAt = timestamp(cart.last_activity_at);
  const expiresAt = timestamp(cart.recovery_expires_at);
  const configuredWindow = Math.max(1, Math.min(30, Number(windowDays) || 7)) * 86400000;
  if (paidAt === null || episodeAt === null || !within(episodeAt, paidAt, configuredWindow)) return null;
  if (expiresAt !== null && paidAt > expiresAt) return null;
  if (order.attribution_valid !== true) return null;
  const clickID = String(order.recovery_click_id || '');
  const clickChannel = String(order.recovery_channel || '').toLowerCase();
  const signals = secondarySignals(cart, order);
  let primary = null;

  if (clickChannel === 'sms' && clickID && clickID === String(cart.sms_recovery_click_id || '')
      && cart.dry_run === false && cart.telnyx_message_id && cart.sent_at) {
    const clickedAt = timestamp(order.recovery_clicked_at || cart.clicked_at);
    if (within(clickedAt, paidAt, configuredWindow)) {
      primary = { method: 'sms_recovery_link', strength: 'direct', actionAt: clickedAt,
        actionID: clickID, channel: 'sms', evidence: ['sms_recovery_link_clicked', 'exact_recovery_cart_order'] };
    }
  }

  if (!primary && clickChannel === 'push' && clickID && clickID === String(cart.push_recovery_click_id || '')
      && cart.push_provider_message_id && cart.push_sent_at) {
    const clickedAt = timestamp(order.recovery_clicked_at || cart.push_clicked_at);
    const pushWindow = cart.push_destination_type === 'shop'
      ? Math.min(configuredWindow, Math.max(1, Number(pushShopWindowHours) || 24) * 3600000)
      : configuredWindow;
    if (within(clickedAt, paidAt, pushWindow)) {
      primary = { method: 'push', strength: 'direct', actionAt: clickedAt,
        actionID: clickID, channel: 'push', evidence: ['tracked_push_click', 'exact_recovery_cart_order'] };
    }
  }

  const conversationAt = timestamp(cart.conversation_occurred_at);
  const transferAt = timestamp(cart.voice_transfer_connected_at);
  if (!primary && transferAt !== null && within(transferAt, paidAt, configuredWindow)) {
    primary = { method: 'voice_transfer_assisted', strength: 'strong', actionAt: transferAt,
      actionID: cart.voice_call_control_id || cart.id, channel: 'voice',
      evidence: ['voice_transfer_connected', 'active_recovery_episode'] };
  }

  if (!primary && conversationAt !== null && cart.telnyx_message_id && cart.dry_run === false
      && within(conversationAt, paidAt, configuredWindow)) {
    primary = { method: 'conversation_assisted', strength: 'strong', actionAt: conversationAt,
      actionID: cart.telnyx_message_id, channel: 'sms', evidence: ['customer_replied', 'active_recovery_episode'] };
  }

  const incentiveAt = timestamp(cart.push_due_at);
  const incentiveEligible = Boolean(cart.push_sent_at || cart.customer_push_permission === true);
  if (!primary && signals.coupon_used === RECOVERY_COUPON && incentiveEligible
      && incentiveAt !== null && paidAt >= incentiveAt
      && within(incentiveAt, paidAt, configuredWindow)) {
    primary = { method: 'recovery_coupon', strength: 'strong', actionAt: incentiveAt,
      actionID: RECOVERY_COUPON, channel: cart.push_sent_at ? 'push' : 'manual',
      evidence: ['verified_recovery_coupon', 'active_recovery_episode', 'incentive_stage_eligible'] };
  }

  if (!primary) return null;
  const financial = orderFinancials(order);
  if (!financial || !financial.currency || financial.gross <= 0) return null;
  return {
    workspace_id: cart.workspace_id,
    recovery_id: cart.id,
    abandonment_episode_id: cart.id,
    external_cart_id: cart.external_cart_id,
    order_id: String(order.order_id),
    wordpress_user_id: cart.wordpress_user_id || null,
    customer_identity_id: cart.customer_identity_id || null,
    contact_phone: cart.contact_phone || null,
    original_cart_value: Number(cart.cart_total) || 0,
    order_paid_at: new Date(paidAt).toISOString(),
    order_status: String(order.status).toLowerCase(),
    order_currency: financial.currency,
    gross_recovered_revenue: financial.gross,
    discount_amount: financial.discount,
    refund_amount: financial.refunded,
    net_recovered_revenue: financial.net,
    attribution_method: primary.method,
    attribution_strength: primary.strength,
    attribution_action_at: new Date(primary.actionAt).toISOString(),
    attribution_window_seconds: Math.floor((paidAt - primary.actionAt) / 1000),
    recovery_channel: primary.channel,
    recovery_click_id: clickID || null,
    coupon_code: signals.coupon_used,
    conversation_occurred: signals.conversation_occurred,
    voice_call_control_id: cart.voice_call_control_id || null,
    secondary_signals: signals,
    evidence_codes: primary.evidence,
    attribution_model_version: METHODOLOGY_VERSION
  };
}

function attributionPayload(record) {
  if (!record?.order_id || !record?.recovery_id) return null;
  const direct = record.attribution_strength === 'direct';
  const method = record.attribution_method;
  const actionID = method === 'sms_recovery_link' || method === 'push'
    ? record.recovery_click_id
    : method === 'recovery_coupon' ? RECOVERY_COUPON : record.message_id;
  return {
    workspace_id: record.workspace_id,
    order_id: String(record.order_id),
    customer_id: record.wordpress_user_id || null,
    contact_phone: record.contact_phone || null,
    currency: record.order_currency,
    gross_amount: Number(record.gross_recovered_revenue),
    refunded_amount: Number(record.refund_amount),
    net_amount: Number(record.net_recovered_revenue),
    category: 'cart_recovery',
    workflow: 'cart_recovery',
    originating_action_type: method,
    originating_action_id: actionID || record.recovery_id,
    action_at: record.attribution_action_at,
    conversion_at: record.order_paid_at,
    attribution_window_seconds: Number(record.attribution_window_seconds) || 0,
    confidence_level: direct ? 'direct' : 'strong',
    confidence_score: direct ? 1 : 0.9,
    reason: direct
      ? `Paid order is deterministically linked to ${method}.`
      : `Paid order is strongly linked to ${method} within an active recovery episode.`,
    supporting_evidence: {
      codes: Array.isArray(record.evidence_codes) ? record.evidence_codes : [],
      recoveryID: record.recovery_id,
      externalCartID: record.external_cart_id,
      primaryMethod: method,
      secondarySignals: record.secondary_signals || {},
      orderBound: true
    },
    methodology_version: record.attribution_model_version || METHODOLOGY_VERSION,
    source: 'luko_cart_recovery'
  };
}

async function stagePersisted(client, record) {
  const payload = attributionPayload(record);
  if (!payload) return null;
  return stageAttributionCandidate(client, payload, {
    sourceType: 'payment_recovery',
    sourceKey: `cart-recovery:${record.recovery_id}`,
    financialStatus: record.order_status,
    financialObservedAt: record.financial_observed_at || record.updated_at || record.order_paid_at
  });
}

async function stageCartRecoveryAttribution(client, cart, order, settings = {}) {
  const decision = attributionDecision(cart, order, {
    windowDays: settings.attribution_window_days,
    pushShopWindowHours: settings.push_shop_attribution_window_hours
  });
  if (!decision) return { staged: false };
  const { data: record, error } = await client.rpc('persist_luko_cart_recovered_order', { p_decision: decision });
  if (error) throw error;
  const result = await stagePersisted(client, record);
  return { staged: true, decision, record, result };
}

async function reconcileCartRecoveryFinancials(client, cart, order) {
  if (!cart || !order?.order_id) return { reconciled: false };
  const financial = orderFinancials(order);
  if (!financial || !financial.currency) return { reconciled: false };
  const observedAt = order.financial_observed_at || new Date().toISOString();
  const { data: record, error } = await client.rpc('reconcile_luko_cart_recovered_order_financials', {
    p_recovery_id: cart.id,
    p_order_id: String(order.order_id),
    p_status: String(order.status || '').toLowerCase(),
    p_currency: financial.currency,
    p_gross: financial.gross,
    p_discount: financial.discount,
    p_refunded: financial.refunded,
    p_observed_at: observedAt
  });
  if (error) throw error;
  if (!record) return { reconciled: false };
  const result = await stagePersisted(client, record);
  return { reconciled: true, record, result };
}

async function findBy(client, workspace, column, value) {
  const query = client.from('luko_cart_recoveries').select('*').eq('workspace_id', workspace).eq(column, value).limit(1);
  const { data, error } = await query;
  if (error) throw error;
  return Array.isArray(data) ? data[0] || null : data || null;
}

module.exports = {
  METHODOLOGY_VERSION,
  RECOVERY_COUPON,
  attributionDecision,
  attributionPayload,
  stageCartRecoveryAttribution,
  reconcileCartRecoveryFinancials,
  findBy
};
