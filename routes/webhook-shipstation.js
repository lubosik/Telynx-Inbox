'use strict';
/**
 * routes/webhook-shipstation.js
 *
 * Thin router wrapper — all logic lives in flows/shipped.js
 *
 * SHIP_NOTIFY stores the shipment record only (no SMS).
 * pollForCarrierScans() runs every 30 min and sends SMS when carrier scans.
 * checkAndSendDeliverySMS() runs every 6 hours for legacy delivery follow-ups.
 */

const { fetchResourceUrl } = require('../shipstation');
const {
  handleShipNotify,
  pollForCarrierScans,
  checkAndSendDeliverySMS
} = require('../flows/shipped');

module.exports = (broadcastSSE) => {
  const router = require('express').Router();

  router.post('/shipstation', async (req, res) => {
    const secret = req.query.secret;
    if (process.env.SS_WEBHOOK_SECRET && secret !== process.env.SS_WEBHOOK_SECRET) {
      console.warn('[SHIPSTATION] Invalid webhook secret');
      return res.sendStatus(401);
    }

    res.sendStatus(200);

    try {
      const { resource_url, resource_type } = req.body;
      console.log(`[SHIPSTATION] Webhook: ${resource_type}`);

      if (!['SHIP_NOTIFY', 'ITEM_SHIP_NOTIFY', 'FULFILLMENT_SHIPPED'].includes(resource_type)) {
        console.log(`[SHIPSTATION] Ignoring event: ${resource_type}`);
        return;
      }
      if (!resource_url) return;

      const data      = await fetchResourceUrl(resource_url);
      const shipments = data.shipments
        ? data.shipments
        : (data.shipmentId ? [data] : []);

      console.log(`[SHIPSTATION] Processing ${shipments.length} shipment(s)`);
      for (const shipment of shipments) {
        await handleShipNotify(shipment);
      }
    } catch (err) {
      console.error('[SHIPSTATION] Webhook error:', err.message);
    }
  });

  return router;
};

// Export for server.js cron
module.exports.pollForCarrierScans     = pollForCarrierScans;
module.exports.checkAndSendDeliverySMS = checkAndSendDeliverySMS;
