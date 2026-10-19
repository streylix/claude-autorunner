"""Backfill surviving text_to_speech.Notification rows as outbound messages.

IDEMPOTENT: each row is keyed by external_id "tts:<notification pk>", which is
unique in the durable log, so running this twice creates nothing the second
time.

Note the asymmetry this exists to fix: text_to_speech._prune() caps that table
at MAX_NOTIFICATIONS (500) and has already deleted ~1600 older notifications.
Only what survives can be recovered; from here on the durable log keeps
everything, because it has no cap.
"""

from django.core.management.base import BaseCommand

from conversation_log.recording import record_tts_notification
from text_to_speech.models import Notification


class Command(BaseCommand):
    help = "Backfill text_to_speech.Notification rows into the durable conversation log."

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, **opts):
        from conversation_log.models import Message

        total = Notification.objects.count()
        created = 0
        existing = 0
        failed = 0

        for n in Notification.objects.order_by("id").iterator(chunk_size=200):
            key = f"tts:{n.pk}"
            if opts["dry_run"]:
                if Message.objects.filter(external_id=key).exists():
                    existing += 1
                else:
                    created += 1
                continue
            before = Message.objects.filter(external_id=key).exists()
            msg = record_tts_notification(n)
            if msg is None:
                failed += 1
            elif before:
                existing += 1
            else:
                created += 1

        self.stdout.write(self.style.SUCCESS(
            f"backfill_tts_messages: {total} notification(s) — "
            f"{created} new, {existing} already logged, {failed} failed"
            f"{' (dry run — nothing written)' if opts['dry_run'] else ''}"
        ))
