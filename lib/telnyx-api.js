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

// Telnyx allows only letters, numbers, spaces and -_~!.+ in from_display_name,
// max 128 chars. An unsanitised CRM name (O'Brien, Smith & Sons, José) would be
// rejected and take the whole transfer down with it, so anything outside the
// allowed set is stripped rather than sent.
function sanitiseDisplayName(name) {
  if (!name || typeof name !== 'string') return null;
  const cleaned = name
    // Decompose then drop combining marks, so José becomes Jose rather than
    // losing the letter entirely. Escapes are spelled out because literal
    // combining characters in source are invisible and easy to corrupt.
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 \-_~!.+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 128)
    .trim();
  return cleaned.length ? cleaned : null;
}

/**
 * Transfers the answered call to a SIP endpoint.
 *
 * `from` becomes the caller ID the device sees, so passing the customer's
 * number (not our own) is what makes the iPhone's Recents entry callable.
 * `fromDisplayName` rides the SIP From display name and is what surfaces as
 * the contact name on the incoming call screen.
 */
function transferCall(callControlId, to, from, fromDisplayName) {
  const body = { to, from, timeout_secs: 40 };
  const display = sanitiseDisplayName(fromDisplayName);
  if (display) body.from_display_name = display;
  return telnyxPost(`/calls/${callControlId}/actions/transfer`, body);
}

function playAudioOnCall(callControlId, audioUrl, loop = 'infinity') {
  return telnyxPost(`/calls/${callControlId}/actions/playback_start`, {
    audio_url: audioUrl,
    loop,
    cache_audio: true
  });
}

function stopAudioOnCall(callControlId) {
  return telnyxPost(`/calls/${callControlId}/actions/playback_stop`, {
    stop: 'all'
  });
}

function recordCall(callControlId) {
  return telnyxPost(`/calls/${callControlId}/actions/record_start`, {
    format: 'mp3',
    channels: 'dual'
  });
}

module.exports = { answerCall, speakOnCall, transferCall, playAudioOnCall, stopAudioOnCall, recordCall, sanitiseDisplayName };
