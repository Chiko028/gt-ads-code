# GT-Ads – Technische Architektur (v2.1)

Stand: 2026-11-09 · Ersetzt `ARCHIV/ARCHITEKTUR_v1_2026-11-09.md` · Status: PLAN, keine Implementierung
Zielumgebung: Contabo VPS 6 (6 vCPU, ~12 GB RAM, ~190 GB SSD), Ubuntu 24.04, Docker. Entscheidungen sind Vorschläge, bis sie in `OFFENE_ENTSCHEIDUNGEN.md` bestätigt sind.

## 0. Änderungsprotokoll gegenüber v1
| Thema | v1 | v2 (warum) |
|---|---|---|
| Name | Taxiwerbung | **GT-Ads**, technisch `gt-ads` (Auftrag Betreiber) |
| Ereignisvolumen | „Rohdaten 13 Monate" | **Neu berechnet** (§6): bis ~144 Mio. Wiedergaben/Monat bei 2.000 Tablets → Rohdaten nur 60–90 Tage, Aggregate dauerhaft, Gerät sendet kompakt |
| Metriken | „Proof-of-Play" | Verbindliche Begriffe **Wiedergabe / Verifizierte Wiedergabe / Kontaktchance** (`ANFORDERUNGEN.md` §4) |
| Fahrzeugmodell | Gerät | **Taxi hat 2 Tablets**, gemeinsame Zuordnung, Medien-Dedup pro Taxi als V2-Optimierung |
| Buchung | Kampagne/Zeitplan | **Buchung ≠ Kampagne ≠ Schleifenplatz**: erweiterbares Regelmodell (§5) |
| Kiosk/Fernverwaltung | Device Owner genannt | Eigener schlanker Device-Owner-Controller + Update-Kanal; MDM-Zukauf als Alternative bewertet (§8) |
| Hardwarerisiken | nicht behandelt | Hitze, Strom, Diebstahl, Mobilfunk als eigene Risiken/Tests (§13) |
| Tablet-Betrieb (Protokoll v2.0) | – | Neuer Abschnitt §15: Zustandsautomat, Fahrzeugbereitschaft, Pause/Taster, Presence-Schnittstelle, GPS-Modi (Standard aus) |
| Heartbeat | alle 5 min | **30–60 min** + Zustandswechsel (Protokoll §5), Alarmlogik angepasst |
| Unverändert übernommen | | Modularer Monolith, Fastify/TS, PostgreSQL+pg-boss, Caddy, React-SPA, Compose, Prometheus/Grafana/Kuma, Sicherheits- und Agentenkonzept, Migrationsprinzipien |

## 1. Leitprinzipien (unverändert, präzisiert)
1. Modularer Monolith (API + Worker), später teilbar.
2. Docker Compose, 12-Factor-Konfiguration, keine festen IPs/Pfade im Code.
3. **Offline-first:** Wiedergabe läuft ohne Server.
4. Nur 443 (und ggf. 80) öffentlich; alles Administrative intern/VPN. **Kein neuer Port ohne Freigabe.**
5. KI-Agenten getrennt, ohne Produktivzugriff.
6. GitHub = Code. Datenbank/Medien = eigenes Backup.
7. Selbst betreibbar, offene Komponenten, kein Lock-in.

## 2. Technologie
| Bereich | Wahl | Anmerkung |
|---|---|---|
| Proxy/TLS | Caddy | |
| Backend | TypeScript, Node 22, Fastify, Zod/OpenAPI | Ein Repo `gt-ads` (Monorepo, pnpm) |
| DB | PostgreSQL 17, Drizzle + SQL-Migrationen | Partitionierung, JSONB |
| Jobs | pg-boss | Kein Redis |
| Dashboard | React + Vite (statisch) | Kundenportal später im selben Codebestand, andere Rolle/Mandant |
| Medien | ffmpeg im Worker, Storage-Interface (lokal → S3-kompatibel) | |
| Android | Kotlin, Media3/ExoPlayer, WorkManager, Room, Device-Owner-Controller | |
| Monitoring | Prometheus, Grafana, node_exporter, cAdvisor, Uptime Kuma | nur intern |
| Admin-Zugang | Tailscale oder IP-Allowlist | Entscheidung offen |
| CI/CD | GitHub Actions, Images nach GHCR, Deployment manuell freigegeben | |
Bewusst nicht: Kubernetes, Kafka, Redis, ClickHouse, Elasticsearch (zu schwer/unnötig bis Skalierungsbedarf nachgewiesen).

