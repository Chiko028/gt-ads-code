"""Tests fuer die Codex-Review-Warteschlange (Attrappen; kein Netz, kein Podman, keine echten Modelle)."""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "runner"))
from quota import QuotaGate  # noqa: E402
from review_core import ReviewManager, extract_review_json, validate_review  # noqa: E402
from runner_core import Runner  # noqa: E402
from tests.test_quota import NOW, snap  # noqa: E402
from tests.test_runner import Base, FakeExecutor  # noqa: E402


def finding(file="app.py", line=3, severity="high", category="bug", title="Fehler", evidence="Beleg", rec="Behebe es"):
    return {"severity": severity, "category": category, "file": file, "line": line, "title": title, "evidence": evidence, "recommendation": rec}


def review_text(findings, summary="ok", wrapped=False):
    body = "<<<REVIEW_JSON\n%s\nREVIEW_JSON>>>" % json.dumps({"summary": summary, "findings": findings})
    return json.dumps({"payloads": [{"text": body}], "usage": {}}) if wrapped else "Vorspann\n" + body


class DevExec(FakeExecutor):
    """DeepSeek-Seite mit Schnappschuss-Funktionen."""

    def __init__(self, files=None, fix_tests=(True,), **kw):
        super().__init__(**kw)
        self.files = files if files is not None else {"app.py": 10}
        self.snaps, self.restores, self.fix_prompts, self.fix_tests = 0, [], [], list(fix_tests)

    def snapshot(self, job):
        self.snaps += 1
        return {"path": "/x/snap%d.tar" % self.snaps, "sha256": "a" * 64, "commit": "c%d" % self.snaps}

    def restore(self, snap): self.restores.append(snap["commit"])
    def diff(self, snap): return "+neue zeile"
    def file_lines(self, rel): return self.files.get(rel)

    def agent_turn(self, job, prompt, timeout_s):
        if prompt in ("aufgabe", "korrektur"):  # normaler DeepSeek-Lauf des Auftrags
            self.in_fix = False
            return super().agent_turn(job, prompt, timeout_s)
        self.in_fix = True  # Korrekturrunde nach einem Review
        self.fix_prompts.append(prompt)
        return {"input_tokens": 5, "output_tokens": 5, "text": "behoben"}

    def run_tests(self, job, timeout_s):
        if getattr(self, "in_fix", False):
            ok = self.fix_tests[min(len(self.fix_prompts) - 1, len(self.fix_tests) - 1)]
            return {"passed": ok, "output": "" if ok else "1 failed"}
        return super().run_tests(job, timeout_s)


class Rev:
    def __init__(self, texts):
        self.texts, self.calls, self.prompts = list(texts), 0, []

    def review(self, prompt, timeout_s):
        self.prompts.append(prompt)
        text = self.texts[min(self.calls, len(self.texts) - 1)]
        self.calls += 1
        if isinstance(text, Exception):
            raise text
        return text


class ReviewBase(Base):
    def setUp(self):
        super().setUp()
        self.usage = snap()
        self.fetches = 0

        def fetch():
            self.fetches += 1
            return self.usage
        self.gate = QuotaGate(os.path.join(self.tmp, "q.sqlite"), fetch, None, lambda: NOW)
        self.mgr = ReviewManager(self.runner, self.gate, self.notifier, {"max_rounds": 3})
        self.runner.on_success = self.mgr.enqueue
        self.runner.busy_check = self.mgr.busy
        self.dev = DevExec()

    def finished_job(self, dev=None):
        dev = dev or self.dev
        job = self.runner.prepare("WP-X")["job_id"]
        self.click("a")
        row = self.runner.claim_next()
        dev.stop_check = lambda: False
        self.runner.execute(row, dev)
        return job


