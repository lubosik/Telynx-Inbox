'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  aggregateCalls,
  aggregatePeriod,
  applyAttributionFilters,
  aggregateMessaging,
  aggregatePaymentRecovery,
  aggregateRevenue,
  aggregateRevenueDrivers,
  aggregateSentiment,
  availabilityFor,
  AnalyticsNotReadyError,
  decimalToCents,
  evidenceCodes,
  fetchCampaignAttributions,
  fetchPaged,
  filterCampaignAttributions,
  isMissingAnalyticsSchema,
  publicAttribution,
  publicAttributionExplanation,
  publicCampaignAttribution,
  sentimentChange,
  sourceCoverage
} = require('../lib/analytics/aggregate');

test('campaign revenue availability is derived from the versioned policy migration', () => {
  const source = fs.readFileSync(require.resolve('../lib/analytics/aggregate'), 'utf8');
  assert.match(source, /CAMPAIGN_ATTRIBUTION_GENERATION_UNAVAILABLE/);
  assert.match(source, /campaignAttributionGenerationReady/);
  assert.match(source, /revenueAttribution: generationReady/);
});

function campaignAttributionClient(sourceRows, forcedError = null) {
  return {
    from(table) {
      assert.equal(table, 'revenue_attributions');
      const filters = {};
      return {
        select(columns) { filters.columns = columns; return this; },
        eq(column, value) { filters[column] = value; return this; },
        is(column, value) { filters[`is:${column}`] = value; return this; },
        in(column, values) { filters[`in:${column}`] = values; return this; },
        order() { return this; },
        async range(from, to) {
          if (forcedError) return { data: null, error: forcedError };
          let rows = sourceRows.filter(row => row.workspace_id === filters.workspace_id);
          if (filters.campaign_id !== undefined) rows = rows.filter(row => row.campaign_id === filters.campaign_id);
          if (Object.hasOwn(filters, 'is:campaign_id')) rows = rows.filter(row => row.campaign_id === filters['is:campaign_id']);
          if (filters['in:originating_action_id']) {
            rows = rows.filter(row => filters['in:originating_action_id'].includes(row.originating_action_id));
          }
          return { data: rows.slice(from, to + 1), error: null };
        }
      };
    }
  };
}

function emptyAnalyticsSource(overrides = {}) {
  return {
    messages: [], reminders: [], calls: [], attributions: [],
    recoveryAttributions: [], sentiments: [],
    ...overrides
  };
}

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

test('global revenue drivers show only real classified categories and keep confidence separate', () => {
  const drivers = aggregateRevenueDrivers([
    attribution(),
    attribution({ id: 'manual', order_id: '101', category: 'manual', confidence_level: 'influenced', net_amount: '50.00', gross_amount: '50.00' }),
    attribution({ id: 'reorder', order_id: '102', category: 'reorder_personal', confidence_level: 'strong', net_amount: '80.00', gross_amount: '100.00', refunded_amount: '20.00' }),
    attribution({ id: 'restock', order_id: '103', category: 'back_in_stock', confidence_level: 'direct', net_amount: '40.00', gross_amount: '40.00' }),
    attribution({ id: 'unknown', order_id: '104', category: 'product_enquiry', net_amount: '999.00', gross_amount: '999.00' })
  ]);
  assert.deepEqual(drivers.map(item => item.key), ['paymentRecovery', 'campaigns', 'reorders', 'backInStock']);
  assert.equal(drivers.find(item => item.key === 'campaigns').attributedRevenue, '0.00');
  assert.equal(drivers.find(item => item.key === 'campaigns').influencedRevenue, '50.00');
  assert.equal(drivers.find(item => item.key === 'reorders').attributedRevenue, '80.00');
  assert.equal(drivers.find(item => item.key === 'reorders').refundedRevenue, '20.00');
  assert.equal(drivers.some(item => item.label === 'product_enquiry'), false);
});

