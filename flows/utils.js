'use strict';
/**
 * flows/utils.js — shared helpers used by all SMS flow files
 */

const { supabase } = require('../db');
const { sendSMS }  = require('../telnyx');

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
// Deduplication
// ---------------------------------------------------------------------------

async function alreadySent(orderId, flowType) {
  const { data } = await supabase
    .from('sms_sent_log')
    .select('id')
    .eq('order_id', String(orderId))
    .eq('flow_type', flowType)
    .maybeSingle();
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

  // Pre-send dedup check
  if (await alreadySent(orderId, flowType)) {
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
      status:            'sent',
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
  // Skip if already sent
  if (await alreadySent(orderId, flowType)) {
    console.log(`[SCHEDULE] Already sent, not scheduling | order=${orderId} flow=${flowType}`);
    return;
  }

  // Skip if already scheduled
  const { data: existing } = await supabase
    .from('sms_scheduled')
    .select('id')
    .eq('order_id', String(orderId))
    .eq('flow_type', flowType)
    .eq('status', 'pending')
    .maybeSingle();

  if (existing) {
    console.log(`[SCHEDULE] Already queued | order=${orderId} flow=${flowType}`);
    return;
  }

  await supabase.from('sms_scheduled').insert({
    order_id:     String(orderId),
    phone,
    flow_type:    flowType,
    message_body: message,
    send_at:      sendAt
  });

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

// Cancel ALL pending scheduled messages for a customer by phone number.
// Used when a customer successfully pays — clears failed/hold flows from
// any prior order IDs that cancelScheduled(orderId) would miss.
async function cancelScheduledForCustomer(phone) {
  if (!phone) return 0;
  const { data } = await supabase
    .from('sms_scheduled')
    .update({ status: 'cancelled' })
    .eq('phone', phone)
    .eq('status', 'pending')
    .select('id');
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
    'hold-msg1','hold-msg2','hold-msg3'
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
  sendAndLog,
  scheduleSMS,
  cancelScheduled,
  cancelScheduledForCustomer,
  processScheduledQueue,
  checkOrderRecovered
};
