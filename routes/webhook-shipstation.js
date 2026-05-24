const { supabase } = require('../db');
const { sendSMS } = require('../telnyx');
const { fetchResourceUrl } = require('../shipstation');
const { buildTrackingUrl } = require('../woocommerce');

const SHIPPED_SMS = (firstName, carrier, trackingNumber, trackingUrl) => {
  let msg = `Hey ${firstName}! It's Dom from Vici Peptides. Your order is officially on its way to you!`;
  if (trackingUrl) msg += ` You can track it right here: ${trackingUrl}`;
  else if (trackingNumber) msg += ` Tracking number: ${trackingNumber}`;
  msg += ' Reach out anytime if you need me. Reply STOP to opt out.';
  return msg;
};

const DELIVERED_SMS = (firstName) =>
  `Hey ${firstName}! It's Dom from Vici Peptides. I really hope your order arrived safe and you're already loving it. If you get 30 seconds, an honest review would mean the absolute world to us: https://g.page/r/Cdab3lrLfvy1EBM/review Thank you so much!`;

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

  // Atomically claim the shipped SMS — race-safe, same pattern as order_sms_sent
  const { data: claimed, error: claimErr } = await supabase
    .from('sms_orders')
    .update({ shipped_sms_sent: true })
    .eq('woo_order_id', wooId)
    .eq('shipped_sms_sent', false)
    .select('id');

  if (claimErr) {
    console.error(`ShipStation order #${orderNumber}: claim error — ${claimErr.message}`);
    return;
  }
  if (!claimed?.length) {
    console.log(`ShipStation order #${orderNumber}: shipped SMS already sent or claimed — skipping`);
    return;
  }

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
    await supabase.from('sms_contacts').update({ last_seen: new Date().toISOString() }).eq('phone', phone);
    if (broadcastSSE) broadcastSSE({ type: 'new_message', phone, body: msg, direction: 'outbound' });
    console.log(`Shipped SMS → ${phone} for order #${orderNumber}`);
  } catch (err) {
    // Roll back the claim so a retry can attempt again
    await supabase.from('sms_orders').update({ shipped_sms_sent: false }).eq('woo_order_id', wooId);
    console.error(`Failed shipped SMS for order #${orderNumber}:`, err.message);
  }
}

// Called by the 6-hour delivery cron in server.js.
// Uses 5-day post-ship delay to determine delivery (ShipStation API not available).
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
    // Consider delivered if shipped_at is more than 5 days ago
    const isDelivered = order.shipped_at && new Date(order.shipped_at) < fiveDaysAgo;
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
