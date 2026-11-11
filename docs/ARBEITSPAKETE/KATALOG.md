# GT-Ads – Arbeitspaketkatalog

Stand: 2026-11-09 · Status des Katalogs: **Entwurf zur Freigabe** (keine WP freigegeben, nichts begonnen).
Grundlage: `docs/konzept/ANFORDERUNGEN.md` (IDs F-/N-/S-/B-), `ZUSTANDSMODELL.md`, `ARCHITEKTUR.md`, `HARDWARETESTPLAN.md`, `WIDERSPRUECHE_LUECKEN_ANNAHMEN.md` (K-/L-/A-).

## ID-Schema (Stand 2026-11-09, 🟦 wartet auf Bestätigung, Q-004)
- **`WP-xxx`** = **Katalogbaustein** (dieses Dokument).
- **`GT-ADS-nnn`** = **Implementierungspaket** des Betreibers (vertikaler Durchstich, Ordner `docs/ARBEITSPAKETE/GT-ADS-nnn/`); es bündelt Teile mehrerer Bausteine. Beispiel: **GT-ADS-001** (Android-Geräteregistrierung) liefert Teile von WP-201, 203, 204, 205, 211, 301, 302, 401, 402 und ein Minimalgerüst aus WP-001/003/101. Bausteine bleiben im Katalog offen, bis ihr vollständiger Umfang erledigt ist.
- Statusübersicht: [README.md](README.md).

## Lesehilfe
- **Prio:** MVP = Pilot · V2 · V3 · G = Betreiber-/Gate-Aufgabe (keine KI-Implementierung).
- **Status:** alle WPs starten als `Entwurf`; nur der Betreiber setzt `Freigegeben` (in `docs/fortschritt/STATUS.md`).
- **Abh.** = müssen `Done` sein, bevor das WP freigegeben/gestartet wird. Gesamtgraph: `ABHAENGIGKEITEN.md`.
- **Blockiert durch** = offene Entscheidungen/Lücken (E-, L-, A-, K-), die vorab geklärt sein müssen. „–" = keine.
- **Tests** = Mindesttests; echte Testausgabe ist im PR zu belegen. **DoD** = `DEFINITION_OF_DONE.md` **plus** „DoD+".
- **Daten:** „synthetisch" = nur Daten nach `DATENTRENNUNG.md`. Kein WP verwendet Produktivdaten.
- Alle Akzeptanzkriterien beziehen sich auf Dokumente; Zahlen mit (A) sind Annahmen und als Konfiguration zu führen.
- Rollen je WP: **Plan** Claude · **Impl** DeepSeek (Standard) · **Review** Claude (frische Sitzung) · **Freigabe/Merge** Betreiber.

---
## Bereich A – Prozess und Repository

### WP-001 Repository-Grundgerüst und Qualitätsleitplanken · MVP
- **Ziel:** Monorepo-Struktur, Branch-Schutz-Anleitung, CI-Skelett (Lint-Platzhalter, Secret-Scan, Doku-Konsistenzprüfung), PR-Vorlage, `.env.example`, geschützte Pfade.
- **Eingaben/Quellen:** `PROJEKTSTRUKTUR.md`, `ENTWICKLUNGSPROZESS.md` §5, ADR-0002 (Technologie, nach Bestätigung).
- **Module:** `.github/`, `tools/`, Wurzel.
- **Akzeptanz:** CI läuft auf PR; Secret-Scan schlägt bei Testgeheimnis (synthetisch) an; Änderung an geschütztem Pfad ohne Label schlägt fehl; Doku-Check meldet fehlende referenzierte IDs/Dateien.
- **Tests:** CI-Selbsttests (Negativfälle), lokale Ausführung dokumentiert.
- **DoD+:** Branch-Protection-Einstellungen vom Betreiber nachweislich gesetzt.
- **Abh.:** – · **Blockiert durch:** L-11 (GitHub/CI), A-05 (Technologie bestätigen)

