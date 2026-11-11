"""Tests fuer den beratenden Gemini-Zusatzreview: Datenregel, Limiter, Fehlerpfade (Attrappen, kein Netz)."""

import json
import os
import shutil
import sys
import tempfile
import unittest
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "runner"))
from gemini_review import (GeminiLimiter, GeminiReviewer, GeminiUnavailable, PACIFIC, contains_secret, next_pacific_midnight, pacific_day)  # noqa: E402
from tests.test_reviews import DevExec, ReviewBase, Rev, finding, review_text  # noqa: E402
from tests.test_quota import snap  # noqa: E402

KEY = "AIzaSyDUMMY-NICHT-ECHT-0123456789abcdefgh"


def gemini_body(text):
    return json.dumps({"candidates": [{"content": {"parts": [{"text": text}]}}]}).encode()


class Clock:
    def __init__(self, start=1_800_000_000.0):
        self.now = start

    def __call__(self):
        return self.now


class Transport:
    def __init__(self, status=200, body=None, exc=None):
        self.status, self.body, self.exc, self.calls = status, body if body is not None else gemini_body("ok"), exc, []

    def __call__(self, path, headers, body):
        self.calls.append((path, dict(headers), body))
        if self.exc:
            raise self.exc
        return self.status, self.body


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.clock = Clock()
        self.transport = Transport()
        self.limiter = GeminiLimiter(os.path.join(self.tmp, "g.sqlite"), {"min_interval_s": 15, "max_requests_per_day": 3}, self.clock)
        self.gem = GeminiReviewer(KEY, "gemini-test", self.limiter, {"max_prompt_chars": 1000}, self.transport, clock=self.clock)


class ReviewerTests(Base):
    def test_unconfigured_never_calls(self):
        for key, model in (("", "m"), ("  ", "m"), (KEY, "")):
            g = GeminiReviewer(key, model, self.limiter, None, self.transport, clock=self.clock)
            with self.assertRaises(GeminiUnavailable):
                g.review("hallo")
        self.assertEqual(self.transport.calls, [])

    def test_secrets_in_prompt_are_never_sent(self):
        for secret in ("key AIzaSyA1234567890abcdefghijklmnopqrstu", "sk-abcdefghijklmnopqrstuv", "-----BEGIN RSA PRIVATE KEY-----",
                       "123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKKlll", "AKIAABCDEFGHIJKLMNOP", 'password = "geheim12345"', "ghp_" + "a" * 36):
            with self.assertRaises(GeminiUnavailable, msg=secret):
                self.gem.review("code\n" + secret)
        self.assertEqual(self.transport.calls, [])
        self.assertTrue(contains_secret("token: 'abcdefgh1234'"))
        self.assertFalse(contains_secret("def add(a, b):\n    return a + b\n"))

    def test_prompt_size_limit(self):
        with self.assertRaises(GeminiUnavailable):
            self.gem.review("x" * 1001)
        self.assertEqual(self.transport.calls, [])

    def test_key_only_in_header_never_in_path_body_or_errors(self):
        self.transport.body = gemini_body("hallo")
        self.assertEqual(self.gem.review("synthetischer code"), "hallo")
        path, headers, body = self.transport.calls[0]
        self.assertEqual(headers["x-goog-api-key"], KEY)
        self.assertNotIn(KEY, path)
        self.assertNotIn(KEY.encode(), body)
        self.assertEqual(path, "/v1beta/models/gemini-test:generateContent")
        self.clock.now += 20
        self.transport.status = 500
        with self.assertRaises(GeminiUnavailable) as ctx:
            self.gem.review("nochmal")
        self.assertNotIn(KEY, str(ctx.exception))

    def test_daily_limit_and_interval(self):
        for i in range(3):
            self.gem.review("a%d" % i)
            with self.assertRaises(GeminiUnavailable) as ctx:  # Mindestabstand
                self.gem.review("zu frueh")
            self.assertIn("Mindestabstand", str(ctx.exception)) if i < 2 else None
            self.clock.now += 20
        with self.assertRaises(GeminiUnavailable) as ctx:
            self.gem.review("viertes")
        self.assertIn("Tageslimit", str(ctx.exception))
        self.assertEqual(len(self.transport.calls), 3)
        self.clock.now = next_pacific_midnight(self.clock.now) + 60  # naechster Pazifik-Tag
        self.gem.review("neuer tag")
        self.assertEqual(len(self.transport.calls), 4)

    def test_429_blocks_until_next_pacific_reset(self):
        self.transport.status = 429
        with self.assertRaises(GeminiUnavailable):
            self.gem.review("a")
        self.transport.status = 200
        self.clock.now += 3600
        with self.assertRaises(GeminiUnavailable) as ctx:
            self.gem.review("b")
        self.assertIn("pausiert", str(ctx.exception))
        self.assertEqual(len(self.transport.calls), 1)
        self.clock.now = next_pacific_midnight(1_800_000_000.0) + 1
        self.gem.review("c")
        self.assertEqual(len(self.transport.calls), 2)

    def test_auth_errors_disable_permanently(self):
        for status in (401, 403):
            self.setUp()
            self.transport.status = status
            with self.assertRaises(GeminiUnavailable):
                self.gem.review("a")
            self.transport.status = 200
            self.clock.now += 10 * 86400
            with self.assertRaises(GeminiUnavailable) as ctx:
                self.gem.review("b")
            self.assertIn("dauerhaft deaktiviert", str(ctx.exception))
            self.assertEqual(len(self.transport.calls), 1)

    def test_connection_error_pauses_one_hour_and_counts_the_attempt(self):
        self.transport.exc = OSError("boom " + KEY)
        with self.assertRaises(GeminiUnavailable) as ctx:
            self.gem.review("a")
        self.assertNotIn(KEY, str(ctx.exception))
        self.assertEqual(self.limiter.status()["heute_genutzt"], 1)
        self.transport.exc = None
        with self.assertRaises(GeminiUnavailable):
            self.gem.review("b")
        self.clock.now += 3700
        self.gem.review("c")

    def test_unreadable_response(self):
        self.transport.body = b"kein json"
        with self.assertRaises(GeminiUnavailable):
            self.gem.review("a")
        self.setUp()
        self.transport.body = json.dumps({"candidates": []}).encode()
        with self.assertRaises(GeminiUnavailable):
            self.gem.review("a")

    def test_pacific_day_boundary(self):
        end = next_pacific_midnight(1_800_000_000.0)
        self.assertGreater(end, 1_800_000_000.0)
        self.assertLess(end - 1_800_000_000.0, 25 * 3600)
        self.assertNotEqual(pacific_day(end - 600), pacific_day(end + 60))
        self.assertEqual(datetime.fromtimestamp(end, PACIFIC).hour, 0)


