'use strict';

// Alibaba Cloud Model Studio Qwen VoiceDesign, behind the Vici server.
// Credentials never leave Railway. Only account-scoped, English voices whose
// names begin with the Vici operations prefix are exposed to the app.

const PROVIDER = 'qwen';
const REGION = 'ap-southeast-1';
const DESIGN_MODEL = 'qwen-voice-design';
const TARGET_MODEL = 'qwen3-tts-vd-2026-01-26';
const VICI_PREFIX = 'vici_';
const MAX_CHARACTERS = 1200;
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

const FRIENDLY_NAMES = Object.freeze({
  vici_miami: 'Maya Social',
  vici_brielle: 'Brielle Natural',
  vici_sienna: 'Sienna Bright',
  vici_ava: 'Ava Conversational',
  vici_chloe: 'Chloe Warm',
  vici_sofia: 'Sofia Polished'
});

function configuration(env = process.env) {
  const key = String(env.DASHSCOPE_API_KEY || '').trim();
  const workspaceID = String(env.DASHSCOPE_WORKSPACE_ID || '').trim();
  if (!key) throw Object.assign(new Error('Qwen voice is not configured.'), { code: 'QWEN_VOICE_NOT_CONFIGURED' });
  if (!/^ws-[a-z0-9]+$/.test(workspaceID)) {
    throw Object.assign(new Error('The Qwen workspace ID is invalid.'), { code: 'QWEN_WORKSPACE_INVALID' });
  }
  return {
    key,
    workspaceID,
    origin: `https://${workspaceID}.${REGION}.maas.aliyuncs.com`
  };
}

function safeAudioURL(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password
      || (!host.endsWith('.aliyuncs.com') && !host.endsWith('.alibabacloud.com'))) return null;
  return url.href;
}

