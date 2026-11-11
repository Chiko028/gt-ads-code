#!/usr/bin/env bash
# Baut die Entwicklungsumgebung v2 reproduzierbar (als NORMALER Benutzer, kein sudo): Image gtads-dev:2 und die gepinnte Paketversorgung.
#   bash infra/openclaw/devenv/build-devenv.sh
# Isolierte Build-Umgebung: Wegwerf-Container (rootless Podman), eingebunden ist NUR das Ausgabeverzeichnis, keine Secrets, `npm ci --ignore-scripts`.
# Netz: Der Container nutzt das Host-Netz (slirp4netns ist nicht installiert); die lokalen Dienste verlangen Token. Nach dem Build ist kein Netz mehr noetig.
# Ergebnis: $ART/gtads-dev-2.tar (+ .sha256), $ART/supply/{node_modules,npm-cache,TREE.sha256,SUPPLY_REPORT.txt}
set -Eeuo pipefail
[ "$(id -u)" -ne 0 ] || { echo "Nicht als root ausfuehren." >&2; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$(cd "$HERE/../runner" && pwd)"
ART="${GTADS_ARTIFACTS:-/srv/taxiwerbung/data/devenv-artifacts}"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$ART/supply"
echo "1/4 Image gtads-dev:2 bauen"
podman build -q -t gtads-dev:2 -f "$HERE/Containerfile" "$HERE" 2>&1 | grep -v 'level=warning' | tail -1
rm -f "$ART/gtads-dev-2.tar" "$ART/gtads-dev-2.tar.sha256"
podman save -o "$ART/gtads-dev-2.tar" gtads-dev:2
( cd "$ART" && sha256sum gtads-dev-2.tar > gtads-dev-2.tar.sha256 )

echo "2/4 Paketversorgung: Lockdatei vorab pruefen (Quelle, Pruefsummen)"
python3 -I - "$HERE/supply/package-lock.json" <<'PY'
import json, sys
lock = json.load(open(sys.argv[1]))
bad = [k for k, v in lock["packages"].items() if k and "version" in v and not v.get("link")
       and (not v.get("integrity") or not v.get("resolved", "").startswith("https://registry.npmjs.org/"))]
if bad:
    sys.exit("Lockdatei unzulaessig (ohne Pruefsumme oder fremde Quelle): %s" % bad[:5])
print("  OK: alle %d Pakete mit Pruefsumme, nur registry.npmjs.org" % len([k for k in lock["packages"] if k]))
PY

echo "3/4 npm ci --ignore-scripts in isolierter Build-Umgebung (einmaliger Download)"
mkdir -p "$WORK/out/work" "$WORK/out/npm-cache"
cp "$HERE/supply/package.json" "$HERE/supply/package-lock.json" "$WORK/out/work/"
chmod -R 777 "$WORK/out"
podman run --rm --network host --userns keep-id --user "$(id -u):$(id -g)" --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,size=2g -v "$WORK/out:/out:rw" -w /out/work -e HOME=/tmp/home gtads-dev:2 \
  npm ci --ignore-scripts --cache /out/npm-cache --no-audit --no-fund 2>&1 | grep -v 'level=warning' | tail -2
# Metadaten fuer das spaetere Offline-Aufloesen von Projekt-Lockdateien in den Zwischenspeicher bringen (Aufloesung ausgehend von der gepinnten Lockdatei)
podman run --rm --network host --userns keep-id --user "$(id -u):$(id -g)" --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,size=2g -v "$WORK/out:/out:rw" -w /out/work -e HOME=/tmp/home gtads-dev:2 \
  npm install --package-lock-only --ignore-scripts --cache /out/npm-cache --no-audit --no-fund 2>&1 | grep -v 'level=warning' | tail -1
cmp -s "$WORK/out/work/package-lock.json" "$HERE/supply/package-lock.json" || { echo "FEHLER: Lockdatei hat sich beim Build veraendert - Abbruch (Supply-Pinning verletzt)." >&2; exit 1; }
rm -rf "$ART/supply/node_modules" "$ART/supply/npm-cache"
mv "$WORK/out/work/node_modules" "$ART/supply/node_modules"
mv "$WORK/out/npm-cache" "$ART/supply/npm-cache"
chmod -R go-w "$ART/supply"

echo "4/4 Pruefsumme des Baums und Bericht"
python3 -I "$RUNNER/supply_check.py" tree-hash "$ART/supply/node_modules" > "$ART/supply/TREE.sha256"
python3 -I "$RUNNER/supply_check.py" report "$HERE/supply/package-lock.json" | tee "$ART/supply/SUPPLY_REPORT.txt"
echo "Fertig: $ART (node_modules $(du -sh "$ART/supply/node_modules" | cut -f1), Zwischenspeicher $(du -sh "$ART/supply/npm-cache" | cut -f1), Image $(du -sh "$ART/gtads-dev-2.tar" | cut -f1))"
