"""Statische Prüfungen für infra/openclaw: Units, Skripte, Konfigurationsvorlage, Lockdatei, Allowlist, Geheimnisse."""

import json
import os
import re
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DEPLOY = os.path.join(ROOT, "deploy")
sys.path.insert(0, os.path.join(ROOT, "egress-proxy"))
import egress_proxy as ep  # noqa: E402


def read(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as handle:
        return handle.read()


def unit_lines(name):
    return [line.strip() for line in read("deploy", name).splitlines() if line.strip() and not line.lstrip().startswith("#")]


class UnitTests(unittest.TestCase):
    COMMON = [
        "NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes", "PrivateTmp=yes", "PrivateDevices=yes",
        "ProtectKernelTunables=yes", "ProtectKernelModules=yes", "ProtectControlGroups=yes", "RestrictNamespaces=yes",
        "LockPersonality=yes", "CapabilityBoundingSet=", "SystemCallFilter=@system-service", "SystemCallFilter=~@privileged",
        "UMask=0077", "Restart=on-failure", "WantedBy=multi-user.target", "MemoryMax=", "CPUQuota=", "TasksMax=",
    ]

    def test_common_hardening_in_both_units(self):
        for name in ("gt-ads-openclaw.service", "gt-ads-egress-proxy.service"):
            lines = unit_lines(name)
            for item in self.COMMON:
                self.assertTrue(any(line.startswith(item) for line in lines), "%s: %s fehlt" % (name, item))
            for forbidden in ("Ports=", "ExecStartPost", "PermissionsStartOnly", "User=root", "AmbientCapabilities=CAP"):
                self.assertFalse(any(line.startswith(forbidden) for line in lines), "%s: %s" % (name, forbidden))

    def test_openclaw_unit_network_boundary_and_identity(self):
        lines = unit_lines("gt-ads-openclaw.service")
        for item in ("User=openclaw", "Group=openclaw", "IPAddressDeny=any", "IPAddressAllow=localhost",
                     "ExecStartPre=+/opt/openclaw/bin/guard-no-double-polling.sh openclaw",
                     "ExecStart=/opt/openclaw/bin/start-gateway.sh", "ReadOnlyPaths=/opt/openclaw",
                     "StateDirectory=openclaw", "MemoryDenyWriteExecute=no", "Environment=NODE_USE_ENV_PROXY=1"):
            self.assertIn(item, lines)
        for cred in ("telegram_bot_token", "deepseek_api_key", "gateway_token"):
            self.assertTrue(any(line.startswith("LoadCredential=%s:/etc/gt-ads/openclaw-credentials/" % cred) for line in lines), cred)
        self.assertTrue(any(line.startswith("InaccessiblePaths=") and "/srv" in line and "/etc/gt-ads/credentials" in line for line in lines))
        self.assertTrue(any(line.startswith("HTTPS_PROXY") or "HTTPS_PROXY=http://127.0.0.1:3128" in line for line in lines))
        # MemoryDenyWriteExecute=no ist nur wegen V8-JIT zulässig und muss begründet sein
        self.assertIn("V8", read("deploy", "gt-ads-openclaw.service"))

    def test_proxy_unit_identity_and_no_secrets(self):
        lines = unit_lines("gt-ads-egress-proxy.service")
        for item in ("User=gtads-egress", "RestrictAddressFamilies=AF_INET AF_INET6", "MemoryDenyWriteExecute=yes"):
            self.assertIn(item, lines)
        self.assertFalse(any(line.startswith("LoadCredential") for line in lines))
        self.assertTrue(any("--listen 127.0.0.1:3128" in line for line in lines))


class ScriptTests(unittest.TestCase):
    SCRIPTS = ("install.sh", "switch-telegram-to-openclaw.sh", "uninstall.sh", "verify.sh",
               "start-gateway.sh", "guard-no-double-polling.sh", "check-tools.sh", "sync-status-docs.sh", "install-and-switch.sh", "remove-python-gateway.sh", "diagnose-openclaw.sh", "set-telegram-flag.sh", "setup-podman-sandbox.sh")
    FORBIDDEN = re.compile(r"\b(ufw|iptables|nft|firewall-cmd|visudo|NOPASSWD|usermod|passwd|chpasswd|setcap)\b|curl[^|\n]*\|\s*(ba)?sh|docker\.sock|--privileged")

    def test_all_scripts_basics(self):
        for name in self.SCRIPTS:
            text = read("deploy", name)
            code = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))
            self.assertTrue(text.startswith("#!/usr/bin/env bash\n"), name)
            self.assertIn("set -Eeuo pipefail", text, name)
            self.assertNotIn("set -x", text, name)
            self.assertNotIn("\r", text, name)
            self.assertIsNone(self.FORBIDDEN.search(code), "%s: %s" % (name, self.FORBIDDEN.search(code)))

    def test_privileged_scripts_have_dry_run(self):
        for name in ("install.sh", "switch-telegram-to-openclaw.sh", "uninstall.sh"):
            self.assertIn("--dry-run", read("deploy", name), name)

    def test_install_creates_unprivileged_users_only(self):
        text = read("deploy", "install.sh")
        for user in ("openclaw", "gtads-egress"):
            line = [l for l in text.splitlines() if "useradd" in l and user in l]
            self.assertEqual(len(line), 1, user)
            self.assertIn("--system", line[0])
            self.assertIn("/usr/sbin/nologin", line[0])
            self.assertNotRegex(line[0], r"(-G|--groups|--gid\s+0|-u\s+0\b)")
        self.assertNotIn("adduser", text)

    def test_install_pins_and_verifies_downloads(self):
        text = read("deploy", "install.sh")
        sha = re.search(r"NODE_SHA256=([0-9a-f]+)", text).group(1)
        self.assertEqual(len(sha), 64)
        self.assertIn("sha256sum -c", text)
        self.assertRegex(text, r"NODE_VERSION=v24\.\d+\.\d+")
        version = re.search(r"OPENCLAW_VERSION=([0-9.]+)", text).group(1)
        with open(os.path.join(ROOT, "package-lock.json"), encoding="utf-8") as handle:
            lock = json.load(handle)
        self.assertEqual(lock["packages"]["node_modules/openclaw"]["version"], version)
        self.assertIn("npm ci", text)
        self.assertNotIn("npm install", text.replace("plugins install", ""))
        self.assertIn("openclaw/openclaw.mjs", text)

    def test_switch_never_leaves_two_pollers_and_never_restores_python(self):
        switch = read("deploy", "switch-telegram-to-openclaw.sh")
        base = switch.index('echo "1/4')  # Hauptablauf (die Fehlerfunktion davor startet Python nie)
        order = [switch.index(x, base) for x in ("systemctl stop gt-ads-telegram", "systemctl stop gt-ads-openclaw",
                                                 "set-telegram-flag.sh\" true", "systemctl start gt-ads-openclaw")]
        self.assertEqual(order, sorted(order))
        self.assertIn("systemctl disable gt-ads-telegram", switch)
        self.assertIn("trap failsafe ERR", switch)
        self.assertNotIn("config set", switch)  # kein CLI-Schreibzugriff bei laufendem Gateway
        for name in ("switch-telegram-to-openclaw.sh", "uninstall.sh", "install.sh", "verify.sh"):
            code = read("deploy", name)
            self.assertNotRegex(code, r"systemctl (start|enable)[^\n]*gt-ads-telegram", name)  # Python-Gateway nie wieder starten
        self.assertFalse(os.path.exists(os.path.join(DEPLOY, "rollback-telegram-to-python.sh")))

    def test_set_telegram_flag_helper(self):
        import subprocess, tempfile
        template = read("config", "openclaw.json5.template").replace("__ALLOWED_USER_ID__", "1")
        samples = (template.replace("__TELEGRAM_ENABLED__", "false"),
                   '{"channels": {"telegram": {"enabled": false, "dmPolicy": "allowlist"}}, "bindings": [{"match": {"channel": "telegram"}}]}')
        for content in samples:
            with tempfile.TemporaryDirectory() as tmp:
                cfg = os.path.join(tmp, "c")
                with open(cfg, "w", encoding="utf-8") as handle:
                    handle.write(content)
                for value in ("true", "false"):
                    subprocess.run(["bash", os.path.join(DEPLOY, "set-telegram-flag.sh"), value], check=True, capture_output=True,
                                   env=dict(os.environ, OPENCLAW_CFG=cfg))
                    with open(cfg, encoding="utf-8") as handle:
                        self.assertRegex(handle.read(), r"telegram\"?\s*:\s*\{[^{}]*?enabled\"?\s*:\s*" + value)
                with open(cfg, "w", encoding="utf-8") as handle:
                    handle.write("{}")
                bad = subprocess.run(["bash", os.path.join(DEPLOY, "set-telegram-flag.sh"), "true"], capture_output=True,
                                     env=dict(os.environ, OPENCLAW_CFG=cfg))
                self.assertNotEqual(bad.returncode, 0)  # ohne Telegram-Block nichts aendern, Fehler melden

    def test_secret_handling(self):
        for name in self.SCRIPTS:
            text = read("deploy", name)
            self.assertNotRegex(text, r"(?m)^\s*(echo|printf)\b[^\n|>]*\$\{?(OPENCLAW_GATEWAY_TOKEN|DEEPSEEK_API_KEY)\b(?!.*(curl|\|\s*curl|>\s*))", name)
        self.assertIn("tools.effective", read("deploy", "check-tools.sh"))
        self.assertIn("-K -", read("deploy", "verify.sh"))
        self.assertIn("umask 077", read("deploy", "install.sh"))