class IntegrationTests(ReviewBase):
    def setUp(self):
        super().setUp()
        self.cfg["packages"]["WP-X"]["synthetic"] = True
        self.tmp2 = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp2, True)
        self.transport = Transport(body=gemini_body(review_text([finding()])))
        limiter = GeminiLimiter(os.path.join(self.tmp2, "g.sqlite"), {"min_interval_s": 0, "max_requests_per_day": 5})
        self.gem = GeminiReviewer(KEY, "gemini-test", limiter, None, self.transport)
        self.mgr.gemini = self.gem
        self.usage = snap(week=75.0)  # Codex gesperrt

    def test_synthetic_package_gets_advisory_gemini_review_when_codex_paused(self):
        self.finished_job()
        rev = Rev([review_text([])])
        self.mgr.run_next(self.dev, rev)
        rows = self.mgr.list()
        self.assertEqual({r["pruefer"] for r in rows}, {"codex", "gemini"})
        gem = next(r for r in rows if r["pruefer"] == "gemini")
        cdx = next(r for r in rows if r["pruefer"] == "codex")
        self.assertEqual((gem["zustand"], gem["bestaetigt"]), ("done_open", 1))
        self.assertEqual(cdx["zustand"], "paused")           # Codex-Review steht weiter aus
        self.assertEqual(rev.calls, 0)
        self.assertEqual(self.dev.fix_prompts, [])            # Gemini korrigiert nie
        msg = [m for m in self.notifier.messages if "Gemini" in m][-1]
        self.assertIn("BERATEND", msg)
        self.assertIn("ersetzt den Codex-Review nicht", msg)

    def test_non_synthetic_package_never_goes_to_gemini(self):
        self.cfg["packages"]["WP-X"]["synthetic"] = False
        self.finished_job()
        self.mgr.run_next(self.dev, Rev([review_text([])]))
        self.assertEqual(self.transport.calls, [])
        self.assertEqual({r["pruefer"] for r in self.mgr.list()}, {"codex"})
        del self.cfg["packages"]["WP-X"]["synthetic"]         # Flag fehlt ganz -> ebenfalls gesperrt
        self.mgr.run_next(self.dev, Rev([review_text([])]))
        self.assertEqual(self.transport.calls, [])

    def test_non_boolean_synthetic_flag_is_not_enough(self):
        self.cfg["packages"]["WP-X"]["synthetic"] = "true"  # nur ein echtes JSON-true zaehlt
        self.finished_job()
        self.mgr.run_next(self.dev, Rev([review_text([])]))
        self.assertEqual(self.transport.calls, [])
        self.assertEqual({r["pruefer"] for r in self.mgr.list()}, {"codex"})

    def test_codex_available_means_no_gemini(self):
        self.usage = snap()
        self.finished_job()
        self.mgr.run_next(self.dev, Rev([review_text([])]))
        self.assertEqual(self.transport.calls, [])

    def test_only_one_gemini_review_per_job(self):
        self.finished_job()
        for _ in range(3):
            self.mgr.run_next(self.dev, Rev([review_text([])]))
        self.assertEqual(len(self.transport.calls), 1)

    def test_gemini_unavailable_does_not_disturb_codex_queue(self):
        self.transport.status = 429
        self.finished_job()
        self.mgr.run_next(self.dev, Rev([review_text([])]))
        rows = self.mgr.list()
        self.assertEqual(next(r for r in rows if r["pruefer"] == "codex")["zustand"], "paused")
        self.assertEqual(next(r for r in rows if r["pruefer"] == "gemini")["zustand"], "cancelled")

    def test_hallucinated_gemini_finding_is_not_confirmed(self):
        self.transport.body = gemini_body(review_text([finding(file="gibt_es_nicht.py")]))
        self.finished_job()
        self.mgr.run_next(self.dev, Rev([review_text([])]))
        self.assertEqual(next(r for r in self.mgr.list() if r["pruefer"] == "gemini")["bestaetigt"], 0)

    def test_gemini_status_without_key(self):
        self.mgr.gemini = GeminiReviewer("", "m", self.gem.limiter, None, self.transport)
        self.assertIn("nicht eingerichtet", self.mgr.gemini_status()["zustand"])
        self.mgr.gemini = self.gem
        st = self.mgr.gemini_status()
        self.assertIn("nur synthetische Pakete", st["datenregel"])
        self.assertEqual(st["modell"], "gemini-test")

    def test_synthetic_flag_is_part_of_the_approval_hash(self):
        before = self.runner.spec_hash("WP-X")
        self.cfg["packages"]["WP-X"]["synthetic"] = False
        self.assertNotEqual(before, self.runner.spec_hash("WP-X"))


if __name__ == "__main__":
    unittest.main()
