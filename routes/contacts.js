const router = require('express').Router();
const { supabase } = require('../db');

// Full customer profile: contact info + orders + AI intelligence
router.get('/:phone', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);

    const [contactResult, ordersResult, profileResult, suggestionsResult] = await Promise.all([
      supabase.from('sms_contacts').select('*').eq('phone', phone).maybeSingle(),
      supabase.from('sms_orders').select('*').eq('contact_phone', phone).order('created_at', { ascending: false }),
      supabase.from('sms_customer_profiles').select('*').eq('contact_phone', phone).maybeSingle(),
      supabase.from('sms_campaign_suggestions').select('*').eq('contact_phone', phone).eq('status', 'pending').order('created_at', { ascending: false }).limit(5)
    ]);

    const contact = contactResult.data;
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const orders = ordersResult.data || [];
    const totalSpent = orders.reduce((sum, o) => sum + (parseFloat(o.total) || 0), 0);

    res.json({
      ...contact,
      orders,
      total_orders: orders.length,
      total_spent: totalSpent,
      intelligence: profileResult.data || null,
      suggestions: suggestionsResult.data || []
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load contact profile' });
  }
});

// Update contact name manually
router.patch('/:phone', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const { name, email } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (email !== undefined) updates.email = email;
    await supabase.from('sms_contacts').update(updates).eq('phone', phone);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

module.exports = router;
