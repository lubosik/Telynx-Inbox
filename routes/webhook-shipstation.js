const { supabase } = require('../db');
const { sendSMS } = require('../telnyx');
const { fetchResourceUrl, ssGet } = require('../shipstation');

// Build carrier tracking URLs from carrier code + tracking number
function buildTrackingUrl(carrierCode, trackingNumber) {
  if (!trackingNumber) return null;
  const c = (carrierCode || '').toLowerCase();
  if (c === 'stamps_com' || c === 'usps')
    return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`;
  if (c === 'ups')
    return `https://www.ups.com/track?tracknum=${trackingNumber}`;
  if (c.includes('fedex'))
    return `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`;
  if (c === 'dhl' || c === 'dhl_express')
    return `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}`;
  if (c === 'ontrac')
    return `https://www.ontrac.com/tracking.asp?tn=${trackingNumber}`;
  return null;
}

const SHIPPED_SMS = (firstName, carrier, trackingNumber, trackingUrl) => {
  let msg = `Hey ${firstName}! It's Dom, founder of Vici Peptides. Just wanted to personally let you know your order is on its way!`;
  if (trackingUrl) msg += ` Track it here: ${trackingUrl}`;
  else if (trackingNumber) msg += ` Tracking: ${trackingNumber}`;
  msg += ' Reply STOP to opt out.';
  return msg;
};

const DELIVERED_SMS = (firstName) =>
  `Hi ${firstName}! Your Vici Peptides order has arrived. We hope you love it! A quick review means the world to us: vicipeptides.com/reviews Reply STOP to opt out.`;

// Process a single ShipStation shipment object from SHIP_NOTIFY
async function processShipment(shipment, broadcastSSE) {
  const orderNumber = shipment.orderNumber?.toString();
  if (!orderNumber) return;

  const wooId = parseInt(orderNumber, 10);
  if (isNaN(wooId)) return;

  // Look up the order in our DB
  const { data: order } = await supabase
    .from('sms_orders')
    .select('id, contact_phone, shipped_sms_sent, delivery_sms_sent, woo_order_id')
    .eq('woo_order_id', wooId)
    .maybeSingle();

  if (!order) {
    console.log(`ShipStation SHIP_NOTIFY: no DB match for order #${orderNumber} — skipping`);
    return;
  }

  const phone = order.contact_phone;
  const trackingNumber = shipment.trackingNumber || null;
  const carrier = shipment.carrierCode || null;
  const trackingUrl = buildTrackingUrl(carrier, trackingNumber);

  // Update order with shipment data
  await supabase.from('sms_orders').update({
    shipstation_order_id: shipment.shipmentId?.toString() || null,
    tracking_number: trackingNumber,
    carrier,
    status: 'shipped',
    shipped_at: shipment.shipDate || new Date().toISOString()
  }).eq('woo_order_id', wooId);

  // Send shipped SMS once
  if (!order.shipped_sms_sent) {
    const { data: contact } = await supabase
      .from('sms_contacts')
      .select('name')
      .eq('phone', phone)
      .maybeSingle();

    const firstName = contact?.name?.split(' ')?.[0] || 'there';
    const msg = SHIPPED_SMS(firstName, carrier, trackingNumber, trackingUrl);

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
      await supabase.from('sms_orders').update({ shipped_sms_sent: true }).eq('woo_order_id', wooId);
      await supabase.from('sms_contacts').update({ last_seen: new Date().toISOString() }).eq('phone', phone);
      if (broadcastSSE) broadcastSSE({ type: 'new_message', phone, body: msg, direction: 'outbound' });
      console.log(`Shipped SMS → ${phone} for order #${orderNumber}`);
    } catch (err) {
      console.error(`Failed shipped SMS for order #${orderNumber}:`, err.message);
    }
  }
}

// Called by the 6-hour delivery cron in server.js
// Uses ShipStation tracking API (status_code === "DE") with 5-day fallback
async function checkAndSendDeliverySMS(broadcastSSE) {
  const { data: shippedOrders } = await supabase
    .from('sms_orders')
    .select('id, contact_phone, woo_order_id, tracking_number, carrier, shipped_at')
    .eq('shipped_sms_sent', true)
    .eq('delivery_sms_sent', false);

  if (!shippedOrders?.length) return 0;

  let sent = 0;
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

  for (const order of shippedOrders) {
    let isDelivered = false;

    // Check carrier tracking via ShipStation tracking API
    if (order.tracking_number && order.carrier) {
      try {
        const trackData = await ssGet('/tracking', {
          carrier_code: order.carrier,
          tracking_number: order.tracking_number
        });
        // status_code "DE" = delivered; actual_delivery_date set = delivered
        isDelivered = trackData.status_code === 'DE' || !!trackData.actual_delivery_date;
      } catch (err) {
        console.warn(`Tracking API failed for ${order.tracking_number}:`, err.message);
        // Fallback: 5-day delay
        isDelivered = order.shipped_at && new Date(order.shipped_at) < fiveDaysAgo;
      }
    } else {
      // No tracking number — use 5-day delay
      isDelivered = order.shipped_at && new Date(order.shipped_at) < fiveDaysAgo;
    }

    if (!isDelivered) continue;

    const { data: contact } = await supabase
      .from('sms_contacts')
      .select('name')
      .eq('phone', order.contact_phone)
      .maybeSingle();

    const firstName = contact?.name?.split(' ')?.[0] || 'there';
    const msg = DELIVERED_SMS(firstName);

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
      await supabase.from('sms_orders').update({
        delivery_sms_sent: true,
        delivered_at: new Date().toISOString(),
        status: 'delivered'
      }).eq('id', order.id);
      await supabase.from('sms_contacts').update({ last_seen: new Date().toISOString() }).eq('phone', order.contact_phone);
      if (broadcastSSE) broadcastSSE({ type: 'new_message', phone: order.contact_phone, body: msg, direction: 'outbound' });
      sent++;
      console.log(`Delivery review SMS → ${order.contact_phone} for order #${order.woo_order_id}`);
    } catch (err) {
      console.error(`Failed delivery SMS for order ${order.id}:`, err.message);
    }
  }
  return sent;
}

module.exports = (broadcastSSE) => {
  const router = require('express').Router();

  router.post('/shipstation', async (req, res) => {
    const secret = req.query.secret;
    if (process.env.SS_WEBHOOK_SECRET && secret !== process.env.SS_WEBHOOK_SECRET) {
      console.warn('ShipStation webhook: invalid secret');
      return res.sendStatus(401);
    }
    res.sendStatus(200);

    try {
      const { resource_url, resource_type } = req.body;
      console.log(`ShipStation webhook: ${resource_type}`);

      // Only handle shipping events
      if (!['SHIP_NOTIFY', 'ITEM_SHIP_NOTIFY', 'FULFILLMENT_SHIPPED'].includes(resource_type)) {
        console.log(`ShipStation: ignoring event type ${resource_type}`);
        return;
      }

      if (!resource_url) return;

      // Fetch the actual shipment data from the resource URL
      const data = await fetchResourceUrl(resource_url);

      // Response may be a list { shipments: [...] } or a single shipment object
      const shipments = data.shipments
        ? data.shipments
        : (data.shipmentId ? [data] : []);

      console.log(`ShipStation: processing ${shipments.length} shipment(s)`);
      for (const shipment of shipments) {
        await processShipment(shipment, broadcastSSE);
      }
    } catch (err) {
      console.error('ShipStation webhook error:', err.message);
    }
  });

  return router;
};

module.exports.processShipment = processShipment;
module.exports.checkAndSendDeliverySMS = checkAndSendDeliverySMS;
