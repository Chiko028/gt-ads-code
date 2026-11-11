"""Codex als Arbeitspaket-Architekt + Freigabebereich (Betreiber 2026-11-11). Synthetische Inhalte, Codex/Telegram gefaelscht."""

import json
import os
import shutil
import stat
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "runner"))
from planner_core import Planner, PlannerError, extract_json, is_sensitive, validate_package  # noqa: E402
from runner_core import Runner, RunnerError, Store  # noqa: E402
from tests.test_runner import OP, Clock, FakeExecutor, FakeNotifier  # noqa: E402

SECRET_TASK = "SYNTHETISCH-GEHEIMER-AUFTRAGSTEXT-4711"


def pkg(title, paths=("apps/api/src/demo/",), deps=(), sensitive=False, extra=None):
    d = {"titel": title, "ziel": "Synthetisches Ziel " + title, "abhaengigkeiten": list(deps), "erlaubte_pfade": list(paths),
         "tests": ["demo liefert 42"], "deepseek_auftrag": SECRET_TASK + " " + title, "risiken": "keine", "widersprueche": [], "sensibel": sensitive}
    d.update(extra or {})
    return d


class FakeCodex:
    def __init__(self, packages):
        self.packages, self.prompts = packages, []

    def plan(self, prompt):
        self.prompts.append(prompt)
        return "Hier ist der Plan:\n```json\n" + json.dumps({"pakete": self.packages}) + "\n```"


class Gate:
    def __init__(self, allowed=True):
        self.allowed = allowed

    def check(self):
        return {"allowed": self.allowed, "reason": "test" if self.allowed else "5-Stunden-Fenster: 85 % belegt"}

    def record_cost(self, *a):
        pass


class PlannerBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.plan_dir = os.path.join(self.tmp, "plan")
        self.release = os.path.join(self.tmp, "release")
        os.makedirs(self.plan_dir, mode=0o700)
        os.makedirs(self.release, mode=0o755)
        self.clock, self.notifier = Clock(), FakeNotifier()
        self.cfg = {"db_path": os.path.join(self.plan_dir, "p.sqlite"), "operator_chat_id": OP, "release_dir": self.release}
        self.codex = FakeCodex([pkg("Demo A"), pkg("Demo B", deps=["CX-001"])])
        self.planner = Planner(self.cfg, self.notifier, self.codex, Gate(), self.clock)
        self.sent = []
        orig = self.notifier.send_operator

        def capture(text, buttons=None):
            orig(text, buttons)
            self.sent.append((text, buttons))
        self.notifier.send_operator = capture

    def run_request(self, **kw):
        self.planner.request(**kw)
        for _ in range(200):
            if self.planner.busy.acquire(blocking=False):
                self.planner.busy.release()
                return
            time.sleep(0.01)
        self.fail("Planer-Thread endet nicht")

    def nonce_of(self, idx, ns="gtp"):
        b = self.sent[idx][1]
        self.assertTrue(b[0][0]["callback_data"].startswith(ns + ":"))
        return b[0][0]["callback_data"].split(":", 2)[2]

    def press(self, idx, action="a", sender=OP, chat=OP, group=False):
        return self.planner.button(self.nonce_of(idx), action, sender, chat, group)["text"]


