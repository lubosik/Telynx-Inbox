const { supabase } = require('./db');
const { normalizePhone, fetchOrders, wooGet, extractTracking } = require('./woocommerce');
const { searchContactByEmail } = require('./ghl');

// fromWebhook=true means this is a live inbound order — don't pre-mark SMS as sent.
// fromWebhook=false (default, manual sync) marks historical orders as already sent to avoid spam.
// phoneOverride: pre-resolved phone (used by runWooSync batch lookup).
async function syncOrder(order, { fromWebhook = false, phoneOverride = null } = {}) {
  let phone = phoneOverride || normalizePhone(order.billing?.phone);

  // If billing phone is missing, try local DB or GHL lookup by email
  if (!phone && order.billing?.email) {
    const email = order.billing.email;
    try {
      const { data: local } = await supabase
        .from('sms_contacts')
        .select('phone')
        .eq('email', email)
        .maybeSingle();
      if (local?.phone) phone = local.phone;
    } catch {}

    if (!phone) {
      try {
        const ghlContact = await searchContactByEmail(email);
        phone = normalizePhone(ghlContact?.phone) || null;
      } catch {}
    }
  }

  if (!phone) return false;

  const firstName = order.billing?.first_name || '';
  const lastName = order.billing?.last_name || '';
  const name = [firstName, lastName].filter(Boolean).join(' ') || null;

  await supabase.from('sms_contacts').upsert({
    phone,
    name,
    email: order.billing?.email || null,
    city: order.billing?.city || null,
    state: order.billing?.state || null,
    country: order.billing?.country || null,
    woo_customer_id: order.customer_id || null,
    last_seen: order.date_modified || order.date_created || new Date().toISOString()
  }, { onConflict: 'phone' });

  const items = (order.line_items || []).map(i => ({
    name: i.name,
    quantity: i.quantity,
    total: i.total,
    sku: i.sku || null
  }));

  const tracking = extractTracking(order);

  // "Already done" — order won't ship or has already shipped
  const neverShips = ['refunded', 'cancelled', 'failed'].includes(order.status);
  const alreadyShipped = ['shipped', 'completed', 'delivered'].includes(order.status);

  // Internal statuses we manage — never downgrade these from a WooCommerce status update
  const PROTECTED_STATUSES = ['shipped', 'delivered'];

  // Check if this order already exists in the DB
  const { data: existing } = await supabase
    .from('sms_orders')
    .select('id, status, tracking_number')
    .eq('woo_order_id', order.id)
    .maybeSingle();

  if (existing) {
    // Order already in DB — only update mutable fields, never overwrite SMS sent flags.
    // Don't downgrade our internal shipped/delivered status with a WooCommerce status.
    const keepStatus = PROTECTED_STATUSES.includes(existing.status);
    const updateFields = {
      contact_phone: phone,
      items,
      total: parseFloat(order.total) || 0
    };
    if (!keepStatus) updateFields.status = order.status || 'pending';

    // Store tracking number if we have it and don't yet
    if (tracking?.trackingNumber && !existing.tracking_number) {
      updateFields.tracking_number = tracking.trackingNumber;
      updateFields.carrier = tracking.carrier || null;
      if (!keepStatus) updateFields.status = 'shipped';
      if (tracking.shippedDate) updateFields.shipped_at = tracking.shippedDate;
    }

    await supabase.from('sms_orders').update(updateFields).eq('woo_order_id', order.id);
  } else {
    // New order — set SMS flags appropriately.
    // Historical (manual sync): suppress order_sms_sent to avoid re-confirming old orders,
    // but only suppress shipped/delivery SMS if the order has actually shipped or will never ship.
    // Live webhook: start everything at false so each handler fires when the time is right.
    //
    // Use upsert with ignoreDuplicates:true (ON CONFLICT DO NOTHING) so concurrent webhook
    // requests that both see this order as "new" don't create duplicate rows. The UNIQUE
    // constraint on woo_order_id enforces exactly one row per order.
    const historical = !fromWebhook;
    const hasTracking = !!tracking?.trackingNumber;
    await supabase.from('sms_orders').upsert({
      contact_phone: phone,
      woo_order_id: order.id,
      status: (hasTracking ? 'shipped' : order.status) || 'pending',
      items,
      total: parseFloat(order.total) || 0,
      tracking_number: tracking?.trackingNumber || null,
      carrier: tracking?.carrier || null,
      shipped_at: tracking?.shippedDate || (hasTracking ? new Date().toISOString() : null),
      created_at: order.date_created || new Date().toISOString(),
      order_sms_sent: historical,
      shipped_sms_sent: neverShips || (historical && (alreadyShipped || hasTracking)),
      delivery_sms_sent: neverShips || (historical && (alreadyShipped || hasTracking))
    }, { onConflict: 'woo_order_id', ignoreDuplicates: true });
  }

  return true;
}

async function runWooSync() {
  let totalOrders = 0;
  let syncedContacts = 0;

  const { orders: firstPage, totalPages, total } = await fetchOrders(1, 100, 'any');
  console.log(`WooCommerce sync: ${total} orders across ${totalPages} pages`);

  for (const o of firstPage) {
    if (await syncOrder(o)) syncedContacts++;
  }
  totalOrders += firstPage.length;

  for (let page = 2; page <= totalPages; page++) {
    await new Promise(r => setTimeout(r, 250));
    const { orders } = await fetchOrders(page, 100, 'any');
    for (const o of orders) {
      if (await syncOrder(o)) syncedContacts++;
    }
    totalOrders += orders.length;
    console.log(`WooCommerce sync: page ${page}/${totalPages} done`);
  }

  return { total_orders: totalOrders, synced_contacts: syncedContacts };
}

module.exports = { syncOrder, runWooSync };
