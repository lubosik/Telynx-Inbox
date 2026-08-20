'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  analyseHistoricalRevenue,
  persistenceAllowed,
  persistRecords,
  renderReport,
  samePersistencePayload
} = require('../scripts/backfill-analytics');
const {
  prepareSentimentCandidates,
  persistenceAllowed: sentimentPersistenceAllowed
} = require('../scripts/backfill-sentiment');

function order(id, paidAt, overrides = {}) {
  return {
    id,
    customer_id: Number(id),
    status: 'processing',
    total: '100.00',
    currency: 'USD',
    date_paid_gmt: paidAt,
    billing: { phone: '+15550000001' },
    refunds: [],
    meta_data: [],
    ...overrides
  };
}

function reminder(orderID, sentAt, overrides = {}) {
  return {
    id: `log-${orderID}`,
    order_id: String(orderID),
    flow_type: 'hold-msg1',
    phone: '+15550000001',
    message_body: 'Payment reminder',
    telnyx_message_id: `telnyx-${orderID}`,
    sent_at: sentAt,
    ...overrides
  };
}

function delivered(orderID) {
  return {
    id: `provider-${orderID}`,
    telnyx_message_id: `telnyx-${orderID}`,
    status: 'delivered',
    direction: 'outbound',
    contact_phone: '+15550000001',
    body: 'Payment reminder',
    created_at: '2026-08-01T10:00:00.000Z'
  };
}

test('historical analysis classifies direct and strong once per exact paid order', () => {
  const orders = [
    order(101, '2026-08-01T10:30:00.000Z'),
    order(102, '2026-08-01T11:00:00.000Z')
  ];
  const sentLogs = [
    reminder(101, '2026-08-01T10:00:00.000Z'),
    reminder(102, '2026-08-01T10:10:00.000Z')
  ];
  const messages = [
    delivered(101),
    delivered(102),
    { id: 99, direction: 'inbound', contact_phone: '+15550000001', body: 'Just sent it, thanks', created_at: '2026-08-01T10:20:00.000Z' }
  ];
  const analysis = analyseHistoricalRevenue({ orders, sentLogs, messages });
  assert.equal(analysis.aggregate.counts.direct, 1);
  assert.equal(analysis.aggregate.counts.strong, 1);
  assert.equal(analysis.aggregate.net_amounts.direct, 100);
  assert.equal(analysis.publicCandidates.length, 2);
  assert.equal('contact_phone' in analysis.publicCandidates[0], false);
  assert.equal(JSON.stringify(analysis.publicCandidates).includes('Just sent'), false);
});

test('historical analysis rejects weak and contaminated evidence as Unattributed', () => {
  const orders = [
    order(201, '2026-08-01T10:30:00.000Z'),
    order(202, '2026-08-01T10:30:00.000Z'),
    order(203, '2026-08-01T10:30:00.000Z'),
    order(204, '2026-08-03T12:00:00.000Z'),
    order(205, '2026-08-01T09:00:00.000Z'),
    order(206, '2026-08-01T10:30:00.000Z', { refunds: [{ total: '-10.00' }] }),
    order(207, '2026-08-01T10:30:00.000Z', { meta_data: [{ key: '_analytics_test', value: 'yes' }] })
  ];
  const sentLogs = [
    reminder(201, '2026-08-01T10:00:00.000Z', { message_body: 'BACKFILL SKIPPED' }),
    reminder(202, '2026-08-01T10:00:00.000Z', { phone: '+15550000999' }),
    reminder(203, '2026-08-01T10:00:00.000Z', { message_body: 'Let us lock both orders in' }),
    reminder(204, '2026-08-01T10:00:00.000Z'),
    reminder(205, '2026-08-01T10:00:00.000Z'),
    reminder(206, '2026-08-01T10:00:00.000Z'),
    reminder(207, '2026-08-01T10:00:00.000Z')
  ];
  const messages = orders.map(item => delivered(item.id));
  const analysis = analyseHistoricalRevenue({ orders, sentLogs, messages });
  assert.equal(analysis.aggregate.counts.unattributed, 7);
  assert.equal(analysis.aggregate.counts.influenced, 0);
  assert.match(analysis.records.find(item => item.orderID === '205').reason, /before the delivered reminder/);
  assert.match(analysis.records.find(item => item.orderID === '206').reason, /refund activity/);
});

test('ordinary paid orders without an exact reminder get a truthful explanation', () => {
  const analysis = analyseHistoricalRevenue({
    orders: [order(208, '2026-08-01T10:30:00.000Z')],
    sentLogs: [],
    messages: []
  });
  assert.equal(analysis.records[0].confidenceLevel, 'unattributed');
  assert.match(analysis.records[0].reason, /No genuine payment reminder for this exact order/);
  assert.doesNotMatch(analysis.records[0].reason, /customer does not match/i);
});

test('historical output deduplicates a repeated authoritative order ID', () => {
  const duplicate = order(301, '2026-08-01T10:30:00.000Z');
  const analysis = analyseHistoricalRevenue({
    orders: [duplicate, { ...duplicate }],
    sentLogs: [reminder(301, '2026-08-01T10:00:00.000Z')],
    messages: [delivered(301)]
  });
  assert.equal(analysis.records.length, 1);
  assert.equal(analysis.records[0].confidenceLevel, 'unattributed');
});

