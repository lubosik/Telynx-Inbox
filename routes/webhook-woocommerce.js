const crypto = require('crypto');
const { supabase } = require('../db');
const { syncOrder, runWooSync } = require('../sync-woocommerce');
const { normalizePhone, wooGet } = require('../woocommerce');
const { searchContactByEmail } = require('../ghl');

// SMS flows
const { handleOrderFailed, handleOrderRecovered } = require('../flows/failed');
const { handleOrderOnHold }                       = require('../flows/hold');
const { handleOrderConfirmed }                    = require('../flows/confirmed');
const { cancelScheduled }                         = require('../flows/utils');

// Resolve a phone number for an order using multiple fallbacks:
// 1. WooCommerce billing.phone
// 2. WooCommerce customer account phone
// 3. Our local sms_contacts table matched by billing email (repeat customers)
// 4. GHL contact matched by billing email (customers who opted in via funnel)
async function resolvePhone(order) {
  // 1. Direct billing phone
  const fromBilling = normalizePhone(order.billing?.phone);
  if (fromBilling) return fromBilling;

  // 2. WooCommerce customer account
  if (order.customer_id) {
    try {
      const { data: cust } = await wooGet('/customers/' + order.customer_id);
      const custPhone = normalizePhone(cust.billing?.phone);
      if (custPhone) return custPhone;
    } catch {}
  }

  const email = order.billing?.email;
  if (!email) return null;

  // 3. Local contacts DB by email (fast, no API call)
  try {
    const { data: localContact } = await supabase
      .from('sms_contacts')
      .select('phone')
      .eq('email', email)
      .maybeSingle();
    if (localContact?.phone) {
      console.log(`resolvePhone: found ${email} in local DB → ${localContact.phone}`);
      return localContact.phone;
    }
  } catch {}

  // 4. GHL lookup by email (customers who came through funnel but didn't enter phone at checkout)
  try {
    const ghlContact = await searchContactByEmail(email);
    const ghlPhone = normalizePhone(ghlContact?.phone);
    if (ghlPhone) {
      console.log(`resolvePhone: found ${email} in GHL → ${ghlPhone}`);
      return ghlPhone;
    }
  } catch {}

  return null;
}

// Message templates moved to flows/confirmed.js and flows/shipped.js

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
    // Respond 200 immediately — WooCommerce retries if no quick ack
    res.sendStatus(200);

    try {
      const sig = req.headers['x-wc-webhook-signature'];
      if (sig && process.env.WC_WEBHOOK_SECRET) {
        if (!verifyWooSignature(req.body, sig, process.env.WC_WEBHOOK_SECRET)) {
          console.warn('WooCommerce webhook signature mismatch — processing anyway');
        }
      }

      const order  = JSON.parse(req.body.toString());
      const topic  = req.headers['x-wc-webhook-topic'] || 'unknown';
      const status = order.status;
      const orderId = String(order.id);

      console.log(`[WEBHOOK] WooCommerce | topic=${topic} order=${orderId} status=${status}`);

      // Sync contact + order record (preserves existing SMS flags)
      await syncOrder(order, { fromWebhook: true });

      switch (status) {
        case 'failed':
          await handleOrderFailed(order);
          break;

        case 'on-hold':
          await handleOrderOnHold(order);
          break;

        case 'processing':
        case 'completed':
          // Cancel any failed/hold sequences (order recovered)
          await handleOrderRecovered(orderId);
          // Send confirmed SMS (deduped — fires once per order)
          await handleOrderConfirmed(order);
          break;

        case 'cancelled':
        case 'refunded':
          // Cancel any pending sequences for this order
          await cancelScheduled(orderId);
          break;

        default:
          console.log(`[WEBHOOK] WooCommerce status=${status} | order=${orderId} — no SMS flow`);
      }
    } catch (err) {
      console.error('[WEBHOOK] WooCommerce handler error:', err.message, err.stack);
    }
  });

  return router;
};
