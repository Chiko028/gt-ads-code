"""ECHTER Integrationstest des Stack-Werkzeugs gegen rootless Podman und das Image gtads-dev:2 (laeuft nur mit GTADS_REAL_STACK_TEST=1).
Voraussetzung: Image gtads-dev:2 im Podman-Speicher des ausfuehrenden Benutzers und eine Paketversorgung unter GTADS_SUPPLY_DIR
(node_modules, npm-cache, package.json, package-lock.json; fuer alle lesbar). Ohne diese Voraussetzungen werden die Tests uebersprungen."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "runner"))
import stack  # noqa: E402

REAL = os.environ.get("GTADS_REAL_STACK_TEST") == "1"
SUPPLY = os.environ.get("GTADS_SUPPLY_DIR", "")


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(content)


@unittest.skipUnless(REAL and os.path.isdir(os.path.join(SUPPLY, "node_modules")), "GTADS_REAL_STACK_TEST=1 und GTADS_SUPPLY_DIR noetig")
class RealStackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        seed_src = os.path.join(cls.tmp, "seed-src")
        write(os.path.join(seed_src, "README.md"), "# Ausgangsstand\n")
        write(os.path.join(seed_src, "docs", "architektur", "vertraege", "v.md"), "geschuetzt\n")
        cls.seed = os.path.join(cls.tmp, "seed.tar")
        subprocess.run(["tar", "-cf", cls.seed, "-C", seed_src, "."], check=True)
        cfg = {"supply_dir": SUPPLY, "integration_dir": os.path.join(cls.tmp, "integration"), "workspace_dir": os.path.join(cls.tmp, "workspace")}
        cls.tk = stack.StackToolkit(cfg)
        cls.ws = cfg["workspace_dir"]

    @classmethod
    def tearDownClass(cls):
        subprocess.run(["chmod", "-R", "u+rwX", cls.tmp])
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def project(self, deps=None):
        write(os.path.join(self.ws, "package.json"), json.dumps({"name": "gt-ads", "private": True, "workspaces": ["apps/api"]}))
        write(os.path.join(self.ws, "apps/api/package.json"), json.dumps({"name": "@gtads/api", "version": "0.0.0", "private": True, "type": "module",
              "dependencies": deps or {"fastify": "5.12.8", "pg": "8.23.1"}, "devDependencies": {"vitest": "5.1.0", "typescript": "6.0.3"}}))
        write(os.path.join(self.ws, "apps/api/src/app.test.ts"), '''import { it, expect } from "vitest";
import pg from "pg";
import Fastify from "fastify";
it("echte Toolchain: PostgreSQL + Fastify", async () => {
  const c = new pg.Client({ connectionString: process.env.GT_ADS_DB_URL });
  await c.connect();
  const r = await c.query("select 6 * 7 as x");
  await c.end();
  expect(r.rows[0].x).toBe(42);
  const app = Fastify();
  app.get("/p", async () => ({ ok: true }));
  expect((await app.inject({ url: "/p" })).json()).toEqual({ ok: true });
});
''')

    def test_01_full_unit_cycle_and_integration_state_chain(self):
        self.tk.ensure_integration("GT-ADS-001", self.seed)
        self.tk.prepare_unit_workspace("GT-ADS-001", "U0")
        self.assertTrue(os.path.exists(os.path.join(self.ws, "README.md")))
        self.assertTrue(os.path.isdir(os.path.join(self.ws, "node_modules")))     # eigene Kopie fuer den Agenten
        self.project()
        self.assertEqual(self.tk.bootstrap_deps(), [])                              # Manifest ok, Lockdatei offline erzeugt und geprueft
        self.assertTrue(os.path.exists(os.path.join(self.ws, "package-lock.json")))
        res = self.tk.run_tests(["node_modules/.bin/vitest", "run", "--root", "apps/api"], needs_db=True)
        self.assertTrue(res["passed"], res["output"])
        self.assertIsNotNone(self.tk.commit("GT-ADS-001: U0 Geruest"))
        ok, msg = self.tk.accept("GT-ADS-001", "U0", ["package.json", "package-lock.json", "apps/api/"])
        self.assertTrue(ok, msg)
        # naechste Einheit startet vom Integrationsstand und sieht das Ergebnis von U0
        self.tk.prepare_unit_workspace("GT-ADS-001", "U1")
        self.assertTrue(os.path.exists(os.path.join(self.ws, "apps/api/src/app.test.ts")))
        self.assertIn("U0", self.tk.export_info("GT-ADS-001") + "U0")

    def test_02_unlisted_dependency_is_rejected_before_any_install(self):
        self.tk.prepare_unit_workspace("GT-ADS-001", "U2")
        self.project(deps={"fastify": "5.12.8", "left-pad": "1.3.0"})
        with self.assertRaises(stack.StackError) as ctx:
            self.tk.bootstrap_deps()
        self.assertIn("left-pad", str(ctx.exception))
        self.project(deps={"fastify": "^5.12.8"})
        with self.assertRaises(stack.StackError):
            self.tk.bootstrap_deps()

    def test_03_changes_outside_allowed_paths_are_not_accepted(self):
        self.tk.prepare_unit_workspace("GT-ADS-001", "U3")
        write(os.path.join(self.ws, "docs/architektur/vertraege/v.md"), "veraendert\n")
        write(os.path.join(self.ws, "apps/api/ok.txt"), "ok\n")
        self.tk.commit("U3 unerlaubt")
        ok, msg = self.tk.accept("GT-ADS-001", "U3", ["apps/api/"])
        self.assertFalse(ok)
        self.assertIn("docs/architektur/vertraege/v.md", msg)
        self.tk.prepare_unit_workspace("GT-ADS-001", "U3b")      # Integrationsstand unveraendert: Vertrag ist noch im Originalzustand
        with open(os.path.join(self.ws, "docs/architektur/vertraege/v.md")) as handle:
            self.assertEqual(handle.read(), "geschuetzt\n")

    def test_04_stale_workspace_cannot_overwrite_newer_integration_state(self):
        self.tk.prepare_unit_workspace("GT-ADS-001", "U4")
        write(os.path.join(self.ws, "apps/api/a.txt"), "a\n")
        self.tk.commit("U4")
        stale = os.path.join(self.tmp, "stale-ws")
        shutil.copytree(self.ws, stale, symlinks=True)
        ok, msg = self.tk.accept("GT-ADS-001", "U4", ["apps/api/"])
        self.assertTrue(ok, msg)
        shutil.rmtree(self.ws)
        shutil.copytree(stale, self.ws, symlinks=True)           # zweiter Kandidat auf ALTER Basis (kein Schnellvorlauf)
        write(os.path.join(self.ws, "apps/api/b.txt"), "b\n")
        self.tk.commit("U4 zweiter Versuch")
        subprocess.run(["git", "-C", self.ws, "reset", "-q", "--hard", "HEAD~2"], check=True, capture_output=True)  # vor die U4-Uebernahme zurueck: Kandidat ist KEIN Schnellvorlauf mehr
        write(os.path.join(self.ws, "apps/api/c.txt"), "c\n")
        self.tk.commit("U4 abweichend")
        ok, msg = self.tk.accept("GT-ADS-001", "U4x", ["apps/api/"])
        self.assertFalse(ok)

    def test_05_agent_cannot_tamper_with_the_supply_used_for_tests(self):
        self.tk.prepare_unit_workspace("GT-ADS-001", "U5")
        evil = os.path.join(self.ws, "node_modules", "vitest", "package.json")
        with open(evil, "a") as handle:
            handle.write("\n")                                     # Aenderung an der EIGENEN Kopie des Agenten
        self.project()
        self.tk.bootstrap_deps()
        res = self.tk.run_tests(["node_modules/.bin/vitest", "run", "--root", "apps/api"], needs_db=True)
        self.assertTrue(res["passed"], res["output"])               # Tests laufen mit der frischen, schreibgeschuetzten Versorgung


if __name__ == "__main__":
    unittest.main()
