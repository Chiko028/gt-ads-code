"""Tests fuer Plaene (Pakete mit Unteraufgaben): Reihenfolge, Abhaengigkeiten, Blockierung, Limits, Wiederanlauf."""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "runner"))
from runner_core import Runner, RunnerError, Store  # noqa: E402
from tests.test_runner import Base, FakeExecutor  # noqa: E402


class PlanExec(FakeExecutor):
    """Ausfuehrer, der je Einheit Erfolg/Misserfolg und die Uebernahme steuern kann."""

    def __init__(self, fail_units=(), reject_units=(), usage=(10, 10)):
        super().__init__(usage=usage)
        self.fail_units, self.reject_units = set(fail_units), set(reject_units)
        self.order, self.accepted, self.prompts_for = [], [], {}
        self.current = None

    def prepare_workspace(self, job, pkg):
        self.current = job["unit_id"]
        self.order.append(job["unit_id"])
        self.prompts_for[job["unit_id"]] = pkg["task_file"]
        self.limits = {k: pkg[k] for k in ("timeout_s", "max_attempts", "max_tokens")}

    def run_tests(self, job, timeout_s):
        ok = job["unit_id"] not in self.fail_units
        return {"passed": ok, "output": "" if ok else "1 failed"}

    def accept(self, job):
        if job["unit_id"] in self.reject_units:
            return False
        self.accepted.append(job["unit_id"])
        return True


class PlanBase(Base):
    UNITS = [{"id": "U0", "prompt_file": "WP-X/U0.md"},
             {"id": "U1", "prompt_file": "WP-X/U1.md", "depends": ["U0"], "max_tokens": 777},
             {"id": "U2", "prompt_file": "WP-X/U2.md", "depends": ["U0"]},
             {"id": "U3", "prompt_file": "WP-X/U3.md", "depends": ["U1", "U2"]},
             {"id": "U4", "prompt_file": "WP-X/U4.md"}]

    def setUp(self):
        super().setUp()
        for unit in self.UNITS:
            with open(os.path.join(self.tmp, "specs", "WP-X", unit["id"] + ".md"), "w") as handle:
                handle.write("Aufgabe " + unit["id"])
        self.cfg["packages"]["PLAN"] = {"enabled": True, "spec_files": ["WP-X/AUFTRAG.md", "WP-X/U0.md"], "task_file": "WP-X/AUFTRAG.md", "budget_usd": 2,
                                        "timeout_s": 1800, "max_attempts": 3, "max_tokens": 1000, "units": self.UNITS, "plan_max_tokens": 100000}
        self.ex = PlanExec()

    def approve_plan(self):
        job = self.runner.prepare("PLAN")["job_id"]
        self.click("a")
        res = {"state": self.runner._job(job)["state"], "einheiten": [c["unit_id"] for c in self.runner._plan_children(job)]}
        return job, res

    def run_all(self, ex=None, limit=20):
        ex = ex or self.ex
        n = 0
        while n < limit:
            row = self.runner.claim_next()
            if row is None:
                break
            ex.stop_check = lambda: False
            self.runner.execute(row, ex)
            n += 1
        return n

    def states(self, parent):
        return {k["unit_id"]: k["state"] for k in self.runner._plan_children(parent)}


