'use strict';

const BASE = 'https://api.telnyx.com/v2';

async function telnyxPost(path, body = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Telnyx ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

function answerCall(callControlId) {
  return telnyxPost(`/calls/${callControlId}/actions/answer`);
}

function speakOnCall(callControlId, text) {
  return telnyxPost(`/calls/${callControlId}/actions/speak`, {
    payload: text,
    voice: 'female',
    language: 'en-US'
  });
}

function transferCall(callControlId, to, from) {
  return telnyxPost(`/calls/${callControlId}/actions/transfer`, {
    to,
    from,
    timeout_secs: 40
  });
}

module.exports = { answerCall, speakOnCall, transferCall };
