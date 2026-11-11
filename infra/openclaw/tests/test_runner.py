"""Tests fuer den Coding-Runner (Kernlogik mit Attrappen, MCP-Bruecke ueber echten Unix-Socket)."""

import json
import os
import shutil
import socketserver
import sys
import tempfile
import threading
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "runner"))
import executors  # noqa: E402
import mcp_server  # noqa: E402
import runner_daemon  # noqa: E402
from runner_core import Runner, RunnerError, Store  # noqa: E402


OP = "789682954"


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class FakeNotifier:
    def __init__(self):
        self.messages = []
        self.fail = False

    def send_operator(self, text, buttons=None):
        if self.fail:
            raise RuntimeError("down")
        self.messages.append(text)
        if buttons:
            self.buttons = buttons

    def last_nonce(self):
        return self.buttons[0][0]["callback_data"].split(":", 2)[2]


class FakeExecutor:
    """Skriptbarer Ausfuehrer: passes[i] sagt, ob der i-te Testlauf besteht."""

    def __init__(self, runner=None, passes=(True,), usage=(10, 10), on_turn=None):
        self.runner, self.passes, self.usage, self.on_turn = runner, list(passes), usage, on_turn
        self.turns, self.test_runs, self.prompts, self.stop_check = 0, 0, [], None

    def prepare_workspace(self, job, pkg): pass
    def build_prompt(self, job, pkg, correction): return "korrektur" if correction else "aufgabe"
    def cleanup(self, job): pass
    def commit(self, job): return "abc1234"

    def agent_turn(self, job, prompt, timeout_s):
        self.turns += 1
        self.prompts.append(prompt)
        if self.on_turn:
            self.on_turn(self.turns)
        return {"input_tokens": self.usage[0], "output_tokens": self.usage[1], "text": "fertig"}

    def run_tests(self, job, timeout_s):
        ok = self.passes[min(self.test_runs, len(self.passes) - 1)]
        self.test_runs += 1
        return {"passed": ok, "output": "" if ok else "1 failed"}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        specs = os.path.join(self.tmp, "specs", "WP-X")
        os.makedirs(specs)
        self.spec = os.path.join(specs, "AUFTRAG.md")
        with open(self.spec, "w") as handle:
            handle.write("Aufgabe v1")
        self.clock, self.notifier = Clock(), FakeNotifier()
        pkg = {"enabled": True, "spec_files": ["WP-X/AUFTRAG.md"], "task_file": "WP-X/AUFTRAG.md", "budget_usd": 2, "timeout_s": 1800,
               "max_attempts": 3, "max_tokens": 1000}
        self.cfg = {"db_path": os.path.join(self.tmp, "r.sqlite"), "specs_root": os.path.join(self.tmp, "specs"), "pilot_budget_usd": 10,
                    "price_usd_per_million_tokens": {"input": 1.0, "output": 2.0},
                    "packages": {"WP-X": pkg, "OFF": dict(pkg, enabled=False)}, "operator_chat_id": OP}
        self.runner = Runner(Store(self.cfg["db_path"]), self.cfg, self.notifier, self.clock)

    def approved_job(self):
        job = self.runner.prepare("WP-X")["job_id"]
        self.click("a")
        return job

    def click(self, action, sender=None, chat=None, group=False, nonce=None):
        return self.runner.button(nonce if nonce is not None else self.notifier.last_nonce(), action, sender or OP, chat or OP, group)


