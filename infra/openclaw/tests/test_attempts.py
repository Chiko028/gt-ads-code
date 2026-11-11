"""Korrekturschleife (Betreiber 2026-11-11): 10 Versuche / 60 min zentral, Protokoll je Versuch, Ursachenanalyse bei unveraendertem Fehler,
Stopp bei wirkungslosen Versuchen, Testabschwaechung, Sicherheitsverstoss, gescheitertem Agenten-Aufruf und erschoepftem Guthaben."""

import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "runner"))
import executors  # noqa: E402
from runner_core import DEFAULT_LIMITS, error_signature  # noqa: E402
from tests.test_plans import PlanBase, PlanExec  # noqa: E402
from tests.test_runner import Base, FakeExecutor  # noqa: E402


class ScriptedExec(FakeExecutor):
    """Ausfuehrer mit geskripteten Testausgaben, Fingerabdruecken, Integritaet und Agenten-Fehlern."""

    def __init__(self, outputs=("1 failed: expected 5",), changes=True, weaken_at=None, fatal_at=None, agent_error=None):
        super().__init__(passes=(False,))
        self.outputs, self.changes, self.weaken_at, self.fatal_at, self.agent_error = list(outputs), changes, weaken_at, fatal_at, agent_error
        self.prompt_flags, self.fp, self.runs = [], 0, 0

    def build_prompt(self, job, pkg, correction, analyse=False, attempt=None, limit=None):
        self.prompt_flags.append((correction is not None, analyse, attempt, limit))
        return "p"

    def agent_turn(self, job, prompt, timeout_s):
        self.turns += 1
        if self.changes:
            self.fp += 1
        if self.agent_error:
            return {"input_tokens": 5, "output_tokens": 5, "exit_code": 1, "error": self.agent_error}
        return {"input_tokens": 5, "output_tokens": 5, "exit_code": 0, "text": "ok"}

    def fingerprint(self):
        return self.fp

    def test_baseline(self):
        return {"files": set(), "skips": 0}

    def test_integrity(self, baseline):
        return "Testdateien entfernt: a.test.ts" if self.weaken_at is not None and self.turns >= self.weaken_at else ""

    def run_tests(self, job, timeout_s):
        self.runs += 1
        if self.fatal_at is not None and self.runs >= self.fatal_at:
            return {"passed": False, "output": "x", "fatal": "Paketpruefung: left-pad"}
        out = self.outputs[min(self.runs - 1, len(self.outputs) - 1)]
        return {"passed": out == "PASS", "output": out}


class LimitTests(Base):
    def test_central_defaults_are_10_attempts_and_60_minutes(self):
        self.assertEqual(DEFAULT_LIMITS, {"max_attempts": 10, "timeout_s": 3600})
        del self.cfg["packages"]["WP-X"]["max_attempts"]
        del self.cfg["packages"]["WP-X"]["timeout_s"]
        job = self.approved_job()
        pkg = self.runner.effective_package(self.runner._job(job))
        self.assertEqual((pkg["max_attempts"], pkg["timeout_s"]), (10, 3600))
        self.cfg["defaults"] = {"max_attempts": 7}
        self.assertEqual(self.runner.effective_package(self.runner._job(job))["max_attempts"], 7)  # zentral konfigurierbar

    def test_ten_attempts_then_blocked_and_every_attempt_logged(self):
        del self.cfg["packages"]["WP-X"]["max_attempts"]
        self.cfg["packages"]["WP-X"]["max_tokens"] = 10 ** 6
        job = self.approved_job()
        ex = ScriptedExec(outputs=["fehler %d" % i for i in range(20)])  # jedes Mal ein ANDERER Fehler (Fortschritt)
        report = self.runner.execute(self.runner.claim_next(), ex)
        self.assertEqual(report["ergebnis"], "blocked")
        self.assertEqual(ex.turns, 11)                                   # erster Versuch + 10 Korrekturen
        attempts = self.runner.attempts_of(job)
        self.assertEqual(len([a for a in attempts if a["phase"] == "tests"]), 11)
        self.assertTrue(all(a["signature"] for a in attempts))
        self.assertEqual(ex.prompt_flags[1][2:], (1, 10))                 # Agent erfaehrt Versuch n von 10

    def test_sixty_minute_total_limit(self):
        del self.cfg["packages"]["WP-X"]["timeout_s"]
        self.cfg["packages"]["WP-X"]["max_tokens"] = 10 ** 6
        self.approved_job()
        ex = ScriptedExec(outputs=["a", "b", "c"])
        orig = ex.agent_turn

        def slow(job, prompt, timeout_s):
            self.clock.now += 1500                                        # 25 min je Zug
            return orig(job, prompt, timeout_s)
        ex.agent_turn = slow
        report = self.runner.execute(self.runner.claim_next(), ex)
        self.assertEqual(report["ergebnis"], "timeout")
        self.assertEqual(ex.turns, 3)                                     # 0, 25, 50 min gestartet; danach > 60 min


