'use strict';

const { getIOSVoiceCredentials } = require('../voice-credentials');

const HUMAN_TEMPLATE_VERSION = 'abandoned_cart_voice_human_v2';
const VOICEMAIL_TEMPLATE_VERSION = 'abandoned_cart_voice_voicemail_v2';

const HUMAN_TEMPLATE = 'Hi {{first_name}}, this is an automated message from Vin at Vici Peptides. You left {{product_phrase}} in your cart. I was just wondering if you\'re still interested. I sent you a text earlier, so you can pick up where you left off there. To speak with our customer care team, press 1. To stop automated calls, say "stop" or press 9.';
const VOICEMAIL_TEMPLATE = 'Hi {{first_name}}, it\'s Vin from Vici Peptides. You left {{product_phrase}} in your cart. I was just wondering if you\'re still interested. I sent you a text earlier, so you can pick up where you left off there. To stop future automated calls from Vici, call {{voice_opt_out_toll_free_number}}.';

const OPT_OUT_PHRASES = [
  /\bstop\b/i,
  /\bstop calling(?: me)?\b/i,
  /\bdo not call(?: me)?\b/i,
  /\bdon['’]?t call(?: me)?\b/i,
  /\btake me off\b/i,
  /\bremove me\b/i,
  /\bno more calls?\b/i
];

const HUMAN_RESULTS = new Set(['human', 'human_residence', 'human_business']);
const MACHINE_RESULTS = new Set(['machine', 'machine_residence', 'machine_business', 'machine_end_beep', 'beep_detected']);
const TERMINAL_NONDELIVERY_RESULTS = new Set(['fax_detected', 'silence', 'not_sure']);
const ALLOWED_AMD_MODES = new Set([
  'detect', 'detect_beep', 'detect_words', 'greeting_end', 'premium',
  'premium_ios_call_screening_detection'
]);

function clean(value, max = 180) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function firstName(value) {
  const result = clean(value, 60).split(' ')[0].replace(/[^\p{L}\p{M}'-]/gu, '');
  return result.length >= 2 ? result : 'there';
}

function productPhrase(items, aliases = {}) {
  const rows = Array.isArray(items) ? items.filter(Boolean) : [];
  if (rows.length !== 1) return 'the items';
  const raw = clean(rows[0]?.product_name || rows[0]?.name || '', 120);
  if (!raw) return 'the item';
  const byID = aliases[String(rows[0]?.product_id || '')];
  const byName = aliases[raw.toLowerCase()];
  return clean(byID || byName || raw.replace(/[-_]+/g, ' '), 120) || 'the item';
}

function render(template, values) {
  return String(template || '').replace(/{{\s*([a-z_]+)\s*}}/g, (_match, key) => clean(values[key], 180));
}

function renderVoiceScripts({ firstName: name, items, tollFreeNumber, humanTemplate = HUMAN_TEMPLATE,
  voicemailTemplate = VOICEMAIL_TEMPLATE, productAliases = {} }) {
  const values = {
    first_name: firstName(name),
    product_phrase: productPhrase(items, productAliases),
    voice_opt_out_toll_free_number: clean(tollFreeNumber, 30)
  };
  const human = render(humanTemplate, values);
  const voicemail = render(voicemailTemplate, values);
  if (!/automated message/i.test(human) || !/say ["“]?stop/i.test(human) || !/press 9/i.test(human) || !/press 1/i.test(human)) {
    throw Object.assign(new Error('The human-answer message must identify automation and offer spoken STOP, press 9, and press 1.'), {
      code: 'INVALID_VOICE_HUMAN_TEMPLATE'
    });
  }
  if (!values.voice_opt_out_toll_free_number || !voicemail.includes(values.voice_opt_out_toll_free_number)) {
    throw Object.assign(new Error('The voicemail message requires the configured toll-free opt-out number.'), {
      code: 'VOICE_OPT_OUT_NUMBER_REQUIRED'
    });
  }
  return { human, voicemail, productPhrase: values.product_phrase };
}

function isSpokenOptOut(transcript) {
  const normalized = clean(transcript, 500);
  return normalized.length > 0 && OPT_OUT_PHRASES.some(pattern => pattern.test(normalized));
}

function amdBranch(result) {
  const normalized = String(result || '').toLowerCase();
  if (HUMAN_RESULTS.has(normalized)) return 'human';
  if (MACHINE_RESULTS.has(normalized) || normalized.includes('machine')) return 'machine';
  if (TERMINAL_NONDELIVERY_RESULTS.has(normalized) || normalized.includes('fax')) return 'undeliverable';
  return 'unknown';
}

function parseHourMinute(value, fallback) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || fallback));
  if (!match) return parseHourMinute(fallback, '09:00');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : parseHourMinute(fallback, '09:00');
}

function localMinute(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return Number(values.hour) * 60 + Number(values.minute);
}

function insideCallingWindow({ now = new Date(), timeZone = 'America/New_York', start = '09:00', end = '20:00' } = {}) {
  let minute;
  try { minute = localMinute(now, timeZone); } catch { return false; }
  const lower = parseHourMinute(start, '09:00');
  const upper = parseHourMinute(end, '20:00');
  return lower < upper && minute >= lower && minute < upper;
}

function voiceConfiguration(env = process.env, settings = {}) {
  const amdMode = String(env.TELNYX_ABANDONED_CART_AMD_MODE || settings.voice_amd_mode || 'premium_ios_call_screening_detection');
  const voiceID = String(settings.voice_id || env.ELEVENLABS_VIN_VOICE_ID || '').trim();
  const voiceProvider = String(settings.voice_provider || 'elevenlabs').trim().toLowerCase();
  const modelID = String(settings.voice_model_id || env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5').trim();
  const humanAnswerMode = String(settings.voice_human_answer_mode || 'DISABLED').toUpperCase();
  const explicitTransferNumber = String(settings.voice_transfer_number || env.VICI_LIVE_TRANSFER_NUMBER || '').trim();
  const sipLogin = String(getIOSVoiceCredentials(env).login || '').trim();
  // Reuse the same authenticated Vici Inbox SIP destination that already
  // receives ordinary customer calls. The 305 number remains caller ID and
  // the toll-free number remains opt-out only, so neither can create a loop.
  const inboxTransferTarget = sipLogin ? `sip:${sipLogin}@sip.telnyx.com` : '';
  const transferNumber = explicitTransferNumber || inboxTransferTarget;
  const tollFreeNumber = String(settings.voice_opt_out_toll_free_number || env.VICI_VOICE_OPT_OUT_TOLL_FREE_NUMBER || '').trim();
  const errors = [];
  if (!ALLOWED_AMD_MODES.has(amdMode)) errors.push('invalid_amd_mode');
  if (!/^\+[1-9]\d{7,14}$/.test(env.TELNYX_PHONE_NUMBER || '')) errors.push('caller_id_missing');
  if (!env.TELNYX_API_KEY) errors.push('telnyx_api_key_missing');
  if (!env.TELNYX_CONNECTION_ID) errors.push('telnyx_connection_missing');
  if (!['elevenlabs', 'qwen', 'dia'].includes(voiceProvider)) errors.push('invalid_voice_provider');
  if (voiceProvider === 'elevenlabs' && !env.ELEVENLABS_API_KEY) errors.push('elevenlabs_api_key_missing');
  if (voiceProvider === 'qwen' && !env.DASHSCOPE_API_KEY) errors.push('qwen_api_key_missing');
  if (voiceProvider === 'qwen' && !/^ws-[a-z0-9]+$/.test(String(env.DASHSCOPE_WORKSPACE_ID || ''))) {
    errors.push('qwen_workspace_missing');
  }
  if (voiceProvider === 'dia' && !env.DIA_TTS_ENDPOINT) errors.push('dia_endpoint_missing');
  if (voiceProvider === 'dia' && !env.DIA_TTS_API_KEY) errors.push('dia_api_key_missing');
  if (!voiceID) errors.push('vin_voice_missing');
  if (!/^\+[1-9]\d{7,14}$/.test(tollFreeNumber)) errors.push('toll_free_opt_out_missing');
  if (humanAnswerMode !== 'DISABLED' && !transferNumber) errors.push('transfer_number_missing');
  if (explicitTransferNumber && !/^\+[1-9]\d{7,14}$/.test(explicitTransferNumber)) errors.push('invalid_transfer_number');
  if (explicitTransferNumber && explicitTransferNumber === env.TELNYX_PHONE_NUMBER) errors.push('transfer_loop');
  return { valid: errors.length === 0, errors, amdMode, voiceProvider, voiceID, modelID,
    transferNumber, tollFreeNumber,
    telnyxVoice: voiceProvider === 'elevenlabs' ? `ElevenLabs.${modelID}.${voiceID}` : null };
}

/**
 * Voice consent is its own signed, versioned authority. A missing/stale GHL
 * DND observation is not an opt-out and must not cancel that affirmative
 * evidence. Every positive refusal remains controlling: explicit GHL DND,
 * STOP, an authoritative suppression, an internal/test exclusion, or a failed
 * eligibility read still blocks the call.
 *
 * Callers may use this only after `latestVoiceConsent` has proved the current
 * combined consent event. This function never manufactures consent itself.
 */
function applyCurrentVoiceConsent(recipient) {
  if (recipient?.eligible === true) return recipient;
  if (recipient?.reason !== 'dnd_unknown') return recipient;
  return { ...recipient, eligible: true, reason: 'eligible_with_current_voice_consent' };
}

module.exports = {
  HUMAN_TEMPLATE, VOICEMAIL_TEMPLATE, HUMAN_TEMPLATE_VERSION, VOICEMAIL_TEMPLATE_VERSION,
  ALLOWED_AMD_MODES, amdBranch, applyCurrentVoiceConsent, insideCallingWindow, isSpokenOptOut, productPhrase,
  renderVoiceScripts, voiceConfiguration
};
