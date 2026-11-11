# GT-Ads

Eigenes digitales Werbenetzwerk für Taxis in Wien: zwei Android-Tablets je Taxi, zentrales Dashboard, Offline-Wiedergabe. Technischer Name `gt-ads`.
**Status: Planungsphase – noch keine Software implementiert. Kein Arbeitspaket freigegeben.** (Stand 2026-11-09)

## Direkt zu den wichtigsten Dokumenten
| Thema | Link |
|---|---|
| **Vollständiges Inhaltsverzeichnis** | [docs/INDEX.md](docs/INDEX.md) |
| Aktueller Stand, offene Fragen | [docs/fortschritt/STATUS.md](docs/fortschritt/STATUS.md) |
| Geschäftsidee und Vision | [docs/konzept/KONZEPT.md](docs/konzept/KONZEPT.md) |
| Anforderungen (MVP/V2/V3) | [docs/konzept/ANFORDERUNGEN.md](docs/konzept/ANFORDERUNGEN.md) |
| Technische Architektur | [docs/architektur/ARCHITEKTUR.md](docs/architektur/ARCHITEKTUR.md) · [Zustandsmodell](docs/architektur/ZUSTANDSMODELL.md) |
| Schnittstellenverträge | [docs/architektur/vertraege/README.md](docs/architektur/vertraege/README.md) |
| Roadmap | [docs/konzept/ROADMAP.md](docs/konzept/ROADMAP.md) · [MVP-Reihenfolge der Arbeitspakete](docs/ARBEITSPAKETE/MVP_ROADMAP.md) |
| Arbeitspakete (Status, Katalog, Abhängigkeiten) | [docs/ARBEITSPAKETE/README.md](docs/ARBEITSPAKETE/README.md) · [Katalog](docs/ARBEITSPAKETE/KATALOG.md) · [Abhängigkeiten](docs/ARBEITSPAKETE/ABHAENGIGKEITEN.md) |
| **Erstes Paket: GT-ADS-001 Android-Geräteregistrierung** | [Spezifikation](docs/ARBEITSPAKETE/GT-ADS-001/SPEZIFIKATION.md) · [Entwurf](docs/ARBEITSPAKETE/GT-ADS-001/ARCHITEKTUR.md) · [API-Vertrag](docs/ARBEITSPAKETE/GT-ADS-001/API-VERTRAG.md) · [Testplan](docs/ARBEITSPAKETE/GT-ADS-001/TESTPLAN.md) · [DeepSeek-Auftrag](docs/ARBEITSPAKETE/GT-ADS-001/DEEPSEEK-AUFTRAG.md) |
| Entscheidungen | [Offene Entscheidungen / Protokoll](docs/entscheidungen/OFFENE_ENTSCHEIDUNGEN.md) · [ADRs](docs/entscheidungen/adr/README.md) |
| Tests | [docs/tests/README.md](docs/tests/README.md) · [Hardwaretestplan](docs/tests/HARDWARETESTPLAN.md) |
| Prozess und KI-Regeln | [KI-Regeln](docs/prozess/KI_REGELN.md) · [Entwicklungsprozess](docs/prozess/ENTWICKLUNGSPROZESS.md) · [Definition of Done](docs/prozess/DEFINITION_OF_DONE.md) · [Datentrennung](docs/prozess/DATENTRENNUNG.md) · [Kontext/Sitzungen](docs/prozess/KONTEXTMANAGEMENT.md) |
| Analyse (Widersprüche, Lücken, Annahmen) | [docs/analyse/WIDERSPRUECHE_LUECKEN_ANNAHMEN.md](docs/analyse/WIDERSPRUECHE_LUECKEN_ANNAHMEN.md) |
| Quellen des Betreibers | [Masterbriefing](docs/konzept/QUELLEN/MASTERBRIEFING_GT-Ads.md) · [Protokoll Tablet-Betrieb v2.0](docs/konzept/QUELLEN/ENTSCHEIDUNGSPROTOKOLL_Tablet_Betrieb_v2.0.md) |
| Server-Einrichtung (Skripte, keine Secrets) | [infra/server-setup/](infra/server-setup/) |

## Für KI-Sitzungen (Claude, DeepSeek)
Einstieg: [CLAUDE.md](CLAUDE.md) / [AGENTS.md](AGENTS.md). Regel: **kein Code ohne freigegebenes Arbeitspaket**, nichts erfinden, Fakt/Annahme/Offen trennen.

Dieses Repository enthält **keine** Zugangsdaten, Produktivdaten oder Datenbank-Backups (siehe [Datentrennung](docs/prozess/DATENTRENNUNG.md)). Änderungen nur über Branches und Pull Requests; gemergt wird ausschließlich vom Betreiber (Squash).
