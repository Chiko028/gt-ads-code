# Definition of Done (gilt für jedes Arbeitspaket)

Ein Arbeitspaket ist **nur dann** „Done", wenn **alle** Punkte erfüllt und belegt sind. „Belegt" = Datei/Commit/Testausgabe im PR verlinkt, nicht behauptet. Arbeitspaketspezifische Ergänzungen stehen im WP unter „DoD+".

## Standard-DoD
1. **Freigabe:** WP-Status war „Freigegeben" vor Beginn; Umfang entspricht dem Auftrag, keine Nebenänderungen.
2. **Akzeptanzkriterien:** jedes Kriterium einzeln erfüllt und mit Beleg (Test/Log/Datei) verknüpft.
3. **Tests vorhanden und grün:** Unit-/Integrations-/Contract-Tests laut WP; Ausgabe der echten Testausführung im PR; keine übersprungenen oder abgeschwächten Tests; Baseline-Tests unverändert grün.
4. **Fehler- und Grenzfälle** getestet (Offline, doppelte Ereignisse/Idempotenz, ungültige Eingaben, Berechtigungen) – soweit im WP relevant.
5. **Verträge:** unverändert, oder Change Request genehmigt und Contract-Tests angepasst.
6. **Daten:** nur synthetische Test-/Entwicklungsdaten; keine Secrets/Produktivdaten/echten Kennungen in Code, Tests, Logs, Doku. Umgebungs-Guard greift in `prod`.
7. **Sicherheit:** Eingaben validiert, Zugriffsrechte geprüft, keine Geheimnisse im Log, Abhängigkeiten ohne bekannte kritische Lücken (Audit-Ausgabe).
8. **Statische Prüfung:** Lint/Format/Typen ohne Fehler.
9. **Review:** unabhängiges Review (frische Sitzung) „Bestanden"; offene Punkte geschlossen oder als Folge-WP/Frage erfasst.
10. **CI grün** auf dem PR-Stand, der gemergt wird; Merge durch Betreiber.
11. **Dokumentation:** README/Moduldoku/Runbook aktualisiert; Annahmen und offene Fragen dokumentiert; ADR falls Architekturentscheidung.
12. **Rückgängig machbar:** `git revert` getestet bzw. Rückweg der Migration beschrieben; keine unumkehrbaren Datenänderungen ohne Backup.
13. **Status:** `docs/fortschritt/STATUS.md` und Sitzungsprotokoll aktualisiert; WP-Tag gesetzt.
14. **Verifikation (wo zutreffend):** Abnahme am echten Zielsystem/-gerät durch den Betreiber; bis dahin Status „Done (nicht verifiziert)".

## Nicht-Done-Fälle (Beispiele)
Tests fehlen oder scheitern · Test mit erfundenen Daten · Akzeptanzkriterium „fast" erfüllt · Annahme ohne Kennzeichnung · Vertrag stillschweigend geändert · Ausgabe „sollte funktionieren" statt Testbeleg · nicht ausgeführte Tests.

## Zusatz je Bereich (DoD+ Muster)
- **Backend:** OpenAPI/Schema aktuell, Migration vorwärts+Rückweg, Integrationstest gegen echte Postgres-Instanz (Test-Umgebung).
- **Android:** Test auf mindestens einem physischen Testgerät (Modell/Android-Version dokumentiert) **oder** ausdrücklich als „nur Emulator" markiert; Offline-/Neustart-Szenarien laut WP.
- **Dashboard:** Berechtigungstest, keine Rohdaten Dritter ohne Rolle.
- **Infra:** nur nach Betreiberfreigabe am Server; Änderungsprotokoll in `infra/server-setup/STATUS_SERVER.md`; Backup/Rollback vorhanden.
