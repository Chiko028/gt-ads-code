"""Telegram-Steuerung (Betreiber 2026-11-11): Diagnose, Anhalten, erneutes Senden, Wiederholen - nichts davon gibt frei."""

import os
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "runner"))
import runner_daemon  # noqa: E402
from redact import redact  # noqa: E402
from tests.test_planner import FakeCodex, Gate, PlannerBase, pkg  # noqa: E402
from tests.test_runner import OP, Base, FakeExecutor  # noqa: E402


class RedactTests(unittest.TestCase):
    def test_secrets_removed_paths_kept(self):
        for secret in ("sk-" + "a" * 30, "AIza" + "b" * 35, "123456789:" + "C" * 35, "ghp_" + "d" * 36, "token=abcdef123456", "hans@example.com", "C1US-9KNKO"):
            self.assertNotIn(secret, redact("vorher %s nachher" % secret), secret)
        self.assertIn("/tmp/openclaw/openclaw-container-env-4tHGv2/container.env", redact("open /tmp/openclaw/openclaw-container-env-4tHGv2/container.env: permission denied"))


class RunnerControlTests(Base):
    def failed_job(self):
        job = self.approved_job()
        self.runner.execute(self.runner.claim_next(), FakeExecutor(passes=(False,)))
        self.assertNotEqual(self.runner._job(job)["state"], "succeeded")
        return job

    def test_retry_button_prepares_new_draft_but_never_starts(self):
        job = self.failed_job()
        self.assertNotEqual(self.runner._job(job)["state"], "succeeded")
        self.assertEqual(self.notifier.buttons[0][0]["text"], "Erneut vorbereiten")
        retry_nonce = self.notifier.last_nonce()
        res = self.click("p")
        self.assertIn("Neuer Entwurf", res["text"])
        states = [j["state"] for j in self.runner.status()["jobs"]]
        self.assertEqual(states[0], "prepared")                                   # nur Entwurf, kein Start
        self.assertIsNone(self.runner.claim_next())
        self.assertIn("bereits verwendet", self.click("p", nonce=retry_nonce)["text"])  # einmalig
        self.assertIn("Abgelehnt", self.runner.button(retry_nonce, "p", "5555555", "5555555", False)["text"])

    def test_retry_from_foreign_sender_rejected(self):
        self.failed_job()
        self.assertIn("Abgelehnt", self.click("p", sender="4444444")["text"])
        self.assertEqual(len([j for j in self.runner.status()["jobs"] if j["state"] == "prepared"]), 0)

    def test_resend_invalidates_old_buttons_and_only_for_operator(self):
        self.runner.prepare("WP-X")
        old = self.notifier.last_nonce()
        self.assertIn("Abgelehnt", self.runner.resend("123", "123", False)["text"])
        self.assertIn("1 Runner-Entwurf", self.runner.resend(OP, OP, False)["text"])
        self.assertIn("Abgelehnt", self.click("a", nonce=old)["text"])
        self.assertIn("freigegeben", self.click("a")["text"])
        self.assertIn("Keine Runner-Entwuerfe", self.runner.resend(OP, OP, False)["text"])

    def test_health_and_costs(self):
        self.failed_job()
        h = self.runner.health()
        self.assertEqual(h["dienst"], "laeuft")
        self.assertIn(h["proxy"], ("erreichbar", "NICHT erreichbar"))
        self.assertTrue(h["letzte_fehler"])
        c = self.runner.costs()
        self.assertEqual(c["je_paket"][0]["paket"], "WP-X")
        self.assertAlmostEqual(c["rest_pilotbudget_usd"], 10 - c["gesamt_usd"], places=3)

    def test_worker_survives_crashing_execute(self):
        job = self.approved_job()
        sent = []

        class Boom(FakeExecutor):
            def prepare_workspace(self, job, pkg):
                raise ValueError("kaputt token=geheim123456")
        self.runner.execute = lambda j, e: (_ for _ in ()).throw(ValueError("kaputt token=geheim123456"))
        stop = threading.Event()
        t = threading.Thread(target=runner_daemon.worker_loop, args=(self.runner, Boom(), stop), daemon=True)
        t.start()
        for _ in range(100):
            if self.runner._job(job)["state"] == "failed":
                break
            time.sleep(0.02)
        self.assertTrue(t.is_alive())                                              # Worker lebt weiter
        stop.set()
        row = self.runner._job(job)
        self.assertEqual(row["state"], "failed")
        self.assertNotIn("geheim123456", row["error"])
        self.assertIn("interner Fehler", self.notifier.messages[-1])


class SlowCodex(FakeCodex):
    def __init__(self):
        super().__init__([pkg("Demo")])
        self.release = threading.Event()
        self.cancelled = False

    def plan(self, prompt):
        self.release.wait(5)
        if self.cancelled:
            raise RuntimeError("abgebrochen")
        return super().plan(prompt)

    def cancel(self):
        self.cancelled = True
        self.release.set()
        return True


class PlannerControlTests(PlannerBase):
    def test_request_returns_immediately_and_cancel_works(self):
        self.planner.codex = SlowCodex()
        res = self.planner.request(count=1)
        self.assertIn("Angenommen", res["hinweis"])
        self.assertIsNotNone(self.planner.health()["laufende_planung"])
        c = self.planner.cancel()
        self.assertTrue(c["abgebrochen"])
        for _ in range(200):
            if self.planner.busy.acquire(blocking=False):
                self.planner.busy.release()
                break
            time.sleep(0.01)
        self.assertEqual(self.planner.list()["anfragen"][0]["state"], "cancelled")
        self.assertIn("abgebrochen", self.sent[-1][0])
        self.assertEqual(self.planner.list()["entwuerfe"], [])
        self.assertFalse(self.planner.cancel()["abgebrochen"])

    def test_failure_reason_is_detailed_and_redacted(self):
        class Failing(FakeCodex):
            def plan(self, prompt):
                raise RuntimeError("Codex-Lauf endete mit Exit 1: auth failed for hans@example.com token=abcdef123456")
        self.planner.codex = Failing([])
        self.run_request(count=1)
        msg = self.sent[-1][0]
        self.assertIn("auth failed", msg)
        self.assertNotIn("hans@example.com", msg)
        self.assertNotIn("abcdef123456", msg)
        self.assertIn("auth failed", self.planner.health()["letzte_fehler"][0]["grund"])

    def test_restart_marks_hanging_request_interrupted(self):
        self.planner.store.q("INSERT INTO plan_requests(ts, kind, count, state) VALUES (1, 'new', 2, 'running')")
        from planner_core import Planner
        p2 = Planner(self.cfg, self.notifier, self.codex, Gate(), self.clock)
        self.assertEqual(p2.list()["anfragen"][0]["state"], "interrupted")
        self.planner.request(count=1)                                              # neue Anfrage moeglich

    def test_resend_drafts(self):
        self.run_request(count=2)
        before = len(self.sent)
        old = self.nonce_of(0)
        self.assertIn("Abgelehnt", self.planner.resend("1", "1", False)["text"])
        self.assertIn("2 Codex-Entwurf", self.planner.resend(OP, OP, False)["text"])
        self.assertEqual(len(self.sent), before + 3)                               # 2 Einzel + Sammelfreigabe
        self.assertIn("Abgelehnt", self.planner.button(old, "a", OP, OP, False)["text"])


if __name__ == "__main__":
    unittest.main()
