const router = require('express').Router();
const { supabase } = require('../db');
const { runSync } = require('../sync-ghl');
const { runWooSync, syncOrderStatuses } = require('../sync-woocommerce');
const { logAuditSafely } = require('../lib/audit/log');

let syncRunning = false;
let lastSyncResult = null;

/**
 * Every sync route answers the client immediately and keeps working in the
 * background, so the outcome is audited when it lands rather than when it was
 * asked for. Two rows per run — triggered and completed/failed — is what makes
 * "the contact list changed overnight, who ran what?" answerable.
 *
 * Both helpers use logAuditSafely and are called only AFTER res.json() and only
 * from inside the try whose `finally` clears `syncRunning`. The previous shape
 * awaited the triggered row before responding and outside any try, so a single
 * failed audit insert threw past the `finally`: the caller got a 500 instead of
 * the acknowledgement the docstring promises, and `syncRunning` stayed true for
 * the entire life of the process. No sync of any kind could be triggered again
 * until Railway restarted the service. An audit write must never be able to
 * wedge the feature it describes.
 */
async function auditSyncStarted(req, syncType) {
  await logAuditSafely({
    eventType: 'settings.sync.triggered',
    req,
    entityId: syncType,
    summary: `Started the ${syncType} sync`,
    metadata: { sync_type: syncType, source: 'manual' }
  });
}

async function auditSyncFinished(req, syncType, startedAt, result, error) {
  const durationMS = Date.now() - startedAt;
  if (error) {
    await logAuditSafely({
      eventType: 'settings.sync.failed',
      req,
      entityId: syncType,
      summary: `The ${syncType} sync failed after ${durationMS}ms`,
      metadata: { sync_type: syncType, duration_ms: durationMS, error_code: error.code || 'unknown' }
    });
    return;
  }
  await logAuditSafely({
    eventType: 'settings.sync.completed',
    req,
    entityId: syncType,
    summary: `The ${syncType} sync finished in ${durationMS}ms`,
    metadata: {
      sync_type: syncType,
      duration_ms: durationMS,
      contacts_synced: result?.contacts ?? result?.synced ?? null,
      orders_synced: result?.orders ?? null,
      fixed: result?.fixed ?? null,
      skipped: result?.skipped ?? null
    }
  });
}

// Trigger GHL contact sync
router.post('/ghl', async (req, res) => {
  if (syncRunning) return res.json({ success: false, error: 'Sync already running' });
  syncRunning = true;
  const startedAt = Date.now();
  // Acknowledge first. The sync runs in the background, so nothing the
  // caller waits on depends on the audit row, and the audit call belongs
  // inside the try that owns the syncRunning latch.
  res.json({ success: true, message: 'GHL sync started' });
  try {
    await auditSyncStarted(req, 'ghl_contacts');
    lastSyncResult = await runSync();
    await auditSyncFinished(req, 'ghl_contacts', startedAt, lastSyncResult, null);
  } catch (err) {
    lastSyncResult = { success: false, error: err.message };
    await auditSyncFinished(req, 'ghl_contacts', startedAt, null, err);
  } finally {
    syncRunning = false;
  }
});

// Trigger WooCommerce orders + contacts backfill
router.post('/woocommerce', async (req, res) => {
  if (syncRunning) return res.json({ success: false, error: 'Sync already running' });
  syncRunning = true;
  const startedAt = Date.now();
  // Acknowledge first. The sync runs in the background, so nothing the
  // caller waits on depends on the audit row, and the audit call belongs
  // inside the try that owns the syncRunning latch.
  res.json({ success: true, message: 'WooCommerce sync started' });
  try {
    await auditSyncStarted(req, 'woocommerce_backfill');
    lastSyncResult = await runWooSync();
    console.log('WooCommerce sync complete:', lastSyncResult);
    await auditSyncFinished(req, 'woocommerce_backfill', startedAt, lastSyncResult, null);
  } catch (err) {
    console.error('WooCommerce sync error:', err.message);
    lastSyncResult = { success: false, error: err.message };
    await auditSyncFinished(req, 'woocommerce_backfill', startedAt, null, err);
  } finally {
    syncRunning = false;
  }
});

