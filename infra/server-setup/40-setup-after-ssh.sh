#!/usr/bin/env bash
# Phase 4 (Verzeichnisse + Docker) – läuft NUR, wenn die SSH-Härtung aktiv UND bestätigt ist.
# Fasst SSH, UFW, Root-Login, Neustart NICHT an. Aufruf: sudo bash 40-setup-after-ssh.sh
set -Eeuo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausführen"; exit 1; }
cd "$(dirname "$(readlink -f "$0")")"
sha256sum -c SHA256SUMS --ignore-missing --quiet || { echo "Skripte verändert seit Prüfung -> Abbruch"; exit 1; }
EFF=$(sshd -T)
echo "$EFF" | grep -qix 'passwordauthentication no' || { echo "SSH-Härtung nicht aktiv -> Abbruch"; exit 1; }
echo "$EFF" | grep -qix 'permitrootlogin no' || { echo "Root-Login nicht gesperrt -> Abbruch"; exit 1; }
if systemctl is-active --quiet ssh-rollback.timer; then echo "Rollback-Timer noch aktiv (11-ssh-confirm.sh fehlt) -> Abbruch"; exit 1; fi
ufw status | grep -q '^Status: active' || { echo "UFW nicht aktiv -> Abbruch"; exit 1; }
bash ./30-project-dirs.sh
bash ./20-docker-install.sh
echo "FERTIG. Kein Neustart durchgeführt. SSH/UFW unverändert:"; ufw status | head -8
