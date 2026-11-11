#!/usr/bin/env bash
# Einmalig durch den Betreiber: Claude (Benutzer des Repositories) darf GENAU /usr/local/sbin/gtads-deploy ohne Passwort ausfuehren.
#   sudo bash setup-deploy-sudo.sh [--dry-run]          einrichten / aktualisieren (Programm + Schluessel)
#   sudo bash setup-deploy-sudo.sh --remove              Regel und Programm wieder entfernen
# Kein allgemeines sudo: die Regel erlaubt nur dieses root-eigene Programm. Es installiert ausschliesslich auf GitHub gemergte,
# von GitHub signierte Staende von main (nie lokale Aenderungen), zeigt bereinigte Protokolle und fuehrt die Isolationspruefung aus.
# Aenderungen am Programm, am GitHub-Schluessel oder an der Regel passieren NUR ueber dieses Skript (also durch den Betreiber).
set -Eeuo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # vor "cd /" bestimmen (sonst scheitert ein relativer Aufruf)
cd /
DRY=0; MODE=install
case "${1:-}" in --dry-run) DRY=1 ;; --remove) MODE=remove ;; "") ;; *) echo "Unbekannte Option" >&2; exit 2 ;; esac
[ "$DRY" -eq 1 ] || [ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausfuehren (oder --dry-run)." >&2; exit 1; }
REPO=/srv/taxiwerbung/app/gt-ads
USER_NAME="$(stat -c %U "$REPO")"
RULE=/etc/sudoers.d/gtads-deploy
run() { if [ "$DRY" -eq 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }

if [ "$MODE" = remove ]; then
  rm -f "$RULE" /usr/local/sbin/gtads-deploy
  echo "Entfernt: $RULE und /usr/local/sbin/gtads-deploy (Zustand /var/lib/gtads-deploy bleibt fuer die Nachvollziehbarkeit)."
  exit 0
fi

# GitHub-Schluessel pruefen (Fingerabdruecke fest im Programm hinterlegt)
FPRS="$(gpg --batch --with-colons --import-options show-only --import "$HERE/github-web-flow.gpg" 2>/dev/null | awk -F: '$1=="fpr"{print $10}' | sort | tr '\n' ' ')"
[ "$FPRS" = "5DE3E0509C47EA3CF04A42D34AEE18F83AFDEB23 968479A1AFF927E37D1A566BB5690EEEBB952194 " ] || { echo "Unerwarteter GitHub-Schluessel: $FPRS" >&2; exit 1; }

echo "1/3 Programm /usr/local/sbin/gtads-deploy (root-eigen, 0755) und GitHub-Schluessel"
run install -m 0755 -o root -g root "$HERE/gtads-deploy" /usr/local/sbin/gtads-deploy
run install -d -m 0755 -o root -g root /etc/gtads-deploy
run install -m 0644 -o root -g root "$HERE/github-web-flow.gpg" /etc/gtads-deploy/github-web-flow.gpg
run rm -rf /var/lib/gtads-deploy/gnupg   # Schluesselbund wird beim naechsten Aufruf aus der Datei neu angelegt

echo "2/3 sudo-Regel nur fuer dieses Programm (Benutzer: $USER_NAME)"
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
printf '# GT-Ads: Claude darf genau dieses Programm ohne Passwort ausfuehren (setup-deploy-sudo.sh)\n%s ALL=(root) NOPASSWD: /usr/local/sbin/gtads-deploy\n' "$USER_NAME" > "$TMP"
if [ "$DRY" -eq 1 ]; then echo "[dry-run] $RULE:"; cat "$TMP"
else
  visudo -cf "$TMP" >/dev/null || { echo "sudoers-Pruefung fehlgeschlagen" >&2; exit 1; }
  install -m 0440 -o root -g root "$TMP" "$RULE"
  visudo -c >/dev/null || { rm -f "$RULE"; echo "sudoers ungueltig - Regel entfernt" >&2; exit 1; }
fi

echo "3/3 Probe (Status, nur lesend)"
run /usr/local/sbin/gtads-deploy status
echo "Fertig. Entfernen jederzeit: sudo bash $HERE/setup-deploy-sudo.sh --remove"
