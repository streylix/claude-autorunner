# Django backend for Auto-Injector ("claude code bot").
# Serves HTTP + WebSocket (Channels) via daphne on port 8123.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    DJANGO_SETTINGS_MODULE=terminal_backend.settings

# ffmpeg: required by openai-whisper to decode audio.
# libpq5: runtime lib for psycopg (Postgres driver).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libpq5 curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install torch from the CPU-only wheel index first. This avoids pulling the
# ~2GB CUDA build that the default PyPI wheel ships, roughly halving image size.
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch

COPY requirements.txt .
RUN pip install -r requirements.txt

# Copy the Django project (build context is backend/; .dockerignore excludes
# venv, db.sqlite3, __pycache__, media).
COPY . .

EXPOSE 8123

# Entrypoint runs migrations then starts the ASGI server.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["daphne", "-b", "0.0.0.0", "-p", "8123", "terminal_backend.asgi:application"]
