'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  aggregateCalls,
  applyAttributionFilters,
  aggregateMessaging,
  aggregatePaymentRecovery,
  aggregateRevenue,
  aggregateSentiment,
  availabilityFor,
  AnalyticsNotReadyError,
  decimalToCents,
  evidenceCodes,
  fetchPaged,
  isMissingAnalyticsSchema,
  publicAttribution,
  sourceCoverage
} = require('../lib/analytics/aggregate');

function attribution(overrides = {}) {
  return {
    id: 'a-1',
    order_id: '100',
    gross_amount: '219.00',
    refunded_amount: '0.00',
    net_amount: '219.00',
    category: 'payment_recovery',
    confidence_level: 'direct',
    confidence_score: '1.00',
    conversion_at: '2026-08-20T12:00:00.000Z',
    invalidated_at: null,
    ...overrides
  };
}

test('revenue aggregation uses exact decimal strings and separates confidence levels', () => {
  const result = aggregateRevenue([
    attribution(),
    attribution({ id: 'a-2', order_id: '101', net_amount: '100.01', gross_amount: '110.01', refunded_amount: '10.00', confidence_level: 'strong' }),
    attribution({ id: 'a-3', order_id: '102', net_amount: '50.05', gross_amount: '50.05', confidence_level: 'influenced', category: 'reorder' }),
    attribution({ id: 'a-4', order_id: '103', net_amount: '999.99', gross_amount: '999.99', confidence_level: 'unattributed', category: null })
  ]);
  assert.equal(result.recoveredRevenue, '319.01');
  assert.equal(result.attributedRevenue, '319.01');
  assert.equal(result.influencedRevenue, '50.05');
  assert.equal(result.totalRevenueImpact, '369.06');
  assert.equal(result.refundedAttributedRevenue, '10.00');
  assert.equal(result.unattributedRevenue, '999.99');
  assert.equal(result.breakdown.direct.confidenceScore, '1.00');
  assert.equal(result.breakdown.unattributed.orderCount, 1);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('non-recovery direct revenue is attributed but not mislabeled as recovered', () => {
  const result = aggregateRevenue([
    attribution({ category: 'product_enquiry', net_amount: '400.00', gross_amount: '400.00' })
  ]);
  assert.equal(result.recoveredRevenue, '0.00');
  assert.equal(result.attributedRevenue, '400.00');
});

test('duplicate orders, invalidations, refunds and malformed amounts do not inflate revenue', () => {
  const result = aggregateRevenue([
    attribution({ net_amount: '199.00', gross_amount: '219.00', refunded_amount: '20.00' }),
    attribution({ id: 'duplicate', net_amount: '199.00', gross_amount: '219.00', refunded_amount: '20.00' }),
    attribution({ id: 'a-2', order_id: '101', net_amount: '500.00', gross_amount: '500.00', invalidated_at: '2026-08-20T13:00:00Z' }),
    attribution({ id: 'a-3', order_id: '102', net_amount: 'not-money', gross_amount: 'not-money' })
  ]);
  assert.equal(result.recoveredRevenue, '199.00');
  assert.equal(result.refundedAttributedRevenue, '20.00');
  assert.equal(result.breakdown.direct.orderCount, 2);
  assert.equal(decimalToCents('90071992547409.91'), 9007199254740991n);
});

test('fully refunded attribution nets to zero while preserving the refund adjustment', () => {
  const result = aggregateRevenue([
    attribution({
      gross_amount: '219.00', refunded_amount: '219.00', net_amount: '0.00',
      is_refunded: true, invalidated_at: '2026-08-21T12:00:00Z'
    }),
    attribution({ id: 'bad', order_id: '101', gross_amount: '-10.00', net_amount: '-10.00' })
  ]);
  assert.equal(result.attributedRevenue, '0.00');
  assert.equal(result.grossAttributedRevenue, '219.00');
  assert.equal(result.refundedAttributedRevenue, '219.00');
});

test('payment recovery only counts genuine delivered Telnyx reminders', () => {
  const messages = [
    { telnyx_message_id: 'tel-1', status: 'delivered', ghl_message_id: null },
    { telnyx_message_id: 'ghl-1', status: 'delivered', ghl_message_id: 'ghl-1' }
  ];
  const reminders = [
    { id: 1, order_id: '100', phone: '+15550000001', flow_type: 'hold-msg1', telnyx_message_id: 'tel-1', message_body: 'Reminder' },
    { id: 2, order_id: '101', phone: '+15550000002', flow_type: 'hold-msg1', telnyx_message_id: 'ghl-1', message_body: 'Reminder' },
    { id: 3, order_id: '102', phone: '+15550000003', flow_type: 'hold-msg1', telnyx_message_id: 'tel-3', message_body: 'BACKFILL DRY RUN' }
  ];
  const result = aggregatePaymentRecovery([attribution()], reminders, messages);
  assert.equal(result.remindersSent, 2);
  assert.equal(result.remindersDelivered, 1);
  assert.equal(result.uniqueCustomersReminded, 2);
  assert.equal(result.ordersRecovered, 1);
  assert.equal(result.recoveryRate, 100);
});

test('messaging delivery excludes GHL mirror claims and response time excludes automation', () => {
  const messages = [
    { id: 1, telnyx_message_id: 'in-1', contact_phone: '+15550000001', direction: 'inbound', body: 'Help', status: 'delivered', created_at: '2026-08-20T12:00:00Z' },
    { id: 2, telnyx_message_id: 'auto-1', contact_phone: '+15550000001', direction: 'outbound', body: 'Automated', status: 'delivered', created_at: '2026-08-20T12:01:00Z' },
    { id: 3, telnyx_message_id: 'staff-1', contact_phone: '+15550000001', direction: 'outbound', body: 'Reply', status: 'delivered', created_at: '2026-08-20T12:03:00Z' },
    { id: 4, telnyx_message_id: 'ghl-1', ghl_message_id: 'ghl-1', contact_phone: '+15550000002', direction: 'outbound', body: 'CRM', status: 'delivered', created_at: '2026-08-20T12:04:00Z' }
  ];
  const result = aggregateMessaging(messages, [{ telnyx_message_id: 'auto-1' }]);
  assert.equal(result.metrics.delivered, 2);
  assert.equal(result.metrics.outbound, 3);
  assert.equal(result.metrics.replyRate, 0);
  assert.equal(result.responsePerformance.medianFirstResponseSeconds, 180);
  assert.equal(result.responsePerformance.answeredConversations, 1);
});

test('reply rate only counts a customer inbound that follows an outbound', () => {
  const result = aggregateMessaging([
    { id: 1, contact_phone: '+15550000001', direction: 'inbound', created_at: '2026-08-20T12:00:00Z' },
    { id: 2, contact_phone: '+15550000001', direction: 'outbound', created_at: '2026-08-20T12:01:00Z' },
    { id: 3, contact_phone: '+15550000002', direction: 'outbound', created_at: '2026-08-20T12:00:00Z' },
    { id: 4, contact_phone: '+15550000002', direction: 'inbound', created_at: '2026-08-20T12:02:00Z' }
  ], []);
  assert.equal(result.metrics.uniqueCustomersContacted, 2);
  assert.equal(result.metrics.repliesReceived, 2);
  assert.equal(result.metrics.replyRate, 50);
});

test('empty and malformed source rows produce honest nullable metrics', () => {
  const messages = aggregateMessaging([
    { id: 1, direction: 'sideways', created_at: 'not-a-date' }
  ], []);
  const calls = aggregateCalls([{ id: 1, status: 'completed', duration_seconds: 'invalid' }]);
  const sentiment = aggregateSentiment([{ id: 1, message_id: 'm', score: 99 }], 0);
  assert.equal(messages.metrics.total, 1);
  assert.equal(messages.responsePerformance.medianFirstResponseSeconds, null);
  assert.equal(calls.averageDurationSeconds, 0);
  assert.equal(sentiment.averageScore, null);
  assert.equal(sentiment.coveragePercentage, null);
});

test('calling metrics hide the internal SIP transfer leg and deduplicate provider retries', () => {
  const calls = [
    { id: 1, call_control_id: 'real-1', direction: 'inbound', contact_phone: '+15550000001', from_number: '+15550000001', to_number: '+15550000002', status: 'completed', duration_seconds: 42, answered_at: '2026-08-20T12:00:05Z' },
    { id: 2, call_control_id: 'real-1', direction: 'inbound', contact_phone: '+15550000001', status: 'completed', duration_seconds: 42 },
    { id: 3, call_control_id: 'sip-leg', direction: 'outbound', contact_phone: 'sip:user@example.com', to_number: 'sip:user@example.com', status: 'failed', duration_seconds: 0 }
  ];
  const result = aggregateCalls(calls);
  assert.equal(result.total, 1);
  assert.equal(result.completed, 1);
  assert.equal(result.totalTalkSeconds, 42);
  assert.equal(result.answerRate, 100);
});

test('sentiment reports distribution and coverage without raw message content', () => {
  const result = aggregateSentiment([
    { id: 1, message_id: '1', classifier_version: 'v1', score: -1 },
    { id: 2, message_id: '2', classifier_version: 'v1', score: 1 },
    { id: 3, message_id: '3', classifier_version: 'v1', score: 2 }
  ], 6);
  assert.equal(result.label, 'Happy');
  assert.equal(result.averageScore, 0.67);
  assert.equal(result.positivePercentage, 66.7);
  assert.equal(result.coveragePercentage, 50);
});

test('large in-memory aggregate remains deterministic and bounded by supplied rows', () => {
  const rows = Array.from({ length: 10000 }, (_, index) => attribution({
    id: `a-${index}`,
    order_id: String(index),
    net_amount: '0.01',
    gross_amount: '0.01'
  }));
  const result = aggregateRevenue(rows);
  assert.equal(result.recoveredRevenue, '100.00');
  assert.equal(result.breakdown.direct.orderCount, 10000);
});

test('source reads page explicitly and stop after the final partial page', async () => {
  const allRows = Array.from({ length: 2501 }, (_, id) => ({ id }));
  const ranges = [];
  const client = {
    from() {
      let selectedRange = [0, 999];
      const query = {
        select() { return query; },
        gte() { return query; },
        lt() { return query; },
        order() { return query; },
        range(from, to) { selectedRange = [from, to]; ranges.push(selectedRange); return query; },
        then(resolve) {
          const [from, to] = selectedRange;
          resolve({ data: allRows.slice(from, to + 1), error: null });
        }
      };
      return query;
    }
  };
  const result = await fetchPaged(client, {
    table: 'safe_source', columns: 'id', timeColumn: 'created_at',
    start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-02-01T00:00:00Z'), maxRows: 5000
  });
  assert.equal(result.rows.length, 2501);
  assert.equal(result.truncated, false);
  assert.deepEqual(ranges, [[0, 999], [1000, 1999], [2000, 2999]]);
});

test('missing analytics source schema fails unavailable instead of returning an empty dashboard', async () => {
  const query = {
    select() { return this; }, gte() { return this; }, lt() { return this; },
    order() { return this; }, range() { return this; },
    then(resolve) { resolve({ data: null, error: { code: '42P01', message: 'relation does not exist' } }); }
  };
  await assert.rejects(() => fetchPaged({ from: () => query }, {
    table: 'message_sentiment', columns: 'id', timeColumn: 'occurred_at',
    start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-02-01T00:00:00Z')
  }), AnalyticsNotReadyError);
});

test('migration detection does not disguise permissions failures as missing schema', () => {
  assert.equal(isMissingAnalyticsSchema({ code: '42P01', message: 'missing relation' }), true);
  assert.equal(isMissingAnalyticsSchema({ message: "Could not find revenue_attributions in the schema cache" }), true);
  assert.equal(isMissingAnalyticsSchema({ code: '42501', message: 'permission denied for table revenue_attributions' }), false);
});

test('source coverage warns for partial history and marks wholly pre-history ranges unavailable', () => {
  const floors = { messaging: '2026-04-29', paymentRecovery: '2026-05-27', calls: '2026-06-11' };
  const before = sourceCoverage({
    start: new Date('2026-01-01T00:00:00Z'),
    end: new Date('2026-02-01T00:00:00Z')
  }, floors);
  assert.deepEqual(before.availability, { messaging: false, paymentRecovery: false, calls: false });
  assert.ok(before.warnings.every(warning => warning.code.startsWith('NO_')));

  const crossing = sourceCoverage({
    start: new Date('2026-04-01T00:00:00Z'),
    end: new Date('2026-07-01T00:00:00Z')
  }, floors);
  assert.deepEqual(crossing.availability, { messaging: true, paymentRecovery: true, calls: true });
  assert.ok(crossing.warnings.every(warning => warning.code.startsWith('PARTIAL_')));
});

test('revenue cards remain unavailable until a complete historical run is promoted', () => {
  const source = { attributions: [attribution()], reminders: [] };
  const current = { sentiment: { messagesAnalyzed: 1 } };
  const coverage = { messaging: true, paymentRecovery: true, calls: true };
  const pending = availabilityFor(source, current, false, coverage);
  assert.equal(pending.revenueAttribution, false);
  assert.equal(pending.paymentRecovery, false);
  assert.equal(pending.messaging, true);
  const complete = availabilityFor(source, current, true, coverage);
  assert.equal(complete.revenueAttribution, true);
  assert.equal(complete.paymentRecovery, true);
});

test('attribution detail scope defaults to Direct plus Strong before pagination results are returned', () => {
  const operations = [];
  const query = {
    eq(column, value) { operations.push(['eq', column, value]); return this; },
    in(column, values) { operations.push(['in', column, values]); return this; },
    is(column, value) { operations.push(['is', column, value]); return this; }
  };
  applyAttributionFilters(query, {});
  assert.deepEqual(operations, [
    ['is', 'invalidated_at', null],
    ['in', 'confidence_level', ['direct', 'strong']]
  ]);
  operations.length = 0;
  applyAttributionFilters(query, { confidence: 'unattributed', scope: 'attributed', includeInvalidated: true });
  assert.deepEqual(operations, [['eq', 'confidence_level', 'unattributed']]);
});

test('detail serialization exposes audit codes but not raw supporting evidence', () => {
  const row = attribution({
    supporting_evidence: {
      authoritativePayment: true,
      exactOrderMatch: true,
      reminderLogID: '55',
      paymentConfirmationMessageID: 'secret-message-id',
      rawText: 'do not expose this'
    },
    reason: 'Structured evidence supports attribution.'
  });
  const item = publicAttribution(row);
  assert.deepEqual(item.supportingEvidence, [
    'authoritative_payment', 'exact_order_match', 'payment_reminder', 'payment_confirmation'
  ]);
  assert.equal(JSON.stringify(item).includes('do not expose this'), false);
  assert.deepEqual(evidenceCodes(null), []);
});
