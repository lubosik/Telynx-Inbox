'use strict';
/**
 * flows/confirmed.js — Order Confirmed / Processing
 *
 * Single message fired on order.processing.
 * Branches: new customer (1A) vs returning customer (1B).
 * New    = fewer than 3 completed orders.
 * Returning = 3+ completed orders.
 * Deduped via sms_sent_log — fires exactly once per order.
 */

const { formatPhone, sendAndLog } = require('./utils');

// ---------------------------------------------------------------------------
// Customer order count (WooCommerce completed orders)
//
// NOTE: WooCommerce's ?email= filter is unreliable on this store — it ignores
// the param and returns recent orders from anyone. Fix:
//   1. Prefer ?customer=<id> when we have a registered customer_id (works reliably).
//   2. Fall back to fetching by email with per_page=100 and filtering client-side.
// ---------------------------------------------------------------------------

async function getCompletedOrderCount(email, customerId) {
  try {
    const baseUrl    = process.env.WC_URL?.replace('/wp-json/wc/v3', '') || 'https://vicipeptides.com';
    const authHeader = 'Basic ' + Buffer.from(
      `${process.env.WC_CONSUMER_KEY}:${process.env.WC_CONSUMER_SECRET}`
    ).toString('base64');

    if (customerId && customerId > 0) {
      // Registered customer — WC filters by customer_id correctly
      const res    = await fetch(
        `${baseUrl}/wp-json/wc/v3/orders?customer=${customerId}&status=completed&per_page=10`,
        { headers: { Authorization: authHeader } }
      );
      const orders = await res.json();
      return Array.isArray(orders) ? orders.length : 0;
    }

    if (!email) return 0;

    // Guest order — fetch recent completed orders and filter client-side by email
    // (WC ?email= filter is broken on this store — does not filter)
    const res    = await fetch(
      `${baseUrl}/wp-json/wc/v3/orders?status=completed&per_page=100`,
      { headers: { Authorization: authHeader } }
    );
    const orders = await res.json();
    if (!Array.isArray(orders)) return 0;

    const normalised = email.toLowerCase().trim();
    return orders.filter(o => (o.billing?.email || '').toLowerCase().trim() === normalised).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Message builders — verbatim from Dom's approved copy
// ---------------------------------------------------------------------------

function buildMsg1A(firstName, orderNumber) {
  return `${firstName}! Just saw your first order come through and had to text you personally. Welcome to the Vici family!\n\nOrder #${orderNumber} is confirmed and we're on it. I'll text you the tracking the moment it leaves us.\n\nAny questions, I'm literally right here. — DP`;
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
  const customerId  = order.customer_id || 0;

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
  // Returning = 3+ completed orders. New = fewer than 3.
  const completedOrders = await getCompletedOrderCount(email, customerId);
  const isNew      = completedOrders < 3;
  const flowType   = isNew ? 'confirmed-new' : 'confirmed-returning';
  const message    = isNew
    ? buildMsg1A(firstName, orderNumber)
    : buildMsg1B(firstName, orderNumber);

  console.log(`[CONFIRMED] order=${orderId} type=${flowType} completedOrders=${completedOrders}`);

  await sendAndLog(phone, message, orderId, flowType);
}

module.exports = { handleOrderConfirmed };
