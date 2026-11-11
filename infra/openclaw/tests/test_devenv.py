"""Tests fuer WP-013 (Entwicklungsumgebung v2): Pinning, Paketversorgung, Pruefwerkzeug, Skripte."""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DEVENV = os.path.join(ROOT, "devenv")
sys.path.insert(0, os.path.join(ROOT, "runner"))
import supply_check as sc  # noqa: E402

EXACT = re.compile(r"^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$")


def read(*parts):
    with open(os.path.join(DEVENV, *parts), encoding="utf-8") as handle:
        return handle.read()


def mini_lock(packages):
    return {"packages": dict({"": {"name": "root"}}, **{"node_modules/" + n: {"version": v, "integrity": i, "resolved": "https://registry.npmjs.org/%s/-/%s-%s.tgz" % (n, n, v)}
                                                       for n, v, i in packages})}


class PinningTests(unittest.TestCase):
    def test_containerfile_is_pinned_and_minimal(self):
        text = read("Containerfile")
        self.assertRegex(text, r"FROM docker\.io/library/node:22-trixie-slim@sha256:[0-9a-f]{64}")
        self.assertNotIn(":latest", text)
        self.assertIn("--no-install-recommends", text)
        self.assertIn("postgresql-17", text)
        self.assertNotRegex(text, r"(?i)\bsudo\b|curl[^|\n]*\|\s*(ba)?sh|--privileged|docker\.sock")
        self.assertIn("NPM_CONFIG_IGNORE_SCRIPTS=true", text)  # Lifecycle-Skripte standardmaessig aus

    def test_with_postgres_has_no_network_listener_and_cleans_up(self):
        text = read("with-postgres.sh")
        self.assertIn("listen_addresses=''", text)
        self.assertIn("unix_socket_directories=", text)
        self.assertIn("trap cleanup EXIT", text)
        self.assertNotIn("5432", text)
        self.assertNotIn("0.0.0.0", text)

    def test_supply_manifest_is_exact_and_consistent_with_lock(self):
        pkg = json.loads(read("supply", "package.json"))
        lock = json.loads(read("supply", "package-lock.json"))
        top = sc.supply_top_level(pkg)
        self.assertGreaterEqual(len(top), 20)
        for name, version in top.items():
            self.assertRegex(version, EXACT, name)  # keine Bereiche, kein "latest"
            self.assertEqual(lock["packages"]["node_modules/" + name]["version"], version, name)
        root = lock["packages"][""]
        for section in ("dependencies", "devDependencies"):
            self.assertEqual(root.get(section, {}), pkg.get(section, {}))  # Kopf der Lockdatei == package.json (sonst aendert npm sie beim Build)

    def test_supply_lock_integrity_and_source(self):
        lock = json.loads(read("supply", "package-lock.json"))
        count = 0
        for key, entry in lock["packages"].items():
            if not key or entry.get("link") or "version" not in entry:
                continue
            count += 1
            self.assertTrue(entry.get("integrity", "").startswith("sha512-"), key)
            self.assertTrue(entry["resolved"].startswith("https://registry.npmjs.org/"), key)
        self.assertGreater(count, 250)
        self.assertEqual(lock.get("lockfileVersion"), 3)

    def test_only_reviewed_packages_have_install_scripts(self):
        lock = json.loads(read("supply", "package-lock.json"))
        names = {n for n, _ in sc.install_script_packages(lock)}
        self.assertEqual(names, {"esbuild", "fsevents"})  # neue Skript-Pakete muessen bewusst geprueft werden


