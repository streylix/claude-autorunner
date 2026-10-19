# Django backend for Auto-Injector ("claude code bot").
# Serves HTTP + WebSocket (Channels) via daphne on port 8123.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    DJANGO_SETTINGS_MODULE=terminal_backend.settings

# ffmpeg: required by openai-whisper to decode audio.
# libpq5: runtime lib for psycopg (Postgres driver).
# espeak-ng: g2p backend Kokoro/misaki use for text-to-speech.
# libsndfile1: runtime lib for soundfile to write the synthesized WAVs.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libpq5 curl espeak-ng libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install torch first so its wheel source is fixed before requirements resolve.
# CPU-ONLY build, on purpose. The default PyPI wheel ships the full CUDA stack
# (~4.8GB of nvidia-* libs) and made torch pin ~4.8GB of the RTX 3090's VRAM,
# which starved the co-tenant llmapi service on the same card. The only torch
# workload here is Kokoro TTS (82M params), which synthesizes fast enough on CPU.
#
# This does NOT move Whisper STT to the CPU: faster-whisper runs on CTranslate2,
# which carries its own CUDA runtime (nvidia-cublas-cu12 / nvidia-cudnn-cu12 in
# requirements.txt) and is entirely independent of torch's build. See
# voice_transcription/transcription_service.py for the explicit device gate.
RUN pip install torch==2.13.0 --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install -r requirements.txt

# Pre-download the spacy English model misaki[en] needs, so the first TTS
# request doesn't block on a network fetch at runtime.
RUN python -m spacy download en_core_web_sm

# Copy the Django project (build context is backend/; .dockerignore excludes
# venv, db.sqlite3, __pycache__, media).
COPY . .

EXPOSE 8123

# Entrypoint runs migrations then starts the ASGI server.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["daphne", "-b", "0.0.0.0", "-p", "8123", "terminal_backend.asgi:application"]
