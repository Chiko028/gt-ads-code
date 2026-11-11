"""Stack-Werkzeug fuer Plaene (WP-013): Arbeitsstand aus dem Integrationsstand, Paketpruefung, Tests mit PostgreSQL, kontrollierte Uebernahme.

Alle Befehle auf Daten des Agenten (git, npm, Tests) laufen in einem Wegwerf-Container: kein Netz, Root-FS schreibgeschuetzt, ohne Capabilities,
nicht root, nur die noetigen Verzeichnisse eingebunden. Git-Hooks und git-Konfiguration des Agenten werden nie auf dem Host ausgefuehrt.
Der Agent bekommt keinen Zugriff auf das Integrations-Repository; nur der Runner uebernimmt Ergebnisse (nur Schnellvorlauf, nur erlaubte Pfade,
nur nach bestandenen Tests).
"""

import json
import os
import shutil
import subprocess
import tarfile

import supply_check

AGENT_NAME = "GT-Ads Coding-Agent"
GIT_ENV = ["-e", "HOME=/tmp/home", "-e", "GIT_CONFIG_GLOBAL=/dev/null", "-e", "GIT_CONFIG_SYSTEM=/dev/null", "-e", "GIT_TERMINAL_PROMPT=0"]
GIT_SAFE = ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=always"]
ALWAYS_ALLOWED = ("docs/fortschritt/",)


class StackError(Exception):
    """Fehler mit nutzerlesbarer Meldung (wird dem Agenten als Korrekturhinweis gezeigt; ohne Geheimnisse)."""


def path_violations(changed, allowed):
    """changed: Liste relativer Dateipfade; allowed: Liste erlaubter Praefixe/Dateien. Rueckgabe: Liste unerlaubter Pfade."""
    ok = tuple(allowed) + ALWAYS_ALLOWED
    bad = []
    for path in changed:
        norm = os.path.normpath(path)
        if norm.startswith(("/", "..")) or "\x00" in path:
            bad.append(path)
        elif not any(norm == a.rstrip("/") or norm.startswith(a if a.endswith("/") else a + "/") for a in ok):
            bad.append(path)
    return bad


