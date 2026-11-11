#!/usr/bin/env bash
# GT-Ads Telegram-Gateway: Einrichtung (NUR durch den Betreiber mit sudo, nach Freigabe).
#   sudo bash install.sh --dry-run        # zeigt nur, was passieren wuerde
#   sudo bash install.sh                  # richtet Verzeichnisse, Code, Konfiguration und Units ein
#   sudo bash install.sh --enable         # zusaetzlich aktivieren/starten (nur wenn Credentials + ID vorhanden)
# Tut NICHT: Firewall/UFW, SSH, Benutzer anlegen/aendern, Ports oeffnen, Docker.
set -Eeuo pipefail

DRY=0
ENABLE=0
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/opt/gt-ads/telegram-gateway
CONF_DIR=/etc/gt-ads
CRED_DIR=/etc/gt-ads/credentials
STATE_PARENT=/srv/taxiagents/telegram
STATE_DIR=/srv/taxiagents/telegram/state
SVC_USER=taxiagent

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --enable) ENABLE=1 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "Unbekannte Option: $arg" >&2; exit 2 ;;
  esac
done

run() { if [ "$DRY" -eq 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }

if [ "$DRY" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
  echo "Bitte mit sudo ausfuehren (oder --dry-run)." >&2
  exit 1
fi

# --- Vorpruefungen (aendern nichts) -----------------------------------------
command -v python3 >/dev/null || { echo "python3 fehlt" >&2; exit 1; }
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' || { echo "Python >= 3.11 noetig" >&2; exit 1; }
id "$SVC_USER" >/dev/null 2>&1 || { echo "Benutzer $SVC_USER existiert nicht (wird hier bewusst NICHT angelegt)" >&2; exit 1; }
[ -d "$SRC/gtads_tg" ] || { echo "Quellcode nicht gefunden: $SRC/gtads_tg" >&2; exit 1; }
[ -f "$SRC/deploy/gt-ads-telegram.service" ] || { echo "Unit-Vorlage fehlt" >&2; exit 1; }

# --- Code: root-eigen, fuer taxiagent nur lesbar -------------------------------
run install -d -m 0755 -o root -g root /opt/gt-ads "$APP_DIR"
run rm -rf "$APP_DIR/gtads_tg"
run cp -r "$SRC/gtads_tg" "$APP_DIR/gtads_tg"
run cp "$SRC/README.md" "$APP_DIR/README.md"
run chown -R root:root "$APP_DIR"
run find "$APP_DIR" -type d -exec chmod 0755 {} +
run find "$APP_DIR" -type f -exec chmod 0644 {} +
run find "$APP_DIR" -name '__pycache__' -type d -prune -exec rm -rf {} +

# --- Konfiguration und Credentials-Verzeichnis ---------------------------------
run install -d -m 0755 -o root -g root "$CONF_DIR"
run install -d -m 0700 -o root -g root "$CRED_DIR"
if [ ! -e "$CONF_DIR/telegram-gateway.toml" ]; then
  run install -m 0644 -o root -g root "$SRC/config/telegram-gateway.toml.example" "$CONF_DIR/telegram-gateway.toml"
else
  echo "Konfiguration bleibt unveraendert: $CONF_DIR/telegram-gateway.toml"
fi

# --- Zustandsverzeichnis (nur Metadaten) ---------------------------------------
run install -d -m 0750 -o "$SVC_USER" -g "$SVC_USER" "$STATE_PARENT" "$STATE_DIR"

# --- systemd-Units --------------------------------------------------------------
run install -m 0644 -o root -g root "$SRC/deploy/gt-ads-telegram.service" /etc/systemd/system/gt-ads-telegram.service
run install -m 0644 -o root -g root "$SRC/deploy/gt-ads-telegram-setup.service" /etc/systemd/system/gt-ads-telegram-setup.service
run systemctl daemon-reload

if [ "$ENABLE" -eq 1 ]; then
  for name in telegram_bot_token deepseek_api_key; do
    if [ "$DRY" -eq 0 ] && [ ! -s "$CRED_DIR/$name" ]; then
      echo "Credential $name fehlt (zuerst: sudo bash deploy/set-credential.sh $name)" >&2; exit 1
    fi
  done
  if [ "$DRY" -eq 0 ]; then
    (cd "$APP_DIR" && python3 -s -B -m gtads_tg.main --config "$CONF_DIR/telegram-gateway.toml" --check-config) \
      || { echo "Konfiguration unvollstaendig (allowed_user_id?)" >&2; exit 1; }
  fi
  run systemctl enable --now gt-ads-telegram.service
fi

echo
echo "Fertig$([ "$DRY" -eq 1 ] && echo ' (Trockenlauf)')."
echo "Naechste Schritte (siehe deploy/README.md):"
echo "  1. Credentials setzen:   sudo bash deploy/set-credential.sh telegram_bot_token"
echo "  2. ID ermitteln:         sudo systemctl start gt-ads-telegram-setup   # dann Nachricht an den Bot senden"
echo "                           journalctl -u gt-ads-telegram-setup --no-pager | grep setup_id"
echo "  3. ID eintragen:         sudoedit $CONF_DIR/telegram-gateway.toml    (allowed_user_id)"
echo "  4. DeepSeek-Schluessel:  sudo bash deploy/set-credential.sh deepseek_api_key"
echo "  5. Aktivieren:           sudo bash deploy/install.sh --enable"
