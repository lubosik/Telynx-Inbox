'use strict';
/**
 * flows/confirmed.js
 *
 * processing  → handleOrderConfirmed  (payment received, label not yet printed)
 * completed   → handleOrderShipped    (order shipped, tracking from WC meta)
 */

const { formatPhone, sendAndLog, alreadySent } = require('./utils');
const { supabase } = require('../db');

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// ---------------------------------------------------------------------------
// Count prior SUCCESSFUL orders for this customer, excluding the current one.
//
// "Successful" = processing or completed. Failed and on-hold do NOT count —
// those haven't actually gone through. This determines new vs returning.
//
// NOTE: WooCommerce's ?email= filter is unreliable — ignores the param and
// returns recent orders from anyone. Fix:
//   1. Prefer ?customer=<id> when registered (filter works correctly).
//   2. Fall back to per_page=100 + client-side email filter for guests.
// ---------------------------------------------------------------------------

async function getPriorSuccessfulOrderCount(email, customerId, currentOrderId) {
  try {
    const baseUrl    = process.env.WC_URL?.replace('/wp-json/wc/v3', '') || 'https://vicipeptides.com';
    const authHeader = 'Basic ' + Buffer.from(
      `${process.env.WC_CONSUMER_KEY}:${process.env.WC_CONSUMER_SECRET}`
    ).toString('base64');

    if (customerId && customerId > 0) {
      // exclude= keeps the current order out of the count even if it's already completed
      const res = await fetch(
        `${baseUrl}/wp-json/wc/v3/orders?customer=${customerId}&status=completed,processing&per_page=20&exclude=${currentOrderId}`,
        { headers: { Authorization: authHeader } }
      );
      const orders = await res.json();
      return Array.isArray(orders) ? orders.length : 0;
    }

    if (!email) return 0;

    const res = await fetch(
      `${baseUrl}/wp-json/wc/v3/orders?status=completed,processing&per_page=100`,
      { headers: { Authorization: authHeader } }
    );
    const orders = await res.json();
    if (!Array.isArray(orders)) return 0;

    const normalised = email.toLowerCase().trim();
    return orders.filter(o =>
      (o.billing?.email || '').toLowerCase().trim() === normalised &&
      String(o.id) !== String(currentOrderId)
    ).length;
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
  const city       = order.shipping?.city || order.billing?.city || '';
  const state      = order.shipping?.state || order.billing?.state || '';

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
// Conversation context — look for inbound messages in the last 2 hours.
// Returns a formatted string if an active conversation exists, else null.
// ---------------------------------------------------------------------------

async function getRecentConversationContext(phone) {
  if (!phone) return null;
  try {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data: recentMessages } = await supabase
      .from('sms_messages')
      .select('direction, body, created_at')
      .eq('contact_phone', phone)
      .gte('created_at', twoHoursAgo)
      .order('created_at', { ascending: true })
      .limit(10);

    if (!recentMessages || recentMessages.length === 0) return null;

    // Only treat as active if at least one message is inbound (customer spoke)
    const hasInbound = recentMessages.some(m => m.direction === 'inbound');
    if (!hasInbound) return null;

    return recentMessages
      .map(m => `${m.direction === 'inbound' ? 'Customer' : 'Vici'}: ${m.body}`)
      .join('\n');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// OpenRouter context-aware confirmed — generates a natural continuation of
// an active conversation. Falls back to null on any failure.
// ---------------------------------------------------------------------------

async function generateContextAwareConfirmed(order, phone, firstName) {
  if (!process.env.OPENROUTER_API_KEY) return null;

  const context = await getRecentConversationContext(phone);
  if (!context) return null;

  const orderId  = String(order.id);
  const products = (order.line_items || []).map(i => `${i.quantity}x ${i.name}`).join(', ');
  const orderNumber = order.number || order.id;

  const systemPrompt = `You are DP, founder of Vici Peptides, texting customers personally. You already have an ongoing conversation with this customer. Your response must feel like a natural continuation, not a new automated message. Voice: warm, excited, personal. Like a friend texting. Rules: No em dashes. No corporate language. No hashtags. No asterisks. Max 320 characters. Never mention specific compound names in a medical context. Do not repeat information already said. Acknowledge what the customer said if relevant. Still confirm the order is confirmed and being packed.`;

  const userPrompt = `Recent conversation:
${context}

The order is now confirmed (status: processing).
Order #${orderNumber}
Products: ${products}
Customer first name: ${firstName}

Write a short SMS that continues this conversation naturally. Start from where the conversation left off. Confirm the order is confirmed and being prepared. Return ONLY the SMS text. No quotes. No explanation.`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://telynx-ghl-production.up.railway.app',
        'X-Title': 'Vici SMS Context'
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-haiku',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt }
        ],
        max_tokens: 150,
        temperature: 0.5
      }),
      signal: controller.signal
    });

    clearTimeout(timer);

    const data = await response.json();
    const generated = data.choices?.[0]?.message?.content?.trim();

    if (!generated || generated.length > 400) {
      console.log(`[CONTEXT] Invalid response | order=${orderId} — fallback`);
      return null;
    }
    if (generated.includes('—') || generated.includes('–')) {
      console.log(`[CONTEXT] Em dash detected | order=${orderId} — fallback`);
      return null;
    }

    console.log(`[CONTEXT] Generated context-aware message | order=${orderId} chars=${generated.length}`);
    return generated;

  } catch (err) {
    console.error(`[CONTEXT] OpenRouter failed | order=${orderId}: ${err.message} — fallback`);
    return null;
  }
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
// Message builders — exact copy approved by partner
// ---------------------------------------------------------------------------