## 3. Komponenten und Ressourcen (12 GB / 6 vCPU)
| Container | RAM | CPU | Hinweis |
|---|---|---|---|
| `gt-ads-db` (Postgres) | 3,0 GB | 2 | shared_buffers 1 GB; WAL auf SSD |
| `gt-ads-api` | 1,0 GB | 1,5 | |
| `gt-ads-worker` | 1,5 GB | 2 (nice) | ffmpeg max. 2 Jobs |
| `gt-ads-proxy` (Caddy) | 0,15 GB | 0,5 | Medien-Auslieferung mit Range/ETag |
| Monitoring-Stack | 1,5 GB | 1 | |
| Kuma | 0,25 GB | 0,25 | |
| Agenten (V3, getrennt) | 2,0 GB | 1 | |
| Reserve + Page-Cache | ~2,5 GB | | Page-Cache beschleunigt Videoabruf |
Swap 2–4 GB als Sicherheitsnetz: Entscheidung offen. Container-Namen/Netze/Volumes tragen das Präfix `gt-ads-`.

## 4. Netzwerk und Exposition
```
Tablets ──HTTPS 443──► Caddy ──► api  (/device/*, signierte /media/*)
Admin ──Tailscale/VPN──► Dashboard, Grafana, Kuma (nur 127.0.0.1/Tailscale-IF)
```
Docker-Netze: `gt-ads-edge`, `gt-ads-backend` (internal), `gt-ads-monitoring`, `gt-ads-agents` (ohne Zugang zu backend). Container-Ports nie auf 0.0.0.0. Öffentliche Erreichbarkeit der Geräte-API (443) ist **zwingend**, da Tablets sie von Mobilfunk aus erreichen; Alternative ohne offenen Port: Cloudflare Tunnel (Entscheidung offen). Admin-Dashboard wird **nicht** öffentlich gemacht. Domain nötig; Tablets sprechen nur Domainnamen.

## 5. Domänenmodell
Kern: `organizations` (GT-Ads, Partner, Kunden) · `users`/`roles` · `taxis` (Kennzeichen/Fahrzeug-ID, Partner, Status) · `devices` (genau 2 je Taxi, Seriennummer, Enrollment, Version) · `device_groups`/`taxi_groups` · `media_assets` (sha256, Dauer, Profile) · `creatives` (Motiv-Freigabestatus) · `customers` · `campaigns` · **`bookings`** (Kunde, Zeitraum, Ziel: Taxi/Gruppe, Regeltyp, Parameter JSONB, Preis-/Vertragsreferenz) · **`loop_slots`** (Plan: Platz 1..16, Dauer 15 s, Belegung je Zeitraum/Zielgruppe) · `manifests` (unveränderlich, Version, Hash) · `play_events_*` (§6) · `device_heartbeats` · `stats_daily_*` · `partner_payout_basis` (Vergütungsgrundlage, Betrag nicht automatisch) · `audit_log` · `agent_tokens`/`agent_runs`.
**Regelmodell:** Booking-Regeltyp (`fixed_slot`, `weighted`, `time_window`, `exclusive`) wird vom Manifest-Generator in eine konkrete, deterministische Abspielliste je Gerät/Gruppe übersetzt. Das Tablet kennt nur die fertige Liste (einfach, offline-sicher). Neue Buchungsmodelle = neuer Regeltyp im Generator, kein App-Update (solange Manifest-Schema gleich bleibt).

