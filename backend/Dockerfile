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
# Use the default PyPI wheel, which ships the CUDA build, so Kokoro TTS / Whisper
# run on an NVIDIA GPU when one is present (this box has an RTX 3090). On hosts
# without a GPU torch still runs on CPU automatically; the trade-off is a larger
# image (~2GB CUDA libs) vs the previous CPU-only wheel.
RUN pip install torch

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
