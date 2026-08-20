const crypto = require('crypto');

// mediaUrls: optional array of publicly-accessible HTTPS URLs — presence makes
// this an MMS. Telnyx caps media_urls at 10; carrier-safe total size is ~600KB.
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
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.errors?.[0]?.detail || 'Telnyx send failed');
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

module.exports = { sendSMS, verifyWebhookSignature, verifyWebhookSignatureV2 };
