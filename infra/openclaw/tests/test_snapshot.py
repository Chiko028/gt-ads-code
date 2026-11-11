"""Tests fuer Schnappschuss, sicheres Wiederherstellen und objektive Dateipruefung (echte Dateioperationen, ohne Podman)."""

import hashlib
import io
import os
import shutil
import sys
import tarfile
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "runner"))
from executors import PodmanOpenClawExecutor, podman_run_args  # noqa: E402


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.ws = os.path.join(self.tmp, "workspace")
        os.makedirs(self.ws)
        with open(os.path.join(self.ws, "app.py"), "w") as handle:
            handle.write("a = 1\nb = 2\nc = 3\n")
        cfg = {"workspace_dir": self.ws, "artifacts_dir": os.path.join(self.tmp, "art"), "specs_root": self.tmp, "home": self.tmp}
        self.ex = PodmanOpenClawExecutor(cfg, {})
        self.ex.head_commit = lambda: "abc1234"
        self.ex.cleanup = lambda job: None  # kein Podman im Test
        self.stale = os.path.join(self.tmp, ".openclaw", "sandboxes", "workspace-alt")
        os.makedirs(self.stale)

    @staticmethod
    def sha(path):
        with open(path, "rb") as handle:
            return hashlib.sha256(handle.read()).hexdigest()

    def test_snapshot_is_hashed_readonly_and_restorable(self):
        snap = self.ex.snapshot({"id": 7})
        self.assertEqual(snap["commit"], "abc1234")
        self.assertEqual(self.sha(snap["path"]), snap["sha256"])
        self.assertEqual(os.stat(snap["path"]).st_mode & 0o777, 0o400)
        os.remove(os.path.join(self.ws, "app.py"))
        self.ex.restore(snap)
        self.assertFalse(os.path.exists(os.path.dirname(self.stale)))  # veraltete Sandbox-Kopien entfernt
        with open(os.path.join(self.ws, "app.py")) as handle:
            self.assertEqual(handle.read(), "a = 1\nb = 2\nc = 3\n")

    def test_tampered_snapshot_is_rejected(self):
        snap = self.ex.snapshot({"id": 7})
        os.chmod(snap["path"], 0o600)
        with open(snap["path"], "ab") as handle:
            handle.write(b"x")
        with self.assertRaises(RuntimeError):
            self.ex.restore(snap)

    def test_malicious_tar_cannot_escape_workspace(self):
        evil = os.path.join(self.tmp, "evil.tar")
        outside = os.path.join(self.tmp, "ausserhalb.txt")
        with tarfile.open(evil, "w") as tar:
            data = b"boese"
            info = tarfile.TarInfo("ws/../../ausserhalb.txt")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
            link = tarfile.TarInfo("ws/link")
            link.type = tarfile.SYMTYPE
            link.linkname = "/etc"
            tar.addfile(link)
        digest = self.sha(evil)
        with self.assertRaises(Exception):
            self.ex.restore({"path": evil, "sha256": digest, "commit": "x"})
        self.assertFalse(os.path.exists(outside))

    def test_file_lines_objective_checks(self):
        self.assertEqual(self.ex.file_lines("app.py"), 3)
        self.assertIsNone(self.ex.file_lines("fehlt.py"))
        self.assertIsNone(self.ex.file_lines("../ausserhalb"))
        os.symlink("/etc/hostname", os.path.join(self.ws, "link.txt"))
        self.assertIsNone(self.ex.file_lines("link.txt"))
        os.makedirs(os.path.join(self.ws, "ordner"))
        self.assertIsNone(self.ex.file_lines("ordner"))

    def test_reviewer_environment_has_no_api_keys(self):
        from executors import CodexReviewer
        rev = CodexReviewer({"openclaw_node": "n", "openclaw_js": "j", "home": self.tmp},
                            {"OPENAI_API_KEY": "x", "CODEX_API_KEY": "y", "DEEPSEEK_API_KEY": "z", "HTTPS_PROXY": "p", "PATH": "/usr/bin"})
        self.assertEqual(set(rev.env), {"HTTPS_PROXY", "PATH"})


if __name__ == "__main__":
    unittest.main()
