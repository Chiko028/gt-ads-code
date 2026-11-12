# GT-ADS-001 · U0 – Nachprüfung (Coding-Agent)

Datum: 2026-11-12
Unteraufgabe: U0 – Minimalgeruest
Branch: agent/U0
Ausgangsstand: 5c419a6 (U0 in 4648159, Review-Korrektur REV-5 in d0534ce)

## Befund

U0 ist im Workspace bereits vollstaendig umgesetzt und durch REV-5 korrigiert.
Alle fuer U0 geforderten Dateien sind vorhanden; es waren keine Code-Aenderungen
noetig. Diese Sitzung hat den Stand gegen die Abnahmekriterien geprueft und die
vollstaendige Testsuite ausgefuehrt.

## Abnahmekriterien (geprueft)

- Wurzel-package.json: Workspaces apps/api und apps/dashboard; Skripte
  typecheck und test delegieren an alle Workspaces.
- infra/compose/docker-compose.dev.yml: veroeffentlicht nur
  127.0.0.1:8080:8080; db ohne ports; GT_ADS_ENV=dev; Images gepinnt
  (postgres:17.6-bookworm, node:22.23.4-bookworm-slim), kein latest.
- .env.example: nur Schluessel ohne Werte und ohne Geheimnisse.
- apps/api: package.json, tsconfig.json, vitest.config.ts und Dockerfile
  vorhanden; apps/dashboard: package.json, vite.config.ts, tsconfig.json und
  index.html vorhanden.
- Compose-/Secret-Check in apps/api/tests/static/u0-scaffold.test.ts vorhanden
  und gruen.

## Tests (echte Ausgabe, gekuerzt)

Befehl: with-postgres sh -c "npm run -s typecheck && npm test -s"

    RUN  v5.1.0 /workspace/apps/api
     ✓ tests/static/u0-scaffold.test.ts (10 tests)
     ✓ tests/unit/deviceSignature.test.ts (9 tests)
     ✓ tests/unit/registrationCode.test.ts (13 tests)
     ✓ tests/unit/logging.test.ts (9 tests)
     ✓ tests/unit/config.test.ts (11 tests)
     ✓ tests/unit/rateLimit.test.ts (5 tests)
     ✓ tests/db/migrate.test.ts (3 tests)
     ✓ tests/unit/password.test.ts (6 tests)
     ✓ tests/db/createDump.test.ts (4 tests)
     ✓ tests/db/verifyRestore.test.ts (4 tests)
     Test Files  10 passed (10)
          Tests  74 passed (74)

    RUN  v5.1.0 /workspace/apps/dashboard
     ✓ src/tests/app.test.tsx (1 test)
     Test Files  1 passed (1)
          Tests  1 passed (1)

Ergebnis: Exit-Code 0, Typecheck ohne Fehler, keine uebersprungenen Tests.

Zusaetzlich: npm ci --dry-run --ignore-scripts --offline endet mit Exit-Code 0;
die package-lock.json ist zum Wurzel- und Workspace-Paketstand konsistent.

## Offene Punkte / Annahmen

- Ein echtes npm ci wurde in der Sandbox nicht ausgefuehrt: kein Netz und kein
  gefuellter npm-Cache. Der Dry-Run validiert nur die Lockfile-Konsistenz.
- Die gepinnten Image-Tags konnten ohne Netz nicht gegen eine Registry geprueft
  werden; sie enthalten kein latest.
- Keine neuen Q-Fragen.
