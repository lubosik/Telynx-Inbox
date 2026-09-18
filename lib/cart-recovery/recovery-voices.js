'use strict';

// Curated from the voices actually saved in the connected ElevenLabs account.
// Professional voices lead because their source recordings are higher fidelity;
// the account catalogue remains the authority if a voice is removed or disabled.
// Keep a male majority for Vin, with a few optional female alternatives.
const PREFERRED_US_VOICE_IDS = Object.freeze([
  'UgBBYS2sOqTuMpoF3BR0', // Mark, conversational male
  'yHx9q5iHmtVGKONrqrIf', // Dez, grounded male
  '0pa5K4pOrbnP5VS5eH6k', // JM, podcast male
  'bbGtsRRKUfYO634UxSjz', // Leo, direct male
  '84Fal4DSXWfp7nJ8emqQ', // Motivational Coach, confident male
  '6u6JbqKdaQy89ENzLSju', // Brielle, conversational female
  'EST9Ui6982FZPSi7gCHi', // Elise, warm female
  'RXtWW6etvimS8QJ5nhVk'  // Fiona, relaxed female
]);

function curatedRecoveryVoices(accountVoices) {
  const available = new Map((accountVoices || [])
    .filter(voice => voice.verified === true && String(voice.accent || '').toLowerCase() === 'american')
    .map(voice => [voice.id, voice]));
  return PREFERRED_US_VOICE_IDS.map(id => available.get(id)).filter(Boolean);
}

module.exports = { PREFERRED_US_VOICE_IDS, curatedRecoveryVoices };