test('global revenue driver rollup stays empty when no real driver rows exist', () => {
  assert.deepEqual(aggregateRevenueDrivers([]), []);
  assert.deepEqual(aggregateRevenueDrivers([
    attribution({ category: null, confidence_level: 'unattributed' })
  ]), []);
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

test('All Time sentiment has no comparison instead of dereferencing a missing previous period', () => {
  const current = { sentiment: { averageScore: 0.38 } };
  assert.equal(sentimentChange(current, null), null);
  assert.equal(sentimentChange(current, { sentiment: { averageScore: 0.2 } }), 0.18);
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

test('activity series uses hourly zero-filled buckets for Today', () => {
  const range = {
    start: new Date('2026-08-22T00:00:00.000Z'),
    end: new Date('2026-08-22T05:30:00.000Z')
  };
  const result = aggregatePeriod(emptyAnalyticsSource({ messages: [
    { id: 'm1', contact_phone: '+15550000001', direction: 'outbound', created_at: '2026-08-22T02:15:00.000Z' }
  ] }), range, 'UTC');
  assert.equal(result.activityGranularity, 'hour');
  assert.equal(result.activitySeries.length, 6);
  assert.equal(result.activitySeries[2].date, '2026-08-22T02');
  assert.equal(result.activitySeries[2].bucketStart, '2026-08-22T02:00:00.000Z');
  assert.equal(result.activitySeries[2].outboundMessages, 1);
  assert.equal(result.activitySeries[1].outboundMessages, 0);
});

test('activity series adapts long ranges without emitting one label bucket per day', () => {
  const weekly = aggregatePeriod(emptyAnalyticsSource(), {
    start: new Date('2026-01-01T00:00:00.000Z'),
    end: new Date('2026-04-01T00:00:00.000Z')
  }, 'UTC');
  assert.equal(weekly.activityGranularity, 'week');
  assert.ok(weekly.activitySeries.length >= 13 && weekly.activitySeries.length <= 14);

  const monthly = aggregatePeriod(emptyAnalyticsSource(), {
    start: new Date('2026-01-01T00:00:00.000Z'),
    end: new Date('2027-01-01T00:00:00.000Z')
  }, 'UTC');
  assert.equal(monthly.activityGranularity, 'month');
  assert.equal(monthly.activitySeries.length, 12);
  assert.deepEqual(monthly.activitySeries.map(point => point.date).slice(0, 2), ['2026-01', '2026-02']);
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

test('campaign attribution filtering separates Direct, Strong, Influenced and Unattributed', () => {
  const rows = [
    attribution({ id: 'd', confidence_level: 'direct' }),
    attribution({ id: 's', order_id: '101', confidence_level: 'strong' }),
    attribution({ id: 'i', order_id: '102', confidence_level: 'influenced' }),
    attribution({ id: 'u', order_id: '103', confidence_level: 'unattributed' }),
    attribution({ id: 'x', order_id: '104', confidence_level: 'direct', invalidated_at: '2026-08-21T00:00:00Z' })
  ];
  assert.deepEqual(filterCampaignAttributions(rows, {}).map(row => row.id), ['d', 's']);
  assert.deepEqual(filterCampaignAttributions(rows, { scope: 'influenced' }).map(row => row.id), ['i']);
  assert.deepEqual(filterCampaignAttributions(rows, { confidence: 'unattributed' }).map(row => row.id), ['u']);
  assert.deepEqual(filterCampaignAttributions(rows, { scope: 'all', includeInvalidated: true }).map(row => row.id), ['d', 's', 'i', 'u', 'x']);
});

test('campaign source reads authoritative campaign links before merging legacy action matches', async () => {
  const rows = [
    { id: 'explicit', workspace_id: 'vici', campaign_id: 'c1', campaign_recipient_id: 'r1', originating_action_id: 'not-a-recipient-action' },
    { id: 'legacy', workspace_id: 'vici', campaign_id: null, originating_action_id: 'provider-m1' },
    { id: 'other', workspace_id: 'vici', campaign_id: 'c2', originating_action_id: 'provider-m1' }
  ];
  const result = await fetchCampaignAttributions(
    campaignAttributionClient(rows), 'c1',
    [{ id: 'r1', provider_message_id: 'provider-m1' }], 'vici'
  );
  assert.deepEqual(result.rows.map(row => row.id), ['explicit', 'legacy']);
  assert.equal(result.truncated, false);
});

test('missing campaign attribution link columns fail not-ready instead of omitting revenue', async () => {
  await assert.rejects(
    fetchCampaignAttributions(
      campaignAttributionClient([], { code: 'PGRST204', message: "Could not find the 'campaign_id' column" }),
      'c1', [], 'vici'
    ),
    error => error?.code === 'CAMPAIGNS_NOT_READY'
  );
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
  assert.equal(item.reason, 'An app interaction and authoritative payment confirmation directly link this order.');
  assert.deepEqual(evidenceCodes(null), []);
  assert.deepEqual(evidenceCodes({
    codes: ['trusted_provider_delivery', 'exact_target_product', 'raw_customer_body']
  }), ['trusted_provider_delivery', 'exact_target_product']);
});

test('public attribution explanations never expose free-text database reasons', () => {
  const secret = 'Customer wrote private medical details and phone +15551234567';
  const item = publicAttribution(attribution({
    confidence_level: 'influenced',
    reason: secret,
    supporting_evidence: { codes: ['trusted_provider_delivery'], rawText: secret }
  }));
  assert.equal(item.reason,
    'The app interaction occurred before the purchase, but the available evidence cannot prove it caused the order.');
  assert.equal(JSON.stringify(item).includes(secret), false);
  assert.match(publicAttributionExplanation('unattributed', ['outside_attribution_window']), /outside the approved attribution window/i);
});

test('campaign drill-down keeps customer PII and raw message evidence out of the response', () => {
  const item = publicCampaignAttribution(attribution({
    customer_id: 'customer-private-17',
    supporting_evidence: {
      codes: ['trusted_provider_delivery', 'raw_customer_body'],
      rawText: 'private customer reply',
      contactPhone: '+15551234567'
    }
  }), 'campaign-1');
  const serialized = JSON.stringify(item);
  assert.equal(item.campaignId, 'campaign-1');
  assert.equal('customerId' in item, false);
  assert.equal('recipientId' in item, false);
  assert.equal(serialized.includes('customer-private-17'), false);
  assert.equal(serialized.includes('private customer reply'), false);
  assert.equal(serialized.includes('+15551234567'), false);
  assert.equal(serialized.includes('private customer reply'), false);
  assert.deepEqual(item.supportingEvidence, ['trusted_provider_delivery']);
});
