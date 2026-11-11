# GT-Ads – Inhaltsverzeichnis der Dokumentation (INDEX)

Stand: 2026-11-09 · Vollständige Liste aller Dokumente unter `docs/`. Einstieg für Menschen: [../README.md](../README.md) · Einstieg für KI: [../CLAUDE.md](../CLAUDE.md), [../AGENTS.md](../AGENTS.md).
Wahrheitsreihenfolge: Betreiberentscheidung > Anforderungen > Verträge > Architektur/Zustandsmodell > Arbeitspaket > Code. Kennzeichen: ✅ bestätigt · 🟦 vorläufig · 🔧 Annahme · ⚖️ rechtlich zu prüfen.
Pflege: bei jedem neuen oder verschobenen Dokument diese Liste aktualisieren (Prüfung: keine toten Links, jede Datei unter `docs/` ist gelistet).

## Stand und Fortschritt (`docs/fortschritt/`)
- [fortschritt/STATUS.md](fortschritt/STATUS.md) – GT-Ads – Projektstatus (Single Source of Truth für den aktuellen Stand)
- [fortschritt/berichte/2026-11-09_GT-ADS-001_Freigabebericht.md](fortschritt/berichte/2026-11-09_GT-ADS-001_Freigabebericht.md) – Freigabebericht GT-ADS-001 – Android-Geräteregistrierung
- [fortschritt/berichte/2026-11-09_GT-ADS-001_Planung.md](fortschritt/berichte/2026-11-09_GT-ADS-001_Planung.md) – Bericht 2026-11-09 – Planung GT-ADS-001 (Android-Geräteregistrierung)
- [fortschritt/berichte/2026-11-10_GT-ADS-001_Startpruefung.md](fortschritt/berichte/2026-11-10_GT-ADS-001_Startpruefung.md) – Bericht 2026-11-10 – Startprüfung GT-ADS-001: MVP-Vorgaben, Blocker im Runner
- [fortschritt/sessions/2026-11-09_GT-ADS-001_Planer_Claude.md](fortschritt/sessions/2026-11-09_GT-ADS-001_Planer_Claude.md) – Sitzung 2026-11-09 – GT-ADS-001 – Planer – Claude
- [fortschritt/sessions/2026-11-09_WP-006_Implementierer_Claude.md](fortschritt/sessions/2026-11-09_WP-006_Implementierer_Claude.md) – Sitzung 2026-11-09 – WP-006 – Implementierer – Claude
- [fortschritt/sessions/2026-11-09_Planung_Claude.md](fortschritt/sessions/2026-11-09_Planung_Claude.md) – Sitzung 2026-11-09 – Planung (Entwicklungsorganisation) – Planer – Claude

## Konzept (`docs/konzept/`)
- [konzept/ANFORDERUNGEN.md](konzept/ANFORDERUNGEN.md) – GT-Ads – Anforderungen
- [konzept/KONZEPT.md](konzept/KONZEPT.md) – GT-Ads – Konzept und Produktvision
- [konzept/QUELLEN/ENTSCHEIDUNGSPROTOKOLL_Tablet_Betrieb_v2.0.md](konzept/QUELLEN/ENTSCHEIDUNGSPROTOKOLL_Tablet_Betrieb_v2.0.md) – GT-Ads – Entscheidungsprotokoll Tablet-Betrieb v2.0 (Quelle: Betreiber, 09.11.2026)
- [konzept/QUELLEN/MASTERBRIEFING_GT-Ads.md](konzept/QUELLEN/MASTERBRIEFING_GT-Ads.md) – MASTERBRIEFING – GT-Ads | Eigene digitale Taxiwerbung-Plattform (Quelle: Betreiber)
- [konzept/ROADMAP.md](konzept/ROADMAP.md) – GT-Ads – Roadmap

## Architektur und Verträge (`docs/architektur/`)
- [architektur/ARCHITEKTUR.md](architektur/ARCHITEKTUR.md) – GT-Ads – Technische Architektur (v2.1)
- [architektur/ZUSTANDSMODELL.md](architektur/ZUSTANDSMODELL.md) – GT-Ads – Zustandsmodell: zwei Tablets pro Taxi
- [architektur/vertraege/CHANGE_REQUESTS.md](architektur/vertraege/CHANGE_REQUESTS.md) – Change Requests für Verträge
- [architektur/vertraege/README.md](architektur/vertraege/README.md) – Schnittstellenverträge (unveränderlich ohne Änderungsantrag)

