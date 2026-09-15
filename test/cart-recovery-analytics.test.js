'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCartRecoveryAnalyticsService } = require('../lib/cart-recovery/analytics');

function analyticsClient(payload) {
  const calls = [];
  const client = {
    from(table) {
      assert.equal(table, 'analytics_attribution_rules');
      const query = {
        select() { return query; },
        eq() { return query; },
        async maybeSingle() {
          return { data: { business_timezone: 'America/New_York', currency: 'USD' }, error: null };
        }
      };
      return query;
    },
    async rpc(name, args) {
      calls.push({ name, args });
      return { data: payload, error: null };
    }
  };
  return { client, calls };
}

test('cart recovery Analytics uses paid-date quarter bounds and preserves persisted zero metrics', async () => {
  const payload = {
    metrics: { recoveredRevenue: 0, recoveredOrders: 0, abandonedCarts: 3, recoveryRate: 0,
      recoveryRateNumerator: 0, recoveryRateDenominator: 3, smsSent: 0, smsDelivered: 0,
      recoveryLinkClicks: 0, pushSent: 0, pushClicks: 0, discountRecoveries: 0,
      averageRecoveredOrderValue: null, currency: 'USD', mixedCurrencies: false },
    funnel: [{ key: 'abandoned', label: 'Abandoned carts', count: 3 }],
    revenueByMethod: [], orders: [], pagination: { page: 1, pageSize: 25, total: 0, hasMore: false }
  };
  const { client, calls } = analyticsClient(payload);
  const service = createCartRecoveryAnalyticsService({
    client,
    now: () => new Date('2026-08-20T15:30:00.000Z')
  });
  const result = await service.overview({ period: 'quarter' });
  assert.equal(calls[0].name, 'luko_cart_recovery_analytics');
  assert.equal(calls[0].args.p_start, '2026-07-01T04:00:00.000Z');
  assert.equal(calls[0].args.p_end, '2026-08-20T15:30:00.000Z');
  assert.equal(result.metrics.abandonedCarts, 3);
  assert.equal(result.metrics.recoveredOrders, 0);
  assert.deepEqual(result.orders, []);
});

test('cart recovery Analytics supports inclusive custom dates and warns instead of adding currencies', async () => {
  const payload = {
    metrics: { recoveredRevenue: null, mixedCurrencies: true },
    funnel: [], revenueByMethod: [], orders: [], pagination: { page: 2, pageSize: 10, total: 0, hasMore: false }
  };
  const { client, calls } = analyticsClient(payload);
  const service = createCartRecoveryAnalyticsService({ client });
  const result = await service.overview({
    period: 'custom', start: '2026-03-07', end: '2026-03-09', page: 2, pageSize: 10
  });
  assert.equal(calls[0].args.p_start, '2026-03-07T05:00:00.000Z');
  assert.equal(calls[0].args.p_end, '2026-03-10T04:00:00.000Z');
  assert.equal(calls[0].args.p_page, 2);
  assert.equal(result.warnings[0].code, 'MULTIPLE_CART_RECOVERY_CURRENCIES');
});
