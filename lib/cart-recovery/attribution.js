'use strict';

const { stageAttributionCandidate } = require('../analytics/reconciliation');

const METHODOLOGY_VERSION = 'vici-cart-recovery-v1';

function attributionPayload(cart) {
  if (!cart || cart.status !== 'recovered' || !cart.attribution_valid || !cart.order_paid_at || !cart.order_id) return null;
  const paid = Date.parse(cart.order_paid_at);
  const candidates = [];
  const smsAction = Date.parse(cart.delivered_at);
  const smsClick = Date.parse(cart.clicked_at);
  if (cart.dry_run === false && cart.telnyx_message_id && Number.isFinite(smsAction) && Number.isFinite(smsClick)
      && smsClick >= smsAction) {
    candidates.push({ type: 'sms', id: cart.telnyx_message_id, action: smsAction, click: smsClick,
      codes: ['trusted_provider_delivery', 'verified_recipient_order_link', 'exact_recovery_cart_order'] });
  }
  const pushAction = Date.parse(cart.push_sent_at);
  const pushClick = Date.parse(cart.push_clicked_at);
  if (cart.push_provider_message_id && Number.isFinite(pushAction) && Number.isFinite(pushClick)
      && pushClick >= pushAction) {
    candidates.push({ type: 'push', id: cart.push_provider_message_id, action: pushAction, click: pushClick,
      codes: ['trusted_customer_push_send', 'tracked_push_click', 'exact_recovery_cart_order'] });
  }
  const action = candidates.filter(value => Number.isFinite(paid) && paid >= value.click && paid - value.click <= 86400000)
    .sort((left, right) => right.click - left.click)[0];
  if (!action) return null;
  const total = Number(cart.order_total);
  if (!Number.isFinite(total) || total <= 0) return null;
  return {
    workspace_id: cart.workspace_id,
    order_id: String(cart.order_id),
    customer_id: cart.wordpress_user_id || null,
    contact_phone: cart.contact_phone,
    currency: cart.order_currency,
    gross_amount: total,
    refunded_amount: 0,
    net_amount: total,
    category: 'cart_recovery',
    workflow: 'cart_recovery',
    originating_action_type: action.type,
    originating_action_id: action.id,
    action_at: new Date(action.action).toISOString(),
    conversion_at: new Date(paid).toISOString(),
    attribution_window_seconds: Math.floor((paid - action.action) / 1000),
    confidence_level: 'direct',
    confidence_score: 1,
    reason: `Paid order is bound to the tracked ${action.type} recovery action and matching recovery cart.`,
    supporting_evidence: {
      codes: action.codes,
      recoveryCartID: cart.external_cart_id,
      providerMessageID: action.id,
      recoveryChannel: action.type,
      recipientBound: true,
      orderBound: true,
      exactOrderMatch: true
    },
    methodology_version: METHODOLOGY_VERSION,
    source: 'luko_cart_recovery'
  };
}

async function stageCartRecoveryAttribution(client, cart) {
  const payload = attributionPayload(cart);
  if (!payload) return { staged: false };
  const result = await stageAttributionCandidate(client, payload, {
    sourceType: 'payment_recovery',
    sourceKey: `cart-recovery:${cart.external_cart_id}`,
    financialStatus: cart.order_status,
    financialObservedAt: cart.order_paid_at
  });
  return { staged: true, result };
}

async function findBy(client, workspace, column, value) {
  const query = client.from('luko_cart_recoveries').select('*').eq('workspace_id', workspace).eq(column, value).limit(1);
  const { data, error } = await query;
  if (error) throw error;
  return Array.isArray(data) ? data[0] || null : data || null;
}

module.exports = { METHODOLOGY_VERSION, attributionPayload, stageCartRecoveryAttribution, findBy };
