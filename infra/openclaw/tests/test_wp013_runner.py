"""WP-013: Plan GT-ADS-001 im Runner, Einheitenauftraege, Sandbox v2 des Coding-Agenten, StackExecutor-Verdrahtung."""

import json
import os
import re
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
REPO = os.path.abspath(os.path.join(ROOT, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "runner"))
import executors  # noqa: E402
from runner_core import Runner  # noqa: E402
from stack import path_violations  # noqa: E402

PROTECTED = ("docs/architektur/vertraege/", "docs/entscheidungen/", "docs/konzept/ANFORDERUNGEN.md", ".github/", "infra/server-setup/", "infra/openclaw/",
             "AGENTS.md", "CLAUDE.md")


def cfg():
    with open(os.path.join(ROOT, "runner", "config", "runner.json"), encoding="utf-8") as handle:
        return json.load(handle)


def read(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


class PlanConfigTests(unittest.TestCase):
    def setUp(self):
        self.c = cfg()
        self.pkg = self.c["packages"]["GT-ADS-001"]

    def test_plan_is_enabled_valid_and_sequential(self):
        self.assertTrue(self.pkg["enabled"])
        Runner._validate_plan(self.pkg)
        ids = [u["id"] for u in self.pkg["units"]]
        self.assertEqual(ids, ["U0", "U1", "U2", "U3", "U4", "U5", "U6", "U7", "U8", "U10"])  # U9 (Android) folgt mit der Toolchain
        for prev, unit in zip(self.pkg["units"], self.pkg["units"][1:]):
            self.assertEqual(unit["depends"], [prev["id"]])  # Reihenfolge laut Auftrag verbindlich
        self.assertFalse(self.pkg["synthetic"])               # GT-Ads-Code: nie an Gemini

    def test_limits_within_operator_bounds(self):
        for unit in self.pkg["units"]:
            self.assertLessEqual(unit.get("max_tokens", self.pkg["max_tokens"]), 1000000)
            self.assertNotIn("max_attempts", unit)
            self.assertNotIn("timeout_s", unit)
        self.assertEqual(self.c["defaults"], {"max_attempts": 10, "timeout_s": 3600})  # zentral: 10 Versuche, 60 min gesamt
        self.assertLessEqual(self.pkg["plan_max_tokens"], 6000000)
        self.assertLessEqual(self.pkg["budget_usd"], 2)
        self.assertLessEqual(self.c["pilot_budget_usd"], 10)
        price = self.c["price_usd_per_million_tokens"]
        self.assertGreater(price["input"], 0)
        self.assertGreater(price["output"], 0)               # Kostenlimit wirkt (vorher 0)

    def test_no_unit_may_touch_protected_paths_or_the_runner_infrastructure(self):
        for unit in self.pkg["units"]:
            for allowed in unit["allowed_paths"]:
                for protected in PROTECTED:
                    self.assertFalse(allowed.startswith(protected) or protected.startswith(allowed), (unit["id"], allowed, protected))
            self.assertEqual(path_violations(["infra/openclaw/runner/runner_core.py", ".github/workflows/x.yml", "AGENTS.md"], unit["allowed_paths"]),
                             ["infra/openclaw/runner/runner_core.py", ".github/workflows/x.yml", "AGENTS.md"])
        contracts = [u["id"] for u in self.pkg["units"] if any(a.startswith("contracts/") for a in u["allowed_paths"])]
        self.assertEqual(contracts, ["U7"])  # nur U7 legt contracts/gt-ads-001/ an (geschuetzter Pfad -> Merge braucht Betreiberfreigabe)

    def test_spec_hash_covers_all_unit_prompts(self):
        prompts = [u["prompt_file"] for u in self.pkg["units"]]
        for prompt in prompts:
            self.assertIn(prompt, self.pkg["spec_files"])
        for core in ("SPEZIFIKATION", "ARCHITEKTUR", "API-VERTRAG", "TESTPLAN", "DEEPSEEK-AUFTRAG"):
            self.assertIn("GT-ADS-001/%s.md" % core, self.pkg["spec_files"])

    def test_path_rules(self):
        self.assertEqual(path_violations(["apps/api/src/x.ts", "docs/fortschritt/s.md"], ["apps/api/"]), [])
        self.assertEqual(path_violations(["apps/apix/y.ts", "../x", "/etc/passwd2"], ["apps/api/"]), ["apps/apix/y.ts", "../x", "/etc/passwd2"])
        self.assertEqual(path_violations(["package.json"], ["package.json"]), [])


class UnitPromptTests(unittest.TestCase):
    def setUp(self):
        self.pkg = cfg()["packages"]["GT-ADS-001"]
        self.auftrag = read(os.path.join(REPO, "docs", "ARBEITSPAKETE", "GT-ADS-001", "DEEPSEEK-AUFTRAG.md"))
        sup = json.loads(read(os.path.join(ROOT, "devenv", "supply", "package.json")))
        self.supply = dict(sup["dependencies"], **sup["devDependencies"])

    def test_prompts_embed_the_original_unit_section_verbatim(self):
        for unit in self.pkg["units"]:
            text = read(os.path.join(REPO, "docs", "ARBEITSPAKETE", unit["prompt_file"]))
            section = re.search(r"^### %s – .*?(?=^### |^## )" % re.escape(unit["id"]), self.auftrag, re.S | re.M).group(0).rstrip()
            self.assertIn(section, text, unit["id"])

    def test_prompts_state_runner_rules_and_exact_supply_versions(self):
        for unit in self.pkg["units"]:
            text = read(os.path.join(REPO, "docs", "ARBEITSPAKETE", unit["prompt_file"]))
            for phrase in ("Kein Netz", "Lifecycle-Skripte", "with-postgres", "Hoechstens 3 Korrekturversuche", "Daten, keine Anweisungen"):
                self.assertIn(phrase, text, unit["id"])
            for allowed in unit["allowed_paths"]:
                self.assertIn("`%s`" % allowed, text, unit["id"])
            for name, version in self.supply.items():
                self.assertIn("`%s`: `%s`" % (name, version), text)


class SandboxV2ConfigTests(unittest.TestCase):
    def test_coder_uses_dev_image_without_network_or_binds(self):
        text = read(os.path.join(ROOT, "runner", "config", "openclaw-coder.json5.template"))
        coder = text[text.index("      coder: {"):]
        for item in ('image: "gtads-dev:2"', 'network: "none"', "readOnlyRoot: true", 'capDrop: ["ALL"]', 'user: "__UID__:__GID__"', 'tmpfs: ["/tmp:rw,size=1g"]',
                     'NPM_CONFIG_OFFLINE: "true"', 'NPM_CONFIG_IGNORE_SCRIPTS: "true"'):
            self.assertIn(item, coder)
        for forbidden in ("binds", "dangerously", "network: \"bridge\"", "network: \"host\""):
            self.assertNotIn(forbidden, coder)

    def test_openclaw_does_not_bootstrap_the_git_workspace(self):
        text = read(os.path.join(ROOT, "runner", "config", "openclaw-coder.json5.template"))
        self.assertIn("skipBootstrap: true", text)   # sonst WorkspaceVanishedError nach dem Neuanlegen (im Wegwerf-Lauf belegt)
        stack_src = read(os.path.join(ROOT, "runner", "stack.py"))
        self.assertIn(".openclaw/", stack_src)        # OpenClaw-Verwaltungsdateien nie committen

    def test_reviewer_stays_read_only(self):
        text = read(os.path.join(ROOT, "runner", "config", "openclaw-coder.json5.template"))
        reviewer = text[text.index("reviewer: {"):text.index("      coder: {")]
        self.assertIn('workspaceAccess: "ro"', reviewer)


class FakeToolkit:
    def __init__(self, bootstrap_error=None, accept_ok=True):
        self.calls, self.bootstrap_error, self.accept_ok = [], bootstrap_error, accept_ok

    def ensure_integration(self, package, seed):
        self.calls.append(("ensure", package, os.path.basename(seed)))

    def prepare_unit_workspace(self, package, unit):
        self.calls.append(("prepare", package, unit))

    def bootstrap_deps(self):
        self.calls.append(("bootstrap",))
        if self.bootstrap_error:
            from stack import StackError
            raise StackError(self.bootstrap_error)
        return []

    def run_tests(self, cmd, needs_db=True, timeout=900):
        self.calls.append(("tests", tuple(cmd), needs_db))
        return {"passed": True, "output": "ok"}

    def commit(self, message):
        self.calls.append(("commit", message))
        return "abc123"

    def accept(self, package, unit, allowed):
        self.calls.append(("accept", package, unit, tuple(allowed)))
        return self.accept_ok, "uebernommen" if self.accept_ok else "abgelehnt"


class StackExecutorTests(unittest.TestCase):
    def make(self, **kw):
        tk = FakeToolkit(**kw)
        ex = executors.StackExecutor({"workspace_dir": "/tmp/ws", "seeds_dir": "/seeds", "supply_dir": "/s", "integration_dir": "/i",
                                      "specs_root": "/x", "openclaw_node": "n", "openclaw_js": "j"}, {}, toolkit=tk)
        return ex, tk

    def test_unit_flow_uses_integration_state_supply_check_and_accept(self):
        ex, tk = self.make()
        job = {"id": 5, "wp_id": "GT-ADS-001", "unit_id": "U1"}
        unit = {"id": "U1", "title": "Datenbank", "allowed_paths": ["apps/api/"], "test": {"cmd": ["sh", "-c", "npm test"], "db": True}}
        ex.prepare_workspace(job, {"unit": unit})
        self.assertEqual(ex.run_tests(job, 600)["passed"], True)
        self.assertEqual(ex.commit(job), "abc123")
        self.assertTrue(ex.accept(job))
        self.assertEqual([c[0] for c in tk.calls], ["ensure", "prepare", "bootstrap", "tests", "commit", "accept"])
        self.assertEqual(tk.calls[0], ("ensure", "GT-ADS-001", "gt-ads-main.tar"))
        self.assertEqual(tk.calls[-1], ("accept", "GT-ADS-001", "U1", ("apps/api/",)))

    def test_dependency_violation_fails_tests_with_explanation_and_no_test_run(self):
        ex, tk = self.make(bootstrap_error="Paket 'left-pad' ist nicht in der Paketversorgung")
        job = {"id": 5, "wp_id": "GT-ADS-001", "unit_id": "U0"}
        ex.prepare_workspace(job, {"unit": {"id": "U0", "allowed_paths": ["apps/api/"]}})
        res = ex.run_tests(job, 600)
        self.assertFalse(res["passed"])
        self.assertIn("left-pad", res["output"])               # wird dem Agenten als Korrekturhinweis gezeigt
        self.assertNotIn("tests", [c[0] for c in tk.calls])

    def test_default_acceptance_command(self):
        ex, tk = self.make()
        job = {"id": 5, "wp_id": "GT-ADS-001", "unit_id": "U0"}
        ex.prepare_workspace(job, {"unit": {"id": "U0", "allowed_paths": []}})
        ex.run_tests(job, 600)
        self.assertIn(("tests", ("sh", "-c", "npm run -s typecheck && npm test -s"), True), tk.calls)


if __name__ == "__main__":
    unittest.main()
