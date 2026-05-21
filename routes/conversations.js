const router = require('express').Router();
const { supabase } = require('../db');

router.get('/', async (req, res) => {
  try {
    // Fetch all contacts
    const { data: contacts } = await supabase
      .from('sms_contacts')
      .select('*');

    if (!contacts?.length) return res.json([]);

    // Fetch latest message per contact in one batch
    const { data: allMessages } = await supabase
      .from('sms_messages')
      .select('contact_phone, body, direction, created_at')
      .in('contact_phone', contacts.map(c => c.phone))
      .order('created_at', { ascending: false });

    // Fetch latest order per contact in one batch
    const { data: allOrders } = await supabase
      .from('sms_orders')
      .select('contact_phone, status, created_at, woo_order_id, total')
      .in('contact_phone', contacts.map(c => c.phone))
      .order('created_at', { ascending: false });

    // Build lookup maps — first entry per phone = latest (already sorted desc)
    const latestMessage = {};
    for (const m of (allMessages || [])) {
      if (!latestMessage[m.contact_phone]) latestMessage[m.contact_phone] = m;
    }

    const latestOrder = {};
    for (const o of (allOrders || [])) {
      if (!latestOrder[o.contact_phone]) latestOrder[o.contact_phone] = o;
    }

    // Enrich contacts with latest message + latest order info
    const enriched = contacts.map(c => ({
      ...c,
      lastMessage: latestMessage[c.phone] || null,
      latest_order_status: latestOrder[c.phone]?.status || null,
      latest_order_date: latestOrder[c.phone]?.created_at || null,
      latest_order_id: latestOrder[c.phone]?.woo_order_id || null
    }));

    res.json(enriched);
  } catch (err) {
    console.error('Conversations load error:', err.message);
    res.status(500).json({ error: 'Failed to load conversations' });
  }
});

router.get('/:phone', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const { data: messages } = await supabase
      .from('sms_messages')
      .select('*')
      .eq('contact_phone', phone)
      .order('created_at', { ascending: true });

    await supabase.from('sms_contacts')
      .update({ unread_count: 0 })
      .eq('phone', phone);

    res.json(messages || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load thread' });
  }
});

module.exports = router;
