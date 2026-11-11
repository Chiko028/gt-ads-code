#!/usr/bin/env bash
# OpenClaw vollstaendig zurueckbauen (nur Betreiber, sudo). Das Python-Gateway wird NICHT wiederhergestellt.
#   sudo bash uninstall.sh [--dry-run] [--purge-state] [--purge-credentials] [--remove-users]
set -Eeuo pipefail

DRY=0; PURGE_STATE=0; PURGE_CRED=0; RM_USERS=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;; --purge-state) PURGE_STATE=1 ;; --purge-credentials) PURGE_CRED=1 ;; --remove-users) RM_USERS=1 ;;
    -h|--help) sed -n '2,3p' "$0"; exit 0 ;;
    *) echo "Unbekannte Option: $arg" >&2; exit 2 ;;
  esac
done
run() { if [ "$DRY" -eq 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd / # Arbeitsverzeichnis neutral: Benutzer openclaw darf das Repo-Verzeichnis nicht lesen (EACCES)
if [ "$DRY" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then echo "Bitte mit sudo ausfuehren (oder --dry-run)." >&2; exit 1; fi

run systemctl disable --now gt-ads-openclaw.service || true
run systemctl disable --now gt-ads-egress-proxy.service || true
run rm -f /etc/systemd/system/gt-ads-openclaw.service /etc/systemd/system/gt-ads-egress-proxy.service
run systemctl daemon-reload
run rm -rf /opt/openclaw /opt/gt-ads/egress-proxy
[ "$PURGE_STATE" -eq 1 ] && run rm -rf /var/lib/openclaw || echo "Zustand /var/lib/openclaw bleibt erhalten (--purge-state zum Loeschen)."
[ "$PURGE_CRED" -eq 1 ] && run rm -rf /etc/gt-ads/openclaw-credentials || echo "Credentials /etc/gt-ads/openclaw-credentials bleiben erhalten (--purge-credentials)."
if [ "$RM_USERS" -eq 1 ]; then run userdel openclaw || true; run userdel gtads-egress || true; fi
echo "Rueckbau abgeschlossen."
