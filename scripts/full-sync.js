/**
 * full-sync.js
 *
 * One-shot repair script that:
 *   1. Fetches ALL orders from WooCommerce (any status)
 *   2. Upserts contacts and orders — creating missing records
 *   3. Sends missing order-confirmation SMS (Message 1) to any order that never got one
 *   4. Stores tracking numbers from order meta_data
 *   5. Sends missing shipped SMS (Message 2) to any order with tracking but no shipped SMS
 *   6. Updates stale order statuses (fixes Jessica, Amanda, etc.)
 *
 * Safe to re-run — all sends are guarded by atomic DB flags.
 *
 * Usage:
 *   node scripts/full-sync.js              — live run
 *   node scripts/full-sync.js --dry-run    — preview only, no SMS sent
 *   node scripts/full-sync.js --status-only — just sync statuses, no SMS
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { supabase } = require('../db');
const { sendSMS } = require('../telnyx');
const { normalizePhone, wooGet, extractTracking, buildTrackingUrl } = require('../woocommerce');
const { searchContactByEmail } = require('../ghl');

const DRY_RUN = process.argv.includes('--dry-run');
const STATUS_ONLY = process.argv.includes('--status-only');

const ORDER_SMS = (firstName) =>
  `Hey ${firstName}! It's Dom, founder of Vici Peptides. Huge thank you for your order - it genuinely means everything to me. We're getting it packed up right now and I'll personally text you the moment it ships!`;

const SHIPPED_SMS = (firstName, carrier, trackingNumber, trackingUrl) => {
  let msg = `Hey ${firstName}! It's Dom from Vici Peptides. Your order is officially on its way to you!`;
  if (trackingUrl) msg += ` You can track it right here: ${trackingUrl}`;
  else if (trackingNumber) msg += ` Tracking number: ${trackingNumber}`;
  msg += ' Reach out anytime if you need me. Reply STOP to opt out.';
  return msg;
};

async function fetchAllOrders() {
  const all = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const { data, headers } = await wooGet('/orders', {
      per_page: 100,
      page,
      status: 'any',
      orderby: 'date',
      order: 'desc'
    });

    if (page === 1) {
      totalPages = parseInt(headers.get('X-WP-TotalPages') || '1');
      const total = headers.get('X-WP-Total') || '?';
      console.log(`  WooCommerce: ${total} total orders across ${totalPages} page(s)`);
    }

    all.push(...data);
    page++;
    if (page <= totalPages) await new Promise(r => setTimeout(r, 200));
  }

  return all;
}

async function sendAndRecord(phone, msg, label) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would send ${label} to ${phone}`);
    return true;
  }
  const { messageId } = await sendSMS(phone, msg);
  await supabase.from('sms_messages').insert({
    telnyx_message_id: messageId,
    contact_phone: phone,
    direction: 'outbound',
    body: msg,
    status: 'sent',
    created_at: new Date().toISOString()
  });
  await supabase.from('sms_contacts').update({ last_seen: new Date().toISOString() }).eq('phone', phone);
  return true;
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Vici — Full Order Sync & Missing SMS Repair      ');
  if (DRY_RUN)     console.log('  DRY RUN — no SMS will be sent                   ');
  if (STATUS_ONLY) console.log('  STATUS ONLY — only updating statuses/tracking   ');
  console.log('═══════════════════════════════════════════════════\n');

  console.log('Fetching all orders from WooCommerce...');
  const orders = await fetchAllOrders();
  console.log(`Fetched ${orders.length} orders\n`);

  const SKIP_STATUS = ['refunded', 'cancelled', 'failed', 'pending', 'on-hold'];
  const PROTECTED_STATUSES = ['shipped', 'delivered'];

  let contactsCreated = 0;
  let ordersInserted = 0;
  let statusesUpdated = 0;
  let trackingStored = 0;
  let confirmSent = 0;
  let confirmFailed = 0;
  let shippedSent = 0;
  let shippedFailed = 0;
  let skipped = 0;

  for (const order of orders) {
    let phone = normalizePhone(order.billing?.phone);

    // Fallback: look up phone by billing email in local DB then GHL
    if (!phone && order.billing?.email) {
      const email = order.billing.email;
      try {
        const { data: local } = await supabase
          .from('sms_contacts')
          .select('phone')
          .eq('email', email)
          .maybeSingle();
        if (local?.phone) { phone = local.phone; console.log(`  Order #${order.id}: phone via local DB for ${email}`); }
      } catch {}

      if (!phone) {
        try {
          const ghlContact = await searchContactByEmail(email);
          phone = normalizePhone(ghlContact?.phone) || null;
          if (phone) console.log(`  Order #${order.id}: phone via GHL for ${email} → ${phone}`);
        } catch {}
      }
    }

    if (!phone) {
      console.log(`  Order #${order.id}: no phone anywhere (billing, DB, GHL) — skipped`);
      skipped++;
      continue;
    }

    const firstName = order.billing?.first_name || '';
    const lastName  = order.billing?.last_name  || '';
    const name      = [firstName, lastName].filter(Boolean).join(' ') || null;
    const resolvedFirst = firstName || name?.split(' ')?.[0] || 'there';

    // ── 1. Upsert contact ───────────────────────────────────────────────────
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
          email:           order.billing?.email   || null,
          city:            order.billing?.city     || null,
          state:           order.billing?.state    || null,
          country:         order.billing?.country  || null,
          woo_customer_id: order.customer_id       || null,
          last_seen:       order.date_modified || order.date_created || new Date().toISOString()
        }, { onConflict: 'phone' });
      }
      console.log(`  [NEW CONTACT] ${name || phone}  (${phone})`);
      contactsCreated++;
    }

    // ── 2. Extract tracking ─────────────────────────────────────────────────
    const tracking = extractTracking(order);
    const hasTracking = !!tracking?.trackingNumber;

    // ── 3. Upsert order record ──────────────────────────────────────────────
    const items = (order.line_items || []).map(i => ({
      name: i.name, quantity: i.quantity, total: i.total, sku: i.sku || null
    }));

    const neverShips = SKIP_STATUS.includes(order.status);

    const { data: existingOrder } = await supabase
      .from('sms_orders')
      .select('id, status, order_sms_sent, shipped_sms_sent, delivery_sms_sent, tracking_number')
      .eq('woo_order_id', order.id)
      .maybeSingle();

    if (!existingOrder) {
      // Brand new — insert with SMS flags as false so we can send below
      if (!DRY_RUN) {
        await supabase.from('sms_orders').insert({
          contact_phone:     phone,
          woo_order_id:      order.id,
          status:            hasTracking ? 'shipped' : (order.status || 'pending'),
          items,
          total:             parseFloat(order.total) || 0,
          tracking_number:   tracking?.trackingNumber || null,
          carrier:           tracking?.carrier || null,
          shipped_at:        tracking?.shippedDate || (hasTracking ? new Date().toISOString() : null),
          created_at:        order.date_created || new Date().toISOString(),
          order_sms_sent:    neverShips,
          shipped_sms_sent:  neverShips,
          delivery_sms_sent: neverShips
        });
      }
      console.log(`  [NEW ORDER] #${order.id}  ${name || phone}  status=${order.status}${hasTracking ? `  tracking=${tracking.trackingNumber}` : ''}`);
      ordersInserted++;
    } else {
      // Update status + tracking if needed
      const updateFields = {
        contact_phone: phone,
        items,
        total: parseFloat(order.total) || 0
      };

      // Don't downgrade our internal shipped/delivered status
      if (!PROTECTED_STATUSES.includes(existingOrder.status)) {
        const newStatus = hasTracking ? 'shipped' : (order.status || 'pending');
        if (newStatus !== existingOrder.status) {
          updateFields.status = newStatus;
          statusesUpdated++;
          console.log(`  [STATUS UPDATE] Order #${order.id}  ${existingOrder.status} → ${newStatus}`);
        }
      }

      // Store tracking if we now have it
      if (hasTracking && !existingOrder.tracking_number) {
        updateFields.tracking_number = tracking.trackingNumber;
        updateFields.carrier = tracking.carrier || null;
        if (tracking.shippedDate) updateFields.shipped_at = tracking.shippedDate;
        trackingStored++;
        console.log(`  [TRACKING STORED] Order #${order.id}  ${tracking.carrier || 'unknown'} ${tracking.trackingNumber}`);
      }

      if (!DRY_RUN && Object.keys(updateFields).length > 2) {
        await supabase.from('sms_orders').update(updateFields).eq('woo_order_id', order.id);
      }
    }

    if (STATUS_ONLY) continue;

    // ── 4. Send missing order confirmation SMS (Message 1) ──────────────────
    // Safety: only send for orders placed within the last 21 days.
    // Older orders are likely already delivered — messaging them about packing is wrong.
    const orderRow = existingOrder || { order_sms_sent: neverShips, shipped_sms_sent: neverShips };
    const orderAgeDays = order.date_created
      ? (Date.now() - new Date(order.date_created).getTime()) / 86400000
      : 999;
    const needsConfirmSMS = !orderRow.order_sms_sent
      && ['processing', 'completed'].includes(order.status)
      && orderAgeDays <= 21;

    if (needsConfirmSMS) {
      const msg = ORDER_SMS(resolvedFirst);

      // Atomically claim the flag — safe against concurrent runs
      let canSend = true;
      if (!DRY_RUN && existingOrder) {
        const { data: claimed } = await supabase
          .from('sms_orders')
          .update({ order_sms_sent: true })
          .eq('woo_order_id', order.id)
          .eq('order_sms_sent', false)
          .select('id');
        canSend = !!claimed?.length;
      } else if (!DRY_RUN && !existingOrder) {
        await supabase.from('sms_orders').update({ order_sms_sent: true }).eq('woo_order_id', order.id);
      }

      if (canSend) {
        try {
          await sendAndRecord(phone, msg, 'order confirmation');
          console.log(`  ✓ Confirmation SMS → ${name || phone}  order #${order.id}`);
          confirmSent++;
        } catch (err) {
          if (!DRY_RUN) {
            await supabase.from('sms_orders').update({ order_sms_sent: false }).eq('woo_order_id', order.id);
          }
          console.error(`  ✗ Confirmation SMS FAILED → ${phone}  order #${order.id}: ${err.message}`);
          confirmFailed++;
        }
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // ── 5. Send missing shipped SMS (Message 2) ─────────────────────────────
    // ONLY send if the tracking number came from WooCommerce meta_data RIGHT NOW.
    // Never send shipped SMS based on a historical tracking_number stored in our DB —
    // those customers have already received their orders.
    const needsShippedSMS = hasTracking && !orderRow.shipped_sms_sent && !neverShips && orderAgeDays <= 21;

    if (needsShippedSMS) {
      const carrier = tracking.carrier;
      const trackingNum = tracking.trackingNumber;
      const trackingUrl = buildTrackingUrl(carrier, trackingNum);
      const msg = SHIPPED_SMS(resolvedFirst, carrier, trackingNum, trackingUrl);

      let canSend = true;
      if (!DRY_RUN && existingOrder) {
        const { data: claimed } = await supabase
          .from('sms_orders')
          .update({ shipped_sms_sent: true })
          .eq('woo_order_id', order.id)
          .eq('shipped_sms_sent', false)
          .select('id');
        canSend = !!claimed?.length;
      } else if (!DRY_RUN && !existingOrder) {
        await supabase.from('sms_orders').update({ shipped_sms_sent: true }).eq('woo_order_id', order.id);
      }

      if (canSend) {
        try {
          await sendAndRecord(phone, msg, 'shipped notification');
          console.log(`  ✓ Shipped SMS → ${name || phone}  order #${order.id}  tracking ${trackingNum}`);
          shippedSent++;
        } catch (err) {
          if (!DRY_RUN) {
            await supabase.from('sms_orders').update({ shipped_sms_sent: false }).eq('woo_order_id', order.id);
          }
          console.error(`  ✗ Shipped SMS FAILED → ${phone}  order #${order.id}: ${err.message}`);
          shippedFailed++;
        }
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log(`  Contacts created:        ${contactsCreated}`);
  console.log(`  Orders inserted:         ${ordersInserted}`);
  console.log(`  Statuses updated:        ${statusesUpdated}`);
  console.log(`  Tracking numbers stored: ${trackingStored}`);
  if (!STATUS_ONLY) {
    console.log(`  Confirmation SMS sent:   ${confirmSent}`);
    console.log(`  Shipped SMS sent:        ${shippedSent}`);
    if (confirmFailed > 0) console.log(`  Confirmation failed:     ${confirmFailed}`);
    if (shippedFailed  > 0) console.log(`  Shipped failed:          ${shippedFailed}`);
  }
  if (skipped > 0) console.log(`  No phone (skipped):      ${skipped}`);
  if (DRY_RUN) console.log('\n  Re-run without --dry-run to actually send.');
  console.log('═══════════════════════════════════════════════════\n');

  process.exit((confirmFailed + shippedFailed) > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err.message, err.stack);
  process.exit(1);
});
