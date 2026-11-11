#!/usr/bin/env bash
# Python-Telegram-Gateway (WP-006) ENDGUELTIG entfernen (Betreiberentscheidung: nie wieder verwenden).
#   sudo bash remove-python-gateway.sh [--dry-run] [--purge-credentials]
# Zugangsdaten /etc/gt-ads/credentials bleiben ohne --purge-credentials erhalten (Quelle der OpenClaw-Kopien).
set -Eeuo pipefail
cd /
DRY=0; PURGE_CRED=0
for arg in "$@"; do case "$arg" in --dry-run) DRY=1 ;; --purge-credentials) PURGE_CRED=1 ;; *) echo "Unbekannte Option: $arg" >&2; exit 2 ;; esac; done
run() { if [ "$DRY" -eq 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }
[ "$DRY" -eq 1 ] || [ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausfuehren (oder --dry-run)." >&2; exit 1; }

echo "1/3 Python-Gateway stoppen und deaktivieren"
run systemctl disable --now gt-ads-telegram.service || true
echo "2/3 Unit, Drop-in, Code und Konfiguration entfernen"
run rm -f /etc/systemd/system/gt-ads-telegram.service /etc/systemd/system/gt-ads-telegram-setup.service
run rm -rf /etc/systemd/system/gt-ads-telegram.service.d /opt/gt-ads/telegram-gateway /etc/gt-ads/telegram-gateway.toml /srv/taxiagents/telegram/state
run systemctl daemon-reload
echo "3/3 Zugangsdaten"
if [ "$PURGE_CRED" -eq 1 ]; then run rm -rf /etc/gt-ads/credentials; else echo "  /etc/gt-ads/credentials bleibt (mit --purge-credentials loeschen)."; fi
echo "Python-Gateway entfernt."
