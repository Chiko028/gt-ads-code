#!/usr/bin/env bash
# Spiegelt NUR docs/ARBEITSPAKETE aus main in das Spezifikationsverzeichnis des Runners (root-eigen, fuer occoder nur lesbar).
#   sudo bash sync-runner-specs.sh [REPO_DIR]
set -Eeuo pipefail
cd /
REPO="${GTADS_REPO:-${1:-/srv/taxiwerbung/app/gt-ads}}"   # gtads-deploy setzt GTADS_REPO/GTADS_REF auf den geprueften Stand
REF="${GTADS_REF:-main}"
DEST=/var/lib/occoder/specs
[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausfuehren." >&2; exit 1; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
git -C "$REPO" archive "$REF" docs/ARBEITSPAKETE | tar -x -C "$TMP"
rm -rf "$DEST.new"; cp -r "$TMP/docs/ARBEITSPAKETE" "$DEST.new"; chown -R root:root "$DEST.new"; chmod -R u=rwX,go=rX "$DEST.new"
rm -rf "$DEST.old"; [ -d "$DEST" ] && mv "$DEST" "$DEST.old"; mv "$DEST.new" "$DEST"; rm -rf "$DEST.old"
# Seed fuer den Integrationsstand von Plaenen (WP-013): vollstaendiger Stand von main als Archiv (nur gelesen; keine Secrets im Repository).
SEEDS=/var/lib/occoder/seeds
install -d -m 0755 -o root -g root "$SEEDS"
git -C "$REPO" archive -o "$SEEDS/gt-ads-main.tar.new" "$REF"
chmod 0644 "$SEEDS/gt-ads-main.tar.new"; mv "$SEEDS/gt-ads-main.tar.new" "$SEEDS/gt-ads-main.tar"
echo "Seed aktualisiert: $SEEDS/gt-ads-main.tar ($(git -C "$REPO" rev-parse --short "$REF")). Ein bestehender Integrationsstand wird NICHT ueberschrieben."
# Codex-Planer (falls installiert): eigener Seed im Planungsbereich (Roadmap-Kontext; nur main)
if [ -d /var/lib/gt-ads-plan/seeds ]; then
  git -C "$REPO" archive -o /var/lib/gt-ads-plan/seeds/gt-ads-main.tar.new "$REF"
  chmod 0644 /var/lib/gt-ads-plan/seeds/gt-ads-main.tar.new; mv /var/lib/gt-ads-plan/seeds/gt-ads-main.tar.new /var/lib/gt-ads-plan/seeds/gt-ads-main.tar
fi
echo "Spezifikationen gespiegelt: $DEST (aendert sich eine Spezifikation, werden offene Freigaben ungueltig)"