## Entscheidungen (`docs/entscheidungen/`)
- [entscheidungen/OFFENE_ENTSCHEIDUNGEN.md](entscheidungen/OFFENE_ENTSCHEIDUNGEN.md) – GT-Ads – Offene Entscheidungen (für den Betreiber)
- [entscheidungen/adr/ADR-0001.md](entscheidungen/adr/ADR-0001.md) – ADR-0001: Modularer Monolith statt Microservices
- [entscheidungen/adr/ADR-0002.md](entscheidungen/adr/ADR-0002.md) – ADR-0002: Technologiewahl Backend, Dashboard, Android
- [entscheidungen/adr/ADR-0003.md](entscheidungen/adr/ADR-0003.md) – ADR-0003: Offline-first mit versionierten Manifesten
- [entscheidungen/adr/ADR-0004.md](entscheidungen/adr/ADR-0004.md) – ADR-0004: PostgreSQL und pg-boss (Queue)
- [entscheidungen/adr/ADR-0005.md](entscheidungen/adr/ADR-0005.md) – ADR-0005: Buchung ≠ Kampagne ≠ Schleifenplatz
- [entscheidungen/adr/ADR-0006.md](entscheidungen/adr/ADR-0006.md) – ADR-0006: Ereignisse bündeln, Rohdaten befristet, Aggregate dauerhaft
- [entscheidungen/adr/ADR-0007.md](entscheidungen/adr/ADR-0007.md) – ADR-0007: Domain statt IP, Storage-Interface, 12-Factor
- [entscheidungen/adr/ADR-0008.md](entscheidungen/adr/ADR-0008.md) – ADR-0008: KI-Agenten isoliert und rechtearm
- [entscheidungen/adr/ADR-0009.md](entscheidungen/adr/ADR-0009.md) – ADR-0009: Projektname `gt-ads`, Serverpfad `/srv/taxiwerbung` bleibt
- [entscheidungen/adr/ADR-0010.md](entscheidungen/adr/ADR-0010.md) – ADR-0010: Entwicklungs- und Reviewprozess (Claude plant, DeepSeek implementiert, Tests, unabhängiges Review)
- [entscheidungen/adr/ADR-0011.md](entscheidungen/adr/ADR-0011.md) – ADR-0011: Trennung Entwicklungs-/Test-/Produktivdaten
- [entscheidungen/adr/ADR-0012.md](entscheidungen/adr/ADR-0012.md) – ADR-0012: Kontextmanagement per Dateien (Session-Pack, Protokolle)
- [entscheidungen/adr/ADR-0013.md](entscheidungen/adr/ADR-0013.md) – ADR-0013: Android Device Owner und Kiosk (Eigenbau, MDM-Alternative offen)
- [entscheidungen/adr/README.md](entscheidungen/adr/README.md) – Architekturentscheidungen (ADR)

