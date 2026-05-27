'use strict';
/**
 * ShipStation webhook handler + shipped/delivery SMS system.
 *
 * BUG FIXED: shipped SMS previously fired on SHIP_NOTIFY (label creation).
 * ShipStation fires SHIP_NOTIFY when a label is purchased — the carrier has NOT
 * yet scanned the package.  This caused customers to receive "on its way" texts
 * before the carrier ever touched the box (Samantha incident, May 2026).
 *
 * FIX: SHIP_NOTIFY now only stores the shipment record.
 * A polling job (every 30 min) calls GET /shipments?shipmentId=X and sends
 * the shipped SMS only when shipmentStatus === 'shipped' (carrier accepted).
 * Voided labels are detected via voided:true and never trigger SMS.
 */

const { supabase } = require('../db');
const { sendSMS }  = require('../telnyx');
const { fetchResourceUrl, ssGet } = require('../shipstation');
const { buildTrackingUrl } = require('../woocommerce');

// ---------------------------------------------------------------------------
// Message templates — no em-dashes, no asterisks, no hashtags
// ---------------------------------------------------------------------------

function shippedMessage(firstName, carrier, trackingNumber, trackingUrl, orderNum) {
  let msg = `Hey ${firstName}! It's Dom from Vici Peptides. Your order`;
  if (orderNum) msg += ` #${orderNum}`;
  msg += ' is officially on its way to you!';
  if (trackingUrl)    msg += ` Track it here: ${trackingUrl}`;
  else if (trackingNumber) msg += ` Tracking: ${trackingNumber}`;
  msg += ' Reach out anytime if you need me. Reply STOP to opt out.';
  return msg;
}

function deliveryMessage(firstName) {
  return `Hey ${firstName}! It's Dom from Vici Peptides. I really hope your order arrived safe and you're already loving it. If you get 30 seconds, an honest review would mean the absolute world to us: https://g.page/r/Cdab3lrLfvy1EBM/review Thank you so much!`;
}

// ---------------------------------------------------------------------------
// Helper — look up customer phone + name from sms_orders by woo order number
// ---------------------------------------------------------------------------

async function getCustomerInfo(wooOrderNumber) {
  if (!wooOrderNumber) return null;
  const wooId = parseInt(wooOrderNumber, 10);
  if (isNaN(wooId)) return null;

  const { data: order } = await supabase
    .from('sms_orders')
    .select('id, contact_phone, woo_order_id')
    .eq('woo_order_id', wooId)
    .maybeSingle();

  if (!order?.contact_phone) return null;

  const { data: contact } = await supabase
    .from('sms_contacts')
    .select('name')
    .eq('phone', order.contact_phone)
    .maybeSingle();

  return {
    wooOrderId:  String(wooId),
    phone:       order.contact_phone,
    firstName:   contact?.name?.split(' ')?.[0] || 'there'
  };
}

// ---------------------------------------------------------------------------
// processShipment — called for each shipment object in a SHIP_NOTIFY payload.
// DOES NOT send SMS.  Only stores the record for the polling job.
// ---------------------------------------------------------------------------

async function processShipment(shipment) {
  const shipmentId  = String(shipment.shipmentId || '');
  const ssOrderId   = String(shipment.orderId    || '');
  const orderNumber = shipment.orderNumber?.toString() || '';
  const tracking    = shipment.trackingNumber || null;
  const carrier     = shipment.carrierCode    || null;
  const voided      = shipment.voided === true;

  console.log(`[SHIPSTATION] Shipment ${shipmentId} | orderId: ${ssOrderId} | voided: ${voided} | tracking: ${tracking ? '***' + tracking.slice(-4) : 'none'}`);

  if (!shipmentId) {
    console.log('[SHIPSTATION] No shipmentId in payload — skipping');
    return;
  }

  // SAFETY: voided label — mark it and stop
  if (voided) {
    console.log(`[SHIPSTATION] Shipment ${shipmentId} is VOIDED — marking, no SMS`);
    await supabase.from('shipstation_tracking')
      .upsert({
        shipstation_shipment_id: shipmentId,
        shipstation_order_id:    ssOrderId,
        woo_order_id:            orderNumber,
        voided:                  true,
        updated_at:              new Date().toISOString()
      }, { onConflict: 'shipstation_shipment_id' });
    return;
  }

  // No tracking number = label interface opened but no label purchased yet
  if (!tracking) {
    console.log(`[SHIPSTATION] Shipment ${shipmentId} has no tracking number — label only, no SMS`);
    return;
  }

  // Lookup customer so we can store the phone for later polling
  const customer = await getCustomerInfo(orderNumber);

  const row = {
    shipstation_shipment_id: shipmentId,
    shipstation_order_id:    ssOrderId,
    woo_order_id:            orderNumber,
    tracking_number:         tracking,
    carrier,
    voided:                  false,
    shipment_status:         shipment.shipmentStatus || 'label_created',
    customer_phone:          customer?.phone    || null,
    customer_name:           customer?.firstName || null,
    updated_at:              new Date().toISOString()
  };

  await supabase.from('shipstation_tracking')
    .upsert(row, { onConflict: 'shipstation_shipment_id' });

  console.log(`[SHIPSTATION] Shipment ${shipmentId} stored (status: ${row.shipment_status}). Polling will send SMS when carrier scans.`);
}

