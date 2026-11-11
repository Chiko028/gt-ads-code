#!/usr/bin/env bash
# Telegram vom Python-Gateway auf OpenClaw umschalten. NUR nach ausdruecklicher Freigabe des Betreibers.
#   sudo bash switch-telegram-to-openclaw.sh [--dry-run]
# Ablauf (nie zwei Poller gleichzeitig):
#   1. Vorpruefungen (OpenClaw aktiv, Telegram in OpenClaw noch aus)
#   2. Python-Gateway stoppen UND Autostart deaktivieren (Dienst und Dateien bleiben erhalten)
#   3. OpenClaw stoppen, Flag in der Konfigurationsdatei setzen, OpenClaw starten
#   4. Pruefen (Bereitschaft, Verbindung zu api.telegram.org ueber den Proxy); bei JEDEM Fehler: Telegram in OpenClaw aus (kein Rueckweg zum Python-Gateway)
set -Eeuo pipefail

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd /
run() { if [ "$DRY" -eq 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }
CFG=/var/lib/openclaw/.openclaw/openclaw.json
flag() { python3 -I -c 'import re,sys;m=re.search(r"telegram\"?\s*:\s*\{[^{}]*?enabled\"?\s*:\s*(true|false)",open(sys.argv[1]).read());print(m.group(1) if m else "unbekannt")' "$CFG"; }

if [ "$DRY" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then echo "Bitte mit sudo ausfuehren (oder --dry-run)." >&2; exit 1; fi

failsafe() {
  echo "FEHLER -> Telegram in OpenClaw wird wieder deaktiviert; OpenClaw laeuft weiter ohne Telegram. Das Python-Gateway wird NICHT wiederhergestellt (Betreiberentscheidung)." >&2
  systemctl stop gt-ads-openclaw.service || true
  bash "$HERE/set-telegram-flag.sh" false || true
  systemctl start gt-ads-openclaw.service || true
}

if [ "$DRY" -eq 0 ]; then
  systemctl is-active --quiet gt-ads-openclaw.service || { echo "gt-ads-openclaw ist nicht aktiv (zuerst install.sh)." >&2; exit 1; }
  systemctl is-active --quiet gt-ads-egress-proxy.service || { echo "gt-ads-egress-proxy ist nicht aktiv." >&2; exit 1; }
  [ "$(flag)" = "false" ] || { echo "OpenClaw-Telegram ist schon aktiviert oder Flag unlesbar - Abbruch." >&2; exit 1; }
  trap failsafe ERR
fi

echo "1/4 Python-Gateway stoppen und Autostart deaktivieren"
run systemctl stop gt-ads-telegram.service
run systemctl disable gt-ads-telegram.service
[ "$DRY" -eq 1 ] || { ! systemctl is-active --quiet gt-ads-telegram.service; }

echo "2/4 OpenClaw stoppen und Telegram in der Konfiguration aktivieren"
run systemctl stop gt-ads-openclaw.service
run bash "$HERE/set-telegram-flag.sh" true

echo "3/4 OpenClaw starten und auf Bereitschaft warten (bis 10 min)"
START_TS="$(date '+%Y-%m-%d %H:%M:%S')"
run systemctl start gt-ads-openclaw.service
if [ "$DRY" -eq 0 ]; then
  ready=0
  for _ in $(seq 1 75); do
    systemctl is-active --quiet gt-ads-openclaw.service || { echo "gt-ads-openclaw ist nicht (mehr) aktiv." >&2; false; }
    [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:18789/readyz || true)" = "200" ] && { ready=1; break; }
    sleep 8
  done
  [ "$ready" -eq 1 ] || { echo "readyz wurde nicht 200 (Zeitueberschreitung)." >&2; false; }
fi

echo "4/4 Pruefung"
if [ "$DRY" -eq 0 ]; then
  [ "$(flag)" = "true" ]
  ! systemctl is-active --quiet gt-ads-telegram.service
  tg=0
  for _ in $(seq 1 15); do
    journalctl -u gt-ads-egress-proxy --since "$START_TS" --no-pager 2>/dev/null | grep -q 'allowed host=api.telegram.org' && { tg=1; break; }
    sleep 8
  done
  [ "$tg" -eq 1 ] || { echo "Keine Verbindung zu api.telegram.org ueber den Proxy beobachtet." >&2; false; }
  trap - ERR
  echo "Umschaltung abgeschlossen: OpenClaw ist bereit und hat sich mit Telegram verbunden."
  echo "Jetzt in Telegram testen: Nachricht an den Bot senden, anschliessend fremdes Konto/Gruppe (muessen ignoriert werden)."
fi
