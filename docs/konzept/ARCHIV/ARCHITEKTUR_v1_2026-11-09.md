# Taxiwerbung-Plattform – Architektur- und Entwicklungsplan

Stand: 2026-11-09 · Ziel-Hardware: Contabo VPS 6 (6 vCPU, 12 GB RAM, ~190 GB SSD) · Status: PLAN, keine Implementierung

## 1. Leitprinzipien
1. **Modularer Monolith statt Microservices.** Ein Backend-Prozess + ein Worker, klar getrennte Module. Spart RAM, einfacher zu betreiben, später teilbar.
2. **Alles in Docker Compose, konfiguriert per Umgebung (12-Factor).** Keine IPs, Pfade oder Hostnamen im Code → Migration auf Dedicated Server = Compose-Projekt + Daten umziehen.
3. **Tablets sind „offline-first".** Das Tablet spielt aus lokalem Speicher; der Server ist Quelle der Wahrheit, nicht Voraussetzung für die Wiedergabe.
4. **Nur 443 (und nach Freigabe 80) öffentlich.** Alles andere (DB, Monitoring, Admin) bleibt intern oder hinter VPN.
5. **KI-Agenten sind Fremdkörper:** getrennter Benutzer, Netz, Ressourcenlimit, nur API-Tokens mit minimalen Rechten.
6. **GitHub = Quellcode. Datenbank/Medien = eigenes Backup.**

## 2. Technologieauswahl (Empfehlung)

| Bereich | Wahl | Begründung |
|---|---|---|
| Reverse Proxy / TLS | **Caddy** | Automatisches Let's Encrypt, 1 Konfig-Datei, ~30 MB RAM |
| Backend-API | **TypeScript, Node 22, Fastify** (+ Zod-Schemas, OpenAPI) | Eine Sprache mit Dashboard, schnell, geringer RAM-Bedarf |
| Datenbank | **PostgreSQL 17** | Relational, Partitionierung, JSONB, auch als Job-Queue (SKIP LOCKED) nutzbar |
| ORM/Migrationen | **Drizzle ORM** + SQL-Migrationen | Typsicher, SQL bleibt sichtbar |
| Job-Queue | **pg-boss** (auf Postgres) | Kein Redis nötig → ein Dienst weniger |
| Dashboard | **React + Vite + TypeScript** (statisches SPA, von Caddy ausgeliefert) | Kein eigener Node-Prozess zur Laufzeit |
| Medienverarbeitung | **ffmpeg** im Worker-Container (max. 2 vCPU) | Transkodierung auf einheitliches Tablet-Profil |
| Medienspeicher | Dateisystem hinter **Storage-Interface** (S3-kompatibel austauschbar) | Heute lokal, später MinIO/S3 ohne Codeänderung |
| Android-App | **Kotlin, Media3/ExoPlayer, WorkManager, Room** | Zuverlässige Offline-Wiedergabe, resumable Downloads |
| Tablet-Verwaltung | **Android Device Owner / Lock-Task-Modus (Kiosk)** | App als einzige App, Autostart, kein Nutzer-Ausstieg |
| Monitoring | **Prometheus + Grafana + node_exporter + cAdvisor**, **Uptime Kuma** | Standard, ~1–1,5 GB gesamt, nur intern erreichbar |
| Logs | Docker json-file (rotiert) → optional **Loki** später | Anfangs reicht `docker logs` + strukturierte JSON-Logs |
| Admin-Zugang | **Tailscale** (kostenlos für Einzelperson) oder IP-Allowlist | Dashboard/Grafana nicht ins offene Internet |
| CI/CD | GitHub Actions → Images in **GHCR** → manuelles Deployment (`docker compose pull && up`) | Keine automatischen Produktiv-Deployments ohne Freigabe |

Bewusst weggelassen: Kubernetes, Redis, Kafka, ClickHouse, Elasticsearch (zu schwer für 12 GB / aktuell unnötig).

