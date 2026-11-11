"""Tests fuer das Codex-Kontingent-Gate: alles Unklare muss SPERREN, nie schaetzen."""

import json
import os
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "runner"))
from quota import QuotaGate, QuotaUnavailable, parse_snapshot  # noqa: E402

NOW = 1_800_000_000.0  # feste Testzeit (Sekunden)


def snap(five=10.0, week=10.0, five_reset=None, week_reset=None, updated=None, labels=("5h", "Week"), plan="plus", provider="openai", extra=None, error=None):
    windows = []
    if labels[0]:
        windows.append({"label": labels[0], "usedPercent": five, "resetAt": (NOW + 3600) * 1000 if five_reset is None else five_reset})
    if labels[1]:
        windows.append({"label": labels[1], "usedPercent": week, "resetAt": (NOW + 86400) * 1000 if week_reset is None else week_reset})
    prov = {"provider": provider, "displayName": "Codex", "windows": windows, "plan": plan}
    if error:
        prov["error"] = error
    if extra:
        prov.update(extra)
    return json.dumps({"runtimeVersion": "x", "usage": {"updatedAt": (NOW - 5) * 1000 if updated is None else updated, "providers": [prov]}})


class Clock:
    def __init__(self):
        self.now = NOW

    def __call__(self):
        return self.now


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.clock = Clock()
        self.raw = snap()
        self.calls = 0

    def gate(self, name="q", **cfg):
        def fetch():
            self.calls += 1
            if isinstance(self.raw, Exception):
                raise self.raw
            return self.raw
        return QuotaGate(os.path.join(self.tmp, name + ".sqlite"), fetch, cfg, self.clock)


class GateTests(Base):
    def test_both_windows_below_limit_allowed(self):
        d = self.gate().check()
        self.assertTrue(d["allowed"])
        self.assertEqual(d["five_hour"]["left_percent"], 90.0)
        self.assertEqual(d["week"]["used_percent"], 10.0)

    def test_boundary_with_reserve(self):
        self.raw = snap(five=70.0)          # 70 + 10 Reserve = 80 -> erlaubt (<= Grenze)
        self.assertTrue(self.gate().check()["allowed"])
        self.raw = snap(five=70.5)          # 80,5 > 80 -> gesperrt
        self.assertFalse(self.gate().check()["allowed"])

    def test_either_window_blocks(self):
        self.raw = snap(five=10.0, week=75.0)
        d = self.gate().check()
        self.assertFalse(d["allowed"])
        self.assertIn("Wochen", d["reason"])
        self.raw = snap(five=75.0, week=10.0)
        self.assertIn("5-Stunden", self.gate("zweites_szenario").check()["reason"])

    def test_both_limits_must_hold_at_once(self):
        self.raw = snap(five=75.0, week=75.0)
        d = self.gate().check()
        self.assertFalse(d["allowed"])
        self.assertIn("5-Stunden", d["reason"])
        self.assertIn("Wochen", d["reason"])

    def test_only_one_window_measurable_blocks_never_estimates(self):
        for labels in (("5h", None), (None, "Week")):
            self.raw = snap(labels=labels)
            d = self.gate().check()
            self.assertFalse(d["allowed"])
            self.assertFalse(d["measurable"])
            self.assertNotIn("five_hour", d)  # keine erfundenen Werte

    def test_wrong_window_labels_block(self):
        for labels in (("3h", "Week"), ("5h", "Day"), ("168h", "Week"), ("5h", "5h")):
            self.raw = snap(labels=labels)
            self.assertFalse(self.gate().check()["allowed"], labels)

    def test_missing_or_implausible_values_block(self):
        for bad in (None, True, "10", float("nan"), -1, 100.5, float("inf")):
            self.raw = snap(five=bad)
            self.assertFalse(self.gate().check()["allowed"], bad)
        self.raw = snap(five_reset=0)
        self.assertFalse(self.gate().check()["allowed"])

    def test_reset_time_missing_or_in_past_blocks(self):
        self.raw = snap().replace('"resetAt"', '"resetAtX"', 1)
        self.assertFalse(self.gate().check()["allowed"])
        self.raw = snap(five_reset=(NOW - 10) * 1000)
        d = self.gate().check()
        self.assertFalse(d["allowed"])
        self.assertIn("Vergangenheit", d["reason"])

    def test_stale_or_future_measurement_blocks(self):
        self.raw = snap(updated=(NOW - 400) * 1000)
        self.assertIn("alt", self.gate().check()["reason"])
        self.raw = snap(updated=(NOW + 600) * 1000)
        self.assertFalse(self.gate().check()["allowed"])

    def test_not_logged_in_error_or_fetch_failure_block(self):
        self.raw = snap(provider="anthropic")
        self.assertFalse(self.gate().check()["allowed"])
        self.raw = snap(error="Token expired")
        self.assertFalse(self.gate().check()["allowed"])
        self.raw = "kein json"
        self.assertFalse(self.gate().check()["allowed"])
        self.raw = RuntimeError("Timeout mit Geheimnis sk-abc")
        d = self.gate().check()
        self.assertFalse(d["allowed"])
        self.assertNotIn("sk-abc", json.dumps(d))

    def test_two_openai_entries_are_ambiguous(self):
        data = json.loads(snap())
        data["usage"]["providers"].append(data["usage"]["providers"][0])
        self.raw = json.dumps(data)
        self.assertFalse(self.gate().check()["allowed"])