class DraftTests(PlannerBase):
    def test_codex_drafts_go_to_operator_with_buttons_not_released(self):
        self.run_request(count=2)
        self.assertEqual([d["id"] for d in self.planner.list()["entwuerfe"]], ["CX-001", "CX-002"])
        self.assertEqual(len(self.sent), 3)                                      # 2 Einzel + 1 Sammelfreigabe
        self.assertEqual([b["text"] for b in self.sent[0][1][0]], ["Freigeben", "Ablehnen", "Details"])
        self.assertIn("Alle 2 freigeben", self.sent[2][1][0][0]["text"])
        self.assertEqual(os.listdir(self.release), [])                          # nichts freigegeben ohne Klick

    def test_status_agent_sees_metadata_only(self):
        self.run_request(count=2)
        self.assertNotIn(SECRET_TASK, json.dumps(self.planner.list()))
        for text, _ in self.sent:                                                # auch die Telegram-Kurzfassung enthaelt den Auftrag nicht
            self.assertNotIn(SECRET_TASK, text)

    def test_details_button_shows_full_draft_only_to_operator(self):
        self.run_request(count=1)
        self.assertIn(SECRET_TASK, self.press(0, "d"))
        self.assertIn("Abgelehnt", self.press(0, "d", sender="5555555"))

    def test_codex_cannot_self_approve(self):
        self.codex.packages = [pkg("Selbst", extra={"freigegeben": True, "approved": True, "state": "approved", "hash": "x"})]
        self.run_request(count=1)
        self.assertEqual(os.listdir(self.release), [])
        self.assertEqual(self.planner.list()["entwuerfe"][0]["status"], "wartet auf Freigabe")
        content = json.loads(self.planner.current("CX-001")["content"])
        self.assertNotIn("approved", content)
        self.assertNotIn("freigegeben", content)

    def test_quota_gate_blocks_codex(self):
        self.planner.gate = Gate(False)
        self.run_request(count=3)                                               # Antwort sofort; Messung im Hintergrund
        self.assertEqual(self.codex.prompts, [])
        self.assertIn("85 %", self.sent[-1][0])
        self.assertEqual(self.planner.list()["anfragen"][0]["state"], "failed")
        self.planner.gate = None
        with self.assertRaises(PlannerError):
            self.planner.request(count=3)

    def test_count_limits_and_invalid_output(self):
        for n in (0, 6, -1):
            with self.assertRaises(PlannerError):
                self.planner.request(count=n)
        self.codex.packages = [{"titel": "ohne Pfade", "ziel": "z", "deepseek_auftrag": "x", "erlaubte_pfade": ["../etc"]}]
        self.run_request(count=1)
        self.assertEqual(self.planner.list()["entwuerfe"], [])
        self.assertIn("fehlgeschlagen", self.sent[-1][0])

    def test_sensitivity_is_deterministic(self):
        self.assertTrue(is_sensitive(validate_package(pkg("x", paths=["infra/openclaw/"]))))
        self.assertTrue(is_sensitive(validate_package(pkg("Produktiv-Deployment"))))
        self.assertTrue(is_sensitive(validate_package(pkg("x", sensitive=True))))
        self.assertTrue(is_sensitive(validate_package(pkg("x", paths=[".github/workflows/"]))))
        self.assertFalse(is_sensitive(validate_package(pkg("Kampagnenliste"))))

    def test_extract_json_variants(self):
        self.assertEqual(extract_json('vorher {"pakete": [1]} nachher'), {"pakete": [1]})
        self.assertEqual(extract_json('```json\n[{"a": "}"}]\n```'), [{"a": "}"}])
        with self.assertRaises(PlannerError):
            extract_json("kein json")


