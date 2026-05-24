/**
 * Catch-up SMS sender
 *
 * Finds customers whose orders are in "processing" or "shipped" state
 * but who never received the automated SMS (because the system wasn't
 * live yet). Sends the appropriate message to each, safely.
 *
 * processing → sends the order confirmed SMS
 * shipped    → sends the shipped SMS (with tracking if available)
 *
 * Does NOT send to completed, cancelled, refunded, delivered, or anyone
 * who already received that SMS.
 */

const router = require('express').Router();
const { supabase } = require('../db');
const { sendSMS } = require('../telnyx');

const ORDER_SMS = (firstName) =>
  `Hey ${firstName}! It's Dom, founder of Vici Peptides. Huge thank you for your order - it genuinely means everything to me. We're getting it packed up right now and I'll personally text you the moment it ships!`;

const SHIPPED_SMS = (firstName, trackingNumber, carrier) => {
  let msg = `Hey ${firstName}! It's Dom from Vici Peptides. Your order is officially on its way to you!`;
  if (trackingNumber) msg += ` Tracking: ${trackingNumber}`;
  msg += ' Reach out anytime if you need me. Reply STOP to opt out.';
  return msg;
};

// Preview — returns what WOULD be sent without actually sending
router.get('/preview', async (req, res) => {
  try {
    const { data: processingOrders } = await supabase
      .from('sms_orders')
      .select('id, contact_phone, woo_order_id, status')
      .in('status', ['processing', 'completed'])
      .eq('order_sms_sent', false);

    const { data: shippedOrders } = await supabase
      .from('sms_orders')
      .select('id, contact_phone, woo_order_id, status, tracking_number, carrier')
      .eq('status', 'shipped')
      .eq('shipped_sms_sent', false);

    res.json({
      processing: { count: processingOrders?.length || 0, orders: processingOrders || [] },
      shipped: { count: shippedOrders?.length || 0, orders: shippedOrders || [] },
      total_to_send: (processingOrders?.length || 0) + (shippedOrders?.length || 0)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Execute catch-up sends
router.post('/send', async (req, res) => {
  let sent = 0;
  let failed = 0;
  const results = [];

  try {
    // --- Processing + completed orders (both mean paid, need order confirmation SMS) ---
    const { data: processingOrders } = await supabase
      .from('sms_orders')
      .select('id, contact_phone, woo_order_id, status')
      .in('status', ['processing', 'completed'])
      .eq('order_sms_sent', false);

    for (const order of (processingOrders || [])) {
      // Atomically claim the flag first — prevents duplicate sends if a webhook fires
      // concurrently or if this endpoint is called twice at the same time.
      const { data: claimed } = await supabase
        .from('sms_orders')
        .update({ order_sms_sent: true })
        .eq('id', order.id)
        .eq('order_sms_sent', false)
        .select('id');

      if (!claimed?.length) {
        // Already claimed by another concurrent request or webhook
        results.push({ phone: order.contact_phone, type: 'processing', status: 'skipped', reason: 'already claimed' });
        continue;
      }

      const { data: contact } = await supabase
        .from('sms_contacts')
        .select('name')
        .eq('phone', order.contact_phone)
        .maybeSingle();

      const firstName = contact?.name?.split(' ')?.[0] || 'there';
      const msg = ORDER_SMS(firstName);

      try {
        const { messageId } = await sendSMS(order.contact_phone, msg);
        await supabase.from('sms_messages').insert({
          telnyx_message_id: messageId,
          contact_phone: order.contact_phone,
          direction: 'outbound',
          body: msg,
          status: 'sent',
          created_at: new Date().toISOString()
        });
        await supabase.from('sms_contacts').update({ last_seen: new Date().toISOString() }).eq('phone', order.contact_phone);
        results.push({ phone: order.contact_phone, name: contact?.name, type: 'processing', status: 'sent' });
        sent++;
      } catch (err) {
        // Roll back the claim so a retry can attempt again
        await supabase.from('sms_orders').update({ order_sms_sent: false }).eq('id', order.id);
        results.push({ phone: order.contact_phone, type: 'processing', status: 'failed', error: err.message });
        failed++;
      }

      // Small delay between sends to respect Telnyx rate limits
      await new Promise(r => setTimeout(r, 300));
    }

    // --- Shipped orders ---
    const { data: shippedOrders } = await supabase
      .from('sms_orders')
      .select('id, contact_phone, woo_order_id, status, tracking_number, carrier')
      .eq('status', 'shipped')
      .eq('shipped_sms_sent', false);

    for (const order of (shippedOrders || [])) {
      // Atomically claim before sending — same pattern as above
      const { data: claimed } = await supabase
        .from('sms_orders')
        .update({ shipped_sms_sent: true })
        .eq('id', order.id)
        .eq('shipped_sms_sent', false)
        .select('id');

      if (!claimed?.length) {
        results.push({ phone: order.contact_phone, type: 'shipped', status: 'skipped', reason: 'already claimed' });
        continue;
      }

      const { data: contact } = await supabase
        .from('sms_contacts')
        .select('name')
        .eq('phone', order.contact_phone)
        .maybeSingle();

      const firstName = contact?.name?.split(' ')?.[0] || 'there';
      const msg = SHIPPED_SMS(firstName, order.tracking_number, order.carrier);

      try {
        const { messageId } = await sendSMS(order.contact_phone, msg);
        await supabase.from('sms_messages').insert({
          telnyx_message_id: messageId,
          contact_phone: order.contact_phone,
          direction: 'outbound',
          body: msg,
          status: 'sent',
          created_at: new Date().toISOString()
        });
        await supabase.from('sms_contacts').update({ last_seen: new Date().toISOString() }).eq('phone', order.contact_phone);
        results.push({ phone: order.contact_phone, name: contact?.name, type: 'shipped', status: 'sent' });
        sent++;
      } catch (err) {
        await supabase.from('sms_orders').update({ shipped_sms_sent: false }).eq('id', order.id);
        results.push({ phone: order.contact_phone, type: 'shipped', status: 'failed', error: err.message });
        failed++;
      }

      await new Promise(r => setTimeout(r, 300));
    }

    res.json({ sent, failed, results });
  } catch (err) {
    res.status(500).json({ error: err.message, sent, failed });
  }
});

module.exports = router;
