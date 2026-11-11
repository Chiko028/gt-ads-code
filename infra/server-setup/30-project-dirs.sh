#!/usr/bin/env bash
# Verzeichnisse und getrennte Benutzer. Aufruf: sudo bash 30-project-dirs.sh
# Idempotent; ändert keine bestehenden Dateiinhalte, setzt Rechte nur auf die angelegten Ordner (nicht rekursiv).
set -Eeuo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausführen"; exit 1; }
apt-get install -y acl
getent group taxiops >/dev/null || groupadd taxiops
usermod -aG taxiops taxiadmin
# Agenten-Benutzer: ohne sudo, ohne docker, ohne Shell, ohne Passwort
id taxiagent >/dev/null 2>&1 || useradd --system --user-group --no-create-home --home-dir /srv/taxiagents --shell /usr/sbin/nologin taxiagent

B=/srv/taxiwerbung
# PostgreSQL-Daten: benannte Docker-Volumes statt Bind-Mount (keine UID-Probleme) -> kein data/postgres
DIRS="$B $B/app $B/compose $B/deploy $B/logs $B/data $B/data/media $B/backups $B/secrets"
for d in $DIRS; do mkdir -p "$d"; chown root:taxiops "$d"; chmod 2770 "$d"; done
chmod 2750 $B/backups          # taxiops liest, nur root schreibt
chown root:root $B/secrets; chmod 700 $B/secrets   # nur root (Compose liest .env/Secrets per sudo)
# Default-ACL: neue Dateien sind für Gruppe taxiops les-/schreibbar (Deployments ohne chmod)
for d in $B/app $B/compose $B/deploy $B/logs; do setfacl -m d:g:taxiops:rwX -m g:taxiops:rwX "$d"; done

mkdir -p /srv/taxiagents/workspace /srv/taxiagents/logs
chown taxiagent:taxiagent /srv/taxiagents /srv/taxiagents/workspace /srv/taxiagents/logs
chmod 750 /srv/taxiagents
chmod 755 /srv                  # /srv bleibt durchsuchbar; $B ist für 'other' gesperrt (2770)
ls -ld $B $B/* /srv/taxiagents; id taxiagent
echo "taxiadmin muss sich neu anmelden, damit die Gruppe taxiops gilt."
