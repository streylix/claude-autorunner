import time
import os
import tempfile
import logging
import threading
from typing import Any, Dict, List, Optional

# faster_whisper and torch are imported inside the methods that need them,
# not at module top: torch alone costs ~600MB RSS, and this module is pulled
# in whenever Django boots (views.py imports the singleton below). The
# backend must stay cheap for users who never touch voice features.

logger = logging.getLogger(__name__)


def _preload_cuda12_libs():
    """
    ctranslate2 dlopens libcublas.so.12 / libcudnn*.so.9 at inference time.
    The torch wheel in this image ships CUDA-13 libs (nvidia/cu13/...), so the
    CUDA-12 copies come from the nvidia-cublas-cu12 / nvidia-cudnn-cu12 pip
    wheels — preload them by absolute path so the dynamic loader resolves the
    sonames without LD_LIBRARY_PATH plumbing.
    """
    try:
        import nvidia
    except ImportError:
        return
    import ctypes
    import glob
    for base in list(nvidia.__path__):
        for sub in ("cublas", "cudnn"):
            for so in sorted(glob.glob(os.path.join(base, sub, "lib", "*.so*"))):
                try:
                    ctypes.CDLL(so, mode=ctypes.RTLD_GLOBAL)
                except OSError:
                    pass


# Hallucination post-filter (confidence-based). Whisper mislabels non-speech
# audio that gets past the VAD (call cross-talk, ambient/car noise) as canned
# YouTube-caption phrases ("Thank you." / "Thanks for watching"). Measured on
# this box (2026-07-15/16, large-v3 int8_float16): such segments arrive with
# no_speech_prob ~0.68-0.70, while genuine speech stays <= ~0.35 — clear
# speech 0.009, a real spoken "Thank you." 0.066, the voice-interrupt
# stop-words "Yes."/"No."/"Wait." 0.04-0.29 even over car noise, faint
# garbled speech 0.35. So no_speech_prob is the discriminator, gated mid-gap.
#
# avg_logprob does NOT separate hallucinations (-0.26) from real speech, and
# short real commands legitimately score LOW: "Wait." over car noise measured
# -0.802 — a floor at the often-suggested -0.6/-0.7 would drop the interrupt
# stop-words. Keep it strictly below -0.802 (with margin); it exists only to
# kill degenerate/looping output.
NO_SPEECH_PROB_MAX = 0.5
AVG_LOGPROB_MIN = -0.9


def _drop_low_confidence_segments(segments):
    """Split segment dicts into (kept, dropped) by the confidence gates."""
    kept, dropped = [], []
    for s in segments:
        ok = (s['no_speech_prob'] <= NO_SPEECH_PROB_MAX
              and s['avg_logprob'] >= AVG_LOGPROB_MIN)
        (kept if ok else dropped).append(s)
    return kept, dropped


# Last-resort exact-match blocklist for the most persistent YouTube-caption
# artifacts — ONLY phrases that are never a real standalone voice memo. The
# whole normalized transcript must match; phrases inside longer sentences
# survive. Deliberately tiny: no "thank you", and never the voice-interrupt
# stop-words ("no"/"wait"/"yes").
_JUNK_TRANSCRIPTS = {
    "thanks for watching",
    "thank you for watching",
    "please subscribe",
    "music",  # "[Music]" after normalization
}


def _is_junk_transcript(text: str) -> bool:
    normalized = " ".join(
        "".join(c if c.isalnum() or c.isspace() else " " for c in text.lower()).split()
    )
    return normalized in _JUNK_TRANSCRIPTS


