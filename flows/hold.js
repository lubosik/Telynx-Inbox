'use strict';
/**
 * flows/hold.js — On Hold (Zelle / Venmo payment pending)
 *
 * MSG 1 — immediate (30s delay so webhook 200 goes out first)
 * MSG 2 — T+4 hours
 * MSG 3 — T+24 hours (final notice, stock release warning)
 */

const { formatPhone, scheduleSMS, alreadySent } = require('./utils');
const { supabase } = require('../db');

// ---------------------------------------------------------------------------
// Payment method detection
// ---------------------------------------------------------------------------

function detectPaymentMethod(order) {
  const method      = (order.payment_method       || '').toLowerCase();
  // Strip unicode / special chars before comparing (handles '𝓥enmo' etc.)
  const methodTitle = (order.payment_method_title || '')
    .normalize('NFKD')            // decompose unicode
    .replace(/[^\x00-\x7F]/g, '') // strip non-ASCII
    .toLowerCase();

  if (method.includes('venmo') || methodTitle.includes('venmo') || methodTitle.includes('enmo')) {
    return { label: 'Venmo', handle: process.env.VENMO_HANDLE || '@ViciPeptides' };
  }
  if (method.includes('zelle') || methodTitle.includes('zelle')) {
    return { label: 'Zelle', handle: process.env.ZELLE_HANDLE || 'support@vicipeptides.com' };
  }
  // Default to Venmo if payment method is unclear
  return { label: 'Venmo', handle: process.env.VENMO_HANDLE || '@ViciPeptides' };
}

// ---------------------------------------------------------------------------
// Message builders — verbatim from Dom's approved copy
// ---------------------------------------------------------------------------

function paymentInstructions(method, handle, orderNumber) {
  if (method === 'Zelle') {
    return `Zelle to ${handle}. Please use your order number #${orderNumber} as the payment reference.`;
  }
  // Venmo
  return `Pay via Venmo to ${handle}. Just include your name in the notes so I can match it.`;
}

function buildMsg1(firstName, orderNumber, total, handle, method) {
  return `Hey ${firstName}! It's DP from Vici Peptides. Just got your order #${orderNumber} - so excited to get this to you!\n\nTo lock it in, send $${total} via ${method}:\n${paymentInstructions(method, handle, orderNumber)}\n\nOnce I see it come through I'll get it packed up straight away!`;
}

function buildMsg2(firstName, orderNumber, total, handle, method) {
  return `Hey ${firstName}, checking in on order #${orderNumber}. I'm holding the stock for you!\n\nWhen you get a chance, send $${total} via ${method} to ${handle}${method === 'Zelle' ? ` (ref: #${orderNumber})` : ''}.\n\nAny issues at all, just reply here. DP`;
}

function buildMsg3(firstName, orderNumber, total, handle, method) {
  return `${firstName}, last check-in on order #${orderNumber}. I've got the stock held for you but I'll need to release it by end of today.\n\nSend $${total} via ${method} to ${handle}${method === 'Zelle' ? ` - use #${orderNumber} as your reference` : ''}.\n\nJust reply if anything's up. DP`;
}

// ---------------------------------------------------------------------------
// Live handler — called by WooCommerce order.on-hold webhook
// ---------------------------------------------------------------------------

async function handleOrderOnHold(order) {
  const phone       = formatPhone(order.billing?.phone || order.shipping?.phone);
  const firstName   = order.billing?.first_name || 'there';
  const orderNumber = order.number || order.id;
  const orderId     = String(order.id);
  const total       = order.total || '0.00';
  const { label: method, handle } = detectPaymentMethod(order);

  if (!phone) {
    console.log(`[HOLD] No phone | order=${orderId} — skipping`);
    return;
  }

  // MSG 1 — 30 seconds (gives webhook 200 time to complete)
  await scheduleSMS({
    orderId,
    phone,
    flowType: 'hold-msg1',
    message:  buildMsg1(firstName, orderNumber, total, handle, method),
    sendAt:   new Date(Date.now() + 30 * 1000).toISOString()
  });

  // MSG 2 — T+4 hours
  await scheduleSMS({
    orderId,
    phone,
    flowType: 'hold-msg2',
    message:  buildMsg2(firstName, orderNumber, total, handle, method),
    sendAt:   new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()
  });

  // MSG 3 — T+24 hours
  await scheduleSMS({
    orderId,
    phone,
    flowType: 'hold-msg3',
    message:  buildMsg3(firstName, orderNumber, total, handle, method),
    sendAt:   new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  });

  console.log(`[HOLD] Flow scheduled | order=${orderId} method=${method} phone=...${phone.slice(-4)}`);
}

// ---------------------------------------------------------------------------
// Backfill — sends MSG 3 (final notice) to currently on-hold orders
// ---------------------------------------------------------------------------

async function backfillOnHoldOrders({ dryRun = false } = {}) {
  const baseUrl    = process.env.WC_URL?.replace('/wp-json/wc/v3', '') || 'https://vicipeptides.com';
  const authHeader = 'Basic ' + Buffer.from(
    `${process.env.WC_CONSUMER_KEY}:${process.env.WC_CONSUMER_SECRET}`
  ).toString('base64');

  let page = 1, processed = 0, skipped = 0;

  while (true) {
    const res = await fetch(
      `${baseUrl}/wp-json/wc/v3/orders?status=on-hold&per_page=100&page=${page}`,
      { headers: { Authorization: authHeader } }
    );
    const orders = await res.json();
    if (!Array.isArray(orders) || orders.length === 0) break;

    for (const order of orders) {
      const orderId = String(order.id);
      const phone   = formatPhone(order.billing?.phone || order.shipping?.phone);

      if (!phone) { skipped++; continue; }

      if (await alreadySent(orderId, 'hold-msg3')) {
        console.log(`[BACKFILL-HOLD] Already sent | order=${orderId} — skip`);
        skipped++; continue;
      }

      const firstName   = order.billing?.first_name || 'there';
      const orderNumber = order.number || order.id;
      const total       = order.total || '0.00';
      const { label: method, handle } = detectPaymentMethod(order);
      const msg3 = buildMsg3(firstName, orderNumber, total, handle, method);

      console.log(`[BACKFILL-HOLD] ${dryRun ? 'DRY RUN' : 'SENDING'} | order=${orderId} phone=...${phone.slice(-4)}`);

      if (!dryRun) {
        // Mark MSG1+MSG2 as skipped
        await supabase.from('sms_sent_log').upsert([
          { order_id: orderId, flow_type: 'hold-msg1', phone, message_body: 'BACKFILL SKIPPED' },
          { order_id: orderId, flow_type: 'hold-msg2', phone, message_body: 'BACKFILL SKIPPED' }
        ], { onConflict: 'order_id,flow_type', ignoreDuplicates: true });

        const { sendAndLog } = require('./utils');
        await sendAndLog(phone, msg3, orderId, 'hold-msg3');
        processed++;
        await new Promise(r => setTimeout(r, 1000));
      } else {
        processed++;
      }
    }

    page++;
    if (orders.length < 100) break;
  }

  console.log(`[BACKFILL-HOLD] Complete | processed=${processed} skipped=${skipped} dryRun=${dryRun}`);
  return { processed, skipped };
}

module.exports = { handleOrderOnHold, backfillOnHoldOrders, detectPaymentMethod, buildMsg3 };