class ConfigTests(unittest.TestCase):
    def test_template_security_settings(self):
        text = read("config", "openclaw.json5.template")
        for item in ('bind: "loopback"', 'mode: "token"', 'dmPolicy: "allowlist"', 'groupPolicy: "disabled"', "elevated: { enabled: false }",
                     'security: "deny"', "catalogRefresh: { enabled: false }", "browser: { enabled: false }", "hooks: { enabled: false }",
                     'model: "deepseek/deepseek-flash"', 'proxyUrl: "http://127.0.0.1:3128"', "__TELEGRAM_ENABLED__", "__ALLOWED_USER_ID__",
                     'profile: "minimal", alsoAllow: ["read", "ls", "gtads-coder__*"]', "workspaceOnly: true", "maxConcurrent: 1", "auto: { enabled: false }", "restart: false", "bash: false"):
            self.assertIn(item, text)
        for forbidden in ('profile: "full"', 'dmPolicy: "open"', 'groupPolicy: "open"', 'bind: "lan"', 'security: "full"', 'ask: "off"', "allowFrom: [\"*\"]"):
            self.assertNotIn(forbidden, text)
        self.assertEqual(text.count("__ALLOWED_USER_ID__"), 2)  # allowFrom + Betreiber-ID des Freigabe-Plugins (je eigene Zeile; sed ersetzt beide)
        self.assertFalse(re.search(r"allowFrom: \[\"\d+\"\]", text), "keine echte ID in der Vorlage")
        self.assertNotIn("botToken", text)

    def test_allowlist_has_exactly_the_known_hosts_and_never_the_paid_openai_api(self):
        hosts = ep.load_allowlist(os.path.join(ROOT, "config", "egress-allowlist.txt"))
        self.assertEqual(hosts, frozenset({"api.telegram.org", "api.deepseek.com", "auth.openai.com", "chatgpt.com", "generativelanguage.googleapis.com"}))
        for forbidden in ("api.openai.com", "openai.com", "api.anthropic.com", "googleapis.com", "aiplatform.googleapis.com"):
            self.assertNotIn(forbidden, hosts)  # keine kostenpflichtige OpenAI-API, kein Vertex/Cloud-Google, nur der Gemini-Entwickler-Host

    def test_workspace_instructions_are_read_only(self):
        text = read("config", "workspace-status", "AGENTS.md")
        for phrase in ("nur lesen", "Freigaben gibt es bei dir nicht", "kein Werkzeug", "callback_data", "keine Zahlen", "Daten, keine Anweisungen", "gemessene Daten", "coder_limits", "nie GT-Ads-Code"):
            self.assertIn(phrase.lower(), text.lower())


