"""Tests for the durable conversation log.

Covers: models, both endpoints, backfill idempotency, the no-prune guarantee
(criterion 12: a Message outlives the Notification it was derived from), and
incremental/idempotent open-ask extraction.
"""

import tempfile
from datetime import timedelta
from io import StringIO
from unittest import mock

from django.core.management import call_command
from django.test import TestCase, override_settings
from django.utils import timezone

from conversation_log.extraction import extract_asks
from conversation_log.models import ExtractionState, Message, OpenAsk
from conversation_log.recording import record, record_tts_notification
from text_to_speech.models import Notification


class MessageModelTests(TestCase):
    def test_fields_and_defaults(self):
        m = Message.objects.create(
            direction="inbound", destination="discord", kind="text", text="hello"
        )
        self.assertEqual(m.kind, "text")
        self.assertEqual(m.media_path, "")
        self.assertEqual(m.external_id, "")
        self.assertEqual(m.meta, {})
        self.assertIsNotNone(m.created_at)

    def test_destination_is_a_real_column_and_distinguishes_sources(self):
        Message.objects.create(direction="outbound", destination="discord", text="d")
        Message.objects.create(direction="outbound", destination="tts", text="t")
        Message.objects.create(direction="inbound", destination="terminal", text="x")
        self.assertEqual(Message.objects.filter(destination="tts").count(), 1)
        self.assertEqual(Message.objects.filter(destination="discord").count(), 1)
        self.assertEqual(Message.objects.filter(destination="terminal").count(), 1)

    def test_external_id_is_idempotent_but_blanks_are_unconstrained(self):
        a = record(direction="outbound", destination="discord", text="x", external_id="k1")
        b = record(direction="outbound", destination="discord", text="x", external_id="k1")
        self.assertEqual(a.id, b.id)
        record(direction="outbound", destination="discord", text="one")
        record(direction="outbound", destination="discord", text="two")
        self.assertEqual(Message.objects.filter(external_id="").count(), 2)

    def test_no_row_cap_or_pruning(self):
        """The whole point of this app: nothing trims Message. (criterion 12)"""
        for i in range(600):
            Message.objects.create(direction="inbound", destination="discord", text=f"m{i}")
        self.assertEqual(Message.objects.count(), 600)

    def test_message_survives_deletion_of_its_source_notification(self):
        """A Message must outlive the Notification it was derived from."""
        n = Notification.objects.create(text="spoken words", voice="af_heart")
        msg = record_tts_notification(n)
        self.assertIsNotNone(msg)
        nid = n.pk
        n.delete()
        self.assertFalse(Notification.objects.filter(pk=nid).exists())
        survivor = Message.objects.get(pk=msg.pk)
        self.assertEqual(survivor.text, "spoken words")
        self.assertEqual(survivor.destination, "tts")
        self.assertEqual(survivor.external_id, f"tts:{nid}")

    def test_open_ask_survives_deletion_of_its_source_message(self):
        m = Message.objects.create(direction="inbound", destination="discord", text="please add X")
        ask = OpenAsk.objects.create(text="please add X", source_message=m, dedupe_key="k")
        m.delete()
        ask.refresh_from_db()
        self.assertIsNone(ask.source_message)


class PostMessageEndpointTests(TestCase):
    URL = "/api/conversation/messages/"

    def test_stores_and_returns_id(self):
        r = self.client.post(
            self.URL,
            {"direction": "inbound", "destination": "discord", "kind": "text",
             "text": "hi there", "meta": {"user": "ethan"}},
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 201)
        body = r.json()
        self.assertTrue(body["success"])
        self.assertIsInstance(body["id"], int)
        m = Message.objects.get(pk=body["id"])
        self.assertEqual(m.text, "hi there")
        self.assertEqual(m.meta, {"user": "ethan"})

    def test_partial_payload_does_not_500(self):
        r = self.client.post(self.URL, {"text": "just text"}, content_type="application/json")
        self.assertEqual(r.status_code, 201)
        m = Message.objects.get(pk=r.json()["id"])
        self.assertEqual(m.direction, "outbound")   # documented fallback
        self.assertEqual(m.destination, "other")

    def test_empty_payload_does_not_500(self):
        r = self.client.post(self.URL, {}, content_type="application/json")
        self.assertEqual(r.status_code, 201)

    def test_garbage_enums_and_meta_do_not_500(self):
        r = self.client.post(
            self.URL,
            {"direction": "sideways", "destination": 42, "kind": None,
             "text": 12345, "meta": "not-a-dict", "media_path": None},
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 201)
        m = Message.objects.get(pk=r.json()["id"])
        self.assertEqual(m.direction, "outbound")
        self.assertEqual(m.destination, "other")
        self.assertEqual(m.kind, "text")
        self.assertEqual(m.text, "12345")
        self.assertEqual(m.meta, {"value": "not-a-dict"})

    def test_broken_json_body_does_not_500(self):
        r = self.client.post(self.URL, "{not json at all", content_type="application/json")
        self.assertLess(r.status_code, 500)

    def test_non_dict_json_body_does_not_500(self):
        r = self.client.post(self.URL, "[1,2,3]", content_type="application/json")
        self.assertLess(r.status_code, 500)

    def test_repeated_external_id_does_not_duplicate(self):
        for _ in range(3):
            r = self.client.post(
                self.URL,
                {"direction": "outbound", "destination": "discord",
                 "text": "same", "external_id": "discord:99"},
                content_type="application/json",
            )
            self.assertEqual(r.status_code, 201)
        self.assertEqual(Message.objects.filter(external_id="discord:99").count(), 1)


