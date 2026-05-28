'use strict';
/**
 * flows/confirmed.js — Order Confirmed / Processing
 *
 * Single message fired on order.processing.
 * Branches: new customer (1A) vs returning customer (1B).
 * New       = 0 prior completed orders (first order ever).
 * Returning = 1+ prior completed orders (every subsequent order).
 * Deduped via sms_sent_log — fires exactly once per order.
 *
 * On fire: cancels ALL pending scheduled messages for the customer by phone
 * (fixes Harriet scenario: failed flows from prior order IDs get cleared).
 *
 * OpenRouter personalisation: adds a natural one-liner about what they ordered,
 * where they're from, and prior history. Falls back to base template on any failure.
 */

const { formatPhone, sendAndLog, cancelScheduledForCustomer } = require('./utils');
const { supabase } = require('../db');

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

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
      const res    = await fetch(
        `${baseUrl}/wp-json/wc/v3/orders?customer=${customerId}&status=completed&per_page=10`,
        { headers: { Authorization: authHeader } }
      );
      const orders = await res.json();
      return Array.isArray(orders) ? orders.length : 0;
    }

    if (!email) return 0;

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
// Build rich customer context for OpenRouter personalisation
// ---------------------------------------------------------------------------

async function buildCustomerContext(order) {
  const email      = order.billing?.email || '';
  const customerId = order.customer_id || 0;
  const phone      = formatPhone(order.billing?.phone || order.shipping?.phone);
  const city       = order.billing?.city || order.shipping?.city || '';
  const state      = order.billing?.state || order.shipping?.state || '';

  const baseUrl    = process.env.WC_URL?.replace('/wp-json/wc/v3', '') || 'https://vicipeptides.com';
  const authHeader = 'Basic ' + Buffer.from(
    `${process.env.WC_CONSUMER_KEY}:${process.env.WC_CONSUMER_SECRET}`
  ).toString('base64');

  // Current order items
  const currentItems = (order.line_items || [])
    .map(item => `${item.quantity}x ${item.name}`)
    .join(', ');

  // Prior orders — only for registered customers (WC customer ID filter is reliable)
  let priorProducts = [];
  if (customerId > 0) {
    try {
      const res = await fetch(
        `${baseUrl}/wp-json/wc/v3/orders?customer=${customerId}&status=completed,processing&per_page=3&orderby=date&order=desc`,
        { headers: { Authorization: authHeader } }
      );
      const prevOrders = await res.json();
      if (Array.isArray(prevOrders)) {
        priorProducts = prevOrders
          .filter(o => String(o.id) !== String(order.id))
          .slice(0, 2)
          .flatMap(o => (o.line_items || []).map(item => item.name))
          .filter(Boolean);
      }
    } catch {}
  }

  // Failed order history — has this phone ever received a failed flow message?
  let hasPriorFailure = false;
  if (phone) {
    try {
      const { data: failedLog } = await supabase
        .from('sms_sent_log')
        .select('id')
        .eq('phone', phone)
        .eq('flow_type', 'failed-msg1')
        .limit(1);
      hasPriorFailure = !!(failedLog && failedLog.length > 0);
    } catch {}
  }

  return { currentItems, city, state, priorProducts, hasPriorFailure };
}

// ---------------------------------------------------------------------------
// OpenRouter personalisation — generates a naturally-worded one-liner to insert
// into the base template. Returns null on any failure so caller falls back.
// ---------------------------------------------------------------------------