class ApprovalTests(Base):
    def test_only_allowlisted_enabled_packages(self):
        for wp in ("GT-ADS-001", "OFF", "../etc", None, 5):
            with self.assertRaises(RunnerError):
                self.runner.prepare(wp)

    def test_prepare_sends_buttons_only_to_operator_not_to_caller(self):
        result = self.runner.prepare("WP-X")
        nonce = self.notifier.last_nonce()
        self.assertRegex(nonce, r"^[A-Za-z0-9_-]{22}$")
        self.assertNotIn(nonce, json.dumps(result))
        self.assertNotIn(nonce, self.notifier.messages[-1])
        self.assertIn(result["spec_hash"], self.notifier.messages[-1])
        self.assertEqual([b["text"] for b in self.notifier.buttons[0]], ["Freigeben", "Ablehnen", "Details"])
        self.assertTrue(all(len(b["callback_data"].encode()) <= 64 for b in self.notifier.buttons[0]))
        self.assertNotIn(nonce, json.dumps(self.runner.approvals.history()))  # Nonce nie im Protokoll

    def test_prepare_discarded_when_operator_cannot_be_notified(self):
        self.notifier.fail = True
        with self.assertRaises(RunnerError):
            self.runner.prepare("WP-X")
        self.assertEqual(self.runner.status()["jobs"][0]["state"], "cancelled")

    def test_text_or_code_approval_is_abolished(self):
        job = self.runner.prepare("WP-X")["job_id"]
        for code in ("123456", self.notifier.last_nonce(), None):
            with self.assertRaises(RunnerError):
                self.runner.approve(job, code)
        self.assertEqual(self.runner.status()["jobs"][0]["state"], "prepared")

    def test_foreign_sender_group_and_other_chat_rejected(self):
        self.runner.prepare("WP-X")
        for kw in ({"sender": "111"}, {"group": True}, {"chat": "-100123"}, {"sender": "789682954 "}, {"sender": "0"}):
            self.assertIn("Abgelehnt", self.click("a", **kw)["text"])
        self.assertEqual(self.runner.status()["jobs"][0]["state"], "prepared")  # fremde Klicks verbrauchen nichts
        self.assertIn("freigegeben", self.click("a")["text"])
        events = [h["event"] for h in self.runner.approvals.history()]
        self.assertEqual(len([e for e in events if "abgelehnt" in e]), 5)

    def test_replay_rejected(self):
        self.approved_job()
        self.assertIn("bereits verwendet", self.click("a")["text"])
        self.assertIn("bereits verwendet", self.click("r")["text"])
        self.assertEqual(self.runner.status()["jobs"][0]["state"], "approved")

    def test_forged_or_unknown_nonce_rejected(self):
        self.runner.prepare("WP-X")
        for n in ("A" * 22, "x", "../../etc", "A" * 64, ""):
            self.assertIn("Abgelehnt", self.click("a", nonce=n)["text"])

    def test_request_expires(self):
        self.runner.prepare("WP-X")
        self.clock.now += 24 * 3600 + 1
        self.assertIn("abgelaufen", self.click("a")["text"])

    def test_approval_bound_to_spec_version(self):
        self.runner.prepare("WP-X")
        with open(self.spec, "w") as handle:
            handle.write("Aufgabe v2 (geaendert)")
        self.assertIn("nicht mehr offen", self.click("a")["text"])
        self.assertEqual(self.runner.status()["jobs"][0]["state"], "prepared")
        self.assertIn("bereits verwendet", self.click("a")["text"])  # Anfrage bleibt ungueltig

    def test_reject_button_cancels(self):
        self.runner.prepare("WP-X")
        self.assertIn("abgelehnt", self.click("r")["text"])
        self.assertEqual(self.runner.status()["jobs"][0]["state"], "cancelled")

    def test_details_does_not_consume(self):
        self.runner.prepare("WP-X")
        d = self.click("d")
        self.assertIn("WP-X", d["text"])
        self.assertTrue(d["keep_buttons"])
        self.assertIn("freigegeben", self.click("a")["text"])

    def test_sensitive_needs_root_confirmation(self):
        self.cfg["packages"]["WP-X"]["sensitive"] = True
        job = self.runner.prepare("WP-X")["job_id"]
        self.assertIn("sudo gtads-confirm", self.notifier.messages[-1])
        self.assertIn("SENSIBEL", self.click("a")["text"])
        self.assertEqual(self.runner.status()["jobs"][0]["state"], "prepared")
        for uid in (1001, 994, 999):
            with self.assertRaises(RunnerError):
                self.runner.strong_confirm("job:%d" % job, uid)
        self.runner.strong_confirm("job:%d" % job, 0)
        self.assertEqual(self.runner.status()["jobs"][0]["state"], "approved")

    def test_sensitive_root_without_telegram_click_refused(self):
        self.cfg["packages"]["WP-X"]["sensitive"] = True
        job = self.runner.prepare("WP-X")["job_id"]
        with self.assertRaises(RunnerError):
            self.runner.strong_confirm("job:%d" % job, 0)

    def test_old_code_drafts_migrated_after_restart(self):
        self.runner.store.run("INSERT INTO jobs(wp_id, spec_hash, state, created_at, code_salt, code_hash, code_expires) VALUES ('WP-X','h','prepared',1,'s','c',99999999)")
        self.runner.recover_after_restart()
        row = self.runner.status()["jobs"][0]
        self.assertEqual(row["state"], "cancelled")

    def test_only_one_job_at_a_time(self):
        job = self.approved_job()
        with self.assertRaises(RunnerError):
            self.runner.prepare("WP-X")
        self.assertEqual(self.runner.claim_next()["id"], job)
        self.assertIsNone(self.runner.claim_next())

    def test_new_draft_replaces_old_draft(self):
        self.runner.prepare("WP-X")
        old = self.notifier.last_nonce()
        self.runner.prepare("WP-X")
        self.assertIn("Abgelehnt", self.click("a", nonce=old)["text"])