## 6. Datenfluss und Datenmengen
**Wiedergabevolumen (Rechnung, Annahme 10 h Betrieb/Tag):** 15-s-Spots → 240 Wiedergaben/Stunde/Tablet → ~2.400/Tag → bei 2.000 Tablets ≈ **4,8 Mio./Tag ≈ 144 Mio./Monat**. Bei ~100 Byte/Zeile ≈ 14 GB/Monat Rohdaten.
**Konsequenzen:**
- Tablet bündelt Ereignisse (Batch, Kompression), Upload bei Verbindung, idempotent über `device_id + Sequenznummer`.
- Rohereignisse in **monatlich/wöchentlich partitionierten** Tabellen, Retention 60–90 Tage (Partition droppen), danach nur `stats_daily_*` (je Kampagne/Gerät/Spot/Stunde). Keine Rohdaten-Dauerarchivierung ohne Bedarf.
- Rollups per Job (nächtlich + stündlich inkrementell). Bei Bedarf später Verdichtung auf Gerät (Zähler je Spot/Stunde plus Stichproben-Rohdaten).
- Statusmeldung alle 30–60 min × 2.000 ≈ 0,6–1,1 Anfragen/s; Zündungswechsel erzeugen Spitzen → zufälliger Versatz (Jitter) in der App: unkritisch.
**Medienvolumen (Annahme 15 s @ ~4 Mbit/s ≈ 7,5 MB/Spot):** 16 Spots ≈ 120 MB/Tablet; Komplettaustausch aller Spots für 2.000 Tablets ≈ 240 GB (≈ 120 GB mit Dedup je Taxi). Neuer Spot an alle Tablets ≈ 15 GB: Verteilung per **gestaffeltem Abruf (Jitter)** und Priorisierung WLAN/Nacht. Bandbreite/Traffic des VPS-Tarifs **vor Pilotende prüfen**. Mobile Daten je Tablet im Normalbetrieb voraussichtlich ≪ 1 GB/Monat (im Pilot messen).
**Abläufe:**
1. Upload → Worker transkodiert (H.264, Profil für Zieltablets) → `media_assets` (sha256) → Freigabestatus.
2. Buchung/Kampagne ändern → Generator baut **neue Manifest-Version** → Tablet pollt (5–15 min, optional Push) → lädt fehlende Dateien (Range, Hash) → **atomar umschalten**, Altbestand per GC.
3. Wiedergabe: lokaler Scheduler (Laufzeitfenster aus Manifest) → Ereignispuffer (Room) → Batch-Upload.
4. Statusmeldung → Zustandsmodell → tägliche Auswertung (`ZUSTANDSMODELL.md`) → Alarme nur für technische Fehler.

## 7. Sicherheitskonzept
- **Host:** SSH nur Schlüssel, Root-Login aus, UFW deny-in, unattended-upgrades; Docker nur via sudo (nicht Gruppe `docker`). [Stand: umgesetzt]
- **Container:** non-root, read-only FS, `cap_drop ALL`, `no-new-privileges`, Limits, gepinnte Images, Trivy in CI.
- **Secrets:** `/srv/taxiwerbung/secrets` (root), nie in Git.
- **Geräte:** Keystore-Schlüssel, Enrollment-Token einmalig, Widerruf, Sperre bei Verlust/Diebstahl, kurzlebige Download-URLs, Hash-Prüfung, TLS mit Zertifikatsprüfung (Pinning prüfen).
- **Ereignisintegrität:** Gerätesession + Plausibilitätsprüfungen (Sequenz, Zeitfenster, Rate = höchstens 1 Spot/15 s); signierte Batches (V2).
- **Dashboard:** MFA, RBAC, Audit-Log, Rate-Limits.
- **Datenschutz:** keine Fahrgastdaten, keine Kamera/Mikrofon; Standort nur nach Entscheidung/Rechtsprüfung; Löschkonzept.
- **Zeit:** Gerätezeit kann abweichen → Server-Offset beim Sync, monotonic Uhr im Gerät, Zeitstempel doppelt (monoton + Wall).