## Arbeitspakete (`docs/ARBEITSPAKETE/`)
- [ARBEITSPAKETE/ABHAENGIGKEITEN.md](ARBEITSPAKETE/ABHAENGIGKEITEN.md) – Abhängigkeitsübersicht
- [ARBEITSPAKETE/GT-ADS-001/API-VERTRAG.md](ARBEITSPAKETE/GT-ADS-001/API-VERTRAG.md) – GT-ADS-001 – API-Vertrag (Entwurf v0.1.0)
- [ARBEITSPAKETE/GT-ADS-001/ARCHITEKTUR.md](ARBEITSPAKETE/GT-ADS-001/ARCHITEKTUR.md) – GT-ADS-001 – Technischer Entwurf
- [ARBEITSPAKETE/GT-ADS-001/DEEPSEEK-AUFTRAG.md](ARBEITSPAKETE/GT-ADS-001/DEEPSEEK-AUFTRAG.md) – GT-ADS-001 – Implementierungsauftrag für DeepSeek
- [ARBEITSPAKETE/GT-ADS-001/SPEZIFIKATION.md](ARBEITSPAKETE/GT-ADS-001/SPEZIFIKATION.md) – GT-ADS-001 – Android-Geräteregistrierung: Spezifikation
- [ARBEITSPAKETE/GT-ADS-001/TESTPLAN.md](ARBEITSPAKETE/GT-ADS-001/TESTPLAN.md) – GT-ADS-001 – Testplan
- [ARBEITSPAKETE/KATALOG.md](ARBEITSPAKETE/KATALOG.md) – GT-Ads – Arbeitspaketkatalog
- [ARBEITSPAKETE/MVP_ROADMAP.md](ARBEITSPAKETE/MVP_ROADMAP.md) – Priorisierte MVP-Roadmap (Entwicklungsplanung)
- [ARBEITSPAKETE/PROJEKTSTRUKTUR.md](ARBEITSPAKETE/PROJEKTSTRUKTUR.md) – Projektstrukturplan GT-Ads
- [ARBEITSPAKETE/README.md](ARBEITSPAKETE/README.md) – Arbeitspakete – Übersicht, Status, Abhängigkeiten, Fortschritt
- [ARBEITSPAKETE/WP-005/API-VERTRAG.md](ARBEITSPAKETE/WP-005/API-VERTRAG.md) – WP-005 – Schnittstellenvereinbarung (statt API-Vertrag)
- [ARBEITSPAKETE/WP-005/ARCHITEKTUR.md](ARBEITSPAKETE/WP-005/ARCHITEKTUR.md) – WP-005 – Technischer Entwurf
- [ARBEITSPAKETE/WP-005/IMPLEMENTIERUNGSAUFTRAG.md](ARBEITSPAKETE/WP-005/IMPLEMENTIERUNGSAUFTRAG.md) – WP-005 – Implementierungsauftrag
- [ARBEITSPAKETE/WP-005/SPEZIFIKATION.md](ARBEITSPAKETE/WP-005/SPEZIFIKATION.md) – WP-005 – DeepSeek-Entwicklungsumgebung: Spezifikation
- [ARBEITSPAKETE/WP-005/TESTPLAN.md](ARBEITSPAKETE/WP-005/TESTPLAN.md) – WP-005 – Testplan
- [ARBEITSPAKETE/WP-006/API-VERTRAG.md](ARBEITSPAKETE/WP-006/API-VERTRAG.md) – WP-006 – Schnittstellenvertrag (Telegram, DeepSeek, Befehle, Status)
- [ARBEITSPAKETE/WP-006/ARCHITEKTUR.md](ARBEITSPAKETE/WP-006/ARCHITEKTUR.md) – WP-006 – Technischer Entwurf
- [ARBEITSPAKETE/WP-006/IMPLEMENTIERUNGSAUFTRAG.md](ARBEITSPAKETE/WP-006/IMPLEMENTIERUNGSAUFTRAG.md) – WP-006 – Implementierungsauftrag
- [ARBEITSPAKETE/WP-006/SPEZIFIKATION.md](ARBEITSPAKETE/WP-006/SPEZIFIKATION.md) – WP-006 – Telegram-Gateway (Phase 1): Spezifikation
- [ARBEITSPAKETE/WP-006/TESTPLAN.md](ARBEITSPAKETE/WP-006/TESTPLAN.md) – WP-006 – Testplan
- [ARBEITSPAKETE/WP-007/STATUSBERICHT.md](ARBEITSPAKETE/WP-007/STATUSBERICHT.md) – WP-007 – OpenClaw Phase A: Statusbericht
- [ARBEITSPAKETE/WP-009/DEEPSEEK-AUFTRAG.md](ARBEITSPAKETE/WP-009/DEEPSEEK-AUFTRAG.md) – WP-009 – Auftrag für den Coding-Agenten (synthetischer Pilot)
- [ARBEITSPAKETE/WP-009/SPEZIFIKATION.md](ARBEITSPAKETE/WP-009/SPEZIFIKATION.md) – WP-009 – Coding-Agent-Pilot: Spezifikation
- [ARBEITSPAKETE/WP-009/TESTPLAN.md](ARBEITSPAKETE/WP-009/TESTPLAN.md) – WP-009 – Testplan
- [ARBEITSPAKETE/WP-011/SPEZIFIKATION.md](ARBEITSPAKETE/WP-011/SPEZIFIKATION.md) – WP-011 – Codex als automatischer Code-Reviewer: Spezifikation und Stand
- [ARBEITSPAKETE/WP-012/SPEZIFIKATION.md](ARBEITSPAKETE/WP-012/SPEZIFIKATION.md) – WP-012 – Gemini als optionaler, beratender Zusatz-Reviewer

