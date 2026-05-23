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

  // customer.created + customer.updated — single endpoint, both topics point here
  router.post('/woocommerce-customer', async (req, res) => {
    res.sendStatus(200);
    try {
      const sig = req.headers['x-wc-webhook-signature'];
      if (sig && process.env.WC_WEBHOOK_SECRET) {
        if (!verifyWooSignature(req.body, sig, process.env.WC_WEBHOOK_SECRET)) {
          console.warn('WooCommerce customer webhook signature mismatch — processing anyway');
        }
      }

      const customer = JSON.parse(req.body.toString());
      const topic = req.headers['x-wc-webhook-topic'] || 'customer.unknown';
      console.log(`WooCommerce ${topic} — customer #${customer.id} email=${customer.email}`);

      const phone = normalizePhone(customer.billing?.phone || customer.phone);
      if (!phone) {
        console.warn(`${topic} #${customer.id}: no valid phone — skipping`);
        return;
      }

      const firstName = customer.billing?.first_name || customer.first_name || '';
      const lastName  = customer.billing?.last_name  || customer.last_name  || '';
      const name      = [firstName, lastName].filter(Boolean).join(' ') || null;
      const email     = customer.billing?.email || customer.email || null;
      const city      = customer.billing?.city    || null;
      const state     = customer.billing?.state   || null;
      const country   = customer.billing?.country || null;
      const wooId     = customer.id || null;

      // Check if contact already exists (match by phone or woo_customer_id)
      const { data: existing } = await supabase
        .from('sms_contacts')
        .select('phone, name, email, city, state, country, woo_customer_id')
        .or(`phone.eq.${phone}${wooId ? `,woo_customer_id.eq.${wooId}` : ''}`)
        .maybeSingle();

      if (!existing) {
        // Brand new contact
        await supabase.from('sms_contacts').upsert({
          phone, name, email, city, state, country,
          woo_customer_id: wooId,
          last_seen: new Date().toISOString()
        }, { onConflict: 'phone' });

        broadcastSSE({ type: 'contact_added', phone, name });
        console.log(`${topic}: new contact created — ${phone} (${name})`);
        return;
      }

      // Contact exists — build diff, only write fields that actually changed
      const updates = {};
      if (name    && name    !== existing.name)    updates.name    = name;
      if (email   && email   !== existing.email)   updates.email   = email;
      if (city    && city    !== existing.city)     updates.city    = city;
      if (state   && state   !== existing.state)   updates.state   = state;
      if (country && country !== existing.country) updates.country = country;
      if (wooId   && wooId   !== existing.woo_customer_id) updates.woo_customer_id = wooId;

      if (Object.keys(updates).length === 0) {
        console.log(`${topic}: contact ${phone} already up to date — no changes`);
        return;
      }

      updates.last_seen = new Date().toISOString();

      await supabase.from('sms_contacts')
        .update(updates)
        .eq('phone', existing.phone);

      broadcastSSE({ type: 'contact_updated', phone: existing.phone, updates });
      console.log(`${topic}: updated contact ${existing.phone} — changed fields: ${Object.keys(updates).filter(k => k !== 'last_seen').join(', ')}`);
    } catch (err) {
      console.error('WooCommerce customer webhook error:', err.message, err.stack);
    }
  });

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

      // Fire SMS on "processing" (paid, being packed) OR "completed" (paid, may ship same day)
      if (!['processing', 'completed'].includes(order.status)) return;

      const phone = await resolvePhone(order);
      if (!phone) {
        console.warn(`WooCommerce order #${order.id}: no phone in billing or customer profile — SMS skipped`);
        return;
      }

      // Atomically claim this SMS send — only the first concurrent request wins.
      // UPDATE WHERE order_sms_sent = false returns 0 rows if already sent (race-safe).
      const { data: claimed, error: claimErr } = await supabase
        .from('sms_orders')
        .update({ order_sms_sent: true })
        .eq('woo_order_id', order.id)
        .eq('order_sms_sent', false)
        .select('id');

      if (claimErr) {
        console.error(`Order #${order.id}: claim update error — ${claimErr.message}`);
        return;
      }
      if (!claimed?.length) {
        console.log(`Order #${order.id}: processing SMS already sent or claimed — skipping`);
        return;
      }

      const firstName = order.billing?.first_name || 'there';
      const msg = ORDER_PROCESSING_SMS(firstName, order.number || order.id, order.total || '0');

      try {
        const { messageId } = await sendSMS(phone, msg);
        await supabase.from('sms_messages').insert({
          telnyx_message_id: messageId,
          contact_phone: phone,
          direction: 'outbound',
          body: msg,
          status: 'sent',
          created_at: new Date().toISOString()
        });
        await supabase.from('sms_contacts')
          .update({ last_seen: new Date().toISOString() })
          .eq('phone', phone);
        broadcastSSE({ type: 'new_message', phone, body: msg, direction: 'outbound' });
        console.log(`Order processing SMS sent to ${phone} for order #${order.id}`);
      } catch (smsErr) {
        // Roll back the claim so a retry can attempt again
        await supabase.from('sms_orders').update({ order_sms_sent: false }).eq('woo_order_id', order.id);
        console.error(`WooCommerce SMS send failed for order #${order.id}:`, smsErr.message);
      }
    } catch (err) {
      console.error('WooCommerce webhook error:', err.message, err.stack);
    }
  });

  return router;
};