// Status-only sync: pulls current WC order statuses, updates DB, broadcasts SSE.
// Zero flow handlers. Zero SMS. Safe to run at any time.
router.post('/statuses', async (req, res) => {
  if (syncRunning) return res.json({ success: false, error: 'Sync already running' });
  syncRunning = true;
  const startedAt = Date.now();
  // Acknowledge first. The sync runs in the background, so nothing the
  // caller waits on depends on the audit row, and the audit call belongs
  // inside the try that owns the syncRunning latch.
  res.json({ success: true, message: 'Status sync started' });
  try {
    await auditSyncStarted(req, 'order_statuses');
    lastSyncResult = await syncOrderStatuses();
    console.log(`[STATUS-SYNC] Complete: fixed=${lastSyncResult.fixed} skipped=${lastSyncResult.skipped}`);
    await auditSyncFinished(req, 'order_statuses', startedAt, lastSyncResult, null);
  } catch (err) {
    console.error('[STATUS-SYNC] Error:', err.message);
    lastSyncResult = { success: false, error: err.message };
    await auditSyncFinished(req, 'order_statuses', startedAt, null, err);
  } finally {
    syncRunning = false;
  }
});

router.get('/status', (req, res) => {
  res.json({ running: syncRunning, last: lastSyncResult });
});

// Manual import
router.post('/import', async (req, res) => {
  const { contacts } = req.body;
  if (!Array.isArray(contacts)) return res.status(400).json({ error: 'contacts array required' });

  let imported = 0;
  for (const c of contacts) {
    if (!c.phone) continue;
    await supabase.from('sms_contacts').upsert({
      phone: c.phone,
      name: c.name || null,
      last_seen: new Date().toISOString()
    }, { onConflict: 'phone' });

    for (const m of (c.messages || [])) {
      await supabase.from('sms_messages').upsert({
        telnyx_message_id: `manual-${c.phone}-${m.created_at || Date.now()}`,
        contact_phone: c.phone,
        direction: m.direction || 'outbound',
        body: m.body,
        status: 'delivered',
        created_at: m.created_at || new Date().toISOString()
      }, { onConflict: 'telnyx_message_id' });
      imported++;
    }
  }

  // severity 'warning': a bulk import writes to sms_contacts and sms_messages
  // in one unreviewed pass, with no per-row confirmation and no undo. One
  // summary row, never one per contact.
  //
  // Safe-logged for the same reason as the sync routes: the rows are already
  // written by this point, and this handler has no try/catch, so a throw here
  // would leave the caller with an unanswered request for an import that in
  // fact succeeded.
  await logAuditSafely({
    eventType: 'contact.bulk_imported',
    req,
    entityId: `import:${new Date().toISOString()}`,
    summary: `Imported ${contacts.length} contact(s) and ${imported} message(s) via the manual import endpoint`,
    metadata: { source: 'manual_import', contact_count: contacts.length, message_count: imported }
  });

  res.json({ success: true, messages_imported: imported });
});

// Seed from old Telnyx bridge
router.post('/seed-from-bridge', async (req, res) => {
  try {
    const r = await fetch('https://telynx-ghl-production.up.railway.app/dashboard.json');
    if (!r.ok) return res.status(502).json({ error: 'Old bridge unreachable' });

    const data = await r.json();
    const messages = (data.messages || []).filter(m =>
      m.from && m.to && m.message && !m.message.includes('rate test')
    );

    let imported = 0;
    for (const m of messages) {
      const isOutbound = m.direction === 'OUT';
      const customerPhone = isOutbound ? m.to : m.from;
      const viciPhone = process.env.TELNYX_PHONE_NUMBER;
      if (!customerPhone || customerPhone === viciPhone) continue;

      await supabase.from('sms_contacts').upsert({
        phone: customerPhone,
        ghl_contact_id: m.contactId || null,
        last_seen: m.timestamp || new Date().toISOString()
      }, { onConflict: 'phone' });

      await supabase.from('sms_messages').upsert({
        telnyx_message_id: m.providerId || `bridge-${customerPhone}-${m.timestamp}`,
        contact_phone: customerPhone,
        direction: isOutbound ? 'outbound' : 'inbound',
        body: m.message,
        status: m.status || 'delivered',
        created_at: m.timestamp || new Date().toISOString()
      }, { onConflict: 'telnyx_message_id' });
      imported++;
    }

    // Same event and same reasoning as /import above: one summary row for a
    // bulk write with no per-row confirmation and no undo. lib/route-policy.js
    // flags this endpoint `audit: true` and it wrote nothing until now.
    await logAuditSafely({
      eventType: 'contact.bulk_imported',
      req,
      entityId: `bridge-seed:${new Date().toISOString()}`,
      summary: `Seeded ${imported} message(s) from the old Telnyx bridge`,
      metadata: { source: 'telnyx_bridge_seed', contact_count: null, message_count: imported }
    });

    res.json({ success: true, messages_imported: imported });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
