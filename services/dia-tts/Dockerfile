FROM nvidia/cuda:12.6.3-cudnn-runtime-ubuntu22.04

ARG DEBIAN_FRONTEND=noninteractive
ARG DIA_GIT_REVISION=876125e461a03b157ec905b0fe8b57a0f8b9e7a0

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg git python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --no-cache-dir \
      --index-url https://download.pytorch.org/whl/cu126 \
      torch==2.6.0 torchaudio==2.6.0

RUN git clone https://github.com/nari-labs/dia.git /opt/dia \
    && git -C /opt/dia checkout "${DIA_GIT_REVISION}" \
    && test "$(git -C /opt/dia rev-parse HEAD)" = "${DIA_GIT_REVISION}" \
    && python3 -m pip install --no-cache-dir --no-deps /opt/dia \
    && python3 -m pip install --no-cache-dir \
      descript-audio-codec==1.0.0 safetensors==0.5.3

WORKDIR /app
COPY requirements.txt ./requirements.txt
RUN python3 -m pip install --no-cache-dir -r requirements.txt
COPY app.py ./app.py

ENV PORT=8080 PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8080} --workers 1 --no-access-log"]
