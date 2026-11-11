# GT-ADS-001 · U1 – Sitzungsprotokoll (Coding-Agent)

Datum: 2026-11-11
Unteraufgabe: U1 – Datenbank
Branch: agent/U1

## Umsetzung

- apps/api/src/db/client.ts: databaseUrlFromEnv (kein Standardwert fuer
  GT_ADS_DB_URL) und createDatabasePool (pg.Pool, Aufrufer schliesst).
- apps/api/src/db/migrate.ts: migrateUp/migrateDown lesen die SQL-Dateien
  und fuehren sie ueber eine minimale SqlExecutor-Schnittstelle aus.
  assertDownAllowed verweigert den Rueckweg, wenn GT_ADS_ENV fehlt oder
  nicht dev/test ist – vor jedem Datenbankzugriff.
- apps/api/src/db/migrations/0001_gt_ads_001.up.sql: Schema exakt
  ARCHITEKTUR.md §3 (registration_codes, devices, device_auth_challenges,
  device_access_tokens, admin_sessions, audit_events; Indizes laut §3;
  keine Seeds).
- apps/api/src/db/migrations/0001_gt_ads_001.down.sql: entfernt die sechs
  Tabellen samt Indizes/Constraints (drop table if exists ... cascade).
- apps/api/tests/db/migrate.test.ts: I-01 (up -> Schema, down -> leer, erneut
  up -> Schema) und I-02 (Down mit GT_ADS_ENV=prod sowie ohne GT_ADS_ENV wird
  verweigert, Schema bleibt unveraendert).

## Entscheidung / Annahme

- registration_codes.used_by_device_id ist als nachtraeglich angelegter,
  deferrable FK auf devices(id) umgesetzt (ARCHITEKTUR.md §3 erlaubt
  deferrable FK oder FK-frei mit Constraint-Test). Der Zyklus wird durch
  "deferrable initially deferred" aufgeloest; es ist kein zusaetzlicher
  Constraint-Test noetig.
- Kein Migration-Tracking-Objekt: U1 verlangt nur Migration 0001 vorwaerts und
  rueckwaerts; ein zusaetzliches Buchhaltungsobjekt wuerde das in §3
  festgelegte Schema erweitern.

## Tests (echte Ausgabe)

Befehl: with-postgres sh -c "npm run -s typecheck && npm test -s"

    RUN  v5.1.0 /workspace/apps/api
     ✓ tests/static/u0-scaffold.test.ts (7 tests) 42ms
     ✓ tests/db/migrate.test.ts (3 tests) 162ms
     Test Files  2 passed (2)
          Tests  10 passed (10)

    RUN  v5.1.0 /workspace/apps/dashboard
     ✓ src/tests/app.test.tsx (1 test) 147ms
     Test Files  1 passed (1)
          Tests  1 passed (1)

Ergebnis: Exit-Code 0, Typecheck ohne Fehler, alle Tests bestanden.

## Offene Punkte / Fragen

Keine neuen Q-Fragen.
