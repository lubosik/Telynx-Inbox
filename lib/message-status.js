'use strict';

// Telnyx SMS/MMS delivery states. Standard SMS does not expose read receipts;
// `delivered` means the carrier/device confirmed delivery, not that the person
// opened the message. RCS has a separate `read` state, but this application
// currently sends SMS/MMS.
const STATUS_RECHECK_MS = {
  queued: 30 * 1000,
  sent: 5 * 60 * 1000
};
const checkedAt = new Map();

function normaliseTelnyxStatus(value, fallback = 'queued') {
  const status = String(value || '').trim().toLowerCase();
  if (['queued', 'sending', 'scheduled'].includes(status)) return 'queued';
  if (['sent', 'delivery_unconfirmed'].includes(status)) return 'sent';
  if (['delivered', 'received'].includes(status)) return 'delivered';
  if (['delivery_failed', 'sending_failed', 'failed', 'gw_timeout'].includes(status)) return 'failed';
  if (['unavailable', 'status_unavailable'].includes(status)) return 'unavailable';
  return fallback;
}

// Delivery callbacks may be retried or arrive out of order. Never let a late
// `message.sent` callback downgrade a final delivered/failed state.
function shouldAdvanceStatus(currentValue, nextValue) {
  const current = normaliseTelnyxStatus(currentValue, String(currentValue || '').toLowerCase());
  const next = normaliseTelnyxStatus(nextValue, String(nextValue || '').toLowerCase());
  if (!next || current === next) return false;
  if (['delivered', 'failed', 'unavailable'].includes(current)) return false;
  if (['delivered', 'failed', 'unavailable'].includes(next)) return true;
  return current === 'queued' && next === 'sent';
}

async function retrieveTelnyxMessage(messageId, fetchImpl = fetch) {
  const response = await fetchImpl(
    `https://api.telnyx.com/v2/messages/${encodeURIComponent(messageId)}`,
    { headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` } }
  );
  if (response.status === 404) return { status: 'unavailable', updatedAt: null };
  if (!response.ok) return null;
  const result = await response.json();
  const recipient = Array.isArray(result?.data?.to) ? result.data.to[0] : result?.data?.to;
  return {
    status: normaliseTelnyxStatus(recipient?.status || result?.data?.status, null),
    updatedAt: result?.data?.completed_at || result?.data?.sent_at || null
  };
}

async function updateMessageStatus(supabase, messageId, providerStatus) {
  const next = normaliseTelnyxStatus(providerStatus, null);
  if (!messageId || !next) return null;

  const { data: existing, error: lookupError } = await supabase
    .from('sms_messages')
    // `body` is read by the caller to tell a blocked PAYMENT message from any
    // other blocked message, which is the difference between "somebody is
    // waiting for money that is never coming" and a routine delivery failure.
    .select('id, contact_phone, status, body')
    .eq('telnyx_message_id', messageId)
    .maybeSingle();
  if (lookupError || !existing || !shouldAdvanceStatus(existing.status, next)) return null;

  const { error: updateError } = await supabase
    .from('sms_messages')
    .update({ status: next })
    .eq('id', existing.id);
  if (updateError) throw updateError;
  return { ...existing, status: next };
}

function presentExpiredQueuedAsUnavailable(messages, now = Date.now()) {
  const cutoff = now - 10 * 24 * 60 * 60 * 1000;
  return (messages || []).map(message => {
    const created = Date.parse(message?.created_at || '');
    if (message?.direction === 'outbound' && message?.status === 'queued' &&
        Number.isFinite(created) && created < cutoff) {
      // Preserve the raw database value; only the API presentation changes.
      // Telnyx cannot retrieve a final receipt after its ten-day lookup window,
      // so continuing to say "Queued" would imply it is still waiting today.
      return { ...message, status: 'unavailable' };
    }
    return message;
  });
}

// The retrieve endpoint covers recent messages (up to 10 days). Reconcile only
// non-final outbound rows, and cache checks so the iOS thread's polling does not
// repeatedly call Telnyx for an intentionally unconfirmed message.
async function reconcileRecentMessageStatuses(supabase, messages, options = {}) {
  const now = options.now || Date.now();
  const maxAgeMs = 10 * 24 * 60 * 60 * 1000;
  const candidates = [...(messages || [])].reverse().filter(message => {
    if (message?.direction !== 'outbound' || !message.telnyx_message_id) return false;
    const status = normaliseTelnyxStatus(message.status, message.status);
    if (!Object.prototype.hasOwnProperty.call(STATUS_RECHECK_MS, status)) return false;
    const created = Date.parse(message.created_at || '');
    if (!Number.isFinite(created) || now - created > maxAgeMs) return false;
    const lastCheck = checkedAt.get(message.telnyx_message_id) || 0;
    return now - lastCheck >= STATUS_RECHECK_MS[status];
  }).slice(0, options.limit || 12);

  if (!candidates.length) return presentExpiredQueuedAsUnavailable(messages, now);

  const replacements = new Map();
  await Promise.all(candidates.map(async message => {
    checkedAt.set(message.telnyx_message_id, now);
    try {
      const provider = await retrieveTelnyxMessage(message.telnyx_message_id, options.fetchImpl || fetch);
      if (!provider?.status || !shouldAdvanceStatus(message.status, provider.status)) return;
      const updated = await updateMessageStatus(supabase, message.telnyx_message_id, provider.status);
      if (updated) replacements.set(message.telnyx_message_id, updated.status);
    } catch (error) {
      console.warn(`[MESSAGING] Status reconciliation failed for ...${message.telnyx_message_id.slice(-8)}: ${error.message}`);
    }
  }));

  // Bound the process-local cache during long-running deployments.
  if (checkedAt.size > 2000) {
    for (const key of checkedAt.keys()) {
      checkedAt.delete(key);
      if (checkedAt.size <= 1000) break;
    }
  }

  if (!replacements.size) return presentExpiredQueuedAsUnavailable(messages, now);
  const reconciled = messages.map(message => {
    const status = replacements.get(message.telnyx_message_id);
    return status ? { ...message, status } : message;
  });
  return presentExpiredQueuedAsUnavailable(reconciled, now);
}

module.exports = {
  normaliseTelnyxStatus,
  shouldAdvanceStatus,
  retrieveTelnyxMessage,
  updateMessageStatus,
  presentExpiredQueuedAsUnavailable,
  reconcileRecentMessageStatuses
};