class ReleaseTests(PlannerBase):
    def test_button_releases_exact_version_once(self):
        self.run_request(count=1)
        self.assertIn("Freigegeben", self.press(0))
        index = json.load(open(os.path.join(self.release, "index.json")))
        self.assertEqual(index["CX-001"]["version"], 1)
        rec = json.load(open(os.path.join(self.release, "CX-001", "v1.json")))
        self.assertEqual(rec["hash"], self.planner.current("CX-001")["hash"])
        self.assertEqual(rec["freigegeben_von"], OP)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.release, "CX-001", "v1.json")).st_mode), 0o644)
        self.assertIn("bereits verwendet", self.press(0))                       # Wiederholung

    def test_foreign_group_and_other_chat_rejected(self):
        self.run_request(count=1)
        for kw in ({"sender": "123456"}, {"group": True}, {"chat": "-1001"}):
            self.assertIn("Abgelehnt", self.press(0, **kw))
        self.assertEqual(os.listdir(self.release), [])

    def test_revision_invalidates_old_approval_and_reappears(self):
        self.run_request(count=1)
        old = len(self.sent) - 1
        self.codex.packages = [pkg("Demo A ueberarbeitet")]
        self.run_request(count=1, target="CX-001", revise_note="kleiner schneiden")
        self.assertIn("Abgelehnt", self.press(old))                             # alte Version nicht mehr freigebbar
        self.assertIn("CX-001 v2", self.sent[-1][0])                            # neue Version erscheint erneut zur Freigabe
        self.assertIn("Freigegeben", self.press(len(self.sent) - 1))
        self.assertEqual(json.load(open(os.path.join(self.release, "index.json")))["CX-001"]["version"], 2)

    def test_batch_approval(self):
        self.run_request(count=2)
        self.assertIn("CX-001 v1, CX-002 v1", self.press(2))
        self.assertEqual(sorted(json.load(open(os.path.join(self.release, "index.json")))), ["CX-001", "CX-002"])
        self.assertIn("Abgelehnt", self.press(0))                               # Einzelknopf danach ungueltig (Version nicht mehr offen)

    def test_sensitive_needs_root(self):
        self.codex.packages = [pkg("Infra", paths=["infra/openclaw/"]), pkg("Normal")]
        self.run_request(count=2)
        self.assertEqual(len(self.sent), 2)                                      # keine Sammelfreigabe mit sensiblem Paket
        self.assertIn("SENSIBEL", self.press(0))
        self.assertEqual(os.listdir(self.release), [])
        with self.assertRaises(PlannerError):
            self.planner.strong_confirm("CX-001", 994)
        self.planner.strong_confirm("CX-001", 0)
        self.assertEqual(json.load(open(os.path.join(self.release, "CX-001", "v1.json")))["freigegeben_von"], "root")

    def test_reject(self):
        self.run_request(count=1)
        self.assertIn("Abgelehnt: CX-001", self.press(0, "r"))
        self.assertEqual(self.planner.list()["entwuerfe"][0]["status"], "rejected")


