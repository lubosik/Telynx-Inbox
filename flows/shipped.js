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

// ---------------------------------------------------------------------------
// Message builders — verbatim from Dom's approved copy
// ---------------------------------------------------------------------------

function buildShippedMessage(firstName, orderNumber, trackingNumber) {
  const trackingUrl = `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`;
  return `${firstName}! It's DP - your order is officially on its way to you!\n\nOrder #${orderNumber} · FedEx\nTrack it here: ${trackingUrl}\n\nSo excited for you to get it. Reach out anytime!\n\nDP. Reply STOP to opt out.`;
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

        const orderId = record.woo_order_id || record.shipstation_shipment_id;
        const sent    = await sendAndLog(
          phone,
          buildShippedMessage(firstName, record.woo_order_number || record.woo_order_id, record.tracking_number),
          orderId,
          'shipped-msg1'
        );

        if (sent) {
          const now = new Date().toISOString();
          await supabase.from('shipstation_tracking')
            .update({ shipped_sms_sent: true, shipped_at: now, updated_at: now })
            .eq('id', record.id);

          // Keep sms_orders in sync for delivery cron compatibility
          if (record.woo_order_id) {
            const wooId = parseInt(record.woo_order_id, 10);
            if (!isNaN(wooId)) {
              await supabase.from('sms_orders')
                .update({ shipped_sms_sent: true, tracking_number: record.tracking_number, carrier: 'fedex', status: 'shipped', shipped_at: now })
                .eq('woo_order_id', wooId)
                .eq('shipped_sms_sent', false);
            }
          }

          // Schedule delivery check-in 3 days later
          await scheduleSMS({
            orderId,
            phone,
            flowType: 'delivered-msg1',
            message:  buildDeliveryMessage(firstName),
            sendAt:   new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
          });
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

async function checkAndSendDeliverySMS() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: shippedOrders } = await supabase
    .from('sms_orders')
    .select('id, contact_phone, woo_order_id, shipped_at')
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
    const msg       = buildDeliveryMessage(firstName);

    // Atomic claim on sms_orders
    const { data: claimed } = await supabase
      .from('sms_orders')
      .update({ delivery_sms_sent: true, delivered_at: new Date().toISOString(), status: 'delivered' })
      .eq('id', order.id)
      .eq('delivery_sms_sent', false)
      .select('id');

    if (!claimed?.length) continue;

    const sent_ = await sendAndLog(order.contact_phone, msg, String(order.woo_order_id), 'delivered-msg1');
    if (sent_) sent++;
  }
  return sent;
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
