'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  chooseAttributionWinner,
  classifyCampaignOrder,
  matchRecipientToOrder,
  matchTargetProducts,
  reconcileCampaignAttribution,
  resolveWindow,
  summariseCampaignPerformance
} = require('../lib/campaigns/attribution-policy');

const touch = {
  workspaceID: 'vici',
  campaignID: 'campaign-1',
  recipientID: 'recipient-1',
  workflow: 'back_in_stock',
  providerMessageID: 'message-1',
  providerStatus: 'delivered',
  deliveryTrusted: true,
  deliveredAt: '2026-08-20T12:00:00.000Z',
  customerID: '44',
  phone: '+13055550123',
  targetProducts: [{ productID: 101, variationID: 202 }]
};

const order = {
  workspaceID: 'vici',
  id: 'order-1',
  customerID: '44',
  phone: '(305) 555-0123',
  status: 'processing',
  total: '120.00',
  refundedAmount: 0,
  paidAt: '2026-08-20T14:00:00.000Z',
  lineItems: [{ productID: 101, variationID: 202 }]
};

test('provider acceptance is never treated as campaign delivery evidence', () => {
  const result = classifyCampaignOrder({
    order,
    touch: { ...touch, providerStatus: 'sent', deliveryTrusted: false, providerAcceptedAt: touch.deliveredAt }
  });
  assert.equal(result.confidenceLevel, 'unattributed');
  assert.ok(result.supportingEvidence.codes.includes('trusted_delivery_required'));
});

test('exact recipient, product, timing and trusted delivery qualify as Strong', () => {
  const result = classifyCampaignOrder({ order, touch });
  assert.equal(result.confidenceLevel, 'strong');
  assert.equal(result.confidenceScore, 0.9);
  assert.equal(result.attributionWindowSeconds, 7200);
  assert.deepEqual(result.supportingEvidence.codes, [
    'trusted_provider_delivery',
    'exact_recipient_customer_id',
    'inside_attribution_window',
    'exact_target_product'
  ]);
  assert.deepEqual(result.supportingEvidence.productMatches, [{ productID: '101', variationID: '202' }]);
  assert.equal(result.supportingEvidence.identityMethod, 'customer_id');
});

test('a verified recipient-bound, order-bound link can qualify as Direct', () => {
  const result = classifyCampaignOrder({
    order,
    touch,
    linkEvents: [{
      id: 'click-1', campaignID: 'campaign-1', recipientID: 'recipient-1', orderID: 'order-1',
      trusted: true, recipientBound: true, orderBound: true, occurredAt: '2026-08-20T12:30:00Z'
    }]
  });
  assert.equal(result.confidenceLevel, 'direct');
  assert.equal(result.confidenceScore, 1);
  assert.ok(result.supportingEvidence.codes.includes('verified_recipient_order_link'));
});

test('a trusted unique recipient coupon used on the exact order can qualify as Direct', () => {
  const result = classifyCampaignOrder({
    order: { ...order, couponCodes: ['RESTOCK-44'] },
    touch,
    couponEvidence: [{
      id: 'coupon-assignment-1', code: 'restock-44', campaignID: 'campaign-1', recipientID: 'recipient-1',
      trusted: true, recipientBound: true, singleUse: true, assignedAt: '2026-08-20T11:00:00Z'
    }]
  });
  assert.equal(result.confidenceLevel, 'direct');
  assert.ok(result.supportingEvidence.codes.includes('verified_unique_recipient_coupon'));
});

test('only a trusted deterministic purchase-confirmation intent can strengthen to Direct', () => {
  const event = {
    id: 'intent-1', campaignID: 'campaign-1', recipientID: 'recipient-1', intentCode: 'purchase_confirmed',
    trusted: true, ruleBased: true, occurredAt: '2026-08-20T13:00:00Z'
  };
  assert.equal(classifyCampaignOrder({ order, touch, inboundIntents: [event] }).confidenceLevel, 'direct');
  assert.equal(classifyCampaignOrder({ order, touch, inboundIntents: [{ ...event, ruleBased: false }] }).confidenceLevel, 'strong');
});

test('unrelated products and non-exact variations remain Unattributed', () => {
  const unrelated = classifyCampaignOrder({
    order: { ...order, lineItems: [{ productID: 999, variationID: 1 }] }, touch
  });
  const wrongVariation = classifyCampaignOrder({
    order: { ...order, lineItems: [{ productID: 101, variationID: 203 }] }, touch
  });
  assert.equal(unrelated.confidenceLevel, 'unattributed');
  assert.equal(wrongVariation.confidenceLevel, 'unattributed');
  assert.ok(wrongVariation.supportingEvidence.codes.includes('target_product_not_in_order'));
});

