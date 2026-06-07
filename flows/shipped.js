'use strict';
/**
 * flows/shipped.js — ShipStation carrier scan detection + delivery check-in
 *
 * SHIP_NOTIFY: stores shipment record only — NO SMS
 * Polling (every 30 min): sends SMS when shipmentStatus = 'shipped' (carrier accepted)
 * Delivery check-in: scheduled 3 days after shipped SMS fires
 *
 * Carrier is always FedEx per Dom's spec.
 */

const { supabase }              = require('../db');
const { sendAndLog, scheduleSMS } = require('./utils');

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// ---------------------------------------------------------------------------
// Shared context builder — city from sms_contacts, products from WooCommerce
// ---------------------------------------------------------------------------

async function buildShipmentContext(phone, wooOrderId) {
  let city = '';
  let products = [];

  try {
    const { data: contact } = await supabase
      .from('sms_contacts')
      .select('city, state')
      .eq('phone', phone)
      .maybeSingle();
    if (contact?.city) city = contact.city + (contact.state ? ', ' + contact.state : '');
  } catch {}

  if (wooOrderId) {
    try {
      const authHeader = 'Basic ' + Buffer.from(
        `${process.env.WC_CONSUMER_KEY}:${process.env.WC_CONSUMER_SECRET}`
      ).toString('base64');
      const baseUrl = process.env.WC_URL?.replace('/wp-json/wc/v3', '') || 'https://vicipeptides.com';
      const res = await fetch(`${baseUrl}/wp-json/wc/v3/orders/${wooOrderId}`, { headers: { Authorization: authHeader } });
      const order = await res.json();
      products = (order.line_items || []).map(item => `${item.quantity}x ${item.name}`).filter(Boolean);
    } catch {}
  }

  return { city, products };
}

// ---------------------------------------------------------------------------
// OpenRouter personalisation helpers — both fall back silently on any failure
// ---------------------------------------------------------------------------

async function generatePersonalisedShipped(baseMessage, context, orderId) {
  if (!process.env.OPENROUTER_API_KEY) return null;
  const { city, products } = context;
  if (!city && products.length === 0) return null;

  const contextParts = [];
  if (products.length) contextParts.push(`Products shipped: ${products.join(', ')}`);
  if (city)            contextParts.push(`Destination: ${city}`);

  const system = `You are DP, founder of Vici Peptides. You send personal SMS to customers. Warm, excited, direct. No em dashes. No hashtags. No asterisks. Max 400 characters total for the final message.`;
  const user   = `Base SMS to modify:
"${baseMessage}"

Customer context:
${contextParts.map(p => `- ${p}`).join('\n')}

Task: Add ONE natural sentence after the first sentence. Mention what they ordered and that it's heading to their city.
Example: "Your BPC-157 and TB-500 are on their way to London!"
Keep everything else exactly the same, including the FedEx tracking line and the opt-out line.
Return ONLY the modified message. Nothing else.`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://telynx-ghl-production.up.railway.app',
        'X-Title': 'Vici SMS'
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-haiku',
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        max_tokens: 175,
        temperature: 0.4
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    const data = await response.json();
    const msg = data.choices?.[0]?.message?.content?.trim();
    if (!msg || msg.length > 420 || msg.includes('—') || msg.includes('–')) {
      console.log(`[PERSONALISE] Shipped: invalid — fallback | order=${orderId}`);
      return null;
    }
    console.log(`[PERSONALISE] Shipped generated | order=${orderId} chars=${msg.length}`);
    return msg;
  } catch (err) {
    console.error(`[PERSONALISE] Shipped failed: ${err.message} — fallback | order=${orderId}`);
    return null;
  }
}

