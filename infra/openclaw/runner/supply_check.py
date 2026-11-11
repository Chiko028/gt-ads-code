"""Pruefwerkzeuge fuer die kontrollierte Paketversorgung (WP-013). Nur Python-Standardbibliothek.

Regeln (Betreiberbedingungen 2026-11-10): Der Coding-Agent installiert keine beliebigen Pakete. Zulaessig sind ausschliesslich
Pakete der gepinnten Versorgung (devenv/supply/package-lock.json). Projekt-package.json-Dateien muessen EXAKTE Versionen dieser Pakete nennen;
jede vom Runner offline erzeugte Projekt-Lockdatei muss vollstaendig in der Versorgung enthalten sein (Name, Version, Pruefsumme).
"""

import hashlib
import json
import os
import re
import sys

EXACT = re.compile(r"^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$")
SECTIONS = ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")
REGISTRY = "https://registry.npmjs.org/"


def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def _name(path_key):
    return path_key.split("node_modules/")[-1]


def supply_top_level(supply_pkg):
    out = {}
    for section in ("dependencies", "devDependencies"):
        out.update(supply_pkg.get(section, {}))
    return out


def supply_index(supply_lock):
    """Menge aller (name, version, integrity) der Versorgungs-Lockdatei."""
    return {(_name(k), v["version"], v.get("integrity")) for k, v in supply_lock["packages"].items()
            if k and "node_modules/" in k and "version" in v and not v.get("link")}


def install_script_packages(supply_lock):
    return sorted((_name(k), v["version"]) for k, v in supply_lock["packages"].items() if k and v.get("hasInstallScript"))


def manifest_violations(supply_pkg, manifests, internal_prefix="@gtads/"):
    """manifests: {relativer_pfad: package.json-dict}. Rueckgabe: Liste verstaendlicher Verstoesse (leer = ok)."""
    allowed = supply_top_level(supply_pkg)
    internal = {m.get("name") for m in manifests.values() if m.get("name")}
    problems = []
    for path, manifest in sorted(manifests.items()):
        for section in SECTIONS:
            for name, spec in (manifest.get(section) or {}).items():
                if name in internal or name.startswith(internal_prefix):
                    continue
                if name not in allowed:
                    problems.append("%s: Paket '%s' ist nicht in der Paketversorgung" % (path, name))
                elif not isinstance(spec, str) or not EXACT.match(spec):
                    problems.append("%s: '%s' muss eine EXAKTE Version sein (nicht '%s')" % (path, name, spec))
                elif spec != allowed[name]:
                    problems.append("%s: '%s' Version %s ist nicht die gepinnte (%s)" % (path, name, spec, allowed[name]))
        for hook in ("scripts",):
            for key in (manifest.get(hook) or {}):
                if key in ("preinstall", "install", "postinstall", "prepare", "prepublish"):
                    problems.append("%s: Lifecycle-Skript '%s' ist nicht erlaubt" % (path, key))
    return problems


def lock_violations(supply_lock, project_lock):
    index = supply_index(supply_lock)
    problems = []
    for key, entry in project_lock.get("packages", {}).items():
        if not key or "node_modules/" not in key or entry.get("link") or "version" not in entry:
            continue
        resolved = entry.get("resolved")
        if resolved and not resolved.startswith(REGISTRY):
            problems.append("%s: Quelle ausserhalb der npm-Registry (%s)" % (_name(key), resolved[:60]))
        if (_name(key), entry["version"], entry.get("integrity")) not in index:
            problems.append("%s@%s ist (mit dieser Pruefsumme) nicht in der Paketversorgung" % (_name(key), entry["version"]))
    return problems


def tree_hash(root):
    """Deterministischer Hash eines Verzeichnisbaums (relative Pfade, Dateitypen, Inhalte; Symlinks als Ziel)."""
    digest = hashlib.sha256()
    for folder, dirs, files in os.walk(root):
        dirs.sort()
        for name in sorted(files + [d for d in dirs if os.path.islink(os.path.join(folder, d))]):
            path = os.path.join(folder, name)
            rel = os.path.relpath(path, root)
            digest.update(rel.encode("utf-8") + b"\0")
            if os.path.islink(path):
                digest.update(b"L" + os.readlink(path).encode("utf-8") + b"\0")
                continue
            with open(path, "rb") as handle:
                for chunk in iter(lambda: handle.read(1 << 20), b""):
                    digest.update(chunk)
            digest.update(b"\0")
    return digest.hexdigest()


def collect_manifests(project_dir):
    out = {}
    for folder, dirs, files in os.walk(project_dir):
        dirs[:] = [d for d in dirs if d not in ("node_modules", ".git", "dist")]
        if "package.json" in files:
            out[os.path.relpath(os.path.join(folder, "package.json"), project_dir)] = load(os.path.join(folder, "package.json"))
    return out


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "manifests":  # supply_check.py manifests <supply/package.json> <projektverzeichnis>
        problems = manifest_violations(load(argv[2]), collect_manifests(argv[3]))
    elif cmd == "lock":      # supply_check.py lock <supply/package-lock.json> <projekt/package-lock.json>
        problems = lock_violations(load(argv[2]), load(argv[3]))
    elif cmd == "tree-hash":
        print(tree_hash(argv[2]))
        return 0
    elif cmd == "report":    # supply_check.py report <supply/package-lock.json>
        lock = load(argv[2])
        print("Pakete (mit Transitiven): %d" % len(supply_index(lock)))
        print("Pakete mit Installationsskript (werden mit --ignore-scripts NIE ausgefuehrt): %s" % ", ".join("%s@%s" % p for p in install_script_packages(lock)))
        return 0
    else:
        print("Verwendung: supply_check.py manifests|lock|tree-hash|report ...", file=sys.stderr)
        return 2
    for p in problems:
        print("VERSTOSS:", p)
    print("%d Verstoss/Verstoesse" % len(problems))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