class ExecutionTests(Base):
    def run_job(self, executor):
        job = self.approved_job()
        row = self.runner.claim_next()
        executor.stop_check = lambda: self.runner.stop_requested(job)
        return job, self.runner.execute(row, executor)

    def test_success_first_try(self):
        _, report = self.run_job(FakeExecutor(passes=(True,)))
        self.assertEqual(report["ergebnis"], "succeeded")
        self.assertEqual(report["korrekturversuche"], 0)
        self.assertEqual(report["commit"], "abc1234")

    def test_correction_loop_succeeds_on_second_try(self):
        ex = FakeExecutor(passes=(False, True))
        _, report = self.run_job(ex)
        self.assertEqual((report["ergebnis"], report["korrekturversuche"], ex.turns), ("succeeded", 1, 2))
        self.assertEqual(ex.prompts[1], "korrektur")

    def test_at_most_three_correction_attempts_then_honest_failure(self):
        ex = FakeExecutor(passes=(False,))
        _, report = self.run_job(ex)
        self.assertEqual((report["ergebnis"], report["korrekturversuche"], ex.turns), ("blocked", 3, 4))  # nach dem Limit: blockiert
        self.assertIn("NICHT bestanden", self.notifier.messages[-1])
        self.assertIn("3 Korrekturversuchen", report["fehler"])

    def test_timeout_enforced(self):
        ex = FakeExecutor(passes=(False,), on_turn=lambda n: setattr(self.clock, "now", self.clock.now + 2000))
        _, report = self.run_job(ex)
        self.assertEqual(report["ergebnis"], "timeout")

    def test_token_budget_enforced(self):
        ex = FakeExecutor(passes=(False,), usage=(400, 400))  # Limit 1000 Tokens
        _, report = self.run_job(ex)
        self.assertEqual(report["ergebnis"], "budget")
        self.assertLessEqual(ex.turns, 2)

    def test_cost_budget_enforced(self):
        self.cfg["packages"]["WP-X"]["budget_usd"] = 0.0001
        self.cfg["packages"]["WP-X"]["max_tokens"] = 10 ** 9
        ex = FakeExecutor(passes=(False,), usage=(1000, 1000))
        _, report = self.run_job(ex)
        self.assertEqual(report["ergebnis"], "budget")

    def test_stop_ends_running_job(self):
        ex = FakeExecutor(passes=(False,), on_turn=lambda n: self.runner.stop())
        _, report = self.run_job(ex)
        self.assertEqual((report["ergebnis"], ex.turns), ("stopped", 1))

    def test_executor_exception_is_reported_without_details(self):
        ex = FakeExecutor()
        ex.agent_turn = lambda *a: (_ for _ in ()).throw(RuntimeError("geheim: sk-abc"))
        _, report = self.run_job(ex)
        self.assertEqual(report["ergebnis"], "failed")
        self.assertNotIn("sk-abc", json.dumps(report))

    def test_agent_note_is_labelled_unverified(self):
        self.run_job(FakeExecutor())
        self.assertIn("ungeprueft", self.notifier.messages[-1])

    def test_restart_never_reruns_a_running_job(self):
        job = self.approved_job()
        self.runner.claim_next()
        again = Runner(Store(self.cfg["db_path"]), self.cfg, self.notifier, self.clock)
        again.recover_after_restart()
        self.assertEqual(again.status()["jobs"][0]["state"], "interrupted")
        self.assertIsNone(again.claim_next())
        self.assertEqual(job, again.status()["jobs"][0]["id"])

    def test_pilot_budget_blocks_start(self):
        self.cfg["pilot_budget_usd"] = 0.0
        _, report = self.run_job(FakeExecutor())
        self.assertEqual(report["ergebnis"], "budget")