## 8. Android-Betrieb
- **Provisionierung:** Factory-Reset → QR/Zero-Touch-Variante → App wird **Device Owner** → Kiosk (Lock-Task), Auto-Start, USB-Debug aus, Wartungsmodus nur über Server-Befehl.
- **Updates:** eigener signierter Update-Kanal; als Device Owner stille Installation möglich; gestaffelter Rollout (z. B. 5 % → 25 % → 100 %), Rollback auf Vorversion. MVP: manuell per ADB/QR; V2: OTA.
- **Alternative:** Fertige MDM-Lösung (z. B. Open-Source) statt Eigenbau – im Pilot bewerten, Entscheidung offen. Kriterium: Kontrolle, Kosten, Wartungsaufwand.
- **Hardware (offen):** Tablets mit Dauerbetriebstauglichkeit (Akku-Schutz/Ladelimit, Temperatur, Brandschutz), Fahrzeugstrom 12 V → USB-PD mit Spannungsschutz und Zündungsabschaltung, Halterung abschließbar, SIM je Tablet vs. ein LTE-Router je Taxi (Kosten/Ausfallrisiko – offen, Pilot vergleicht).

## 9. KI-Agenten (V3)
Wie v1: Benutzer `taxiagent`, `/srv/taxiagents`, Docker-Netz `gt-ads-agents`, kein Zugriff auf `/srv/taxiwerbung`, DB, Docker-Socket, Secrets; Container non-root/read-only/cap-drop/Limits; ausgehend nur Allowlist; Zugriff nur über API mit Agent-Token, Rollen `report:read`, `fleet:read`, `campaign:draft`; Schreiben nur als Entwurf mit menschlicher Freigabe; Audit; kein Root/sudo/Deploy. **Freigabekonzept:** jede neue Agentenfähigkeit = dokumentierter Antrag (Zweck, Rechte, Limits, Rücknahme), von dir genehmigt; produktive Änderungen nie autonom. Agenten laufen auf dem Server (unabhängig vom PC); eine zweite, kleinere Umgebung für Test-/Entwicklungs-Agenten ohne Kundendaten (Testdatenbank) ist zu bevorzugen.

## 10. Backup und Recovery
PostgreSQL: täglich `pg_dump` + WAL-Archivierung (pgBackRest), Offsite-Ziel nötig (**kostenpflichtig → Freigabe**). Medien-Originale getrennt sichern (Transkodate reproduzierbar). Konfiguration in Git (ohne Secrets). Restore-Test vor Pilotstart und danach quartalsweise. RPO MVP ≤ 24 h.

## 11. Migration VPS → Dedicated Server
Voraussetzungen (jetzt einhalten): Domain statt IP, Storage-Interface, keine Host-Pfade im Code, gepinnte Container, Setup als Skripte/Ansible (Basis: unsere Skripte `10–40`), Konfig per Umgebung. Ablauf: neuen Host aufsetzen → Postgres-Replikation → Medien-`rsync` → DNS-TTL senken → Cutover mit kurzem Schreibstopp → alter Host 7 Tage unverändert als Rückfall. **Tablets bleiben unverändert**, da sie nur den Domainnamen kennen. Skalierung danach: DB getrennt, Worker auf eigenen Host, Medien hinter CDN/Objektspeicher, Statistik ggf. ClickHouse – ohne API-Änderung.