class StackToolkit:
    def __init__(self, cfg, runner=None):
        self.cfg = cfg
        self.podman = cfg.get("podman", "podman")
        self.image = cfg.get("dev_image", "gtads-dev:2")
        self.supply = cfg["supply_dir"]
        self.integration_dir = cfg["integration_dir"]
        self.workspace = cfg["workspace_dir"]
        self.uid, self.gid = cfg.get("uid", os.getuid()), cfg.get("gid", os.getgid())
        self.env = cfg.get("env") or dict(os.environ)
        self.run_cmd = runner or self._run

    # -- Prozess ---------------------------------------------------------------------------------------
    def _run(self, args, timeout):
        proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=self.env, timeout=timeout)
        return proc.returncode, proc.stdout.decode("utf-8", "replace")

    def container_args(self, mounts, cmd, network="none", memory="3g", pids=512):
        args = [self.podman, "run", "--rm", "--network", network, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                "--userns", "keep-id", "--user", "%d:%d" % (self.uid, self.gid), "--pids-limit", str(pids), "--memory", memory,
                "--tmpfs", "/tmp:rw,size=1g", "-w", "/work" if any(m[1] == "/work" for m in mounts) else "/tmp"] + GIT_ENV
        for host, cont, mode in mounts:
            args += ["-v", "%s:%s:%s" % (host, cont, mode)]
        return args + [self.image] + list(cmd)

    def container(self, mounts, cmd, timeout=600, **kw):
        code, out = self.run_cmd(self.container_args(mounts, cmd, **kw), timeout)
        return code, "\n".join(l for l in out.splitlines() if "level=warning" not in l)

    # -- Integrationsstand ----------------------------------------------------------------------------------
    def repo_path(self, package):
        return os.path.join(self.integration_dir, package + ".git")

    def ensure_integration(self, package, seed_tar):
        """Legt das Integrations-Repository (bare) aus dem Seed-Archiv an, falls es fehlt. Der Seed stammt aus `git archive main` (vom Betreiber/root gespiegelt)."""
        repo = self.repo_path(package)
        if os.path.isdir(repo):
            return repo
        os.makedirs(self.integration_dir, mode=0o700, exist_ok=True)
        seed = os.path.join(self.integration_dir, ".seed-" + package)
        shutil.rmtree(seed, ignore_errors=True)
        os.makedirs(seed, mode=0o700)
        with tarfile.open(seed_tar, "r") as tar:
            tar.extractall(seed, filter="data")
        script = ("set -e; cd /seed && git init -q -b integration && git add -A && git -c user.name=runner -c user.email=runner@invalid commit -q -m 'Ausgangsstand (main)' "
                  "&& git init -q --bare -b integration /int/%s.git && git push -q /int/%s.git integration:integration" % (package, package))
        code, out = self.container([(seed, "/seed", "rw"), (self.integration_dir, "/int", "rw")], ["sh", "-c", script], network="none")
        shutil.rmtree(seed, ignore_errors=True)
        if code != 0:
            shutil.rmtree(repo, ignore_errors=True)
            raise StackError("Integrations-Repository konnte nicht angelegt werden: %s" % out[-300:])
        return repo

    def prepare_unit_workspace(self, package, unit_id):
        repo = self.repo_path(package)
        if not os.path.isdir(repo):
            raise StackError("Integrations-Repository fehlt (zuerst ensure_integration)")
        shutil.rmtree(self.workspace, ignore_errors=True)
        os.makedirs(self.workspace, mode=0o700)
        script = ("set -e; git clone -q --no-hardlinks --branch integration /int/%s.git /work && cd /work && git remote remove origin && "
                  "git checkout -q -b agent/%s && printf 'node_modules/\\ndist/\\n.openclaw/\\nopenclaw-workspace-state.json\\n' >> .git/info/exclude" % (package, unit_id))
        code, out = self.container([(self.workspace, "/work", "rw"), (self.integration_dir, "/int", "ro")], ["sh", "-c", script])
        if code != 0:
            raise StackError("Arbeitsstand konnte nicht angelegt werden: %s" % out[-300:])
        nm = os.path.join(self.supply, "node_modules")
        if os.path.isdir(nm):  # eigene Kopie fuer den Agenten (die Tests des Runners nutzen immer die frische Versorgung)
            shutil.copytree(nm, os.path.join(self.workspace, "node_modules"), symlinks=True)

    # -- Pakete ---------------------------------------------------------------------------------------------
    def bootstrap_deps(self):
        """Prueft die package.json-Dateien gegen die Paketversorgung und erzeugt die Projekt-Lockdatei OFFLINE (Netz: aus).
        Wirft StackError mit verstaendlicher Meldung bei Verstoessen. Rueckgabe: Liste der Hinweise."""
        supply_pkg = supply_check.load(os.path.join(self.supply, "package.json"))
        supply_lock = supply_check.load(os.path.join(self.supply, "package-lock.json"))
        manifests = supply_check.collect_manifests(self.workspace)
        if not manifests:
            return ["keine package.json vorhanden (noch kein Projekt)"]
        problems = supply_check.manifest_violations(supply_pkg, manifests)
        if problems:
            raise StackError("Unzulaessige Abhaengigkeiten:\n" + "\n".join(problems[:20]))
        lock_path = os.path.join(self.workspace, "package-lock.json")
        if not os.path.exists(lock_path):
            shutil.copy(os.path.join(self.supply, "package-lock.json"), lock_path)  # Ausgangspunkt: gepinnte Versorgungs-Lockdatei
        mounts = [(self.workspace, "/work", "rw"), (os.path.join(self.supply, "npm-cache"), "/cache", "O")]
        code, out = self.container(mounts, ["npm", "install", "--package-lock-only", "--offline", "--ignore-scripts", "--cache", "/cache", "--no-audit", "--no-fund"], timeout=300)
        if code != 0:
            raise StackError("Lockdatei konnte offline nicht erzeugt werden (Paket ausserhalb der Versorgung?):\n" + out[-600:])
        problems = supply_check.lock_violations(supply_lock, supply_check.load(lock_path))
        if problems:
            raise StackError("Lockdatei enthaelt Pakete ausserhalb der Paketversorgung:\n" + "\n".join(problems[:20]))
        return []

    # -- Tests ------------------------------------------------------------------------------------------------
    def run_tests(self, cmd, needs_db=True, timeout=900):
        """Fuehrt den Testbefehl mit FRISCHER, schreibgeschuetzter Paketversorgung (Overlay) aus. cmd: Liste (ohne Shell-Interpretation durch den Host)."""
        mounts = [(self.workspace, "/work", "rw"), (os.path.join(self.supply, "node_modules"), "/work/node_modules", "O")]
        full = (["with-postgres"] if needs_db else []) + list(cmd)
        code, out = self.container(mounts, full, timeout=timeout)
        return {"passed": code == 0, "output": out[-4000:]}

    # -- Git im Arbeitsstand ---------------------------------------------------------------------------------
    def commit(self, message):
        msg = "".join(c for c in message if c not in "'\"\\$`\n")[:120]
        git = " ".join(GIT_SAFE)
        script = "cd /work && %s add -A && (%s -c user.name='%s' -c user.email=agent@invalid commit -q -m '%s' || true) && %s rev-parse --short HEAD" % (git, git, AGENT_NAME, msg, git)
        code, out = self.container([(self.workspace, "/work", "rw")], ["sh", "-c", script])
        lines = [l for l in out.strip().splitlines() if l.strip()]
        return lines[-1][:12] if code == 0 and lines else None

    def accept(self, package, unit_id, allowed_paths):
        """Uebernahme in den Integrationsstand: Kandidat holen, Pfade pruefen, nur Schnellvorlauf. Rueckgabe (ok, Meldung)."""
        cand = "candidate/%s" % unit_id
        push = " ".join(GIT_SAFE) + " push -q /int/%s.git HEAD:refs/heads/%s" % (package, cand)
        code, out = self.container([(self.workspace, "/work", "ro"), (self.integration_dir, "/int", "rw")], ["sh", "-c", "cd /work && " + push])
        if code != 0:
            return False, "Kandidat konnte nicht uebertragen werden: " + out[-300:]
        gd = "git --git-dir=/int/%s.git" % package
        code, out = self.container([(self.integration_dir, "/int", "ro")], ["sh", "-c", "%s diff --name-only integration %s" % (gd, cand)])
        changed = [l for l in out.splitlines() if l.strip()] if code == 0 else None
        if changed is None:
            return False, "Aenderungsliste nicht lesbar"
        bad = path_violations(changed, allowed_paths)
        if bad:
            self._drop_candidate(package, cand)
            return False, "Unerlaubte Pfade geaendert: " + ", ".join(bad[:10])
        script = "set -e; %s merge-base --is-ancestor integration %s && %s update-ref refs/heads/integration %s && %s tag -f 'unit-%s' %s" % (gd, cand, gd, cand, gd, unit_id, cand)
        code, out = self.container([(self.integration_dir, "/int", "rw")], ["sh", "-c", script])
        self._drop_candidate(package, cand)
        if code != 0:
            return False, "Kein Schnellvorlauf (Integrationsstand hat sich veraendert?): " + out[-200:]
        return True, "uebernommen"

    def _drop_candidate(self, package, cand):
        self.container([(self.integration_dir, "/int", "rw")], ["sh", "-c", "git --git-dir=/int/%s.git update-ref -d refs/heads/%s || true" % (package, cand)])

    def export_info(self, package):
        code, out = self.container([(self.integration_dir, "/int", "ro")], ["sh", "-c", "git --git-dir=/int/%s.git log --oneline -20 integration" % package])
        return out if code == 0 else ""
