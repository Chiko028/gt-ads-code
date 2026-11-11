#!/usr/bin/env bash
# Ein Befehl fuer die freigegebenen Schritte (Freigabe B + D): install -> Docs-Spiegel -> verify -> Umschaltung.
#   sudo bash infra/openclaw/deploy/install-and-switch.sh [--dry-run]
# Die Umschaltung erfolgt NUR, wenn verify.sh ohne Fehler endet; sonst bleibt das Python-Gateway aktiv.
# Die Umschaltung hat einen automatischen Rueckweg (switch-telegram-to-openclaw.sh).
set -Eeuo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY=(); [ "${1:-}" = "--dry-run" ] && DRY=(--dry-run)
if [ "${#DRY[@]}" -eq 1 ]; then
  bash "$HERE/install.sh" --dry-run; echo "[dry-run] sync-status-docs.sh; verify.sh; switch-telegram-to-openclaw.sh --dry-run"
  bash "$HERE/switch-telegram-to-openclaw.sh" --dry-run; exit 0
fi
[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausfuehren." >&2; exit 1; }
bash "$HERE/install.sh"
bash "$HERE/sync-status-docs.sh"
for _ in $(seq 1 90); do ss -tln | grep -q "127.0.0.1:18789" && break; sleep 4; done  # auf Gateway-Start warten (bis 6 min)
sleep 5
if bash "$HERE/verify.sh"; then
  echo "verify.sh bestanden -> Umschaltung"
  bash "$HERE/switch-telegram-to-openclaw.sh"
else
  echo "verify.sh NICHT bestanden -> keine Umschaltung, Python-Gateway bleibt aktiv. Ausgabe oben pruefen." >&2; exit 1
fi
