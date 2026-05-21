/**
 * backfill-missing.js
 *
 * Pulls all recent orders directly from WooCommerce (status: processing + completed),
 * creates any missing contacts, inserts any missing order records, then sends the
 * order-confirmation SMS to anyone who never received it.
 *
 * Safe to re-run — order_sms_sent flag prevents double-sends.
 *
 * Usage:
 *   node scripts/backfill-missing.js
 *   node scripts/backfill-missing.js --dry-run   (preview only, no sends)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { supabase } = require('../db');
const { sendSMS } = require('../telnyx');
const { normalizePhone, wooGet } = require('../woocommerce');

const DRY_RUN = process.argv.includes('--dry-run');

const ORDER_SMS = (firstName) =>
  `Hey ${firstName}! It's Dom, founder of Vici Peptides. Huge thank you for your order - it genuinely means everything to me. We're getting it packed up right now and I'll personally text you the moment it ships!`;

async function fetchAllRecentOrders() {
  const statuses = ['processing', 'completed'];
  const all = [];

  for (const status of statuses) {
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      const url = new URL('https://vicipeptides.com/wp-json/wc/v3/orders');
      url.searchParams.set('per_page', '100');
      url.searchParams.set('page', String(page));
      url.searchParams.set('status', status);
      url.searchParams.set('orderby', 'date');
      url.searchParams.set('order', 'desc');

      const { data, headers } = await wooGet('/orders', {
        per_page: 100,
        page,
        status,
        orderby: 'date',
        order: 'desc'
      });

      if (page === 1) {
        totalPages = parseInt(headers.get('X-WP-TotalPages') || '1');
        const total = headers.get('X-WP-Total') || '?';
        console.log(`  WooCommerce ${status}: ${total} orders, ${totalPages} pages`);
      }

      all.push(...data);
      page++;
      if (page <= totalPages) await new Promise(r => setTimeout(r, 200));
    }
  }

  return all;
}

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Vici — Missing Contacts & Orders Backfill    ');
  if (DRY_RUN) console.log('  DRY RUN — no SMS will be sent                ');
  console.log('═══════════════════════════════════════════════\n');

  console.log('Fetching orders from WooCommerce (processing + completed)...');
  const orders = await fetchAllRecentOrders();
  console.log(`\nTotal orders fetched: ${orders.length}\n`);

  let contactsCreated = 0;
  let ordersInserted = 0;
  let smsSent = 0;
  let smsFailed = 0;
  let skipped = 0;

  for (const order of orders) {
    const phone = normalizePhone(order.billing?.phone);
    if (!phone) {
      console.log(`  Order #${order.id}: no valid phone — skipped`);
      skipped++;
      continue;
    }

    const firstName = order.billing?.first_name || '';
    const lastName  = order.billing?.last_name  || '';
    const name      = [firstName, lastName].filter(Boolean).join(' ') || null;

    // 1. Upsert contact — creates it if missing, updates if stale
    const { data: existingContact } = await supabase
      .from('sms_contacts')
      .select('phone, name')
      .eq('phone', phone)
      .maybeSingle();

    if (!existingContact) {
      if (!DRY_RUN) {
        await supabase.from('sms_contacts').upsert({
          phone,
          name,
          email:           order.billing?.email || null,
          city:            order.billing?.city   || null,
          state:           order.billing?.state  || null,
          country:         order.billing?.country || null,
          woo_customer_id: order.customer_id || null,
          last_seen:       order.date_modified || order.date_created || new Date().toISOString()
        }, { onConflict: 'phone' });
      }
      console.log(`  [NEW CONTACT] ${name || phone}  (${phone})`);
      contactsCreated++;
    }

    // 2. Check if order already exists in DB
    const { data: existingOrder } = await supabase
      .from('sms_orders')
      .select('id, order_sms_sent')
      .eq('woo_order_id', order.id)
      .maybeSingle();

    if (!existingOrder) {
      // Insert with order_sms_sent=false so it gets SMS below
      if (!DRY_RUN) {
        await supabase.from('sms_orders').insert({
          contact_phone:    phone,
          woo_order_id:     order.id,
          status:           order.status,
          items:            (order.line_items || []).map(i => ({ name: i.name, quantity: i.quantity, total: i.total, sku: i.sku || null })),
          total:            parseFloat(order.total) || 0,
          created_at:       order.date_created || new Date().toISOString(),
          order_sms_sent:   false,
          shipped_sms_sent: false,
          delivery_sms_sent: false
        });
      }
      console.log(`  [NEW ORDER] #${order.id}  ${name || phone}  status=${order.status}  SMS will be sent`);
      ordersInserted++;
    }

    // 3. Determine if SMS needs to go out
    const needsSMS = existingOrder ? !existingOrder.order_sms_sent : true;

    if (!needsSMS) {
      continue; // already sent
    }

    const resolvedName = existingContact?.name || name || 'there';
    const resolvedFirst = resolvedName.split(' ')[0] || 'there';
    const msg = ORDER_SMS(resolvedFirst);

    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would send SMS to ${phone} (${resolvedName})`);
      smsSent++;
      continue;
    }

    // Mark as sent BEFORE Telnyx call to prevent race on re-run
    const orderId = existingOrder?.id;
    if (orderId) {
      await supabase.from('sms_orders').update({ order_sms_sent: true }).eq('id', orderId);
    } else {
      await supabase.from('sms_orders').update({ order_sms_sent: true }).eq('woo_order_id', order.id);
    }

    try {
      const { messageId } = await sendSMS(phone, msg);

      await supabase.from('sms_messages').insert({
        telnyx_message_id: messageId,
        contact_phone:     phone,
        direction:         'outbound',
        body:              msg,
        status:            'sent',
        created_at:        new Date().toISOString()
      });

      await supabase.from('sms_contacts')
        .update({ last_seen: new Date().toISOString() })
        .eq('phone', phone);

      console.log(`  ✓  SMS sent → ${resolvedName}  (${phone})  order #${order.id}`);
      smsSent++;
    } catch (err) {
      // Reset flag so it can be retried
      if (orderId) {
        await supabase.from('sms_orders').update({ order_sms_sent: false }).eq('id', orderId);
      } else {
        await supabase.from('sms_orders').update({ order_sms_sent: false }).eq('woo_order_id', order.id);
      }
      console.error(`  ✗  SMS FAILED → ${phone}  order #${order.id}: ${err.message}`);
      smsFailed++;
    }

    await new Promise(r => setTimeout(r, 400));
  }

  console.log('\n═══════════════════════════════════════════════');
  console.log(`  Contacts created:  ${contactsCreated}`);
  console.log(`  Orders inserted:   ${ordersInserted}`);
  console.log(`  SMS sent:          ${smsSent}`);
  if (smsFailed > 0) console.log(`  SMS failed:        ${smsFailed}`);
  if (skipped > 0)   console.log(`  No phone (skipped):${skipped}`);
  if (DRY_RUN)       console.log('\n  Re-run without --dry-run to actually send.');
  console.log('═══════════════════════════════════════════════\n');

  process.exit(smsFailed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err.message, err.stack);
  process.exit(1);
});
