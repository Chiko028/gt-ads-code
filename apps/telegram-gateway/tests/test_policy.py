import datetime
import unittest

from gtads_tg.policy import VIENNA_NAME, SlidingWindowLimiter, classify, day_key

from tests.helpers import ALLOWED, OTHER, FakeClock, make_update


class PolicyTests(unittest.TestCase):
    def test_u01_accepts_allowed_private_text(self):  # U-01
        verdict = classify(make_update(text="Hallo"), ALLOWED)
        self.assertTrue(verdict.accept)
        self.assertEqual(verdict.text, "Hallo")
        self.assertEqual(verdict.chat_id, ALLOWED)

    def test_u02_drops_everything_else(self):  # U-02
        cases = [
            ("unauthorized", make_update(sender=OTHER)),
            ("not_private", make_update(chat_type="group")),
            ("not_private", make_update(chat_type="supergroup")),
            ("not_private", make_update(chat_type="channel")),
            ("bot_or_unknown", make_update(is_bot=True)),
            ("no_text", make_update(text=None, photo=[{"file_id": "SYN"}])),
            ("forwarded", make_update(forward_origin={"type": "user"})),
            ("forwarded", make_update(forward_from={"id": OTHER})),
            ("via_bot", make_update(via_bot={"id": OTHER})),
            ("not_message", {"update_id": 1, "edited_message": make_update()["message"]}),
            ("not_message", {"update_id": 1, "callback_query": {"id": "SYN"}}),
            ("not_message", {"update_id": 1, "channel_post": make_update()["message"]}),
            ("not_message", {"update_id": 1, "inline_query": {"id": "SYN"}}),
        ]
        for reason, update in cases:
            with self.subTest(reason=reason, keys=sorted(update.get("message", update))[:3]):
                verdict = classify(update, ALLOWED)
                self.assertFalse(verdict.accept)
                self.assertEqual(verdict.reason, reason)

    def test_u03_malformed_input_is_dropped_without_error(self):  # U-03
        for bad in (None, 5, [], {}, {"message": None}, {"message": {}}, {"message": {"chat": {}}}):
            with self.subTest(bad=bad):
                self.assertFalse(classify(bad, ALLOWED).accept)
        self.assertFalse(classify(make_update(sender="4242"), ALLOWED).accept)  # String-ID
        self.assertFalse(classify(make_update(sender=-ALLOWED), ALLOWED).accept)
        self.assertFalse(classify(make_update(sender=True), 1).accept)  # bool ist keine ID
        self.assertFalse(classify(make_update(sender=2**80), ALLOWED).accept)
        self.assertFalse(classify(make_update(text="   "), ALLOWED).accept)
        self.assertFalse(classify(make_update(text=123), ALLOWED).accept)
        self.assertFalse(classify(make_update(chat_id=OTHER), ALLOWED).accept)  # Chat-ID != Absender
        self.assertFalse(classify(make_update(), 0).accept)  # ohne konfigurierte ID nie akzeptieren

    def test_u05_rate_limiter_window(self):  # U-05
        clock = FakeClock()
        limiter = SlidingWindowLimiter(5, 60, clock)
        self.assertEqual([limiter.allow() for _ in range(6)], [True] * 5 + [False])
        clock.advance(59)
        self.assertFalse(limiter.allow())
        clock.advance(1.01)
        self.assertTrue(limiter.allow())

    @unittest.skipIf(VIENNA_NAME != "Europe/Vienna", "tzdata fehlt")
    def test_u06_day_key_dst_boundaries(self):  # U-06
        utc = datetime.timezone.utc

        def key(*moment):
            return day_key(datetime.datetime(*moment, tzinfo=utc).timestamp())

        # Sommerzeit endet 2026-10-25 01:00 UTC (03:00 CEST -> 02:00 CET).
        self.assertEqual(key(2026, 10, 24, 21, 59), "2026-10-24")  # 23:59 CEST
        self.assertEqual(key(2026, 10, 24, 22, 1), "2026-10-25")  # 00:01 CEST
        self.assertEqual(key(2026, 10, 25, 22, 59), "2026-10-25")  # 23:59 CET
        self.assertEqual(key(2026, 10, 25, 23, 1), "2026-10-26")  # 00:01 CET
        # Sommerzeit beginnt 2026-03-29 01:00 UTC (02:00 CET -> 03:00 CEST).
        self.assertEqual(key(2026, 3, 28, 22, 59), "2026-03-28")  # 23:59 CET
        self.assertEqual(key(2026, 3, 28, 23, 1), "2026-03-29")  # 00:01 CET
        self.assertEqual(key(2026, 3, 29, 21, 59), "2026-03-29")  # 23:59 CEST
        self.assertEqual(key(2026, 3, 29, 22, 1), "2026-03-30")  # 00:01 CEST


if __name__ == "__main__":
    unittest.main()
