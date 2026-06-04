'use strict';
/**
 * flows/hold.js — On Hold (Zelle / Venmo payment pending)
 *
 * MSG 1 — immediate (30s delay so webhook 200 goes out first)
 * MSG 2 — T+4 hours
 * MSG 3 — T+24 hours (final notice, stock release warning)
 *
 * Smart failed-flow detection (runs before hold dedup):
 *   If customer has a pending failed flow when on-hold fires:
 *     - Same products (retry): cancel failed flow, send on-hold only. No mention of failed.
 *     - Different products:    cancel failed flow, send on-hold, schedule a nudge T+2hrs
 *                              asking if they still want the item from the failed order.
 */

const { formatPhone, scheduleSMS, sendAndLog, alreadySent } = require('./utils');
const { supabase } = require('../db');

// ---------------------------------------------------------------------------
// WooCommerce helpers
// ---------------------------------------------------------------------------

function wcAuthHeader() {
  return 'Basic ' + Buffer.from(
    `${process.env.WC_CONSUMER_KEY}:${process.env.WC_CONSUMER_SECRET}`
  ).toString('base64');
}

function wcBaseUrl() {
  return process.env.WC_URL?.replace('/wp-json/wc/v3', '') || 'https://vicipeptides.com';
}

/**
 * Fetches an order from WooCommerce and returns the key fields we need.
 * Returns null on any failure — callers degrade gracefully.
 */
async function getOrderDetails(orderId) {
  try {
    const res = await fetch(
      `${wcBaseUrl()}/wp-json/wc/v3/orders/${orderId}`,
      { headers: { Authorization: wcAuthHeader() } }
    );
    const o = await res.json();
    if (!o || !o.id) return null;
    return {
      number:    o.number || String(o.id),
      order_key: o.order_key || '',
      total:     o.total || '0.00',
      items:     (o.line_items || []).map(i => ({
        product_id: i.product_id,
        name:       i.name || '',
        quantity:   i.quantity || 1
      }))
    };
  } catch {
    return null;
  }
}

/**
 * Returns true if the two item arrays share at least one product_id.
 */
function ordersShareProducts(itemsA, itemsB) {
  if (!itemsA?.length || !itemsB?.length) return false;
  const idsA = new Set(itemsA.map(i => i.product_id).filter(Boolean));
  return itemsB.some(i => idsA.has(i.product_id));
}

/**
 * Formats an item list into a natural short string for SMS.
 * e.g. "BPC-157" / "BPC-157 and TB-500" / "BPC-157 and 2 more"
 */
function formatProductList(items) {
  if (!items || items.length === 0) return '';
  const names = items.map(i => i.name).filter(Boolean);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} more`;
}

/**
 * Builds a WooCommerce order-pay URL for a failed order (used in nudge message).
 */
function buildFailedCheckoutUrl(orderId, orderKey) {
  const base      = wcBaseUrl();
  const utmParams = `utm_source=sms&utm_medium=text&utm_campaign=failed_recovery&utm_content=hold_nudge`;
  return `${base}/checkout/order-pay/${orderId}/?pay_for_order=true&key=${orderKey}&${utmParams}`;
}

// ---------------------------------------------------------------------------
// Payment method detection
// ---------------------------------------------------------------------------

function detectPaymentMethod(order) {
  const method      = (order.payment_method       || '').toLowerCase();
  const methodTitle = (order.payment_method_title || '')
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .toLowerCase();

  if (method.includes('venmo') || methodTitle.includes('venmo') || methodTitle.includes('enmo')) {
    return { label: 'Venmo', handle: process.env.VENMO_HANDLE || '@ViciPeptides' };
  }
  if (method.includes('zelle') || methodTitle.includes('zelle')) {
    return { label: 'Zelle', handle: process.env.ZELLE_HANDLE || 'support@vicipeptides.com' };
  }
  return { label: 'Venmo', handle: process.env.VENMO_HANDLE || '@ViciPeptides' };
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

function buildMsg1(firstName, orderNumber, total, handle, method, products, city) {
  const productPhrase = products && products.length
    ? ` for your ${formatProductList(products)}`
    : '';
  const cityPhrase = city ? ` to ${city}` : '';
  return `Hey ${firstName}! It's DP from Vici Peptides. Just got your order #${orderNumber}${productPhrase}!\n\nSend $${total} to ${handle} via ${method} to lock it in. Once I see it I'll ship it${cityPhrase} straight away!\n\nDP`;
}

function buildMsg2(firstName, orderNumber, total, handle, method) {
  return `Hey ${firstName}, checking in on order #${orderNumber}. Holding your stock!\n\nSend $${total} to ${handle} via ${method} when you get a chance. Just reply if anything's up.\n\nDP`;
}

