"""
Kokoro-82M text-to-speech service.

Mirrors voice_transcription/transcription_service.py: a single module-level
singleton with lazily-loaded, lock-guarded models. Here the "models" are
KPipeline instances keyed by language code (one pipeline drives all voices that
share a language). Pipelines are expensive to build and hold the 82M Kokoro net
+ a g2p stack, so we build each at most once and cache it.
"""

import logging
import threading
import time
from typing import Tuple

import numpy as np

from .voices import DEFAULT_VOICE, lang_code_for

logger = logging.getLogger(__name__)

SAMPLE_RATE = 24000  # Kokoro always outputs 24 kHz mono
REPO_ID = "hexgrad/Kokoro-82M"


class KokoroTTSService:
    """Offline text-to-speech using the Kokoro-82M model."""

    def __init__(self):
        # lang_code -> KPipeline
        self.pipelines = {}
        # Guards check-and-load so concurrent requests don't build the same
        # pipeline twice or race on self.pipelines.
        self._lock = threading.Lock()
        logger.info("Kokoro TTS service initialized (pipelines load lazily)")

    def _get_pipeline(self, lang_code: str):
        # Fast path: already built.
        if lang_code in self.pipelines:
            return self.pipelines[lang_code]

        with self._lock:
            if lang_code in self.pipelines:
                return self.pipelines[lang_code]

            logger.info(f"Loading Kokoro pipeline for lang_code={lang_code!r}")
            # Imported lazily so importing this module (e.g. during migrations)
            # never pulls in torch/kokoro.
            from kokoro import KPipeline

            self.pipelines[lang_code] = KPipeline(lang_code=lang_code, repo_id=REPO_ID)
            logger.info(f"Kokoro pipeline ready for lang_code={lang_code!r}")
        return self.pipelines[lang_code]

    def synthesize(
        self, text: str, voice: str = DEFAULT_VOICE, speed: float = 1.0
    ) -> Tuple[np.ndarray, int]:
        """
        Render `text` to a mono float32 waveform with the given voice.

        `speed` is the synthesis-time tempo Kokoro applies (1.0 = natural). The
        renderer additionally exposes a separate playback-rate control, so this
        usually stays at 1.0 and speed adjustments happen client-side.

        Returns (samples float32 in [-1, 1], sample_rate).
        """
        start = time.time()
        pipeline = self._get_pipeline(lang_code_for(voice))
        chunks = [audio for _, _, audio in pipeline(text, voice=voice, speed=speed)]
        if not chunks:
            raise ValueError("Kokoro produced no audio for the given text")
        samples = np.concatenate([np.asarray(c, dtype=np.float32) for c in chunks])
        logger.info(
            f"Synthesized {len(samples)/SAMPLE_RATE:.2f}s with voice={voice} "
            f"in {time.time()-start:.2f}s"
        )
        return samples, SAMPLE_RATE

    def synthesize_to_file(
        self, path: str, text: str, voice: str = DEFAULT_VOICE, speed: float = 1.0
    ) -> int:
        """Synthesize and write a 16-bit PCM WAV (broad browser compatibility).

        Returns the duration in milliseconds.
        """
        import soundfile as sf  # lazy: pulls libsndfile only when actually used

        samples, sr = self.synthesize(text, voice=voice, speed=speed)
        sf.write(path, samples, sr, subtype="PCM_16")
        return int(round(len(samples) / sr * 1000))


# Global service instance (mirrors transcription_service).
tts_service = KokoroTTSService()
