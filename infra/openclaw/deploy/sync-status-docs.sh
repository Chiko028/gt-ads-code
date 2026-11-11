#!/usr/bin/env bash
# Spiegelt NUR docs/ aus main des Repos in den Lese-Workspace des Statusagenten (keine Secrets, kein Code).
#   sudo bash sync-status-docs.sh [REPO_DIR]
set -Eeuo pipefail
REPO="${1:-/srv/taxiwerbung/app/gt-ads}"
DEST=/var/lib/openclaw/workspace-status/docs
[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausfuehren." >&2; exit 1; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
git -C "$REPO" archive main docs | tar -x -C "$TMP"
rm -rf "$DEST.new"; install -d -m 0750 -o openclaw -g openclaw "$(dirname "$DEST")"
cp -r "$TMP/docs" "$DEST.new"; chown -R root:openclaw "$DEST.new"; chmod -R u=rwX,g=rX,o= "$DEST.new"
rm -rf "$DEST.old"; [ -d "$DEST" ] && mv "$DEST" "$DEST.old"; mv "$DEST.new" "$DEST"; rm -rf "$DEST.old"
echo "Docs-Spiegel aktualisiert: $DEST (root-eigen, fuer openclaw nur lesbar)"