class ListMessagesEndpointTests(TestCase):
    URL = "/api/conversation/messages/"

    def setUp(self):
        now = timezone.now()
        self.old = Message.objects.create(
            direction="inbound", destination="discord", text="old apple message",
            created_at=now - timedelta(days=5))
        self.mid = Message.objects.create(
            direction="outbound", destination="tts", text="middle banana message",
            created_at=now - timedelta(days=2))
        self.new = Message.objects.create(
            direction="inbound", destination="terminal", text="new cherry message",
            created_at=now - timedelta(minutes=1))

    def _ids(self, response):
        return [m["id"] for m in response.json()["messages"]]

    def test_newest_first(self):
        self.assertEqual(self._ids(self.client.get(self.URL)),
                         [self.new.id, self.mid.id, self.old.id])

    def test_since_and_until(self):
        cutoff = (timezone.now() - timedelta(days=3)).isoformat()
        self.assertEqual(self._ids(self.client.get(self.URL, {"since": cutoff})),
                         [self.new.id, self.mid.id])
        self.assertEqual(self._ids(self.client.get(self.URL, {"until": cutoff})),
                         [self.old.id])

    def test_destination_and_direction_filters(self):
        self.assertEqual(self._ids(self.client.get(self.URL, {"destination": "tts"})), [self.mid.id])
        self.assertEqual(self._ids(self.client.get(self.URL, {"direction": "inbound"})),
                         [self.new.id, self.old.id])

    def test_text_search(self):
        self.assertEqual(self._ids(self.client.get(self.URL, {"q": "banana"})), [self.mid.id])
        self.assertEqual(self._ids(self.client.get(self.URL, {"q": "MESSAGE"})),
                         [self.new.id, self.mid.id, self.old.id])

    def test_limit(self):
        self.assertEqual(self._ids(self.client.get(self.URL, {"limit": 2})),
                         [self.new.id, self.mid.id])

    def test_bad_filters_do_not_500(self):
        r = self.client.get(self.URL, {"since": "not-a-date", "limit": "banana"})
        self.assertEqual(r.status_code, 200)


class SyntheticMarkerTests(TestCase):
    """A test/probe row that reaches the live table must be unmistakable.

    An OpenAsk the user never said is worse than no log at all, because it
    would be acted on. The marker is enforced in three places: it is accepted
    top level so it can't be fumbled, it hides the row from ordinary reads,
    and it keeps the row out of extraction entirely.
    """

    URL = "/api/conversation/messages/"

    def test_top_level_synthetic_flag_lands_in_meta(self):
        r = self.client.post(
            self.URL,
            {"direction": "inbound", "destination": "discord",
             "text": "smoke test", "synthetic": True},
            content_type="application/json",
        )
        m = Message.objects.get(pk=r.json()["id"])
        self.assertIs(m.meta["synthetic"], True)

    def test_nested_synthetic_flag_is_preserved(self):
        r = self.client.post(
            self.URL,
            {"text": "smoke test", "meta": {"synthetic": True, "note": "probe"}},
            content_type="application/json",
        )
        m = Message.objects.get(pk=r.json()["id"])
        self.assertIs(m.meta["synthetic"], True)
        self.assertEqual(m.meta["note"], "probe")

    def test_reads_hide_synthetic_rows_by_default(self):
        real = Message.objects.create(direction="inbound", destination="discord",
                                      text="something Ethan said")
        fake = Message.objects.create(direction="inbound", destination="discord",
                                      text="smoke test", meta={"synthetic": True})

        ids = [m["id"] for m in self.client.get(self.URL).json()["messages"]]
        self.assertEqual(ids, [real.id])

        ids = [m["id"] for m in self.client.get(self.URL, {"synthetic": "include"}).json()["messages"]]
        self.assertCountEqual(ids, [real.id, fake.id])

        ids = [m["id"] for m in self.client.get(self.URL, {"synthetic": "only"}).json()["messages"]]
        self.assertEqual(ids, [fake.id])

    def test_synthetic_rows_are_still_stored(self):
        """Hidden from reads, but never silently dropped — the log stays honest."""
        self.client.post(self.URL, {"text": "smoke", "synthetic": True},
                         content_type="application/json")
        self.assertEqual(Message.objects.count(), 1)


