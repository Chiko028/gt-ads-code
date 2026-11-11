#!/usr/bin/env bash
# Erst nach erfolgreichem Test in neuer SSH-Verbindung: Rückfall-Timer entfernen.
set -Eeuo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausführen"; exit 1; }
sshd -t
systemctl is-active --quiet ssh-rollback.timer || { echo "Kein aktiver Rückfall-Timer (evtl. schon zurückgerollt) -> nichts getan"; exit 1; }
sshd -T | grep -qix 'passwordauthentication no' || { echo "Härtung nicht aktiv -> nichts getan"; exit 1; }
systemctl stop ssh-rollback.timer ssh-rollback.service 2>/dev/null || true
systemctl reset-failed ssh-rollback.timer ssh-rollback.service 2>/dev/null || true
echo "Rückfall-Timer entfernt. Backup bleibt unter $(cat /root/.ssh-backup-latest)"
sshd -T | grep -Ei '^(permitrootlogin|passwordauthentication|x11forwarding) '
