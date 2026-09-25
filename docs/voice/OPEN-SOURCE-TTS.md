# Open-source TTS evaluation

## Decision

Pilot Qwen3-TTS VoiceDesign through Alibaba Cloud Model Studio in the Singapore
region. VoiceDesign creates wholly synthetic voice assets from an objective
description, so it does not require or imitate a person's recording. Keep the
existing ElevenLabs Professional Voice Clones available during the blind quality
comparison. The application must never treat a model name as a voice or use an
arbitrary internet recording as cloning material.

The pilot uses `qwen3-tts-vd-2026-01-26` for both design and synthesis. The
backend accepts only English, account-scoped voices with the `vici_` operations
prefix. It derives the Singapore workspace hostname from
`DASHSCOPE_WORKSPACE_ID`; no client-supplied provider URL is accepted.

The first two candidates for a controlled pilot are:

1. Qwen3-TTS. Apache-2.0 open weights, English support, and VoiceDesign. The
   hosted VoiceDesign pilot is the fastest safe route because it needs no voice
   recording or Railway GPU. A later self-hosted Base pilot remains possible.
   - https://github.com/QwenLM/Qwen3-TTS
   - https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base
2. Chatterbox Turbo. MIT licensed, zero-shot cloning, and built-in PerTh
   watermarking. It is the preferred quick pilot once a licensed reference
   voice and hosted inference endpoint exist.
   - https://github.com/resemble-ai/chatterbox
   - https://huggingface.co/ResembleAI/chatterbox

OpenVoice V2 is a permissible lower-cost comparison, but it must pass the same
blind quality test before it is exposed:

- https://github.com/myshell-ai/OpenVoice

## Excluded from this commercial product

- F5-TTS public weights are CC-BY-NC-4.0.
- Fish Speech requires a separate commercial licence.
- Higgs Audio v3 is research/non-commercial.
- XTTS-v2 is not commercially licensed for this use.
- Kokoro does not provide the requested zero-shot voice cloning.

Do not add any of these to a production picker merely because their source code
is visible.

## Required production architecture

Railway does not provide GPU instances. The initial pilot therefore uses the
authenticated Model Studio service; a future self-hosted model would require a
separate GPU inference service. The Vici backend remains the only caller and
persists an immutable provider, model, and authorized voice-profile ID on every
attempt.

Before dialing:

1. Render both human-answer and voicemail scripts.
2. Generate both audio files through the selected provider.
3. Store them in the private call-recordings bucket.
4. Confirm both files are available through short-lived signed URLs.
5. Only then place the Telnyx call.

If any generation or staging step fails, do not dial. Never fall back to a
different provider or the current workspace voice.

Each self-hosted voice profile needs:

- provider and model version;
- synthetic-design record or signed talent release;
- reference-audio hash and encrypted storage location;
- American-English and intended-use tags;
- commercial licence and provenance;
- consent/revocation status; and
- independent realism and telephone-transcoding test results.

## Acceptance test

Compare candidates blindly against the current Professional Voice Clones using
the actual Vici cart-recovery scripts. Score naturalness, pronunciation,
speaker consistency over 20 to 60 seconds, synthesis latency, and quality after
Telnyx telephone transcoding. A model is not added to the app until it wins or
matches the production baseline and its voice asset is legally authorized.