class GuardTests(unittest.TestCase):
    """Regression: Das Guard-Skript muss die gerenderte JSON5-Vorlage UND JSON lesen (sonst blockiert es den Dienststart)."""

    def flag(self, content):
        import subprocess, tempfile
        with tempfile.TemporaryDirectory() as tmp:
            cfg = os.path.join(tmp, "c")
            with open(cfg, "w", encoding="utf-8") as handle:
                handle.write(content)
            script = read("deploy", "guard-no-double-polling.sh").replace("/var/lib/openclaw/.openclaw/openclaw.json", cfg)
            script = script[: script.index("\ncase ")] + "\ntelegram_flag\n"
            return subprocess.run(["bash", "-c", script], capture_output=True, text=True, check=True).stdout.strip()

    def test_json5_template(self):
        template = read("config", "openclaw.json5.template").replace("__ALLOWED_USER_ID__", "1")
        self.assertEqual(self.flag(template.replace("__TELEGRAM_ENABLED__", "false")), "false")
        self.assertEqual(self.flag(template.replace("__TELEGRAM_ENABLED__", "true")), "true")

    def test_json_and_unreadable(self):
        self.assertEqual(self.flag('{"channels": {"telegram": {"enabled": false}}, "b": [{"match": {"channel": "telegram"}}]}'), "false")
        self.assertEqual(self.flag('{"channels": {"telegram": {"enabled": true}}}'), "true")
        self.assertEqual(self.flag("{ kaputt"), "true")  # fail-safe