class PlanFlowTests(PlanBase):
    def test_approval_expands_units_and_blocks_a_second_plan(self):
        parent, res = self.approve_plan()
        self.assertEqual(res["state"], "plan")
        self.assertEqual(res["einheiten"], ["U0", "U1", "U2", "U3", "U4"])
        self.assertEqual(self.states(parent), {u["id"]: "approved" for u in self.UNITS})
        with self.assertRaises(RunnerError):
            self.runner.prepare("PLAN")
        with self.assertRaises(RunnerError):
            self.runner.prepare("WP-X")

    def test_units_run_one_at_a_time_in_dependency_order(self):
        parent, _ = self.approve_plan()
        first = self.runner.claim_next()
        self.assertEqual(first["unit_id"], "U0")
        self.assertIsNone(self.runner.claim_next())          # nie zwei gleichzeitig
        self.ex.stop_check = lambda: False
        self.runner.execute(first, self.ex)
        self.run_all()
        order = self.ex.order
        self.assertEqual(order[0], "U0")
        self.assertLess(order.index("U0"), order.index("U1"))
        self.assertLess(order.index("U0"), order.index("U2"))
        self.assertLess(max(order.index("U1"), order.index("U2")), order.index("U3"))
        self.assertEqual(sorted(order), ["U0", "U1", "U2", "U3", "U4"])
        self.assertEqual(self.runner._job(parent)["state"], "succeeded")
        self.assertEqual(sorted(self.ex.accepted), ["U0", "U1", "U2", "U3", "U4"])

    def test_failure_blocks_only_dependents_independent_units_continue(self):
        parent, _ = self.approve_plan()
        self.run_all(PlanExec(fail_units={"U1"}))
        st = self.states(parent)
        self.assertEqual((st["U0"], st["U1"], st["U2"], st["U3"], st["U4"]), ("succeeded", "blocked", "succeeded", "blocked", "succeeded"))
        job = self.runner._job(parent)
        self.assertEqual(job["state"], "failed")
        self.assertIn("blockiert", self.runner._job(self.runner._plan_children(parent)[3]["id"])["error"])
        self.assertIn("ABGESCHLOSSEN MIT FEHLERN", self.notifier.messages[-1])
        self.assertIn("U3: blocked", self.notifier.messages[-1])

    def test_root_failure_blocks_all_dependents_but_not_independent(self):
        parent, _ = self.approve_plan()
        self.run_all(PlanExec(fail_units={"U0"}))
        st = self.states(parent)
        self.assertEqual((st["U1"], st["U2"], st["U3"], st["U4"]), ("blocked", "blocked", "blocked", "succeeded"))

    def test_rejected_integration_counts_as_failure(self):
        parent, _ = self.approve_plan()
        self.run_all(PlanExec(reject_units={"U0"}))
        st = self.states(parent)
        self.assertEqual(st["U0"], "failed")
        self.assertEqual(st["U1"], "blocked")

    def test_failed_tests_are_never_accepted_into_integration(self):
        parent, _ = self.approve_plan()
        ex = PlanExec(fail_units={"U2"})
        self.run_all(ex)
        self.assertNotIn("U2", ex.accepted)
        self.assertNotIn("U3", ex.accepted)

    def test_unit_limits_and_prompt_file_are_applied(self):
        parent, _ = self.approve_plan()
        self.run_all()
        self.assertEqual(self.ex.prompts_for["U1"], "WP-X/U1.md")
        pkg = self.runner.effective_package(self.runner._job(self.runner._plan_children(parent)[1]["id"]))
        self.assertEqual(pkg["max_tokens"], 777)               # Einheit ueberschreibt
        self.assertEqual(pkg["max_attempts"], 3)               # Rest vom Paket

    def test_plan_token_cap_stops_remaining_units(self):
        self.cfg["packages"]["PLAN"]["plan_max_tokens"] = 30
        parent, _ = self.approve_plan()
        self.run_all(PlanExec(usage=(10, 10)))
        st = self.states(parent)
        self.assertEqual(st["U0"], "succeeded")
        self.assertIn("budget", st.values())
        self.assertEqual(self.runner._job(parent)["state"], "failed")

    def test_restart_requeues_interrupted_unit_once_without_double_execution(self):
        parent, _ = self.approve_plan()
        first = self.runner.claim_next()                      # U0 laeuft
        again = Runner(Store(self.cfg["db_path"]), self.cfg, self.notifier, self.clock)
        again.recover_after_restart()
        rows = [k for k in again._plan_children(parent, latest=False) if k["unit_id"] == "U0"]
        self.assertEqual([r["state"] for r in rows], ["interrupted", "approved"])   # alter Lauf beendet, EIN frischer Neuanlauf
        ex = PlanExec()
        while True:
            row = again.claim_next()
            if row is None:
                break
            ex.stop_check = lambda: False
            again.execute(row, ex)
        self.assertEqual(ex.order.count("U0"), 1)            # U0 lief nach dem Neustart genau einmal
        self.assertEqual(again._job(parent)["state"], "succeeded")
        self.assertNotEqual(first["id"], [r for r in again._plan_children(parent, latest=False) if r["unit_id"] == "U0"][-1]["id"])

    def test_second_interruption_of_same_unit_is_not_requeued(self):
        parent, _ = self.approve_plan()
        self.runner.claim_next()
        r2 = Runner(Store(self.cfg["db_path"]), self.cfg, self.notifier, self.clock)
        r2.recover_after_restart()
        first = r2.claim_next()                               # zuerst die unabhaengige Einheit U4 ...
        self.assertEqual(first["unit_id"], "U4")
        ex = PlanExec()
        ex.stop_check = lambda: False
        r2.execute(first, ex)
        self.assertEqual(r2.claim_next()["unit_id"], "U0")   # ... dann der Neuanlauf von U0, der jetzt laeuft ...
        r3 = Runner(Store(self.cfg["db_path"]), self.cfg, self.notifier, self.clock)
        r3.recover_after_restart()                            # ... und wird erneut unterbrochen
        rows = [k["state"] for k in r3._plan_children(parent, latest=False) if k["unit_id"] == "U0"]
        self.assertEqual(rows, ["interrupted", "interrupted"])  # kein zweiter automatischer Neuanlauf
        self.assertIsNone(r3.claim_next())                    # alles Abhaengige blockiert, U4 war fertig; nichts startet doppelt
        self.assertEqual(r3._job(parent)["state"], "failed")

    def test_stop_cancels_waiting_units_and_requests_stop_of_running_one(self):
        parent, _ = self.approve_plan()
        running = self.runner.claim_next()
        self.runner.stop()
        st = self.states(parent)
        self.assertEqual(st["U0"], "running")
        self.assertTrue(self.runner.stop_requested(running["id"]))
        self.assertEqual(st["U1"], "stopped")
        ex = PlanExec()
        ex.stop_check = lambda: self.runner.stop_requested(running["id"])
        self.runner.execute(running, ex)
        self.assertIn(self.runner._job(parent)["state"], ("failed", "stopped"))
        self.assertIsNone(self.runner.claim_next())

    def test_status_shows_plan_progress(self):
        parent, _ = self.approve_plan()
        self.run_all(PlanExec(fail_units={"U1"}))
        plan = self.runner.status()["plan"]
        self.assertEqual((plan["plan_id"], plan["paket"]), (parent, "PLAN"))
        self.assertEqual(plan["einheiten"]["U3"], "blocked")
        self.assertGreater(plan["tokens"], 0)

    def test_unit_reports_name_the_unit(self):
        self.approve_plan()
        self.run_all()
        self.assertTrue(any("Einheit U0" in m for m in self.notifier.messages))
        self.assertIn("ALLE Einheiten erfolgreich", self.notifier.messages[-1])