class LoopGuardTests(Base):
    def run_job(self, ex):
        self.cfg["packages"]["WP-X"]["max_tokens"] = 10 ** 6
        self.cfg["packages"]["WP-X"]["max_attempts"] = 10
        self.approved_job()
        return self.runner.execute(self.runner.claim_next(), ex)

    def test_same_error_twice_triggers_root_cause_analysis(self):
        ex = ScriptedExec(outputs=["Expected 5, got 4 (12ms)", "Expected 5, got 4 (15ms)", "Expected 5, got 4 (9ms)", "PASS"])
        report = self.run_job(ex)
        self.assertEqual(report["ergebnis"], "succeeded")
        flags = [f[1] for f in ex.prompt_flags[1:]]
        self.assertEqual(flags[:2], [False, True])                       # 2. gleicher Fehler -> Analyse verlangt
        self.assertEqual(error_signature("Expected 5, got 4 (12ms)"), error_signature("Expected 5, got 4 (99ms)"))

    def test_two_ineffective_attempts_block(self):
        report = self.run_job(ScriptedExec(changes=False))
        self.assertEqual(report["ergebnis"], "blocked")
        self.assertIn("wirkungslose", report["fehler"])

    def test_weakened_tests_stop_immediately(self):
        ex = ScriptedExec(weaken_at=2)
        report = self.run_job(ex)
        self.assertEqual(report["ergebnis"], "blocked")
        self.assertIn("Tests abgeschwaecht", report["fehler"])
        self.assertEqual(ex.turns, 2)

    def test_security_violation_stops_immediately(self):
        ex = ScriptedExec(fatal_at=1)
        report = self.run_job(ex)
        self.assertEqual((report["ergebnis"], ex.turns), ("blocked", 1))
        self.assertIn("Sicherheitsregel", report["fehler"])

    def test_failed_agent_call_stops_without_tests_and_reports_reason(self):
        ex = ScriptedExec(agent_error="Unknown model: deepseek/deepseek-flash")
        report = self.run_job(ex)
        self.assertEqual((report["ergebnis"], ex.turns, ex.runs), ("failed", 1, 0))
        self.assertIn("Unknown model", report["fehler"])
        self.assertIn("Agent-Aufruf fehlgeschlagen", self.notifier.messages[-1])


class BalanceTests(PlanBase):
    def test_exhausted_prepaid_stops_the_whole_plan(self):
        parent, _ = self.approve_plan()
        ex = ScriptedExec(agent_error="402 Insufficient Balance")
        ex.accept = lambda job: True
        row = self.runner.claim_next()
        report = self.runner.execute(row, ex)
        self.assertEqual(report["ergebnis"], "budget")
        self.assertIn("Prepaid", report["fehler"])
        states = {k["unit_id"]: k["state"] for k in self.runner._plan_children(parent)}
        self.assertTrue(all(st in ("budget", "blocked") for st in states.values()), states)
        self.assertIsNone(self.runner.claim_next())


class RealExecutorChecksTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.ex = executors.PodmanOpenClawExecutor({"workspace_dir": self.tmp}, {})
        os.makedirs(os.path.join(self.tmp, "apps/api/src"))
        os.makedirs(os.path.join(self.tmp, "node_modules/x"))
        self.write("apps/api/src/a.test.ts", "it('x', () => {});\n")
        self.write("apps/api/src/a.ts", "export const a = 1;\n")
        self.write("node_modules/x/index.js", "1")

    def write(self, rel, text):
        with open(os.path.join(self.tmp, rel), "w") as handle:
            handle.write(text)

    def test_fingerprint_ignores_node_modules_and_sees_code_changes(self):
        fp = self.ex.fingerprint()
        self.write("node_modules/x/index.js", "2")
        self.assertEqual(fp, self.ex.fingerprint())
        self.write("apps/api/src/a.ts", "export const a = 2;\n")
        self.assertNotEqual(fp, self.ex.fingerprint())

    def test_integrity_detects_deleted_and_skipped_tests(self):
        base = self.ex.test_baseline()
        self.assertEqual(self.ex.test_integrity(base), "")
        self.write("apps/api/src/a.test.ts", "it.skip('x', () => {});\n")
        self.assertIn("skip", self.ex.test_integrity(base))
        os.remove(os.path.join(self.tmp, "apps/api/src/a.test.ts"))
        self.assertIn("a.test.ts", self.ex.test_integrity(base))
        self.write("test_x.py", "import pytest\n@pytest.mark.skip\ndef test_a(): pass\n")
        self.assertIn("skip", self.ex.test_integrity({"files": {"test_x.py"}, "skips": 0}))

    def test_agent_error_message_is_extracted(self):
        ex = executors.PodmanOpenClawExecutor({"workspace_dir": self.tmp, "openclaw_node": "n", "openclaw_js": "j"}, {})
        ex._run = lambda args, timeout: (1, "log\n" + json.dumps({"ok": False, "error": {"type": "cli_error", "message": "Sandbox image not found"}}))
        turn = ex.agent_turn({"id": 1}, "p", 60)
        self.assertEqual(turn["exit_code"], 1)
        self.assertEqual(turn["error"], "Sandbox image not found")


if __name__ == "__main__":
    unittest.main()


class EmptySuiteTests(Base):
    """WP-009 Lauf 3 (Betreiber 2026-11-11): leere Testsuite darf nie als bestanden gelten."""

    def test_empty_suite_patterns(self):
        from runner_core import empty_suite
        for out in ("no tests ran in 0.01s", "collected 0 items\n", "# tests 0\n# pass 0", "Tests:       0 total", "No test files found, exiting with code 1"):
            self.assertTrue(empty_suite(out), out)
        for out in ("3 passed in 0.1s", "# tests 12\n# pass 12", ""):
            self.assertFalse(empty_suite(out), out)

    def test_empty_suite_is_not_success_and_agent_gets_clear_hint(self):
        self.cfg["packages"]["WP-X"]["max_attempts"] = 1
        self.approved_job()

        class EmptyPass(ScriptedExec):
            def run_tests(self, job, timeout_s):  # Testbefehl meldet Exit 0, aber es lief kein Test
                self.runs += 1
                return {"passed": True, "output": "no tests ran in 0.01s"}

        ex = EmptyPass()
        report = self.runner.execute(self.runner.claim_next(), ex)
        self.assertNotEqual(report["ergebnis"], "done")
        self.assertEqual(ex.prompt_flags[1][0], True)  # Korrekturrunde mit Hinweis statt Erfolg