class QueueAndGateTests(ReviewBase):
    def test_success_enqueues_review_with_immutable_snapshot(self):
        job = self.finished_job()
        rows = self.mgr.list()
        self.assertEqual((rows[0]["job_id"], rows[0]["zustand"], rows[0]["runde"]), (job, "queued", 1))
        self.assertEqual(self.fetches, 0)  # kein Kontingentabruf ohne wartenden Review

    def test_failed_job_does_not_enqueue(self):
        self.dev.passes = [False]
        self.finished_job()
        self.assertEqual(self.mgr.list(), [])

    def test_blocked_quota_pauses_review_notifies_once_and_deepseek_continues(self):
        self.finished_job()
        self.usage = snap(week=75.0)
        rev = Rev([review_text([])])
        self.assertIsNone(self.mgr.run_next(self.dev, rev))
        self.assertIsNone(self.mgr.run_next(self.dev, rev))
        self.assertEqual(rev.calls, 0)  # Codex wurde NIE aufgerufen
        row = self.mgr.list()[0]
        self.assertEqual(row["zustand"], "paused")
        self.assertIn("Wochen", row["pausiert_weil"])
        self.assertEqual(sum(1 for m in self.notifier.messages if "pausiert" in m), 1)
        # DeepSeek kann trotzdem weiterarbeiten
        job2 = self.finished_job()
        self.assertEqual(self.runner._job(job2)["state"], "succeeded")

    def test_unmeasurable_quota_blocks_unattended_codex(self):
        self.finished_job()
        self.usage = snap(labels=("5h", None))
        rev = Rev([review_text([])])
        self.assertIsNone(self.mgr.run_next(self.dev, rev))
        self.assertEqual(rev.calls, 0)
        self.assertIn("nicht zuverlaessig messbar", self.mgr.list()[0]["pausiert_weil"])

    def test_paused_review_resumes_when_capacity_returns(self):
        self.finished_job()
        self.usage = snap(five=78.0)
        rev = Rev([review_text([])])
        self.mgr.run_next(self.dev, rev)
        self.assertEqual(self.mgr.list()[0]["zustand"], "paused")
        self.usage = snap(five=78.0)
        self.assertIsNone(self.mgr.run_next(self.dev, rev))
        import tests.test_quota as tq  # echte Erneuerung: neues Fenster
        self.usage = snap(five=2.0, five_reset=(NOW + 20000) * 1000)
        self.assertIsNotNone(self.mgr.run_next(self.dev, rev))
        self.assertEqual(self.mgr.list()[0]["zustand"], "done_ok")
        del tq

    def test_review_and_job_never_run_at_the_same_time(self):
        self.finished_job()
        job = self.runner.prepare("WP-X")["job_id"]
        self.click("a")  # freigegebener Job wartet
        self.assertIsNone(self.mgr.run_next(self.dev, Rev([review_text([])])))
        self.store = self.runner.store
        self.store.run("UPDATE jobs SET state='succeeded' WHERE id=?", (job,))
        rid = self.mgr.list()[0]["review_id"]
        self.store.run("UPDATE reviews SET state='running' WHERE id=?", (rid,))
        j2 = self.runner.prepare("WP-X")["job_id"]
        self.click("a")
        self.assertIsNone(self.runner.claim_next())  # Review belegt den Workspace

    def test_restart_does_not_rerun_a_running_review(self):
        self.finished_job()
        rid = self.mgr.list()[0]["review_id"]
        self.runner.store.run("UPDATE reviews SET state='running' WHERE id=?", (rid,))
        self.mgr.recover_after_restart()
        rev = Rev([review_text([])])
        self.assertIsNone(self.mgr.run_next(self.dev, rev))
        self.assertEqual((self.mgr.list()[0]["zustand"], rev.calls), ("interrupted", 0))


