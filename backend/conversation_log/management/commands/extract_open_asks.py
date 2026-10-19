"""Populate OpenAsk from inbound messages newer than the last run.

Safe to run on a schedule: it advances a watermark (ExtractionState) so each
run only scans new rows, and OpenAsk.dedupe_key is unique so even a full
re-scan (--reset) can't duplicate anything.
"""

from django.core.management.base import BaseCommand
from django.db import IntegrityError, transaction

from conversation_log.extraction import dedupe_key, extract_asks
from conversation_log.models import ExtractionState, Message, OpenAsk


class Command(BaseCommand):
    help = "Extract open asks from inbound conversation messages (incremental)."

    def add_arguments(self, parser):
        parser.add_argument("--reset", action="store_true",
                            help="Rescan from the beginning (still idempotent).")
        parser.add_argument("--since-id", type=int, default=None,
                            help="Scan messages with id greater than this instead of the watermark.")
        parser.add_argument("--dry-run", action="store_true",
                            help="Report what would be extracted; write nothing.")

    def handle(self, *args, **opts):
        state = ExtractionState.load()
        watermark = 0 if opts["reset"] else state.last_message_id
        if opts["since_id"] is not None:
            watermark = opts["since_id"]

        qs = (Message.objects
              .filter(id__gt=watermark, direction="inbound")
              .order_by("id"))

        scanned = 0
        created = 0
        skipped = 0
        highest = watermark

        for msg in qs.iterator(chunk_size=500):
            scanned += 1
            highest = max(highest, msg.id)
            # Rows explicitly marked synthetic (smoke tests, probes) are real
            # log entries but were never said by the user, so they must never
            # become asks — including on a --reset full rescan.
            if isinstance(msg.meta, dict) and msg.meta.get("synthetic"):
                continue
            for ask in extract_asks(msg.text):
                key = dedupe_key(ask)
                if opts["dry_run"]:
                    if OpenAsk.objects.filter(dedupe_key=key).exists():
                        skipped += 1
                    else:
                        created += 1
                        self.stdout.write(f"  would add: {ask[:100]}")
                    continue
                try:
                    with transaction.atomic():
                        _, was_created = OpenAsk.objects.get_or_create(
                            dedupe_key=key,
                            defaults={"text": ask, "source_message": msg},
                        )
                    if was_created:
                        created += 1
                    else:
                        skipped += 1
                except IntegrityError:
                    skipped += 1

        # The watermark must advance past every message we scanned, including
        # ones with no asks, or a scheduled run rescans them forever.
        highest_seen = Message.objects.filter(id__gt=watermark).order_by("-id").values_list("id", flat=True).first()
        if highest_seen:
            highest = max(highest, highest_seen)

        if not opts["dry_run"]:
            from django.utils import timezone
            state.last_message_id = highest
            state.last_run_at = timezone.now()
            state.save(update_fields=["last_message_id", "last_run_at"])

        self.stdout.write(self.style.SUCCESS(
            f"extract_open_asks: scanned {scanned} inbound message(s) "
            f"(> id {watermark}), created {created}, already known {skipped}, "
            f"watermark now {highest}{' (dry run — not saved)' if opts['dry_run'] else ''}"
        ))