async function requestJSON(path, payload, { env = process.env, fetchImpl = global.fetch,
  timeoutMs = 30_000 } = {}) {
  const { key, origin } = configuration(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${origin}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!response.ok) {
      throw Object.assign(new Error(`Qwen voice request failed (${response.status}).`), {
        code: response.status === 401 || response.status === 403 ? 'QWEN_VOICE_KEY_REJECTED' : 'QWEN_VOICE_FAILED',
        status: response.status
      });
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function cleanVoiceID(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : '';
}

function friendlyName(id) {
  const key = Object.keys(FRIENDLY_NAMES).find(prefix => id === prefix || id.startsWith(`${prefix}_`));
  if (key) return FRIENDLY_NAMES[key];
  return id.replace(/^vici_/, '').replace(/[_-]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

async function listDesignedVoices({ env = process.env, fetchImpl = global.fetch, timeoutMs = 15_000 } = {}) {
  const data = await requestJSON('/api/v1/services/audio/tts/customization', {
    model: DESIGN_MODEL,
    input: { action: 'list', page_size: 100, page_index: 0 }
  }, { env, fetchImpl, timeoutMs });
  return (data?.output?.voice_list || []).map(item => {
    const id = cleanVoiceID(item?.voice);
    const prompt = String(item?.voice_prompt || '').trim();
    const language = String(item?.language || '').toLowerCase();
    const modelID = String(item?.target_model || '').trim();
    if (!id.startsWith(VICI_PREFIX) || language !== 'en' || modelID !== TARGET_MODEL) return null;
    return {
      id,
      name: friendlyName(id),
      provider: PROVIDER,
      providerLabel: 'Qwen VoiceDesign',
      modelId: modelID,
      accent: /american|united states|south florida|miami/i.test(prompt) ? 'american' : 'american',
      gender: /female|woman/i.test(prompt) ? 'female' : (/male|man/i.test(prompt) ? 'male' : null),
      age: /young adult/i.test(prompt) ? 'young adult' : null,
      language: 'en',
      descriptive: prompt.slice(0, 240) || 'Designed conversational voice',
      category: 'designed',
      professionalClone: false,
      syntheticDesign: true,
      previewUrl: null,
      verified: true
    };
  }).filter(Boolean);
}

async function designVoice({ preferredName, voicePrompt, previewText, env = process.env,
  fetchImpl = global.fetch, timeoutMs = 60_000 } = {}) {
  const name = String(preferredName || '').trim();
  const prompt = String(voicePrompt || '').trim();
  const preview = String(previewText || '').trim();
  if (!/^vici_[A-Za-z0-9_]{1,11}$/.test(name)) {
    throw Object.assign(new Error('Qwen voice names must use the approved Vici prefix.'), { code: 'QWEN_VOICE_NAME_INVALID' });
  }
  if (!prompt || prompt.length > 2048 || !preview || preview.length > 1024) {
    throw Object.assign(new Error('The Qwen voice description or preview text is invalid.'), { code: 'QWEN_VOICE_DESIGN_INVALID' });
  }
  const data = await requestJSON('/api/v1/services/audio/tts/customization', {
    model: DESIGN_MODEL,
    input: {
      action: 'create', target_model: TARGET_MODEL, preferred_name: name,
      voice_prompt: prompt, preview_text: preview, language: 'en'
    },
    parameters: { sample_rate: 24000, response_format: 'wav' }
  }, { env, fetchImpl, timeoutMs });
  const id = cleanVoiceID(data?.output?.voice);
  const encoded = String(data?.output?.preview_audio?.data || '');
  const audio = encoded ? Buffer.from(encoded, 'base64') : Buffer.alloc(0);
  if (!id || !id.startsWith(VICI_PREFIX) || !audio.length || audio.length > MAX_AUDIO_BYTES) {
    throw Object.assign(new Error('Qwen returned an invalid voice design response.'), { code: 'QWEN_VOICE_DESIGN_FAILED' });
  }
  return { id, modelId: data.output.target_model || TARGET_MODEL, audio, contentType: 'audio/wav' };
}

async function downloadAudio(url, { fetchImpl = global.fetch, timeoutMs = 30_000 } = {}) {
  const href = safeAudioURL(url);
  if (!href) throw Object.assign(new Error('Qwen returned an unsafe audio location.'), { code: 'QWEN_AUDIO_URL_INVALID' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(href, { signal: controller.signal, redirect: 'error' });
    const declared = Number(response.headers?.get?.('content-length') || 0);
    if (!response.ok || declared > MAX_AUDIO_BYTES) {
      throw Object.assign(new Error('Qwen audio download failed.'), { code: 'QWEN_AUDIO_DOWNLOAD_FAILED' });
    }
    const audio = Buffer.from(await response.arrayBuffer());
    if (!audio.length || audio.length > MAX_AUDIO_BYTES) {
      throw Object.assign(new Error('Qwen returned invalid audio.'), { code: 'QWEN_AUDIO_INVALID' });
    }
    const contentType = String(response.headers?.get?.('content-type') || 'audio/wav').split(';')[0];
    if (!/^audio\//i.test(contentType) && contentType !== 'application/octet-stream') {
      throw Object.assign(new Error('Qwen returned an invalid audio type.'), { code: 'QWEN_AUDIO_INVALID' });
    }
    return { audio, contentType: /^audio\//i.test(contentType) ? contentType : 'audio/wav' };
  } finally { clearTimeout(timer); }
}

async function speak({ text, voiceID, modelID = TARGET_MODEL, env = process.env,
  fetchImpl = global.fetch, timeoutMs = 45_000 } = {}) {
  const spoken = String(text || '').trim().slice(0, MAX_CHARACTERS);
  const id = cleanVoiceID(voiceID);
  if (!spoken) throw Object.assign(new Error('Nothing to speak.'), { code: 'EMPTY_TEXT' });
  if (!id.startsWith(VICI_PREFIX) || modelID !== TARGET_MODEL) {
    throw Object.assign(new Error('That Qwen voice is not authorized.'), { code: 'QWEN_VOICE_INVALID' });
  }
  const data = await requestJSON('/api/v1/services/aigc/multimodal-generation/generation', {
    model: TARGET_MODEL,
    input: { text: spoken, voice: id }
  }, { env, fetchImpl, timeoutMs });
  const inline = String(data?.output?.audio?.data || '');
  if (inline) {
    const audio = Buffer.from(inline.replace(/^data:audio\/[^;]+;base64,/, ''), 'base64');
    if (audio.length && audio.length <= MAX_AUDIO_BYTES) return { audio, contentType: 'audio/wav', characters: spoken.length };
  }
  const downloaded = await downloadAudio(data?.output?.audio?.url, { fetchImpl, timeoutMs });
  return { ...downloaded, characters: spoken.length };
}

module.exports = {
  DESIGN_MODEL, FRIENDLY_NAMES, MAX_AUDIO_BYTES, PROVIDER, REGION, TARGET_MODEL, VICI_PREFIX,
  configuration, designVoice, downloadAudio, listDesignedVoices, safeAudioURL, speak
};