class WhisperTranscriptionService:
    """
    Service for handling offline voice transcription using faster-whisper
    (CTranslate2). Quantized int8_float16 keeps large-v3 resident at ~2-3GB
    VRAM instead of the ~10GB an fp16 openai-whisper load would hold, while
    decoding faster than the old 'base' model.

    Nothing heavy is imported until a transcription is actually requested —
    see _resolve_device() and _load().
    """

    def __init__(self):
        self.models = {}
        # Guards the check-and-load in _get_model so concurrent requests don't
        # trigger duplicate (expensive) model loads or race on self.models.
        self._model_lock = threading.Lock()
        # Resolved on first model load (needs torch); None until then.
        self.device = None

    def _resolve_device(self):
        if self.device is None:
            import torch
            if torch.cuda.is_available():
                # Must run before the first CT2 load — see _preload_cuda12_libs.
                _preload_cuda12_libs()
                self.device = "cuda"
            else:
                self.device = "cpu"
            logger.info(f"Whisper service initialized on device: {self.device}")
        return self.device

    def _load(self, model_name: str) -> "WhisperModel":
        """Load one CT2 model, degrading quantization/device instead of dying."""
        from faster_whisper import WhisperModel
        if self.device == "cuda":
            for compute_type in ("int8_float16", "int8"):
                try:
                    model = WhisperModel(model_name, device="cuda",
                                         compute_type=compute_type)
                    logger.info(f"Loaded {model_name} on cuda ({compute_type})")
                    return model
                except Exception as e:
                    logger.warning(
                        f"cuda/{compute_type} load failed for {model_name}: {e}")
        model = WhisperModel(model_name, device="cpu", compute_type="int8")
        logger.info(f"Loaded {model_name} on cpu (int8)")
        return model

    def _get_model(self, model_name: str) -> "WhisperModel":
        """Load and cache Whisper models (thread-safe)."""
        # Fast path: already cached, no lock needed.
        if model_name in self.models:
            return self.models[model_name]

        with self._model_lock:
            # Re-check inside the lock in case another thread loaded it while
            # we were waiting.
            if model_name in self.models:
                return self.models[model_name]

            self._resolve_device()
            logger.info(f"Loading Whisper model: {model_name}")
            try:
                self.models[model_name] = self._load(model_name)
            except Exception as e:
                logger.error(f"Failed to load {model_name} model: {e}")
                # Fallback to base model
                if model_name != 'base':
                    logger.info("Falling back to base model")
                    self.models[model_name] = self._load('base')
                else:
                    raise
        return self.models[model_name]

    def transcribe_audio(self, audio_file_path: str, model_name: str = 'large-v3',
                        language: Optional[str] = 'en') -> Dict[str, Any]:
        """
        Transcribe audio file using faster-whisper

        Args:
            audio_file_path: Path to audio file
            model_name: Whisper model to use ('tiny', 'base', 'small',
                        'medium', 'large-v3')
            language: Language code (e.g., 'en', 'es', 'fr') or None for
                      auto-detect. Defaults to 'en' — auto-detect made short
                      memos hallucinate other languages.

        Returns:
            Dict with transcription results
        """
        start_time = time.time()

        try:
            # Load the model
            model = self._get_model(model_name)

            # Transcribe
            logger.info(f"Starting transcription of {audio_file_path} with {model_name} model")

            segment_iter, info = model.transcribe(
                audio_file_path, language=language, beam_size=5,
                # Silero VAD skips non-speech audio entirely — THE fix for
                # Whisper hallucinating "Thank you" / "Thanks for watching"
                # (YouTube-caption artifacts) on silent-ish memos.
                vad_filter=True,
                # threshold=0.6 (Silero default 0.5): low-energy blips (road
                # noise, cross-talk) don't register as speech. Verified the
                # short interrupt commands still pass, even over car noise.
                # min_speech_duration_ms stays at the 250ms default — raising
                # it risks clipping a real bare "no".
                vad_parameters=dict(threshold=0.6, min_silence_duration_ms=500),
                # Don't feed prior text back in — stops the model repeating
                # itself into quiet gaps.
                condition_on_previous_text=False,
                no_speech_threshold=0.6,
            )
            # faster-whisper returns a lazy generator; decoding happens here.
            # Materialize dicts so the result stays JSON-shaped like before.
            segments = [
                {
                    'start': s.start,
                    'end': s.end,
                    'text': s.text,
                    'no_speech_prob': s.no_speech_prob,
                    'avg_logprob': s.avg_logprob,
                }
                for s in segment_iter
            ]
            # Post-filter: per-segment confidence gate. The VAD can't catch
            # hallucinations on cross-talk — there IS voice activity, Whisper
            # just mislabels it — but their no_speech_prob gives them away.
            segments, dropped = _drop_low_confidence_segments(segments)
            for s in dropped:
                logger.info(
                    "Dropped low-confidence segment "
                    f"(no_speech_prob={s['no_speech_prob']:.3f}, "
                    f"avg_logprob={s['avg_logprob']:.3f}): {s['text'].strip()!r}")
            text = ''.join(s['text'] for s in segments).strip()

            if text and _is_junk_transcript(text):
                logger.info(
                    f"Filtered junk transcript (returned empty): {text!r}")
                text = ''
                segments = []

            processing_time = time.time() - start_time

            transcription_result = {
                'text': text,
                'language': info.language or 'unknown',
                'confidence': self._calculate_confidence(segments),
                'model_used': model_name,
                'processing_time': processing_time,
                'segments': segments,
                'success': True
            }

            logger.info(f"Transcription completed in {processing_time:.2f}s: {text[:100]}...")
            return transcription_result

        except Exception as e:
            processing_time = time.time() - start_time
            logger.error(f"Transcription failed after {processing_time:.2f}s: {e}")
            return {
                'text': '',
                'error': str(e),
                'model_used': model_name,
                'processing_time': processing_time,
                'success': False
            }

    def _calculate_confidence(self, segments: List[Dict[str, Any]]) -> float:
        """
        Calculate average confidence from transcription segments
        """
        try:
            if not segments:
                return 0.0

            total_confidence = 0.0
            total_duration = 0.0

            for segment in segments:
                # Whisper doesn't provide confidence directly,
                # but we can estimate from no_speech_prob
                no_speech_prob = segment.get('no_speech_prob', 0.5)
                confidence = 1.0 - no_speech_prob
                duration = segment.get('end', 0) - segment.get('start', 0)

                total_confidence += confidence * duration
                total_duration += duration

            return total_confidence / total_duration if total_duration > 0 else 0.0

        except Exception as e:
            logger.warning(f"Failed to calculate confidence: {e}")
            return 0.0

    def save_temp_audio_file(self, audio_data: bytes, suffix: str = '.wav') -> str:
        """
        Save audio data to temporary file

        Returns:
            Path to temporary file
        """
        temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        temp_file.write(audio_data)
        temp_file.close()
        return temp_file.name

    def cleanup_temp_file(self, file_path: str):
        """
        Clean up temporary file
        """
        try:
            if os.path.exists(file_path):
                os.unlink(file_path)
                logger.debug(f"Cleaned up temp file: {file_path}")
        except Exception as e:
            logger.warning(f"Failed to cleanup temp file {file_path}: {e}")


# Global service instance
transcription_service = WhisperTranscriptionService()
