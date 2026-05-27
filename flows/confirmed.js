'use strict';
/**
 * flows/confirmed.js — Order Confirmed / Processing
 *
 * Single message fired on order.processing.
 * Branches: new customer (1A) vs returning customer (1B).
 * New = 0 or 1 completed orders. Returning = 2+.
 * Deduped via sms_sent_log — fires exactly once per order.
 */

const { formatPhone, sendAndLog } = require('./utils');

// ---------------------------------------------------------------------------
// Customer order count (WooCommerce completed orders for this email)
// ---------------------------------------------------------------------------

async function getCompletedOrderCount(email) {
  if (!email) return 0;
  try {
    const baseUrl    = process.env.WC_URL?.replace('/wp-json/wc/v3', '') || 'https://vicipeptides.com';
    const authHeader = 'Basic ' + Buffer.from(
      `${process.env.WC_CONSUMER_KEY}:${process.env.WC_CONSUMER_SECRET}`
    ).toString('base64');

    const res    = await fetch(
      `${baseUrl}/wp-json/wc/v3/orders?email=${encodeURIComponent(email)}&status=completed&per_page=5`,
      { headers: { Authorization: authHeader } }
    );
    const orders = await res.json();
    return Array.isArray(orders) ? orders.length : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Message builders — verbatim from Dom's approved copy
// ---------------------------------------------------------------------------

function buildMsg1A(firstName, orderNumber) {
  return `${firstName}! Just saw your first order come through and had to text you personally. Welcome to the Vici family!\n\nOrder #${orderNumber} is confirmed and we're on it. I'll text you the tracking the moment it leaves us.\n\nAny questions, I'm literally right here.`;
}

function buildMsg1B(firstName, orderNumber) {
  return `${firstName}! Back again - you're the best. Order #${orderNumber} is confirmed and going straight to the front of the queue.\n\nI'll text you as soon as it's on the way. Appreciate you more than you know.\n\nAnything you want, just reply.`;
}

// ---------------------------------------------------------------------------
// Live handler — called by WooCommerce order.processing webhook
// ---------------------------------------------------------------------------

async function handleOrderConfirmed(order) {
  const phone       = formatPhone(order.billing?.phone || order.shipping?.phone);
  const firstName   = order.billing?.first_name || 'there';
  const orderNumber = order.number || order.id;
  const orderId     = String(order.id);
  const email       = order.billing?.email || '';

  if (!phone) {
    console.log(`[CONFIRMED] No phone | order=${orderId} — skipping`);
    return;
  }

  // Staleness guard: skip if order is more than 48 hours old
  const orderAgeMs  = order.date_created
    ? Date.now() - new Date(order.date_created).getTime()
    : Infinity;
  if (orderAgeMs > 48 * 60 * 60 * 1000) {
    console.log(`[CONFIRMED] Order too old | order=${orderId} — skipping`);
    return;
  }

  // Determine new vs returning
  const completedOrders = await getCompletedOrderCount(email);
  // completedOrders = count of COMPLETED orders including possibly this one.
  // If 0 or 1, this is effectively their first: use 1A.
  // If 2+, they're returning: use 1B.
  const isNew      = completedOrders <= 1;
  const flowType   = isNew ? 'confirmed-new' : 'confirmed-returning';
  const message    = isNew
    ? buildMsg1A(firstName, orderNumber)
    : buildMsg1B(firstName, orderNumber);

  console.log(`[CONFIRMED] order=${orderId} type=${flowType} completedOrders=${completedOrders}`);

  await sendAndLog(phone, message, orderId, flowType);
}

module.exports = { handleOrderConfirmed };
