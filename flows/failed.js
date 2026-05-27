'use strict';
/**
 * flows/failed.js — Order Failed: 3-message sequence
 *
 * MSG 1 — T+10 min:  payment issue notification + retry link
 * MSG 2 — T+2 hours: follow-up check-in
 * MSG 3 — T+24 hrs:  10% discount recovery offer (VICISAVE)
 *
 * All messages cancelled if order recovers to processing/completed before they fire.
 */

const { formatPhone, sendAndLog, scheduleSMS, cancelScheduled, alreadySent } = require('./utils');
const { supabase } = require('../db');

// ---------------------------------------------------------------------------
// Message builders — verbatim from Dom's approved copy
// ---------------------------------------------------------------------------

function buildMsg1(firstName, orderNumber, checkoutUrl) {
  return `Hey ${firstName}! It's DP from Vici. Looks like your payment didn't go through on order #${orderNumber} - don't worry, nothing was charged to your card.\n\nSometimes banks flag these. Give it 5 mins and try again here: ${checkoutUrl}`;
}

function buildMsg2(firstName, orderNumber) {
  return `Still having trouble with order #${orderNumber}, ${firstName}? Happens a lot actually - your bank might just need you to call and confirm it was you.\n\nI'm here if you need anything!\n\nDP`;
}

function buildMsg3(firstName, checkoutUrl) {
  return `Hey ${firstName}, your cart's still saved. Gonna be honest - I really want to get this order out to you.\n\nUse VICISAVE for 10% off, it's good for today only: ${checkoutUrl}\n\nDP. Reply STOP to opt out.`;
}

function buildCheckoutUrl(order) {
  const orderId   = order.id;
  const orderKey  = order.order_key || '';
  return `${process.env.WC_URL?.replace('/wp-json/wc/v3', '') || 'https://vicipeptides.com'}/checkout/order-pay/${orderId}/?pay_for_order=true&key=${orderKey}`;
}

// ---------------------------------------------------------------------------
// Live handler — called by WooCommerce order.failed webhook
// ---------------------------------------------------------------------------

async function handleOrderFailed(order) {
  const phone       = formatPhone(order.billing?.phone || order.shipping?.phone);
  const firstName   = order.billing?.first_name || 'there';
  const orderNumber = order.number || order.id;
  const orderId     = String(order.id);
  const checkoutUrl = buildCheckoutUrl(order);

  if (!phone) {
    console.log(`[FAILED] No phone | order=${orderId} — skipping`);
    return;
  }

  // MSG 1 — T+10 minutes
  await scheduleSMS({
    orderId,
    phone,
    flowType: 'failed-msg1',
    message:  buildMsg1(firstName, orderNumber, checkoutUrl),
    sendAt:   new Date(Date.now() + 10 * 60 * 1000).toISOString()
  });

  // MSG 2 — T+2 hours
  await scheduleSMS({
    orderId,
    phone,
    flowType: 'failed-msg2',
    message:  buildMsg2(firstName, orderNumber),
    sendAt:   new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
  });

  // MSG 3 — T+24 hours
  await scheduleSMS({
    orderId,
    phone,
    flowType: 'failed-msg3',
    message:  buildMsg3(firstName, checkoutUrl),
    sendAt:   new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  });

  console.log(`[FAILED] Flow scheduled | order=${orderId} phone=...${phone.slice(-4)}`);
}

// ---------------------------------------------------------------------------
// Recovery handler — called when order moves to processing/completed/cancelled
// ---------------------------------------------------------------------------

async function handleOrderRecovered(orderId) {
  await cancelScheduled(orderId);
}

// ---------------------------------------------------------------------------
// Backfill — sends MSG 3 (discount recovery) to historical failed orders
// Only runs for orders where customer has NOT since placed a successful order
// ---------------------------------------------------------------------------