### WP-002 Vertragsverzeichnis und Contract-Test-Grundlage · MVP
- **Ziel:** `contracts/` anlegen, Entwurf C-01…C-08 aus Anforderungen/Zustandsmodell ableiten (nur dokumentierte Inhalte), Contract-Test-Rahmen, CR-Prozess aktivieren.
- **Eingaben:** ANFORDERUNGEN F-A03…F-A11, F-A23…27, F-B05…07; ZUSTANDSMODELL.
- **Akzeptanz:** jeder Vertragsfeld-Eintrag verweist auf Anforderung/Zustandsmodell-Abschnitt oder ist als **Offen** markiert; Beispielnachrichten synthetisch; **Betreiber friert Version 1.0.0 ein**.
- **Tests:** Schema-Validierung der Beispiele; CI-Regel „kein Merge in `contracts/**` ohne CR".
- **DoD+:** Betreiber-Freigabe je Vertrag dokumentiert.
- **Abh.:** WP-001 · **Blockiert durch:** E36 (Pause-Semantik), L-03, L-07

### WP-003 Datenumgebungen und synthetische Testdaten · MVP
- **Ziel:** `GT_ADS_ENV`-Guard, Generator für synthetische Daten (Seed), Kennzeichnung `SYN-`, Prod-Guard-Tests.
- **Quellen:** DATENTRENNUNG.md.
- **Akzeptanz:** Seed bricht bei `prod` ab (Test); Generator reproduzierbar (gleicher Seed → gleiche Daten); keine realen Namen/Kennzeichen; Start ohne `GT_ADS_ENV` verweigert.
- **Tests:** Unit + Integrationsstart in 4 Umgebungen (Container).
- **Abh.:** WP-001 · **Blockiert durch:** –

### WP-004 ADR-Übernahme und Statuspflege · MVP
- **Ziel:** ADRs 0001–0012 prüfen/finalisieren, Vorlage, Statusroutine, Sitzungsprotokoll-Ordner. (Doku-WP, Planer; Betreiber gibt ADRs frei.)
- **Akzeptanz:** jede Architekturentscheidung aus ARCHITEKTUR §14 hat ADR mit Status; offene Annahmen A-05/A-16 sind entschieden oder markiert.
- **Tests:** Doku-Check aus WP-001.
- **Abh.:** – · **Blockiert durch:** Betreiberfreigabe

### WP-005 DeepSeek-Entwicklungsumgebung · MVP (Voraussetzung für KI-Implementierung)
- **Status: Spezifiziert** – Paketordner [WP-005/](WP-005/SPEZIFIKATION.md) (Spezifikation, Entwurf, Schnittstellenvereinbarung, Testplan, Implementierungsauftrag).
- **Ziel:** Isolierte Umgebung, in der DeepSeek Arbeitspakete umsetzt, ohne Produktivbezug, ohne Geheimnisse, ohne Schreibzugriff auf `main`.
- **Eingaben/Quellen:** `docs/prozess/DEEPSEEK_ENTWICKLUNGSUMGEBUNG.md`, ADR-0008/0010/0011, `KI_REGELN.md`, E45/E46 (🟦) und E57–E63.
- **Module:** `.devcontainer/**`, `infra/devenv/**` (Compose, Egress-Proxy-Allowlist, Hook-Vorlagen, README) – geschützte Pfade, nur per PR mit Betreiber-Merge.
- **Akzeptanz:** Sicherheitsabnahme SA-01…SA-12 vollständig bestanden und belegt; Werkzeug-Probelauf K1–K9 dokumentiert; keine Secrets im Repo; gepinnte Images; Reset ≤ 15 min (A).
- **Tests:** SA-Prüfungen (Netz, Rechte, Secrets, Push, Prompt-Injection, Limits, Reset); Probelauf nur auf Wegwerf-Repo mit synthetischem Inhalt.
- **DoD+:** Installation nur durch den Betreiber auf dem PC; auf dem VPS keine Änderung; Kostenlimit beim Anbieter nachgewiesen.
- **Abh.:** – · **Blockiert durch:** E57–E63 · **Blockiert:** GT-ADS-001 (Start), alle weiteren KI-Implementierungspakete

