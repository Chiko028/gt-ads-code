# Projektstrukturplan GT-Ads

Stand: 2026-11-09 · Entwurf zur Freigabe. Entwicklungsbereiche und geplante Repository-Struktur. Technologiewahl ist **Vorschlag (A-05)** und wird mit ADR-0002…0008 vor WP-001 bestätigt.

## 1. Entwicklungsbereiche (Work Breakdown)
| Bereich | Inhalt | WPs |
|---|---|---|
| A Prozess/Repo | Repo, CI, Verträge, Datentrennung, ADR/Status | WP-001…004 |
| B Infrastruktur/Betrieb | Compose, Proxy, Monitoring, Backup, Server-Restpunkte, Domain/TLS | WP-101…106 |
| C Backend/API/Worker | DB, Auth, Audit, Geräte, Medien, Kampagnen, Manifest, Status/Ereignisse, Auswertung, Befehle, Konfiguration, Alarme | WP-201…216 |
| D Dashboard | Login, Verwaltung, Medien/Kampagnen, Status/Auswertung, Pause/Konfig, Berichte | WP-301…306 |
| E Android-App | Kiosk, Enrollment, Sync/Download, Player, Zustandsautomat, Puffer/Status, Pause/Taster, Watchdog, Schnittstellen | WP-401…409 |
| F Hardwaretests | Labor, Klima, Fahrzeug, Feldtest | WP-501…504 |
| G Recht/Betrieb | Recht, Datenschutz, Support, Verträge | WP-601…604 |
| H Später | OTA, Portal, Fahrer-App, WhatsApp, Agenten, Migration, Presence, GPS, … | WP-701…711 |
Querschnitt: Sicherheit, Tests, Dokumentation, Datentrennung, Monitoring gelten für **jedes** WP (DoD).

## 2. Geplante Repository-Struktur (Monorepo `gt-ads`)
```
gt-ads/
├── CLAUDE.md  AGENTS.md  README.md  .gitignore
├── .github/                 # PR-Vorlage, Workflows (geschützt)
├── docs/                    # Vollständiges Inhaltsverzeichnis: docs/INDEX.md
│   ├── INDEX.md  
│   ├── konzept/             # Konzept, Anforderungen, Roadmap, QUELLEN (Betreiber), ARCHIV
│   ├── architektur/         # Architektur, Zustandsmodell, vertraege/ (Schnittstellenverträge + Change Requests)
│   ├── entscheidungen/      # OFFENE_ENTSCHEIDUNGEN.md (Entscheidungsprotokoll), adr/
│   ├── ARBEITSPAKETE/       # README (Status), KATALOG, ABHAENGIGKEITEN, MVP_ROADMAP, PROJEKTSTRUKTUR, _VORLAGE/, GT-ADS-nnn/
│   ├── tests/               # Teststrategie, HARDWARETESTPLAN
│   ├── fortschritt/         # STATUS.md, sessions/, berichte/
│   ├── prozess/             # KI-Regeln, Entwicklungsprozess, DoD, Datentrennung, Kontext, Session-Vorlagen
│   └── analyse/             # Widersprüche, Lücken, Annahmen
├── contracts/               # (WP-002) OpenAPI/JSON-Schemas, Beispiele (synthetisch) – geschützt
├── apps/
│   ├── api/                 # Backend (WP-2xx)
│   ├── worker/              # Jobs, Transkodierung
│   ├── dashboard/           # Web-Oberfläche (WP-3xx)
│   └── android/             # Tablet-App (WP-4xx)
├── packages/                # gemeinsam genutzte Typen/Clients aus contracts/
├── testdata/                # Generatoren für synthetische Daten (WP-003)
├── infra/
│   ├── compose/             # Compose-Dateien (WP-101)
│   ├── monitoring/          # (WP-103)
│   ├── backup/              # (WP-104)
│   └── server-setup/        # vorhandene Serverskripte + STATUS_SERVER.md
└── tools/                   # Doku-Check, Hilfsskripte (WP-001)
```
Auf dem Server: Arbeitskopie unter `/srv/taxiwerbung/app/gt-ads` (Ordnerschema bleibt `/srv/taxiwerbung`, siehe ADR-0009).

## 3. Modulgrenzen (Backend, modularer Monolith)
`auth` · `orgs` · `fleet` (Taxis/Geräte/Gruppen) · `media` · `campaigns` (Kunden/Kampagnen/Buchungen) · `scheduling` (Schleife/Manifest) · `delivery` (signierte Medien) · `telemetry` (Status/Ereignisse) · `analytics` (Rollups/Auswertung) · `commands` (Pause/Fernbefehle) · `config` · `alerts` · `audit`. Module sprechen nur über definierte Schnittstellen; keine Querzugriffe auf fremde Tabellen.
Android: `core` · `enrollment` · `sync` · `player` · `scheduler` · `power` (Fahrzeugbereitschaft) · `state` (Automat) · `telemetry` · `commands` · `presence-if` · `location-if` (aus).

## 4. Querschnittsregeln
Verträge zuerst · Tests mit jedem WP · Konfiguration statt Konstanten für Annahmen · Umgebungs-Guard · keine Secrets im Repo · jedes Modul mit README (Zweck, Schnittstellen, Tests, Annahmen).