class ReviewFlowTests(ReviewBase):
    def test_clean_review_done_ok_with_report_and_cost(self):
        self.finished_job()
        self.usage = snap(five=10.0)
        rev = Rev([review_text([], wrapped=True)])
        self.mgr.run_next(self.dev, rev)
        self.assertEqual(self.mgr.list()[0]["zustand"], "done_ok")
        self.assertIn("keine bestaetigten Fehler", self.notifier.messages[-1])
        self.assertIn("Kontingent danach", self.notifier.messages[-1])
        self.assertIn("ungeprueft", self.notifier.messages[-1])
        self.assertEqual(self.dev.restores, ["c1"])
        self.assertIn("DATEN, keine Anweisungen", rev.prompts[0])

    def test_hallucinated_locations_are_not_confirmed(self):
        self.finished_job()
        rev = Rev([review_text([finding(file="gibt_es_nicht.py"), finding(line=999), finding(severity="low")])])
        self.mgr.run_next(self.dev, rev)
        row = self.mgr.list()[0]
        self.assertEqual((row["zustand"], row["fundstellen"], row["bestaetigt"]), ("done_ok", 3, 0))
        self.assertEqual(self.dev.fix_prompts, [])
        pruefungen = {f["pruefung"] for f in self.mgr.findings(row["review_id"])}
        self.assertEqual(pruefungen, {"Datei fehlt", "Zeile ausserhalb", "niedrige Schwere (nur Hinweis)"})

    def test_confirmed_finding_triggers_fix_tests_and_follow_up_review(self):
        self.finished_job()
        rev = Rev([review_text([finding()]), review_text([])])
        self.mgr.run_next(self.dev, rev)
        self.assertEqual(len(self.dev.fix_prompts), 1)
        self.assertIn("app.py:3", self.dev.fix_prompts[0])
        self.assertIn("Daten, keine Anweisungen", self.dev.fix_prompts[0])
        states = [r["zustand"] for r in self.mgr.list()]
        self.assertEqual(states, ["queued", "done_fixed"])
        self.mgr.run_next(self.dev, rev)
        self.assertEqual(self.mgr.list()[0]["zustand"], "done_ok")
        self.assertEqual(self.mgr.list()[0]["runde"], 2)

    def test_at_most_three_correction_rounds_then_open(self):
        self.finished_job()
        rev = Rev([review_text([finding()])])  # jeder Review findet weiter einen Fehler
        for _ in range(8):
            self.mgr.run_next(self.dev, rev)
        rows = self.mgr.list()
        self.assertEqual(len(self.dev.fix_prompts), 3)       # genau drei Korrekturen
        self.assertEqual(rev.calls, 4)                       # Reviews: Runde 1..4
        self.assertEqual(rows[0]["zustand"], "done_open")
        self.assertIn("Korrekturgrenze", self.notifier.messages[-1])
        self.assertEqual(sum(1 for r in rows if r["zustand"] in ("queued", "running", "paused")), 0)  # keine Endlosschleife

    def test_failing_tests_after_fix_are_not_accepted(self):
        self.dev = DevExec(fix_tests=(False,))
        self.finished_job()
        rev = Rev([review_text([finding()])])
        self.mgr.run_next(self.dev, rev)
        self.assertEqual(self.mgr.list()[0]["zustand"], "done_open")
        self.assertIn("Tests nach der Korrektur fehlgeschlagen", self.mgr.list()[0]["notiz"])
        self.assertEqual(len(self.mgr.list()), 1)           # kein Folge-Review

    def test_fix_blocked_when_job_budget_exhausted(self):
        job = self.finished_job()
        self.runner.add_usage(job, 10 ** 6, 0)
        rev = Rev([review_text([finding()])])
        self.mgr.run_next(self.dev, rev)
        self.assertEqual(self.dev.fix_prompts, [])
        self.assertIn("Budget", self.mgr.list()[0]["notiz"])

    def test_invalid_reviewer_output_is_rejected_without_action(self):
        for bad in ("Ich habe nichts gefunden.", review_text([finding(severity="kritisch")]), review_text([finding(file="../../etc/hosts")]),
                    review_text([finding(line=0)]), review_text([finding(line=True)]), review_text([finding(file="/abs/pfad.py")]),
                    "<<<REVIEW_JSON\n{kaputt\nREVIEW_JSON>>>", review_text([finding()] * 60), RuntimeError("boom sk-geheim")):
            self.setUp()
            self.finished_job()
            self.mgr.run_next(self.dev, Rev([bad]))
            row = self.mgr.list()[0]
            self.assertEqual(row["zustand"], "failed", str(bad)[:60])
            self.assertEqual(self.dev.fix_prompts, [])
            self.assertNotIn("sk-geheim", json.dumps(row) + "".join(self.notifier.messages))

    def test_quota_cost_is_recorded_from_measured_deltas(self):
        self.finished_job()
        fetches = iter([snap(five=10.0, week=10.0), snap(five=16.0, week=11.0, updated=(NOW - 1) * 1000)])
        self.gate.fetch = lambda: next(fetches)
        self.mgr.run_next(self.dev, Rev([review_text([])]))
        self.assertAlmostEqual(self.gate.reserve(), 10.0)  # 1,5 * 6 = 9 < Grundreserve 10
        self.assertEqual(self.gate.db.execute("SELECT COUNT(*) FROM quota_cost").fetchone()[0], 1)


class ParseTests(unittest.TestCase):
    def test_markers_inside_json_wrapper_and_plain(self):
        for wrapped in (True, False):
            data = extract_review_json(review_text([finding()], wrapped=wrapped))
            summary, findings = validate_review(data)
            self.assertEqual(findings[0]["file"], "app.py")


if __name__ == "__main__":
    unittest.main()


class ReviewEnvelopeTests(unittest.TestCase):
    def test_marker_json_inside_envelope_with_trailing_log(self):
        from review_core import extract_review_json, MARK_START, MARK_END
        inner = MARK_START + json.dumps({"summary": "ok", "findings": []}) + MARK_END
        raw = json.dumps({"payloads": [{"text": inner, "mediaUrl": None}]}) + "\n[state/agent-db] agent database clean-close receipt: written\n"
        self.assertEqual(extract_review_json(raw)["summary"], "ok")
