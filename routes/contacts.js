const router = require('express').Router();
const { supabase } = require('../db');

// GET /api/contacts?search=&page=1
// Returns all contacts sorted alphabetically by first_name, last_name
router.get('/', async (req, res) => {
  try {
    const { search, page = 1 } = req.query;
    const limit = 100;
    const offset = (parseInt(page) - 1) * limit;

    let query = supabase
      .from('sms_contacts')
      .select('id, phone, first_name, last_name, name, email, notes, unread_count, last_seen, source, created_at')
      .order('first_name', { ascending: true, nullsFirst: false })
      .order('last_name', { ascending: true, nullsFirst: false })
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.or(
        `first_name.ilike.%${search}%,last_name.ilike.%${search}%,name.ilike.%${search}%,phone.ilike.%${search}%`
      );
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const normalised = (data || []).map(c => normaliseContact(c));

    res.json({ contacts: normalised, page: parseInt(page), hasMore: (data?.length || 0) === limit });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load contacts' });
  }
});

// GET /api/contacts/:phone
// Full customer profile: contact info + orders + AI intelligence
router.get('/:phone', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);

    const [contactResult, ordersResult, profileResult, suggestionsResult] = await Promise.all([
      supabase.from('sms_contacts').select('*').eq('phone', phone).maybeSingle(),
      supabase.from('sms_orders').select('id, woo_order_id, status, total, items, created_at, tracking_number, carrier, shipped_at').eq('contact_phone', phone).order('created_at', { ascending: false }).limit(20),
      supabase.from('sms_customer_profiles').select('*').eq('contact_phone', phone).maybeSingle(),
      supabase.from('sms_campaign_suggestions').select('*').eq('contact_phone', phone).eq('status', 'pending').order('created_at', { ascending: false }).limit(5)
    ]);

    const contact = contactResult.data;
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const orders = ordersResult.data || [];
    const totalSpent = orders.reduce((sum, o) => sum + (parseFloat(o.total) || 0), 0);

    // Attempt WooCommerce live fallback if no local orders and contact has email
    let finalOrders = orders;
    if (!finalOrders.length && (contact.email)) {
      finalOrders = await fetchWooOrdersByEmail(contact.email);
    }

    res.json({
      contact: normaliseContact(contact),
      orders: finalOrders,
      total_orders: finalOrders.length,
      total_spent: totalSpent,
      intelligence: profileResult.data || null,
      suggestions: suggestionsResult.data || []
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load contact profile' });
  }
});

// POST /api/contacts
// Create a new contact manually
router.post('/', async (req, res) => {
  try {
    const { first_name, last_name, phone, email, notes } = req.body;

    if (!phone) return res.status(400).json({ error: 'Phone number is required' });
    if (!first_name && !last_name) return res.status(400).json({ error: 'At least a first or last name is required' });

    const formattedPhone = formatPhone(phone);
    if (!formattedPhone) return res.status(400).json({ error: 'Invalid phone number format' });

    const { data: existing } = await supabase
      .from('sms_contacts')
      .select('id, phone, first_name, last_name, email, notes')
      .eq('phone', formattedPhone)
      .maybeSingle();

    if (existing) {
      const { data: updated } = await supabase
        .from('sms_contacts')
        .update({
          first_name: first_name || existing.first_name,
          last_name: last_name || existing.last_name,
          name: buildFullName(first_name || existing.first_name, last_name || existing.last_name),
          email: email || existing.email,
          notes: notes || existing.notes
        })
        .eq('phone', formattedPhone)
        .select()
        .single();
      return res.json({ contact: normaliseContact(updated), created: false });
    }

    const { data: created, error } = await supabase
      .from('sms_contacts')
      .insert({
        phone: formattedPhone,
        first_name: first_name || null,
        last_name: last_name || null,
        name: buildFullName(first_name, last_name),
        email: email || null,
        notes: notes || null,
        source: 'manual',
        unread_count: 0,
        last_seen: new Date().toISOString()
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    console.log(`[CONTACTS] created | phone=${formattedPhone?.slice(-4).padStart(formattedPhone.length, '*')}`);
    res.status(201).json({ contact: normaliseContact(created), created: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

// PATCH /api/contacts/:phone
// Update contact details
router.patch('/:phone', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const { first_name, last_name, name, email, notes } = req.body;

    const updates = {};
    if (first_name !== undefined) updates.first_name = first_name;
    if (last_name !== undefined) updates.last_name = last_name;
    if (email !== undefined) updates.email = email;
    if (notes !== undefined) updates.notes = notes;
    if (name !== undefined) updates.name = name;

    if ((first_name !== undefined || last_name !== undefined) && name === undefined) {
      const { data: current } = await supabase
        .from('sms_contacts').select('first_name, last_name').eq('phone', phone).single();
      updates.name = buildFullName(
        first_name ?? current?.first_name,
        last_name ?? current?.last_name
      );
    }

    const { data, error } = await supabase
      .from('sms_contacts')
      .update(updates)
      .eq('phone', phone)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ contact: normaliseContact(data) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function normaliseContact(c) {
  if (!c) return c;
  const first = c.first_name || (c.name ? c.name.split(' ')[0] : '');
  const last  = c.last_name  || (c.name ? c.name.split(' ').slice(1).join(' ') : '');
  return {
    ...c,
    first_name: first,
    last_name:  last,
    display_name: buildFullName(first, last) || c.phone
  };
}

function buildFullName(first, last) {
  return [first, last].filter(Boolean).join(' ').trim();
}

function formatPhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  if (raw.startsWith('+') && digits.length >= 10) return '+' + digits;
  return null;
}

async function fetchWooOrdersByEmail(email) {
  try {
    const authHeader = 'Basic ' + Buffer.from(
      `${process.env.WC_CONSUMER_KEY}:${process.env.WC_CONSUMER_SECRET}`
    ).toString('base64');

    const r = await fetch(
      `${process.env.WC_URL}/orders?email=${encodeURIComponent(email)}&per_page=20&orderby=date&order=desc`,
      { headers: { Authorization: authHeader } }
    );
    const orders = await r.json();
    return (orders || []).map(o => ({
      woo_order_id: String(o.id),
      status: o.status,
      total: o.total,
      items: (o.line_items || []).map(i => ({ name: i.name, quantity: i.quantity })),
      created_at: o.date_created,
      tracking_number: null,
      carrier: null
    }));
  } catch (err) {
    console.error('[CONTACTS] WooCommerce fallback failed:', err.message);
    return [];
  }
}

module.exports = router;