## 12. Namensumstellung auf GT-Ads (Abhängigkeitsprüfung)
**Neu verwenden:** Produkt „GT-Ads"; technisch `gt-ads` für Repo(s), Compose-Projekt (`name: gt-ads`), Container/Netze/Volumes, Datenbank `gt_ads`, Domain-Vorschläge `api.gt-ads.<tld>` etc. (Domain offen).
**Bestehendes bleibt vorerst:** `/srv/taxiwerbung`, `/srv/taxiagents`, Gruppe `taxiops`, Benutzer `taxiadmin`/`taxiagent`, lokaler SSH-Alias `taxiwerbung`, Ordner `~/taxiwerbung-setup`.
**Abhängigkeiten, die bei einer späteren Verzeichnisumbenennung zu prüfen sind:**
| Fundstelle | Abhängigkeit |
|---|---|
| `30-project-dirs.sh`, `40-setup-after-ssh.sh`, `SHA256SUMS` | Pfad `/srv/taxiwerbung` hartkodiert; Prüfsummen müssen neu erzeugt werden |
| Dateirechte/ACL | ACLs und Gruppen an `/srv/taxiwerbung/*` gebunden; Umbenennung per `mv` im selben Dateisystem erhält sie, Skripte nicht |
| Docker | Noch keine Container/Volumes/Compose-Dateien → heute **kein** Risiko; später Bind-Mounts, `.env`, Compose-Pfade |
| UFW/SSH/sudoers | keine Bezüge zum Pfad |
| Backups/Cron/Systemd-Units | existieren noch nicht; künftig Pfad nur über eine Variable (`GT_ADS_ROOT`) referenzieren |
| Lokaler SSH-Alias, VS-Code-Workspaces | hängen am Alias, nicht am Verzeichnis |
**Empfehlung:** Neue Dateien verwenden sofort die Variable `GT_ADS_ROOT=/srv/taxiwerbung`; Umbenennung (falls gewünscht) wird dadurch zur Ein-Zeilen-Änderung. Umbenennung nur mit deiner Freigabe, außerhalb des Betriebs, mit vorherigem Backup.

## 13. Schwachstellen des Konzepts (Risikoregister)
| # | Risiko | Wirkung | Gegenmaßnahme |
|---|---|---|---|
| R1 | **Wirtschaftlichkeit bei niedriger Auslastung:** ≈ 114 €/Taxi/Monat Fixkosten (Annahmen) bei 12 Plätzen → hoher Mindestpreis je Platz | Verlust trotz technischem Erfolg | Vorab Verkaufstest/Vorverträge; Pilot mit wenigen Taxis; Preismodell nach Auslastung |
| R2 | **Hitze/Strom im Fahrzeug** (Sommer 60 °C, Zündung, Akkus) | Ausfälle, Akkuschäden, Brandrisiko | Gerätewahl mit Temperaturdaten, Lade-/Temperatur-Cutoff, Testbetrieb im Sommer, Zündungsschaltung, Fachmontage |
| R3 | **Diebstahl/Vandalismus/Manipulation** | Hardwareverlust, gefälschte Daten | Abschließbare Halterung, Geräte-Sperre aus der Ferne, Seriennummerninventar, Keystore-Identität, Anomalieerkennung |
| R4 | **Wiedergabe ≠ Sicht:** Spots laufen auch ohne Fahrgast | Kunden zweifeln Berichte an | Begriffsklärung, „Verifizierte Wiedergabe" (Fahrzeug aktiv), ehrliche Berichte, keine Fahrgasterkennung im MVP (E9/E21), Pausen separat ausgewiesen |
| R5 | **Rechtslage Wien/AT:** Zulässigkeit von Taxiwerbung, Abgaben, Inhaltsregeln, Verträge, DSGVO (Fahrerbezug, GPS) | Untersagung, Bußgeld | Rechts-/Steuerberatung **vor** Pilot; Datensparsamkeit; keine Personenerfassung |
| R6 | **Mobilfunk:** Funklöcher, Datenvolumen, SIM-Verwaltung bei 2.000 SIMs | Verzögerte Updates, Kosten | Offline-first, Delta-Downloads, Download-Fenster, Pooltarif/IoT-SIM prüfen |
| R7 | **Fernverwaltung im Feld:** defekte App ohne Zugriff | Taxi-Ausfall, Vor-Ort-Einsatz | Watchdog, Rollback-Slot, gestaffelter Rollout, Remote-Neustart, Ersatzgerätebestand (≈ 10 %) |
| R8 | **Datenvolumen der Events** | DB-Wachstum, Kosten | §6: Batching, Partitionen, Retention, Rollups |
| R9 | **Single VPS:** Ausfall/Hardwaredefekt | Keine Neuaufträge/Statistiken (Wiedergabe läuft weiter) | Backups + Restore-Test, Offline-first, Dedicated-Migration vorbereitet, Monitoring |
| R10 | **Zeitabweichung** der Tablets | Falsche Laufzeiten/Abrechnung | Server-Offset, monotone Uhr, Laufzeit mit Toleranz, Validierung |
| R11 | **Eigenbau-Aufwand** (App, MDM, Support) | Zeit/Qualität | Pilot klein, MVP-Scope strikt, MDM-Zukauf prüfen, Automatisierte Tests |
| R12 | **Ablenkung des Fahrers / Sicherheit im Fahrzeug** | Haftung, Verbot | Nur Fond, Montage durch Fachbetrieb, Abstimmung mit Taxi-Partnern/Behörde |
| R13 | **Abhängigkeit von Einzelperson/Wissen** | Betriebsrisiko | Dokumentation, Runbooks, ADRs, zweite Person mit Zugang (Notfallzugang) |
| R14 | **Sicherheit der KI-Agenten** | Datenabfluss, Fehlaktionen | §9 + Freigabekonzept |

