#!/usr/bin/env bash
# Verhindert, dass zwei Prozesse gleichzeitig Telegram-Updates fuer denselben Bot abrufen (Long Polling).
# Wird von systemd als root (ExecStartPre=+) vor dem Start BEIDER Dienste aufgerufen:
#   guard-no-double-polling.sh openclaw   -> OpenClaw darf nicht starten, wenn dessen Telegram aktiv ist UND das Python-Gateway laeuft
#   guard-no-double-polling.sh python     -> Python-Gateway darf nicht starten, wenn OpenClaw laeuft UND dessen Telegram aktiv ist
set -Eeuo pipefail

WHO="${1:-}"

telegram_flag() {
  # Liest channels.telegram.enabled direkt aus der Konfigurationsdatei (als root, schnell, ohne die langsame OpenClaw-CLI).
  # Nicht lesbar/unklar -> "true" (sicher: im Zweifel nicht doppelt pollen). Fehlt die Datei -> false.
  local cfg=/var/lib/openclaw/.openclaw/openclaw.json
  [ -f "$cfg" ] || { echo false; return; }
  python3 -I - "$cfg" <<'PY' 2>/dev/null || echo true
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
# Funktioniert fuer JSON5 (Vorlage) und JSON (nach Aenderung per CLI): erstes "enabled" im Block "telegram".
m = re.search(r'telegram"?\s*:\s*\{[^{}]*?enabled"?\s*:\s*(true|false)', text)
print(m.group(1) if m else "true")  # nicht erkennbar -> sicher: als aktiv werten
PY
}

case "$WHO" in
  openclaw)
    if [ "$(telegram_flag)" = "true" ] && systemctl is-active --quiet gt-ads-telegram.service; then
      echo "ABGEBROCHEN: OpenClaw-Telegram ist aktiviert, aber das Python-Gateway (gt-ads-telegram) laeuft noch." >&2
      echo "Zuerst sudo bash infra/openclaw/deploy/switch-telegram-to-openclaw.sh verwenden." >&2
      exit 1
    fi ;;
  python)
    if systemctl is-active --quiet gt-ads-openclaw.service && [ "$(telegram_flag)" = "true" ]; then
      echo "ABGEBROCHEN: OpenClaw laeuft mit aktivem Telegram. Das Python-Gateway wird nicht mehr verwendet." >&2
      exit 1
    fi ;;
  *)
    echo "Verwendung: guard-no-double-polling.sh openclaw|python" >&2; exit 2 ;;
esac
exit 0
