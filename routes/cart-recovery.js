'use strict';

const express = require('express');
const { verifySignature } = require('../lib/cart-recovery/security');

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

function analytics(service) {
  const router = express.Router();
  router.get('/', async (_req, res) => {
    try {
      const live = process.env.CART_RECOVERY_ENABLED === 'true' && process.env.SMS_DRY_RUN === 'false' && process.env.LUKO_CART_PROVIDER_APPROVED === 'true';
      res.json({ mode: live ? 'live' : 'dry_run', metrics: await service.metrics() });
    } catch (error) {
      const notReady = ['42P01', 'PGRST202', 'PGRST204', 'PGRST205'].includes(error.code);
      res.status(notReady ? 503 : 500).json({ error: notReady ? 'Cart recovery migration is not applied.' : 'Cart recovery metrics unavailable.' });
    }
  });
  return router;
}

module.exports = analytics;
module.exports.analytics = analytics;
module.exports.connectorEvents = connectorEvents;
