#!/usr/bin/env bash
# GT-Ads Telegram-Gateway: Rueckbau (NUR durch den Betreiber mit sudo).
#   sudo bash uninstall.sh --dry-run
#   sudo bash uninstall.sh                       # Dienst stoppen/deaktivieren, Units und Code entfernen
#   sudo bash uninstall.sh --purge-credentials   # zusaetzlich Credential-Dateien loeschen
#   sudo bash uninstall.sh --purge-state         # zusaetzlich Zustandsverzeichnis loeschen
# Danach: Bot-Token bei BotFather widerrufen (/revoke) und DeepSeek-Schluessel in der Konsole widerrufen.
set -Eeuo pipefail

DRY=0
PURGE_CRED=0
PURGE_STATE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --purge-credentials) PURGE_CRED=1 ;;
    --purge-state) PURGE_STATE=1 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "Unbekannte Option: $arg" >&2; exit 2 ;;
  esac
done

run() { if [ "$DRY" -eq 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }

if [ "$DRY" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
  echo "Bitte mit sudo ausfuehren (oder --dry-run)." >&2
  exit 1
fi

run systemctl disable --now gt-ads-telegram.service || true
run systemctl stop gt-ads-telegram-setup.service || true
run rm -f /etc/systemd/system/gt-ads-telegram.service /etc/systemd/system/gt-ads-telegram-setup.service
run systemctl daemon-reload
run rm -rf /opt/gt-ads/telegram-gateway
run rmdir --ignore-fail-on-non-empty /opt/gt-ads

if [ "$PURGE_CRED" -eq 1 ]; then
  run rm -f /etc/gt-ads/credentials/telegram_bot_token /etc/gt-ads/credentials/deepseek_api_key
  run rmdir --ignore-fail-on-non-empty /etc/gt-ads/credentials
else
  echo "Credentials bleiben erhalten (/etc/gt-ads/credentials); Entfernen mit --purge-credentials."
fi
if [ "$PURGE_STATE" -eq 1 ]; then
  run rm -rf /srv/taxiagents/telegram/state
  run rmdir --ignore-fail-on-non-empty /srv/taxiagents/telegram
else
  echo "Zustandsverzeichnis bleibt erhalten (/srv/taxiagents/telegram/state)."
fi
echo "Konfiguration /etc/gt-ads/telegram-gateway.toml bleibt erhalten."
echo "Nicht vergessen: Token bei BotFather (/revoke) und DeepSeek-Schluessel widerrufen."
