# Architekturentscheidungen (ADR)

Jede Architektur- oder Prozessentscheidung = eine Datei `ADR-nnnn.md`. Statuswerte: Vorgeschlagen · Akzeptiert (nur durch Betreiber) · Verworfen · Ersetzt durch ADR-nnnn.
Produkt-/Geschäftsentscheidungen stehen im Entscheidungsprotokoll (`docs/entscheidungen/OFFENE_ENTSCHEIDUNGEN.md`), nicht hier.

## Übersicht
| ADR | Titel | Status |
|---|---|---|
| [0001](ADR-0001.md) | Modularer Monolith statt Microservices | Vorgeschlagen |
| [0002](ADR-0002.md) | Technologiewahl Backend, Dashboard, Android | Vorgeschlagen |
| [0003](ADR-0003.md) | Offline-first mit versionierten Manifesten | Akzeptiert |
| [0004](ADR-0004.md) | PostgreSQL und pg-boss (Queue) | Vorgeschlagen |
| [0005](ADR-0005.md) | Buchung ≠ Kampagne ≠ Schleifenplatz | Vorgeschlagen |
| [0006](ADR-0006.md) | Ereignisse bündeln, Rohdaten befristet, Aggregate dauerhaft | Vorgeschlagen |
| [0007](ADR-0007.md) | Domain statt IP, Storage-Interface, 12-Factor | Vorgeschlagen |
| [0008](ADR-0008.md) | KI-Agenten isoliert und rechtearm | Akzeptiert |
| [0009](ADR-0009.md) | Projektname `gt-ads`, Serverpfad `/srv/taxiwerbung` bleibt | Akzeptiert |
| [0010](ADR-0010.md) | Entwicklungs- und Reviewprozess (Claude plant, DeepSeek implementiert, Tests, unabhängiges Review) | Vorgeschlagen |
| [0011](ADR-0011.md) | Trennung Entwicklungs-/Test-/Produktivdaten | Vorgeschlagen |
| [0012](ADR-0012.md) | Kontextmanagement per Dateien (Session-Pack, Protokolle) | Vorgeschlagen |
| [0013](ADR-0013.md) | Android Device Owner und Kiosk (Eigenbau, MDM-Alternative offen) | Vorgeschlagen |

## Zuordnung zur Kurzliste in ARCHITEKTUR §14
ADR-01→0001 · ADR-02→0004 · ADR-03→0003 · ADR-04→0005 · ADR-05→0006 · ADR-06→0013 · ADR-07→0007 · ADR-08→0008 · ADR-09→0009. Neu: 0002, 0010, 0011, 0012.

## Vorlage
Kontext · Entscheidung · Alternativen · Folgen · Quelle · Status/Datum.
