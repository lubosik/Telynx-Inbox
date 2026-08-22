'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  campaignAttributionRows,
  campaignFinancialMetrics,
  campaignMetricRecipients,
  campaignOperationalMetrics
} = require('../lib/campaigns/analytics');

const recipients = [
  { id: 'r1', selected: true, state: 'delivered', provider_message_id: 'm1', sent_at: '2026-08-20T12:00:00Z' },
  { id: 'r2', selected: true, state: 'sent', provider_message_id: 'm2', sent_at: '2026-08-20T12:01:00Z' },
  { id: 'r3', selected: true, state: 'suppressed' },
  { id: 'not-selected', selected: false, state: 'draft' }
];

const events = [
  { id: 1, recipient_id: 'r1', event_type: 'provider.delivered', occurred_at: '2026-08-20T12:02:00Z', trusted: true, provider: 'telnyx', provider_event_id: 'evt-1', trust_source: 'telnyx_ed25519_v2' },
  { id: 2, recipient_id: 'r2', event_type: 'provider.delivered', occurred_at: '2026-08-20T12:03:00Z', trusted: false, provider: 'telnyx', provider_event_id: 'evt-2', trust_source: 'telnyx_ed25519_v2' },
  { id: 3, recipient_id: 'r1', event_type: 'customer.replied', occurred_at: '2026-08-20T12:05:00Z', metadata: { trusted: true } },
  { id: 4, recipient_id: 'r1', event_type: 'recipient.opted_out', occurred_at: '2026-08-20T12:06:00Z', trusted: true },
  { id: 4, recipient_id: 'r1', event_type: 'recipient.opted_out', occurred_at: '2026-08-20T12:06:00Z', trusted: true }
];

function attribution(overrides = {}) {
  return {
    id: 'a1', order_id: 'o1', category: 'back_in_stock', originating_action_id: 'm1',
    gross_amount: '120.00', refunded_amount: '20.00', net_amount: '100.00',
    confidence_level: 'strong', action_at: '2026-08-20T12:02:00Z',
    conversion_at: '2026-08-20T13:00:00Z', attribution_window_seconds: 3480,
    supporting_evidence: { codes: ['trusted_provider_delivery', 'exact_target_product'] },
    invalidated_at: null,
    ...overrides
  };
}

test('operational metrics never call sent/provider acceptance delivered', () => {
  const metricRows = campaignMetricRecipients(recipients, events);
  assert.equal(metricRows.find(row => row.recipientID === 'r1').deliveryTrusted, true);
  assert.equal(metricRows.find(row => row.recipientID === 'r2').deliveryTrusted, false);
  const metrics = campaignOperationalMetrics(recipients, events);
  assert.equal(metrics.recipients, 3);
  assert.equal(metrics.providerAccepted, 2);
  assert.equal(metrics.delivered, 1);
  assert.equal(metrics.replies, 1);
  assert.equal(metrics.optOuts, 1);
  assert.equal(metrics.skipped, 1);
  assert.equal(metrics.providerAcceptanceIsDelivery, false);
  assert.equal(JSON.stringify(metrics).includes('phone'), false);
});

test('delivery requires the canonical signed provider event contract', () => {
  const variants = [
    { event_type: 'provider_delivered', trusted: true, provider: 'telnyx', provider_event_id: 'legacy', trust_source: 'telnyx_ed25519_v2' },
    { event_type: 'provider.delivered', trusted: true, provider: 'telnyx', provider_event_id: '', trust_source: 'telnyx_ed25519_v2' },
    { event_type: 'provider.delivered', trusted: true, provider: 'telnyx', provider_event_id: 'unsigned', trust_source: 'provider_api_response' },
    { event_type: 'provider.delivered', metadata: { trusted: true }, provider: 'telnyx', provider_event_id: 'metadata-only', trust_source: 'telnyx_ed25519_v2' }
  ].map((event, index) => ({ id: `unsafe-${index}`, recipient_id: 'r2', occurred_at: '2026-08-20T12:03:00Z', ...event }));
  assert.equal(campaignMetricRecipients(recipients, variants).find(row => row.recipientID === 'r2').deliveryTrusted, false);
});

test('campaign attribution accepts only the exact campaign action or explicit campaign evidence', () => {
  const rows = campaignAttributionRows({
    campaignID: 'c1', workspaceID: 'vici', recipients,
    attributions: [
      attribution(),
      attribution({ id: 'other-action', order_id: 'o2', originating_action_id: 'not-this-campaign' }),
      attribution({ id: 'payment', order_id: 'o3', category: 'payment_recovery', originating_action_id: 'm1' }),
      attribution({ id: 'explicit', order_id: 'o4', category: 'manual', originating_action_id: 'old-action', supporting_evidence: { campaignID: 'c1' } }),
      attribution({ id: 'explicit-column', order_id: 'o6', campaign_id: 'c1', campaign_recipient_id: 'r2', originating_action_id: 'unmatched-action' }),
      attribution({ id: 'other-campaign', order_id: 'o5', supporting_evidence: { campaignID: 'c2' } })
    ]
  });
  assert.deepEqual(rows.map(row => row.id), ['a1', 'explicit', 'explicit-column']);
  assert.equal(rows[0].campaignID, 'c1');
  assert.equal(rows[0].recipientID, 'r1');
  assert.equal(rows[2].recipientID, 'r2');
});

test('financial metrics separate confidence, refunds and influenced revenue', () => {
  const result = campaignFinancialMetrics({
    campaignID: 'c1', workspaceID: 'vici', recipients, events,
    attributions: [
      attribution(),
      attribution({ id: 'a2', order_id: 'o2', originating_action_id: 'm2', confidence_level: 'influenced', gross_amount: '50.00', refunded_amount: '0.00', net_amount: '50.00' }),
      attribution({ id: 'a3', order_id: 'o3', originating_action_id: 'm2', confidence_level: 'unattributed', gross_amount: '500.00', net_amount: '500.00' })
    ]
  });
  assert.equal(result.revenueImpactOrders, 2);
  assert.equal(result.attributedOrders, 1);
  assert.equal(result.influencedOrders, 1);
  assert.deepEqual(result.ordersByConfidence, { direct: 0, strong: 1, influenced: 1 });
  assert.deepEqual(result.revenue, {
    direct: '0.00', strong: '100.00', influenced: '50.00', attributed: '100.00', totalImpact: '150.00',
    gross: '170.00', refunded: '20.00', refundedOrders: 1
  });
  assert.equal(result.attributions.length, 3);
});

test('invalidated/full-refund rows and another workflow winner cannot inflate campaign totals', () => {
  const result = campaignFinancialMetrics({
    campaignID: 'c1', workspaceID: 'vici', recipients, events,
    attributions: [
      attribution({ invalidated_at: '2026-08-21T00:00:00Z', net_amount: '0.00', refunded_amount: '120.00' }),
      attribution({ id: 'payment', order_id: 'o2', category: 'payment_recovery', originating_action_id: 'm2', confidence_level: 'direct' })
    ]
  });
  assert.equal(result.revenueImpactOrders, 0);
  assert.equal(result.revenue.totalImpact, '0.00');
  assert.equal(result.revenue.refunded, '120.00');
});

test('campaign analytics requires explicit workspace and campaign boundaries', () => {
  assert.throws(() => campaignAttributionRows({ campaignID: 'c1' }), /campaignID and workspaceID/);
});