function buildMsg1A(firstName, orderNumber, products, city) {
  const productLine = products?.length ? `Your ${products.join(' and ')} is` : `Order #${orderNumber} is`;
  const cityPhrase  = city ? ` heading to ${city}` : '';
  return `${firstName}! Just saw your first order come through and had to text you personally. Welcome to the Vici family!\n\nOrder #${orderNumber} confirmed - ${productLine}${cityPhrase} and we're on it. I'll text you the tracking the moment it leaves us.\n\nAny questions, I'm right here.\n\nDP`;
}

function buildMsg1B(firstName, orderNumber, products, city) {
  const productLine = products?.length ? `your ${products.join(' and ')}` : `order #${orderNumber}`;
  const cityPhrase  = city ? ` to ${city}` : '';
  return `${firstName}! Back again - you're the best. Order #${orderNumber} confirmed - ${productLine} is heading${cityPhrase} and going straight to the front of the queue.\n\nI'll text you the tracking the moment it ships. Appreciate you more than you know.\n\nDP`;
}

function buildShippedMessage(firstName, orderNumber, trackingNumber) {
  if (trackingNumber) {
    const trackingUrl = `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`;
    return `${firstName}! It's DP - your order is officially on its way to you!\n\nOrder #${orderNumber} · FedEx\nTrack it here: ${trackingUrl}\n\nSo excited for you to get it. Reach out anytime!\n\nDP`;
  }
  return `${firstName}! It's DP - your order is officially on its way to you!\n\nOrder #${orderNumber} is with FedEx and heading to you. I'll send the tracking link as soon as it's available!\n\nDP`;
}

// ---------------------------------------------------------------------------
// Extract tracking number from WooCommerce order meta
// Supports WC Shipment Tracking plugin + ShipStation WC integration
// ---------------------------------------------------------------------------

