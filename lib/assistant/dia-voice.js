'use strict';

/**
 * Nari Labs Dia, behind a private GPU endpoint.
 *
 * Dia is not loaded in the Railway process. The official 1.6B checkpoint is
 * GPU-first and large enough to interfere with webhooks and the SMS worker if
 * it shares this service. Railway only orchestrates a narrow, authenticated
 * endpoint that returns the finished MP3 before Telnyx is allowed to dial.
 *
 * The profile id is immutable. The GPU service binds that id to a pinned model
 * revision, fixed sampling seeds, and a signal-quality gate. No customer or
 * iOS client can supply an arbitrary reference voice or sampling controls.
 */

const PROVIDER = 'dia';
const MODEL_ID = 'nari-labs/Dia-1.6B-0626';
const MODEL_REVISION = 'ef2795fcc29c5abe6ffc91fd33808588b49bbc66';
const DEFAULT_VOICE_ID = 'dia_vici_sunny_v1';
const DEFAULT_VOICE_NAME = 'Dia Sunny';
const MAX_CHARACTERS = 1200;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 480_000;
const HEALTH_PROBE_TIMEOUT_MS = 15_000;

const NONVERBAL_TAGS = [
  'laughs', 'laugh', 'chuckle', 'coughs', 'clears throat', 'sighs', 'gasps',
  'singing', 'sings', 'mumbles', 'beep', 'groans', 'sniffs', 'claps',
  'screams', 'inhales', 'exhales', 'applause', 'burps', 'humming',
  'sneezes', 'whistles'
];

function cleanID(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : '';
}

function endpointURL(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  // The endpoint is configured by an operator, not accepted from a request.
  // Still refuse loopback, link-local and raw IP destinations so a leaked
  // settings write cannot turn synthesis into an SSRF primitive.
  const host = url.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')
      || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) return null;
  url.pathname = url.pathname.replace(/\/$/, '') || '/';
  return url;
}

function configuration(env = process.env) {
  const endpoint = endpointURL(env.DIA_TTS_ENDPOINT);
  const key = String(env.DIA_TTS_API_KEY || '').trim();
  const voiceID = cleanID(env.DIA_VOICE_PROFILE_ID || DEFAULT_VOICE_ID);
  const voiceName = String(env.DIA_VOICE_NAME || DEFAULT_VOICE_NAME).trim().slice(0, 80);
  const modelID = String(env.DIA_MODEL_ID || MODEL_ID).trim();
  const modelRevision = String(env.DIA_MODEL_REVISION || MODEL_REVISION).trim();
  if (!endpoint) throw Object.assign(new Error('Dia voice endpoint is not configured.'), {
    code: 'DIA_ENDPOINT_INVALID'
  });
  if (key.length < 20) throw Object.assign(new Error('Dia voice credentials are not configured.'), {
    code: 'DIA_KEY_MISSING'
  });
  if (!voiceID || !voiceName) throw Object.assign(new Error('Dia voice profile is invalid.'), {
    code: 'DIA_PROFILE_INVALID'
  });
  if (modelID !== MODEL_ID || modelRevision !== MODEL_REVISION) {
    throw Object.assign(new Error('Dia model identity is not pinned to the reviewed checkpoint.'), {
      code: 'DIA_MODEL_INVALID'
    });
  }
  return { endpoint, key, voiceID, voiceName, modelID, modelRevision };
}

/**
 * Provider control syntax may never come from a product name, customer name,
 * or editable shared template. The private endpoint adds its own single [S1]
 * marker after this boundary.
 */
function safeText(value) {
  let text = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  text = text.replace(/\[S[12]\]/gi, '');
  for (const tag of NONVERBAL_TAGS) {
    text = text.replace(new RegExp(`\\(${tag.replace(/ /g, '\\s+')}\\)`, 'gi'), '');
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_CHARACTERS);
}

function voiceFromConfiguration(config) {
  return {
    id: config.voiceID,
    name: config.voiceName,
    provider: PROVIDER,
    providerLabel: 'Dia · Nari Labs',
    modelId: `${config.modelID}@${config.modelRevision}`,
    accent: 'american',
    gender: 'female',
    age: 'young adult',
    language: 'en',
    descriptive: 'Fixed-seed Vici voice selected for a warm, upbeat American delivery.',
    category: 'generated_seed_profile',
    professionalClone: false,
    syntheticDesign: true,
    previewUrl: null,
    verified: true
  };
}

async function listDiaVoices({ env = process.env } = {}) {
  return [voiceFromConfiguration(configuration(env))];
}

function timeoutValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(30_000, Math.min(600_000, parsed)) : DEFAULT_TIMEOUT_MS;
}

function retryDelayValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(500, Math.min(15_000, parsed)) : 5_000;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function validMP3(audio) {
  if (!Buffer.isBuffer(audio) || audio.length < 4) return false;
  return audio.subarray(0, 3).toString('ascii') === 'ID3'
    || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0);
}

