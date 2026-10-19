"""Durable, append-only record of every message exchanged with the user.

WHY THIS EXISTS
---------------
Spoken output was the only thing ever persisted (text_to_speech.Notification),
and even that is capped: text_to_speech.views.MAX_NOTIFICATIONS = 500 with a
_prune() on every create, which has already destroyed ~1600 past messages.
Everything TYPED, in either direction, was persisted nowhere at all — the
frontend queue was the single source of truth and it dies with the session.

NO CAP, NO PRUNE — EVER
-----------------------
`Message` is append-only. There is deliberately no MAX_* constant, no _prune(),
no TTL, no trimming management command, and no cascade from any upstream table.
A Message derived from a Notification holds only the *string* `external_id`
("tts:<pk>") — never a ForeignKey — so text_to_speech's pruning can never reach
in here. The Message must outlive the Notification it came from. If you are
about to add row-capping logic to this model: don't. That is the exact data loss
this app was built to stop.
"""

from django.db import models
from django.db.models import Q
from django.utils import timezone


DIRECTION_CHOICES = [
    ("inbound", "inbound"),    # user -> manager
    ("outbound", "outbound"),  # manager -> user
]

DESTINATION_CHOICES = [
    ("discord", "discord"),
    ("tts", "tts"),
    ("terminal", "terminal"),
    ("other", "other"),
]

KIND_CHOICES = [
    ("text", "text"),
    ("voice", "voice"),
    ("image", "image"),
    ("video", "video"),
    ("file", "file"),
]

DIRECTIONS = {c[0] for c in DIRECTION_CHOICES}
DESTINATIONS = {c[0] for c in DESTINATION_CHOICES}
KINDS = {c[0] for c in KIND_CHOICES}


class Message(models.Model):
    """One message, in either direction, on any destination.

    `created_at` defaults to now but is explicitly settable so historical rows
    (the TTS backfill) keep their real timestamps.

    `external_id` is the idempotency key: a stable identifier from the source
    system ("tts:1837", a Discord message id, ...). Unique when non-empty, so a
    re-run of a backfill or a retried fire-and-forget POST cannot duplicate.
    """

    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    direction = models.CharField(max_length=16, choices=DIRECTION_CHOICES, db_index=True)
    destination = models.CharField(max_length=16, choices=DESTINATION_CHOICES, db_index=True)
    kind = models.CharField(max_length=16, choices=KIND_CHOICES, default="text")
    text = models.TextField(blank=True, default="")
    # Absolute path to media on disk (inbound download / outbound attachment).
    media_path = models.CharField(max_length=1000, blank=True, default="")
    external_id = models.CharField(max_length=200, blank=True, default="", db_index=True)
    meta = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        constraints = [
            models.UniqueConstraint(
                fields=["external_id"],
                condition=~Q(external_id=""),
                name="conversation_log_message_external_id_uniq",
            )
        ]
        indexes = [
            models.Index(fields=["direction", "-created_at"], name="cl_msg_dir_created_idx"),
            models.Index(fields=["destination", "-created_at"], name="cl_msg_dest_created_idx"),
        ]

    def __str__(self):
        return f"[{self.direction}/{self.destination}] {self.text[:60]}"


class OpenAsk(models.Model):
    """Something the user asked for, extracted from an inbound message.

    `source_message` is SET_NULL on delete: an ask outlives its source row.
    `dedupe_key` makes the extractor structurally idempotent — re-processing the
    same text can never create a second ask.
    """

    STATUS_CHOICES = [
        ("open", "open"),
        ("done", "done"),
        ("dropped", "dropped"),
    ]

    text = models.TextField()
    source_message = models.ForeignKey(
        Message,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="open_asks",
    )
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default="open", db_index=True)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    resolved_at = models.DateTimeField(null=True, blank=True)
    notes = models.TextField(blank=True, default="")
    # Normalized fingerprint of `text`; unique so extraction is idempotent.
    dedupe_key = models.CharField(max_length=64, unique=True)

    class Meta:
        ordering = ["-created_at", "-id"]

    def __str__(self):
        return f"[{self.status}] {self.text[:60]}"


class ExtractionState(models.Model):
    """Singleton (pk=1) watermark for the extract_open_asks command.

    Tracks the highest Message id already scanned, so a scheduled run only
    processes what arrived since last time.
    """

    last_message_id = models.BigIntegerField(default=0)
    last_run_at = models.DateTimeField(null=True, blank=True)

    @classmethod
    def load(cls):
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj
