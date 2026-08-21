const router = require('express').Router();
const { supabase } = require('../db');
const { logAudit, diffFields } = require('../lib/audit/log');

/**
 * The snapshot stored in an audit row's previous_state/new_state.
 *
 * `notes` is deliberately excluded. It is freeform operator text that routinely
 * carries customer detail, and sms_audit_log cannot be deleted from, so a note
 * copied in here could not be removed on an erasure request. That a note
 * changed is still visible, by name, in changed_fields.
 */
function auditSnapshot(contact) {
  if (!contact) return null;
  return {
    phone: contact.phone || null,
    first_name: contact.first_name || null,
    last_name: contact.last_name || null,
    name: contact.name || null,
    email: contact.email || null,
    has_notes: Boolean(contact.notes)
  };
}

// GET /api/contacts?search=&page=1
// Returns all contacts sorted alphabetically by first_name, last_name
router.get('/', async (req, res) => {
  try {
    const { search, page = 1, per_page: perPage = 100 } = req.query;
    const limit = Math.min(1000, Math.max(1, Number.parseInt(perPage, 10) || 100));
    const pageNumber = Math.max(1, Number.parseInt(page, 10) || 1);
    const batchSize = 1000;
    const rows = [];

    // first_name/last_name are absent on many imported contacts while `name`
    // is populated. Fetch matching rows in chunks, normalise, then sort by the
    // actual display name before paginating so every page is globally A–Z.
    for (let offset = 0; ; offset += batchSize) {
      let query = supabase
        .from('sms_contacts')
        .select('id, phone, first_name, last_name, name, email, notes, unread_count, last_seen, source, created_at')
        .order('id', { ascending: true })
        .range(offset, offset + batchSize - 1);

      if (search) {
        query = query.or(
          `first_name.ilike.%${search}%,last_name.ilike.%${search}%,name.ilike.%${search}%,phone.ilike.%${search}%,email.ilike.%${search}%`
        );
      }

      const { data, error } = await query;
      if (error) return res.status(500).json({ error: error.message });
      rows.push(...(data || []));
      if ((data?.length || 0) < batchSize) break;
    }

    const normalised = rows.map(normaliseContact).sort((a, b) => {
      const aHasName = Boolean(a.first_name || a.last_name || a.name);
      const bHasName = Boolean(b.first_name || b.last_name || b.name);
      if (aHasName !== bHasName) return aHasName ? -1 : 1;
      const byName = a.display_name.localeCompare(b.display_name, undefined, { sensitivity: 'base', numeric: true });
      return byName || a.phone.localeCompare(b.phone);
    });
    const start = (pageNumber - 1) * limit;
    const contacts = normalised.slice(start, start + limit);

    res.json({ contacts, page: pageNumber, hasMore: start + limit < normalised.length });
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
      const updatedSnapshot = auditSnapshot(updated);
      await logAudit({
        eventType: 'contact.updated',
        req,
        entityId: formattedPhone,
        contactPhone: formattedPhone,
        summary: `Updated the existing contact ${formattedPhone}`,
        previousState: auditSnapshot(existing),
        newState: updatedSnapshot,
        changedFields: diffFields(auditSnapshot(existing), updatedSnapshot),
        metadata: { source: 'manual', updated_via: 'create_form' }
      });
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
    await logAudit({
      eventType: 'contact.created',
      req,
      entityId: formattedPhone,
      contactPhone: formattedPhone,
      summary: `Created the contact ${buildFullName(first_name, last_name) || formattedPhone}`,
      newState: auditSnapshot(created),
      metadata: { source: 'manual', created_via: 'contacts_api', has_email: Boolean(email) }
    });
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
    const { first_name, last_name, name, email, notes, avatar_url, new_phone } = req.body;

    const updates = {};
    if (first_name !== undefined) updates.first_name = first_name;
    if (last_name !== undefined) updates.last_name = last_name;
    if (email !== undefined) updates.email = email;
    if (notes !== undefined) updates.notes = notes;
    if (avatar_url !== undefined) updates.avatar_url = avatar_url;
    if (name !== undefined) updates.name = name;

    // Read the prior row once, for both the display-name rebuild and the audit
    // snapshot. sms_audit_log cannot be updated later, so the before-state has
    // to be captured here or not at all.
    const { data: current } = await supabase
      .from('sms_contacts')
      .select('phone, first_name, last_name, name, email, notes')
      .eq('phone', phone)
      .maybeSingle();

    if ((first_name !== undefined || last_name !== undefined) && name === undefined) {
      updates.name = buildFullName(
        first_name ?? current?.first_name,
        last_name ?? current?.last_name
      );
    }

    // Phone change: update only sms_contacts (message/order history stays on old number)
    if (new_phone) {
      const formatted = formatPhone(new_phone);
      if (!formatted) return res.status(400).json({ error: 'Invalid phone number format' });
      updates.phone = formatted;
    }

    const { data, error } = await supabase
      .from('sms_contacts')
      .update(updates)
      .eq('phone', phone)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    const previousSnapshot = auditSnapshot(current);
    const nextSnapshot = auditSnapshot(data);
    const changed = diffFields(previousSnapshot, nextSnapshot);
    const phoneChanged = Boolean(updates.phone && updates.phone !== phone);

    // A phone change is severity 'warning', not 'info'. sms_messages and
    // sms_orders key on the number, so changing it silently detaches every
    // message and order from the contact — the behaviour the comment above
    // already describes. That is exactly the kind of quiet, hard-to-reverse
    // change an Admin later needs to find.
    await logAudit({
      eventType: phoneChanged ? 'contact.phone_changed' : 'contact.updated',
      req,
      entityId: updates.phone || phone,
      contactPhone: updates.phone || phone,
      summary: phoneChanged
        ? `Changed the phone number for ${current?.name || phone} from ${phone} to ${updates.phone}; message and order history stays on the old number`
        : `Updated the contact ${current?.name || phone}`,
      previousState: previousSnapshot,
      newState: nextSnapshot,
      changedFields: changed,
      metadata: phoneChanged
        ? { previous_phone: phone, new_phone: updates.phone, history_detached: true }
        : { source: 'manual', updated_via: 'contacts_api' }
    });

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