class BackfillTests(TestCase):
    def _make_notifications(self, n=5):
        for i in range(n):
            Notification.objects.create(
                text=f"spoken {i}", voice="af_heart", speed=1.0,
                terminal_id="999", audio_path=f"tts/{i}.wav")

    def test_backfill_creates_outbound_tts_messages(self):
        self._make_notifications(5)
        out = StringIO()
        call_command("backfill_tts_messages", stdout=out)
        self.assertEqual(Message.objects.filter(destination="tts").count(), 5)
        m = Message.objects.filter(destination="tts").first()
        self.assertEqual(m.direction, "outbound")
        self.assertEqual(m.kind, "voice")
        self.assertTrue(m.external_id.startswith("tts:"))
        self.assertIn("5 new", out.getvalue())

    def test_backfill_is_idempotent(self):
        self._make_notifications(5)
        call_command("backfill_tts_messages", stdout=StringIO())
        first = Message.objects.count()
        out = StringIO()
        call_command("backfill_tts_messages", stdout=out)
        self.assertEqual(Message.objects.count(), first)
        self.assertEqual(Message.objects.count(), 5)
        self.assertIn("0 new", out.getvalue())
        self.assertIn("5 already logged", out.getvalue())

    def test_backfill_preserves_original_timestamps(self):
        n = Notification.objects.create(text="old one", voice="af_heart")
        Notification.objects.filter(pk=n.pk).update(
            created_at=timezone.now() - timedelta(days=30))
        n.refresh_from_db()
        call_command("backfill_tts_messages", stdout=StringIO())
        m = Message.objects.get(external_id=f"tts:{n.pk}")
        self.assertEqual(m.created_at, n.created_at)

    def test_live_speak_path_logs_are_not_duplicated_by_backfill(self):
        n = Notification.objects.create(text="live", voice="af_heart")
        record_tts_notification(n)          # what speak() does inline
        call_command("backfill_tts_messages", stdout=StringIO())
        self.assertEqual(Message.objects.filter(external_id=f"tts:{n.pk}").count(), 1)