test('product-specific workflows fail closed when frozen product IDs are absent', () => {
  const result = classifyCampaignOrder({ order, touch: { ...touch, targetProducts: [] } });
  assert.equal(result.confidenceLevel, 'unattributed');
  assert.ok(result.supportingEvidence.codes.includes('target_product_evidence_missing'));
});

test('generic timing without a direct signal is only Influenced', () => {
  const result = classifyCampaignOrder({
    order: { ...order, lineItems: [] },
    touch: { ...touch, workflow: 'manual', targetProducts: [] }
  });
  assert.equal(result.confidenceLevel, 'influenced');
  assert.equal(result.confidenceScore, 0.6);
});

test('orders before delivery, outside the window, or with contrary evidence remain Unattributed', () => {
  const before = classifyCampaignOrder({ order: { ...order, paidAt: '2026-08-20T11:59:00Z' }, touch });
  const late = classifyCampaignOrder({ order: { ...order, paidAt: '2026-09-20T14:00:00Z' }, touch });
  const contrary = classifyCampaignOrder({ order, touch, contradictoryEvidence: ['another_channel_owned_conversion'] });
  assert.equal(before.confidenceLevel, 'unattributed');
  assert.equal(late.confidenceLevel, 'unattributed');
  assert.equal(contrary.confidenceLevel, 'unattributed');
});

test('missing or conflicting workspace identity fails closed', () => {
  const missing = classifyCampaignOrder({
    order: { ...order, workspaceID: undefined },
    touch: { ...touch, workspaceID: undefined }
  });
  const conflict = classifyCampaignOrder({ order, touch: { ...touch, workspaceID: 'other' } });
  assert.equal(missing.confidenceLevel, 'unattributed');
  assert.ok(missing.supportingEvidence.codes.includes('workspace_id_missing'));
  assert.equal(conflict.confidenceLevel, 'unattributed');
  assert.ok(conflict.supportingEvidence.codes.includes('workspace_id_conflict'));
});

test('staff and test identities are marked for exclusion rather than revenue aggregation', () => {
  const result = classifyCampaignOrder({ order, touch, internalOrTestIdentity: true });
  assert.equal(result.confidenceLevel, 'unattributed');
  assert.equal(result.excluded, true);
  assert.equal(result.exclusionReason, 'internal_or_test_identity');
});

test('guest customer ID zero never joins two customers; normalized phone may match instead', () => {
  assert.deepEqual(matchRecipientToOrder(
    { customerID: 0, phone: '3055550123' },
    { customerID: 0, phone: '+13055550123' }
  ), { matched: true, method: 'phone', reason: null });
  assert.equal(matchRecipientToOrder(
    { customerID: 0, phone: '3055550123' },
    { customerID: 0, phone: '+13055559999' }
  ).matched, false);
  assert.deepEqual(matchRecipientToOrder(
    { customerID: 44, phone: '3055550123' },
    { customerID: 45, phone: '+13055550123' }
  ), { matched: false, method: null, reason: 'customer_id_conflict' });
});

test('parent target accepts its variation, while a variation target stays exact', () => {
  assert.equal(matchTargetProducts([{ productID: 101 }], [{ productID: 101, variationID: 202 }]).matched, true);
  assert.equal(matchTargetProducts([{ productID: 101, variationID: 203 }], [{ productID: 101, variationID: 202 }]).matched, false);
  assert.equal(matchTargetProducts([{ sku: 'SAME-NAME' }], [{ sku: 'SAME-NAME' }]).matched, false);
});

test('partial refunds reduce net revenue while full refunds invalidate the effective claim', () => {
  const classified = classifyCampaignOrder({ order, touch });
  const partial = reconcileCampaignAttribution(classified, { ...order, refundedAmount: 20 });
  assert.equal(partial.netAmount, 100);
  assert.equal(partial.invalidated, false);
  assert.equal(partial.reconciliationReason, 'partial_refund_reconciled');

  const full = reconcileCampaignAttribution(classified, { ...order, status: 'refunded', refundedAmount: 120 }, {
    now: '2026-08-22T12:00:00Z'
  });
  assert.equal(full.netAmount, 0);
  assert.equal(full.invalidated, true);
  assert.equal(full.effectiveConfidenceLevel, 'unattributed');
  assert.equal(full.invalidatedAt, '2026-08-22T12:00:00.000Z');
});

test('one deterministic winner prevents payment, campaign and call double counting', () => {
  const campaign = classifyCampaignOrder({ order, touch });
  const payment = {
    ...campaign,
    sourceType: 'payment_recovery',
    category: 'payment_recovery',
    actionID: 'reminder-1',
    supportingEvidence: { codes: ['exact_payment_reminder'] }
  };
  const call = { ...campaign, sourceType: 'call', actionID: 'call-1' };
  const result = chooseAttributionWinner([call, campaign, payment]);
  assert.equal(result.winner.sourceType, 'payment_recovery');
  assert.equal(result.displaced.length, 2);
});

