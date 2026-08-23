const crypto = require('crypto');

/**
 * Hard ceiling on a single provider POST.
 *
 * Without this, `fetch` waits for undici's 300-second headers timeout. One hung
 * Telnyx call therefore blocked whatever was awaiting it for five minutes — an
 * order-confirmation flow, an inbox send, or a campaign batch with a 2-minute
 * interval stacking runs behind it. 20 seconds is far beyond Telnyx's normal
 * sub-second response and far below anything that looks like a working system.
 */
const PROVIDER_TIMEOUT_MS = 20_000;

/**
 * HTTP statuses on which Telnyx has REJECTED the request outright and has not
 * handed anything to a carrier: the message provably did not go out.
 *
 * Narrow on purpose. Everything absent from this set — 401/403 (our credentials
 * or account, not this destination), 408/425/429 (retryable), every 5xx, every
 * network error, and every abort — stays UNCERTAIN, because "the provider did
 * not answer clearly" must never be downgraded to "the provider said no". A
 * wrongly-refused row is a marketing message a paying customer never receives;
 * a wrongly-uncertain row is a line in a human queue.
 */
const PROVIDER_REFUSAL_STATUSES = new Set([400, 404, 422]);

/**
 * True when a thrown sendSMS error carries proof the provider refused before
 * submission. Anything else — including a timeout, an abort and a 5xx — is
 * false, and callers must treat it as an unknown outcome.
 */
function isProviderRefusal(error) {
  return error?.providerRefused === true;
}

// mediaUrls: optional array of publicly-accessible HTTPS URLs — presence makes
// this an MMS. Telnyx caps media_urls at 10; carrier-safe total size is ~600KB.
//
// SUCCESS CONTRACT (unchanged, and depended on by order confirmation, shipping,
// the inbox, GHL relay, reactions, catch-up and the campaign worker): resolves
// to { messageId, status }, or throws an Error whose `message` is the Telnyx
// detail. The only addition is that a thrown error may now also carry
// `providerRefused`, `providerErrorCode` and `httpStatus`. Every existing caller
// reads `.message` and nothing else, so their behaviour is byte-identical.
async function sendSMS(to, message, mediaUrls = null) {
  const body = {
    from: process.env.TELNYX_PHONE_NUMBER,
    to,
    text: message || '',
    messaging_profile_id: process.env.TELNYX_MESSAGING_PROFILE_ID
  };
  if (Array.isArray(mediaUrls) && mediaUrls.length > 0) {
    body.media_urls = mediaUrls.slice(0, 10);
  }

  const response = await fetch('https://api.telnyx.com/v2/messages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
  });

  // A body we cannot parse is not evidence of anything. On a success status it
  // still throws exactly as before; on a failure status it stays uncertain
  // rather than being promoted to a refusal.
  let data = null;
  let parsed = true;
  try {
    data = await response.json();
  } catch (parseError) {
    if (response.ok) throw parseError;
    parsed = false;
  }

  if (!response.ok) {
    const failure = new Error(data?.errors?.[0]?.detail || 'Telnyx send failed');
    failure.httpStatus = response.status;
    if (parsed && PROVIDER_REFUSAL_STATUSES.has(response.status)) {
      failure.providerRefused = true;
      failure.providerErrorCode = String(data?.errors?.[0]?.code ?? `http_${response.status}`);
    }
    throw failure;
  }
  return { messageId: data.data.id, status: data.data.to?.[0]?.status };
}

function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  try {
    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');
    return signatureHeader === expected;
  } catch {
    return false;
  }
}

function ed25519PublicKey(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.includes('BEGIN PUBLIC KEY')) return crypto.createPublicKey(text);
  const raw = /^[a-f0-9]{64}$/i.test(text)
    ? Buffer.from(text, 'hex')
    : Buffer.from(text, 'base64');
  if (raw.length !== 32) return null;
  // RFC 8410 SubjectPublicKeyInfo prefix for a raw Ed25519 public key.
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
  return crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
}

function verifyWebhookSignatureV2(rawBody, signatureHeader, timestampHeader, publicKey,
  { now = Date.now(), toleranceSeconds = 300 } = {}) {
  try {
    const timestamp = String(timestampHeader || '');
    const timestampSeconds = Number(timestamp);
    if (!Number.isFinite(timestampSeconds) ||
        Math.abs(Math.floor(now / 1000) - timestampSeconds) > toleranceSeconds) return false;
    const signature = Buffer.from(String(signatureHeader || ''), 'base64');
    const key = ed25519PublicKey(publicKey);
    if (!key || signature.length !== 64) return false;
    const signedPayload = Buffer.concat([Buffer.from(`${timestamp}|`, 'utf8'), Buffer.from(rawBody)]);
    return crypto.verify(null, signedPayload, key, signature);
  } catch {
    return false;
  }
}

module.exports = {
  PROVIDER_REFUSAL_STATUSES,
  PROVIDER_TIMEOUT_MS,
  isProviderRefusal,
  sendSMS,
  verifyWebhookSignature,
  verifyWebhookSignatureV2
};
