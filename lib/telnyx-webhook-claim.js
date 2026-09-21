'use strict';

const crypto = require('node:crypto');
const { verifyWebhookSignatureV2 } = require('../telnyx');

function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Provider retry metadata (for example `meta.attempt`) is outside `data` and
// can legitimately change between deliveries of the same event. Dedupe the
// verified semantic event, not the complete transport envelope, while still
// detecting reuse of an event ID for different content.
function digestTelnyxEvent(event) {
  return crypto.createHash('sha256').update(canonicalJSON(event)).digest('hex');
}

function decodeVerifiedTelnyxEvent(rawBody, headers, publicKey, options) {
  if (!Buffer.isBuffer(rawBody)) throw Object.assign(new Error('Invalid webhook body.'), { status: 400 });
  const valid = verifyWebhookSignatureV2(
    rawBody,
    headers?.['telnyx-signature-ed25519'],
    headers?.['telnyx-timestamp'],
    publicKey,
    options
  );
  if (!valid) throw Object.assign(new Error('Invalid webhook signature.'), { status: 403 });
  let body;
  try { body = JSON.parse(rawBody.toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid webhook JSON.'), { status: 400 }); }
  const event = body?.data;
  const requirePayloadID = options?.requirePayloadID !== false;
  if (!event?.id || !event?.event_type || (requirePayloadID && !event?.payload?.id)) {
    throw Object.assign(new Error('Invalid webhook event.'), { status: 400 });
  }
  return event;
}

async function rpc(client, name, args) {
  const { data, error } = await client.rpc(name, args);
  if (error) throw Object.assign(new Error('Telnyx webhook ledger unavailable.'), { code: error.code || 'TELNYX_LEDGER_ERROR' });
  return data;
}

async function claimTelnyxEvent(client, event, status) {
  return rpc(client, 'claim_telnyx_message_event', { p_event: {
    workspace_id: 'vici',
    provider_event_id: String(event?.id || ''),
    message_id: String(event?.payload?.id || ''),
    event_type: String(event?.event_type || ''),
    status: status || null,
    occurred_at: event?.occurred_at || event?.payload?.received_at || new Date().toISOString()
  } });
}

async function finishTelnyxEvent(client, eventID, token) {
  return rpc(client, 'finish_telnyx_message_event', { p_event_id: eventID, p_token: token });
}

async function failTelnyxEvent(client, eventID, token, error) {
  return rpc(client, 'fail_telnyx_message_event', {
    p_event_id: eventID,
    p_token: token,
    p_error: String(error?.code || error?.message || 'processing_error').slice(0, 80)
  });
}

module.exports = {
  decodeVerifiedTelnyxEvent, digestTelnyxEvent,
  claimTelnyxEvent, finishTelnyxEvent, failTelnyxEvent
};