## 3. Komponenten und Ressourcenbudget (12 GB RAM, 6 vCPU)

| Komponente | Container | RAM-Limit | CPU-Limit |
|---|---|---|---|
| PostgreSQL | `db` | 3,0 GB (shared_buffers 1 GB, effective_cache 5 GB) | 2 |
| Backend-API | `api` | 1,0 GB | 1,5 |
| Worker (Jobs, ffmpeg) | `worker` | 1,5 GB | 2 (nice) |
| Caddy | `proxy` | 0,15 GB | 0,5 |
| Prometheus + Grafana + Exporter | `mon-*` | 1,5 GB | 1 |
| Uptime Kuma | `kuma` | 0,25 GB | 0,25 |
| KI-Agenten (später, getrennt) | `agent-*` | 2,0 GB gesamt | 1 |
| Reserve OS + Page-Cache (Videos!) | – | ~2,5 GB | – |

Wichtig: Der **Linux-Page-Cache** beschleunigt Video-Auslieferung; deshalb 2–3 GB bewusst frei lassen. **Swap (2–4 GB)** als Sicherheitsnetz einrichten (Entscheidung offen, siehe §10).

## 4. Netzwerk und Exposition
```
Internet ──443──► Caddy ──► api (intern)         /api/*, /media/* (signierte URLs)
                      └──► dashboard (statisch)   /  (nur Admin-IP/VPN, siehe unten)
Tailscale/VPN ──► Grafana, Kuma, Dashboard-Admin (nur an 127.0.0.1 / Tailscale-IF gebunden)
```
- Docker-Netze: `edge` (Caddy↔api), `backend` (api/worker↔db, **internal**), `monitoring`, `agents` (**getrennt, kein Zugang zu `backend`**).
- Container-Ports niemals `0.0.0.0` veröffentlichen; nur Caddy auf 80/443 (**Port-Freigabe erforderlich!**). Alternative ohne offene Ports: Cloudflare Tunnel (kostenlos) – Entscheidung offen.
- Domain/Subdomain nötig (`api.…`, `admin.…`), DNS per CNAME/A → bei Migration nur DNS ändern.

## 5. Datenmodell (Kern)
`organizations` · `users`/`roles` · `vehicles` · `devices` (Tablet, Enrollment-Status, App-/OS-Version, last_seen) · `media_assets` (sha256, Dauer, Profile, Größe) · `campaigns` (Kunde, Zeitraum, Priorität, Ziel-Gebiet/Fahrzeuggruppen) · `campaign_assets` · `schedules` · `playlists`/`playlist_versions` (unveränderlich, versioniert) · `device_manifests` · `playback_events` (**monatlich partitioniert**) · `device_heartbeats` · `audit_log` · `agent_tokens`/`agent_runs`.
Aggregation: nächtliche Rollups (`stats_daily_campaign`, `stats_daily_device`) per Job; Rohdaten 13 Monate, Aggregate unbegrenzt.

## 6. Datenfluss
**a) Medien-Upload:** Dashboard → API (resumable Upload, Größen-/MIME-Prüfung) → Worker: Virenscan optional, ffmpeg-Transkodierung (z. B. H.264 1080p/720p, Ziel-Bitrate) → `media_assets` mit sha256 → inhaltsadressierte Ablage (`/srv/taxiwerbung/data/media/<sha256>`).
**b) Kampagne → Tablet:** Kampagne/Zeitplan ändern → Worker baut neue **Manifest-Version** (Liste Medien+Reihenfolge+Gültigkeit+Hashes) → Tablet fragt `GET /device/manifest` (ETag/Long-Poll alle 5–15 min, optional MQTT/WebSocket-Push) → neues Manifest → Download nur fehlender Dateien (Range-Requests, Prüfsumme) → **atomares Umschalten**, sobald alles vollständig; alte Dateien erst nach Garbage-Collection löschen.
**c) Wiedergabe:** Lokaler Scheduler im Tablet (Zeitfenster, Priorität, Rotation) → Proof-of-Play-Events (`event_id` UUID, Zeitstempel monotonic+wall) lokal in Room gepuffert → gebündelt hochgeladen (`POST /device/events`, idempotent) → Postgres → Rollups → Dashboard.
**d) Monitoring:** Heartbeat (Akku, Speicher, App-Version, Netz, Manifest-Version, optional grobe Position) alle 5 min → Alarm „Tablet seit X Std offline".

