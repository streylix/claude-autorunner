"""Read/write API for the durable conversation log.

POST /api/conversation/messages/   — fire-and-forget ingest. Callers (the
Discord bridge, the TTS path) must never be hurt by logging, so this endpoint
never returns 500 for a malformed or partial payload: unknown enums fall back,
missing fields default, and only a genuinely broken request body gets a 400.

GET  /api/conversation/messages/   — newest first, filterable.
GET  /api/conversation/open-asks/  — extracted asks, ?status=open by default.
"""

import logging

from django.db.models import Q
from django.utils.dateparse import parse_datetime
from rest_framework.decorators import api_view
from rest_framework.response import Response

from .models import Message, OpenAsk
from .recording import normalize

logger = logging.getLogger(__name__)

DEFAULT_LIMIT = 100
MAX_LIMIT = 1000


def _parse_limit(raw, default=DEFAULT_LIMIT):
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return default
    return max(1, min(MAX_LIMIT, n))


def _parse_dt(raw):
    """Lenient ISO-8601 parse. Accepts a trailing Z. Returns None if unusable."""
    if not raw:
        return None
    try:
        return parse_datetime(str(raw).strip().replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def _serialize(m):
    return {
        "id": m.id,
        "created_at": m.created_at.isoformat(),
        "direction": m.direction,
        "destination": m.destination,
        "kind": m.kind,
        "text": m.text,
        "media_path": m.media_path,
        "external_id": m.external_id,
        "meta": m.meta,
    }


def _serialize_ask(a):
    return {
        "id": a.id,
        "text": a.text,
        "status": a.status,
        "created_at": a.created_at.isoformat(),
        "resolved_at": a.resolved_at.isoformat() if a.resolved_at else None,
        "notes": a.notes,
        "source_message_id": a.source_message_id,
    }


@api_view(["POST", "GET"])
def messages(request):
    if request.method == "POST":
        return _create_message(request)
    return _list_messages(request)


def _create_message(request):
    # request.data may be anything (or a parse error already turned into 400 by
    # DRF). normalize() copes with partial/garbage dicts; the blanket except
    # guarantees a fire-and-forget caller can never take a 500.
    try:
        fields = normalize(request.data)
        created_at = _parse_dt(
            request.data.get("created_at") if isinstance(request.data, dict) else None
        )
        if created_at:
            fields["created_at"] = created_at

        external_id = fields.pop("external_id")
        if external_id:
            obj, created = Message.objects.get_or_create(
                external_id=external_id, defaults=fields
            )
        else:
            obj, created = Message.objects.create(**fields), True
        return Response({"success": True, "id": obj.id, "created": created}, status=201)
    except Exception as exc:
        logger.warning("conversation_log: POST /messages/ failed: %s", exc)
        return Response({"success": False, "error": str(exc)}, status=400)


def _list_messages(request):
    try:
        qs = Message.objects.all()
        p = request.query_params

        since = _parse_dt(p.get("since"))
        if since:
            qs = qs.filter(created_at__gte=since)
        until = _parse_dt(p.get("until"))
        if until:
            qs = qs.filter(created_at__lte=until)

        destination = (p.get("destination") or "").strip().lower()
        if destination:
            qs = qs.filter(destination=destination)
        direction = (p.get("direction") or "").strip().lower()
        if direction:
            qs = qs.filter(direction=direction)
        q = (p.get("q") or "").strip()
        if q:
            qs = qs.filter(text__icontains=q)

        # Synthetic (test/probe) rows are HIDDEN BY DEFAULT. They stay in the
        # table as honest history, but a plain read of the log never mixes them
        # in with what the user actually said. ?synthetic=include to see them,
        # ?synthetic=only to audit them.
        synthetic = (p.get("synthetic") or "exclude").strip().lower()
        if synthetic == "only":
            qs = qs.filter(meta__synthetic=True)
        elif synthetic != "include":
            # NOT exclude(meta__synthetic=True): on a JSON key path a missing
            # key evaluates to NULL, and NOT NULL is NULL, so exclude() would
            # silently drop every UNMARKED row — i.e. the whole real log.
            qs = qs.filter(Q(meta__synthetic__isnull=True) | Q(meta__synthetic=False))

        limit = _parse_limit(p.get("limit"))
        rows = list(qs.order_by("-created_at", "-id")[:limit])
        return Response({"count": len(rows), "messages": [_serialize(m) for m in rows]})
    except Exception as exc:
        logger.warning("conversation_log: GET /messages/ failed: %s", exc)
        return Response({"error": str(exc)}, status=400)


@api_view(["GET"])
def open_asks(request):
    try:
        status = (request.query_params.get("status") or "open").strip().lower()
        qs = OpenAsk.objects.all()
        if status and status != "all":
            qs = qs.filter(status=status)
        limit = _parse_limit(request.query_params.get("limit"))
        rows = list(qs.order_by("-created_at", "-id")[:limit])
        return Response({"count": len(rows), "open_asks": [_serialize_ask(a) for a in rows]})
    except Exception as exc:
        logger.warning("conversation_log: GET /open-asks/ failed: %s", exc)
        return Response({"error": str(exc)}, status=400)