class SupplyCheckTests(unittest.TestCase):
    def setUp(self):
        self.pkg = {"dependencies": {"fastify": "5.12.8"}, "devDependencies": {"vitest": "5.1.0"}}
        self.lock = mini_lock([("fastify", "5.12.8", "sha512-aaa"), ("vitest", "5.1.0", "sha512-bbb"), ("dep", "1.0.0", "sha512-ccc")])

    def test_manifest_accepts_exact_pinned_versions_and_internal_packages(self):
        manifests = {"apps/api/package.json": {"name": "@gtads/api", "dependencies": {"fastify": "5.12.8", "@gtads/shared": "0.0.0"}, "devDependencies": {"vitest": "5.1.0"}}}
        self.assertEqual(sc.manifest_violations(self.pkg, manifests), [])

    def test_manifest_rejects_unknown_ranges_urls_and_wrong_versions(self):
        cases = {"left-pad": "1.3.0", "fastify": "^5.12.8", "vitest": "latest", "react": "file:../x",
                 "pg": "git+https://example.invalid/x.git"}
        for name, spec in cases.items():
            manifests = {"package.json": {"dependencies": {name.strip(): spec}}}
            self.assertNotEqual(sc.manifest_violations(self.pkg, manifests), [], (name, spec))
        self.assertNotEqual(sc.manifest_violations(self.pkg, {"package.json": {"dependencies": {"fastify": "5.12.7"}}}), [])  # andere als die gepinnte Version

    def test_manifest_rejects_lifecycle_scripts(self):
        for hook in ("preinstall", "install", "postinstall", "prepare"):
            self.assertTrue(sc.manifest_violations(self.pkg, {"package.json": {"scripts": {hook: "node evil.js"}}}), hook)
        self.assertEqual(sc.manifest_violations(self.pkg, {"package.json": {"scripts": {"test": "vitest run", "build": "vite build"}}}), [])

    def test_lock_must_be_subset_of_supply_with_same_integrity(self):
        project = mini_lock([("fastify", "5.12.8", "sha512-aaa"), ("dep", "1.0.0", "sha512-ccc")])
        self.assertEqual(sc.lock_violations(self.lock, project), [])
        self.assertTrue(sc.lock_violations(self.lock, mini_lock([("fastify", "5.12.9", "sha512-aaa")])))           # andere Version
        self.assertTrue(sc.lock_violations(self.lock, mini_lock([("fastify", "5.12.8", "sha512-MANIPULIERT")])))   # andere Pruefsumme
        self.assertTrue(sc.lock_violations(self.lock, mini_lock([("evil", "1.0.0", "sha512-xxx")])))               # unbekanntes Paket
        foreign = mini_lock([("fastify", "5.12.8", "sha512-aaa")])
        foreign["packages"]["node_modules/fastify"]["resolved"] = "https://evil.example/fastify.tgz"
        self.assertTrue(any("ausserhalb" in p for p in sc.lock_violations(self.lock, foreign)))

    def test_workspace_links_are_ignored(self):
        project = mini_lock([("fastify", "5.12.8", "sha512-aaa")])
        project["packages"]["node_modules/@gtads/api"] = {"resolved": "apps/api", "link": True}
        project["packages"]["apps/api"] = {"name": "@gtads/api", "version": "0.0.0"}
        self.assertEqual(sc.lock_violations(self.lock, project), [])

    def test_tree_hash_detects_changes_and_is_deterministic(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        os.makedirs(os.path.join(tmp, "a"))
        with open(os.path.join(tmp, "a", "f.js"), "w") as handle:
            handle.write("one")
        h1 = sc.tree_hash(tmp)
        self.assertEqual(h1, sc.tree_hash(tmp))
        with open(os.path.join(tmp, "a", "f.js"), "w") as handle:
            handle.write("two")
        h2 = sc.tree_hash(tmp)
        self.assertNotEqual(h1, h2)
        os.symlink("f.js", os.path.join(tmp, "a", "link"))
        self.assertNotEqual(h2, sc.tree_hash(tmp))

    def test_cli_exit_codes(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        with open(os.path.join(tmp, "package.json"), "w") as handle:
            json.dump({"dependencies": {"left-pad": "1.3.0"}}, handle)
        res = subprocess.run([sys.executable, "-I", os.path.join(ROOT, "runner", "supply_check.py"), "manifests", os.path.join(DEVENV, "supply", "package.json"), tmp],
                             capture_output=True, text=True)
        self.assertEqual(res.returncode, 1)
        self.assertIn("left-pad", res.stdout)

    def test_smoke_project_complies(self):
        manifests = sc.collect_manifests(os.path.join(DEVENV, "smoke"))
        self.assertEqual(sc.manifest_violations(sc.load(os.path.join(DEVENV, "supply", "package.json")), manifests), [])


class ScriptTests(unittest.TestCase):
    FORBIDDEN = re.compile(r"\b(ufw|iptables|visudo|NOPASSWD|usermod|chpasswd|setcap)\b|curl[^|\n]*\|\s*(ba)?sh|docker\.sock|--privileged")

    def test_scripts_basics(self):
        for name in ("build-devenv.sh", "install-devenv.sh"):
            text = read(name)
            self.assertTrue(text.startswith("#!/usr/bin/env bash\n"), name)
            self.assertIn("set -Eeuo pipefail", text)
            self.assertNotIn("set -x", text)
            code = "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))
            self.assertIsNone(self.FORBIDDEN.search(code), name)

    def test_build_runs_unprivileged_in_isolated_container_without_scripts(self):
        text = read("build-devenv.sh")
        self.assertIn('"$(id -u)" -ne 0', text)             # nie als root
        self.assertIn("--ignore-scripts", text)
        self.assertIn("--cap-drop ALL", text)
        self.assertIn("no-new-privileges", text)
        self.assertEqual(len(re.findall(r"-v \"\$WORK/out:/out:rw\"", text)), 2)  # genau das Ausgabeverzeichnis wird eingebunden
        self.assertNotIn("$HOME", text.replace("-e HOME=/tmp/home", ""))
        self.assertIn("cmp -s", text)                        # Lockdatei darf sich beim Build nicht aendern

    def test_install_is_offline_verified_and_does_not_touch_network_config(self):
        text = read("install-devenv.sh")
        self.assertIn("--dry-run", text)
        self.assertIn("\ncd /", text)
        self.assertIn("sha256sum -c", text)
        self.assertIn("tree-hash", text)
        self.assertIn("--network none", text)
        self.assertIn("--read-only", text)
        self.assertIn(":O", text)                            # Overlay: Versorgung bleibt unveraendert
        self.assertNotRegex(text, r"egress-allowlist|systemctl (restart|stop|start)")

    def test_install_dry_run_runs_unprivileged(self):
        res = subprocess.run(["bash", os.path.join(DEVENV, "install-devenv.sh"), "--dry-run"], capture_output=True, text=True, cwd="/")
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn("[dry-run] podman load", res.stdout)


if __name__ == "__main__":
    unittest.main()