## 7. Sicherheitskonzept
- **Host:** SSH nur Schlüssel, kein Root-Login (erledigt), UFW default deny, unattended-upgrades, Docker-Gruppe nicht verwenden (sudo), Fail2ban optional.
- **Container:** non-root User, `read_only` Dateisystem wo möglich, `cap_drop: [ALL]`, `no-new-privileges` (bereits Daemon-Standard), Ressourcenlimits, feste Image-Versionen/Digests, Trivy-Scan in CI.
- **Secrets:** nur in `/srv/taxiwerbung/secrets` (root, 700) bzw. Docker-Secrets; nie in Git; `.env` nicht committen; Rotation dokumentiert.
- **API:** HTTPS only, Rate-Limit, Eingabevalidierung (Zod), Dashboard-Login mit **MFA (TOTP/Passkey)**, RBAC, Audit-Log; Geräte authentifizieren sich mit **geräteeigenem Schlüssel/Token** (Enrollment per einmaligem QR-Token, danach widerrufbar).
- **Medien-Downloads:** kurzlebige signierte URLs je Gerät; Hash-Prüfung im Tablet.
- **Datenschutz (AT/DSGVO):** Standortdaten nur grob/aggregiert und nur wenn nötig; keine Fahrgastdaten/Kamera/Mikrofon; Löschfristen; Verzeichnis der Verarbeitungstätigkeiten.
- **Backups:** siehe §9.

## 8. Isolierte KI-Agenten (spätere Etappe)
- Eigener Linux-Benutzer `taxiagent` (existiert, ohne Rechte), eigenes Compose-Projekt unter `/srv/taxiagents`, eigenes Docker-Netz `agents`, **kein Zugriff auf `/srv/taxiwerbung`, DB-Netz, Docker-Socket, Secrets**.
- Agent-Container: non-root, read-only Root-FS, `cap_drop ALL`, CPU 1 / RAM 2 GB / PIDs-Limit, ausgehender Verkehr nur per Allowlist (API + gewünschte Dienste).
- Zugriff nur über die **öffentliche API mit Agent-Token** (Rollen: z. B. `report:read`, `campaign:draft`), niemals Direktzugriff auf die DB. Schreibaktionen erzeugen **Entwürfe**, die ein Mensch freigibt (Human-in-the-loop). Alle Aktionen im `audit_log`; Tokens kurzlebig, widerrufbar, Budget-Limit pro Agent.
- Kein Root, kein sudo, keine Produktiv-Deployments durch Agenten.
- Optional später: gVisor/Sysbox oder eigene VM für stärkere Isolierung.

## 9. Betrieb: Backup, Recovery, Migration
- **PostgreSQL:** täglich `pg_dump` + kontinuierliche WAL-Archivierung (**pgBackRest**), Aufbewahrung 14 Tage + 4 Wochen; **Offsite-Ziel erforderlich** (Server-intern allein ist kein Backup). Wiederherstellungstest vierteljährlich dokumentieren.
- **Medien:** Originale separat sichern (Transkodate sind reproduzierbar). Offsite-Ziel notwendig → ggf. kostenpflichtig (nicht bestellt, Freigabe nötig).
- **Konfiguration:** Compose-Dateien, Caddyfile, Ansible-Playbooks in Git (ohne Secrets).
- **Migration auf Dedicated Server:**
  1. Setup per Ansible/Skripten (aus unseren `10–40`-Skripten ableitbar) auf neuem Host.
  2. Postgres: physische Replikation (oder `pg_basebackup` + WAL) auf neuen Host, Cutover mit kurzem Schreibstopp.
  3. Medien: `rsync` (inhaltsadressiert → idempotent).
  4. DNS-TTL vorher senken, dann `api.…` umstellen; Tablets nutzen nur Domain, **keine App-Neuauslieferung**.
  5. Rollback: alter Host bleibt 7 Tage unverändert.
  Voraussetzung dafür: Storage-Interface, keine Host-spezifischen Pfade, Domain statt IP, Container mit festen Versionen.
