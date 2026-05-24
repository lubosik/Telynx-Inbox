const crypto = require('crypto');
const { supabase } = require('../db');
const { sendSMS } = require('../telnyx');
const { syncOrder, runWooSync } = require('../sync-woocommerce');
const { normalizePhone, wooGet, extractTracking, buildTrackingUrl } = require('../woocommerce');
const { searchContactByEmail } = require('../ghl');

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

const ORDER_PROCESSING_SMS = (firstName) =>
  `Hey ${firstName}! It's Dom, founder of Vici Peptides. Huge thank you for your order - it genuinely means everything to me. We're getting it packed up right now and I'll personally text you the moment it ships!`;

const SHIPPED_SMS = (firstName, carrier, trackingNumber, trackingUrl) => {
  let msg = `Hey ${firstName}! It's Dom from Vici Peptides. Your order is officially on its way to you!`;
  if (trackingUrl) msg += ` You can track it right here: ${trackingUrl}`;
  else if (trackingNumber) msg += ` Tracking number: ${trackingNumber}`;
  msg += ' Reach out anytime if you need me. Reply STOP to opt out.';
  return msg;
};

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

      const phone = await resolvePhone(order);
      if (!phone) {
        console.warn(`WooCommerce order #${order.id}: no phone in billing or customer profile — SMS skipped`);
        return;
      }

      const firstName = order.billing?.first_name || 'there';

      // ── MESSAGE 1: Order confirmation ──────────────────────────────────────
      // Fires once when order first hits processing or completed (paid + being packed).
      // Atomic flag prevents any double-send even if both statuses fire webhooks.
      if (['processing', 'completed'].includes(order.status)) {
        const { data: claimed, error: claimErr } = await supabase
          .from('sms_orders')
          .update({ order_sms_sent: true })
          .eq('woo_order_id', order.id)
          .eq('order_sms_sent', false)
          .select('id');

        if (claimErr) {
          console.error(`Order #${order.id}: claim update error — ${claimErr.message}`);
        } else if (claimed?.length) {
          const msg = ORDER_PROCESSING_SMS(firstName);
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
            await supabase.from('sms_contacts').update({ last_seen: new Date().toISOString() }).eq('phone', phone);
            broadcastSSE({ type: 'new_message', phone, body: msg, direction: 'outbound' });
            console.log(`Order confirmation SMS → ${phone} order #${order.id}`);
          } catch (smsErr) {
            await supabase.from('sms_orders').update({ order_sms_sent: false }).eq('woo_order_id', order.id);
            console.error(`Order confirmation SMS failed for #${order.id}:`, smsErr.message);
          }
        } else {
          console.log(`Order #${order.id}: confirmation SMS already sent — skipping`);
        }
      }

      // ── MESSAGE 2: Shipped notification ───────────────────────────────────
      // Fires when a tracking number appears in WooCommerce order meta_data.
      // This happens when the 3PL/warehouse enters the tracking number in WooCommerce.
      // Atomic flag ensures exactly one shipped SMS per order regardless of how many
      // order.updated webhooks fire.
      const tracking = extractTracking(order);
      if (tracking?.trackingNumber) {
        console.log(`Order #${order.id}: tracking found — ${tracking.carrier} ${tracking.trackingNumber}`);

        // Store tracking in DB (only if not already set — avoid overwrite on repeated webhooks)
        await supabase.from('sms_orders')
          .update({
            tracking_number: tracking.trackingNumber,
            carrier: tracking.carrier || null,
            status: 'shipped',
            shipped_at: tracking.shippedDate || new Date().toISOString()
          })
          .eq('woo_order_id', order.id)
          .is('tracking_number', null); // idempotent — only update if not already set

        // Atomically claim the shipped SMS
        const { data: shippedClaimed, error: shippedErr } = await supabase
          .from('sms_orders')
          .update({ shipped_sms_sent: true })
          .eq('woo_order_id', order.id)
          .eq('shipped_sms_sent', false)
          .select('id');

        if (shippedErr) {
          console.error(`Order #${order.id}: shipped SMS claim error — ${shippedErr.message}`);
        } else if (shippedClaimed?.length) {
          const trackingUrl = buildTrackingUrl(tracking.carrier, tracking.trackingNumber);
          const msg = SHIPPED_SMS(firstName, tracking.carrier, tracking.trackingNumber, trackingUrl);
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
            await supabase.from('sms_contacts').update({ last_seen: new Date().toISOString() }).eq('phone', phone);
            broadcastSSE({ type: 'new_message', phone, body: msg, direction: 'outbound' });
            console.log(`Shipped SMS → ${phone} order #${order.id} tracking ${tracking.trackingNumber}`);
          } catch (smsErr) {
            await supabase.from('sms_orders').update({ shipped_sms_sent: false }).eq('woo_order_id', order.id);
            console.error(`Shipped SMS failed for order #${order.id}:`, smsErr.message);
          }
        } else {
          console.log(`Order #${order.id}: shipped SMS already sent — skipping`);
        }
      }
    } catch (err) {
      console.error('WooCommerce webhook error:', err.message, err.stack);
    }
  });

  return router;
};
