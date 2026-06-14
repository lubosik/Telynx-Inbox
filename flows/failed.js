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
// Message builders
// ---------------------------------------------------------------------------

function buildMsg1(firstName, productPhrase, checkoutUrl) {
  const ref = productPhrase ? `your ${productPhrase} order` : 'your order';
  return `Hey ${firstName}! It's Vin from Vici Peptides. Looks like payment didn't go through on ${ref} - don't worry, nothing was charged.\n\nGive it 5 mins and try again here: ${checkoutUrl}\n\nIf your bank is flagging it, give them a quick call to let them know about the transaction and try again.\n\nVin`;
}

function buildMsg2(firstName) {
  const venmo = process.env.VENMO_HANDLE || '@ViciPeptides';
  const zelle = process.env.ZELLE_HANDLE || 'support@vicipeptides.com';
  return `Did you call your bank and try again, ${firstName}?\n\nIf it still didn't work no worries - we also accept Venmo (${venmo}) or Zelle (${zelle}). Just reply here and I'll sort it.\n\nVin`;
}

function buildMsg3(firstName, productPhrase, checkoutUrl) {
  const ref = productPhrase ? `your ${productPhrase}` : 'your cart';
  return `Hey ${firstName}, ${ref} is still saved. Gonna be honest - I really want to get this order out to you.\n\nUse VICISAVE for 10% off, it's good for today only: ${checkoutUrl}\n\nVin`;
}

function buildCheckoutUrl(order, utmContent = 'msg1') {
  const orderId  = order.id;
  const orderKey = order.order_key || '';
  if (!orderKey) console.warn(`[FAILED] order=${orderId} has no order_key — retry URL may not work`);
  const base      = process.env.WC_URL?.replace('/wp-json/wc/v3', '') || 'https://vicipeptides.com';
  const utmParams = `utm_source=sms&utm_medium=text&utm_campaign=failed_recovery&utm_content=${utmContent}`;
  return `${base}/checkout/order-pay/${orderId}/?pay_for_order=true&key=${orderKey}&${utmParams}`;
}

