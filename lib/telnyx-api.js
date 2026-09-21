'use strict';

const BASE = 'https://api.telnyx.com/v2';

async function telnyxPost(path, body = {}, { env = process.env, fetchImpl = global.fetch } = {}) {
  const res = await fetchImpl(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.TELNYX_API_KEY}`,
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

function createOutboundCall({ to, from, connectionId, webhookUrl, amdMode, clientState, commandId }, options) {
  return telnyxPost('/calls', {
    to,
    from,
    connection_id: connectionId,
    webhook_url: webhookUrl,
    webhook_url_method: 'POST',
    answering_machine_detection: amdMode,
    client_state: clientState,
    command_id: commandId,
    timeout_secs: 45,
    time_limit_secs: 180
  }, options);
}

function answerCall(callControlId, { clientState, commandId } = {}, options) {
  const body = {};
  if (clientState) body.client_state = clientState;
  if (commandId) body.command_id = commandId;
  return telnyxPost(`/calls/${encodeURIComponent(callControlId)}/actions/answer`, body, options);
}

function speakOnCall(callControlId, text) {
  return telnyxPost(`/calls/${callControlId}/actions/speak`, {
    payload: text,
    voice: 'female',
    language: 'en-US'
  });
}

/**
 * Speak an IVR prompt while collecting DTMF. Telnyx requires the call to be
 * answered first and returns the result through call.gather.ended.
 */
function gatherUsingSpeak(callControlId, text, {
  validDigits = '0123456789', minimumDigits = 1, maximumDigits = 1,
  terminatingDigit = '', maximumTries = 2, timeoutMillis = 10000,
  invalidPayload = 'That was not a valid selection. Please try again.',
  clientState, commandId
} = {}, options) {
  const body = {
    payload: text,
    invalid_payload: invalidPayload,
    payload_type: 'text',
    service_level: 'premium',
    voice: 'Azure.en-US-BrianMultilingualNeural',
    language: 'en-US',
    minimum_digits: minimumDigits,
    maximum_digits: maximumDigits,
    terminating_digit: terminatingDigit,
    valid_digits: validDigits,
    maximum_tries: maximumTries,
    timeout_millis: timeoutMillis
  };
  if (clientState) body.client_state = clientState;
  if (commandId) body.command_id = commandId;
  return telnyxPost(`/calls/${encodeURIComponent(callControlId)}/actions/gather_using_speak`, body, options);
}

function speakStatefulOnCall(callControlId, text, { clientState, commandId } = {}, options) {
  const body = {
    payload: text,
    payload_type: 'text',
    voice: 'Azure.en-US-BrianMultilingualNeural',
    language: 'en-US'
  };
  if (clientState) body.client_state = clientState;
  if (commandId) body.command_id = commandId;
  return telnyxPost(`/calls/${encodeURIComponent(callControlId)}/actions/speak`, body, options);
}

function speakPremiumOnCall(callControlId, text, { voice, apiKeyRef, commandId }, options) {
  const body = {
    payload: text,
    payload_type: 'text',
    voice,
    language: 'en-US',
    command_id: commandId
  };
  if (apiKeyRef) body.voice_settings = { api_key_ref: apiKeyRef };
  return telnyxPost(`/calls/${encodeURIComponent(callControlId)}/actions/speak`, body, options);
}

function startTranscription(callControlId, commandId, options) {
  return telnyxPost(`/calls/${encodeURIComponent(callControlId)}/actions/transcription_start`, {
    language: 'en',
    transcription_engine: 'B',
    transcription_tracks: 'inbound',
    command_id: commandId
  }, options);
}

function hangupCall(callControlId, commandId, options) {
  return telnyxPost(`/calls/${encodeURIComponent(callControlId)}/actions/hangup`, {
    command_id: commandId
  }, options);
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
function transferCall(callControlId, to, from, fromDisplayName, commandId, options) {
  const body = { to, from, timeout_secs: 40 };
  const display = sanitiseDisplayName(fromDisplayName);
  if (display) body.from_display_name = display;
  if (commandId) body.command_id = commandId;
  return telnyxPost(`/calls/${encodeURIComponent(callControlId)}/actions/transfer`, body, options);
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

module.exports = {
  answerCall, createOutboundCall, hangupCall, speakOnCall, speakPremiumOnCall,
  startTranscription, transferCall, playAudioOnCall, stopAudioOnCall, recordCall,
  gatherUsingSpeak, speakStatefulOnCall,
  sanitiseDisplayName, telnyxPost
};
