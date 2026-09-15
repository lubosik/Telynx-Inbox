'use strict';

const { stageAttributionCandidate } = require('../analytics/reconciliation');

const METHODOLOGY_VERSION = 'vici-cart-recovery-v1';

function attributionPayload(cart) {
  if (!cart || cart.status !== 'recovered' || cart.dry_run !== false || !cart.attribution_valid ||
      !cart.delivered_at || !cart.clicked_at || !cart.order_paid_at || !cart.telnyx_message_id || !cart.order_id) return null;
  const delivered = Date.parse(cart.delivered_at);
  const clicked = Date.parse(cart.clicked_at);
  const paid = Date.parse(cart.order_paid_at);
  if (![delivered, clicked, paid].every(Number.isFinite) || clicked < delivered || paid < clicked || paid - clicked > 86400000) return null;
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
    originating_action_type: 'sms',
    originating_action_id: cart.telnyx_message_id,
    action_at: new Date(delivered).toISOString(),
    conversion_at: new Date(paid).toISOString(),
    attribution_window_seconds: Math.floor((paid - delivered) / 1000),
    confidence_level: 'direct',
    confidence_score: 1,
    reason: 'Paid order is bound to the delivered recovery message through its opaque recovery token and matching restored cart.',
    supporting_evidence: {
      codes: ['trusted_provider_delivery', 'verified_recipient_order_link', 'exact_recovery_cart_order'],
      recoveryCartID: cart.external_cart_id,
      providerMessageID: cart.telnyx_message_id,
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