async function speak({ text, voiceID, modelID, env = process.env,
  fetchImpl = global.fetch, timeoutMs, waitImpl = delay } = {}) {
  const config = configuration(env);
  const spoken = safeText(text);
  if (!spoken) throw Object.assign(new Error('Nothing to speak.'), { code: 'EMPTY_TEXT' });
  if (cleanID(voiceID) !== config.voiceID) {
    throw Object.assign(new Error('That Dia voice profile is not authorized.'), { code: 'DIA_PROFILE_INVALID' });
  }
  const immutableModelID = `${config.modelID}@${config.modelRevision}`;
  if (modelID && modelID !== immutableModelID) {
    throw Object.assign(new Error('That Dia model revision is not authorized.'), { code: 'DIA_MODEL_INVALID' });
  }

  const requestTimeout = timeoutValue(timeoutMs || env.DIA_REQUEST_TIMEOUT_MS);
  const retryDelay = retryDelayValue(env.DIA_WAKE_RETRY_MS);
  const deadline = Date.now() + requestTimeout;
  const healthEndpoint = new URL('/health', config.endpoint);

  async function waitUntilReady() {
    while (Date.now() < deadline) {
      const controller = new AbortController();
      const remaining = deadline - Date.now();
      const timer = setTimeout(() => controller.abort(), Math.min(HEALTH_PROBE_TIMEOUT_MS, remaining));
      let response = null;
      try {
        response = await fetchImpl(healthEndpoint.href, {
          method: 'GET', redirect: 'error', headers: { Accept: 'application/json' }, signal: controller.signal
        });
      } catch (error) {
        if (error?.name !== 'AbortError' && Date.now() >= deadline) throw error;
      } finally {
        clearTimeout(timer);
      }
      if (response?.ok) {
        try { await response.body?.cancel?.(); } catch {}
        return;
      }
      if (response && ![502, 503, 504].includes(response.status)) {
        try { await response.body?.cancel?.(); } catch {}
        throw Object.assign(new Error(`Dia health check failed (${response.status}).`), {
          code: 'DIA_ENDPOINT_INVALID', status: response.status
        });
      }
      try { await response?.body?.cancel?.(); } catch {}
      if (Date.now() + retryDelay >= deadline) break;
      await waitImpl(retryDelay);
    }
    throw Object.assign(new Error('Dia voice endpoint is still waking.'), {
      code: 'DIA_ENDPOINT_WARMING', status: 503
    });
  }

  while (Date.now() < deadline) {
    await waitUntilReady();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    const request = {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${config.key}`,
        Accept: 'audio/mpeg',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.modelID,
        model_revision: config.modelRevision,
        voice: config.voiceID,
        input: spoken,
        response_format: 'mp3'
      }),
      signal: controller.signal
    };
    let response;
    try {
      response = await fetchImpl(config.endpoint.href, request);
    } catch (error) {
      if (error?.name === 'AbortError' || Date.now() >= deadline) {
        throw Object.assign(new Error('Dia voice generation timed out.'), {
          code: 'DIA_ENDPOINT_WARMING', status: 503
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if ([502, 503, 504].includes(response.status)) {
      try { await response.body?.cancel?.(); } catch {}
      if (Date.now() + retryDelay >= deadline) break;
      await waitImpl(retryDelay);
      continue;
    }
    if (!response.ok) {
      throw Object.assign(new Error(`Dia voice request failed (${response.status}).`), {
        code: response.status === 401 || response.status === 403
          ? 'DIA_KEY_REJECTED' : 'DIA_VOICE_FAILED',
        status: response.status
      });
    }
    const type = String(response.headers?.get?.('content-type') || '').split(';')[0].toLowerCase();
    const declared = Number(response.headers?.get?.('content-length') || 0);
    if (type !== 'audio/mpeg' || declared > MAX_AUDIO_BYTES) {
      throw Object.assign(new Error('Dia returned an invalid audio response.'), { code: 'DIA_AUDIO_INVALID' });
    }
    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.length > MAX_AUDIO_BYTES || !validMP3(audio)) {
      throw Object.assign(new Error('Dia returned an invalid MP3.'), { code: 'DIA_AUDIO_INVALID' });
    }
    return { audio, contentType: 'audio/mpeg', characters: spoken.length };
  }
  throw Object.assign(new Error('Dia voice endpoint is still waking.'), {
    code: 'DIA_ENDPOINT_WARMING', status: 503
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_VOICE_ID,
  DEFAULT_VOICE_NAME,
  HEALTH_PROBE_TIMEOUT_MS,
  MAX_AUDIO_BYTES,
  MAX_CHARACTERS,
  MODEL_ID,
  MODEL_REVISION,
  NONVERBAL_TAGS,
  PROVIDER,
  configuration,
  endpointURL,
  listDiaVoices,
  safeText,
  speak,
  retryDelayValue,
  validMP3,
  voiceFromConfiguration
};
