'use strict';
/**
 * lib/assistant/voice.js — ElevenLabs, behind the server.
 *
 * THE KEY NEVER LEAVES RAILWAY
 *   Anything shipped in an iOS binary can be extracted, TestFlight included, so
 *   the app never holds this credential and never talks to ElevenLabs. It asks
 *   Vici for audio and Vici asks ElevenLabs. That also means one place to
 *   disable the whole thing, and the existing session auth already decides who
 *   may ask.
 *
 * WHAT LEAVES THE DEVICE
 *   The sentence to speak, which contains business figures. Nothing else. No
 *   customer record, no phone number, no transcript history. The privacy copy
 *   in the app has to say this, because it is a change from the on-device
 *   build and saying otherwise would be untrue.
 */

const API = 'https://api.elevenlabs.io/v1';

// Elise. Chosen from the community library rather than the synthetic presets,
// which is why it does not sound generated.
const DEFAULT_VOICE_ID = 'EST9Ui6982FZPSi7gCHi';

// The low-latency model. Measured at 0.5 to 0.7s for a two-sentence answer,
// which is what keeps the whole turn inside a conversational feel.
const DEFAULT_MODEL = 'eleven_turbo_v2_5';

// A spoken answer is two or three sentences. This is roughly four times that,
// so it never truncates a real reply, and it caps what one request can spend
// if something upstream goes wrong and hands us a wall of text.
const MAX_CHARACTERS = 1200;

function keyFrom(env) {
  const key = env.ELEVENLABS_API_KEY;
  if (!key) throw Object.assign(new Error('Voice is not configured'), { code: 'VOICE_NOT_CONFIGURED' });
  return key;
}

/**
 * @returns {Promise<{audio: Buffer, contentType: string, characters: number}>}
 */
async function speak({ text, voiceID, env = process.env, fetchImpl = global.fetch, timeoutMs = 15_000 }) {
  const key = keyFrom(env);
  const spoken = String(text || '').trim().slice(0, MAX_CHARACTERS);
  if (!spoken) throw Object.assign(new Error('Nothing to speak'), { code: 'EMPTY_TEXT' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(
      `${API}/text-to-speech/${encodeURIComponent(voiceID || env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID)}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: spoken,
          model_id: env.ELEVENLABS_MODEL || DEFAULT_MODEL,
          voice_settings: { stability: 0.45, similarity_boost: 0.75, speed: 1.04 }
        }),
        signal: controller.signal
      }
    );
    if (!response.ok) {
      throw Object.assign(new Error(`Voice request failed (${response.status})`), {
        code: response.status === 401 ? 'VOICE_KEY_REJECTED' : 'VOICE_FAILED'
      });
    }
    const audio = Buffer.from(await response.arrayBuffer());
    return { audio, contentType: 'audio/mpeg', characters: spoken.length };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The searchable voice library.
 *
 * Community voices only. The synthetic presets are what the owner rejected as
 * sounding generated, and `cloned_by_count` is the honest proxy for "does this
 * sound like a person": a voice thousands of builders chose is one that held up
 * in real products.
 */
async function searchVoices({ query, gender, accent, page = 0, env = process.env, fetchImpl = global.fetch, timeoutMs = 15_000 }) {
  const key = keyFrom(env);
  const params = new URLSearchParams({
    page_size: '30',
    sort: 'cloned_by_count',
    use_cases: 'conversational'
  });
  if (query) params.set('search', String(query).slice(0, 80));
  if (gender) params.set('gender', gender);
  if (accent) params.set('accent', accent);
  if (page > 0) params.set('page', String(page));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${API}/shared-voices?${params}`, {
      headers: { 'xi-api-key': key },
      signal: controller.signal
    });
    if (!response.ok) throw Object.assign(new Error(`Voice search failed (${response.status})`), { code: 'VOICE_SEARCH_FAILED' });
    const data = await response.json();
    return {
      voices: (data.voices || []).map(voice => ({
        id: voice.voice_id,
        name: voice.name,
        accent: voice.accent || null,
        gender: voice.gender || null,
        age: voice.age || null,
        descriptive: voice.descriptive || null,
        // Shown in the picker so a person can tell a widely trusted voice from
        // one nobody has used.
        usedBy: voice.cloned_by_count || 0,
        previewUrl: voice.preview_url || null
      })),
      hasMore: Boolean(data.has_more)
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { DEFAULT_MODEL, DEFAULT_VOICE_ID, MAX_CHARACTERS, searchVoices, speak };
