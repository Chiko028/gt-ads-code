# Tests – Überblick

Stand: 2026-11-09 · Teststrategie, Zuordnung der Testpläne und Regeln. Nichts hier ersetzt `docs/prozess/DEFINITION_OF_DONE.md`.

## Regeln (verbindlich)
Nur synthetische Testdaten (`docs/prozess/DATENTRENNUNG.md`) · Tests prüfen echtes Verhalten (keine Tautologien, keine Mocks der getesteten Einheit) · nichts abschwächen/überspringen · echte Ausgabe im PR · nicht ausgeführte Tests als „nicht ausgeführt" melden · Integrationstests gegen echte PostgreSQL-Testinstanz.

## Testpläne
| Plan | Gegenstand | Datei |
|---|---|---|
| GT-ADS-001 | Android-Geräteregistrierung (Unit, Integration, Contract, UI, Gerät, manuell) | [../ARBEITSPAKETE/GT-ADS-001/TESTPLAN.md](../ARBEITSPAKETE/GT-ADS-001/TESTPLAN.md) |
| Hardware | Tablet, Strom, Taster, Sensorik, Mobilfunk (Stufen 1–4) | [HARDWARETESTPLAN.md](HARDWARETESTPLAN.md) |
| weitere Pakete | je Paketordner `TESTPLAN.md` | [../ARBEITSPAKETE/README.md](../ARBEITSPAKETE/README.md) |

## Stufen (Standard für Pakete)
T1 Unit · T2 Integration (echte DB) · T3 Contract · T4 Komponenten/UI · T5 Gerät instrumentiert · T6 manuell (Betreiber) · T7 statisch (Lint, Typen, Secret-Scan, Manifest-/Compose-Checks).
