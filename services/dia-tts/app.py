"""Private, single-profile Nari Labs Dia speech service.

The public API deliberately does not accept prompts, seeds, sampling settings,
or arbitrary models. Those are an immutable operator-owned voice profile. The
Node service sends only customer-safe text and receives a finished MP3 before
Telnyx is allowed to place a call.
"""

from __future__ import annotations

import asyncio
import hmac
import os
import re
import subprocess
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from dia.model import Dia
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import Response
from huggingface_hub import hf_hub_download
from pydantic import BaseModel, ConfigDict, Field


MODEL_ID = "nari-labs/Dia-1.6B-0626"
MODEL_REVISION = "ef2795fcc29c5abe6ffc91fd33808588b49bbc66"
VOICE_ID = os.getenv("DIA_VOICE_PROFILE_ID", "dia_vici_sunny_v1")
SAMPLE_RATE = 44_100
MAX_CHARACTERS = 1_200
CONTROL_PATTERN = re.compile(r"\[S[12]\]|\([^)]{1,40}\)", re.IGNORECASE)
PRODUCTION_SEEDS = (1057, 2467, 6151)


class SpeechRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model: str
    model_revision: str
    voice: str
    input: str = Field(min_length=1, max_length=MAX_CHARACTERS)
    response_format: str


class Runtime:
    model: Dia | None = None
    lock: asyncio.Lock | None = None


runtime = Runtime()


def _seed_everything(seed: int) -> None:
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    np.random.seed(seed)


def _validate_environment() -> str:
    token = os.getenv("DIA_API_TOKEN", "").strip()
    if len(token) < 32:
        raise RuntimeError("DIA_API_TOKEN must contain at least 32 characters")
    if not torch.cuda.is_available():
        raise RuntimeError("Dia requires a CUDA GPU; refusing CPU production startup")
    if MODEL_ID != os.getenv("DIA_MODEL_ID", MODEL_ID):
        raise RuntimeError("DIA_MODEL_ID does not match the reviewed model")
    if MODEL_REVISION != os.getenv("DIA_MODEL_REVISION", MODEL_REVISION):
        raise RuntimeError("DIA_MODEL_REVISION does not match the reviewed checkpoint")
    return token


def _load_runtime() -> None:
    _validate_environment()
    config_path = hf_hub_download(
        repo_id=MODEL_ID,
        filename="config.json",
        revision=MODEL_REVISION,
        token=os.getenv("HF_TOKEN") or None,
    )
    checkpoint_path = hf_hub_download(
        repo_id=MODEL_ID,
        filename="dia-v1.pth",
        revision=MODEL_REVISION,
        token=os.getenv("HF_TOKEN") or None,
    )
    # Dia.from_pretrained expects a Hub repository ID and does not preserve a
    # caller-selected revision. Load the audited snapshot's native checkpoint
    # directly so production cannot drift to a newer model revision.
    model = Dia.from_local(
        config_path=config_path,
        checkpoint_path=checkpoint_path,
        compute_dtype="float16",
        device=torch.device("cuda"),
    )
    runtime.model = model
    runtime.lock = asyncio.Lock()


@asynccontextmanager
async def lifespan(_: FastAPI):
    await asyncio.to_thread(_load_runtime)
    yield
    runtime.model = None


app = FastAPI(title="Vici Dia Speech", docs_url=None, redoc_url=None, lifespan=lifespan)


def authorize(authorization: str | None = Header(default=None)) -> None:
    expected = f"Bearer {os.getenv('DIA_API_TOKEN', '').strip()}"
    if not authorization or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.get("/health")
async def health() -> dict[str, str]:
    if runtime.model is None:
        raise HTTPException(status_code=503, detail="Model is loading")
    return {
        "status": "ready",
        "model": MODEL_ID,
        "model_revision": MODEL_REVISION,
        "voice": VOICE_ID,
    }


def _encode_mp3(audio: np.ndarray) -> bytes:
    if audio is None or len(audio) < SAMPLE_RATE // 2 or not np.isfinite(audio).all():
        raise RuntimeError("Dia returned invalid audio")
    peak = float(np.max(np.abs(audio)))
    if peak <= 0.001 or peak > 1.05:
        raise RuntimeError("Dia audio failed level validation")

    with tempfile.TemporaryDirectory(prefix="dia-render-") as directory:
        wav_path = Path(directory) / "speech.wav"
        mp3_path = Path(directory) / "speech.mp3"
        sf.write(wav_path, audio, SAMPLE_RATE)
        subprocess.run(
            ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(wav_path),
             "-ac", "1", "-ar", "24000", "-codec:a", "libmp3lame", "-b:a", "64k", str(mp3_path)],
            check=True,
        )
        encoded = mp3_path.read_bytes()
    if len(encoded) < 1_000 or len(encoded) > 20 * 1024 * 1024:
        raise RuntimeError("Encoded Dia audio failed size validation")
    return encoded


def _clean_customer_text(text: str) -> str:
    cleaned = " ".join(text.replace("\r", " ").replace("\n", " ").split())
    if CONTROL_PATTERN.search(cleaned):
        raise ValueError("Control syntax is not accepted in customer text")
    return cleaned


def _passes_speech_shape(audio: np.ndarray, text: str) -> bool:
    if audio is None or len(audio) < SAMPLE_RATE // 2 or not np.isfinite(audio).all():
        return False
    duration = len(audio) / SAMPLE_RATE
    words = max(1, len(text.split()))
    maximum_duration = min(35.0, max(5.0, words / 1.4 + 3.0))
    peak = float(np.max(np.abs(audio)))
    rms = float(np.sqrt(np.mean(np.square(audio))))
    signs = np.signbit(audio)
    zero_crossing_rate = float(np.count_nonzero(signs[1:] != signs[:-1]) / max(1, len(audio) - 1))
    return (
        0.5 <= duration <= maximum_duration
        and 0.005 <= rms <= 0.35
        and 0.02 <= peak <= 1.05
        and zero_crossing_rate <= 0.18
    )


def _synthesize(text: str) -> bytes:
    assert runtime.model is not None
    cleaned = _clean_customer_text(text)
    for seed in PRODUCTION_SEEDS:
        _seed_everything(seed)
        audio = runtime.model.generate(
            f"[S1] {cleaned}",
            use_torch_compile=False,
            verbose=False,
            cfg_scale=3.0,
            temperature=1.8,
            top_p=0.90,
            cfg_filter_top_k=45,
        )
        if _passes_speech_shape(audio, cleaned):
            return _encode_mp3(audio)
    raise RuntimeError("Dia did not produce speech that passed the quality gate")


@app.post("/v1/audio/speech", dependencies=[Depends(authorize)])
async def speech(request: SpeechRequest) -> Response:
    if request.model != MODEL_ID or request.model_revision != MODEL_REVISION:
        raise HTTPException(status_code=400, detail="Unsupported model revision")
    if request.voice != VOICE_ID or request.response_format != "mp3":
        raise HTTPException(status_code=400, detail="Unsupported voice profile or format")
    assert runtime.lock is not None
    try:
        async with runtime.lock:
            audio = await asyncio.to_thread(_synthesize, request.input)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        # Do not leak customer text, model paths, or provider internals.
        raise HTTPException(status_code=500, detail="Speech generation failed") from error
    return Response(content=audio, media_type="audio/mpeg", headers={"Cache-Control": "no-store"})