class McpBridgeTests(Base):
    def setUp(self):
        super().setUp()
        self.sock = os.path.join(self.tmp, "c.sock")
        self.server = runner_daemon.Server(self.sock, runner_daemon.Handler)
        self.server.runner = self.runner
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def call(self, name, **args):
        reply = mcp_server.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}}, self.sock)
        return json.loads(reply["result"]["content"][0]["text"]), reply["result"]["isError"]

    def test_tools_and_protocol(self):
        listing = mcp_server.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        self.assertEqual({t["name"] for t in listing["result"]["tools"]}, {"coder_prepare", "coder_stop", "coder_status", "coder_report", "coder_limits", "coder_reviews", "coder_review_findings", "coder_agents", "coder_released", "coder_start_released", "codex_plan", "codex_revise", "codex_drafts", "coder_health", "coder_costs", "codex_health", "codex_cancel"})
        init = mcp_server.handle({"jsonrpc": "2.0", "id": 2, "method": "initialize", "params": {}})
        self.assertIn("tools", init["result"]["capabilities"])
        self.assertIsNone(mcp_server.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}))

    def test_prepare_via_mcp_never_approves(self):
        result, err = self.call("coder_prepare", wp_id="WP-X")
        self.assertFalse(err)
        self.assertNotIn(self.notifier.last_nonce(), json.dumps(result))
        listing = mcp_server.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        self.assertFalse([t for t in listing["result"]["tools"] if "approve" in t["name"] or "freigeb" in t["name"]])
        res = mcp_server.handle({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "coder_approve", "arguments": {"job_id": 1, "code": "x"}}})
        self.assertIn("error", res)
        self.assertEqual(self.runner.status()["jobs"][0]["state"], "prepared")

    def test_disabled_package_and_unknown_tool_and_unreachable_runner(self):
        res, err = self.call("coder_prepare", wp_id="GT-ADS-001")
        self.assertTrue(err)
        self.assertEqual(mcp_server.handle({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "bash", "arguments": {}}})["error"]["code"], -32602)
        res = mcp_server.handle({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "coder_status", "arguments": {}}}, os.path.join(self.tmp, "weg.sock"))
        self.assertTrue(res["result"]["isError"])


