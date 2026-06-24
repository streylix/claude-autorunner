"""TTS / notifications API.

Routes (mounted under /api/tts/):
  POST   speak/                 synthesize text -> store Notification + WAV
  GET    voices/                list available Kokoro voices
  GET    notifications/         list recent notifications (?after=<id>&limit=)
  DELETE notifications/         clear all notifications (+ their audio files)
  POST   notifications/<id>/played/   mark a notification as played
  GET    audio/<id>/            stream the synthesized WAV
  GET    health/               warm up the default pipeline
"""

import logging
import os
import uuid

from django.conf import settings
from django.http import FileResponse, Http404
from rest_framework.decorators import api_view, throttle_classes
from rest_framework.response import Response

from terminal_backend.api_security import TTSSpeakThrottle
from .models import Notification, TTSConfig
from .voices import DEFAULT_VOICE, VOICES, is_valid_voice
from .tts_service import tts_service

logger = logging.getLogger(__name__)

MAX_TEXT_CHARS = 2000
MAX_NOTIFICATIONS = 500  # prune older rows beyond this
TTS_MEDIA_SUBDIR = "tts"


def _audio_dir() -> str:
    path = os.path.join(settings.MEDIA_ROOT, TTS_MEDIA_SUBDIR)
    os.makedirs(path, exist_ok=True)
    return path


def _serialize(n: Notification) -> dict:
    return {
        "id": n.id,
        "terminal_id": n.terminal_id,
        "terminal_name": n.terminal_name,
        "text": n.text,
        "voice": n.voice,
        "speed": n.speed,
        "source": n.source,
        "duration_ms": n.duration_ms,
        "played": n.played,
        "created_at": n.created_at.isoformat(),
        "audio_url": f"/api/tts/audio/{n.id}/" if n.audio_path else None,
    }


def _prune():
    """Keep only the newest MAX_NOTIFICATIONS rows; delete pruned audio files."""
    ids = list(
        Notification.objects.order_by("-created_at").values_list("id", flat=True)[
            MAX_NOTIFICATIONS:
        ]
    )
    if not ids:
        return
    for n in Notification.objects.filter(id__in=ids):
        _delete_audio(n)
    Notification.objects.filter(id__in=ids).delete()


def _delete_audio(n: Notification):
    if not n.audio_path:
        return
    full = os.path.join(settings.MEDIA_ROOT, n.audio_path)
    try:
        if os.path.exists(full):
            os.unlink(full)
    except OSError as e:
        logger.warning(f"Failed to delete audio {full}: {e}")


@api_view(["POST"])
@throttle_classes([TTSSpeakThrottle])
def speak(request):
    """Synthesize text to speech, persist it, and return the notification."""
    data = request.data or {}
    text = (data.get("text") or "").strip()
    if not text:
        return Response({"success": False, "error": "text is required"}, status=400)
    if len(text) > MAX_TEXT_CHARS:
        text = text[:MAX_TEXT_CHARS]

    # Omitted voice falls back to the user's preferred voice (backend config),
    # so the manager can defer to the user's choice by simply not passing one.
    voice = data.get("voice")
    if not voice:
        voice = TTSConfig.get_solo().preferred_voice or DEFAULT_VOICE
    if not is_valid_voice(voice):
        return Response(
            {"success": False, "error": f"unknown voice {voice!r}"}, status=400
        )

    try:
        speed = float(data.get("speed", 1.0))
    except (TypeError, ValueError):
        speed = 1.0
    speed = min(2.0, max(0.5, speed))

    terminal_id = data.get("terminal_id")
    terminal_id = str(terminal_id) if terminal_id is not None else None

    # Synthesize FIRST, to a temp file in the audio dir. Synthesis takes a few
    # seconds; if we created the row before this, a poller could fetch it with an
    # empty audio_path, advance past it, and never play it. By rendering audio
    # before the row exists, the row is created already (effectively) ready.
    audio_dir = _audio_dir()
    tmp_path = os.path.join(audio_dir, f".pending-{uuid.uuid4().hex}.wav")
    try:
        duration_ms = tts_service.synthesize_to_file(
            tmp_path, text, voice=voice, speed=speed
        )
    except Exception as e:
        logger.error(f"TTS synthesis failed: {e}")
        if os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        return Response({"success": False, "error": str(e)}, status=500)

    notification = Notification.objects.create(
        terminal_id=terminal_id,
        terminal_name=data.get("terminal_name") or None,
        text=text,
        voice=voice,
        speed=speed,
        source=data.get("source") or "manager",
        duration_ms=duration_ms,
    )

    # Atomic rename within the same dir → the row only ever has its final audio.
    rel_path = os.path.join(TTS_MEDIA_SUBDIR, f"{notification.id}.wav")
    os.replace(tmp_path, os.path.join(audio_dir, f"{notification.id}.wav"))
    notification.audio_path = rel_path
    notification.save(update_fields=["audio_path"])

    _prune()

    payload = _serialize(notification)
    payload["success"] = True
    return Response(payload, status=201)


@api_view(["GET"])
def voices(request):
    return Response({"voices": VOICES, "default": DEFAULT_VOICE})


@api_view(["GET", "PUT"])
def config(request):
    """Get/set the user's preferred default voice (used when speak omits voice)."""
    cfg = TTSConfig.get_solo()
    if request.method == "PUT":
        voice = (request.data or {}).get("preferred_voice")
        if voice:
            if not is_valid_voice(voice):
                return Response(
                    {"success": False, "error": f"unknown voice {voice!r}"}, status=400
                )
            cfg.preferred_voice = voice
            cfg.save(update_fields=["preferred_voice", "updated_at"])
    return Response({"preferred_voice": cfg.preferred_voice})


@api_view(["GET", "DELETE"])
def notifications(request):
    if request.method == "DELETE":
        for n in Notification.objects.all():
            _delete_audio(n)
        deleted, _ = Notification.objects.all().delete()
        return Response({"success": True, "deleted": deleted})

    # Only ready rows (audio synthesized) — never expose a half-written row, so a
    # poller can't advance past a notification before its audio exists.
    qs = Notification.objects.exclude(audio_path="")  # already ordered -created_at
    after = request.query_params.get("after")
    if after:
        try:
            qs = qs.filter(id__gt=int(after))
        except ValueError:
            pass
    try:
        limit = min(200, max(1, int(request.query_params.get("limit", 100))))
    except ValueError:
        limit = 100
    items = [_serialize(n) for n in qs[:limit]]
    return Response({"notifications": items})


@api_view(["POST"])
def mark_played(request, pk):
    updated = Notification.objects.filter(id=pk).update(played=True)
    return Response({"success": bool(updated)})


@api_view(["GET"])
def audio(request, pk):
    try:
        n = Notification.objects.get(id=pk)
    except Notification.DoesNotExist:
        raise Http404
    if not n.audio_path:
        raise Http404
    full = os.path.join(settings.MEDIA_ROOT, n.audio_path)
    if not os.path.exists(full):
        raise Http404
    return FileResponse(open(full, "rb"), content_type="audio/wav")


@api_view(["GET"])
def health(request):
    """Warm up the default pipeline so the first real request is fast."""
    try:
        tts_service.synthesize("ready", voice=DEFAULT_VOICE, speed=1.0)
        return Response({"status": "ok", "voices": len(VOICES)})
    except Exception as e:
        logger.error(f"TTS health check failed: {e}")
        return Response({"status": "error", "error": str(e)}, status=503)