class PodmanScriptTests(unittest.TestCase):
    """Regression: Die Grenztests duerfen nie 'Befehl nicht gefunden' als bestandenen Negativtest werten."""

    def test_boundary_tests_use_expect_with_positive_controls(self):
        text = read("deploy", "setup-podman-sandbox.sh")
        body = text[text.index('echo "4/5'):text.index('echo "5/5')]
        self.assertNotIn("bash -c", body)            # Funktionen (as_coder) sind in bash -c nicht sichtbar
        self.assertIn("expect()", body)
        self.assertIn("Positivkontrolle", body)
        self.assertIn("Kontrolle: /etc/hostname", body)
        self.assertNotRegex(body, r'(?m)^\s*chk\b')  # alte, fehleranfaellige Pruefhilfe



class SupplyChainTests(unittest.TestCase):
    def test_lockfile_integrity_and_registry(self):
        with open(os.path.join(ROOT, "package-lock.json"), encoding="utf-8") as handle:
            packages = json.load(handle)["packages"]
        for path, meta in packages.items():
            if not path or meta.get("link"):
                continue
            self.assertTrue(meta.get("integrity") or meta.get("inBundle"), path)
            if meta.get("resolved"):
                self.assertTrue(meta["resolved"].startswith("https://registry.npmjs.org/"), path)

    def test_package_json_pins_exact_version_and_script_policy(self):
        with open(os.path.join(ROOT, "package.json"), encoding="utf-8") as handle:
            package = json.load(handle)
        self.assertEqual(package["dependencies"], {"openclaw": "2026.11.2"})  # exakte Version, kein ^/~
        npmrc = read(".npmrc")
        self.assertIn("allow-scripts=openclaw", npmrc)
        self.assertNotIn("dangerously", npmrc)


class SecretScanTests(unittest.TestCase):
    def test_no_secrets_or_real_identifiers(self):
        patterns = [re.compile(r"\b\d{8,10}:[A-Za-z0-9_-]{35}\b"), re.compile(r"\bsk-[A-Za-z0-9]{20,}\b"),
                    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"), re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.]+\b"),
                    re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")]
        allowed_ip = {"127.0.0.1", "0.0.0.0"}
        for folder, _, files in os.walk(ROOT):
            if "__pycache__" in folder or os.sep + "tests" in folder or "node_modules" in folder:
                continue
            for name in files:
                if name == "package-lock.json":
                    continue
                with open(os.path.join(folder, name), encoding="utf-8", errors="ignore") as handle:
                    text = handle.read()
                for pattern in patterns:
                    for match in pattern.finditer(text):
                        if match.group(0) in allowed_ip:
                            continue
                        self.fail("%s: %s" % (os.path.join(folder, name), match.group(0)[:30]))


if __name__ == "__main__":
    unittest.main()