class SandboxCommandTests(unittest.TestCase):
    def test_podman_run_is_hardened(self):
        args = executors.podman_run_args("/w", ["true"])
        joined = " ".join(args)
        for flag in ("--network none", "--read-only", "--cap-drop ALL", "no-new-privileges", "--pids-limit", "--memory"):
            self.assertIn(flag, joined)
        self.assertNotIn("docker.sock", joined)
        self.assertNotIn("--privileged", joined)
        self.assertEqual([a for a in args if a == "-v"], ["-v"])  # genau ein Mount: der Workspace

    def test_shipped_config_enables_only_pilot_package(self):
        with open(os.path.join(ROOT, "runner", "config", "runner.json"), encoding="utf-8") as handle:
            cfg = json.load(handle)
        # Betreiberfreigabe 2026-11-10: GT-ADS-001 zur Implementierung freigegeben (Plan); weitere Pakete bleiben gesperrt
        self.assertEqual(sorted(k for k, v in cfg["packages"].items() if v["enabled"]), ["GT-ADS-001", "WP-009"])
        self.assertTrue(cfg["packages"]["WP-009"].get("synthetic"))
        self.assertFalse(cfg["packages"]["GT-ADS-001"].get("synthetic"))
        pkg = cfg["packages"]["WP-009"]
        self.assertEqual(cfg["defaults"], {"max_attempts": 10, "timeout_s": 3600})  # zentral (Betreiber 2026-11-11)
        self.assertNotIn("max_attempts", pkg)
        self.assertEqual(pkg["budget_usd"], 2)
        self.assertLessEqual(cfg["pilot_budget_usd"], 10)


