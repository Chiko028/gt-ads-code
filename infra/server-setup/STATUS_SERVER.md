# STATUS – GT-Ads (Projekt) auf VPS vmi3737797

Stand: 2026-11-09 10:12. SSH gehärtet, Docker + Verzeichnisse eingerichtet, Neustart durchgeführt (Kernel 6.8.0-149).

## Ist-Zustand (geprüft, nichts am System verändert)
- Ubuntu 24.04.5 LTS, Kernel 6.8.0-147 aktiv, 6 vCPU, 11 GiB RAM, 189 GB frei
- SSH-Login als taxiadmin per ED25519-Schlüssel funktioniert; VNC-Konsole (taxiadmin) getestet
- Effektiv: PermitRootLogin yes, PasswordAuthentication yes (wegen 50-cloud-init.conf, wird vor 60-cloudimg gelesen), X11Forwarding yes, MaxAuthTries 6
- UFW aktiv: deny incoming, nur 22/tcp (v4+v6); nur SSH öffentlich erreichbar
- unattended-upgrades aktiv (noble + noble-security + ESM)
- Neustart ausstehend (linux-image-6.8.0-149, linux-base)
- Docker, Fail2ban nicht installiert; /srv/taxiwerbung existiert nicht
- Fehlversuche SSH 7 Tage: 2

## Vorbereitete Skripte (alle noch NICHT ausgeführt)
- 10-ssh-harden.sh – Backup, Rollback-Timer (10 min), 00-hardening.conf, Prüfung, reload
- 11-ssh-confirm.sh – entfernt Rollback-Timer nach erfolgreichem Test
- 20-docker-install.sh – Docker CE + Compose (später)
- 40-setup-after-ssh.sh – Wrapper: prüft Prüfsummen + bestätigte SSH-Härtung + UFW aktiv, dann 30 und 20
- 30-project-dirs.sh – /srv/taxiwerbung, Gruppe taxiops, Benutzer taxiagent (später)

## Offene Aufgaben
1. ERLEDIGT: SSH-Härtung (10) + Bestätigung (11), Backup in /root/ssh-backup-20261108-193623
2. ERLEDIGT 2026-11-09: Docker CE 29.9.3, Compose v5.7.0, Buildx; /srv/taxiwerbung, /srv/taxiagents, Gruppe taxiops, Benutzer taxiagent (via 40)
3. ERLEDIGT 2026-11-09 10:10: Neustart; Kernel 6.8.0-149, reboot-required entfernt
4. Fail2ban prüfen, unnötige Dienste (snapd, ModemManager, udisks2, multipathd) bewerten
5. unattended-upgrades Log/Automatic-Reboot-Policy prüfen
6. ERLEDIGT 2026-11-09: Planungsdokumente (siehe unten). Offene Entscheidungen: OFFENE_ENTSCHEIDUNGEN.md. Abschlussbericht offen; Backup-Konzept für PostgreSQL (GitHub ersetzt kein DB-Backup)
7. Nach Abschluss: Rollback-Backup unter /root/ssh-backup-* behalten

## Ablauf (je ein sudo-Befehl durch taxiadmin)
1. `sudo bash ~/taxiwerbung-setup/10-ssh-harden.sh` (ERLEDIGT 2026-11-08 19:36, Tests bestanden)
2. Tests in neuer Verbindung (taxiwerbung ok; Passwort/Root abgelehnt)
3. `sudo bash ~/taxiwerbung-setup/11-ssh-confirm.sh`
4. `sudo bash ~/taxiwerbung-setup/40-setup-after-ssh.sh` (ERLEDIGT; taxiadmin muss sich neu anmelden für Gruppe taxiops)
5. Neustart nur nach gesonderter Zustimmung

Keine KI-Agenten eingerichtet (taxiagent-Benutzer wird nur als Platzhalter ohne Rechte angelegt).

## Stand nach Phase 4
- Nur Port 22 öffentlich; Docker-Container-Ports nur an 127.0.0.1 binden
- daemon.json: Log-Rotation, live-restore, no-new-privileges
- Vorläufig deferred: Neustart von systemd-logind/unattended-upgrades (erledigt sich mit Neustart)

## Verifikation nach Neustart (ohne root geprüft)
- Kernel 6.8.0-149, kein reboot-required; ssh, ssh.socket, docker, containerd, ufw, apparmor, unattended-upgrades: active
- Nur 22/tcp öffentlich lauschend; 00-hardening.conf aktiv
- /srv/taxiwerbung Rechte/ACL wie geplant; deploy für taxiops schreibbar; secrets nur root
- Noch mit sudo zu prüfen: `sudo ufw status verbose`, `sudo docker info`, `sudo sshd -T`

## Projekt GT-Ads (seit 2026-11-09)
- Offizieller Name: **GT-Ads**, technisch `gt-ads`. Serverordner `/srv/taxiwerbung`, Gruppe `taxiops`, Benutzer `taxiagent` bleiben vorerst unverändert (Prüfung in ARCHITEKTUR.md §12).
- Dokumente (alle in diesem Ordner): KONZEPT.md, ANFORDERUNGEN.md, ARCHITEKTUR.md (v2.1), ROADMAP.md, OFFENE_ENTSCHEIDUNGEN.md, ZUSTANDSMODELL.md, HARDWARETESTPLAN.md; Vorversionen in ARCHIV/ (v1)
- Keine Anwendungsentwicklung begonnen, keine Serveränderung, keine neuen Ports, keine Kosten ausgelöst.
- Nächster Schritt: Betreiber-Entscheidungen E1–E5 (Domain, Erreichbarkeit, Pilotgröße, Rechtsprüfung, Budget); danach Phase P2 (Gerüst) in ROADMAP.md.

## Protokoll Tablet-Betrieb v2.0 (2026-11-09) übernommen
- Eingearbeitet in alle Planungsdokumente; Kennzeichen ✅ bestätigt / 🟦 vorläufig / 🔧 Annahme / ⚖️ rechtlich zu prüfen
- Neu: ZUSTANDSMODELL.md (2 Tablets/Taxi), HARDWARETESTPLAN.md (Stufen 1–4)
- Angepasst: Statusmeldungen 30–60 min (statt 5 min), tägliche Auswertung, GPS Standard AUS, Pause-Funktion
- Keine Hardware bestellt/installiert, nichts implementiert, keine Serveränderung
- Offen neu: E36–E44 (Pausen-Semantik, Tasterart, Fahrer-App, WhatsApp, Nachlauf, Vertragsregeln, Fachbetrieb, Datenschutz/Arbeitsrecht, Zählung Pausenzeit)