class IsolationConfigTests(unittest.TestCase):
    """Betreiber 2026-11-11: getrennte Identitaeten, kein gemeinsamer Zugriff, Freigabe nur per Schaltflaeche."""

    def unit(self, name):
        return read("runner", "deploy", name)

    def test_planner_unit_identity_and_hardening(self):
        u = self.unit("gt-ads-planner.service")
        for item in ("User=ocplan", "SupplementaryGroups=gtads-plan-ctl", "NoNewPrivileges=yes", "ProtectSystem=strict", "PrivateTmp=yes",
                     "ReadWritePaths=/var/lib/gt-ads-plan /var/lib/gt-ads-release", "IPAddressDeny=any", "CapabilityBoundingSet=\n", "-/var/lib/occoder",
                     "MemoryMax=3G", "OOMPolicy=continue"):
            self.assertIn(item, u)
        self.assertNotIn("SupplementaryGroups=openclaw", u)
        self.assertIn("--max-old-space-size=1536", read("runner", "planner_daemon.py"))
        self.assertNotIn("deepseek_api_key", u.lower())

    def test_runner_unit_hides_planning_area(self):
        u = self.unit("gt-ads-coding-runner.service")
        self.assertIn("-/var/lib/gt-ads-plan", u)
        self.assertIn("-/etc/gt-ads/planner-credentials", u)
        self.assertNotIn("gtads-plan-ctl", u)

    def test_planner_sockets_have_own_group(self):
        cfg = json.loads(read("runner", "config", "planner.json"))
        self.assertEqual(cfg["socket_group"], "gtads-plan-ctl")
        self.assertTrue(cfg["release_dir"] != cfg["home"] and not cfg["release_dir"].startswith(cfg["home"]))

    def test_planner_codex_has_no_tools_and_no_api_key(self):
        t = read("runner", "config", "openclaw-planner.json5.template")
        for item in ('"read"', '"exec"', '"write"', '"message"', 'sandbox: { mode: "off" }', 'security: "deny"'):
            self.assertIn(item, t)
        self.assertNotIn("deepseek", t)
        self.assertNotIn("API_KEY", t)

    def test_gateway_template_loads_plugin_dm_only(self):
        t = read("config", "openclaw.json5.template")
        self.assertIn('"gtads-freigabe": { enabled: true, config: { operatorId: "__ALLOWED_USER_ID__" } }', t)
        self.assertIn('inlineButtons: "dm"', t)
        self.assertIn("GTADS_PLANNER_SOCK", t)

    def test_isolation_verifier_covers_required_cases(self):
        v = self.unit("verify-isolation.sh")
        for item in ("Planungsbereich auflisten", "Codex-Anmeldung des Planers lesen", "im Freigabebereich schreiben", "gemeinsam beschreibbar",
                     "Git-Repository im Planungsbereich", "Journal des Planers", "im DeepSeek-Container", "root-Bestaetigung als occoder", "InaccessiblePaths"):
            self.assertIn(item, v)


class DeployCompletenessTests(unittest.TestCase):
    def test_install_scripts_copy_every_imported_runner_module(self):
        import re as _re
        here = os.path.join(ROOT, "runner")
        local = {f[:-3] for f in os.listdir(here) if f.endswith(".py")}
        needed = set()
        for name in ("runner_daemon.py", "planner_daemon.py", "runner_core.py", "planner_core.py", "executors.py", "review_core.py", "stack.py", "mcp_server.py"):
            src = open(os.path.join(here, name)).read()
            needed |= {m for m in _re.findall(r"^\s*(?:from|import) ([a-z_]+)", src, _re.M) if m in local}
        coder = read("runner", "deploy", "install-coder.sh")
        planner = read("runner", "deploy", "install-planner.sh")
        for mod in sorted(needed):
            self.assertIn(mod + ".py", coder, "install-coder.sh kopiert %s.py nicht" % mod)
        for mod in ("planner_core", "planner_daemon", "approvals", "redact", "runner_daemon", "runner_core", "executors", "quota", "notifier"):
            self.assertIn(mod + ".py", planner, "install-planner.sh kopiert %s.py nicht" % mod)


class RunnerUnitPodmanTests(unittest.TestCase):
    def test_userns_inside_unit(self):
        u = read("runner", "deploy", "gt-ads-coding-runner.service")
        self.assertIn("CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_SETFCAP CAP_DAC_OVERRIDE CAP_SYS_ADMIN", u)
        self.assertIn("ExecStartPre=-/usr/bin/podman system migrate", u)
        self.assertIn("ExecStartPost=-/usr/bin/podman unshare true", u)
        self.assertIn("PrivateTmp=yes", u)
        self.assertIn("NoNewPrivileges=no", u)
        self.assertIn("ProtectKernelLogs=no", u)        # sonst kein /proc im Container (belegt 2026-11-11)
        self.assertIn("ProtectKernelModules=yes", u)


class DeploySudoTests(unittest.TestCase):
    def test_sudo_rule_only_for_wrapper(self):
        t = read("deploy", "setup-deploy-sudo.sh")
        self.assertIn("ALL=(root) NOPASSWD: /usr/local/sbin/gtads-deploy\\n", t)
        self.assertEqual(t.count("NOPASSWD"), 1)
        self.assertIn("visudo -cf", t)
        self.assertIn("--remove", t)

    def test_wrapper_has_no_free_command_execution(self):
        w = read("deploy", "gtads-deploy")
        self.assertNotIn("shell=True", w)
        self.assertNotIn("os.system", w)
        for fpr in ("5DE3E0509C47EA3CF04A42D34AEE18F83AFDEB23", "968479A1AFF927E37D1A566BB5690EEEBB952194"):
            self.assertIn(fpr, w)
        self.assertNotIn('"devenv"', w)  # Artefakte liegen benutzerbeschreibbar -> nicht ueber den Wrapper
