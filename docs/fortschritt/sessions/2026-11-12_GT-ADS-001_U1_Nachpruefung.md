# GT-ADS-001 · U1 – Nachpruefung (Coding-Agent)

Datum: 2026-11-12
Unteraufgabe: U1 – Datenbank
Branch: agent/U1

## Ausgangslage

U1 ist im Integrationsstand bereits umgesetzt (Commit `9963ed7`,
Sitzungsprotokoll `2026-11-11_GT-ADS-001_U1_Implementierer_DeepSeek.md`).
Diese Nachpruefung kontrolliert den Stand gegen Spezifikation und
Abnahmebefehl; es waren keine Codeaenderungen notwendig.

## Geprueft

- `apps/api/src/db/client.ts`: `databaseUrlFromEnv` ohne Standardwert,
  `createDatabasePool` (pg.Pool).
- `apps/api/src/db/migrate.ts`: `migrateUp`/`migrateDown`; `assertDownAllowed`
  verweigert den Rueckweg bei fehlendem oder nicht dev/test `GT_ADS_ENV`
  vor jedem Datenbankzugriff.
- `0001_gt_ads_001.up.sql`: Schema gegen ARCHITEKTUR.md §3 abgeglichen
  (6 Tabellen, Spalten/Typen/NULLability/Defaults, 5 geforderte Indizes,
  Check-Constraints, deferrable FK `registration_codes.used_by_device_id`).
- `0001_gt_ads_001.down.sql`: entfernt alle sechs Tabellen samt
  Indizes/Constraints; danach 0 Tabellen im Schema `public`.
- `apps/api/tests/db/migrate.test.ts`: I-01 und I-02 vorhanden und nicht
  abgeschwaecht.

## Testausfuehrung (echte Ausgabe)

Befehl: `with-postgres sh -c "npm run -s typecheck && npm test -s"`

    RUN  v5.1.0 /workspace/apps/api

     ✓ tests/static/u0-scaffold.test.ts (10 tests) 59ms
     ✓ tests/unit/deviceSignature.test.ts (9 tests) 78ms
     ✓ tests/unit/registrationCode.test.ts (13 tests) 331ms
     ✓ tests/unit/logging.test.ts (9 tests) 13ms
     ✓ tests/unit/config.test.ts (11 tests) 103ms
     ✓ tests/unit/rateLimit.test.ts (5 tests) 8ms
     ✓ tests/db/migrate.test.ts (3 tests) 139ms
     ✓ tests/unit/password.test.ts (6 tests) 928ms
     ✓ tests/db/createDump.test.ts (4 tests) 2025ms
     ✓ tests/db/verifyRestore.test.ts (4 tests) 6027ms

     Test Files  10 passed (10)
          Tests  74 passed (74)

    RUN  v5.1.0 /workspace/apps/dashboard

     ✓ src/tests/app.test.tsx (1 test) 121ms

     Test Files  1 passed (1)
          Tests  1 passed (1)

Ergebnis: Exit-Code 0, Typecheck ohne Fehler, alle Tests bestanden.

## Offene Punkte / Fragen

Keine neuen Q-Fragen.