class RunnerReleaseTests(PlannerBase):
    """Coding-Runner liest NUR den Freigabebereich (geprueft); DeepSeek bekommt nur freigegebene Auftraege."""

    def setUp(self):
        super().setUp()
        self.rnot = FakeNotifier()
        self.rcfg = {"db_path": os.path.join(self.tmp, "r.sqlite"), "specs_root": self.tmp, "operator_chat_id": OP, "pilot_budget_usd": 10,
                     "price_usd_per_million_tokens": {"input": 1.0, "output": 2.0}, "packages": {}, "release_dir": self.release,
                     "release_owner_uid": os.getuid()}
        self.runner = Runner(Store(self.rcfg["db_path"]), self.rcfg, self.rnot, self.clock)
        os.chmod(self.release, 0o555)                                           # aus Sicht des Runners: nur lesbar
        self.addCleanup(os.chmod, self.release, 0o755)

    def approve_all(self, count=2):
        os.chmod(self.release, 0o755)
        self.run_request(count=count)
        self.press(len(self.sent) - 1)
        os.chmod(self.release, 0o555)

    def test_only_released_versions_start_and_prompt_has_only_released_text(self):
        self.codex.packages = [pkg("Demo A"), pkg("Demo B")]
        os.chmod(self.release, 0o755)
        self.run_request(count=2)
        self.press(0)                                                            # nur CX-001 freigegeben
        os.chmod(self.release, 0o555)
        res = self.runner.start_released()
        self.assertEqual([s["id"] for s in res["eingereiht"]], ["CX-001"])
        nope = self.runner.start_released(["CX-002"])                           # nicht freigegeben -> nie gestartet
        self.assertEqual(nope["eingereiht"], [])
        self.assertIn("nicht freigegeben", nope["uebersprungen"][0]["grund"])
        job = self.runner.claim_next()
        pkg_eff = self.runner.effective_package(job)
        self.assertIn("Demo A", pkg_eff["task_text"])
        self.assertNotIn("Demo B", pkg_eff["task_text"])
        self.assertEqual(self.runner.start_released(["CX-001"])["uebersprungen"][0]["grund"], "bereits beauftragt oder erledigt")

    def test_tampered_release_file_refused(self):
        self.approve_all(1)
        os.chmod(self.release, 0o755)
        path = os.path.join(self.release, "CX-001", "v1.json")
        rec = json.load(open(path))
        rec["paket"]["deepseek_auftrag"] = "manipuliert"
        os.chmod(path, 0o644)
        open(path, "w").write(json.dumps(rec))
        os.chmod(self.release, 0o555)
        res = self.runner.start_released()
        self.assertEqual(res["eingereiht"], [])
        self.assertIn("Hash", res["uebersprungen"][0]["grund"])

    def test_writable_release_dir_or_world_writable_file_refused(self):
        self.approve_all(1)
        os.chmod(self.release, 0o755)                                            # Runner duerfte schreiben -> Isolation verletzt
        with self.assertRaises(RunnerError):
            self.runner.start_released()
        os.chmod(self.release, 0o555)
        os.chmod(os.path.join(self.release, "index.json"), 0o666)
        with self.assertRaises(RunnerError):
            self.runner.start_released()

    def test_wrong_owner_refused(self):
        self.approve_all(1)
        self.rcfg["release_owner_uid"] = os.getuid() + 1
        with self.assertRaises(RunnerError):
            self.runner.start_released()

    def test_dependencies_run_in_order_and_failure_blocks(self):
        self.approve_all(2)                                                      # CX-002 haengt von CX-001 ab
        self.runner.start_released()
        first = self.runner.claim_next()
        self.assertEqual(first["wp_id"], "CX-001")
        self.assertIsNone(self.runner.claim_next())                              # einer gleichzeitig
        self.runner._finish(first["id"], "failed", error="test")
        self.assertIsNone(self.runner.claim_next())
        states = {j["wp_id"]: j["state"] for j in self.runner.status()["jobs"]}
        self.assertEqual(states["CX-002"], "blocked")

    def test_dependency_success_unlocks(self):
        self.approve_all(2)
        self.runner.start_released()
        first = self.runner.claim_next()
        self.runner._finish(first["id"], "succeeded")
        self.assertEqual(self.runner.claim_next()["wp_id"], "CX-002")

    def test_runner_code_never_references_planning_area(self):
        here = os.path.join(os.path.dirname(__file__), "..", "runner")
        for name in ("runner_core.py", "runner_daemon.py", "executors.py", "stack.py", "mcp_server.py"):
            text = open(os.path.join(here, name)).read()
            self.assertNotIn("gt-ads-plan", text, name)
            self.assertNotIn("planner.sqlite", text, name)
        cfg = json.load(open(os.path.join(here, "config", "runner.json")))
        self.assertNotIn("gt-ads-plan", json.dumps(cfg))


if __name__ == "__main__":
    unittest.main()


class FormatToleranceTests(unittest.TestCase):
    """Codex-Planung #4 (2026-11-11): 'Pflichtfeld titel fehlt' - Modelle liefern englische/abweichende Feldnamen."""

    def test_english_keys_and_wrapping(self):
        raw = {"paket": {"title": "Kampagnen", "goal": "Liste", "allowed_paths": ["apps/api/"], "task": "Baue X", "dependencies": [], "tests": ["a"],
                         "approved": True}}
        p = validate_package(raw)
        self.assertEqual((p["titel"], p["ziel"], p["deepseek_auftrag"], p["erlaubte_pfade"]), ("Kampagnen", "Liste", "Baue X", ["apps/api/"]))
        self.assertNotIn("approved", p)

    def test_missing_title_names_received_keys(self):
        with self.assertRaises(PlannerError) as ctx:
            validate_package({"foo": 1, "bar": "x", "ziel": "z"})
        self.assertIn("foo", str(ctx.exception))

    def test_prompt_contains_exact_example(self):
        from planner_core import Planner
        import tempfile
        d = tempfile.mkdtemp()
        pl = Planner({"db_path": os.path.join(d, "p.sqlite"), "operator_chat_id": OP, "release_dir": d}, None, None, None)
        prompt = pl.build_prompt(2, "", None, "")
        data = extract_json(prompt[prompt.index('{"pakete"'):])
        self.assertEqual(sorted(data["pakete"][0]), sorted(["titel", "ziel", "abhaengigkeiten", "erlaubte_pfade", "tests", "testbefehl",
                                                           "deepseek_auftrag", "risiken", "widersprueche", "sensibel"]))


