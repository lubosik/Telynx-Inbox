'use strict';

const { rangeForPeriod } = require('../analytics/date-ranges');

class CartRecoveryAnalyticsNotReadyError extends Error {
  constructor() {
    super('Abandoned-cart Analytics is not ready.');
    this.code = 'CART_RECOVERY_ANALYTICS_NOT_READY';
  }
}

function publicRange(range) {
  return {
    period: range.period,
    start: range.start.toISOString(),
    end: range.end.toISOString(),
    timeZone: range.timeZone,
    previous: range.previous ? {
      start: range.previous.start.toISOString(),
      end: range.previous.end.toISOString()
    } : null
  };
}

function createCartRecoveryAnalyticsService({ client, workspace = 'vici', now = () => new Date(), reliableFrom = '2026-01-16' } = {}) {
  if (!client) throw new TypeError('Analytics client is required.');
  return {
    async overview(params = {}) {
      const { data: rules, error: rulesError } = await client.from('analytics_attribution_rules')
        .select('business_timezone,currency').eq('workspace_id', workspace).maybeSingle();
      if (rulesError || !rules) throw new CartRecoveryAnalyticsNotReadyError();
      const range = rangeForPeriod({
        period: params.period || 'month',
        customStart: params.start,
        customEnd: params.end,
        now: now(),
        timeZone: rules.business_timezone,
        reliableFrom
      });
      const page = Math.max(1, Math.floor(Number(params.page) || 1));
      const pageSize = Math.min(100, Math.max(1, Math.floor(Number(params.pageSize) || 25)));
      const { data, error } = await client.rpc('luko_cart_recovery_analytics', {
        p_workspace: workspace,
        p_start: range.start.toISOString(),
        p_end: range.end.toISOString(),
        p_page: page,
        p_page_size: pageSize
      });
      if (error || !data) throw new CartRecoveryAnalyticsNotReadyError();
      return {
        generatedAt: now().toISOString(),
        range: publicRange(range),
        metrics: data.metrics || {},
        funnel: Array.isArray(data.funnel) ? data.funnel : [],
        revenueByMethod: Array.isArray(data.revenueByMethod) ? data.revenueByMethod : [],
        orders: Array.isArray(data.orders) ? data.orders : [],
        pagination: data.pagination || { page, pageSize, total: 0, hasMore: false },
        warnings: data.metrics?.mixedCurrencies === true ? [{
          code: 'MULTIPLE_CART_RECOVERY_CURRENCIES',
          message: 'Recovered orders span multiple currencies, so a combined revenue total is not shown.'
        }] : []
      };
    }
  };
}

module.exports = { CartRecoveryAnalyticsNotReadyError, createCartRecoveryAnalyticsService, publicRange };