- Skalierung später: DB auf eigenen Host, Worker/Transkodierung auf weitere Hosts, Medien hinter CDN/Objektspeicher, Rollups auf ClickHouse falls nötig – ohne Änderung des API-Vertrags.

## 10. Offene Entscheidungen (brauche deine Antwort)
1. **Domain** vorhanden? (für TLS und Tablets zwingend)
2. **Öffentliche Ports 80/443** freigeben **oder** Cloudflare-Tunnel verwenden?
3. **Offsite-Backup-Ziel** (kostenpflichtig, z. B. Objektspeicher/Storage Box) – Budget ok?
4. **Anzahl Tablets/Fahrzeuge** zu Beginn / in 12 Monaten, durchschnittliche Videolänge/-größe, Anzahl Werbespots pro Tablet?
5. **Standortdaten** (GPS) für Kampagnen gewünscht (Geo-Targeting)? Datenschutz-Folge!
6. **Tablet-Modelle / Android-Version** und Verwaltung als Device Owner (Factory-Reset-Provisionierung ok)?
7. **Swap** (2–4 GB) einrichten – einverstanden?
8. **Mehrere Mandanten/Kunden** im Dashboard (Werbekunden-Login) oder nur interne Verwaltung?

## 11. Umsetzungsetappen
| # | Etappe | Ergebnis | Freigabe nötig |
|---|---|---|---|
| 0 | **Fundament** | SSH gehärtet, Docker, Verzeichnisse, Neustart – ERLEDIGT | – |
| 1 | Repo + Gerüst | Monorepo (api, worker, dashboard, android), CI, Compose-Grundgerüst, Caddy intern, Healthchecks | nein |
| 2 | Kern-Backend | DB-Schema/Migrationen, Auth+MFA, Rollen, Geräte-Enrollment, Audit-Log | nein |
| 3 | Medien + Kampagnen | Upload, Transkodierung, Kampagnen/Zeitpläne, Manifest-Erzeugung, signierte Downloads | nein |
| 4 | Android-Player MVP | Enrollment, Manifest-Sync, Download, Offline-Wiedergabe, Kiosk-Modus | Testgerät |
| 5 | Statistiken + Monitoring | Proof-of-Play, Rollups, Dashboard-Reports, Prometheus/Grafana/Kuma, Alarme | nein |
| 6 | Betrieb härten | pgBackRest + Offsite-Backup, Restore-Test, Lasttest (viele Tablets), Update-Prozess | **Backup-Ziel (kostenpflichtig)** |
| 7 | Produktiv-Start | Domain, TLS, Port 443 öffnen, Pilot mit wenigen Fahrzeugen | **Ports + Deployment-Freigabe** |
| 8 | KI-Agenten (sandboxed) | Agent-API, Tokens, Netz/Limits, Human-in-the-loop-Freigabe | **Freigabe je Agent** |
| 9 | Migrationsreife | Ansible-Playbooks, Migrations-Runbook, Probe-Umzug | nein |

Empfehlung: Etappe 1 starten, sobald Fragen 1, 2, 4 und 8 beantwortet sind. Etappen 1–3 können lokal/in Docker ohne öffentliche Ports entwickelt werden.