class EnvelopeTests(unittest.TestCase):
    """Codex-Planung #6 (2026-11-11): 'Codex lieferte die Felder: mediaUrl, text' - Laufzeit-Huelle statt Paketen."""

    def envelope(self):
        inner = json.dumps({"pakete": [{"titel": "Demo", "ziel": "z", "erlaubte_pfade": ["apps/api/"], "deepseek_auftrag": "a"}]}, ensure_ascii=False)
        env = {"payloads": [{"text": "Hier der Plan:\n```json\n" + inner + "\n```", "mediaUrl": None}], "meta": {"durationMs": 1}}
        return "[proxy] routing process HTTP traffic through external proxy\n" + json.dumps(env) + "\n[state/agent-db] agent database clean-close receipt: written\n"

    def test_agent_text_unwraps_envelope_with_log_lines(self):
        from executors import agent_text
        txt = agent_text(self.envelope())
        self.assertTrue(txt.startswith("Hier der Plan"))

    def test_find_packages_never_takes_envelope(self):
        from planner_core import find_packages
        self.assertEqual(find_packages(self.envelope())[0]["titel"], "Demo")  # auch direkt aus der Rohausgabe
        with self.assertRaises(PlannerError):
            find_packages('[proxy] x\n{"payloads": [{"text": "kein json", "mediaUrl": null}]}')

    def test_deepseek_usage_parsed_despite_trailing_log(self):
        import executors
        out = json.dumps({"payloads": [{"text": "ok"}], "meta": {"agentMeta": {}}, "usage": {"input_tokens": 120, "output_tokens": 30}}) + "\n[state/agent-db] receipt: written\n"
        self.assertEqual(executors.first_json_object(out, executors._is_agent_envelope)["usage"]["input_tokens"], 120)


class DiagnoseTests(PlannerBase):
    def test_format_error_writes_structure_to_journal(self):
        import io
        import contextlib

        class Odd(FakeCodex):
            def plan(self, prompt):
                self.last_raw = '{"payloads": [{"text": "Hallo", "mediaUrl": null}], "meta": {"x": 1}}\\n[log] receipt'
                return "Hallo"
        self.planner.codex = Odd([])
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.run_request(count=1)
        out = err.getvalue()
        self.assertIn("Diagnose Planung", out)
        self.assertIn("payloads: [1 x {text: str(5), mediaUrl: NoneType}]", out)


class ContextTests(PlannerBase):
    def test_negated_deployment_in_goal_is_not_sensitive(self):
        self.assertFalse(is_sensitive(validate_package(pkg("API-Minimalserver", extra={"ziel": "Server startet lokal; kein Deployment"}))))
        self.assertTrue(is_sensitive(validate_package(pkg("Produktiv-Deployment vorbereiten"))))

    def test_planned_units_are_in_prompt(self):
        import io
        import tarfile as tf
        seed = os.path.join(self.tmp, "seed.tar")
        with tf.open(seed, "w") as tar:
            data = "# GT-ADS-001 · U8 – Dashboard (Auftrag)\\n...".encode()
            info = tf.TarInfo("docs/ARBEITSPAKETE/GT-ADS-001/runner/U8.md")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        self.planner.cfg["seed_tar"] = seed
        prompt = self.planner.build_prompt(2, "", None, "")
        self.assertIn("GT-ADS-001 U8: GT-ADS-001 · U8 – Dashboard", prompt)
        self.assertIn("NICHT erneut planen", prompt)