### WP-006 Telegram-Gateway (Phase 1: Chat, Status, schreibgeschützt) · Nebenstrang
- **Status: Freigegeben (Betreiber, Chat 2026-11-09) – umgesetzt als PR (Branch `wp/WP-006-telegram-gateway`), Merge und Betreiber-Schritte S1/S2/S5 stehen aus** – Paketordner [WP-006/](WP-006/SPEZIFIKATION.md).
- **Ziel:** Kleiner Python-Dienst (nur Standardbibliothek) auf dem VPS unter `taxiagent`: `/start`, `/status`, einfache Fragen an DeepSeek; Long Polling, nur Betreiber-ID, ohne Werkzeuge, mit Autostart.
- **Quellen:** `docs/prozess/TELEGRAM_STEUERUNG.md`, ADR-0008, E57′/E61/E62/E68–E73.
- **Akzeptanz/Tests:** AC-01…AC-17, Unit/Integration/Statik, Betreiberprüfungen OP-01…OP-06, Telegram-Tests M-01…M-03.
- **Abh.:** – (unabhängig von WP-005/GT-ADS-001) · **Blockiert durch:** Freigabe, E68 (ID, Setup-Modus), S1/S2 · **Nicht enthalten:** Dokumentenzugriff (Phase 1b), Aufgabenwarteschlange (Phase 2).

## Bereich B – Infrastruktur und Betrieb

### WP-101 Compose-Grundgerüst `gt-ads` (lokal, ohne öffentliche Ports) · MVP
- **Ziel:** Compose-Projekt `gt-ads` mit db, api-Platzhalter, worker-Platzhalter, Netzen (`edge`,`backend` internal), Ressourcenlimits, Healthchecks; Messung des realen RAM-Budgets (K-02).
- **Quellen:** ARCHITEKTUR §3, §4; Servermessung.
- **Akzeptanz:** `docker compose up` startet; kein Port auf `0.0.0.0`; Limits aktiv; Messprotokoll RAM im Leerlauf; `ss -tlnp` zeigt nur 22 öffentlich.
- **Tests:** Compose-Konfig-Lint, Portprüfung, Healthchecks.
- **DoD+:** Deployment auf VPS nur nach Betreiberfreigabe.
- **Abh.:** WP-001, WP-003 · **Blockiert durch:** A-05, A-06

### WP-102 Caddy intern und Healthchecks · MVP
- **Ziel:** Reverse Proxy nur intern (127.0.0.1), Routing-Skelett `/api`, `/media`, Dashboard-Statik; TLS erst in WP-106.
- **Akzeptanz:** Zugriff nur lokal/VPN; Header-Basis gesetzt; Healthcheck-Endpunkte.
- **Tests:** HTTP-Tests lokal; Portscan von außen negativ.
- **Abh.:** WP-101

### WP-103 Monitoring-Basis · MVP
- **Ziel:** Prometheus, Grafana, node_exporter, cAdvisor, Uptime Kuma – nur intern; Basisdashboards (Host, Container, Postgres).
- **Quellen:** F-B09 (Teil), N-11.
- **Akzeptanz:** Metriken sichtbar; kein öffentlicher Port; Alarm-Regel „Dienst down" (Zustellkanal erst L-06).
- **Tests:** Dienst stoppen → Alarmzustand sichtbar.
- **Abh.:** WP-101 · **Blockiert durch:** L-06 (Alarmkanal), L-12

### WP-104 Backup und Restore PostgreSQL · MVP
- **Ziel:** tägliches `pg_dump` + WAL-Archivierung (pgBackRest) lokal; Restore-Runbook; Offsite-Anbindung getrennt (Freigabe/Kosten).
- **Quellen:** N-09, ARCHITEKTUR §10.
- **Akzeptanz:** Restore in leerer Umgebung erfolgreich, Dauer gemessen; Prüfsummen; Backup-Verzeichnis nicht in Git.
- **Tests:** Restore-Test automatisiert mit **synthetischer** Datenbasis.
- **DoD+:** Restore-Test dokumentiert; Offsite erst nach Betreiberfreigabe.
- **Abh.:** WP-201 · **Blockiert durch:** L-16, E23

### WP-105 Server-Restpunkte · MVP (Betreiber führt sudo aus)
- **Ziel:** Swap (E25), überflüssige Dienste (E26), Fail2ban-Entscheidung, unattended-upgrades-Log prüfen, `sudo ufw status`/`docker info` gegenprüfen.
- **Akzeptanz:** jede Änderung dokumentiert in `infra/server-setup/STATUS_SERVER.md`; SSH/UFW unverändert oder ausdrücklich freigegeben.
- **Tests:** Prüfbefehle mit Ausgabe.
- **Abh.:** – · **Blockiert durch:** E25, E26 · **Rolle:** Betreiber (G)/Plan: Claude