// Format a list of product names into a natural short phrase
// 1 item: "BPC-157" | 2: "BPC-157 and TB-500" | 3: "BPC-157, TB-500 and GHK-Cu" | 4+: "BPC-157 and 3 more"
function formatProductPhrase(items) {
  const names = (items || []).map(i => i.name).filter(Boolean);
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]} and ${names.length - 1} more`;
}

// Merge two product arrays, deduplicating by name (preserves different dosages of same product)
function mergeProducts(itemsA, itemsB) {
  const seen = new Set();
  const merged = [];
  for (const item of [...(itemsA || []), ...(itemsB || [])]) {
    const key = item.name || item.product_id;
    if (key && !seen.has(key)) { seen.add(key); merged.push(item); }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Live handler — called by WooCommerce order.failed webhook
// ---------------------------------------------------------------------------

async function handleOrderFailed(order) {
  const phone       = formatPhone(order.billing?.phone || order.shipping?.phone);
  const firstName   = order.billing?.first_name || 'there';
  const orderId     = String(order.id);
  const checkoutUrl1 = buildCheckoutUrl(order, 'msg1');
  const checkoutUrl3 = buildCheckoutUrl(order, 'msg3');

  // Products from the current (new) failed order — available in webhook payload
  const newItems = (order.line_items || []).map(i => ({ product_id: i.product_id, name: i.name }));

  if (!phone) {
    console.log(`[FAILED] No phone | order=${orderId} — skipping`);
    return;
  }

  // PHONE-LEVEL DEDUP: if customer already has a pending failed flow, merge both
  // orders into one by updating the message bodies to reference combined products,
  // and point the order_id at the new order (so recovery detection works correctly).
  // This prevents parallel flows and avoids bombarding the customer.
  const { data: existingFlow } = await supabase
    .from('sms_scheduled')
    .select('id, order_id, flow_type')
    .eq('phone', phone)
    .in('flow_type', ['failed-msg1', 'failed-msg2', 'failed-msg3'])
    .eq('status', 'pending');

  if (existingFlow && existingFlow.length > 0) {
    const existingOrderId = existingFlow[0].order_id;
    console.log(`[FAILED] Customer ...${phone.slice(-4)} already in failed flow (order=${existingOrderId}) — merging with order=${orderId}`);

    // Fetch the existing order's products so we can combine them with the new order's
    let existingItems = [];
    try {
      const authHeader = 'Basic ' + Buffer.from(
        `${process.env.WC_CONSUMER_KEY}:${process.env.WC_CONSUMER_SECRET}`
      ).toString('base64');
      const baseUrl = process.env.WC_URL?.replace('/wp-json/wc/v3', '') || 'https://vicipeptides.com';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${baseUrl}/wp-json/wc/v3/orders/${existingOrderId}`, {
        headers: { Authorization: authHeader }, signal: controller.signal
      });
      clearTimeout(timer);
      const existingOrder = await res.json();
      existingItems = (existingOrder.line_items || []).map(i => ({ product_id: i.product_id, name: i.name }));
    } catch {
      // If WC fetch fails, fall back to new order's products only
    }

    const combined   = mergeProducts(existingItems, newItems);
    const phrase     = formatProductPhrase(combined);

    // Rebuild each pending message with combined product context + new checkout URL
    const msgMap = {
      'failed-msg1': buildMsg1(firstName, phrase, checkoutUrl1),
      'failed-msg2': buildMsg2(firstName),
      'failed-msg3': buildMsg3(firstName, phrase, checkoutUrl3),
    };

    for (const row of existingFlow) {
      const newBody = msgMap[row.flow_type];
      if (newBody) {
        await supabase.from('sms_scheduled')
          .update({ order_id: orderId, message_body: newBody })
          .eq('id', row.id);
      }
    }

    console.log(`[FAILED] Merged | order=${orderId} products="${phrase}" phone=...${phone.slice(-4)}`);
    return;
  }

  const productPhrase = formatProductPhrase(newItems);

  // MSG 1 — T+10 minutes
  await scheduleSMS({
    orderId,
    phone,
    flowType: 'failed-msg1',
    message:  buildMsg1(firstName, productPhrase, checkoutUrl1),
    sendAt:   new Date(Date.now() + 10 * 60 * 1000).toISOString()
  });

  // MSG 2 — T+2 hours
  await scheduleSMS({
    orderId,
    phone,
    flowType: 'failed-msg2',
    message:  buildMsg2(firstName),
    sendAt:   new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
  });

  // MSG 3 — T+24 hours
  await scheduleSMS({
    orderId,
    phone,
    flowType: 'failed-msg3',
    message:  buildMsg3(firstName, productPhrase, checkoutUrl3),
    sendAt:   new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  });

  console.log(`[FAILED] Flow scheduled | order=${orderId} phone=...${phone.slice(-4)}`);

  // Race-condition guard: if two webhooks arrived simultaneously, both may have
  // passed the pending check before either committed. Cancel any older duplicate
  // rows that now exist for the same phone, keeping only the newest order's flow.
  await deduplicateFailedFlow(phone, orderId);
}

// After scheduling, cancel any older pending failed rows for the same phone
// that belong to a different order — keeps only the most recently scheduled flow.
async function deduplicateFailedFlow(phone, currentOrderId) {
  const { data: others } = await supabase
    .from('sms_scheduled')
    .select('id, order_id, flow_type')
    .eq('phone', phone)
    .in('flow_type', ['failed-msg1', 'failed-msg2', 'failed-msg3'])
    .eq('status', 'pending')
    .neq('order_id', currentOrderId);

  if (!others?.length) return;

  console.log(`[FAILED] Race dedup: cancelling ${others.length} stale rows for phone=...${phone.slice(-4)}`);
  const ids = others.map(r => r.id);
  await supabase.from('sms_scheduled')
    .update({ status: 'cancelled' })
    .in('id', ids);
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
      const checkoutUrl = buildCheckoutUrl(order, 'backfill');
      const msg3        = buildMsg3(firstName, '', checkoutUrl);

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
