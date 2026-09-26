# Authenticated Dia recovery-voice service

This container hosts the reviewed Nari Labs Dia checkpoint on a dedicated CUDA
GPU. Railway remains the orchestrator and never loads the model. The reviewed
deployment is the public-source Docker Space `lubosik/vici-dia-tts`; the
synthesis route remains private through a 64-character bearer token. Point
`DIA_TTS_ENDPOINT` at its HTTPS `/v1/audio/speech` route.

Pinned supply chain:

- Dia source: `nari-labs/dia` commit `876125e461a03b157ec905b0fe8b57a0f8b9e7a0`
- model: `nari-labs/Dia-1.6B-0626`
- model revision: `ef2795fcc29c5abe6ffc91fd33808588b49bbc66`

Required secrets are `DIA_API_TOKEN` (32+ random characters) and, for private
or rate-limited downloads, `HF_TOKEN`. The reviewed Space sleeps after one idle
minute. Railway retries a waking Space for up to five minutes, and synthesis
still completes before Telnyx is permitted to dial.

The default profile is generated directly from a fixed, audited seed and does
not clone a person. Two fallback seeds and signal-level duration, loudness, and
noise checks prevent a malformed generation from being treated as usable
speech. The selected profile must still be auditioned before setting
`DIA_VOICE_CATALOGUE_ENABLED=true`.

The service accepts only one model revision, one profile, MP3 output, bearer
authentication, and plain customer text. It does not accept remote audio URLs,
arbitrary voice prompts, or Dia control tokens. Inference is serialized to
avoid GPU memory contention, and request text is not logged.

Build check (requires Docker and an NVIDIA deployment target):

```sh
docker build -t vici-dia-tts services/dia-tts
```

Health becomes ready only after the pinned checkpoint is loaded:

```sh
curl https://HOST/health
```

The health route is intentionally non-sensitive and does not require auth so
the hosting platform can probe it. The synthesis route always requires auth.
