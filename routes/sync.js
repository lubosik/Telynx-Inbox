const router = require('express').Router();
const { supabase } = require('../db');
const { runSync } = require('../sync-ghl');

let syncRunning = false;
let lastSyncResult = null;

// Trigger GHL sync
router.post('/ghl', async (req, res) => {
  if (syncRunning) return res.json({ success: false, error: 'Sync already running' });
  syncRunning = true;
  res.json({ success: true, message: 'Sync started' });

  try {
    lastSyncResult = await runSync();
  } catch (err) {
    lastSyncResult = { success: false, error: err.message };
  } finally {
    syncRunning = false;
  }
});

// Sync status
router.get('/status', (req, res) => {
  res.json({ running: syncRunning, last: lastSyncResult });
});

// Manual import — seed contacts + messages from an array
// Body: [{ phone, name, messages: [{direction, body, created_at}] }]
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
  res.json({ success: true, messages_imported: imported });
});

// Seed from the old Telnyx bridge in-memory log
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

    res.json({ success: true, messages_imported: imported, bridge_uptime_days: Math.floor(data.uptime / 86400) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
