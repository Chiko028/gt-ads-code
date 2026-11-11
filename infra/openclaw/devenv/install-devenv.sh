#!/usr/bin/env bash
# Installiert die Entwicklungsumgebung v2 fuer den Coding-Runner (privilegiert, OHNE Netz): Paketversorgung nach /var/lib/occoder/supply
# (root-eigen, fuer occoder nur lesbar), Image gtads-dev:2 in den Podman-Speicher von occoder, Funktionstest unter Sandbox-Bedingungen.
#   sudo bash install-devenv.sh [--dry-run]
# Voraussetzung: build-devenv.sh wurde als normaler Benutzer ausgefuehrt. Aendert NICHT: SSH, UFW, Docker, Netzwerk, laufende Dienste.
set -Eeuo pipefail
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$(cd "$HERE/../runner" && pwd)"
cd /
ART="${GTADS_ARTIFACTS:-/srv/taxiwerbung/data/devenv-artifacts}"
DEST=/var/lib/occoder/supply
run() { if [ "$DRY" -eq 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }
[ "$DRY" -eq 1 ] || [ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausfuehren (oder --dry-run)." >&2; exit 1; }
CUID="$(id -u occoder 2>/dev/null || echo OCCODER_UID)"
as_coder() { runuser -u occoder -- env HOME=/var/lib/occoder XDG_RUNTIME_DIR="/run/user/$CUID" PATH=/usr/bin:/bin "$@"; }

echo "1/5 Artefakte pruefen"
if [ "$DRY" -eq 0 ]; then
  [ -f "$ART/gtads-dev-2.tar" ] && [ -d "$ART/supply/node_modules" ] || { echo "Artefakte fehlen unter $ART (zuerst: bash $HERE/build-devenv.sh)" >&2; exit 1; }
  ( cd "$ART" && sha256sum -c gtads-dev-2.tar.sha256 >/dev/null ) || { echo "Image-Pruefsumme stimmt nicht." >&2; exit 1; }
  [ "$(python3 -I "$RUNNER/supply_check.py" tree-hash "$ART/supply/node_modules")" = "$(cat "$ART/supply/TREE.sha256")" ] || { echo "Pruefsumme von node_modules stimmt nicht." >&2; exit 1; }
  echo "  OK: Image und Paketbaum entsprechen der beim Build erzeugten Pruefsumme"
else echo "[dry-run] Image-Pruefsumme und Baum-Hash pruefen"; fi

echo "2/5 Paketversorgung nach $DEST (root-eigen, schreibgeschuetzt fuer occoder)"
run install -d -m 0755 -o root -g root "$DEST"
run rm -rf "$DEST/node_modules" "$DEST/npm-cache"
run cp -a "$ART/supply/node_modules" "$DEST/node_modules"
run cp -a "$ART/supply/npm-cache" "$DEST/npm-cache"
run install -m 0644 -o root -g root "$HERE/supply/package.json" "$DEST/package.json"
run install -m 0644 -o root -g root "$HERE/supply/package-lock.json" "$DEST/package-lock.json"
run install -m 0644 -o root -g root "$ART/supply/TREE.sha256" "$DEST/TREE.sha256"
run chown -R root:root "$DEST"; run chmod -R go-w,a+rX "$DEST"

echo "3/5 Image gtads-dev:2 fuer occoder laden"
run install -m 0644 "$ART/gtads-dev-2.tar" /var/lib/occoder/gtads-dev-2.tar
run chown occoder:occoder /var/lib/occoder/gtads-dev-2.tar
if [ "$DRY" -eq 1 ]; then echo "[dry-run] podman load -i /var/lib/occoder/gtads-dev-2.tar (als occoder)"; else as_coder podman load -q -i /var/lib/occoder/gtads-dev-2.tar | tail -1; rm -f /var/lib/occoder/gtads-dev-2.tar; fi

echo "4/5 Funktionstest unter Sandbox-Bedingungen (kein Netz, Root-FS schreibgeschuetzt, ohne Capabilities, als occoder)"
if [ "$DRY" -eq 1 ]; then echo "[dry-run] Probeprojekt: tsc, vitest (Fastify, React, PostgreSQL per Socket), vite build"
else
  SMOKE="$(mktemp -d /var/lib/occoder/smoke.XXXXXX)"; cp -a "$HERE/smoke/." "$SMOKE/"; chown -R occoder:occoder "$SMOKE"
  OUTPUT="$(as_coder podman run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --userns keep-id --user "$CUID:$(id -g occoder)" \
    --tmpfs /tmp:rw,size=1g --pids-limit 512 --memory 3g -v "$SMOKE:/work:rw" -v "$DEST/node_modules:/work/node_modules:O" gtads-dev:2 \
    bash -c 'node_modules/.bin/tsc -p . && echo TSC_OK && with-postgres node_modules/.bin/vitest run 2>&1 | grep -E "Tests |Test Files" && node_modules/.bin/vite build >/dev/null 2>&1 && echo VITE_OK' 2>&1 | grep -v 'level=warning' || true)"
  rm -rf "$SMOKE"
  echo "$OUTPUT" | sed 's/\x1b\[[0-9;]*m//g' | sed 's/^/    /'
  echo "$OUTPUT" | grep -q TSC_OK && echo "$OUTPUT" | grep -q VITE_OK && echo "$OUTPUT" | sed 's/\x1b\[[0-9;]*m//g' | grep -q '4 passed' || { echo "FEHLER: Funktionstest nicht bestanden - Umgebung NICHT freigeben." >&2; exit 1; }
  echo "  OK: TypeScript, Vitest (4 Tests inkl. PostgreSQL, Fastify, React), Vite-Build offline bestanden"
fi

echo "5/5 Ergebnis"
echo "Umgebung v2 installiert: $DEST (Versionen siehe $DEST/package.json und package-lock.json). Keine Netzfreigabe geaendert."
