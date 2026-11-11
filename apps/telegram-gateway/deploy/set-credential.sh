#!/usr/bin/env bash
# GT-Ads Telegram-Gateway: Zugangsdaten sicher ablegen (NUR durch den Betreiber mit sudo, im eigenen Terminal).
#   sudo bash set-credential.sh telegram_bot_token [--no-verify]
#   sudo bash set-credential.sh deepseek_api_key   [--no-verify]
# Der Wert wird ueber einen VERSTECKTEN Prompt gelesen (keine Anzeige, keine History, nie als Argument),
# nach /etc/gt-ads/credentials/<name> geschrieben (root:root, 0600) und NIE ausgegeben.
# Den Wert niemals in einen Chat, ein Ticket oder eine Datei im Repo einfuegen.
set -Eeuo pipefail

NAME="${1:-}"
VERIFY=1
[ "${2:-}" = "--no-verify" ] && VERIFY=0
CRED_DIR=/etc/gt-ads/credentials

case "$NAME" in
  telegram_bot_token|deepseek_api_key) ;;
  *) echo "Verwendung: set-credential.sh telegram_bot_token|deepseek_api_key [--no-verify]" >&2; exit 2 ;;
esac
[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausfuehren." >&2; exit 1; }

read -rsp "Wert fuer $NAME (Eingabe unsichtbar): " VALUE; echo
read -rsp "Wert wiederholen: " VALUE2; echo
if [ -z "$VALUE" ] || [ "$VALUE" != "$VALUE2" ]; then
  unset VALUE VALUE2
  echo "Eingaben leer oder verschieden - nichts geschrieben." >&2
  exit 1
fi
unset VALUE2

case "$NAME" in
  telegram_bot_token)
    [[ "$VALUE" =~ ^[0-9]{5,}:[A-Za-z0-9_-]{30,}$ ]] || { unset VALUE; echo "Format ungueltig (erwartet <zahl>:<zeichen>)." >&2; exit 1; } ;;
  deepseek_api_key)
    [[ "$VALUE" =~ ^[^[:space:]]{8,}$ ]] || { unset VALUE; echo "Format ungueltig (mind. 8 Zeichen, keine Leerzeichen)." >&2; exit 1; } ;;
esac

umask 077
install -d -m 0700 -o root -g root "$CRED_DIR"
TMP="$(mktemp "$CRED_DIR/.${NAME}.XXXXXX")"
printf '%s' "$VALUE" > "$TMP"
chown root:root "$TMP"
chmod 0600 "$TMP"
mv -f "$TMP" "$CRED_DIR/$NAME"
echo "Gespeichert: $CRED_DIR/$NAME (root:root, 0600). Wert wird nicht angezeigt."

if [ "$VERIFY" -eq 1 ]; then
  # Konfiguration ueber stdin (curl -K -): der Wert erscheint nicht in der Prozessliste. Ausgabe: nur HTTP-Statuscode.
  case "$NAME" in
    telegram_bot_token)
      CODE="$(printf 'url = "https://api.telegram.org/bot%s/getMe"\n' "$VALUE" | curl -sS -K - --max-time 20 -o /dev/null -w '%{http_code}' || true)" ;;
    deepseek_api_key)
      CODE="$(printf 'url = "https://api.deepseek.com/models"\nheader = "Authorization: Bearer %s"\n' "$VALUE" | curl -sS -K - --max-time 20 -o /dev/null -w '%{http_code}' || true)" ;;
  esac
  if [ "$CODE" = "200" ]; then echo "Pruefung: Anbieter akzeptiert den Wert (HTTP 200)."; else echo "Pruefung: HTTP ${CODE:-keine Antwort} - Wert pruefen (bei deepseek_api_key ist der Pruefaufruf eine Annahme)." >&2; fi
fi
unset VALUE
echo "Danach: sudo systemctl restart gt-ads-telegram   (falls der Dienst schon laeuft)"
