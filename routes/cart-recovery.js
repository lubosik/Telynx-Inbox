'use strict';

const express = require('express');
const { verifySignature } = require('../lib/cart-recovery/security');
const { logAuditSafely } = require('../lib/audit/log');
const { presentError } = require('../lib/user-facing-errors');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sendError(res, error, action) {
  const notReady = ['42P01', '42703', 'PGRST202', 'PGRST204', 'PGRST205'].includes(error?.code);
  if (notReady) return res.status(503).json({ error: 'Cart recovery Growth migration is not applied.' });
  const presented = presentError(error, { action });
  return res.status(presented.status).json(presented.body);
}

function id(value) {
  if (!UUID.test(String(value || ''))) {
    throw Object.assign(new Error('That cart recovery journey could not be found.'), {
      code: 'CART_RECOVERY_NOT_FOUND', status: 404
    });
  }
  return String(value).toLowerCase();
}

function noStore(res) { res.set('Cache-Control', 'no-store, private'); }

function mode(env) {
  return env.CART_RECOVERY_ENABLED === 'true' && env.SMS_DRY_RUN === 'false'
    && env.LUKO_CART_PROVIDER_APPROVED === 'true' ? 'live' : 'dry_run';
}

async function auditCartRecovery(input, writer = logAuditSafely) {
  return writer === logAuditSafely ? logAuditSafely(input) : writer(input);
}

function connectorEvents(service, { env = process.env } = {}) {
  const router = express.Router();
  router.post('/', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const timestamp = req.get('X-LUKO-Timestamp');
    const signature = req.get('X-LUKO-Signature');
    if (!verifySignature(raw, timestamp, signature, env.LUKO_WP_SIGNING_SECRET)) {
      return res.status(401).json({ error: 'Invalid connector signature.' });
    }
    let event;
    try { event = JSON.parse(raw.toString('utf8')); }
    catch { return res.status(400).json({ error: 'Invalid JSON.' }); }
    try {
      const result = await service.processEvent(event);
      return res.status(202).json(result);
    } catch (error) {
      const status = Number(error.status) || (error.code === 'INVALID_CART_EVENT' ? 400 : 503);
      console.error('[CART RECOVERY] Connector event rejected:', error.code || 'persistence_error');
      return res.status(status).json({ error: status === 400 ? 'Invalid connector event.' : 'Connector temporarily unavailable.' });
    }
  });
  return router;
}

function analytics(service, { env = process.env, audit = logAuditSafely } = {}) {
  const router = express.Router();
  router.get('/', async (req, res) => {
    try {
      noStore(res);
      const result = typeof service.dashboard === 'function'
        ? await service.dashboard({ actor: req.actor })
        : { metrics: await service.metrics() };
      res.json({ ...(result || {}), mode: mode(env) });
    } catch (error) {
      sendError(res, error, 'loading cart recovery analytics');
    }
  });

  router.get('/journeys', async (req, res) => {
    try {
      noStore(res);
      return res.json(await service.listJourneys({ query: req.query || {}, actor: req.actor }));
    } catch (error) { return sendError(res, error, 'loading abandoned-cart journeys'); }
  });

  router.get('/journeys/:id', async (req, res) => {
    try {
      noStore(res);
      return res.json(await service.getJourney({ id: id(req.params.id), actor: req.actor }));
    } catch (error) { return sendError(res, error, 'loading this abandoned-cart journey'); }
  });

  router.get('/settings', async (req, res) => {
    try {
      noStore(res);
      return res.json(await service.getSettings({ actor: req.actor }));
    } catch (error) { return sendError(res, error, 'loading abandoned-cart automation settings'); }
  });

  router.put('/settings', async (req, res) => {
    try {
      noStore(res);
      const result = await service.updateSettings({ input: req.body || {}, actor: req.actor });
      await auditCartRecovery({
        eventType: 'cart_recovery.settings_changed', req,
        summary: 'Changed abandoned-cart recovery automation settings',
        metadata: { automation: 'abandoned_cart_recovery' }
      }, audit);
      return res.json(result);
    } catch (error) { return sendError(res, error, 'changing abandoned-cart automation settings'); }
  });

  router.patch('/journeys/:id/replies/:replyId/draft', async (req, res) => {
    try {
      noStore(res);
      const journeyId = id(req.params.id);
      const replyId = id(req.params.replyId);
      const result = await service.updateReplyDraft({ journeyId, replyId, input: req.body || {}, actor: req.actor });
      await auditCartRecovery({
        eventType: 'cart_recovery.reply_draft_edited', req, entityId: journeyId,
        summary: 'Edited an abandoned-cart reply draft',
        metadata: { automation: 'abandoned_cart_recovery', reply_id: replyId }
      }, audit);
      return res.json(result);
    } catch (error) { return sendError(res, error, 'editing this reply draft'); }
  });

  router.post('/journeys/:id/replies/:replyId/approve', async (req, res) => {
    try {
      noStore(res);
      const journeyId = id(req.params.id);
      const replyId = id(req.params.replyId);
      const result = await service.approveReplyDraft({ journeyId, replyId, input: req.body || {}, actor: req.actor });
      await auditCartRecovery({
        eventType: 'cart_recovery.reply_draft_approved', req, entityId: journeyId,
        summary: result?.dryRun ? 'Approved an abandoned-cart reply draft in dry-run' : 'Approved and sent an abandoned-cart reply',
        metadata: { automation: 'abandoned_cart_recovery', reply_id: replyId, dry_run: result?.dryRun === true }
      }, audit);
      return res.json(result);
    } catch (error) { return sendError(res, error, 'approving this reply draft'); }
  });

  router.post('/journeys/:id/replies/:replyId/discard', async (req, res) => {
    try {
      noStore(res);
      const journeyId = id(req.params.id);
      const replyId = id(req.params.replyId);
      const result = await service.discardReplyDraft({ journeyId, replyId, input: req.body || {}, actor: req.actor });
      await auditCartRecovery({
        eventType: 'cart_recovery.reply_draft_discarded', req, entityId: journeyId,
        summary: 'Discarded an abandoned-cart reply draft',
        metadata: { automation: 'abandoned_cart_recovery', reply_id: replyId }
      }, audit);
      return res.json(result);
    } catch (error) { return sendError(res, error, 'discarding this reply draft'); }
  });

  return router;
}

module.exports = analytics;
module.exports.analytics = analytics;
module.exports.connectorEvents = connectorEvents;
