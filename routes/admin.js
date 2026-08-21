'use strict';
/**
 * routes/admin.js — Protected admin endpoints
 *
 * POST /admin/backfill/failed      — send recovery SMS to historical failed orders
 * POST /admin/backfill/hold        — send final notice to currently on-hold orders
 * POST /admin/fix-old-statuses     — one-time corrective: mark old shipped orders as
 *                                    delivered, reset last_seen to actual order dates
 * POST /admin/backfill-recordings  — pull missing call recordings from Telnyx
 * POST /admin/release-notify       — tell registered iPhones a new build exists
 *
 * Auth: `Authorization: Bearer <ADMIN_API_TOKEN>`, falling back to
 * `INBOX_PASSWORD` while ADMIN_API_TOKEN is not yet set.
 *
 * THIS ROUTER FAILS CLOSED. It previously called next() when no password was
 * configured, on the reasoning that an unset password meant local development.
 * The consequence on Railway is the opposite of a development convenience:
 * renaming or clearing one variable would have turned every endpoint here —
 * each of which sends real SMS to real customers — fully public, with no error
 * and nothing in the logs to say so. No secret configured now means 503.
 *
 * These endpoints live off the cookie session on purpose: they are called by
 * machines (a GitHub Actions release workflow, a one-off curl) that have a
 * bearer token and no browser session.
 */
const { backfillFailedOrders } = require('../flows/failed');
const { backfillOnHoldOrders } = require('../flows/hold');
const { backfillRecordings } = require('../scripts/backfill-recordings');
const { supabase } = require('../db');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

let didLogSecretSource = false;

/**
 * The admin bearer token. `ADMIN_API_TOKEN` is the dedicated variable; the
 * inbox login password is accepted as a fallback so nothing breaks on the
 * deploy that introduces the split, and so the two can be rotated separately
 * afterwards. An operator's UI password should not also be a machine
 * credential sitting in a CI secret store.
 */
function adminSecret() {
  return process.env.ADMIN_API_TOKEN || process.env.INBOX_PASSWORD || '';
}

/**
 * Constant-time comparison. `!==` on strings returns as soon as two characters
 * differ, so the time it takes leaks how much of a guess was correct — enough,
 * over many attempts, to recover a token a character at a time. Hashing first
 * gives timingSafeEqual the equal-length inputs it requires (it throws
 * otherwise) without revealing the real secret's length.
 */
function secretsMatch(provided, expected) {
  if (typeof provided !== 'string' || !provided || !expected) return false;
  const a = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

/** Says once, at boot, which credential is actually in force. */
function logSecretSourceOnce() {
  if (didLogSecretSource) return;
  didLogSecretSource = true;
  if (process.env.ADMIN_API_TOKEN) {
    console.log('[ADMIN] authenticating with ADMIN_API_TOKEN');
  } else if (process.env.INBOX_PASSWORD) {
    console.warn('[ADMIN] ADMIN_API_TOKEN is not set — falling back to INBOX_PASSWORD. Set a dedicated ADMIN_API_TOKEN so the machine credential can be rotated without changing the inbox login.');
  } else {
    console.error('[ADMIN] no ADMIN_API_TOKEN or INBOX_PASSWORD configured — every admin endpoint will refuse with 503 until one is set.');
  }
}

function requireAdmin(req, res, next) {
  const expected = adminSecret();
  if (!expected) {
    // Deny, never allow. An unconfigured secret is a deployment fault, not a
    // grant of access, and these endpoints send SMS to real customers.
    console.error('[ADMIN] refused: no ADMIN_API_TOKEN or INBOX_PASSWORD configured');
    return res.status(503).json({ error: 'Admin API is not configured' });
  }

  const header = req.headers?.['authorization'] || '';
  const token = (header.startsWith('Bearer ') ? header.slice(7) : header).trim();
  if (!secretsMatch(token, expected)) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  next();
}

/**
 * A bearer token is guessable in a way a browser session is not, so cap the
 * guessing rate. Mounted on the router rather than in server.js because the
 * limit belongs to these endpoints, not to the app.
 */
const adminLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many admin requests' }
});

const BUILD_PATTERN = /^\d{1,9}$/;

/**
 * POST /admin/release-notify
 *
 * DRY RUN IS THE DEFAULT. Only an explicit `"dryRun": false` sends anything.
 * The cost of a mistaken dry run is a JSON list; the cost of a mistaken send is
 * a push notification on someone's phone that cannot be recalled.
 *
 * Body: { userId?, belowBuild?, title, body, dryRun? }
 */
function releaseNotifyHandler(deps = {}) {
  return async (req, res) => {
    const send = deps.sendReleaseNotification ||
      require('../lib/apns-notify').sendReleaseNotification;

    const payload = req.body || {};
    const dryRun = payload.dryRun !== false;

    const rawBuild = payload.belowBuild;
    let belowBuild = null;
    if (rawBuild !== undefined && rawBuild !== null && rawBuild !== '') {
      const text = String(rawBuild).trim();
      if (!BUILD_PATTERN.test(text)) {
        return res.status(400).json({ error: 'belowBuild must be a build number' });
      }
      belowBuild = Number(text);
    }

    const userId = typeof payload.userId === 'string' && payload.userId.trim()
      ? payload.userId.trim().slice(0, 64)
      : (Number.isInteger(payload.userId) ? String(payload.userId) : null);

    const title = typeof payload.title === 'string' ? payload.title.trim().slice(0, 120) : '';
    const body = typeof payload.body === 'string' ? payload.body.trim().slice(0, 500) : '';
    // A dry run answers "who would this reach", which is a useful question
    // before the copy is written. A real send needs the copy.
    if (!dryRun && (!title || !body)) {
      return res.status(400).json({ error: 'title and body are required to send' });
    }

    try {
      const result = await send({
        userId,
        belowBuild,
        title: title || 'Vici Inbox update',
        body: body || 'A new build is available.',
        collapseId: payload.collapseId,
        dryRun
      });
      if (result?.error) {
        return res.status(502).json({ error: result.error, code: 502 });
      }
      console.log(`[ADMIN] release-notify | dryRun=${dryRun} userId=${userId || 'any'} belowBuild=${belowBuild ?? 'any'} targeted=${result?.targeted ?? 0} sent=${result?.sent ?? 0}`);
      return res.json({ ok: true, dryRun, ...result });
    } catch (err) {
      console.error('[ADMIN] release-notify error:', err.message);
      return res.status(500).json({ error: err.message, code: 500 });
    }
  };
}

module.exports = (deps = {}) => {
  const router = require('express').Router();
  logSecretSourceOnce();
  router.use(adminLimiter);

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

  router.post('/backfill-recordings', requireAdmin, async (req, res) => {
    console.log('[ADMIN] Starting recording backfill from Telnyx API');
    try {
      const result = await backfillRecordings();
      console.log('[ADMIN] Recording backfill complete:', result);
      res.json({ status: 'done', ...result });
    } catch (err) {
      console.error('[ADMIN] Recording backfill error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/release-notify', requireAdmin, releaseNotifyHandler(deps));

  return router;
};

module.exports.requireAdmin = requireAdmin;
module.exports.releaseNotifyHandler = releaseNotifyHandler;
module.exports.secretsMatch = secretsMatch;