function buildMsg3(firstName, orderNumber, total, handle, method) {
  return `${firstName}, last call on order #${orderNumber}. Need to release the stock by end of today.\n\nSend $${total} to ${handle} via ${method} to secure it. Just reply if you need anything.\n\nDP`;
}

function buildFailedNudgeMsg(firstName, failedOrderNumber, failedProducts, checkoutUrl) {
  const productPhrase = failedProducts && failedProducts.length
    ? ` for your ${formatProductList(failedProducts)}`
    : '';
  return `Hey ${firstName}, also noticed your order #${failedOrderNumber}${productPhrase} didn't go through. Still want it? ${checkoutUrl}\n\nDP`;
}

// ---------------------------------------------------------------------------
// Combined builders — two on-hold orders, one merged message
// ---------------------------------------------------------------------------

function buildCombinedMsg1(firstName, orderRef, combinedTotal, handle, method) {
  return `Hey ${firstName}! It's DP from Vici Peptides. You've got two orders waiting - ${orderRef}.\n\nSend $${combinedTotal} to ${handle} via ${method} to lock them both in. I'll ship them straight away!\n\nDP`;
}

function buildCombinedMsg2(firstName, orderRef, combinedTotal, handle, method) {
  return `Hey ${firstName}, checking in on orders ${orderRef}. Holding stock for both!\n\nSend $${combinedTotal} to ${handle} via ${method} when you get a chance. Just reply if anything's up.\n\nDP`;
}