## 14. Architekturentscheidungen (ADR-Liste, Kurzform)
ADR-01 Modularer Monolith · ADR-02 PostgreSQL + pg-boss · ADR-03 Offline-first mit Manifest-Versionen · ADR-04 Buchung≠Kampagne≠Platz, Regel-Generator serverseitig · ADR-05 Ereignisse batchen, Rohdaten befristet · ADR-06 Device Owner/Kiosk · ADR-07 Domain statt IP, Storage-Interface · ADR-08 Agenten isoliert · ADR-09 Name `gt-ads`, Pfad `/srv/taxiwerbung` vorerst unverändert. Jede ADR wird bei Umsetzung als Datei unter `docs/entscheidungen/adr/` im Repo geführt.

> Statuskennzeichen: ✅ **Bestätigt** (Betreiberentscheidung) · 🟦 **Vorläufig** (Richtungsentscheidung) · 🔧 **Technische Annahme** (im Test zu prüfen) · ⚖️ **Rechtlich zu prüfen** (nicht freigegeben)

## 15. Tablet-Betrieb, Energie, Fahrersteuerung, Präsenz, GPS (Protokoll v2.0)
**Grundsatz:** Jedes Tablet arbeitet **autonom**. Das Taxi (2 Tablets) ist ein gemeinsamer Betriebskontext, aber keine Abhängigkeit: fällt ein Tablet aus, spielt das andere weiter. Gemeinsame Zustände (Pause) werden über Befehle abgeglichen, nicht über einen „Master".

### 15.1 Komponenten in der Tablet-App
| Modul | Aufgabe | Status |
|---|---|---|
| `PowerStateMonitor` | Netzteil-/Ladesignal → Fahrzeugbereitschaft (Entprellung gegen Wackelkontakt, z. B. 10–30 s) | 🔧 geräteabhängig |
| `PlaybackController` | Zustandsautomat; startet/stoppt Player; Display (Nachlauf, aus, Wiederanlauf) | ✅ |
| `PauseService` | Lokaler Pausenstatus, Persistenz, Befehlslog (`command_id`, `origin`, Revision), idempotent | 🟦 |
| `CommandSources` | Adapter: Taster (BLE/kabelgebunden), Fahrer-App, WhatsApp über Server, Server-Fernbefehl | 🟦 · 🔧 |
| `PassengerPresenceProvider` | Schnittstelle, Standard „nicht vorhanden" | 🟦 · ⚖️ |
| `LocationModule` | GPS-Modi aus / lokale Gebietserkennung / Übermittlung; Standard aus | ✅ · ⚖️ |
| `StatusReporter` | Statusmeldung alle 30–60 min + Zustandswechsel (mit Jitter), Offline-Pufferung | ✅ |
Display/Wake: kein permanenter Wake-Lock. Display aus per Device-Owner-Funktionen nach Nachlauf; Wiedereinschalten bei Ladesignal über Vordergrunddienst. **Annahme 🔧:** Bildschirm wecken, Autostart bei Laden und Start aus Power-off sind modellabhängig; Hardwaretest bestätigt oder verwirft das Modell.