test('revenue backfill persistence requires both independent gates', () => {
  assert.equal(persistenceAllowed({ persist: false }, { ANALYTICS_BACKFILL_APPROVED: 'YES' }), false);
  assert.equal(persistenceAllowed({ persist: true }, {}), false);
  assert.equal(persistenceAllowed({ persist: true }, { ANALYTICS_BACKFILL_APPROVED: 'yes' }), false);
  assert.equal(persistenceAllowed({ persist: true }, { ANALYTICS_BACKFILL_APPROVED: 'YES' }), true);
});

test('persistence comparison is stable across database decimals, timestamp formats and evidence key order', () => {
  const left = {
    gross_amount: '100.0', refunded_amount: 0, net_amount: '100.00', confidence_score: 0.9,
    action_at: '2026-08-01T10:00:00+00:00', conversion_at: '2026-08-01T10:15:00Z',
    invalidated_at: null, supporting_evidence: { exactOrderMatch: true, authoritativePayment: true }
  };
  const right = {
    gross_amount: '100.00', refunded_amount: '0.00', net_amount: 100, confidence_score: '0.90',
    action_at: '2026-08-01T10:00:00.000Z', conversion_at: '2026-08-01T10:15:00.000Z',
    invalidated_at: null, supporting_evidence: { authoritativePayment: true, exactOrderMatch: true }
  };
  assert.equal(samePersistencePayload(left, right), true);
});

test('historical persistence stages truthfully and uses only atomic live-safe promotion', () => {
  const source = persistRecords.toString();
  assert.match(source, /review_status: 'rule_accepted'/);
  assert.match(source, /rpc\('promote_analytics_backfill'/);
  assert.doesNotMatch(source, /from\('revenue_attributions'\)/);
  assert.doesNotMatch(source, /review_status: 'approved'/);
  assert.match(source, /\.in\('status', \['running', 'staged'\]\)/);
});

test('GHL mirror delivery claims cannot make a reminder attributable', () => {
  const analysis = analyseHistoricalRevenue({
    orders: [order(401, '2026-08-01T10:30:00.000Z')],
    sentLogs: [reminder(401, '2026-08-01T10:00:00.000Z')],
    messages: [{ ...delivered(401), ghl_message_id: 'ghl-provider-row' }]
  });
  assert.equal(analysis.records[0].confidenceLevel, 'unattributed');
});

test('candidate report is aggregate-only and labels values provisional', () => {
  const report = renderReport({
    woo_orders_examined: 2,
    paid_orders_examined: 1,
    counts: { direct: 1, strong: 0, influenced: 0, unattributed: 0 },
    net_amounts: { direct: 100, strong: 0, influenced: 0, unattributed: 0 }
  });
  assert.match(report, /candidate-only, provisional/);
  assert.doesNotMatch(report, /\+1555/);
});

test('sentiment dry run includes inbound text only and emits no bodies', () => {
  const analysis = prepareSentimentCandidates([
    { id: 1, direction: 'inbound', contact_phone: '+15550000001', body: 'Thank you so much', created_at: '2026-08-01T10:00:00Z' },
    { id: 2, direction: 'outbound', contact_phone: '+15550000001', body: 'Thank you so much', created_at: '2026-08-01T10:01:00Z' },
    { id: 3, direction: 'inbound', contact_phone: '+15550000001', body: '', media_urls: ['https://example.invalid/image'], created_at: '2026-08-01T10:02:00Z' },
    { id: 4, direction: 'inbound', contact_phone: '+15550000001', body: 'Thanks, but this issue is terrible', created_at: '2026-08-01T10:03:00Z' },
    { id: 5, direction: 'inbound', contact_phone: '+15550000009', body: 'Awful', created_at: '2026-08-01T10:04:00Z' }
  ], { excludedPhones: new Set(['+15550000009']) });
  assert.equal(analysis.candidates.length, 1);
  assert.equal(analysis.aggregate.distribution.very_positive, 1);
  assert.equal(analysis.aggregate.excluded.non_inbound, 1);
  assert.equal(analysis.aggregate.excluded.empty_or_tapback, 1);
  assert.equal(analysis.aggregate.excluded.ambiguous, 1);
  assert.equal(analysis.aggregate.excluded.internal_or_test, 1);
  assert.equal('body' in analysis.candidates[0], false);
  assert.equal(JSON.stringify(analysis.aggregate).includes('Thank you'), false);
});

test('sentiment persistence requires both independent gates', () => {
  assert.equal(sentimentPersistenceAllowed({ persist: false }, { ANALYTICS_BACKFILL_APPROVED: 'YES' }), false);
  assert.equal(sentimentPersistenceAllowed({ persist: true }, {}), false);
  assert.equal(sentimentPersistenceAllowed({ persist: true }, { ANALYTICS_BACKFILL_APPROVED: 'YES' }), true);
});
