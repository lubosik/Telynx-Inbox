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

module.exports = { sendSMS, verifyWebhookSignature };
