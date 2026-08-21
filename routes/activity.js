'use strict';
/**
 * routes/activity.js — the scheduled-SMS QUEUE monitor.
 *
 * NAME COLLISION, READ THIS BEFORE YOU GO LOOKING FOR THE AUDIT TRAIL
 *   This file is not the Activity Center. It backs `/api/activity/*`, which the
 *   iOS tab labelled "Automations" calls to read the pending queue, the recent
 *   send log, and to cancel a single queued message. It reads sms_scheduled and
 *   sms_sent_log.
 *
 *   The Activity Center audit trail is a different subsystem: `/api/audit`,
 *   backed by `routes/audit.js` and the append-only `sms_audit_log` table.
 *
 *   These routes are NOT being renamed this release. The iOS binary already in
 *   the field calls `/api/activity/*` by that exact path, and renaming it would
 *   break every installed copy for the sake of tidiness.
 */
const router    = require('express').Router();
const { supabase } = require('../db');
const { selectIn } = require('../lib/fetch-all-rows');
const { broadcast } = require('../lib/broadcaster');
const { logAudit } = require('../lib/audit/log');
const { messageFingerprint } = require('../lib/audit/redact');

// GET /api/activity/stats
router.get('/stats', async (req, res) => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayISO = todayStart.toISOString();

  try {
    const [pending, sentToday, failedToday, cancelledToday] = await Promise.all([
      supabase.from('sms_scheduled').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('sms_sent_log').select('id', { count: 'exact', head: true }).gte('sent_at', todayISO),
      // updated_at absent — use send_at as proxy: messages that were due today and failed
      supabase.from('sms_scheduled').select('id', { count: 'exact', head: true }).eq('status', 'failed').gte('send_at', todayISO),
      // cancelled today: items created today that were cancelled
      supabase.from('sms_scheduled').select('id', { count: 'exact', head: true }).eq('status', 'cancelled').gte('created_at', todayISO),
    ]);

    res.json({
      pending:         pending.count        || 0,
      sentToday:       sentToday.count      || 0,
      failedToday:     failedToday.count    || 0,
      cancelledToday:  cancelledToday.count || 0,
      updatedAt:       new Date().toISOString()
    });
  } catch (err) {
    console.error('[ACTIVITY] stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/activity/queue?flow=&page=1
router.get('/queue', async (req, res) => {
  const { flow, page = 1 } = req.query;
  const limit  = 50;
  const offset = (parseInt(page) - 1) * limit;

  try {
    let query = supabase
      .from('sms_scheduled')
      .select('id, order_id, phone, flow_type, message_body, send_at, status, created_at')
      .eq('status', 'pending')
      .order('send_at', { ascending: true })
      .range(offset, offset + limit - 1);

    if (flow && flow !== 'all') query = query.eq('flow_type', flow);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const enriched = await enrichWithNames(data || []);
    res.json({ items: enriched, page: parseInt(page), hasMore: (data?.length || 0) === limit });
  } catch (err) {
    console.error('[ACTIVITY] queue error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/activity/recent?flow=&page=1
router.get('/recent', async (req, res) => {
  const { flow, page = 1 } = req.query;
  const limit  = 50;
  const offset = (parseInt(page) - 1) * limit;

  try {
    let query = supabase
      .from('sms_sent_log')
      .select('id, order_id, flow_type, phone, message_body, telnyx_message_id, sent_at')
      .order('sent_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (flow && flow !== 'all') query = query.eq('flow_type', flow);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const enriched = await enrichWithNames(data || []);
    res.json({ items: enriched, page: parseInt(page), hasMore: (data?.length || 0) === limit });
  } catch (err) {
    console.error('[ACTIVITY] recent error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/activity/queue/:id — cancel a single pending message
router.delete('/queue/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const { data: row } = await supabase
      .from('sms_scheduled')
      .select('id, order_id, phone, flow_type, message_body, send_at')
      .eq('id', id)
      .eq('status', 'pending')
      .maybeSingle();

    if (!row) return res.status(404).json({ error: 'Message not found or already cancelled' });

    const { error } = await supabase
      .from('sms_scheduled')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .eq('status', 'pending');

    if (error) return res.status(500).json({ error: error.message });

    console.log(`[ACTIVITY] Cancelled | id=${id} flow=${row.flow_type} order=${row.order_id} phone=...${row.phone?.slice(-4)}`);

    // Audit — the flagship case. One Admin cancels an automation; another Admin
    // has to be able to see who did it, when, and what it looked like before.
    // The SELECT above already fetched the full prior row, so this is the exact
    // pre-change state rather than a reconstruction.
    //
    // message_body is deliberately absent from both snapshots. Its length and
    // sha256 digest go into metadata instead, and sms_scheduled still holds the
    // text itself — see lib/audit/redact.js for why that split is the right one.
    const cancelSnapshot = {
      id: row.id,
      order_id: row.order_id,
      phone: row.phone,
      flow_type: row.flow_type,
      send_at: row.send_at,
      status: 'pending'
    };
    await logAudit({
      eventType: 'automation.queue_item.cancelled',
      req,
      entityId: row.id,
      contactPhone: row.phone,
      summary: `Cancelled the queued ${row.flow_type} message for order ${row.order_id || 'n/a'}`,
      previousState: cancelSnapshot,
      newState: { ...cancelSnapshot, status: 'cancelled' },
      changedFields: ['status'],
      metadata: {
        scheduled_id: row.id,
        order_id: row.order_id,
        flow_type: row.flow_type,
        send_at: row.send_at,
        reason: 'manual',
        ...messageFingerprint(row.message_body)
      }
    });

    broadcast({
      type:      'queue_cancelled',
      id:        row.id,
      order_id:  row.order_id,
      flow_type: row.flow_type,
      phone:     row.phone
    });

    res.json({ success: true, cancelled: row });
  } catch (err) {
    console.error('[ACTIVITY] cancel error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Enrich rows with contact name from sms_contacts
async function enrichWithNames(rows) {
  if (!rows.length) return rows;
  const phones = [...new Set(rows.map(r => r.phone).filter(Boolean))];
  if (!phones.length) return rows;
  // Chunked: see lib/fetch-all-rows.js — a long `.in()` list overflows the URL.
  let contacts = [];
  try {
    contacts = await selectIn(supabase, 'sms_contacts', 'phone, name', 'phone', phones);
  } catch (err) {
    console.warn('[ACTIVITY] Contact name lookup failed:', err.message);
  }
  const nameMap = {};
  (contacts || []).forEach(c => { nameMap[c.phone] = c.name; });
  return rows.map(r => ({ ...r, contact_name: nameMap[r.phone] || null }));
}

module.exports = router;