function buildCombinedMsg3(firstName, orderRef, combinedTotal, handle, method) {
  return `${firstName}, last call on orders ${orderRef}. Need to release the stock by end of today.\n\nSend $${combinedTotal} to ${handle} via ${method} to secure them.\n\nDP`;
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
  const city        = order.shipping?.city || order.billing?.city || '';
  const { label: method, handle } = detectPaymentMethod(order);

  if (!phone) {
    console.log(`[HOLD] No phone | order=${orderId} — skipping`);
    return;
  }

  // -------------------------------------------------------------------------
  // STEP 1: Smart failed-flow detection
  //
  // If the customer has a pending failed flow when this on-hold fires, figure
  // out whether this is a retry of the same order or a genuinely separate one.
  // Either way we cancel the failed flow — we never want both running in parallel.
  // -------------------------------------------------------------------------
  let failedNudge = null; // populated only for the different-products scenario

  const { data: pendingFailed } = await supabase
    .from('sms_scheduled')
    .select('id, order_id')
    .eq('phone', phone)
    .in('flow_type', ['failed-msg1', 'failed-msg2', 'failed-msg3'])
    .eq('status', 'pending')
    .limit(1);

  if (pendingFailed && pendingFailed.length > 0) {
    const failedOrderId = pendingFailed[0].order_id;

    // Items from the current on-hold order (available in webhook payload)
    const currentItems = (order.line_items || []).map(i => ({
      product_id: i.product_id,
      name:       i.name || '',
      quantity:   i.quantity || 1
    }));

    // Fetch the failed order from WooCommerce
    const failedOrderDetails = await getOrderDetails(failedOrderId);

    const isSameProducts = failedOrderDetails
      ? ordersShareProducts(currentItems, failedOrderDetails.items)
      : false; // can't tell → treat as different (safer to nudge than to miss)

    // Cancel failed flow in all cases — don't run both in parallel
    await supabase.from('sms_scheduled')
      .update({ status: 'cancelled' })
      .eq('phone', phone)
      .in('flow_type', ['failed-msg1', 'failed-msg2', 'failed-msg3'])
      .eq('status', 'pending');

    if (isSameProducts) {
      // Retry: she re-ordered the same thing. On-hold message covers it fully.
      console.log(`[HOLD] Retry detected — cancelled failed flow for order=${failedOrderId} | same products as on-hold order=${orderId}`);
    } else {
      // Different products: schedule a gentle nudge about the failed order ~2hrs later
      console.log(`[HOLD] Different-product failed order=${failedOrderId} detected — will nudge after on-hold msgs`);
      if (failedOrderDetails) {
        failedNudge = {
          failedOrderId,
          failedOrderNumber: failedOrderDetails.number,
          failedProducts:    failedOrderDetails.items,
          checkoutUrl:       buildFailedCheckoutUrl(failedOrderId, failedOrderDetails.order_key)
        };
      }
    }
  }

  // -------------------------------------------------------------------------
  // STEP 2: Phone-level hold dedup
  // If customer already has a pending hold flow, merge both orders into a single
  // combined message (updated in-place) rather than sending a second parallel flow.
  // -------------------------------------------------------------------------
  const { data: existingFlow } = await supabase
    .from('sms_scheduled')
    .select('id, order_id, flow_type')
    .eq('phone', phone)
    .in('flow_type', ['hold-msg1', 'hold-msg2', 'hold-msg3'])
    .eq('status', 'pending');

  if (existingFlow && existingFlow.length > 0) {
    const existingOrderId = existingFlow[0].order_id;

    // Same-order guard: duplicate or retried webhook for the same order — skip silently.
    if (existingOrderId === orderId) {
      console.log(`[HOLD] Duplicate webhook | order=${orderId} already scheduled | phone=...${phone.slice(-4)}`);
      return;
    }

    // Defensive: log if somehow multiple different prior order IDs have pending hold rows.
    // Should never occur given dedup logic, but surfaces anomalies in production.
    const uniquePriorIds = [...new Set(existingFlow.map(r => r.order_id))];
    if (uniquePriorIds.length > 1) {
      console.warn(`[HOLD] Multiple prior order IDs in hold flow for phone=...${phone.slice(-4)}: ${uniquePriorIds.join(',')} — using first`);
    }

    console.log(`[HOLD] Customer ...${phone.slice(-4)} already in hold flow (order=${existingOrderId}) — merging with order=${orderId}`);

    let combinedTotal = total;
    // Hoist existingOrderNumber so the fallback catch block can use the best available value.
    // Defaults to existingOrderId until the WC fetch succeeds and provides the display number.
    let existingOrderNumber = existingOrderId;
    let orderRef = `#${existingOrderId} and #${orderNumber}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(
        `${wcBaseUrl()}/wp-json/wc/v3/orders/${existingOrderId}`,
        { headers: { Authorization: wcAuthHeader() }, signal: controller.signal }
      );
      clearTimeout(timer);
      const existingOrder = await res.json();
      existingOrderNumber = existingOrder.number || existingOrderId;
      const sum = (parseFloat(existingOrder.total || 0) + parseFloat(total)).toFixed(2);
      combinedTotal = sum;
      // Use display numbers from WC (order.number) — these are what customers see on invoices
      orderRef = `#${existingOrderNumber} and #${orderNumber}`;
    } catch {
      // WC fetch failed — orderRef already set to best available (existingOrderId + orderNumber)
      console.warn(`[HOLD] WC fetch failed for order ${existingOrderId} — using fallback numbers`);
    }

    const msgMap = {
      'hold-msg1': buildCombinedMsg1(firstName, orderRef, combinedTotal, handle, method),
      'hold-msg2': buildCombinedMsg2(firstName, orderRef, combinedTotal, handle, method),
      'hold-msg3': buildCombinedMsg3(firstName, orderRef, combinedTotal, handle, method)
    };

    for (const row of existingFlow) {
      const newBody = msgMap[row.flow_type];
      if (newBody) {
        await supabase.from('sms_scheduled')
          .update({ order_id: orderId, message_body: newBody })
          .eq('id', row.id);
      }
    }

    console.log(`[HOLD] Merged hold flow | orders=${orderRef} total=$${combinedTotal} phone=...${phone.slice(-4)}`);

    // Still schedule the failed nudge if needed — it's about a separate order
    if (failedNudge) {
      await scheduleSMS({
        orderId:  failedNudge.failedOrderId,
        phone,
        flowType: 'hold-failed-nudge',
        message:  buildFailedNudgeMsg(firstName, failedNudge.failedOrderNumber, failedNudge.failedProducts, failedNudge.checkoutUrl),
        sendAt:   new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
      });
      console.log(`[HOLD] Scheduled failed-nudge for order=${failedNudge.failedOrderId} at T+2hrs`);
    }

    return;
  }

  // -------------------------------------------------------------------------
  // STEP 3: Fetch current order's products for personalisation in MSG 1
  // Products are in the webhook payload — use directly, no WC fetch needed
  // -------------------------------------------------------------------------
  const currentProducts = (order.line_items || []).map(i => ({
    product_id: i.product_id,
    name:       i.name || '',
    quantity:   i.quantity || 1
  }));

  // MSG 1 — 30 seconds
  await scheduleSMS({
    orderId,
    phone,
    flowType: 'hold-msg1',
    message:  buildMsg1(firstName, orderNumber, total, handle, method, currentProducts, city),
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

  // Nudge about the failed order — sent 2 hours after on-hold msg 1
  if (failedNudge) {
    await scheduleSMS({
      orderId:  failedNudge.failedOrderId,
      phone,
      flowType: 'hold-failed-nudge',
      message:  buildFailedNudgeMsg(firstName, failedNudge.failedOrderNumber, failedNudge.failedProducts, failedNudge.checkoutUrl),
      sendAt:   new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
    });
    console.log(`[HOLD] Scheduled failed-nudge for order=${failedNudge.failedOrderId} at T+2hrs`);
  }

  console.log(`[HOLD] Flow scheduled | order=${orderId} method=${method} phone=...${phone.slice(-4)}`);
}

// ---------------------------------------------------------------------------
// Backfill — sends MSG 3 (final notice) to currently on-hold orders
// ---------------------------------------------------------------------------

async function backfillOnHoldOrders({ dryRun = false } = {}) {
  let page = 1, processed = 0, skipped = 0;

  while (true) {
    const res = await fetch(
      `${wcBaseUrl()}/wp-json/wc/v3/orders?status=on-hold&per_page=100&page=${page}`,
      { headers: { Authorization: wcAuthHeader() } }
    );
    const orders = await res.json();
    if (!Array.isArray(orders) || orders.length === 0) break;

    for (const order of orders) {
      const orderId = String(order.id);
      const phone   = formatPhone(order.billing?.phone || order.shipping?.phone);

      if (!phone) { skipped++; continue; }

      if (await alreadySent(orderId, 'hold-msg3', phone)) {
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
        await supabase.from('sms_sent_log').upsert([
          { order_id: orderId, flow_type: 'hold-msg1', phone, message_body: 'BACKFILL SKIPPED' },
          { order_id: orderId, flow_type: 'hold-msg2', phone, message_body: 'BACKFILL SKIPPED' }
        ], { onConflict: 'order_id,flow_type', ignoreDuplicates: true });

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

module.exports = { handleOrderOnHold, backfillOnHoldOrders, detectPaymentMethod, buildMsg1, buildMsg2, buildMsg3 };
