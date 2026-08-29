'use strict';
/**
 * flows/utils.js — shared helpers used by all SMS flow files
 */

const { supabase } = require('../db');
const { sendSMS }  = require('../telnyx');
const { broadcast } = require('../lib/broadcaster');
const { normaliseTelnyxStatus } = require('../lib/message-status');
const { logAudit } = require('../lib/audit/log');
const { messageFingerprint } = require('../lib/audit/redact');

// ---------------------------------------------------------------------------
// Audit helpers
//
// Everything in this file runs from a webhook or the five-minute cron, so the
// actor is always the system, never a signed-in person.
// ---------------------------------------------------------------------------

/**
 * A bulk cancel is recorded as ONE summary row, never one row per message.
 * A single WooCommerce webhook can cancel a dozen queued messages; twelve rows
 * would bury the human decisions the feed exists to show. The ids are capped
 * so one very large cancel cannot push the metadata past its 8KB ceiling.
 */
const SCHEDULED_ID_CAP = 200;

function cappedScheduledIDs(rows) {
  const ids = (rows || []).map(row => row.id).filter(id => id !== null && id !== undefined);
  return {
    scheduled_ids: ids.slice(0, SCHEDULED_ID_CAP),
    scheduled_ids_truncated: ids.length > SCHEDULED_ID_CAP
  };
}

/** The single phone shared by every cancelled row, or null if they differ. */
function singleContactPhone(rows) {
  const phones = [...new Set((rows || []).map(row => row.phone).filter(Boolean))];
  return phones.length === 1 ? phones[0] : null;
}

// ---------------------------------------------------------------------------
// Operational alerts
//
// `console.error` is the wrong channel for a condition that needs a human.
// This file already emits a dozen of them for ordinary, self-healing failures,
// so a genuinely serious one scrolls past looking identical to the noise. These
// helpers give the serious ones a single, stable, greppable shape:
//
//   [ALERT] SMS_OPT_OUT_NOT_SUPPRESSED severity=critical phone=...1234 ...
//
// One line, one leading token, one machine-readable code. `[ALERT] ` is a
// literal prefix a log drain can filter on, and the code after it names the
// exact condition, so an alarm can be defined per code rather than per string
// fragment. Nothing else in this repository writes that prefix.
// ---------------------------------------------------------------------------

const OPERATIONAL_ALERT_PREFIX = '[ALERT]';

/**
 * A customer sent STOP, but the row that `isOptedOut()` reads could not be
 * written. They are not suppressed. Every future flow will send to them.
 */
const ALERT_OPT_OUT_NOT_SUPPRESSED = 'SMS_OPT_OUT_NOT_SUPPRESSED';