async function backfillFailedOrders({ dryRun = false } = {}) {
  const authHeader = 'Basic ' + Buffer.from(
    `${process.env.WC_CONSUMER_KEY}:${process.env.WC_CONSUMER_SECRET}`
  ).toString('base64');

  const baseUrl = process.env.WC_URL?.replace('/wp-json/wc/v3', '') || 'https://vicipeptides.com';
  let page = 1, processed = 0, skipped = 0;
  // Phone-level dedup: prevent sending to the same number twice in one backfill run
  const phonesContacted = new Set();

  while (true) {
    const res = await fetch(
      `${baseUrl}/wp-json/wc/v3/orders?status=failed&per_page=100&page=${page}&after=2025-01-01T00:00:00`,
      { headers: { Authorization: authHeader } }
    );
    const orders = await res.json();
    if (!Array.isArray(orders) || orders.length === 0) break;

    for (const order of orders) {
      const orderId = String(order.id);
      const phone   = formatPhone(order.billing?.phone || order.shipping?.phone);
      const email   = order.billing?.email;

      if (!phone) {
        console.log(`[BACKFILL-FAILED] No phone | order=${orderId} — skip`);
        skipped++; continue;
      }

      // SAFETY: customer placed a successful order after this failed one?
      const recovered = await customerHasSuccessfulOrderAfter(email, order.date_created, authHeader, baseUrl);
      if (recovered) {
        console.log(`[BACKFILL-FAILED] Customer recovered after order=${orderId} — skip`);
        skipped++; continue;
      }

      // SAFETY: already contacted this phone (same customer, multiple failed orders).
      // Check in-memory set for this run, AND durably log skipped orders to sms_sent_log
      // so re-runs never send to the same phone twice.
      if (phonesContacted.has(phone)) {
        console.log(`[BACKFILL-FAILED] Phone already contacted this run | order=${orderId} — skip+log`);
        // Durably mark all 3 messages as skipped so this order is never picked up again
        if (!dryRun) {
          await supabase.from('sms_sent_log').upsert([
            { order_id: orderId, flow_type: 'failed-msg1', phone, message_body: 'BACKFILL PHONE DEDUP' },
            { order_id: orderId, flow_type: 'failed-msg2', phone, message_body: 'BACKFILL PHONE DEDUP' },
            { order_id: orderId, flow_type: 'failed-msg3', phone, message_body: 'BACKFILL PHONE DEDUP' }
          ], { onConflict: 'order_id,flow_type', ignoreDuplicates: true });
        }
        skipped++; continue;
      }

      // SAFETY: already sent or logged for this order?
      if (await alreadySent(orderId, 'failed-msg3')) {
        console.log(`[BACKFILL-FAILED] Already sent | order=${orderId} — skip`);
        // Also track the phone so sibling orders are skipped in this run
        phonesContacted.add(phone);
        skipped++; continue;
      }

      const firstName   = order.billing?.first_name || 'there';
      const checkoutUrl = buildCheckoutUrl(order);
      const msg3        = buildMsg3(firstName, checkoutUrl);

      console.log(`[BACKFILL-FAILED] ${dryRun ? 'DRY RUN' : 'SENDING'} | order=${orderId} phone=...${phone.slice(-4)}`);

      if (!dryRun) {
        // Mark MSG1+MSG2 as skipped so they never fire later
        await supabase.from('sms_sent_log').upsert([
          { order_id: orderId, flow_type: 'failed-msg1', phone, message_body: 'BACKFILL SKIPPED' },
          { order_id: orderId, flow_type: 'failed-msg2', phone, message_body: 'BACKFILL SKIPPED' }
        ], { onConflict: 'order_id,flow_type', ignoreDuplicates: true });

        // Send MSG3 now
        await sendAndLog(phone, msg3, orderId, 'failed-msg3');
        phonesContacted.add(phone);
        processed++;

        // Throttle: 1 per second
        await new Promise(r => setTimeout(r, 1000));
      } else {
        phonesContacted.add(phone);
        processed++;
      }
    }

    page++;
    if (orders.length < 100) break;
  }

  console.log(`[BACKFILL-FAILED] Complete | processed=${processed} skipped=${skipped} dryRun=${dryRun}`);
  return { processed, skipped };
}

async function customerHasSuccessfulOrderAfter(email, afterDate, authHeader, baseUrl) {
  if (!email) return false;
  try {
    const res = await fetch(
      `${baseUrl}/wp-json/wc/v3/orders?email=${encodeURIComponent(email)}&status=completed,processing&after=${afterDate}&per_page=1`,
      { headers: { Authorization: authHeader } }
    );
    const orders = await res.json();
    return Array.isArray(orders) && orders.length > 0;
  } catch {
    return false;
  }
}

module.exports = { handleOrderFailed, handleOrderRecovered, backfillFailedOrders };
