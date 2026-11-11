"""gtads-deploy: installiert nur von GitHub signierte, gemergte Staende; lehnt lokale/unsignierte Commits und Zurueckrollen ab.
Laeuft ohne root: runuser wird simuliert, Pfade zeigen in ein Temp-Verzeichnis; Quelle ist ein Klon des echten Repositorys."""

import importlib.machinery
import importlib.util
import os
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(__file__)
WRAPPER = os.path.join(HERE, "..", "deploy", "gtads-deploy")
REAL = "/srv/taxiwerbung/app/gt-ads"


def load():
    loader = importlib.machinery.SourceFileLoader("gtads_deploy", WRAPPER)
    spec = importlib.util.spec_from_loader("gtads_deploy", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


@unittest.skipUnless(shutil.which("gpg") and os.path.isdir(os.path.join(REAL, ".git")), "gpg/Repository fehlt")
class WrapperTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.src = os.path.join(self.tmp, "src")
        subprocess.run(["git", "clone", "-q", "--no-checkout", REAL, self.src], check=True)
        subprocess.run(["git", "-C", self.src, "update-ref", "refs/remotes/origin/main", "refs/remotes/origin/HEAD"], check=False)
        sha = subprocess.run(["git", "-C", REAL, "rev-parse", "origin/main"], capture_output=True, text=True, check=True).stdout.strip()
        subprocess.run(["git", "-C", self.src, "update-ref", "refs/remotes/origin/main", sha], check=True)
        self.main_sha = sha
        self.m = load()
        self.m.REPO = self.src
        self.m.STATE = os.path.join(self.tmp, "state")
        self.m.KEYRING = os.path.join(HERE, "..", "deploy", "github-web-flow.gpg")
        self.m.LOG = os.path.join(self.tmp, "log")
        real_run = subprocess.run

        def fake_run(args, *a, **kw):  # runuser -u X -- cmd  ->  cmd (Test laeuft ohne root)
            if args[:1] == ["runuser"]:
                args = args[args.index("--") + 1:]
            return real_run(args, *a, **kw)
        self.m.subprocess.run = fake_run
        self.addCleanup(setattr, self.m.subprocess, "run", real_run)
        self.m.os.chown = lambda *a: None

    def test_merged_main_is_accepted(self):
        bare, sha = self.m.fetch_verified()
        self.assertEqual(sha, self.main_sha)
        work = self.m.export(bare, sha)
        self.assertTrue(os.path.isfile(os.path.join(work, "infra/openclaw/runner/deploy/install-coder.sh")))

    def test_local_unsigned_commit_is_rejected(self):
        g = ["git", "-C", self.src, "-c", "user.name=x", "-c", "user.email=x@invalid"]
        tree = subprocess.run(g + ["rev-parse", self.main_sha + "^{tree}"], capture_output=True, text=True, check=True).stdout.strip()
        evil = subprocess.run(g + ["commit-tree", tree, "-p", self.main_sha, "-m", "lokal (#99)"], capture_output=True, text=True, check=True).stdout.strip()
        subprocess.run(g + ["update-ref", "refs/remotes/origin/main", evil], check=True)
        with self.assertRaises(SystemExit):
            self.m.fetch_verified()
        self.assertIn("NICHT von GitHub signiert", open(self.m.LOG).read())

    def test_rollback_is_rejected(self):
        self.m.fetch_verified()
        os.makedirs(self.m.STATE, exist_ok=True)
        with open(os.path.join(self.m.STATE, "deployed"), "w") as h:
            h.write(self.main_sha + "\n")
        older = subprocess.run(["git", "-C", self.src, "rev-parse", self.main_sha + "~3"], capture_output=True, text=True, check=True).stdout.strip()
        subprocess.run(["git", "-C", self.src, "update-ref", "refs/remotes/origin/main", older], check=True)
        with self.assertRaises(SystemExit):
            self.m.fetch_verified()
        self.assertIn("kein Zurueckrollen", open(self.m.LOG).read())

    def test_fixed_actions_only(self):
        self.m.os.geteuid = lambda: 0
        for argv in (["install", "devenv"], ["install", "../../x"], ["journal", "sshd"], ["journal", "runner", "9999"], ["bash"], ["install"]):
            with self.assertRaises(SystemExit, msg=argv):
                self.m.main(argv)

    def test_journal_redacts(self):
        self.assertNotIn("hans@example.com", self.m.redact("user hans@example.com token=abcdef123456"))
        self.assertNotIn("abcdef123456", self.m.redact("token=abcdef123456"))


if __name__ == "__main__":
    unittest.main()
