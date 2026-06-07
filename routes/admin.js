'use strict';
/**
 * routes/admin.js — Protected admin endpoints
 *
 * POST /admin/backfill/failed      — send recovery SMS to historical failed orders
 * POST /admin/backfill/hold        — send final notice to currently on-hold orders
 * POST /admin/fix-old-statuses     — one-time corrective: mark old shipped orders as
 *                                    delivered, reset last_seen to actual order dates
 *
 * Auth: Authorization: Bearer <INBOX_PASSWORD>
 * Backfill endpoints are idempotent (sms_sent_log dedup prevents double-sends).
 * Optional body: { "dryRun": true } to log without sending.
 */

const { backfillFailedOrders } = require('../flows/failed');
const { backfillOnHoldOrders } = require('../flows/hold');
const { supabase } = require('../db');

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

  // Corrective endpoint: fixes the damage from a sync that set last_seen=NOW() for all
  // contacts. Marks old shipped orders (>21 days) as delivered, then resets every
  // contact's last_seen to their most recent order's created_at so the list sorts
  // by genuine order recency rather than sync timestamp.
  router.post('/fix-old-statuses', requireAdmin, async (req, res) => {
    const { broadcast } = require('../lib/broadcaster');
    const DELIVERED_THRESHOLD_DAYS = 21;
    const threshold = new Date(Date.now() - DELIVERED_THRESHOLD_DAYS * 24 * 60 * 60 * 1000).toISOString();

    console.log(`[ADMIN] fix-old-statuses starting — threshold=${threshold}`);
    res.json({ status: 'started', message: 'Running in background — check Railway logs' });

    setImmediate(async () => {
      try {
        // Fetch ALL orders so we can compute per-contact max(created_at)
        const { data: allOrders, error: fetchErr } = await supabase
          .from('sms_orders')
          .select('woo_order_id, contact_phone, created_at, status');

        if (fetchErr) throw fetchErr;

        let markedDelivered = 0;

        // Step 1: change old 'shipped' orders → 'delivered'
        for (const o of allOrders) {
          if (o.status === 'shipped' && o.created_at < threshold) {
            await supabase.from('sms_orders')
              .update({ status: 'delivered' })
              .eq('woo_order_id', o.woo_order_id);
            o.status = 'delivered'; // reflect in local array for step 2
            markedDelivered++;
          }
        }

        // Step 2: for each contact, find their most recent order's created_at and
        // reset last_seen to that value (undoes the bulk NOW() from the previous sync)
        const contactBest = {}; // phone → { date, status }
        for (const o of allOrders) {
          if (!o.contact_phone) continue;
          const cur = contactBest[o.contact_phone];
          if (!cur || o.created_at > cur.date) {
            contactBest[o.contact_phone] = { date: o.created_at, status: o.status };
          }
        }

        let contactsFixed = 0;
        for (const [phone, { date, status }] of Object.entries(contactBest)) {
          await supabase.from('sms_contacts')
            .update({ last_seen: date })
            .eq('phone', phone);
          broadcast({ type: 'order_status_updated', phone, status, order_id: null });
          contactsFixed++;
        }

        console.log(`[ADMIN] fix-old-statuses done — markedDelivered=${markedDelivered} contactsFixed=${contactsFixed}`);
      } catch (err) {
        console.error('[ADMIN] fix-old-statuses error:', err.message);
      }
    });
  });

  return router;
};