function emitOperationalAlert(code, fields = {}) {
  const detail = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, ' ')}`)
    .join(' ');
  console.error(`${OPERATIONAL_ALERT_PREFIX} ${code} severity=critical ${detail}`.trim());
}

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

/**
 * How many times to try writing the opt-out sentinel before alerting.
 *
 * The sentinel is the ONLY record of suppression: `isOptedOut()` reads this
 * exact row, and nothing else does. `routes/webhook.js` answers Telnyx with
 * `res.sendStatus(200)` before it processes the message, so a failure here is
 * never retried by the provider either. If the write is lost, the customer who
 * texted STOP stays subscribed permanently and every future flow sends to them
 * normally. One immediate retry costs one round trip and covers the transient
 * PostgREST/network failure that is by far the likeliest cause.
 */
const SENTINEL_WRITE_ATTEMPTS = 2;
const SENTINEL_RETRY_DELAY_MS = 250;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * One attempt at the sentinel write. Returns the error, or null on success.
 *
 * NOTE: this call used to end in `.catch(() => {})`. A Supabase query builder
 * is a thenable with `then` only — it has no `catch` method — so that line
 * threw `TypeError: ...upsert(...).catch is not a function` BEFORE the request
 * was ever dispatched, and the Telnyx webhook's outer try/catch swallowed it.
 * Every inbound STOP therefore failed to write its opt-out sentinel. A
 * PostgREST failure arrives in `error`, not as a rejection, so try/catch around
 * the await is the correct shape here.
 */
async function writeOptOutSentinel(client, phone, orderId) {
  try {
    const { error } = await client.from('sms_sent_log').upsert({
      order_id: orderId,
      flow_type: 'opted-out',
      phone,
      message_body: 'OPT_OUT'
    }, { onConflict: 'order_id,flow_type', ignoreDuplicates: true });
    return error || null;
  } catch (err) {
    return err;
  }
}

/**
 * Record that a customer opted out.
 *
 * Returns `{ suppressed, audited, reason }` rather than throwing on a sentinel
 * failure. Throwing would be defensible here, but the caller in
 * `routes/webhook.js` deliberately continues to `cancelScheduledForCustomer()`
 * after this returns, and that cancellation must happen whatever else went
 * wrong. Returning keeps that path unconditional; the alert is what makes the
 * failure impossible to miss. (The consent-bearing `logAudit` below still
 * throws — the caller already catches it and proceeds with suppression.)
 *
 * @param {string} phone
 * @param {object} [deps]  injection seams, so this is testable without a network
 */
async function markOptedOut(phone, {
  client = supabase,
  audit = logAudit,
  alert = emitOperationalAlert,
  retryDelayMS = SENTINEL_RETRY_DELAY_MS
} = {}) {
  if (!phone) return { suppressed: false, audited: false, reason: 'no_phone' };
  const orderId = 'OPTOUT_' + phone.replace(/\D/g, '');

  let error = null;
  for (let attempt = 1; attempt <= SENTINEL_WRITE_ATTEMPTS; attempt += 1) {
    error = await writeOptOutSentinel(client, phone, orderId);
    if (!error) break;
    const detail = error.message || error.code || 'unknown';
    console.error(`[OPT-OUT] Sentinel write attempt ${attempt}/${SENTINEL_WRITE_ATTEMPTS} failed for ...${phone.slice(-4)}: ${detail}`);
    if (attempt < SENTINEL_WRITE_ATTEMPTS && retryDelayMS > 0) await sleep(retryDelayMS);
  }

  if (error) {
    // The retry did not help. This is not a logging problem: the customer is
    // still subscribed and there is no queue, no provider retry and no
    // reconciliation job that will fix it later. Say so once, loudly, in a
    // shape an alarm can match, and do not write an audit row claiming a
    // suppression that did not happen.
    alert(ALERT_OPT_OUT_NOT_SUPPRESSED, {
      phone: `...${phone.slice(-4)}`,
      attempts: SENTINEL_WRITE_ATTEMPTS,
      error: error.message || error.code || 'unknown',
      impact: 'customer-texted-STOP-but-is-NOT-suppressed;isOptedOut-returns-false;future-flows-will-send',
      action: 'insert-sms_sent_log-sentinel-manually-then-confirm-isOptedOut'
    });
    return { suppressed: false, audited: false, reason: 'sentinel_write_failed' };
  }

  // Consent-bearing: logAudit THROWS if this cannot be written. A consent
  // record that cannot be stored must stop the action rather than proceed
  // unrecorded. The fingerprint makes a retried webhook idempotent, and matches
  // the sentinel above, which is also once-per-phone.
  await audit({
    eventType: 'contact.opted_out',
    actorType: 'system',
    entityId: phone,
    contactPhone: phone,
    summary: `${phone} opted out of SMS`,
    previousState: { sms_opted_out: false },
    newState: { sms_opted_out: true },
    changedFields: ['sms_opted_out'],
    fingerprint: `contact.opted_out:${phone}`,
    metadata: { trigger: 'inbound_stop', source: 'telnyx_webhook' }
  });

  return { suppressed: true, audited: true, reason: null };
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

  await logAudit({
    eventType: 'automation.queue_item.scheduled',
    actorType: 'system',
    entityId: inserted?.id,
    contactPhone: phone,
    summary: `Queued the ${flowType} message for order ${orderId} at ${sendAt}`,
    newState: { id: inserted?.id, order_id: String(orderId), phone, flow_type: flowType, send_at: sendAt, status: 'pending' },
    metadata: {
      scheduled_id: inserted?.id,
      order_id: String(orderId),
      flow_type: flowType,
      send_at: sendAt,
      ...messageFingerprint(message)
    }
  });

  broadcast({ type: 'queue_added', id: inserted?.id, order_id: String(orderId), flow_type: flowType, send_at: sendAt, phone });
  console.log(`[SCHEDULE] Queued | order=${orderId} flow=${flowType} at=${sendAt}`);
}

async function cancelScheduled(orderId) {
  // phone/flow_type are selected alongside id purely so the audit summary row
  // can describe what was cancelled without a second query.
  const { data } = await supabase
    .from('sms_scheduled')
    .update({ status: 'cancelled' })
    .eq('order_id', String(orderId))
    .eq('status', 'pending')
    .select('id, phone, flow_type');

  if (data?.length > 0) {
    console.log(`[SCHEDULE] Cancelled ${data.length} pending messages | order=${orderId}`);
    await logAudit({
      eventType: 'automation.queue_item.bulk_cancelled',
      actorType: 'system',
      entityId: String(orderId),
      contactPhone: singleContactPhone(data),
      summary: `Cancelled ${data.length} queued message(s) for order ${orderId}`,
      previousState: { status: 'pending', pending_count: data.length },
      newState: { status: 'cancelled', pending_count: 0 },
      changedFields: ['status'],
      metadata: {
        scope: 'order',
        order_id: String(orderId),
        reason: 'order_state_changed',
        cancelled_count: data.length,
        flow_types: [...new Set(data.map(row => row.flow_type).filter(Boolean))],
        ...cappedScheduledIDs(data)
      }
    });
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
  const { data } = await query.select('id, phone, flow_type');
  const count = data?.length || 0;
  if (count > 0) {
    console.log(`[SCHEDULE] Cancelled ${count} pending messages | phone=...${phone.slice(-4)}`);
    await logAudit({
      eventType: 'automation.queue_item.bulk_cancelled',
      actorType: 'system',
      entityId: `phone:${phone}`,
      contactPhone: phone,
      summary: `Cancelled ${count} queued message(s) for ${phone}`,
      previousState: { status: 'pending', pending_count: count },
      newState: { status: 'cancelled', pending_count: 0 },
      changedFields: ['status'],
      metadata: {
        scope: 'customer',
        reason: flowTypes && flowTypes.length ? 'customer_replied' : 'customer_opted_out',
        cancelled_count: count,
        flow_types: [...new Set(data.map(row => row.flow_type).filter(Boolean))],
        ...cappedScheduledIDs(data)
      }
    });
  }
  return count;
}

// ---------------------------------------------------------------------------
// Queue processor — called every 5 minutes by server.js
// ---------------------------------------------------------------------------

/**
 * Flows this queue must never send, because it has no promotional gate.
 *
 * See the note inside processScheduledQueue. A flow named here is queued for
 * its timing only; something else decides whether it may actually go out.
 */
const PROMOTIONAL_FLOW_TYPES = new Set(['checkin-21d']);

async function processScheduledQueue() {
  const now = new Date().toISOString();

  // ── This queue is TRANSACTIONAL, and it sends what it is given ─────────
  //
  // sendAndLog checks two things: has this person sent STOP, and has this
  // exact message already gone. Correct and complete for "your order has
  // shipped", which a customer is owed whatever their marketing preferences.
  // It does not check promotional consent, quiet hours, the frequency caps or
  // the do-not-contact list, because a shipping update needs none of them.
  //
  // So a promotional flow must never appear here. `checkin-21d` rows are
  // queued by lib/campaigns/check-in.js purely to record a DUE DATE, they
  // carry a null message_body on purpose, and without this filter they would
  // arrive at sendAndLog and be handed to sendSMS as a null body. Excluded by
  // name rather than by "has a body", so that adding a promotional flow that
  // does have a body cannot quietly opt itself back in.
  const { data: due } = await supabase
    .from('sms_scheduled')
    .select('*')
    .eq('status', 'pending')
    .not('flow_type', 'in', `(${[...PROMOTIONAL_FLOW_TYPES].join(',')})`)
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
        await logAudit({
          eventType: 'automation.queue_item.cancelled',
          actorType: 'system',
          entityId: job.id,
          contactPhone: job.phone,
          summary: `Cancelled the ${job.flow_type} message because order ${job.order_id} recovered`,
          previousState: { id: job.id, order_id: job.order_id, phone: job.phone, flow_type: job.flow_type, send_at: job.send_at, status: 'pending' },
          newState: { id: job.id, order_id: job.order_id, phone: job.phone, flow_type: job.flow_type, send_at: job.send_at, status: 'cancelled' },
          changedFields: ['status'],
          metadata: {
            scheduled_id: job.id,
            order_id: job.order_id,
            flow_type: job.flow_type,
            send_at: job.send_at,
            reason: 'order_recovered',
            ...messageFingerprint(job.message_body)
          }
        });
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
    } else {
      // Failures are audited; successes are not. sms_sent_log is already the
      // ledger of what went out, and its unique index makes a double-insert
      // impossible, so duplicating it here would add noise and no evidence.
      await logAudit({
        eventType: 'automation.queue_item.failed',
        actorType: 'system',
        entityId: job.id,
        contactPhone: job.phone,
        summary: `The ${job.flow_type} message for order ${job.order_id || job.id} could not be sent`,
        previousState: { id: job.id, status: 'pending', attempts: job.attempts || 0 },
        newState: { id: job.id, status: 'failed', attempts: (job.attempts || 0) + 1 },
        changedFields: ['status', 'attempts'],
        metadata: {
          scheduled_id: job.id,
          order_id: job.order_id,
          flow_type: job.flow_type,
          attempts: (job.attempts || 0) + 1,
          reason: 'send_failed',
          ...messageFingerprint(job.message_body)
        }
      });
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
  ALERT_OPT_OUT_NOT_SUPPRESSED,
  OPERATIONAL_ALERT_PREFIX,
  SENTINEL_WRITE_ATTEMPTS,
  emitOperationalAlert,
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
