'use strict';
/**
 * flows/utils.js — shared helpers used by all SMS flow files
 */

const { supabase } = require('../db');
const { sendSMS }  = require('../telnyx');
const { broadcast } = require('../lib/broadcaster');
const { normaliseTelnyxStatus } = require('../lib/message-status');

// ---------------------------------------------------------------------------
// Phone formatting
// ---------------------------------------------------------------------------

function formatPhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10)                         return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1')    return '+' + digits;
  if (raw.startsWith('+') && digits.length >= 10)   return '+' + digits;
  return null;
}

// ---------------------------------------------------------------------------
// Opt-out — stored as a sentinel row in sms_sent_log so no schema change needed
// order_id = 'OPTOUT_<digits>', flow_type = 'opted-out'
// ---------------------------------------------------------------------------

async function isOptedOut(phone) {
  if (!phone) return false;
  try {
    const { data } = await supabase
      .from('sms_sent_log')
      .select('id')
      .eq('phone', phone)
      .eq('flow_type', 'opted-out')
      .maybeSingle();
    return !!data;
  } catch {
    return false;
  }
}

async function markOptedOut(phone) {
  if (!phone) return;
  const orderId = 'OPTOUT_' + phone.replace(/\D/g, '');
  await supabase.from('sms_sent_log').upsert({
    order_id: orderId,
    flow_type: 'opted-out',
    phone,
    message_body: 'OPT_OUT'
  }, { onConflict: 'order_id,flow_type', ignoreDuplicates: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

// phone is optional — pass it to scope the check to a specific customer.
// Without phone, any sent record for (orderId, flowType) matches, which can
// cause false positives when WooCommerce reuses internal order IDs.
async function alreadySent(orderId, flowType, phone = null) {
  let query = supabase
    .from('sms_sent_log')
    .select('id')
    .eq('order_id', String(orderId))
    .eq('flow_type', flowType);
  if (phone) query = query.eq('phone', phone);
  const { data } = await query.maybeSingle();
  return !!data;
}

// ---------------------------------------------------------------------------
// Send + log — the single place that calls Telnyx
// ---------------------------------------------------------------------------

async function sendAndLog(phone, message, orderId, flowType) {
  if (!phone || !phone.startsWith('+')) {
    console.log(`[SMS] SKIP invalid phone | order=${orderId} flow=${flowType}`);
    return false;
  }

  // Opt-out check — never send to someone who said STOP
  if (await isOptedOut(phone)) {
    console.log(`[SMS] SKIP opted out | order=${orderId} flow=${flowType} phone=...${phone.slice(-4)}`);
    return false;
  }

  // Pre-send dedup check — include phone so reused WC order IDs don't produce false positives
  if (await alreadySent(orderId, flowType, phone)) {
    console.log(`[SMS] SKIP already sent | order=${orderId} flow=${flowType}`);
    return false;
  }

  try {
    const result = await sendSMS(phone, message);

    // Insert log — unique index prevents duplicates even under race conditions
    const { error: insertErr } = await supabase.from('sms_sent_log').insert({
      order_id:          String(orderId),
      flow_type:         flowType,
      phone,
      message_body:      message,
      telnyx_message_id: result?.messageId || null
    });

    if (insertErr) {
      // Code 23505 = unique constraint violation = race condition, already sent by another process
      if (insertErr.code === '23505') {
        console.log(`[SMS] RACE CAUGHT | order=${orderId} flow=${flowType} — already sent`);
        return false;
      }
      throw insertErr;
    }

    // Also store in sms_messages for inbox display
    await supabase.from('sms_messages').insert({
      telnyx_message_id: result?.messageId || null,
      contact_phone:     phone,
      direction:         'outbound',
      body:              message,
      status:            normaliseTelnyxStatus(result?.status),
      created_at:        new Date().toISOString()
    });
    await supabase.from('sms_contacts')
      .update({ last_seen: new Date().toISOString() })
      .eq('phone', phone);

    console.log(`[SMS] SENT | order=${orderId} flow=${flowType} phone=...${phone.slice(-4)}`);
    return true;
  } catch (err) {
    console.error(`[SMS] FAILED | order=${orderId} flow=${flowType}: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

async function scheduleSMS({ orderId, phone, flowType, message, sendAt }) {
  // Skip if already sent — include phone so reused WC order IDs don't block new customers
  if (await alreadySent(orderId, flowType, phone)) {
    console.log(`[SCHEDULE] Already sent, not scheduling | order=${orderId} flow=${flowType}`);
    return;
  }

  // Skip if already pending for this exact customer+order+flow combination
  const { data: existing } = await supabase
    .from('sms_scheduled')
    .select('id')
    .eq('order_id', String(orderId))
    .eq('flow_type', flowType)
    .eq('phone', phone)
    .eq('status', 'pending')
    .maybeSingle();

  if (existing) {
    console.log(`[SCHEDULE] Already queued | order=${orderId} flow=${flowType}`);
    return;
  }

  const { data: inserted, error: insertErr } = await supabase.from('sms_scheduled').insert({
    order_id:     String(orderId),
    phone,
    flow_type:    flowType,
    message_body: message,
    send_at:      sendAt
  }).select('id').maybeSingle();

  if (insertErr) {
    console.error(`[SCHEDULE] INSERT FAILED | order=${orderId} flow=${flowType} phone=...${phone.slice(-4)}: ${insertErr.message}`);
    return;
  }

  broadcast({ type: 'queue_added', id: inserted?.id, order_id: String(orderId), flow_type: flowType, send_at: sendAt, phone });
  console.log(`[SCHEDULE] Queued | order=${orderId} flow=${flowType} at=${sendAt}`);
}

async function cancelScheduled(orderId) {
  const { data } = await supabase
    .from('sms_scheduled')
    .update({ status: 'cancelled' })
    .eq('order_id', String(orderId))
    .eq('status', 'pending')
    .select('id');

  if (data?.length > 0) {
    console.log(`[SCHEDULE] Cancelled ${data.length} pending messages | order=${orderId}`);
  }
}

// Cancel pending scheduled messages for a customer by phone number.
// Pass flowTypes array to restrict which flow types are cancelled.
// Omit flowTypes (or pass null) to cancel all pending messages.
async function cancelScheduledForCustomer(phone, flowTypes = null) {
  if (!phone) return 0;
  let query = supabase
    .from('sms_scheduled')
    .update({ status: 'cancelled' })
    .eq('phone', phone)
    .eq('status', 'pending');
  if (flowTypes && flowTypes.length > 0) {
    // bounded: a fixed set of flow-type names supplied by the caller, never data-derived.
    query = query.in('flow_type', flowTypes);
  }
  const { data } = await query.select('id');
  const count = data?.length || 0;
  if (count > 0) {
    console.log(`[SCHEDULE] Cancelled ${count} pending messages | phone=...${phone.slice(-4)}`);
  }
  return count;
}

// ---------------------------------------------------------------------------
// Queue processor — called every 5 minutes by server.js
// ---------------------------------------------------------------------------

async function processScheduledQueue() {
  const now = new Date().toISOString();

  const { data: due } = await supabase
    .from('sms_scheduled')
    .select('*')
    .eq('status', 'pending')
    .lte('send_at', now)
    .limit(50);

  if (!due?.length) return;

  console.log(`[SCHEDULE] Processing ${due.length} due message(s)`);

  const cancellableFlows = [
    'failed-msg1','failed-msg2','failed-msg3',
    'hold-msg1','hold-msg2','hold-msg3',
    'hold-failed-nudge'
  ];

  for (const job of due) {
    // For failed/hold messages: check if the order has since recovered
    if (cancellableFlows.includes(job.flow_type) && job.order_id) {
      const recovered = await checkOrderRecovered(job.order_id);
      if (recovered) {
        await supabase.from('sms_scheduled')
          .update({ status: 'cancelled' })
          .eq('id', job.id);
        console.log(`[SCHEDULE] Order ${job.order_id} recovered — cancelling ${job.flow_type}`);
        broadcast({ type: 'queue_cancelled', id: job.id, order_id: job.order_id, flow_type: job.flow_type, phone: job.phone });
        continue;
      }
    }

    const sent = await sendAndLog(
      job.phone,
      job.message_body,
      job.order_id || String(job.id),
      job.flow_type
    );

    await supabase.from('sms_scheduled')
      .update({
        status:   sent ? 'sent' : 'failed',
        attempts: (job.attempts || 0) + 1
      })
      .eq('id', job.id);

    if (sent) {
      broadcast({ type: 'message_sent', id: job.id, order_id: job.order_id, flow_type: job.flow_type, phone: job.phone, sent_at: new Date().toISOString() });
      broadcast({ type: 'stats_update' });
    }
  }
}

// ---------------------------------------------------------------------------
// Recovery check — has a failed/on-hold order moved to processing?
// ---------------------------------------------------------------------------

async function checkOrderRecovered(orderId) {
  try {
    const authHeader = 'Basic ' + Buffer.from(
      `${process.env.WC_CONSUMER_KEY}:${process.env.WC_CONSUMER_SECRET}`
    ).toString('base64');

    const res = await fetch(
      `${process.env.WC_URL}/orders/${orderId}`,
      { headers: { Authorization: authHeader } }
    );
    const order = await res.json();
    return ['processing', 'completed', 'shipped'].includes(order.status);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  formatPhone,
  alreadySent,
  isOptedOut,
  markOptedOut,
  sendAndLog,
  scheduleSMS,
  cancelScheduled,
  cancelScheduledForCustomer,
  processScheduledQueue,
  checkOrderRecovered
};