async function generatePersonalisedConfirmed(baseMessage, context, firstName, orderId) {
  if (!process.env.OPENROUTER_API_KEY) return null;

  const { currentItems, city, state, priorProducts, hasPriorFailure } = context;

  // Build context lines — only include what we actually know
  const contextParts = [];
  if (currentItems)         contextParts.push(`Ordered now: ${currentItems}`);
  if (city)                 contextParts.push(`Location: ${city}${state ? ', ' + state : ''}`);
  if (priorProducts.length) contextParts.push(`Previously bought: ${priorProducts.join(', ')}`);
  if (hasPriorFailure)      contextParts.push(`Had a previous payment failure — they got it sorted. Acknowledge the persistence naturally, no big deal.`);

  if (contextParts.length === 0) return null;

  const systemPrompt = `You are DP, founder of Vici Peptides. You send personal SMS to customers. Your voice is warm, excited, and direct — like a real person texting, not a business. No em dashes. No corporate language. No hashtags. No asterisks. Max 320 characters total for the final message.`;

  const userPrompt = `Base SMS to modify:
"${baseMessage}"

Customer context:
${contextParts.map(p => `- ${p}`).join('\n')}

Task: Add ONE natural sentence after the first sentence. Use this style:
- Mention what they ordered by name, then say it will be on its way to [their city] as soon as possible.
- Example: "Your BPC-157 and TB-500 will be heading straight to London as soon as we pack it up."
- Keep it simple and warm. No weird phrases. No "spotted". No "London-bound". Just natural.
- Keep everything else in the message exactly the same.

Return ONLY the modified message text. Nothing else.`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://telynx-ghl-production.up.railway.app',
        'X-Title': 'Vici SMS'
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-haiku',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 150,
        temperature: 0.4
      }),
      signal: controller.signal
    });

    clearTimeout(timer);

    const data = await response.json();
    const personalised = data.choices?.[0]?.message?.content?.trim();

    if (!personalised || personalised.length > 320) {
      console.log(`[PERSONALISE] Invalid response | order=${orderId} — fallback`);
      return null;
    }

    // Reject if em dashes snuck in
    if (personalised.includes('—') || personalised.includes('–')) {
      console.log(`[PERSONALISE] Em dash detected | order=${orderId} — fallback`);
      return null;
    }

    console.log(`[PERSONALISE] Generated | order=${orderId} chars=${personalised.length}`);
    return personalised;

  } catch (err) {
    console.error(`[PERSONALISE] Failed | order=${orderId}: ${err.message} — fallback`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Message builders — verbatim from Dom's approved copy
// ---------------------------------------------------------------------------

function buildMsg1A(firstName, orderNumber) {
  return `${firstName}! Just saw your first order come through and had to text you personally. Welcome to the Vici family!\n\nOrder #${orderNumber} is confirmed and we're on it. I'll text you the tracking the moment it leaves us.\n\nAny questions, I'm literally right here.\n\nDP`;
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
  const orderAgeMs = order.date_created
    ? Date.now() - new Date(order.date_created).getTime()
    : Infinity;
  if (orderAgeMs > 48 * 60 * 60 * 1000) {
    console.log(`[CONFIRMED] Order too old | order=${orderId} — skipping`);
    return;
  }

  // Cancel ALL pending scheduled messages for this customer by phone number.
  // This fixes the Harriet scenario: failed/hold flows from prior order IDs
  // (which cancelScheduled(orderId) would never touch) are now cleared.
  await cancelScheduledForCustomer(phone);

  // Determine new vs returning
  const completedOrders = await getCompletedOrderCount(email, customerId);
  const isNew      = completedOrders === 0;
  const flowType   = isNew ? 'confirmed-new' : 'confirmed-returning';
  const baseMessage = isNew
    ? buildMsg1A(firstName, orderNumber)
    : buildMsg1B(firstName, orderNumber);

  console.log(`[CONFIRMED] order=${orderId} type=${flowType} completedOrders=${completedOrders}`);

  // Build customer context and attempt OpenRouter personalisation
  let finalMessage = baseMessage;
  try {
    const context = await buildCustomerContext(order);
    const personalised = await generatePersonalisedConfirmed(baseMessage, context, firstName, orderId);
    if (personalised) finalMessage = personalised;
  } catch (err) {
    console.error(`[CONFIRMED] Context build failed | order=${orderId}: ${err.message} — using base`);
  }

  await sendAndLog(phone, finalMessage, orderId, flowType);
}

module.exports = { handleOrderConfirmed };
