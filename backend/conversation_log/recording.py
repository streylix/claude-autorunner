"""Helpers for recording messages into the durable log.

Everything here is best-effort: a logging failure must never break the thing
being logged (speaking, sending, delivering). Callers get None on failure.
"""

import logging

from .models import DESTINATIONS, DIRECTIONS, KINDS, Message

logger = logging.getLogger(__name__)

MAX_TEXT_CHARS = 100_000


def coerce_choice(value, allowed, fallback):
    v = str(value or "").strip().lower()
    return v if v in allowed else fallback


def normalize(payload):
    """Turn an arbitrary (possibly hostile/partial) payload into model kwargs.

    Never raises: unknown enum values fall back, non-dict meta is wrapped, long
    text is capped. A partial payload produces a partial row, not an error.
    """
    data = payload if isinstance(payload, dict) else {}

    meta = data.get("meta")
    if not isinstance(meta, dict):
        meta = {} if meta in (None, "") else {"value": str(meta)[:2000]}

    # SYNTHETIC MARKER. Any row written by a test, probe or smoke check that can
    # reach the live table MUST carry meta.synthetic — a marked row is excluded
    # from open-ask extraction and hidden from reads by default, so nobody ever
    # has to wonder whether the user actually said it. Accepted top level too
    # ({"synthetic": true}), because a caller that fumbles the nesting would
    # silently produce an unmarked row, which is the exact failure this guards.
    if data.get("synthetic") or meta.get("synthetic"):
        meta["synthetic"] = True

    text = data.get("text")
    text = "" if text is None else str(text)

    media_path = data.get("media_path")
    media_path = "" if media_path is None else str(media_path)[:1000]

    external_id = data.get("external_id")
    external_id = "" if external_id is None else str(external_id)[:200]

    return {
        "direction": coerce_choice(data.get("direction"), DIRECTIONS, "outbound"),
        "destination": coerce_choice(data.get("destination"), DESTINATIONS, "other"),
        "kind": coerce_choice(data.get("kind"), KINDS, "text"),
        "text": text[:MAX_TEXT_CHARS],
        "media_path": media_path,
        "external_id": external_id,
        "meta": meta,
    }


def record(**payload):
    """Create a Message from loose kwargs. Returns the Message or None.

    Honors external_id idempotency: re-recording the same external_id returns
    the existing row instead of duplicating it.
    """
    try:
        fields = normalize(payload)
        created_at = payload.get("created_at")
        if created_at is not None:
            fields["created_at"] = created_at
        external_id = fields.pop("external_id")
        if external_id:
            obj, _ = Message.objects.get_or_create(
                external_id=external_id, defaults=fields
            )
            return obj
        return Message.objects.create(**fields)
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("conversation_log: failed to record message: %s", exc)
        return None


def record_tts_notification(notification):
    """Log a spoken notification as an outbound tts message.

    The Message keeps only the string key "tts:<pk>" — never a FK — so
    text_to_speech's _prune() can never cascade into the durable log.
    """
    return record(
        direction="outbound",
        destination="tts",
        kind="voice",
        text=getattr(notification, "text", "") or "",
        media_path=getattr(notification, "audio_path", "") or "",
        external_id=f"tts:{notification.pk}",
        created_at=getattr(notification, "created_at", None),
        meta={
            "voice": getattr(notification, "voice", "") or "",
            "speed": getattr(notification, "speed", None),
            "source": getattr(notification, "source", "") or "",
            "terminal_id": getattr(notification, "terminal_id", None),
            "terminal_name": getattr(notification, "terminal_name", None),
            "duration_ms": getattr(notification, "duration_ms", None),
            "notification_id": notification.pk,
        },
    )