// ---------------------------------------------------------------------------
// pollShipmentStatuses — called every 30 minutes by the cron in server.js.
// Queries ShipStation for current shipmentStatus on all pending records.
// Sends SMS only when shipmentStatus === 'shipped' (carrier accepted).
// ---------------------------------------------------------------------------

async function pollShipmentStatuses(broadcastSSE) {
  console.log('[POLL] Starting ShipStation status poll');

  const { data: pending, error } = await supabase
    .from('shipstation_tracking')
    .select('*')
    .eq('shipped_sms_sent', false)
    .eq('voided', false)
    .not('tracking_number', 'is', null)
    .limit(50);

  if (error) {
    console.error('[POLL] Supabase query error:', error.message);
    return;
  }
  if (!pending?.length) {
    console.log('[POLL] No pending shipments to check');
    return;
  }

  console.log(`[POLL] Checking ${pending.length} shipment(s)`);

  for (const record of pending) {
    try {
      const data = await ssGet('/shipments', { shipmentId: record.shipstation_shipment_id });
      const shipment = data.shipments?.[0];

      if (!shipment) {
        console.log(`[POLL] Shipment ${record.shipstation_shipment_id} not found in ShipStation`);
        await supabase.from('shipstation_tracking')
          .update({ last_polled: new Date().toISOString() })
          .eq('id', record.id);
        await sleep(1000);
        continue;
      }

      // Check if voided since last webhook
      if (shipment.voided === true) {
        console.log(`[POLL] Shipment ${record.shipstation_shipment_id} now voided — skipping`);
        await supabase.from('shipstation_tracking')
          .update({ voided: true, updated_at: new Date().toISOString() })
          .eq('id', record.id);
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

      // Only send SMS when carrier has accepted the package
      const carrierAccepted = isCarrierScanned(shipment);

      if (carrierAccepted) {
        await sendShippedSMS(record, shipment, broadcastSSE);
      } else {
        console.log(`[POLL] Shipment ${record.shipstation_shipment_id} status: ${currentStatus} — not yet with carrier`);
      }

    } catch (err) {
      console.error(`[POLL] Error checking shipment ${record.shipstation_shipment_id}:`, err.message);
    }

    // Throttle: 1 request/sec to stay well within ShipStation's ~40 req/min limit
    await sleep(1000);
  }

  console.log('[POLL] Poll cycle complete');
}

/**
 * isCarrierScanned — true when ShipStation confirms the carrier has accepted
 * the package (first physical scan or acceptance event).
 *
 * ShipStation's shipmentStatus values:
 *   null / 'label_created' — label purchased, not yet with carrier
 *   'shipped'              — carrier has accepted / scanned the package
 *   'delivered'            — delivered to recipient
 *
 * We check both 'shipped' and 'delivered' to cover cases where polling catches
 * a package that was already delivered before we polled.
 */
function isCarrierScanned(shipment) {
  if (shipment.voided === true) return false;
  const s = (shipment.shipmentStatus || '').toLowerCase();
  return s === 'shipped' || s === 'delivered';
}

// ---------------------------------------------------------------------------
// sendShippedSMS — sends the shipped SMS with deduplication guard
// ---------------------------------------------------------------------------

async function sendShippedSMS(record, shipment, broadcastSSE) {
  const { customer_phone, customer_name, woo_order_id, tracking_number, carrier, shipstation_shipment_id } = record;
  const orderId = woo_order_id || shipstation_shipment_id;

  // Resolve phone: try record first, then look up from sms_orders (may have been stored after webhook)
  let phone = customer_phone;
  let firstName = customer_name || 'there';

  if (!phone || !phone.startsWith('+')) {
    const customer = await getCustomerInfo(woo_order_id);
    if (!customer?.phone) {
      console.log(`[SMS] No valid phone for shipment ${shipstation_shipment_id} / order ${orderId} — skipping`);
      return;
    }
    phone     = customer.phone;
    firstName = customer.firstName;
    // Update the tracking record with the now-resolved phone
    await supabase.from('shipstation_tracking')
      .update({ customer_phone: phone, customer_name: firstName })
      .eq('id', record.id);
  }

  // DEDUP CHECK 1: sms_sent_log (covers our own polling flow)
  const { data: existing } = await supabase
    .from('sms_sent_log')
    .select('id')
    .eq('order_id', orderId)
    .eq('flow_type', 'shipped-msg1')
    .maybeSingle();

  if (existing) {
    console.log(`[SMS] Shipped SMS already logged for order ${orderId} — marking flag and skipping`);
    await supabase.from('shipstation_tracking')
      .update({ shipped_sms_sent: true, updated_at: new Date().toISOString() })
      .eq('id', record.id);
    return;
  }

  // DEDUP CHECK 2: sms_orders.shipped_sms_sent — covers the WooCommerce webhook flow
  // (webhook-woocommerce.js sends shipped SMS when tracking appears in WooCommerce
  //  and atomically claims via sms_orders.shipped_sms_sent but does not log to sms_sent_log)
  if (woo_order_id) {
    const wooId = parseInt(woo_order_id, 10);
    if (!isNaN(wooId)) {
      const { data: wooOrder } = await supabase
        .from('sms_orders')
        .select('shipped_sms_sent')
        .eq('woo_order_id', wooId)
        .maybeSingle();
      if (wooOrder?.shipped_sms_sent === true) {
        console.log(`[SMS] Shipped SMS already sent via WooCommerce flow for order ${orderId} — marking tracking and skipping`);
        await supabase.from('shipstation_tracking')
          .update({ shipped_sms_sent: true, updated_at: new Date().toISOString() })
          .eq('id', record.id);
        return;
      }
    }
  }

  // Build message
  const trackingUrl = buildTrackingUrl(carrier, tracking_number);
  const orderNum    = shipment?.orderNumber || woo_order_id;
  const msg         = shippedMessage(firstName, carrier, tracking_number, trackingUrl, orderNum);

  try {
    const { messageId } = await sendSMS(phone, msg);

    // Log for deduplication
    await supabase.from('sms_sent_log').insert({
      order_id:         orderId,
      flow_type:        'shipped-msg1',
      phone,
      message_body:     msg,
      telnyx_message_id: messageId || null
    });

    // Mark sent in tracking table
    await supabase.from('shipstation_tracking')
      .update({
        shipped_sms_sent: true,
        shipped_at:       new Date().toISOString(),
        updated_at:       new Date().toISOString()
      })
      .eq('id', record.id);

    // Also update sms_orders so the existing delivery cron can still fire
    if (woo_order_id) {
      const wooId = parseInt(woo_order_id, 10);
      if (!isNaN(wooId)) {
        await supabase.from('sms_orders')
          .update({
            shipped_sms_sent:    true,
            shipstation_order_id: String(record.shipstation_shipment_id),
            tracking_number,
            carrier,
            status:   'shipped',
            shipped_at: new Date().toISOString()
          })
          .eq('woo_order_id', wooId)
          .eq('shipped_sms_sent', false); // atomic: only write if not already sent
      }
    }

    // Insert into sms_messages for inbox display
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

    if (broadcastSSE) broadcastSSE({ type: 'new_message', phone, body: msg, direction: 'outbound' });

    console.log(`[SMS] Shipped SMS sent to ...${phone.slice(-4)} for order ${orderId}`);

  } catch (err) {
    console.error(`[SMS] Failed shipped SMS for order ${orderId}:`, err.message);
    // Do NOT mark shipped_sms_sent:true so the next poll can retry
  }
}

// ---------------------------------------------------------------------------
// checkAndSendDeliverySMS — unchanged from original, called every 6 hours.
// Sends review SMS 5 days after shipping to customers whose order we tracked.
// ---------------------------------------------------------------------------

async function checkAndSendDeliverySMS(broadcastSSE) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: shippedOrders } = await supabase
    .from('sms_orders')
    .select('id, contact_phone, woo_order_id, tracking_number, carrier, shipped_at')
    .eq('shipped_sms_sent', true)
    .eq('delivery_sms_sent', false)
    .eq('order_sms_sent', true)
    .gte('shipped_at', thirtyDaysAgo);

  if (!shippedOrders?.length) return 0;

  let sent = 0;
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

  for (const order of shippedOrders) {
    const isDelivered = order.shipped_at && new Date(order.shipped_at) < fiveDaysAgo;
    if (!isDelivered) continue;

    const { data: contact } = await supabase
      .from('sms_contacts')
      .select('name')
      .eq('phone', order.contact_phone)
      .maybeSingle();

    const firstName = contact?.name?.split(' ')?.[0] || 'there';
    const msg       = deliveryMessage(firstName);

    // DEDUP: check sms_sent_log first
    const { data: logged } = await supabase
      .from('sms_sent_log')
      .select('id')
      .eq('order_id', String(order.woo_order_id))
      .eq('flow_type', 'delivery-review')
      .maybeSingle();

    if (logged) continue;

    // Atomic claim on sms_orders
    const { data: claimed } = await supabase
      .from('sms_orders')
      .update({ delivery_sms_sent: true, delivered_at: new Date().toISOString(), status: 'delivered' })
      .eq('id', order.id)
      .eq('delivery_sms_sent', false)
      .select('id');

    if (!claimed?.length) continue;

    try {
      const { messageId } = await sendSMS(order.contact_phone, msg);

      await supabase.from('sms_sent_log').insert({
        order_id:          String(order.woo_order_id),
        flow_type:         'delivery-review',
        phone:             order.contact_phone,
        message_body:      msg,
        telnyx_message_id: messageId || null
      });

      await supabase.from('sms_messages').insert({
        telnyx_message_id: messageId,
        contact_phone:     order.contact_phone,
        direction:         'outbound',
        body:              msg,
        status:            'sent',
        created_at:        new Date().toISOString()
      });
      await supabase.from('sms_contacts')
        .update({ last_seen: new Date().toISOString() })
        .eq('phone', order.contact_phone);

      if (broadcastSSE) broadcastSSE({ type: 'new_message', phone: order.contact_phone, body: msg, direction: 'outbound' });
      sent++;
      console.log(`[SMS] Delivery review SMS sent to ...${order.contact_phone.slice(-4)} for order ${order.woo_order_id}`);
    } catch (err) {
      // Roll back claim so next cycle can retry
      await supabase.from('sms_orders')
        .update({ delivery_sms_sent: false })
        .eq('id', order.id);
      console.error(`[SMS] Failed delivery SMS for order ${order.id}:`, err.message);
    }
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Express router — POST /webhook/shipstation
// ---------------------------------------------------------------------------

module.exports = (broadcastSSE) => {
  const router = require('express').Router();

  router.post('/shipstation', async (req, res) => {
    // Validate secret
    const secret = req.query.secret;
    if (process.env.SS_WEBHOOK_SECRET && secret !== process.env.SS_WEBHOOK_SECRET) {
      console.warn('[SHIPSTATION] Webhook: invalid secret');
      return res.sendStatus(401);
    }

    // Respond 200 immediately — ShipStation retries if no quick ack
    res.sendStatus(200);

    try {
      const { resource_url, resource_type } = req.body;
      console.log(`[SHIPSTATION] Webhook received: ${resource_type}`);

      // Handle shipping events only
      if (!['SHIP_NOTIFY', 'ITEM_SHIP_NOTIFY', 'FULFILLMENT_SHIPPED'].includes(resource_type)) {
        console.log(`[SHIPSTATION] Ignoring event type: ${resource_type}`);
        return;
      }

      if (!resource_url) {
        console.log('[SHIPSTATION] No resource_url in payload — skipping');
        return;
      }

      const data = await fetchResourceUrl(resource_url);
      const shipments = data.shipments
        ? data.shipments
        : (data.shipmentId ? [data] : []);

      console.log(`[SHIPSTATION] Processing ${shipments.length} shipment(s)`);
      for (const shipment of shipments) {
        await processShipment(shipment);
      }
    } catch (err) {
      console.error('[SHIPSTATION] Webhook error:', err.message);
    }
  });

  return router;
};

// Export for use in server.js cron and tests
module.exports.processShipment        = processShipment;
module.exports.pollShipmentStatuses   = pollShipmentStatuses;
module.exports.checkAndSendDeliverySMS = checkAndSendDeliverySMS;
module.exports.isCarrierScanned       = isCarrierScanned;
