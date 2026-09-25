'use strict';

// Curated from Professional Voice Clones actually copied into the connected
// ElevenLabs account. Premade/generated voices and private instant clones are
// deliberately excluded: realistic output is not enough without documented
// Voice Library provenance and verification. The live account catalogue remains
// the authority if an owner removes or disables a shared voice.
// Keep a male majority for Vin, with a few optional female alternatives.
const PREFERRED_US_VOICE_IDS = Object.freeze([
  'UgBBYS2sOqTuMpoF3BR0', // Mark, conversational male
  'yHx9q5iHmtVGKONrqrIf', // Dez, grounded male
  '0pa5K4pOrbnP5VS5eH6k', // JM, podcast male
  'bbGtsRRKUfYO634UxSjz', // Leo, direct male
  '84Fal4DSXWfp7nJ8emqQ', // Motivational Coach, confident male
  '6u6JbqKdaQy89ENzLSju', // Brielle, conversational female
  'T7eLpgAAhoXHlrNajG8v', // Gracie Social, bubbly influencer-style female
  'kdmDKE6EkgrWrrykO9Qt', // Alexandra, youthful natural female
  'PoHUWWWMHFrA8z7Q88pu'  // Miranda Bright, sweet commercial female
]);

function curatedRecoveryVoices(accountVoices) {
  const available = new Map((accountVoices || [])
    .filter(voice => voice.professionalClone === true
      && voice.verified === true
      && voice.category === 'professional'
      && String(voice.language || '').toLowerCase() === 'en'
      && String(voice.accent || '').toLowerCase() === 'american')
    .map(voice => [voice.id, voice]));
  return PREFERRED_US_VOICE_IDS.map(id => available.get(id)).filter(Boolean);
}

module.exports = { PREFERRED_US_VOICE_IDS, curatedRecoveryVoices };
