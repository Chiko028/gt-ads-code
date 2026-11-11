#!/usr/bin/env bash
# Gemini-API-Schluessel ablegen: versteckte Eingabe im eigenen Terminal (nie im Chat, nie in Git, nie in Logs).
#   sudo bash set-gemini-key.sh
# WICHTIG (kostenlos): Den Schluessel in Google AI Studio fuer ein Projekt OHNE Abrechnungskonto erstellen. Sobald ein Abrechnungskonto
# verknuepft ist, wechselt das Projekt in den kostenpflichtigen Tarif. Das kann dieses Programm nicht pruefen - das musst du sicherstellen.
# Gemini erhaelt ausschliesslich SYNTHETISCHE Beispiele (Betreiberentscheidung), nie GT-Ads-Code.
set -Eeuo pipefail
cd /
umask 077
[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausfuehren." >&2; exit 1; }
FILE=/etc/gt-ads/runner-credentials/gemini_api_key
[ -d /etc/gt-ads/runner-credentials ] || { echo "Zuerst install-coder.sh ausfuehren." >&2; exit 1; }
read -r -s -p "Gemini-API-Schluessel (Eingabe bleibt unsichtbar): " KEY; echo
# Nur sichtbare ASCII-Zeichen ohne Leerzeichen, 20-300 Zeichen (Google-Schluesselformate koennen z. B. auch Punkte enthalten).
# Die Pruefung verhindert nur versehentlich eingefuegten Text (Leerzeichen/Zeilenumbruch); sie bewertet nie die Gueltigkeit des Schluessels.
if ! [[ "$KEY" =~ ^[\!-~]{20,300}$ ]]; then
  echo "Ungueltige Eingabe: ${#KEY} Zeichen (erlaubt: 20-300 sichtbare Zeichen ohne Leerzeichen). Wurde mehr als der Schluessel eingefuegt?" >&2; unset KEY; exit 1
fi
printf '%s' "$KEY" | install -m 0600 -o root -g root /dev/stdin "$FILE"
unset KEY
echo "Schluessel gespeichert (nicht angezeigt). Runner wird neu gestartet, damit er ihn laedt ..."
systemctl restart gt-ads-coding-runner.service
for _ in $(seq 1 30); do [ -S /run/gtads-runner/control.sock ] && break; sleep 2; done
[ -S /run/gtads-runner/control.sock ] && echo "Runner laeuft." || { echo "Runner startet nicht - journalctl -u gt-ads-coding-runner pruefen." >&2; exit 1; }
echo "Weiter: sudo bash $(dirname "${BASH_SOURCE[0]}")/verify-gemini.sh"