class AnomalyAndReserveTests(Base):
    def test_usage_dropping_within_same_window_is_an_anomaly(self):
        gate = self.gate()
        self.raw = snap(five=72.0)
        self.assertFalse(gate.check()["allowed"])           # gesperrt wegen Grenze
        self.raw = snap(five=0.0)                           # derselbe Reset, aber 0 %: typischer "|| 0"-Fehler
        d = gate.check()
        self.assertFalse(d["allowed"])
        self.assertIn("Anomalie", d["reason"])

    def test_genuine_reset_unblocks(self):
        gate = self.gate()
        self.raw = snap(five=72.0)
        self.assertFalse(gate.check()["allowed"])
        self.clock.now += 4000
        self.raw = snap(five=1.0, five_reset=(self.clock.now + 18000) * 1000, week=11.0, week_reset=(NOW + 86400) * 1000, updated=(self.clock.now - 3) * 1000)
        self.assertTrue(gate.check()["allowed"])            # neues Fenster (anderes resetAt) -> echte Erneuerung

    def test_reserve_grows_with_observed_review_cost(self):
        gate = self.gate()
        before = gate.check()
        self.raw = snap(five=18.0, week=14.0, updated=(NOW - 2) * 1000)
        after = gate.check()
        gate.record_cost(1, before, after)                  # gemessen: +8 Punkte im 5h-Fenster
        self.assertAlmostEqual(gate.reserve(), 12.0)       # 1,5 * 8
        self.raw = snap(five=69.0, week=14.0, updated=(NOW - 2) * 1000)
        self.assertFalse(gate.check()["allowed"])           # 69 + 12 > 80

    def test_cost_not_recorded_without_two_valid_measurements(self):
        gate = self.gate()
        gate.record_cost(1, {"measurable": False}, gate.check())
        self.assertEqual(gate.reserve(), 10.0)

    def test_custom_limit_is_respected(self):
        self.raw = snap(five=40.0)
        self.assertFalse(self.gate(limit_percent=45.0).check()["allowed"])
        self.assertTrue(self.gate(limit_percent=60.0).check()["allowed"])