function extractTrackingNumber(order) {
  const meta = order.meta_data || [];

  // WC Shipment Tracking plugin — stores an array under _wc_shipment_tracking_items
  const trackingItems = meta.find(m => m.key === '_wc_shipment_tracking_items');
  if (trackingItems?.value) {
    try {
      const items = Array.isArray(trackingItems.value)
        ? trackingItems.value
        : JSON.parse(trackingItems.value);
      const num = items?.[0]?.tracking_number;
      if (num) return String(num).trim();
    } catch {}
  }

  // ShipStation WC integration and other common fields
  for (const key of ['_tracking_number', 'tracking_number', '_shipstation_tracking_number', 'ss_tracking_number', '_wc_ss_tracking_number']) {
    const field = meta.find(m => m.key === key);
    if (field?.value && typeof field.value === 'string' && field.value.trim()) {
      return field.value.trim();
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// handleOrderConfirmed — fires on WooCommerce status: processing
// Payment received, label not yet printed. No tracking yet.
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

  const orderAgeMs = order.date_created
    ? Date.now() - new Date(order.date_created).getTime()
    : Infinity;
  if (orderAgeMs > 48 * 60 * 60 * 1000) {
    console.log(`[CONFIRMED] Order too old | order=${orderId} — skipping`);
    return;
  }

  // Cross-type dedup
  const { data: alreadyConfirmed } = await supabase
    .from('sms_sent_log')
    .select('id, flow_type')
    .eq('order_id', orderId)
    .in('flow_type', ['confirmed-new', 'confirmed-returning'])
    .maybeSingle();

  if (alreadyConfirmed) {
    console.log(`[CONFIRMED] Already sent ${alreadyConfirmed.flow_type} | order=${orderId} — skipping`);
    return;
  }

  const priorSuccessful = await getPriorSuccessfulOrderCount(email, customerId, orderId);
  const isNew     = priorSuccessful === 0;
  const flowType  = isNew ? 'confirmed-new' : 'confirmed-returning';

  const products = (order.line_items || []).map(i => i.name).filter(Boolean);
  const city     = order.shipping?.city || order.billing?.city || '';

  const baseMessage = isNew
    ? buildMsg1A(firstName, orderNumber, products, city)
    : buildMsg1B(firstName, orderNumber, products, city);

  console.log(`[CONFIRMED] order=${orderId} type=${flowType} priorSuccessful=${priorSuccessful}`);

  // If customer texted in the last 2 hours, use AI context-aware continuation
  // instead of the base template — feels like a natural reply, not a cold message
  let finalMessage = baseMessage;
  try {
    const contextMsg = await generateContextAwareConfirmed(order, phone, firstName);
    if (contextMsg) finalMessage = contextMsg;
  } catch (err) {
    console.error(`[CONFIRMED] Context generation failed | order=${orderId}: ${err.message} — using base`);
  }

  await sendAndLog(phone, finalMessage, orderId, flowType);
}

// ---------------------------------------------------------------------------
// handleOrderShipped — fires on WooCommerce status: completed
// Order has been shipped. Reads tracking from WC order meta and texts the link.
// ---------------------------------------------------------------------------

async function handleOrderShipped(order) {
  const phone       = formatPhone(order.billing?.phone || order.shipping?.phone);
  const firstName   = order.billing?.first_name || 'there';
  const orderNumber = order.number || order.id;
  const orderId     = String(order.id);

  if (!phone) {
    console.log(`[SHIPPED] No phone | order=${orderId} — skipping`);
    return;
  }

  if (await alreadySent(orderId, 'shipped-msg1')) {
    console.log(`[SHIPPED] Already sent | order=${orderId} — skipping`);
    return;
  }

  const tracking = extractTrackingNumber(order);

  // If no tracking number yet, do NOT send a "tracking coming soon" message.
  // That premature message blocks the ShipStation poll from sending the real
  // tracking link later (dedup prevents it). Let ShipStation handle delivery
  // notification once the carrier actually scans the package.
  if (!tracking) {
    console.log(`[SHIPPED] No tracking in WC metadata | order=${orderId} — ShipStation poll will send when carrier scans`);
    return;
  }

  const message = buildShippedMessage(firstName, orderNumber, tracking);

  console.log(`[SHIPPED] order=${orderId} tracking=***${tracking.slice(-4)} phone=...${phone.slice(-4)}`);
  const sent = await sendAndLog(phone, message, orderId, 'shipped-msg1');

  // Mark shipped in sms_orders so the ShipStation poll's early-exit dedup works.
  // Without this, the poll doesn't know the WooCommerce path already sent tracking.
  if (sent) {
    const wooId = parseInt(orderId, 10);
    if (!isNaN(wooId)) {
      await supabase.from('sms_orders')
        .update({ shipped_sms_sent: true, tracking_number: tracking, status: 'shipped' })
        .eq('woo_order_id', wooId)
        .eq('shipped_sms_sent', false);
    }
  }
}

module.exports = { handleOrderConfirmed, handleOrderShipped };
