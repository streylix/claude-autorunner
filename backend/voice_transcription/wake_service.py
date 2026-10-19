"""
Lightweight CPU wake-word transcription using Vosk.

Purpose: let the Discord bridge (and anything else) cheaply gate on the wake
word WITHOUT running the GPU Whisper model on every utterance. Vosk is a small
CPU model (no CUDA, ~50MB), so this endpoint costs almost nothing per call, and
the expensive Whisper transcription is only invoked AFTER the wake word fires.

This reuses the Vosk model the desktop app already ships
(assets/models/vosk-model-small-en-us.tar.gz) — mounted into the container at
/models and pointed to by VOSK_MODEL_PATH. No duplicate model, no GPU.
"""

import json
import logging
import os
import subprocess
import tarfile
import tempfile
import threading

logger = logging.getLogger(__name__)

DEFAULT_MODEL_PATH = os.environ.get(
    'VOSK_MODEL_PATH', '/models/vosk-model-small-en-us.tar.gz'
)


class VoskWakeService:
    """Loads the Vosk model once (CPU) and transcribes short utterances."""

    def __init__(self):
        self._lock = threading.Lock()
        self._model = None

    def _resolve_model_dir(self):
        """VOSK_MODEL_PATH may be an extracted dir or a .tar.gz; return a dir
        Vosk can load (the one containing an `am/` subfolder)."""
        p = DEFAULT_MODEL_PATH
        if os.path.isdir(p):
            return p
        if p.endswith('.tar.gz') or p.endswith('.tgz'):
            dest = os.path.join(tempfile.gettempdir(), 'ccbot-vosk-model')
            os.makedirs(dest, exist_ok=True)
            # Extract once (skip if already extracted).
            if not any(
                os.path.isdir(os.path.join(dest, n, 'am')) for n in os.listdir(dest)
            ):
                logger.info(f"Extracting Vosk model {p} -> {dest}")
                with tarfile.open(p) as t:
                    t.extractall(dest)  # trusted, locally-shipped model
            for n in os.listdir(dest):
                cand = os.path.join(dest, n)
                if os.path.isdir(os.path.join(cand, 'am')):
                    return cand
        return p

    def _get_model(self):
        if self._model is not None:
            return self._model
        with self._lock:
            if self._model is not None:
                return self._model
            from vosk import Model, SetLogLevel
            SetLogLevel(-1)
            model_dir = self._resolve_model_dir()
            logger.info(f"Loading Vosk wake model from: {model_dir}")
            self._model = Model(model_dir)
        return self._model

    def transcribe(self, audio_file_path: str) -> str:
        """Return Vosk's best-effort transcript of the audio (any format ffmpeg
        can read). Converts to 16kHz mono s16le first (what Vosk expects)."""
        from vosk import KaldiRecognizer

        proc = subprocess.run(
            ['ffmpeg', '-nostdin', '-loglevel', 'quiet', '-i', audio_file_path,
             '-ar', '16000', '-ac', '1', '-f', 's16le', '-'],
            capture_output=True,
        )
        pcm = proc.stdout
        if not pcm:
            return ''
        rec = KaldiRecognizer(self._get_model(), 16000)
        rec.AcceptWaveform(pcm)
        result = json.loads(rec.FinalResult() or '{}')
        return (result.get('text') or '').strip()


# Module-level singleton (model loads lazily on first call).
wake_service = VoskWakeService()