## Tests (`docs/tests/`)
- [tests/HARDWARETESTPLAN.md](tests/HARDWARETESTPLAN.md) – GT-Ads – Hardwaretestplan Tablet-Betrieb
- [tests/README.md](tests/README.md) – Tests – Überblick

## Prozess und KI-Regeln (`docs/prozess/`)
- [prozess/DATENTRENNUNG.md](prozess/DATENTRENNUNG.md) – Trennung von Entwicklungs-, Test- und Produktivdaten
- [prozess/DEFINITION_OF_DONE.md](prozess/DEFINITION_OF_DONE.md) – Definition of Done (gilt für jedes Arbeitspaket)
- [prozess/ENTWICKLUNGSPROZESS.md](prozess/ENTWICKLUNGSPROZESS.md) – Entwicklungs- und Reviewprozess
- [prozess/GITHUB_ARBEITSWEISE.md](prozess/GITHUB_ARBEITSWEISE.md) – GitHub-Arbeitsweise über Claude Code
- [prozess/TELEGRAM_STEUERUNG.md](prozess/TELEGRAM_STEUERUNG.md) – Telegram-Steuerung des KI-Agenten – Installationsstand, Prüfung und Plan
- [prozess/DEEPSEEK_ENTWICKLUNGSUMGEBUNG.md](prozess/DEEPSEEK_ENTWICKLUNGSUMGEBUNG.md) – DeepSeek-Entwicklungsumgebung – sicherer Einrichtungsplan
- [prozess/KI_REGELN.md](prozess/KI_REGELN.md) – KI-Regeln (verbindlich für Claude, DeepSeek und jede weitere KI)
- [prozess/KONTEXTMANAGEMENT.md](prozess/KONTEXTMANAGEMENT.md) – Kontextmanagement und neue KI-Sitzungen
- [prozess/SESSION_START.md](prozess/SESSION_START.md) – Vorlagen für KI-Sitzungen

## Analyse (`docs/analyse/`)
- [analyse/WIDERSPRUECHE_LUECKEN_ANNAHMEN.md](analyse/WIDERSPRUECHE_LUECKEN_ANNAHMEN.md) – Analyse: Widersprüche, fehlende Informationen, unbelegte Annahmen

## Vorlagen (`docs/ARBEITSPAKETE/_VORLAGE/`)
- [ARBEITSPAKETE/_VORLAGE/API-VERTRAG.md](ARBEITSPAKETE/_VORLAGE/API-VERTRAG.md) – Vorlage API-VERTRAG.md
- [ARBEITSPAKETE/_VORLAGE/ARCHITEKTUR.md](ARBEITSPAKETE/_VORLAGE/ARCHITEKTUR.md) – Vorlage ARCHITEKTUR.md
- [ARBEITSPAKETE/_VORLAGE/DEEPSEEK-AUFTRAG.md](ARBEITSPAKETE/_VORLAGE/DEEPSEEK-AUFTRAG.md) – Vorlage DEEPSEEK-AUFTRAG.md
- [ARBEITSPAKETE/_VORLAGE/SPEZIFIKATION.md](ARBEITSPAKETE/_VORLAGE/SPEZIFIKATION.md) – Vorlage SPEZIFIKATION.md
- [ARBEITSPAKETE/_VORLAGE/TESTPLAN.md](ARBEITSPAKETE/_VORLAGE/TESTPLAN.md) – Vorlage TESTPLAN.md

## Archiv – Vorversionen, **nicht verbindlich** (`docs/konzept/ARCHIV/`)
- [konzept/ARCHIV/ANFORDERUNGEN_v1_2026-11-09.md](konzept/ARCHIV/ANFORDERUNGEN_v1_2026-11-09.md)
- [konzept/ARCHIV/ARCHITEKTUR_v1_2026-11-09.md](konzept/ARCHIV/ARCHITEKTUR_v1_2026-11-09.md)
- [konzept/ARCHIV/KONZEPT_v1_2026-11-09.md](konzept/ARCHIV/KONZEPT_v1_2026-11-09.md)
- [konzept/ARCHIV/OFFENE_ENTSCHEIDUNGEN_v1_2026-11-09.md](konzept/ARCHIV/OFFENE_ENTSCHEIDUNGEN_v1_2026-11-09.md)
- [konzept/ARCHIV/ROADMAP_v1_2026-11-09.md](konzept/ARCHIV/ROADMAP_v1_2026-11-09.md)