class CacheTests(Base):
    """Regression (VPS, 2026-11-10): Die Kontingentabfrage dauert >30 s; der Chat darf nie darauf warten (sonst Zeitlimit -> 'nicht messbar')."""

    def slow_gate(self):
        import threading
        self.release, self.started = threading.Event(), threading.Event()
        self.calls = 0

        def fetch():
            self.calls += 1
            self.started.set()
            self.release.wait(10)
            return self.raw
        return QuotaGate(os.path.join(self.tmp, "slow.sqlite"), fetch, None, self.clock)

    def test_cached_never_blocks_on_a_slow_measurement(self):
        import time
        gate = self.slow_gate()
        t0 = time.time()
        first = gate.cached()
        self.assertLess(time.time() - t0, 1.0)             # kehrt sofort zurueck
        self.assertTrue(first["pending"])
        self.assertFalse(first["allowed"])
        self.assertIn("laeuft", first["reason"])
        self.assertTrue(self.started.wait(3))              # Messung wurde im Hintergrund gestartet
        self.release.set()
        for _ in range(50):
            second = gate.cached()
            if not second.get("pending"):
                break
            time.sleep(0.1)
        self.assertTrue(second["measurable"])
        self.assertIn("gemessen_vor_s", second)

    def test_only_one_background_measurement_at_a_time(self):
        import time
        gate = self.slow_gate()
        for _ in range(5):
            gate.cached()
        self.assertTrue(self.started.wait(3))
        time.sleep(0.2)
        self.assertEqual(self.calls, 1)
        self.release.set()
        time.sleep(1.0)                                    # nach der Freigabe duerfen sich KEINE weiteren Messungen aufgestaut haben
        self.assertEqual(self.calls, 1)

    def test_stale_cache_triggers_refresh_but_still_answers_instantly(self):
        gate = self.gate()
        gate.check()
        self.assertEqual(self.calls, 1)
        out = gate.cached(max_age_s=100)
        self.assertEqual(self.calls, 1)                    # frisch genug: kein neuer Abruf
        self.assertEqual(out["gemessen_vor_s"], 0)
        self.clock.now += 500
        self.raw = snap(five=12.0, five_reset=(self.clock.now + 3600) * 1000, week_reset=(self.clock.now + 86400) * 1000, updated=(self.clock.now - 2) * 1000)
        stale = gate.cached(max_age_s=100)
        self.assertEqual(stale["gemessen_vor_s"], 500)    # alte Messung sofort, mit ihrem Alter
        import time
        for _ in range(50):
            if self.calls >= 2:
                break
            time.sleep(0.1)
        self.assertGreaterEqual(self.calls, 2)

    def test_daemon_limits_and_agents_use_the_cache(self):
        import time
        sys.path.insert(0, os.path.join(ROOT, "runner"))
        import runner_daemon
        gate = self.slow_gate()

        class FakeRunner:
            @staticmethod
            def status():
                return {"jobs": [], "pakete": ["WP-009"]}

        class FakeManager:
            @staticmethod
            def gemini_status():
                return {"zustand": "x"}
        cmd = runner_daemon.make_review_cmd(FakeRunner, FakeManager, gate)
        t0 = time.time()
        res = cmd("limits", {})
        agents = cmd("agents", {})
        self.assertLess(time.time() - t0, 1.0)
        self.assertTrue(res["pending"])
        self.assertFalse(agents["codex"]["startbereit"])
        self.release.set()

    def test_review_start_still_measures_fresh_not_from_cache(self):
        gate = self.gate()
        gate.check()
        before = self.calls
        gate.check()
        self.assertEqual(self.calls, before + 1)            # check() nutzt nie den Zwischenspeicher

    def test_handler_ignores_clients_that_hung_up(self):
        import io
        sys.path.insert(0, os.path.join(ROOT, "runner"))
        import runner_daemon

        class Hung:
            def write(self, data):
                raise BrokenPipeError(32, "Broken pipe")

        class Srv:
            class runner:
                @staticmethod
                def status():
                    return {"jobs": []}
        h = runner_daemon.Handler.__new__(runner_daemon.Handler)
        h.server, h.rfile, h.wfile = Srv, io.BytesIO(b'{"cmd": "status"}\n'), Hung()
        h.handle()  # darf nicht werfen (kein Traceback im Journal)


class ParseTests(unittest.TestCase):
    def test_parse_extracts_text_before_json(self):
        out = parse_snapshot("noise line\n" + snap(), NOW)
        self.assertEqual(out["five"]["used"], 10.0)
        self.assertEqual(out["plan"], "plus")

    def test_parse_rejects_without_usage(self):
        for raw in ('{"x": 1}', '{"usage": {"providers": []}}', '{"usage": {"updatedAt": 1, "providers": []}}'):
            with self.assertRaises(QuotaUnavailable):
                parse_snapshot(raw, NOW)


if __name__ == "__main__":
    unittest.main()


class ParseRobustnessTests(unittest.TestCase):
    """2026-11-11: OpenClaw schreibt Protokollzeilen vor/nach dem JSON (z. B. '[state/agent-db] ... receipt: written')."""

    def snap(self):
        now = 1_800_000_000
        return now, json.dumps({"usage": {"updatedAt": now * 1000, "providers": [{"provider": "openai", "plan": "plus", "windows": [
            {"label": "5h", "usedPercent": 3, "resetAt": (now + 3600) * 1000}, {"label": "Week", "usedPercent": 9, "resetAt": (now + 86400) * 1000}]}]}})

    def test_trailing_and_leading_log_lines(self):
        now, js = self.snap()
        raw = "[proxy] routing {x} through proxy\n" + js + "\n[state/agent-db] agent database clean-close receipt: written\n"
        self.assertEqual(parse_snapshot(raw, now)["five"]["used"], 3)

    def test_unreadable_output_names_tail_without_secrets(self):
        with self.assertRaises(QuotaUnavailable) as ctx:
            parse_snapshot("No auth profile for openai (user hans@example.com)", 1)
        self.assertIn("No auth profile", str(ctx.exception))
        self.assertNotIn("hans@example.com", str(ctx.exception))