@override_settings(MEDIA_ROOT=tempfile.mkdtemp(prefix="conversation-log-tests-"))
class SpeakEndpointLoggingTests(TestCase):
    """The live TTS path must log with destination='tts' (criterion 6).

    Synthesis is patched out — this is about the logging hook in speak(), not
    about Kokoro — so the test makes no sound and needs no model.
    """

    @staticmethod
    def _fake_synth(path, text, **kwargs):
        """Stand in for Kokoro: write a stub wav so speak()'s os.replace works."""
        with open(path, "wb") as fh:
            fh.write(b"RIFF----WAVEfmt ")
        return 1234

    def test_speak_logs_a_tts_message(self):
        with mock.patch("text_to_speech.views.tts_service.synthesize_to_file",
                        side_effect=self._fake_synth) as synth:
            r = self.client.post(
                "/api/tts/speak/",
                {"text": "the deploy finished", "voice": "af_heart"},
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertTrue(synth.called)

        n = Notification.objects.get()
        m = Message.objects.get(external_id=f"tts:{n.pk}")
        self.assertEqual(m.direction, "outbound")
        self.assertEqual(m.destination, "tts")
        self.assertEqual(m.kind, "voice")
        self.assertEqual(m.text, "the deploy finished")
        self.assertEqual(m.meta["voice"], "af_heart")

    def test_speak_still_succeeds_when_logging_blows_up(self):
        """A logging failure must never fail a successful speak()."""
        with mock.patch("text_to_speech.views.tts_service.synthesize_to_file",
                        side_effect=self._fake_synth), \
             mock.patch("conversation_log.recording.record_tts_notification",
                        side_effect=RuntimeError("log db is on fire")):
            r = self.client.post(
                "/api/tts/speak/",
                {"text": "still speaks", "voice": "af_heart"},
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(Notification.objects.count(), 1)

    def test_pruned_notifications_leave_their_messages_behind(self):
        """text_to_speech._prune() must never reach into the durable log."""
        from text_to_speech import views as tts_views

        for i in range(5):
            n = Notification.objects.create(text=f"n{i}", voice="af_heart")
            record_tts_notification(n)
        with mock.patch.object(tts_views, "MAX_NOTIFICATIONS", 2):
            tts_views._prune()
        self.assertEqual(Notification.objects.count(), 2)
        self.assertEqual(Message.objects.filter(destination="tts").count(), 5)


class ExtractionTests(TestCase):
    def test_extract_asks_finds_requests_and_ignores_chatter(self):
        asks = extract_asks("Please add a dark mode toggle. The weather is nice. "
                            "Can you also fix the login bug?")
        self.assertEqual(len(asks), 2)
        self.assertIn("Please add a dark mode toggle.", asks[0])
        self.assertIn("fix the login bug", asks[1])

    def test_pure_questions_are_not_asks(self):
        self.assertEqual(extract_asks("What is the status of the deploy?"), [])

    def test_command_extracts_only_new_messages(self):
        Message.objects.create(direction="inbound", destination="discord",
                               text="Please add feature A.")
        call_command("extract_open_asks", stdout=StringIO())
        self.assertEqual(OpenAsk.objects.count(), 1)

        Message.objects.create(direction="inbound", destination="discord",
                               text="Please add feature B.")
        out = StringIO()
        call_command("extract_open_asks", stdout=out)
        self.assertEqual(OpenAsk.objects.count(), 2)
        self.assertIn("scanned 1 inbound message", out.getvalue())

    def test_command_is_idempotent_even_on_a_full_rescan(self):
        Message.objects.create(direction="inbound", destination="discord",
                               text="Please add feature A. Make sure it is tested.")
        call_command("extract_open_asks", stdout=StringIO())
        count = OpenAsk.objects.count()
        self.assertEqual(count, 2)
        call_command("extract_open_asks", "--reset", stdout=StringIO())
        self.assertEqual(OpenAsk.objects.count(), count)

    def test_watermark_advances_past_messages_without_asks(self):
        Message.objects.create(direction="inbound", destination="discord", text="hello there")
        call_command("extract_open_asks", stdout=StringIO())
        state = ExtractionState.load()
        self.assertGreater(state.last_message_id, 0)
        self.assertIsNotNone(state.last_run_at)
        out = StringIO()
        call_command("extract_open_asks", stdout=out)
        self.assertIn("scanned 0 inbound message", out.getvalue())

    def test_outbound_messages_are_not_scanned_for_asks(self):
        Message.objects.create(direction="outbound", destination="tts",
                               text="Please add feature A.")
        call_command("extract_open_asks", stdout=StringIO())
        self.assertEqual(OpenAsk.objects.count(), 0)

    def test_synthetic_messages_never_become_asks(self):
        """Probe/smoke-test rows are kept as log entries but are not asks."""
        Message.objects.create(direction="inbound", destination="discord",
                               text="Please add a synthetic feature.",
                               meta={"synthetic": True})
        call_command("extract_open_asks", stdout=StringIO())
        self.assertEqual(OpenAsk.objects.count(), 0)
        # ...and a full rescan must not resurrect them either.
        call_command("extract_open_asks", "--reset", stdout=StringIO())
        self.assertEqual(OpenAsk.objects.count(), 0)

    def test_asks_link_back_to_their_source_message(self):
        m = Message.objects.create(direction="inbound", destination="discord",
                                   text="Please add feature A.")
        call_command("extract_open_asks", stdout=StringIO())
        self.assertEqual(OpenAsk.objects.get().source_message_id, m.id)


class OpenAsksEndpointTests(TestCase):
    URL = "/api/conversation/open-asks/"

    def setUp(self):
        self.open_ask = OpenAsk.objects.create(text="add dark mode", dedupe_key="a")
        OpenAsk.objects.create(text="ship the thing", status="done",
                               resolved_at=timezone.now(), dedupe_key="b")
        OpenAsk.objects.create(text="never mind", status="dropped", dedupe_key="c")

    def test_status_open_returns_only_open(self):
        r = self.client.get(self.URL, {"status": "open"})
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["count"], 1)
        self.assertEqual(body["open_asks"][0]["text"], "add dark mode")
        self.assertEqual(body["open_asks"][0]["id"], self.open_ask.id)

    def test_defaults_to_open(self):
        self.assertEqual(self.client.get(self.URL).json()["count"], 1)

    def test_other_statuses(self):
        self.assertEqual(self.client.get(self.URL, {"status": "done"}).json()["count"], 1)
        self.assertEqual(self.client.get(self.URL, {"status": "all"}).json()["count"], 3)
