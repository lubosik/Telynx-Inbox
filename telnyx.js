const crypto = require('crypto');

async function sendSMS(to, message) {
  const response = await fetch('https://api.telnyx.com/v2/messages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.TELNYX_PHONE_NUMBER,
      to,
      text: message,
      messaging_profile_id: process.env.TELNYX_MESSAGING_PROFILE_ID
    })
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
