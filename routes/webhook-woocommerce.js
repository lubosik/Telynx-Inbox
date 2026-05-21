const crypto = require('crypto');
const { supabase } = require('../db');
const { sendSMS } = require('../telnyx');
const { syncOrder, runWooSync } = require('../sync-woocommerce');
const { normalizePhone, wooGet } = require('../woocommerce');

async function resolvePhone(order) {
  const fromBilling = normalizePhone(order.billing?.phone);
  if (fromBilling) return fromBilling;
  if (!order.customer_id) return null;
  try {
    const { data: cust } = await wooGet('/customers/' + order.customer_id);
    return normalizePhone(cust.billing?.phone) || null;
  } catch { return null; }
}

const ORDER_PROCESSING_SMS = (firstName, orderNum, total) =>
  `Hey ${firstName}! It's Dom, founder of Vici Peptides. Huge thank you for your order - it genuinely means everything to me. We're getting it packed up right now and I'll personally text you the moment it ships!`;

function verifyWooSignature(rawBody, signature, secret) {
  try {
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
    return signature === expected;
  } catch { return false; }
}

module.exports = (broadcastSSE) => {
  const router = require('express').Router();

  router.post('/woocommerce', async (req, res) => {
    res.sendStatus(200);
    try {
      const sig = req.headers['x-wc-webhook-signature'];
      if (sig && process.env.WC_WEBHOOK_SECRET) {
        if (!verifyWooSignature(req.body, sig, process.env.WC_WEBHOOK_SECRET)) {
          console.warn('WooCommerce webhook signature mismatch — processing anyway');
        }
      }

      const order = JSON.parse(req.body.toString());
      const topic = req.headers['x-wc-webhook-topic'] || 'unknown';
      console.log(`WooCommerce webhook: ${topic} — order #${order.id} status=${order.status} phone=${order.billing?.phone || 'NONE'}`);

      // Sync contact and order data — fromWebhook:true preserves SMS flags for live orders
      await syncOrder(order, { fromWebhook: true });

      // Only fire SMS when transitioning to "processing"
      if (order.status !== 'processing') return;

      const phone = await resolvePhone(order);
      if (!phone) {
        console.warn(`WooCommerce order #${order.id}: no phone in billing or customer profile — SMS skipped`);
        return;
      }

      // Guard against duplicate processing SMS
      const { data: existingOrder } = await supabase
        .from('sms_orders')
        .select('order_sms_sent')
        .eq('woo_order_id', order.id)
        .maybeSingle();

      if (existingOrder?.order_sms_sent) {
        console.log(`Order #${order.id}: processing SMS already sent, skipping`);
        return;
      }

      const firstName = order.billing?.first_name || 'there';
      const msg = ORDER_PROCESSING_SMS(firstName, order.number || order.id, order.total || '0');

      const { messageId } = await sendSMS(phone, msg);

      await supabase.from('sms_messages').insert({
        telnyx_message_id: messageId,
        contact_phone: phone,
        direction: 'outbound',
        body: msg,
        status: 'sent',
        created_at: new Date().toISOString()
      });

      await supabase.from('sms_orders')
        .update({ order_sms_sent: true })
        .eq('woo_order_id', order.id);

      await supabase.from('sms_contacts')
        .update({ last_seen: new Date().toISOString() })
        .eq('phone', phone);

      broadcastSSE({ type: 'new_message', phone, body: msg, direction: 'outbound' });
      console.log(`Order processing SMS sent to ${phone} for order #${order.id}`);
    } catch (err) {
      console.error('WooCommerce webhook error:', err.message, err.stack);
    }
  });

  return router;
};
