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
const { normaliseTelnyxStatus } = require('../lib/message-status');
const { logAuditSafely } = require('../lib/audit/log');

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

/**
 * One audit row per catch-up run, never one per recipient.
 *
 * This is the highest blast-radius endpoint in the application: a single POST
 * sends real SMS to every customer in the unanswered backlog, with no
 * confirmation step and no undo. lib/route-policy.js has always flagged it
 * `audit: true`; until now that flag wrote nothing, so the only record of a
 * run was the individual sms_messages rows, which look identical to ordinary
 * automation traffic.
 *
 * Per-recipient rows are deliberately not written: a backlog run can cover
 * hundreds of orders, and hundreds of audit rows would bury the one fact a
 * reader needs, which is that a person pressed this button and how far it got.
 * The individual messages remain in sms_messages.
 *
 * Safe-logged, and awaited only after the sends: the customers have already
 * been messaged by this point, so a failed audit insert must not turn a
 * completed run into a 500 that invites somebody to run it again.
 */
async function auditCatchupRun(req, { sent, failed, results, processingCandidates, shippedCandidates, error = null }) {
  const skipped = results.filter(entry => entry.status === 'skipped').length;
  const outcome = error ? ' before the run failed' : '';
  await logAuditSafely({
    eventType: 'message.catchup.sent',
    req,
    entityId: `catchup:${new Date().toISOString()}`,
    summary: `Ran the catch-up sender${outcome}: ${sent} message(s) sent, ${failed} failed, ${skipped} skipped, from ${processingCandidates} order and ${shippedCandidates} shipped candidate(s)`,
    metadata: {
      sent,
      failed,
      skipped,
      processing_candidates: processingCandidates,
      shipped_candidates: shippedCandidates,
      source: 'manual_catchup'
    }
  });
}

// Execute catch-up sends
router.post('/send', async (req, res) => {
  let sent = 0;
  let failed = 0;
  let processingCandidates = 0;
  let shippedCandidates = 0;
  const results = [];

  try {
    // --- Processing + completed orders (both mean paid, need order confirmation SMS) ---
    const { data: processingOrders } = await supabase
      .from('sms_orders')
      .select('id, contact_phone, woo_order_id, status')
      .in('status', ['processing', 'completed'])
      .eq('order_sms_sent', false);
    processingCandidates = processingOrders?.length || 0;

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
        const { messageId, status: providerStatus } = await sendSMS(order.contact_phone, msg);
        await supabase.from('sms_messages').insert({
          telnyx_message_id: messageId,
          contact_phone: order.contact_phone,
          direction: 'outbound',
          body: msg,
          status: normaliseTelnyxStatus(providerStatus),
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
    shippedCandidates = shippedOrders?.length || 0;

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
        const { messageId, status: providerStatus } = await sendSMS(order.contact_phone, msg);
        await supabase.from('sms_messages').insert({
          telnyx_message_id: messageId,
          contact_phone: order.contact_phone,
          direction: 'outbound',
          body: msg,
          status: normaliseTelnyxStatus(providerStatus),
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

    await auditCatchupRun(req, { sent, failed, results, processingCandidates, shippedCandidates });
    res.json({ sent, failed, results });
  } catch (err) {
    // Audit what actually went out before the run died. A partial catch-up has
    // already messaged real customers, and that is precisely the run somebody
    // will need to reconstruct later.
    await auditCatchupRun(req, { sent, failed, results, processingCandidates, shippedCandidates, error: err });
    res.status(500).json({ error: err.message, sent, failed });
  }
});

module.exports = router;