class PlanValidationTests(PlanBase):
    def test_invalid_plans_are_rejected_at_prepare(self):
        bad_plans = {
            "doppelt": [{"id": "A", "prompt_file": "x"}, {"id": "A", "prompt_file": "y"}],
            "zyklus/vorwaerts": [{"id": "A", "prompt_file": "x", "depends": ["B"]}, {"id": "B", "prompt_file": "y"}],
            "unbekannt": [{"id": "A", "prompt_file": "x", "depends": ["Z"]}],
            "ohne datei": [{"id": "A"}],
            "ohne id": [{"prompt_file": "x"}],
        }
        for name, units in bad_plans.items():
            self.cfg["packages"]["PLAN"]["units"] = units
            with self.assertRaises(RunnerError, msg=name):
                self.runner.prepare("PLAN")

    def test_plan_is_part_of_the_approval_hash(self):
        before = self.runner.spec_hash("PLAN")
        self.cfg["packages"]["PLAN"]["units"][3]["depends"] = ["U1"]
        self.assertNotEqual(before, self.runner.spec_hash("PLAN"))
        before = self.runner.spec_hash("PLAN")
        self.cfg["packages"]["PLAN"]["plan_max_tokens"] = 99
        self.assertNotEqual(before, self.runner.spec_hash("PLAN"))

    def test_changed_plan_invalidates_pending_approval(self):
        job = self.runner.prepare("PLAN")["job_id"]
        self.cfg["packages"]["PLAN"]["units"][4]["prompt_file"] = "WP-X/U1.md"
        self.assertIn("Abgelehnt", self.click("a")["text"])
        self.assertEqual(self.runner._plan_children(job), [])

    def test_foreign_click_never_creates_units(self):
        job = self.runner.prepare("PLAN")["job_id"]
        self.assertIn("Abgelehnt", self.click("a", sender="42")["text"])
        self.assertEqual(self.runner._plan_children(job), [])


if __name__ == "__main__":
    unittest.main()
