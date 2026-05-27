'use strict';
/**
 * routes/admin.js — Protected admin endpoints
 *
 * POST /admin/backfill/failed  — send recovery SMS to historical failed orders
 * POST /admin/backfill/hold    — send final notice to currently on-hold orders
 *
 * Auth: Authorization: Bearer <INBOX_PASSWORD>
 * Both endpoints are idempotent (sms_sent_log dedup prevents double-sends).
 * Optional body: { "dryRun": true } to log without sending.
 */

const { backfillFailedOrders } = require('../flows/failed');
const { backfillOnHoldOrders } = require('../flows/hold');

function requireAdmin(req, res, next) {
  const auth     = req.headers['authorization'] || '';
  const password = process.env.INBOX_PASSWORD;
  if (!password) return next(); // no password set — allow (dev mode)
  const token = auth.replace('Bearer ', '').trim();
  if (token !== password) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  next();
}

module.exports = () => {
  const router = require('express').Router();

  router.post('/backfill/failed', requireAdmin, async (req, res) => {
    const dryRun = req.body?.dryRun === true;
    console.log(`[ADMIN] Starting failed-orders backfill | dryRun=${dryRun}`);
    res.json({ status: 'started', dryRun, message: 'Backfill running in background — check Railway logs' });

    // Run async after response
    setImmediate(async () => {
      try {
        const result = await backfillFailedOrders({ dryRun });
        console.log(`[ADMIN] Failed backfill complete | processed=${result.processed} skipped=${result.skipped}`);
      } catch (err) {
        console.error('[ADMIN] Failed backfill error:', err.message);
      }
    });
  });

  router.post('/backfill/hold', requireAdmin, async (req, res) => {
    const dryRun = req.body?.dryRun === true;
    console.log(`[ADMIN] Starting on-hold backfill | dryRun=${dryRun}`);
    res.json({ status: 'started', dryRun, message: 'Backfill running in background — check Railway logs' });

    setImmediate(async () => {
      try {
        const result = await backfillOnHoldOrders({ dryRun });
        console.log(`[ADMIN] Hold backfill complete | processed=${result.processed} skipped=${result.skipped}`);
      } catch (err) {
        console.error('[ADMIN] Hold backfill error:', err.message);
      }
    });
  });

  return router;
};
