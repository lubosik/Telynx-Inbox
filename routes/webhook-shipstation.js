const { supabase } = require('../db');
const { sendSMS } = require('../telnyx');
const { fetchResourceUrl } = require('../shipstation');

const SHIPPED_SMS = (firstName, carrier, trackingNum) => {
  let msg = `Hi ${firstName}! Your Vici Peptides order has shipped`;
  if (carrier) msg += ` via ${carrier.toUpperCase()}`;
  msg += '.';
  if (trackingNum) msg += ` Track: ${trackingNum}`;
  if (msg.length < 130) msg += ' Reply STOP to opt out.';
  return msg;
};

const DELIVERED_SMS = (firstName) =>
  `Hi ${firstName}! Your Vici Peptides order has arrived. Hope you love it! Please leave us a review at vicipeptides.com/reviews - it means the world. Reply STOP to opt out.`;

async function processShipment(shipment, broadcastSSE) {
  const orderNumber = shipment.orderNumber || shipment.orderId?.toString();
  if (!orderNumber) return;

  // Find matching order in our DB
  const wooId = parseInt(orderNumber);
  const { data: order } = await supabase
    .from('sms_orders')
    .select('id, contact_phone, shipped_sms_sent, delivery_sms_sent, woo_order_id')
    .eq('woo_order_id', wooId)
    .maybeSingle();

  if (!order) {
    console.log(`ShipStation: no matching DB order for #${orderNumber}`);
    return;
  }

  const phone = order.contact_phone;

  // Get contact name
  const { data: contact } = await supabase
    .from('sms_contacts')
    .select('name')
    .eq('phone', phone)
    .maybeSingle();

  const firstName = contact?.name?.split(' ')?.[0] || 'there';

  // Update order with shipment tracking info
  await supabase.from('sms_orders').update({
    shipstation_order_id: shipment.shipmentId?.toString() || null,
    tracking_number: shipment.trackingNumber || null,
    carrier: shipment.carrierCode || null,
    status: 'shipped',
    shipped_at: shipment.shipDate || new Date().toISOString()
  }).eq('woo_order_id', wooId);

  // Send shipped SMS if not already sent
  if (!order.shipped_sms_sent) {
    const msg = SHIPPED_SMS(firstName, shipment.carrierCode, shipment.trackingNumber);
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
      console.log(`Shipped SMS sent to ${phone} for order #${orderNumber}`);
    } catch (err) {
      console.error('Failed to send shipped SMS:', err.message);
    }
  }
}

// Called by the daily delivery cron — sends delivery SMS to orders shipped 5+ days ago
async function checkAndSendDeliverySMS(broadcastSSE) {
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

  const { data: readyOrders } = await supabase
    .from('sms_orders')
    .select('id, contact_phone, woo_order_id, shipped_at')
    .eq('shipped_sms_sent', true)
    .eq('delivery_sms_sent', false)
    .lt('shipped_at', fiveDaysAgo);

  if (!readyOrders?.length) return 0;

  let sent = 0;
  for (const order of readyOrders) {
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
        delivered_at: new Date().toISOString()
      }).eq('id', order.id);
      await supabase.from('sms_contacts').update({ last_seen: new Date().toISOString() }).eq('phone', order.contact_phone);
      if (broadcastSSE) broadcastSSE({ type: 'new_message', phone: order.contact_phone, body: msg, direction: 'outbound' });
      sent++;
      console.log(`Delivery review SMS sent to ${order.contact_phone} for order #${order.woo_order_id}`);
    } catch (err) {
      console.error(`Failed delivery SMS for order ${order.id}:`, err.message);
    }
  }
  return sent;
}

module.exports = (broadcastSSE) => {
  const router = require('express').Router();

  router.post('/shipstation', async (req, res) => {
    // Verify via query param secret
    const secret = req.query.secret;
    if (process.env.SS_WEBHOOK_SECRET && secret !== process.env.SS_WEBHOOK_SECRET) {
      console.warn('ShipStation webhook: invalid secret');
      return res.sendStatus(401);
    }
    res.sendStatus(200);

    try {
      const { resource_url, resource_type } = req.body;
      console.log(`ShipStation webhook: ${resource_type}`);

      if (resource_type !== 'SHIP_NOTIFY' || !resource_url) return;

      const data = await fetchResourceUrl(resource_url);
      const shipments = data.shipments || (data.shipmentId ? [data] : []);

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