### WP-106 Domain, TLS, öffentlicher Zugang · G (Gate G3)
- **Ziel:** Domain, DNS, Caddy-TLS, Port 443 oder Tunnel; Admin nur VPN/Allowlist.
- **Abh.:** WP-102, G2 · **Blockiert durch:** E1, E2, L-17 · **Freigabe:** ausdrücklich je Port/Kosten

## Bereich C – Backend

### WP-201 Datenbankschema Kern und Migrationen · MVP
- **Ziel:** Tabellen Organisation, Benutzer/Rollen, Taxi, Gerät, Gruppen; Migrationsframework (vorwärts + Rückweg/Backup-Regel C-09).
- **Quellen:** ARCHITEKTUR §5; F-B01.
- **Akzeptanz:** Migration auf leere DB und zurück; Constraints: genau 2 Geräte je Taxi (Regel konfigurierbar, Quelle: Briefing „zwei Tablets je Taxi"); keine Seed-Daten in Migrationen.
- **Tests:** Integrationstest gegen echte Postgres (Test-Umgebung); Migration hoch/runter.
- **Abh.:** WP-101, WP-003 · **Blockiert durch:** L-08, L-04

### WP-202 Authentifizierung, MFA, Rollen (RBAC) · MVP
- **Ziel:** Login Dashboard, MFA, Rollen, Sitzungen, Rate-Limit.
- **Quellen:** F-D01, S-05.
- **Akzeptanz:** ohne MFA kein Zugriff; Rollenprüfung serverseitig; Rate-Limit greift; keine Secrets im Log.
- **Tests:** Unit + Integration + Negativtests (Rolle, Token, Brute-Force).
- **Abh.:** WP-201 · **Blockiert durch:** L-05

### WP-203 Audit-Log · MVP
- **Ziel:** Unveränderliches Protokoll für Verwaltungsaktionen (inkl. Konfiguration/GPS-Schalter, Pausenbefehle von Betreiber).
- **Quellen:** F-B10, F-D09.
- **Akzeptanz:** jede schreibende Admin-Aktion erzeugt Eintrag (wer, was, wann, Vorher/Nachher); Einträge nicht änderbar.
- **Tests:** Integration; Manipulationsversuch scheitert.
- **Abh.:** WP-202

### WP-204 Taxi-, Geräte- und Gruppen-API · MVP
- **Ziel:** CRUD Taxis, Geräte, Gruppen; Zuordnung 2 Tablets/Taxi; Aktivieren/Deaktivieren.
- **Quellen:** F-B01, F-D02, F-D04; Vertrag C-06.
- **Akzeptanz:** Zuordnungsregeln durchgesetzt; Deaktivierung sperrt Gerätezugriff (siehe WP-205); Audit-Einträge.
- **Tests:** Integration + Berechtigungen; Validierungsfälle.
- **Abh.:** WP-201, WP-202, WP-203, WP-002 · **Blockiert durch:** L-04, L-08

### WP-205 Geräte-Enrollment und Geräteauthentifizierung · MVP
- **Ziel:** einmaliger Enrollment-Token, Schlüsselregistrierung, Gerätesitzung, Widerruf.
- **Quellen:** F-A03, S-01, S-02; C-01.
- **Akzeptanz:** Token einmalig nutzbar und ablaufend; widerrufenes/deaktiviertes Gerät abgewiesen; Gerätekennungen nur synthetisch in Tests; Testgeräte können sich nicht bei `prod` registrieren (DATENTRENNUNG §2.6).
- **Tests:** Integration + Negativtests (Wiederverwendung, Ablauf, Fälschung).
- **Abh.:** WP-204, WP-002 · **Blockiert durch:** L-02

### WP-206 Medien-Upload und Metadaten · MVP
- **Ziel:** Upload (fortsetzbar), Prüfung (Größe/MIME), Speicherung inhaltsadressiert (sha256), Metadaten.
- **Quellen:** F-B02, F-D03.
- **Akzeptanz:** Hash stimmt; unzulässige Dateien abgelehnt; Speicherinterface austauschbar (ADR-0007).
- **Tests:** Unit/Integration mit synthetischen Mediendateien (kleine Testvideos, Quelle dokumentiert/lizenzfrei oder generiert).
- **Abh.:** WP-201, WP-202 · **Blockiert durch:** L-01

### WP-207 Transkodierung (Worker) · MVP
- **Ziel:** ffmpeg-Job: Normalisierung auf Tablet-Profil; Fehler-/Wiederholungslogik; Ressourcenlimit (≤ 2 CPU, A-06).
- **Quellen:** F-B02, F-A06.
- **Akzeptanz:** Ausgabe erfüllt Profil laut Betreiberentscheidung (L-01); fehlerhafte Datei → Status Fehler, kein Absturz; Job idempotent.
- **Tests:** Integration mit Testvideos; Fehlerfall; Limit.
- **Abh.:** WP-206 · **Blockiert durch:** L-01 (Profil)

### WP-208 Kunden, Kampagnen, Buchungen (Regeltyp `fixed_slot`) · MVP
- **Ziel:** Kunde, Kampagne (Entwurf/Aktiv/Pausiert/Beendet), Buchung mit Zeitraum und Ziel (Taxi/Gruppe), Regeltyp `fixed_slot`.
- **Quellen:** F-B03, F-B04, F-D03, F-D04; ARCHITEKTUR §5.
- **Akzeptanz:** Laufzeitlogik korrekt (Grenzen, Zeitzone A-14); Zustandsübergänge nur erlaubte; Buchung ≠ Kampagne ≠ Platz getrennt modelliert; **keine Preis-/Abrechnungslogik**.
- **Tests:** Unit (Zeitgrenzen, Zeitumstellung), Integration, Berechtigungen.
- **Abh.:** WP-204, WP-206 · **Blockiert durch:** L-03, L-04, L-07

### WP-209 Schleifenplanung und Manifest-Generator · MVP
- **Ziel:** Plätze 12–16 (konfigurierbar), Platzbelegung, deterministisches versioniertes Manifest je Gerät/Gruppe (C-02).
- **Quellen:** F-B04, F-B05, F-A07.
- **Akzeptanz:** gleiche Eingabe → identisches Manifest (Hash); neue Version bei Änderung; Manifest validiert gegen Schema; Gültigkeitsfenster enthalten; kein Platz doppelt belegt.
- **Tests:** Property-/Unit-Tests, Contract-Test.
- **Abh.:** WP-208, WP-002 · **Blockiert durch:** L-03

### WP-210 Signierte Medien-Auslieferung · MVP
- **Ziel:** Kurzlebige signierte URLs je Gerät, Range-Requests, ETag.
- **Quellen:** F-B06, F-A05, S-02.
- **Akzeptanz:** abgelaufene/fremde URL → 403; Range korrekt; Gerät nur eigene Medien.
- **Tests:** Integration, Negativtests, Last-Smoketest (synthetisch).
- **Abh.:** WP-205, WP-206, WP-102

### WP-211 Status- und Ereignis-Eingang · MVP
- **Ziel:** `POST /device/status` und `/device/events`: idempotent (`device_id`+Sequenz), Validierung, Partitionierung, Zeit-Offset.
- **Quellen:** F-B07, F-A08, F-A09, N-13; C-03; ARCHITEKTUR §6.
- **Akzeptanz:** doppelter Batch → keine Duplikate; ungültige Daten abgelehnt; Plausibilitätsprüfung (z. B. nicht mehr Wiedergaben als physikalisch möglich laut Spotlänge); Partition je Zeitraum; Jitter-Unterstützung.
- **Tests:** Integration inkl. Duplikate, Reihenfolge, großer Batch (synthetisch 100.000).
- **Abh.:** WP-205, WP-201, WP-002

### WP-212 Retention und Rollups · MVP
- **Ziel:** Aggregation (Tag/Kampagne/Gerät/Spot), konfigurierbare Aufbewahrung Rohdaten.
- **Quellen:** F-B08, S-09; E22 (offen).
- **Akzeptanz:** Aggregate stimmen mit Rohdaten überein (synthetisch, Abweichung 0); Retention löscht nur nach Konfiguration; Standard nach E22 (bis dahin **kein** automatisches Löschen).
- **Tests:** Integration mit Generator; Retention-Trockenlauf.
- **Abh.:** WP-211 · **Blockiert durch:** E22 (für Standardwert), K-06

### WP-213 Tägliche Auswertung und Zustandsklassifikation · MVP
- **Ziel:** Job je Tablet/Tag: Soll/Ist, Klassen (Gesund, Fahrzeug aus, Bewusst pausiert, Technischer Fehler, Unbekannt), Taxi-Gesamtstatus.
- **Quellen:** F-B15, ZUSTANDSMODELL §6–7; C-05.
- **Akzeptanz:** Klassifikation exakt nach Regeln; „Unbekannt" wird nie automatisch zu „Defekt"; Toleranzen konfigurierbar (A-08); Zeitzone korrekt.
- **Tests:** Tabellengetriebene Tests mit synthetischen Tagesverläufen für jede Klasse und Grenzfälle.
- **Abh.:** WP-211, WP-212 · **Blockiert durch:** K-03, L-07

### WP-214 Pause- und Fernbefehle (Server) · MVP
- **Ziel:** Befehlsannahme (Betreiber, später Fahrer-App/WhatsApp), Revision, Zustellung an beide Tablets, Statusverfolgung (ausstehend/ausgeführt/nicht zustellbar).
- **Quellen:** F-A23, F-A27, F-A28; C-04; ZUSTANDSMODELL §4.
- **Akzeptanz:** Idempotenz über `command_id`; höhere Revision gewinnt, Gleichstand → Pause; Audit-Eintrag; Befehle an offline Gerät bleiben ausstehend.
- **Tests:** Integration inkl. Konflikt-/Mehrfachfälle.
- **Abh.:** WP-205, WP-203, WP-002 · **Blockiert durch:** E36

### WP-215 Konfiguration und GPS-Schalter (Policy) · MVP
- **Ziel:** Konfigurationsschlüssel (C-07) inkl. Nachlauf, Statusintervall, Retention, GPS-Modus; **GPS nur `aus` wählbar**, Server lehnt Standortdaten ab.
- **Quellen:** F-D09, F-A17, S-08; Protokoll v2.0 §6.
- **Akzeptanz:** Schlüssel validiert (Typ/Grenzen); Änderung auditiert; `uebermittlung` nicht aktivierbar, bis Freigabereferenz hinterlegt; Standort-Payload wird verworfen.
- **Tests:** Unit/Integration, Negativtest Standortdaten.
- **Abh.:** WP-203, WP-002 · **Blockiert durch:** E40, E43 (für spätere Freigabe)

### WP-216 Technische Alarme · MVP
- **Ziel:** Alarme nur für „Technischer Fehler" und anhaltend „Unbekannt"; Schwellen konfigurierbar; Zustellkanal.
- **Quellen:** F-B09, B-01; ZUSTANDSMODELL §6.
- **Akzeptanz:** keine Alarme für pausiert/Fahrzeug aus; Entprellung/Wiederholungsregeln; Zustellung getestet.
- **Tests:** Szenariotests mit synthetischen Verläufen; Zustellmock **nur** für externen Dienst.
- **Abh.:** WP-213, WP-103 · **Blockiert durch:** L-06

## Bereich D – Dashboard

### WP-301 Dashboard-Gerüst, Login, MFA-Oberfläche · MVP
- **Quellen:** F-D01. **Akzeptanz:** Login/MFA funktionieren gegen Backend; rollenabhängige Navigation; keine Secrets im Client. **Tests:** Komponenten-/E2E-Tests (synthetisch). **Abh.:** WP-202 · **Blockiert durch:** L-05, L-07

### WP-302 Taxis, Geräte, Gruppen (UI) · MVP
- **Quellen:** F-D02, F-D04. **Akzeptanz:** Anlegen/Zuordnen/Deaktivieren, Gerätestatus sichtbar, Zuordnungsfehler verständlich. **Tests:** E2E, Berechtigung. **Abh.:** WP-204, WP-301

### WP-303 Medien und Kampagnen (UI) · MVP
- **Quellen:** F-D03. **Akzeptanz:** Upload mit Fortschritt, Vorschau, Kampagnenstatus, Zuweisung, Pausieren/Beenden. **Tests:** E2E mit Testmedien. **Abh.:** WP-208, WP-209, WP-301

### WP-304 Status und Auswertung (UI) · MVP
- **Quellen:** F-D05, F-D02, ZUSTANDSMODELL §6–7. **Akzeptanz:** Tablet-/Taxi-Status mit getrennten Klassen (pausiert ≠ Fehler), tägliche Auswertung, Wiedergabezahlen als **Wiedergaben** (nie „Kontakte"). **Tests:** E2E gegen synthetische Daten, Beschriftungsprüfung. **Abh.:** WP-213, WP-301

### WP-305 Pause, Konfiguration, GPS-Schalter (UI) · MVP
- **Quellen:** F-D09, F-A23. **Akzeptanz:** Pausebefehl senden/Status verfolgen; Nachlauf konfigurieren; GPS-Modus **nur „aus"** wählbar, Hinweis „⚖️ nicht freigegeben". **Tests:** E2E. **Abh.:** WP-214, WP-215, WP-301

### WP-306 Statistikberichte/CSV-Export · V2
- **Quellen:** F-B13, L-13. **Akzeptanz:** Export enthält nur definierte Felder, Wiedergaben und Pausenzeiten getrennt (E44). **Abh.:** WP-212, WP-304 · **Blockiert durch:** L-13, E44

## Bereich E – Android-App

### WP-401 App-Gerüst, Autostart, Kiosk/Device-Owner-Basis · MVP
- **Quellen:** F-A01, F-A02. **Akzeptanz:** Start nach Boot; Kiosk (Lock-Task) auf Testmodell; Einstellungen nicht erreichbar (Test laut HARDWARETESTPLAN T-10, soweit Plattform erlaubt). **Tests:** Instrumentierte Tests + physisches Testgerät (Modell/Version dokumentiert). **Abh.:** WP-001 · **Blockiert durch:** L-02, L-15, A-09

### WP-402 Enrollment und Gerätesitzung (App) · MVP
- **Quellen:** F-A03, S-01. **Akzeptanz:** Enrollment per Token/QR; Schlüssel im Keystore; Sitzung erneuerbar; widerrufenes Gerät stoppt. **Tests:** Contract-Tests gegen C-01, Gerätetest. **Abh.:** WP-401, WP-205

### WP-403 Manifest-Sync und resumable Download · MVP
- **Quellen:** F-A04, F-A05, F-A07. **Akzeptanz:** ETag-Polling; Download fortsetzbar; Hash-Prüfung; atomarer Wechsel erst nach Vollständigkeit; Speicherlimit; GC alter Dateien. **Tests:** Abbruch-/Wiederaufnahme-, Korruptions-, Speicher-voll-Tests. **Abh.:** WP-402, WP-209, WP-210

### WP-404 Player und lokaler Scheduler (Offline) · MVP
- **Quellen:** F-A06, F-A07, F-A14. **Akzeptanz:** Wiedergabe ohne Netz (Flugmodus); Reihenfolge/Laufzeitfenster laut Manifest; kein Schwarzbild beim Wechsel; Fallback-Inhalt. **Tests:** Gerätetests Flugmodus, Zeitabweichung (T-11/T-12). **Abh.:** WP-403 · **Blockiert durch:** L-01, L-03, L-09

### WP-405 Zustandsautomat, Fahrzeugbereitschaft, Display-Nachlauf · MVP
- **Quellen:** F-A20, F-A21, F-A22; C-05; ZUSTANDSMODELL §3. **Akzeptanz:** Übergänge exakt wie Tabelle; Entprellung konfigurierbar (A-07); Nachlauf konfigurierbar (Startwert 2 min ✅); kein permanenter Wake-Lock. **Tests:** Zustandsautomat-Unit-Tests (jede Zeile der Übergangstabelle), Gerätetest T-03…T-07, T-04 (🔧). **Abh.:** WP-404 · **Blockiert durch:** E36, E40, A-11

### WP-406 Ereignispuffer und StatusReporter · MVP
- **Quellen:** F-A08, F-A09, N-13; C-03. **Akzeptanz:** lokale Persistenz überlebt Neustart/Absturz; Upload gebündelt, idempotent; 100.000 Ereignisse verlustfrei; Statusintervall konfigurierbar mit Jitter; Zustandswechsel sofort gepuffert. **Tests:** Unit + Gerätetest (Offline-Puffer). **Abh.:** WP-405, WP-211

### WP-407 Pause-Service und Taster-Schnittstelle · MVP (Prototyp)
- **Quellen:** F-A23, F-A24, F-A27; C-04. **Akzeptanz:** Pause/Fortsetzen lokal sofort, offline; idempotent; Revision; Taster-Adapter austauschbar (BLE-Variante als Prototyp, 🔧); Quelle im Ereignis. **Tests:** Unit; Gerätetest D-01…D-07 laut HARDWARETESTPLAN. **Abh.:** WP-405, WP-214 · **Blockiert durch:** E36, E37, A-10

### WP-408 Watchdog, Selbstheilung, Fallback · MVP
- **Quellen:** F-A10, F-A11, F-A14. **Akzeptanz:** Absturz/Freeze → Wiedergabe ≤ 60 s zurück (A-08); Neustart nach Strom weg; Fehlercode im Status. **Tests:** Gerätetests T-08, T-09. **Abh.:** WP-404, WP-406

### WP-409 Presence- und GPS-Schnittstellen (leer) · MVP
- **Quellen:** F-A17, F-A29; Protokoll v2.0 §1, §6. **Akzeptanz:** Schnittstellen vorhanden, Standardimplementierung „nicht vorhanden"/`aus`; keine Berechtigungsanfrage für Standort; keine Datenverarbeitung. **Tests:** Unit; statische Prüfung (kein Location-API-Aufruf im Code bei `aus`). **Abh.:** WP-405 · **Blockiert durch:** ⚖️ nur für spätere Nutzung

## Bereich F – Hardwaretests (Betreiber-geführt)
- **WP-501** Stufe 1 Labor (HARDWARETESTPLAN §4 A/C/E, P-01…03) · MVP · Abh.: WP-401…407 minimal · Blockiert: E14, E5 · Ergebnis: Ergebnismatrix §6
- **WP-502** Stufe 2 Klima/Dauer (T-13…T-17) · MVP · Abh.: WP-501
- **WP-503** Stufe 3 Fahrzeug stehend (P-04…P-09) · MVP · **Gate G2** · Blockiert: E42, E43
- **WP-504** Stufe 4 Feldtest/Pilotvorbereitung · MVP · **Gate G3** · Blockiert: E1, E2, E3
(Für Ergebnisse gilt: echte Messwerte und Protokolle, nie geschätzt/ergänzt von KI.)

## Bereich G – Recht, Datenschutz, Betrieb (Betreiber/Fachpersonen)
- **WP-601** Rechts-/Steuerprüfung (E4) · **WP-602** Datenschutz, DSFA, Arbeitsrecht (E43, L-19) · **WP-603** Support-/Austausch-/Inventarprozess (E19, L-12) · **WP-604** Partner-/Kundenvertragsvorlagen (E7, E41) · alle **G**, keine KI-Implementierung; Claude kann Entwürfe/Checklisten liefern, aber keine Rechtsberatung.

## Bereich H – Später (V2/V3, nicht freigabefähig vor G4)
WP-701 OTA-Updates (F-A12) · WP-702 Kundenportal (F-D07) · WP-703 Fahrer-App (F-A25) · WP-704 WhatsApp-Kanal (F-A26, ⚖️) · WP-705 KI-Agenten-Sandbox (S-10, C-10) · WP-706 Migration auf Dedicated Server (N-10) · WP-707 Presence-Sensorik-Pilot (F-A29, ⚖️) · WP-708 GPS-Nutzung (F-A17, S-08, ⚖️ gesperrt) · WP-709 Freigabe-Workflow Motive (F-B11) · WP-710 Verifizierte Wiedergabe (L-20) · WP-711 Weitere Buchungsregeltypen (F-B04). Detaillierung erst nach Gate G4.

---
## Vorlage für Detailauftrag (`docs/ARBEITSPAKETE/<ID>/`, vom Planer vor Freigabe ausgefüllt)
```
# WP-xxx <Titel>   Status: Entwurf|Spezifiziert|Freigegeben|In Arbeit|PR offen|Review|Gemergt|Done|Blockiert
Ziel / Nicht-Ziele:
Eingaben und Datenquellen (Datei/ID, nur synthetisch):
Betroffene Module/Dateien (erlaubter Änderungsbereich):
Verträge (ID, Version) – unverändert:
Akzeptanzkriterien (je mit Anforderungs-ID):
Tests (Art, Befehl, Erwartung, Negativfälle):
DoD+:
Annahmen (A-) / offene Fragen (Q-) / Blockaden:
Freigabe Betreiber (Datum):
```
