"""Statische Prüfungen (ST-01…ST-07): Standardbibliothek, keine Werkzeuge, feste Hosts, Unit/Skripte, Geheimnisse."""

import ast
import os
import re
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PKG = os.path.join(ROOT, "gtads_tg")
DEPLOY = os.path.join(ROOT, "deploy")


def package_files():
    return sorted(os.path.join(PKG, name) for name in os.listdir(PKG) if name.endswith(".py"))


def parse(path):
    with open(path, "r", encoding="utf-8") as handle:
        return ast.parse(handle.read(), filename=path)


class StaticTests(unittest.TestCase):
    def test_st01_only_standard_library(self):  # ST-01 / AC-06
        stdlib = set(sys.stdlib_module_names)
        for path in package_files():
            for node in ast.walk(parse(path)):
                names = []
                if isinstance(node, ast.Import):
                    names = [alias.name.split(".")[0] for alias in node.names]
                elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                    names = [node.module.split(".")[0]]
                for name in names:
                    self.assertIn(name, stdlib, "%s importiert Nicht-Standardbibliothek: %s" % (os.path.basename(path), name))

    def test_st02_no_forbidden_calls_or_modules(self):  # ST-02 / AC-05
        forbidden_modules = {"subprocess", "ctypes", "socket", "shutil", "pickle", "marshal", "socketserver", "http", "pty",
                             "multiprocessing", "importlib", "runpy", "code", "codeop"}
        forbidden_names = {"eval", "exec", "compile", "__import__", "input"}
        forbidden_os = {"system", "popen", "spawnl", "spawnv", "execv", "execl", "fork", "kill", "setuid", "chmod", "chown"}
        for path in package_files():
            base = os.path.basename(path)
            for node in ast.walk(parse(path)):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        self.assertNotIn(alias.name.split(".")[0], forbidden_modules, "%s: %s" % (base, alias.name))
                if isinstance(node, ast.ImportFrom) and node.module:
                    self.assertNotIn(node.module.split(".")[0], forbidden_modules, "%s: %s" % (base, node.module))
                if isinstance(node, ast.Call):
                    func = node.func
                    if isinstance(func, ast.Name):
                        self.assertNotIn(func.id, forbidden_names, "%s: %s()" % (base, func.id))
                    if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) and func.value.id == "os":
                        self.assertNotIn(func.attr, forbidden_os, "%s: os.%s()" % (base, func.attr))

    def test_st03_file_writes_only_in_state_module(self):  # ST-03 / AC-05
        write_modes = set("wax+")
        write_attrs = {"write_text", "write_bytes", "mkdir", "makedirs", "replace", "rename", "remove", "unlink", "rmdir", "touch"}
        for path in package_files():
            base = os.path.basename(path)
            if base == "state.py":
                continue
            for node in ast.walk(parse(path)):
                if not isinstance(node, ast.Call):
                    continue
                func = node.func
                if isinstance(func, ast.Name) and func.id == "open":
                    mode = None
                    if len(node.args) > 1 and isinstance(node.args[1], ast.Constant):
                        mode = node.args[1].value
                    for kw in node.keywords:
                        if kw.arg == "mode" and isinstance(kw.value, ast.Constant):
                            mode = kw.value.value
                    self.assertFalse(isinstance(mode, str) and write_modes & set(mode), "%s: open(%r)" % (base, mode))
                if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) and func.value.id in {"os", "pathlib"}:
                    self.assertNotIn(func.attr, write_attrs, "%s: %s.%s()" % (base, func.value.id, func.attr))
                if isinstance(func, ast.Attribute):
                    self.assertNotIn(func.attr, {"write_text", "write_bytes"}, "%s: .%s()" % (base, func.attr))

    def test_st04_hosts_are_fixed_constants(self):  # ST-04 / AC-05
        hosts = {}
        for path in package_files():
            base = os.path.basename(path)
            for node in ast.walk(parse(path)):
                if isinstance(node, ast.Constant) and isinstance(node.value, str) and re.search(r"https?://", node.value):
                    hosts.setdefault(base, set()).add(node.value)
        self.assertEqual(hosts.get("telegram.py"), {"https://api.telegram.org"})
        self.assertEqual(hosts.get("deepseek.py"), {"https://api.deepseek.com"})
        self.assertEqual(set(hosts), {"telegram.py", "deepseek.py"})

    def test_st05_systemd_units(self):  # ST-05 / AC-11, AC-12
        required_common = [
            "User=taxiagent", "NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes", "PrivateTmp=yes",
            "PrivateDevices=yes", "ProtectKernelTunables=yes", "ProtectKernelModules=yes", "ProtectControlGroups=yes",
            "RestrictAddressFamilies=AF_INET AF_INET6", "RestrictNamespaces=yes", "LockPersonality=yes",
            "MemoryDenyWriteExecute=yes", "CapabilityBoundingSet=", "SystemCallFilter=@system-service",
            "SystemCallFilter=~@privileged", "InaccessiblePaths=/srv/taxiwerbung /home /root", "MemoryMax=", "CPUQuota=", "TasksMax=",
        ]
        with open(os.path.join(DEPLOY, "gt-ads-telegram.service"), encoding="utf-8") as handle:
            main = handle.read()
        with open(os.path.join(DEPLOY, "gt-ads-telegram-setup.service"), encoding="utf-8") as handle:
            setup = handle.read()
        for name, text in (("main", main), ("setup", setup)):
            lines = [line.strip() for line in text.splitlines() if line.strip() and not line.startswith("#")]
            for item in required_common:
                self.assertTrue(any(line.startswith(item) for line in lines), "%s-Unit: %s fehlt" % (name, item))
            self.assertNotIn("ExecStartPre", text)
            self.assertNotIn("ExecStartPost", text)
            self.assertNotRegex(text, r"(?m)^\s*Ports?=")
        for item in ("LoadCredential=telegram_bot_token:", "LoadCredential=deepseek_api_key:", "Restart=on-failure",
                     "After=network-online.target", "Wants=network-online.target", "WantedBy=multi-user.target",
                     "ReadWritePaths=/srv/taxiagents/telegram/state", "WorkingDirectory=/opt/gt-ads/telegram-gateway"):
            self.assertIn(item, main)
        setup_lines = [line.strip() for line in setup.splitlines() if line.strip() and not line.startswith("#")]
        self.assertNotIn("[Install]", setup_lines)  # Setup-Modus nur manuell, kein Autostart
        self.assertIn("--setup", setup)
        self.assertNotIn("deepseek_api_key", setup)

    def test_st06_scripts(self):  # ST-06 / AC-14, AC-15
        forbidden = re.compile(r"\b(ufw|iptables|nft|firewall-cmd|sshd|useradd|usermod|userdel|adduser|passwd|visudo|docker|curl[^|\n]*\|\s*(ba)?sh)\b")
        for name in ("install.sh", "uninstall.sh", "set-credential.sh"):
            with open(os.path.join(DEPLOY, name), encoding="utf-8") as handle:
                text = handle.read()
            code = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))
            self.assertTrue(text.startswith("#!/usr/bin/env bash\n"), name)
            self.assertIn("set -Eeuo pipefail", text, name)
            self.assertNotIn("set -x", text, name)
            self.assertIsNone(forbidden.search(code), "%s: verbotener Befehl: %s" % (name, forbidden.search(code)))
            self.assertNotIn("\r", text, "CRLF in " + name)
        for name in ("install.sh", "uninstall.sh"):
            with open(os.path.join(DEPLOY, name), encoding="utf-8") as handle:
                self.assertIn("--dry-run", handle.read(), name)
        with open(os.path.join(DEPLOY, "set-credential.sh"), encoding="utf-8") as handle:
            cred = handle.read()
        self.assertIn("read -rsp", cred)
        self.assertNotRegex(cred, r"(?m)^\s*(echo|printf)[^\n]*\$\{?VALUE\b(?!.*(curl|>))", "Wert darf nicht ausgegeben werden")
        self.assertIn("umask 077", cred)
        self.assertIn("chmod 0600", cred)

    def test_st07_no_secrets_or_real_identifiers_in_package(self):  # ST-07 / AC-07
        patterns = [
            re.compile(r"\b\d{8,10}:[A-Za-z0-9_-]{35}\b"),  # Telegram-Token-Format
            re.compile(r"\bsk-[A-Za-z0-9]{20,}\b"),  # DeepSeek-/OpenAI-Schlüsselformat
            re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
            re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.]+\b"),  # E-Mail
            re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"),  # IPv4
        ]
        for folder, _, files in os.walk(ROOT):
            if "__pycache__" in folder or os.sep + "tests" in folder:
                continue
            for name in files:
                with open(os.path.join(folder, name), encoding="utf-8", errors="ignore") as handle:
                    text = handle.read()
                for pattern in patterns:
                    self.assertIsNone(pattern.search(text), "%s: Muster %s" % (os.path.join(folder, name), pattern.pattern))
        with open(os.path.join(ROOT, "config", "telegram-gateway.toml.example"), encoding="utf-8") as handle:
            self.assertIn("allowed_user_id = 0", handle.read())


if __name__ == "__main__":
    unittest.main()
