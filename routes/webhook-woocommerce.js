const { supabase } = require('../db');
const { syncOrder, runWooSync } = require('../sync-woocommerce');
const { recordWooOrderEvent } = require('../lib/analytics/events');
const { normalizePhone, wooGet } = require('../woocommerce');
const { searchContactByEmail } = require('../ghl');
const { verifyWooSignature, wooDeliveryID } = require('../lib/woocommerce-webhook');
const { recordTrustedProductEvent } = require('../lib/campaigns/product-webhooks');
const { captureCheckoutConsent } = require('../lib/campaigns/checkout-consent');

// SMS flows
const { handleOrderFailed, handleOrderRecovered } = require('../flows/failed');
const { handleOrderOnHold }                       = require('../flows/hold');
const { handleOrderConfirmed, handleOrderShipped } = require('../flows/confirmed');
const { cancelScheduled, cancelScheduledForCustomer } = require('../flows/utils');

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
      let signatureValid = false;
      if (sig && process.env.WC_WEBHOOK_SECRET) {
        signatureValid = verifyWooSignature(req.body, sig, process.env.WC_WEBHOOK_SECRET);
        if (!signatureValid) {
          console.warn('WooCommerce webhook signature mismatch — processing anyway');
        }
      }

      const order  = JSON.parse(req.body.toString());
      const topic  = req.headers['x-wc-webhook-topic'] || 'unknown';
      const status = order.status;
      const orderId = String(order.id);

      console.log(`[WEBHOOK] WooCommerce | topic=${topic} order=${orderId} status=${status}`);

      // Promotional SMS consent evidence, captured only from a live checkout.
      //
      // This sits BEFORE the first await in the handler and is deliberately not
      // awaited. Not awaited, because a consent write must never delay or fail
      // an order confirmation; first, because EVERY await below — `syncOrder`
      // included — throws into the same outer catch, and anything sequenced
      // after one of them is silently skipped on the failure path. This line
      // used to sit under `await syncOrder(...)`, where a sync failure dropped
      // the customer's tick exactly as this comment claimed it could not.
      //
      // It is safe to run on every topic and status: the ledger dedupes on the
      // order id, so `order.updated` firing five times still writes once.
      //
      // Historical bulk syncs do NOT reach this line, and must not. See
      // docs/campaigns/CONSENT-CAPTURE.md.
      void captureCheckoutConsent({
        client: supabase,
        order,
        secretConfigured: Boolean(process.env.WC_WEBHOOK_SECRET),
        signatureValid
      });

      // Sync contact + order record (preserves existing SMS flags)
      const sync = await syncOrder(order, { fromWebhook: true });
      const phone = sync?.phone;

      // Broadcast real-time status update to connected UI clients
      if (phone && status !== 'pending') {
        broadcastSSE({ type: 'order_status_updated', phone, status, order_id: orderId });
      }

      switch (status) {
        case 'failed':
          await handleOrderFailed(order);
          break;

        case 'on-hold':
          await handleOrderOnHold(order);
          break;

        case 'processing': {
          // Payment received — cancel any pending failed/hold flows, send confirmation
          await handleOrderRecovered(orderId);
          if (phone) await cancelScheduledForCustomer(phone);
          await handleOrderConfirmed(order);
          break;
        }

        case 'completed': {
          // Order shipped — cancel any remaining failed/hold flows, send tracking SMS
          await handleOrderRecovered(orderId);
          if (phone) await cancelScheduledForCustomer(phone);
          await handleOrderShipped(order);
          break;
        }

        case 'cancelled':
        case 'refunded': {
          // Cancel by order_id (catches normal flows)
          await cancelScheduled(orderId);
          // Also cancel by phone — hold/failed flows update their order_id when merged,
          // so cancelScheduled alone misses them. Phone-based cancel is the safety net.
          const cancelPhone = await resolvePhone(order);
          if (cancelPhone) {
            await cancelScheduledForCustomer(cancelPhone, [
              'hold-msg1', 'hold-msg2', 'hold-msg3',
              'failed-msg1', 'failed-msg2', 'failed-msg3',
              'hold-failed-nudge'
            ]);
          }
          console.log(`[WEBHOOK] Cancelled order=${orderId} — all pending flows cleared`);
          break;
        }

        default:
          console.log(`[WEBHOOK] WooCommerce status=${status} | order=${orderId} — no SMS flow`);
      }

      // Analytics runs only after every existing operational workflow has
      // completed. It is deliberately not awaited: a slow/missing analytics
      // schema must never delay payment-flow cancellation or customer SMS.
      void recordWooOrderEvent(order, {
        // Official WooCommerce header first; retain the old alias for webhook
        // deliveries recorded before this correction.
        deliveryID: wooDeliveryID(req.headers),
        topic,
        signatureValid
      }).catch(error => console.error('[ANALYTICS] Deferred Woo capture failed:', error.code || 'write_error'));
    } catch (err) {
      console.error('[WEBHOOK] WooCommerce handler error:', err.message, err.stack);
    }
  });

  // Product create/update webhooks are campaign opportunity inputs, not an
  // operational order flow. Unlike the historical order endpoint, they are
  // fail-closed: no secret or an invalid signature means no database write and
  // no back-in-stock opportunity.
  router.post('/woocommerce-product', async (req, res) => {
    const secret = process.env.WC_WEBHOOK_SECRET;
    const signature = req.headers['x-wc-webhook-signature'];
    if (!secret) {
      console.error('[WOO PRODUCT] WC_WEBHOOK_SECRET is missing; refusing product event.');
      return res.status(503).json({ error: 'Webhook verification is unavailable.' });
    }
    if (!verifyWooSignature(req.body, signature, secret)) {
      console.warn('[WOO PRODUCT] Invalid webhook signature; event rejected.');
      return res.status(401).json({ error: 'Invalid webhook signature.' });
    }

    try {
      const result = await recordTrustedProductEvent({
        client: supabase,
        rawBody: req.body,
        headers: req.headers,
        deliveryID: wooDeliveryID(req.headers)
      });
      return res.status(200).json({ received: true, restockCandidate: result.restockCandidate });
    } catch (error) {
      console.error('[WOO PRODUCT] Trusted event capture failed:', error?.code || 'write_error');
      return res.status(500).json({ error: 'Product event could not be recorded.' });
    }
  });

  return router;
};