class CoderDeployTests(unittest.TestCase):
    DEPLOY = os.path.join(ROOT, "runner", "deploy")
    FORBIDDEN = __import__("re").compile(r"\b(ufw|iptables|nft|visudo|NOPASSWD|usermod|chpasswd|setcap)\b|curl[^|\n]*\|\s*(ba)?sh|docker\.sock|--privileged")

    def read(self, *parts):
        with open(os.path.join(ROOT, *parts), encoding="utf-8") as handle:
            return handle.read()

    def test_scripts_basics_and_dry_run(self):
        for name in ("install-coder.sh", "sync-runner-specs.sh", "diagnose-runner.sh", "codex-login.sh", "verify-codex.sh", "set-gemini-key.sh", "verify-gemini.sh", "diagnose-podman-sandbox.sh"):
            text = self.read("runner", "deploy", name)
            self.assertTrue(text.startswith("#!/usr/bin/env bash\n"), name)
            self.assertIn("set -Eeuo pipefail", text)
            self.assertNotIn("set -x", text)
            self.assertIn("\ncd /", text)  # neutrales Arbeitsverzeichnis (EACCES-Lehre)
            code = "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))
            self.assertIsNone(self.FORBIDDEN.search(code), name)
        self.assertIn("--dry-run", self.read("runner", "deploy", "install-coder.sh"))
    def test_installer_makes_program_files_readable_for_occoder(self):
        text = self.read("runner", "deploy", "install-coder.sh")
        self.assertIn("umask 077", text)                             # restriktiv fuer Zugangsdaten ...
        self.assertIn("chmod -R u=rwX,go=rX /opt/gt-ads/runner", text)  # ... daher Programmdateien/Vorlagen ausdruecklich lesbar machen
        self.assertNotIn("chmod -R go-w /opt/gt-ads/runner", text)

    def test_installer_restarts_running_service_but_never_during_a_job(self):
        text = self.read("runner", "deploy", "install-coder.sh")
        self.assertIn("systemctl restart gt-ads-coding-runner.service", text)
        self.assertIn('j["state"]=="running"', text)  # kein Neustart mitten in einem laufenden Auftrag

    def test_gemini_key_input_check_accepts_punctuation_but_rejects_pasted_text(self):
        import re, subprocess
        text = self.read("runner", "deploy", "set-gemini-key.sh")
        self.assertIn("[\\!-~]{20,300}", text)
        def accepts(value):  # dieselbe Bash-Pruefung isoliert ausfuehren (nur die Laengen-/Zeichenpruefung)
            code = 'KEY="$1"; [[ "$KEY" =~ ^[\\!-~]{20,300}$ ]]'
            return subprocess.run(["bash", "-c", code, "x", value]).returncode == 0
        self.assertTrue(accepts("AIza" + "a" * 35))
        self.assertTrue(accepts("AQ.Ab8RN6" + "x" * 30 + "-_.~"))        # Satzzeichen erlaubt
        self.assertFalse(accepts("sudo bash infra/openclaw/runner/deploy/verify-gemini.sh"))  # eingefuegte Befehlszeile
        self.assertFalse(accepts("kurz"))
        self.assertFalse(accepts("a" * 301))
        self.assertFalse(accepts("mit leerzeichen " + "a" * 30))
        del re

    def test_unit_isolation(self):
        lines = [l.strip() for l in self.read("runner", "deploy", "gt-ads-coding-runner.service").splitlines() if l.strip() and not l.lstrip().startswith("#")]
        for item in ("User=occoder", "Group=occoder", "SupplementaryGroups=openclaw", "IPAddressDeny=any", "IPAddressAllow=localhost", "ProtectSystem=strict",
                     "MemoryMax=3G", "UMask=0077", "RuntimeDirectoryMode=0711"):
            self.assertIn(item, lines)
        deny = [l for l in lines if l.startswith("InaccessiblePaths=")][0]
        for path in ("/srv", "/root", "/home", "/etc/gt-ads/credentials", "/etc/gt-ads/openclaw-credentials", "/var/lib/openclaw"):
            self.assertIn(path, deny)
        self.assertTrue(any(l.startswith("LoadCredential=deepseek_api_key:") for l in lines))
        self.assertTrue(any(l.startswith("LoadCredential=gemini_api_key:") for l in lines))
        self.assertFalse(any(l.startswith(("User=root", "Ports=", "ExecStartPost=+", "ExecStartPost=!", "ExecStartPost=-+", "ExecStartPost=-!")) for l in lines))
        self.assertTrue(all(l == "ExecStartPost=-/usr/bin/podman unshare true" for l in lines if l.startswith("ExecStartPost")))  # nur als occoder, kein root
        # begruendete Abweichung von der sonstigen Haertung muss dokumentiert sein
        self.assertIn("NoNewPrivileges=no: newuidmap", self.read("runner", "deploy", "gt-ads-coding-runner.service"))
        unit = self.read("runner", "deploy", "gt-ads-coding-runner.service")
        self.assertIn("RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK", unit)  # Podman braucht Netlink (Diagnose)
        self.assertIn("ProtectHome=no", unit)                                                 # sonst ist /run/user/<uid> unsichtbar
        self.assertIn("IPAddressDeny=any", unit)                                              # Netzsperre bleibt

    def test_unit_starts_daemon_so_modules_are_importable(self):
        unit = self.read("runner", "deploy", "gt-ads-coding-runner.service")
        line = [l for l in unit.splitlines() if l.startswith("ExecStart=")][0]
        self.assertNotRegex(line, r"python3\s+(-\w+\s+)*-I\b")  # -I entfernt das Skriptverzeichnis aus sys.path (Neustart-Schleife auf dem VPS)
        self.assertIn("-E -s", line)

    def test_daemon_smoke_start_as_in_unit(self):
        """Startet den Dienst so wie die Unit (python3 -E -s, anderes Arbeitsverzeichnis) und fragt den Status ueber den Socket ab."""
        import subprocess, time
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        os.makedirs(os.path.join(tmp, "cred"))
        os.makedirs(os.path.join(tmp, "run"))
        for name in ("telegram_bot_token", "deepseek_api_key"):
            with open(os.path.join(tmp, "cred", name), "w") as handle:
                handle.write("x")
        with open(os.path.join(ROOT, "runner", "config", "runner.json"), encoding="utf-8") as handle:
            cfg = json.load(handle)
        cfg.update({"db_path": os.path.join(tmp, "r.sqlite"), "socket_path": os.path.join(tmp, "run", "c.sock"), "approve_socket_path": os.path.join(tmp, "run", "a.sock"), "specs_root": tmp, "workspace_dir": os.path.join(tmp, "ws"),
                    "home": tmp, "xdg_runtime_dir": tmp, "operator_chat_id": 1, "socket_group": "",
                    "openclaw_node": os.path.join(tmp, "kein-node"), "openclaw_js": os.path.join(tmp, "kein.mjs")})  # hermetisch: nie die echte CLI starten
        cfg_path = os.path.join(tmp, "cfg.json")
        with open(cfg_path, "w") as handle:
            json.dump(cfg, handle)
        proc = subprocess.Popen([sys.executable, "-E", "-s", os.path.join(ROOT, "runner", "runner_daemon.py"), cfg_path], cwd="/", stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, env=dict(os.environ, CREDENTIALS_DIRECTORY=os.path.join(tmp, "cred")))
        self.addCleanup(proc.stdout.close)
        self.addCleanup(proc.wait)
        self.addCleanup(proc.terminate)
        reply = None
        for _ in range(40):
            if proc.poll() is not None:
                self.fail("Dienst beendet: " + proc.stdout.read().decode()[-300:])
            if os.path.exists(cfg["socket_path"]):
                try:
                    reply = mcp_server.call_runner({"cmd": "status"}, cfg["socket_path"])
                    break
                except OSError:
                    pass
            time.sleep(0.25)
        self.assertTrue(reply and reply["ok"], reply)
        self.assertEqual(reply["result"]["pakete"], ["GT-ADS-001", "WP-009"])
        limits = mcp_server.call_runner({"cmd": "limits"}, cfg["socket_path"])  # ohne Anmeldung/Messung: gesperrt, kein Absturz, keine erfundenen Werte
        self.assertTrue(limits["ok"])
        self.assertFalse(limits["result"]["allowed"])
        self.assertFalse(limits["result"]["measurable"])
        self.assertNotIn("five_hour", limits["result"])
        agents = mcp_server.call_runner({"cmd": "agents"}, cfg["socket_path"])
        self.assertTrue(agents["ok"])
        self.assertFalse(agents["result"]["codex"]["startbereit"])
        self.assertIn("nicht eingerichtet", agents["result"]["gemini"]["zustand"])
        self.assertEqual(mcp_server.call_runner({"cmd": "reviews"}, cfg["socket_path"])["result"]["reviews"], [])
        bad = mcp_server.call_runner({"cmd": "review_findings", "review_id": 999}, cfg["socket_path"])
        self.assertFalse(bad["ok"])
        self.assertFalse(mcp_server.call_runner({"cmd": "approve", "job_id": 1, "code": "1"}, cfg["socket_path"])["ok"])  # Steuer-Socket: keine Freigabe
        self.assertTrue(os.path.exists(cfg["approve_socket_path"]))
        self.assertEqual(oct(os.stat(cfg["approve_socket_path"]).st_mode & 0o777), "0o660")
        nope = mcp_server.call_runner({"cmd": "button", "nonce": "A" * 22, "action": "a", "sender_id": "1", "chat_id": "1", "is_group": False}, cfg["approve_socket_path"])
        self.assertIn("Abgelehnt", nope["result"]["text"])

    def test_coder_config_is_narrow(self):
        text = self.read("runner", "config", "openclaw-coder.json5.template")
        for item in ('backend: "podman"', 'network: "none"', "readOnlyRoot: true", 'capDrop: ["ALL"]', 'workspaceAccess: "rw"', "elevated: { enabled: false }",
                     'profile: "minimal"', "maxConcurrent: 1", 'user: "__UID__:__GID__"', "catalogRefresh: { enabled: false }", "update: {"):
            self.assertIn(item, text)
        for denied in ("group:web", "group:ui", "group:automation", "gateway", "cron", "sessions_spawn", "message", "github_publish"):
            self.assertIn('"%s"' % denied, text)
        for forbidden in ('network: "bridge"', 'network: "host"', 'mode: "off"', "docker.sock", 'bind: "lan"'):
            self.assertNotIn(forbidden, text)
        self.assertNotIn("telegram", text.lower().replace("// ", ""))  # kein Kanal fuer den Coding-Agenten

    def test_executor_uses_local_agent_and_user(self):
        args = executors.podman_run_args("/w", ["true"], uid=994, gid=984)
        self.assertIn("994:984", args)
        self.assertEqual(args[args.index("--user") + 1], "994:984")
        source = self.read("runner", "executors.py")
        self.assertIn('"agent", "--local"', source)


