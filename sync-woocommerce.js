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

  if (!phone) return null;

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
    last_seen: fromWebhook ? new Date().toISOString() : (order.date_modified || order.date_created || new Date().toISOString())
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

  let writtenStatus;
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

    writtenStatus = keepStatus ? existing.status : (updateFields.status || existing.status);
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
    writtenStatus = hasTracking ? 'shipped' : (order.status || 'pending');
    await supabase.from('sms_orders').upsert({
      contact_phone: phone,
      woo_order_id: order.id,
      status: writtenStatus,
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

  return { phone, status: writtenStatus };
}

async function runWooSync() {
  let totalOrders = 0;
  let syncedContacts = 0;

  const { orders: firstPage, totalPages, total } = await fetchOrders(1, 100, 'any');
  console.log(`WooCommerce sync: ${total} orders across ${totalPages} pages`);

  for (const o of firstPage) {
    if ((await syncOrder(o))?.phone) syncedContacts++;
  }
  totalOrders += firstPage.length;

  for (let page = 2; page <= totalPages; page++) {
    await new Promise(r => setTimeout(r, 250));
    const { orders } = await fetchOrders(page, 100, 'any');
    for (const o of orders) {
      if ((await syncOrder(o))?.phone) syncedContacts++;
    }
    totalOrders += orders.length;
    console.log(`WooCommerce sync: page ${page}/${totalPages} done`);
  }

  return { total_orders: totalOrders, synced_contacts: syncedContacts };
}

// ---------------------------------------------------------------------------
// syncOrderStatuses — status-only sync, NO SMS sent, NO flow handlers called.
// Fetches current WooCommerce order statuses, updates sms_orders.status for any
// order that has changed and is not already in a protected internal state.
// Maps WC 'completed' → 'shipped' (at Vici, completed = physically shipped).
// Updates sms_contacts.last_seen and broadcasts SSE for each changed contact
// so they immediately bubble to the top of the contact list.
// ---------------------------------------------------------------------------
async function syncOrderStatuses() {
  const { broadcast } = require('./lib/broadcaster');

  // 'delivered' is the only terminal state — never downgrade it.
  // 'shipped' is NOT protected here so old shipped orders can graduate to delivered.
  const PROTECTED = new Set(['delivered']);
  const DELIVERED_THRESHOLD_MS = 21 * 24 * 60 * 60 * 1000;

  let fixed = 0, skipped = 0;
  const changes = [];

  const { orders: firstPage, totalPages, total } = await fetchOrders(1, 100, 'any');
  console.log(`[STATUS-SYNC] ${total} WC orders across ${totalPages} pages`);

  const allWcOrders = [...firstPage];
  for (let page = 2; page <= totalPages; page++) {
    await new Promise(r => setTimeout(r, 300));
    const { orders } = await fetchOrders(page, 100, 'any');
    allWcOrders.push(...orders);
  }

  const { data: dbOrders } = await supabase
    .from('sms_orders')
    .select('woo_order_id, status, contact_phone');

  const dbMap = new Map();
  for (const o of (dbOrders || [])) dbMap.set(String(o.woo_order_id), o);

  for (const wc of allWcOrders) {
    const orderId = String(wc.id);
    const db = dbMap.get(orderId);

    if (!db) { skipped++; continue; }
    if (PROTECTED.has(db.status)) { skipped++; continue; }

    // Age-based status: WC 'completed' orders are either shipped (recent) or delivered (old)
    let newStatus;
    if (wc.status === 'completed') {
      const wcDate = new Date(wc.date_modified || wc.date_created);
      const ageMs = Date.now() - wcDate.getTime();
      newStatus = ageMs > DELIVERED_THRESHOLD_MS ? 'delivered' : 'shipped';
    } else {
      newStatus = wc.status;
    }

    if (newStatus === db.status) { skipped++; continue; }

    // Use WC modification date as last_seen — not NOW() — so old orders don't float to top
    const lastSeen = wc.date_modified || wc.date_created || new Date().toISOString();

    await supabase.from('sms_orders')
      .update({ status: newStatus })
      .eq('woo_order_id', wc.id);

    if (db.contact_phone) {
      await supabase.from('sms_contacts')
        .update({ last_seen: lastSeen })
        .eq('phone', db.contact_phone);
      broadcast({ type: 'order_status_updated', phone: db.contact_phone, status: newStatus, order_id: orderId });
    }

    console.log(`[STATUS-SYNC] Order ${orderId}: ${db.status} → ${newStatus} (${db.contact_phone || 'no-phone'})`);
    changes.push({ order_id: orderId, phone: db.contact_phone, from: db.status, to: newStatus });
    fixed++;
  }

  console.log(`[STATUS-SYNC] Done — fixed=${fixed} skipped=${skipped}`);
  return { fixed, skipped, changes };
}

module.exports = { syncOrder, runWooSync, syncOrderStatuses };
