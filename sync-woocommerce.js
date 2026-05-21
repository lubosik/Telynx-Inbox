const { supabase } = require('./db');
const { normalizePhone, fetchOrders } = require('./woocommerce');

// fromWebhook=true means this is a live inbound order — don't pre-mark SMS as sent.
// fromWebhook=false (default, manual sync) marks historical orders as already sent to avoid spam.
async function syncOrder(order, { fromWebhook = false } = {}) {
  const phone = normalizePhone(order.billing?.phone);
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

  const alreadyShipped = ['shipped', 'completed', 'delivered', 'refunded', 'cancelled', 'failed'].includes(order.status);

  // Check if this order already exists in the DB
  const { data: existing } = await supabase
    .from('sms_orders')
    .select('id')
    .eq('woo_order_id', order.id)
    .maybeSingle();

  if (existing) {
    // Order already in DB — only update mutable fields, never overwrite SMS sent flags
    await supabase.from('sms_orders').update({
      contact_phone: phone,
      status: order.status || 'pending',
      items,
      total: parseFloat(order.total) || 0
    }).eq('woo_order_id', order.id);
  } else {
    // New order — set SMS flags appropriately
    // Historical (manual sync): mark all as sent so we don't spam customers retroactively
    // Live webhook: leave order_sms_sent=false so the webhook handler fires the SMS
    const historical = !fromWebhook;
    await supabase.from('sms_orders').insert({
      contact_phone: phone,
      woo_order_id: order.id,
      status: order.status || 'pending',
      items,
      total: parseFloat(order.total) || 0,
      created_at: order.date_created || new Date().toISOString(),
      order_sms_sent: historical,
      shipped_sms_sent: historical || alreadyShipped,
      delivery_sms_sent: historical || alreadyShipped
    });
  }

  return true;
}

async function runWooSync() {
  let page = 1;
  let totalOrders = 0;
  let syncedContacts = 0;

  const { orders: firstPage, totalPages, total } = await fetchOrders(1, 100, 'any');
  console.log(`WooCommerce sync: ${total} orders across ${totalPages} pages`);

  for (const o of firstPage) {
    if (await syncOrder(o)) syncedContacts++;
  }
  totalOrders += firstPage.length;
  page++;

  while (page <= totalPages) {
    await new Promise(r => setTimeout(r, 250));
    const { orders } = await fetchOrders(page, 100, 'any');
    for (const o of orders) {
      if (await syncOrder(o)) syncedContacts++;
    }
    totalOrders += orders.length;
    page++;
    console.log(`WooCommerce sync: page ${page - 1}/${totalPages} done`);
  }

  return { total_orders: totalOrders, synced_contacts: syncedContacts };
}

module.exports = { syncOrder, runWooSync };
