'use strict';

// One-time, operator-run Qwen VoiceDesign pilot. This creates provider assets
// and incurs VoiceDesign usage, but never calls or messages a customer.
// Required gate: QWEN_VOICE_DESIGN_CONFIRM=CREATE_VICI_QWEN_VOICES

const fs = require('node:fs/promises');
const path = require('node:path');
const { designVoice, listDesignedVoices } = require('../lib/assistant/qwen-voice');

const PREVIEW = 'Hi Maya, it is Vin from Vici Peptides. You left GHK in your cart. I sent you a text earlier so you can pick up where you left off. If you have any questions, press 1 to speak with the Vici team.';

const PROFILES = Object.freeze([
  {
    preferredName: 'vici_miami',
    prompt: 'A highly realistic young adult American woman from South Florida. Warm, bright, confident, naturally conversational, lightly energetic, medium pitch, medium pace, crisp articulation, subtle smile, and modern social-media presenter polish. She sounds like a real person leaving a helpful customer-care message, never theatrical, breathy, robotic, or like a radio announcer.'
  },
  {
    preferredName: 'vici_brielle',
    prompt: 'A highly realistic young adult American woman with a warm, friendly, relaxed voice. Medium pitch, natural rhythm, clear consonants, gentle confidence, and understated enthusiasm. Suitable for a personal customer-care phone message. Avoid exaggerated influencer intonation, sales-announcer delivery, vocal fry, and synthetic cadence.'
  },
  {
    preferredName: 'vici_sienna',
    prompt: 'A highly realistic young adult American woman with a bright, upbeat, polished conversational voice. Slightly fast but easy to follow, expressive without exaggeration, clear and friendly, with a subtle smile. Suitable for a modern wellness brand voice assistant. Never theatrical, sing-song, robotic, or pushy.'
  },
  {
    preferredName: 'vici_ava',
    prompt: 'A highly realistic young adult American woman with a calm, intimate, one-to-one speaking style. Medium-low pitch, steady natural pace, warm tone, clean articulation, and trustworthy customer-service presence. Sound spontaneous and human, not scripted, breathy, dramatic, or promotional.'
  },
  {
    preferredName: 'vici_chloe',
    prompt: 'A highly realistic young adult American woman with a friendly, sweet, modern voice. Medium pitch, lightly energetic pace, natural pauses, confident clarity, and warm conversational delivery. Appropriate for helpful ecommerce follow-up. Avoid cartoonish brightness, hard selling, robotic timing, and exaggerated upward inflection.'
  },
  {
    preferredName: 'vici_sofia',
    prompt: 'A highly realistic young adult American woman with polished South Florida warmth. Clear, composed, subtly upbeat, medium pitch, medium pace, and naturally expressive. Suitable for premium health and wellness customer care. Sound like an authentic person on the phone, not an announcer, actor, or synthetic assistant.'
  }
]);

async function main() {
  if (process.env.QWEN_VOICE_DESIGN_CONFIRM !== 'CREATE_VICI_QWEN_VOICES') {
    throw new Error('Voice creation is locked. Set QWEN_VOICE_DESIGN_CONFIRM=CREATE_VICI_QWEN_VOICES for this one operator run.');
  }
  const outputIndex = process.argv.indexOf('--output');
  const outputDir = outputIndex >= 0 && process.argv[outputIndex + 1]
    ? path.resolve(process.argv[outputIndex + 1])
    : path.resolve('/tmp/vici-qwen-voice-previews');
  await fs.mkdir(outputDir, { recursive: true });
  const existing = await listDesignedVoices();
  const results = [];
  for (const profile of PROFILES) {
    const found = existing.find(voice => voice.id === profile.preferredName
      || voice.id.startsWith(`${profile.preferredName}_`));
    if (found) {
      results.push({ preferredName: profile.preferredName, id: found.id, status: 'already_exists' });
      continue;
    }
    const created = await designVoice({ preferredName: profile.preferredName,
      voicePrompt: profile.prompt, previewText: PREVIEW });
    const file = path.join(outputDir, `${profile.preferredName}.wav`);
    await fs.writeFile(file, created.audio, { flag: 'wx' });
    results.push({ preferredName: profile.preferredName, id: created.id, status: 'created', preview: file });
  }
  process.stdout.write(`${JSON.stringify({ created: results, outputDir }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.code || 'QWEN_VOICE_DESIGN_ERROR'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { PREVIEW, PROFILES };
