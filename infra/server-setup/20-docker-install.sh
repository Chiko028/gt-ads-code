#!/usr/bin/env bash
# Docker Engine + Compose-Plugin aus dem offiziellen Docker-Repository (Ubuntu 24.04 noble).
# Aufruf: sudo bash 20-docker-install.sh
set -Eeuo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausführen"; exit 1; }
[ ! -e /etc/docker/daemon.json ] || { echo "/etc/docker/daemon.json existiert schon -> Abbruch"; exit 1; }
# Konfliktpakete laut Docker-Doku (nur falls installiert; hier aktuell keine)
for p in docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc; do
  dpkg -s "$p" >/dev/null 2>&1 && apt-get remove -y "$p" || true
done
apt-get update
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<SRC
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
SRC
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
# daemon.json vor dem ersten Start des Dienstes, dann starten
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<J
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true,
  "no-new-privileges": true
}
J
systemctl enable docker
systemctl restart docker
docker --version; docker compose version
docker info --format 'LiveRestore={{.LiveRestoreEnabled}} SecOpts={{.SecurityOptions}}'
ss -tlnp | grep -c docker-proxy || true
echo "HINWEIS: taxiadmin NICHT in Gruppe 'docker' aufnehmen (=root-äquivalent). Docker-Befehle mit sudo."
echo "HINWEIS: Container-Ports nur als 127.0.0.1:PORT:PORT veröffentlichen (Docker umgeht UFW sonst)."
echo "HINWEIS: no-new-privileges gilt als Standard für alle Container; einzeln überschreibbar."