### 15.2 Taster und Fahrerkanäle
- **Taster (Prototypen, 🔧):** (a) BLE-Taster ohne Verbindung (Advertising), den **beide** Tablets gleichzeitig empfangen → kein Master, wirkt offline; (b) kabelgebundener Taster mit eigener Versorgung; (c) Tablet-Notfallknopf nur als Rückfall. Taster-ID in der Taxi-Konfiguration, Befehlszähler gegen Wiederholung.
- **Fahrer-App:** Web/Android (offen), Taxi-Bindung ohne Fahrerprofil; Befehl → Server → beide Tablets (nur bei Erreichbarkeit).
- **WhatsApp (V3, ⚖️):** Business-Webhook → Signaturprüfung → verifizierte Zuordnung Telefonnummer ↔ Taxi → Befehl. Telefonnummern sind personenbezogen: minimal speichern, Kosten/Bedingungen vorab klären.
- **Vorrang:** Fahrzeug-aus > lokaler Pausenbefehl > zentrale Regeln. Konflikt: höhere Revision gewinnt, bei Gleichstand „Pause gewinnt".

### 15.3 Energie und Stromversorgung
Geschaltet, abgesichert, fahrzeugabhängig (automotive DC/DC, Sicherung, Unterspannungsschutz); Elektro/Hybrid: Betriebsbereit-/Zubehörsignal modellspezifisch ermitteln; kein Eingriff in Hochvolt oder Sicherheitssysteme; Freigabe durch Fachbetrieb. 🔧 Bereitschaft nicht allein aus „Akku lädt" ableiten (voller Akku verändert Ladeanzeige), sondern aus „Netzteil angeschlossen" plus Plausibilität.

### 15.4 Überwachung
Statusmeldungen + lokale Ereignisse → tägliche Auswertung. Fehlende Meldung = „unbekannt", nie automatisch „defekt"/„aus". Technische Alarme nur bei belegten Fehlern oder wenn Soll-/Ist-Abweichung **ohne** Erklärung durch Pause/Fahrzeug-aus über Schwelle liegt.

### 15.5 GPS (geschlossen ausgeliefert)
Modi je Flotte/Taxi: `aus` (Standard) · `lokal_gebiet` (kein Rohkoordinaten-Upload) · `uebermittlung` (eigene Freigabe). Solange `aus`: keine Berechtigungsanfrage, Server lehnt Standortdaten ab; Aktivierung nur mit Freigabereferenz im Audit-Log. Keine Fahrten-/Routenprotokolle als Default. ⚖️ Datenschutz/Arbeitsrecht vor jeder Nutzung. Vom Betreiber genannte Quellen (von mir nicht geprüft): dsb.gv.at, wko.at/dsgvo4kmu, RIS (DSB-Entscheidung 2022).

### 15.6 Presence (optional)
Kamera mit lokaler ML = hohes Datenschutz-/Akzeptanzrisiko (⚖️, auch ohne Speicherung ist die Verarbeitung zu bewerten) → nicht im MVP. Labor-Alternativen: ToF/Radar-Präsenz, Sitzsignal (nur freigegeben, keine Manipulation von Fahrzeug-Sicherheitssystemen). Ausgabe nur boolesch/aggregiert.

### 15.7 Neue Risiken
| # | Risiko | Gegenmaßnahme |
|---|---|---|
| R15 | Dauerpause durch Fahrer | Pausenstatistik je Taxi, Partnerregeln, Auto-Wiederaufnahme (E36) |
| R16 | Ladesignal unzuverlässig | Entprellung, Gerätetest, Plausibilität |
| R17 | Taster fällt aus/verliert Kopplung | Fahrer-App zweiter Kanal; Status im Dashboard |
| R18 | Tablets uneinig bei Pause | Revisionsabgleich, Dashboard zeigt „abweichend" |
| R19 | Datenschutzverstoß (Status-/Standortdaten) | Standard aus, DSFA, Datensparsamkeit, Rollen |
| R20 | Fahrzeuggarantie/Elektrik | Fachbetrieb, Freigabe je Modell |