test('higher confidence wins before workflow precedence and invalidated candidates cannot win', () => {
  const strongPayment = {
    workspaceID: 'vici', orderID: 'order-1', confidenceLevel: 'strong', netAmount: 120,
    sourceType: 'payment_recovery', actionID: 'payment', supportingEvidence: { codes: ['exact_payment_reminder'] }
  };
  const directCampaign = {
    workspaceID: 'vici', orderID: 'order-1', confidenceLevel: 'direct', netAmount: 120,
    sourceType: 'campaign', actionID: 'campaign', supportingEvidence: { codes: ['verified_recipient_order_link'] }
  };
  assert.equal(chooseAttributionWinner([strongPayment, directCampaign]).winner.actionID, 'campaign');
  assert.equal(chooseAttributionWinner([{ ...directCampaign, invalidated: true }, strongPayment]).winner.actionID, 'payment');
});

test('winner rejects candidates from more than one order', () => {
  assert.throws(() => chooseAttributionWinner([
    { workspaceID: 'vici', orderID: 'one', confidenceLevel: 'strong', netAmount: 1 },
    { workspaceID: 'vici', orderID: 'two', confidenceLevel: 'strong', netAmount: 1 }
  ]), /exactly one order/);
  assert.throws(() => chooseAttributionWinner([
    { workspaceID: 'vici', orderID: 'one', confidenceLevel: 'strong', netAmount: 1 },
    { workspaceID: 'other', orderID: 'one', confidenceLevel: 'strong', netAmount: 1 }
  ]), /exactly one workspace/);
});

test('campaign metrics deduplicate recipients/orders and distinguish acceptance from trusted delivery', () => {
  const strong = classifyCampaignOrder({ order, touch });
  const performance = summariseCampaignPerformance({
    campaignID: 'campaign-1',
    recipients: [
      { id: 'recipient-1', state: 'delivered', sentAt: '2026-08-20T12:00:00Z', deliveredAt: '2026-08-20T12:01:00Z', deliveryTrusted: true, repliedAt: '2026-08-20T13:00:00Z', replyTrusted: true },
      { id: 'recipient-1', state: 'delivered', deliveredAt: '2026-08-20T12:01:00Z', deliveryTrusted: true },
      { id: 'recipient-2', state: 'sent', sentAt: '2026-08-20T12:00:00Z', deliveryTrusted: false },
      { id: 'recipient-3', state: 'suppressed', optedOutAt: '2026-08-20T12:00:00Z', optOutTrusted: true }
    ],
    attributions: [strong, { ...strong, sourceType: 'call', actionID: 'call-duplicate' }]
  });
  assert.equal(performance.recipients, 3);
  assert.equal(performance.providerAccepted, 2);
  assert.equal(performance.delivered, 1);
  assert.equal(performance.skipped, 1);
  assert.equal(performance.replies, 1);
  assert.equal(performance.optOuts, 1);
  assert.equal(performance.revenueImpactOrders, 1);
  assert.equal(performance.attributedOrders, 1);
  assert.equal(performance.influencedOrders, 0);
  assert.deepEqual(performance.ordersByConfidence, { direct: 0, strong: 1, influenced: 0 });
  assert.equal(performance.convertedRecipients, 1);
  assert.equal(performance.conversionRate, 1);
  assert.deepEqual(performance.revenue, {
    direct: 0, strong: 120, influenced: 0, attributed: 120, totalImpact: 120
  });
});

test('campaign metrics count revenue only when that campaign wins the order', () => {
  const campaign = classifyCampaignOrder({ order, touch });
  const payment = {
    ...campaign,
    sourceType: 'payment_recovery',
    category: 'payment_recovery',
    confidenceLevel: 'direct',
    supportingEvidence: { exactOrderMatch: true, paymentConfirmationMessageID: 'reply-1' }
  };
  const performance = summariseCampaignPerformance({
    campaignID: 'campaign-1',
    recipients: [{ id: 'recipient-1', deliveredAt: touch.deliveredAt, deliveryTrusted: true }],
    attributions: [campaign, payment]
  });
  assert.equal(performance.attributedOrders, 0);
  assert.equal(performance.revenue.totalImpact, 0);
  assert.throws(() => summariseCampaignPerformance({ recipients: [] }), /campaignID is required/);
});

test('invalid central windows fail closed', () => {
  assert.equal(resolveWindow('manual', { manual: { strongSeconds: 100, maximumSeconds: 99 } }), null);
  const result = classifyCampaignOrder({
    order,
    touch,
    windowsByWorkflow: { back_in_stock: { strongSeconds: 100, maximumSeconds: 99 } }
  });
  assert.equal(result.confidenceLevel, 'unattributed');
  assert.ok(result.supportingEvidence.codes.includes('attribution_window_invalid'));
});