class CodexSafetyTests(unittest.TestCase):
    def read(self, *parts):
        with open(os.path.join(ROOT, *parts), encoding="utf-8") as handle:
            return handle.read()

    def test_reviewer_agent_is_read_only_and_oauth_only(self):
        text = self.read("runner", "config", "openclaw-coder.json5.template")
        block = text[text.index("reviewer: {"):text.index("      coder: {")]
        for item in ('workspaceAccess: "ro"', 'profile: "minimal"', 'alsoAllow: ["read", "ls"]', 'exec: { security: "deny"', "elevated: { enabled: false }",
                     'agentRuntime: { id: "openclaw" }'):
            self.assertIn(item, block)
        for denied in ("exec", "process", "write", "edit", "apply_patch", "group:web", "gateway", "cron", "sessions_spawn", "message"):
            self.assertIn('"%s"' % denied, block)
        for forbidden in ("api_key", "apiKey", "OPENAI_API_KEY", "paste-api-key", 'mode: "off"'):
            self.assertNotIn(forbidden, block)
        self.assertIn('ownership: "explicit"', text)

    def test_no_openai_api_key_anywhere_except_the_stripping_and_checks(self):
        allowed = {"executors.py", "verify-codex.sh", "test_runner.py", "test_snapshot.py", "test_quota.py", "test_reviews.py"}
        for folder, _, files in os.walk(ROOT):
            if "__pycache__" in folder or "node_modules" in folder:
                continue
            for name in files:
                if name == "package-lock.json" or name in allowed:
                    continue
                with open(os.path.join(folder, name), encoding="utf-8", errors="ignore") as handle:
                    text = handle.read()
                self.assertNotIn("OPENAI_API_KEY", text, os.path.join(folder, name))
                self.assertNotIn("CODEX_API_KEY", text, os.path.join(folder, name))

    def test_coder_cli_never_targets_the_status_gateway(self):
        text = self.read("runner", "config", "openclaw-coder.json5.template")
        self.assertIn("port: 18799", text)
        self.assertNotIn("18789", text)

    def test_verify_codex_masks_email_and_reads_model_from_json_and_json5(self):
        import re, subprocess
        text = self.read("runner", "deploy", "verify-codex.sh")
        self.assertIn("<e-mail>", text)
        self.assertIn("--agent reviewer", text.split('MODELS="$(')[1].split("\n")[0])
        pattern = re.search(r"re\.search\(r\"(.*?)\",t,re\.S\)", text).group(1).replace('\\"', '"')
        for sample in ('{"agents": {"entries": {"reviewer": {"name": "x", "model": "openai/m1", "models": {}}}}}',
                       'reviewer: { name: "x", model: "openai/m1", models: {} }'):
            self.assertEqual(re.search(pattern, sample, re.S).group(1), "openai/m1")
        masked = subprocess.run(["sed", "-E", "s/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/<e-mail>/g"], input="Profil openai:max.muster@example.org ok",
                                capture_output=True, text=True).stdout
        self.assertNotIn("example.org", masked)

    def test_login_uses_device_code_oauth_for_reviewer_only(self):
        text = self.read("runner", "deploy", "codex-login.sh")
        self.assertIn("--provider openai --device-code --agent reviewer", text)
        self.assertNotIn("paste", text)
        self.assertNotIn("paste-api-key", text)
        self.assertNotIn("--method api", text)

    def test_reviews_config_limits(self):
        cfg = json.loads(self.read("runner", "config", "runner.json"))
        self.assertEqual(cfg["reviews"]["limit_percent"], 80)
        self.assertEqual(cfg["reviews"]["max_rounds"], 3)
        self.assertGreaterEqual(cfg["reviews"]["safety_margin_percent"], 5)
        self.assertNotIn("mode", cfg["reviews"])


if __name__ == "__main__":
    unittest.main()
