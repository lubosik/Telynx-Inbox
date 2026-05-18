const router = require('express').Router();
const { supabase } = require('../db');

router.get('/', async (req, res) => {
  try {
    const { data: contacts } = await supabase
      .from('sms_contacts')
      .select('*')
      .order('last_seen', { ascending: false });

    const result = await Promise.all((contacts || []).map(async c => {
      const { data: msgs } = await supabase
        .from('sms_messages')
        .select('body, direction, created_at')
        .eq('contact_phone', c.phone)
        .order('created_at', { ascending: false })
        .limit(1);
      return { ...c, lastMessage: msgs?.[0] || null };
    }));

    res.json(result);
  } catch (err) {
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
