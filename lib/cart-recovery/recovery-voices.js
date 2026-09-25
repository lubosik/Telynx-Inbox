'use strict';

// Curated from Professional Voice Clones actually copied into the connected
// ElevenLabs account. Premade/generated voices and private instant clones are
// deliberately excluded: realistic output is not enough without documented
// Voice Library provenance and verification. The live account catalogue remains
// the authority if an owner removes or disables a shared voice.
// The owner reviewed the live catalogue on 2026-09-25 and retained only
// Gracie Social. A short, trusted picker is more useful than a long list of
// voices that are technically eligible but do not sound convincing in the
// actual recovery script.
const PREFERRED_US_VOICE_IDS = Object.freeze([
  'T7eLpgAAhoXHlrNajG8v' // Gracie Social, professional American female clone
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