async function generatePersonalisedDelivery(baseMessage, city, identifier) {
  if (!process.env.OPENROUTER_API_KEY || !city) return null;

  const system = `You are DP, founder of Vici Peptides. You send personal SMS to customers. Warm, caring, direct. No em dashes. No hashtags. No asterisks. Max 320 characters total.`;
  const user   = `Base SMS to modify:
"${baseMessage}"

Customer location: ${city}

Task: Naturally mention their city in the check-in — for example change "everything arrived safe and sound" to "everything arrived safe and sound to ${city}". Keep the rest of the message exactly the same.
Return ONLY the modified message. Nothing else.`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://telynx-ghl-production.up.railway.app',
        'X-Title': 'Vici SMS'
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-haiku',
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        max_tokens: 100,
        temperature: 0.4
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    const data = await response.json();
    const msg = data.choices?.[0]?.message?.content?.trim();
    if (!msg || msg.length > 320 || msg.includes('—') || msg.includes('–')) return null;
    console.log(`[PERSONALISE] Delivery generated | id=${identifier} chars=${msg.length}`);
    return msg;
  } catch (err) {
    console.error(`[PERSONALISE] Delivery failed: ${err.message} — fallback`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Message builders — verbatim from Dom's approved copy
// ---------------------------------------------------------------------------

function buildShippedMessage(firstName, orderNumber, trackingNumber) {
  const trackingUrl = `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`;
  return `${firstName}! It's DP - your order is officially on its way to you!\n\nOrder #${orderNumber} · FedEx\nTrack it here: ${trackingUrl}\n\nSo excited for you to get it. Reach out anytime!\n\nDP`;
}

function buildDeliveryMessage(firstName) {
  return `Hey ${firstName}! Just checking everything arrived safe and sound?\n\nHope you're happy with it. I'm here if you need anything at all.\n\nDP`;
}

// ---------------------------------------------------------------------------
// SHIP_NOTIFY handler — stores record, sends NO SMS
// ---------------------------------------------------------------------------

async function handleShipNotify(shipment) {
  const shipmentId  = String(shipment.shipmentId || '');
  const ssOrderId   = String(shipment.orderId    || '');
  const orderNumber = shipment.orderNumber?.toString() || '';
  const tracking    = shipment.trackingNumber || null;
  const voided      = shipment.voided === true;

  if (!shipmentId) {
    console.log('[SHIPPED] No shipmentId in payload — skipping');
    return;
  }

  console.log(`[SHIPPED] SHIP_NOTIFY | shipment=${shipmentId} order=${orderNumber} voided=${voided} tracking=${tracking ? '***' + tracking.slice(-4) : 'none'}`);

  if (voided) {
    await supabase.from('shipstation_tracking').upsert({
      shipstation_shipment_id: shipmentId,
      shipstation_order_id:    ssOrderId,
      woo_order_number:        orderNumber,
      voided:                  true,
      updated_at:              new Date().toISOString()
    }, { onConflict: 'shipstation_shipment_id' });
    console.log(`[SHIPPED] Voided label ${shipmentId} stored — no SMS`);
    return;
  }

  // Look up customer from sms_orders via order number
  const customer = await getCustomerFromOrderNumber(orderNumber);

  await supabase.from('shipstation_tracking').upsert({
    shipstation_shipment_id: shipmentId,
    shipstation_order_id:    ssOrderId,
    woo_order_id:            customer?.wooOrderId || null,
    woo_order_number:        orderNumber,
    tracking_number:         tracking,
    carrier:                 'fedex',
    customer_phone:          customer?.phone    || null,
    customer_name:           customer?.firstName || null,
    customer_email:          customer?.email    || null,
    voided:                  false,
    shipment_status:         shipment.shipmentStatus || 'label_created',
    updated_at:              new Date().toISOString()
  }, { onConflict: 'shipstation_shipment_id' });

  console.log(`[SHIPPED] Stored shipment=${shipmentId} for order=${orderNumber}. Polling will detect carrier scan.`);
}

// ---------------------------------------------------------------------------
// Polling job — called every 30 minutes
// Sends shipped SMS when shipmentStatus === 'shipped' (carrier accepted)
// ---------------------------------------------------------------------------

async function pollForCarrierScans() {
  console.log('[POLL] ShipStation carrier scan check starting');

  const { data: pending, error } = await supabase
    .from('shipstation_tracking')
    .select('*')
    .eq('shipped_sms_sent', false)
    .eq('voided', false)
    .not('tracking_number', 'is', null)
    .limit(50);

  if (error) {
    console.error('[POLL] Query error:', error.message);
    return;
  }
  if (!pending?.length) {
    console.log('[POLL] No pending shipments');
    return;
  }

  console.log(`[POLL] Checking ${pending.length} shipment(s)`);

  const authHeader = 'Basic ' + Buffer.from(
    `${process.env.SS_API_KEY}:${process.env.SS_API_SECRET}`
  ).toString('base64');

  for (const record of pending) {
    try {
      const res  = await fetch(
        `https://ssapi.shipstation.com/shipments?shipmentId=${record.shipstation_shipment_id}`,
        { headers: { Authorization: authHeader } }
      );
      const data     = await res.json();
      const shipment = data.shipments?.[0];

      if (!shipment) {
        console.log(`[POLL] Shipment ${record.shipstation_shipment_id} not found`);
        await supabase.from('shipstation_tracking')
          .update({ last_polled: new Date().toISOString() })
          .eq('id', record.id);
        await sleep(1000);
        continue;
      }

      // Voided since last check?
      if (shipment.voided === true) {
        await supabase.from('shipstation_tracking')
          .update({ voided: true, updated_at: new Date().toISOString() })
          .eq('id', record.id);
        console.log(`[POLL] Shipment ${record.shipstation_shipment_id} now voided — skip`);
        await sleep(1000);
        continue;
      }

      const currentStatus = shipment.shipmentStatus || 'label_created';

      await supabase.from('shipstation_tracking')
        .update({
          shipment_status: currentStatus,
          last_polled:     new Date().toISOString(),
          updated_at:      new Date().toISOString()
        })
        .eq('id', record.id);

      if (isCarrierScanned(shipment)) {
        // Resolve phone if missing (may have been empty when SHIP_NOTIFY arrived)
        let phone     = record.customer_phone;
        let firstName = record.customer_name || 'there';

        if (!phone) {
          const customer = await getCustomerFromOrderNumber(record.woo_order_number);
          if (customer?.phone) {
            phone     = customer.phone;
            firstName = customer.firstName;
            await supabase.from('shipstation_tracking')
              .update({ customer_phone: phone, customer_name: firstName })
              .eq('id', record.id);
          }
        }

        if (!phone) {
          console.log(`[POLL] No phone for shipment=${record.shipstation_shipment_id} — skip`);
          await sleep(1000);
          continue;
        }

        // DEDUP: check sms_orders.shipped_sms_sent (WooCommerce tracking path may have already fired)
        if (record.woo_order_id) {
          const wooId = parseInt(record.woo_order_id, 10);
          if (!isNaN(wooId)) {
            const { data: wooOrder } = await supabase
              .from('sms_orders')
              .select('shipped_sms_sent')
              .eq('woo_order_id', wooId)
              .maybeSingle();
            if (wooOrder?.shipped_sms_sent === true) {
              console.log(`[POLL] Shipped SMS already sent via WooCommerce path for order=${record.woo_order_id} — marking and skipping`);
              await supabase.from('shipstation_tracking')
                .update({ shipped_sms_sent: true, updated_at: new Date().toISOString() })
                .eq('id', record.id);
              await sleep(1000);
              continue;
            }
          }
        }

        const orderId    = record.woo_order_id || record.shipstation_shipment_id;
        const baseShipped = buildShippedMessage(firstName, record.woo_order_number || record.woo_order_id, record.tracking_number);

        // Build context once — shared for shipped + delivery personalisation
        const shipContext = await buildShipmentContext(phone, record.woo_order_id);
        const personalisedShipped = await generatePersonalisedShipped(baseShipped, shipContext, orderId);

        const sent = await sendAndLog(
          phone,
          personalisedShipped || baseShipped,
          orderId,
          'shipped-msg1'
        );

        if (sent) {
          const now = new Date().toISOString();
          await supabase.from('shipstation_tracking')
            .update({ shipped_sms_sent: true, shipped_at: now, updated_at: now })
            .eq('id', record.id);

          // Keep sms_orders in sync
          if (record.woo_order_id) {
            const wooId = parseInt(record.woo_order_id, 10);
            if (!isNaN(wooId)) {
              await supabase.from('sms_orders')
                .update({ shipped_sms_sent: true, tracking_number: record.tracking_number, carrier: 'fedex', status: 'shipped', shipped_at: now })
                .eq('woo_order_id', wooId)
                .eq('shipped_sms_sent', false);
            }
          }

          // Bubble contact to top in the UI
          await supabase.from('sms_contacts')
            .update({ last_seen: now })
            .eq('phone', phone);
          require('../lib/broadcaster').broadcast({
            type: 'order_status_updated',
            phone,
            status: 'shipped',
            order_id: String(orderId)
          });
          // Delivery check-in disabled — holding until FedEx tracking is wired
        }
      } else {
        console.log(`[POLL] Shipment ${record.shipstation_shipment_id} status=${currentStatus} — not yet with carrier`);
      }
    } catch (err) {
      console.error(`[POLL] Error | shipment=${record.shipstation_shipment_id}: ${err.message}`);
    }

    // Throttle: 1 req/sec to stay within ShipStation's ~40 req/min limit
    await sleep(1000);
  }

  console.log('[POLL] Poll cycle complete');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * isCarrierScanned — true only when shipmentStatus = 'shipped' or 'delivered'
 * (null / 'label_created' = label bought but carrier hasn't scanned yet)
 */
function isCarrierScanned(shipment) {
  if (shipment.voided === true) return false;
  const s = (shipment.shipmentStatus || '').toLowerCase();
  return s === 'shipped' || s === 'delivered';
}

async function getCustomerFromOrderNumber(orderNumber) {
  if (!orderNumber) return null;
  try {
    const wooId = parseInt(orderNumber, 10);
    if (isNaN(wooId)) return null;

    const { data: order } = await supabase
      .from('sms_orders')
      .select('contact_phone, woo_order_id')
      .eq('woo_order_id', wooId)
      .maybeSingle();

    if (!order?.contact_phone) return null;

    const { data: contact } = await supabase
      .from('sms_contacts')
      .select('name')
      .eq('phone', order.contact_phone)
      .maybeSingle();

    return {
      wooOrderId: String(wooId),
      phone:      order.contact_phone,
      firstName:  contact?.name?.split(' ')?.[0] || 'there',
      email:      null
    };
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Delivery cron — called every 6 hours from server.js
// Sends delivery check-in SMS 5 days after shipping for legacy orders
// (new orders use sms_scheduled queue instead)
// ---------------------------------------------------------------------------

// Delivery check-in disabled — holding until FedEx/AfterShip tracking is wired up
async function checkAndSendDeliverySMS() {
  return 0;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  handleShipNotify,
  pollForCarrierScans,
  checkAndSendDeliverySMS,
  isCarrierScanned
};
