'use strict';

const express = require('express');
const {
  AnalyticsNotReadyError,
  createAnalyticsService
} = require('../lib/analytics/aggregate');

const ALLOWED_PERIODS = new Set(['today', 'week', 'month', 'year', 'all', 'custom']);
const ALLOWED_CONFIDENCE = new Set(['direct', 'strong', 'influenced', 'unattributed']);
const ALLOWED_SCOPES = new Set(['attributed', 'influenced', 'unattributed', 'all']);
const SAFE_CATEGORY = /^[a-z][a-z0-9_]{0,63}$/;

class AnalyticsRequestError extends Error {}

function requestParams(query = {}) {
  const period = String(query.period || 'month').toLowerCase();
  if (!ALLOWED_PERIODS.has(period)) throw new AnalyticsRequestError('Unsupported analytics period.');
  if (period === 'custom' && (!query.start || !query.end)) {
    throw new AnalyticsRequestError('Custom analytics ranges require start and end dates.');
  }
  const confidence = query.confidence ? String(query.confidence).toLowerCase() : null;
  if (confidence && !ALLOWED_CONFIDENCE.has(confidence)) throw new AnalyticsRequestError('Unsupported attribution confidence.');
  const scope = query.scope ? String(query.scope).toLowerCase() : 'attributed';
  if (!ALLOWED_SCOPES.has(scope)) throw new AnalyticsRequestError('Unsupported attribution scope.');
  const category = query.category ? String(query.category).toLowerCase() : null;
  if (category && !SAFE_CATEGORY.test(category)) throw new AnalyticsRequestError('Invalid attribution category.');
  if (query.includeInvalidated !== undefined && !['true', 'false'].includes(String(query.includeInvalidated))) {
    throw new AnalyticsRequestError('includeInvalidated must be true or false.');
  }
  return {
    period,
    start: query.start,
    end: query.end,
    page: query.page,
    pageSize: query.pageSize,
    confidence,
    scope,
    category,
    includeInvalidated: String(query.includeInvalidated || 'false') === 'true'
  };
}

function campaignRequestParams(query = {}) {
  const params = requestParams({ ...query, period: 'all', start: undefined, end: undefined });
  return {
    page: params.page,
    pageSize: params.pageSize,
    confidence: params.confidence,
    scope: params.scope,
    includeInvalidated: params.includeInvalidated
  };
}

function sendError(res, error) {
  if (error instanceof AnalyticsRequestError || /analytics range|valid date|Custom start/i.test(error?.message || '')) {
    return res.status(400).json({ error: error.message, code: 'INVALID_ANALYTICS_REQUEST' });
  }
  if (error instanceof AnalyticsNotReadyError || error?.code === 'ANALYTICS_NOT_READY') {
    return res.status(503).json({
      error: 'Analytics is not available until its additive database migration is applied.',
      code: 'ANALYTICS_NOT_READY'
    });
  }
  if (error?.code === 'CAMPAIGNS_NOT_READY') {
    return res.status(503).json({
      error: 'Campaign analytics is not available until its additive database migration is applied.',
      code: 'CAMPAIGNS_NOT_READY'
    });
  }
  if (error?.code === 'CAMPAIGN_NOT_FOUND') {
    return res.status(404).json({ error: 'Campaign not found.', code: 'CAMPAIGN_NOT_FOUND' });
  }
  console.error('[ANALYTICS] Request failed:', error?.code || 'internal_error');
  return res.status(500).json({ error: 'Analytics could not be loaded.', code: 'ANALYTICS_LOAD_FAILED' });
}

function createAnalyticsRouter({ service } = {}) {
  const analyticsService = service || createAnalyticsService({ client: require('../db').supabase });
  const router = express.Router();

  router.get('/overview', async (req, res) => {
    try {
      const result = await analyticsService.overview(requestParams(req.query));
      res.set('Cache-Control', 'no-store, private');
      return res.json(result);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/attributions', async (req, res) => {
    try {
      const result = await analyticsService.attributions(requestParams(req.query));
      res.set('Cache-Control', 'no-store, private');
      return res.json(result);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/campaigns/:id', async (req, res) => {
    try {
      const result = await analyticsService.campaignOverview(req.params.id);
      res.set('Cache-Control', 'no-store, private');
      return res.json(result);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/campaigns/:id/attributions', async (req, res) => {
    try {
      const result = await analyticsService.campaignAttributions(req.params.id, campaignRequestParams(req.query));
      res.set('Cache-Control', 'no-store, private');
      return res.json(result);
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}

module.exports = createAnalyticsRouter;
module.exports.requestParams = requestParams;
module.exports.campaignRequestParams = campaignRequestParams;
module.exports.sendError = sendError;
