#!/usr/bin/env bash
# Rootless-Podman-Sandbox fuer den OpenClaw-Coding-Agenten vorbereiten und Sicherheitsgrenzen testen (Freigabe E).
#   sudo bash setup-podman-sandbox.sh [--dry-run]
# Aendert NICHT: SSH, UFW, Docker, produktive Container. Kein Docker-Socket, kein Root-Container, keine Secrets.
set -Eeuo pipefail

DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd / # neutrales Arbeitsverzeichnis: Benutzer occoder darf das Repo-Verzeichnis nicht lesen
USER_NAME=occoder; HOME_DIR=/var/lib/occoder; SUB_START=300000; SUB_COUNT=65536; IMAGE=gtads-sandbox:1
run() { if [ "$DRY" -eq 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }
[ "$DRY" -eq 1 ] || [ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausfuehren (oder --dry-run)." >&2; exit 1; }

echo "1/5 Pakete (nur Ubuntu-Repositories, ohne Empfehlungen)"
run apt-get install -y --no-install-recommends podman catatonit uidmap
# Das Ubuntu-Paket aktiviert einen systemweiten (root) Podman-API-Socket und Timer: werden nicht gebraucht und bleiben aus (kein Socket-Zugang).
run systemctl disable --now podman.socket podman.service podman-auto-update.timer podman-auto-update.service podman-restart.service podman-clean-transient.service || true

echo "2/5 Benutzer $USER_NAME (keine Anmeldung, kein sudo, keine Gruppen) und Subordinate-IDs"
if ! id "$USER_NAME" >/dev/null 2>&1; then
  run useradd --system --home-dir "$HOME_DIR" --create-home --shell /usr/sbin/nologin --user-group "$USER_NAME"
fi
for f in /etc/subuid /etc/subgid; do
  if [ "$DRY" -eq 1 ]; then echo "[dry-run] $USER_NAME:$SUB_START:$SUB_COUNT -> $f (falls nicht vorhanden; Bereich ueberlappt keine bestehende Zuordnung)"
  elif ! grep -q "^$USER_NAME:" "$f"; then
    awk -F: -v s="$SUB_START" -v e="$((SUB_START+SUB_COUNT-1))" '$2+$3-1>=s && $2<=e {exit 1}' "$f" || { echo "Subordinate-ID-Bereich ueberlappt in $f" >&2; exit 1; }
    echo "$USER_NAME:$SUB_START:$SUB_COUNT" >> "$f"
  fi
done
run loginctl enable-linger "$USER_NAME"

as_coder() { runuser -u "$USER_NAME" -- env HOME="$HOME_DIR" XDG_RUNTIME_DIR="/run/user/$(id -u "$USER_NAME")" PATH=/usr/bin:/bin "$@"; }

echo "3/5 Sandbox-Image bauen (einmalig, Netz nur fuer den Build)"
run install -d -m 0755 "$HOME_DIR/build"
run install -m 0644 "$HERE/sandbox/Containerfile" "$HOME_DIR/build/Containerfile"
run chown -R "$USER_NAME:$USER_NAME" "$HOME_DIR/build"
if [ "$DRY" -eq 1 ]; then echo "[dry-run] podman build -t $IMAGE (als $USER_NAME, rootless)"; else as_coder podman build -q -t "$IMAGE" -f "$HOME_DIR/build/Containerfile" "$HOME_DIR/build"; fi

echo "4/5 Sicherheitsgrenzen testen (synthetisch, ohne Secrets; jeder Negativtest hat eine Positivkontrolle)"
FAIL=0
CUID="$(id -u "$USER_NAME")"; CGID="$(id -g "$USER_NAME")"  # Container laeuft als dieser Benutzer (nicht root, kein Image-USER)
ct() { as_coder podman run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --userns keep-id --user "$CUID:$CGID" --pids-limit 256 --memory 1g "$IMAGE" "$@"; }
# expect NAME ERWARTETES_MUSTER BEFEHL...  -> der Befehl muss das Muster ausgeben (nie nur "Befehl scheiterte")
expect() {
  local name="$1" want="$2"; shift 2
  local out; out="$("$@" 2>&1)" || true
  if printf '%s' "$out" | grep -q -- "$want"; then echo "  OK     $name"
  else echo "  FEHLER $name (erwartet '$want', erhalten: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200))"; FAIL=1; fi
}
if [ "$DRY" -eq 1 ]; then echo "[dry-run] Tests: Positivkontrolle, nicht root, kein Netz, Root-FS schreibgeschuetzt, Pfade unsichtbar (mit Kontrolle), kein Docker-Socket, Capabilities leer, kein sudo, Workspace beschreibbar, occoder kann Zugangsdaten nicht lesen"
else
  expect "Positivkontrolle: Container startet und fuehrt Befehle aus" "PING" ct sh -c 'echo PING'
  expect "laeuft nicht als root" "UID_OK" ct sh -c '[ "$(id -u)" != 0 ] && echo UID_OK'
  expect "kein Netzwerk (Verbindung wird blockiert)" "NET_BLOCKED" ct python3 -c 'import socket
try:
    socket.create_connection(("api.deepseek.com", 443), 3); print("NET_OK")
except Exception:
    print("NET_BLOCKED")'
  expect "Root-Dateisystem schreibgeschuetzt" "RO_OK" ct sh -c 'touch /etc/x 2>/dev/null && echo WRITABLE || echo RO_OK'
  expect "Kontrolle: /etc/hostname ist im Container sichtbar" "VISIBLE" ct sh -c '[ -e /etc/hostname ] && echo VISIBLE || echo HIDDEN'
  for path in /etc/gt-ads /srv/taxiwerbung /home/taxiadmin /var/lib/openclaw; do
    expect "$path im Container nicht sichtbar" "HIDDEN" ct sh -c "[ -e $path ] && echo VISIBLE || echo HIDDEN"
  done
  # /root existiert als leeres Verzeichnis im Image; entscheidend ist, dass kein Inhalt des Host-/root sichtbar ist.
  expect "Kontrolle: Image-/root ist leer (kein Host-Inhalt)" "EMPTY" ct sh -c '[ -z "$(ls -A /root 2>/dev/null)" ] && echo EMPTY || echo NOT_EMPTY'
  expect "Host-/root-Inhalt nicht lesbar fuer occoder" "DENIED" sh -c "runuser -u $USER_NAME -- ls /root >/dev/null 2>&1 && echo READ || echo DENIED"
  expect "kein Docker-Socket im Container" "HIDDEN" ct sh -c 'for f in /var/run/docker* /run/docker* /run/podman*; do [ -e "$f" ] && { echo VISIBLE; exit; }; done; echo HIDDEN'
  expect "keine Capabilities (CapEff leer)" "CapEff:.0000000000000000" ct sh -c 'grep ^CapEff /proc/self/status'
  expect "kein sudo im Image" "NONE" ct sh -c 'command -v sudo >/dev/null && echo FOUND || echo NONE'
  WS="$(mktemp -d -p "$HOME_DIR")"; chown "$USER_NAME:$USER_NAME" "$WS"
  expect "Workspace ist beschreibbar (einziger Schreibort)" "WS_OK" as_coder podman run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --userns keep-id --user "$CUID:$CGID" -v "$WS:/work:rw" -w /work "$IMAGE" sh -c 'echo x > f && echo WS_OK'
  rm -rf "$WS"
  expect "Benutzer occoder kann /etc/gt-ads/credentials nicht lesen" "DENIED" sh -c "runuser -u $USER_NAME -- ls /etc/gt-ads/credentials >/dev/null 2>&1 && echo READ || echo DENIED"
fi

echo "5/5 Unveraenderte Systembereiche (Information)"
if [ "$DRY" -eq 0 ]; then ss -tln | awk 'NR>1{print "  Listener:",$4}' | sort -u | head -12; fi
[ "$DRY" -eq 1 ] && { echo "Trockenlauf beendet (keine Pruefung ausgefuehrt)."; exit 0; }
[ "$FAIL" -eq 0 ] && echo "ERGEBNIS: Rootless-Podman-Sandbox bereit und Grenzen bestaetigt" || { echo "ERGEBNIS: FEHLGESCHLAGEN - Coding-Agent bleibt gesperrt" >&2; exit 1; }
