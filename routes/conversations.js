const router = require('express').Router();
const { supabase } = require('../db');
const { reconcileRecentMessageStatuses } = require('../lib/message-status');
const { fetchAllRows } = require('../lib/fetch-all-rows');

router.get('/', async (req, res) => {
  try {
    // Every read here is paged, and none filters by a list of phone numbers.
    //
    // This route previously passed all contact phones into `.in()`, which puts
    // them in the URL. At 907 contacts that is an ~11,800-character filter,
    // which overflows Node's HTTP header limit and fails the request after a
    // ~10 second stall. The error was swallowed, so every lastMessage came back
    // null and the inbox showed phone numbers where message previews belong,
    // while the 25-second response made the app give up with "cancelled".
    //
    // Reading whole tables in pages is both correct and faster: every message
    // belongs to a contact, so filtering by contact bought nothing.
    const [contacts, allMessages, allOrders] = await Promise.all([
      fetchAllRows(supabase, 'sms_contacts', '*', { orderBy: null }),
      fetchAllRows(supabase, 'sms_messages', 'contact_phone, body, direction, created_at, media_urls'),
      fetchAllRows(supabase, 'sms_orders',   'contact_phone, status, created_at, woo_order_id, total')
    ]);

    if (!contacts.length) return res.json([]);

    // Sorted newest-first, so the first entry seen per phone is the latest.
    const latestMessage = {};
    for (const m of allMessages) {
      if (!latestMessage[m.contact_phone]) latestMessage[m.contact_phone] = m;
    }

    const latestOrder = {};
    for (const o of allOrders) {
      if (!latestOrder[o.contact_phone]) latestOrder[o.contact_phone] = o;
    }

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
    const { data: messages, error } = await supabase
      .from('sms_messages')
      .select('*')
      .eq('contact_phone', phone)
      .order('created_at', { ascending: true });
    if (error) throw error;

    const reconciled = await reconcileRecentMessageStatuses(supabase, messages || []);

    await supabase.from('sms_contacts')
      .update({ unread_count: 0 })
      .eq('phone', phone);

    res.json(reconciled);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load thread' });
  }
});

module.exports = router;
