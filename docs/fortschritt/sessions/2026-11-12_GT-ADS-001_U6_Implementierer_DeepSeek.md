# GT-ADS-001 · U6 – Sitzungsprotokoll (Coding-Agent)

Datum: 2026-11-12
Unteraufgabe: U6 – Admin-API
Branch: agent/U6
Akzeptanz: AC-08, AC-12, AC-13; Tests: I-18…I-23, I-25, I-26

## Umsetzung

- apps/api/src/modules/adminAuth/repository.ts
  - admin_sessions: nur der SHA-256-Hash des Sitzungstokens wird
    gespeichert; Suchen und Loeschen ueber den Hash.
- apps/api/src/modules/adminAuth/service.ts
  - Login gegen den scrypt-Hash aus `GT_ADS_ADMIN_PASSWORD_HASH`
    (zeitkonstanter Vergleich aus U2), generischer 401 bei falschem
    Passwort, Audit `admin.login.failed`/`admin.login.succeeded`,
    Sitzungstoken 32 Byte Base64url, TTL aus `GT_ADS_ADMIN_SESSION_TTL_S`.
  - `verifySession`: unbekannt/abgelaufen/formal ungueltig -> null.
  - `logout`: Sitzungszeile loeschen.
- apps/api/src/modules/adminAuth/middleware.ts
  - Cookie `gt_ads_session` (Name laut Vertrag), Sitzungspruefung bei jeder
    Admin-Anfrage.
  - CSRF-Schutz fuer POST/DELETE: Content-Type muss application/json sein,
    gesendeter Origin muss dem eigenen Ursprung entsprechen
    (`protocol://host`), sonst 403 forbidden. Laeuft als onRequest-Hook,
    damit die Pruefung vor dem Body-Parser greift (falscher Content-Type
    ergibt 403 statt 415).
- apps/api/src/modules/adminAuth/routes.ts
  - POST /v1/admin/login (204 + Cookie), POST /v1/admin/logout (204).
  - Login-Rate-Limit 429 mit Retry-After nach der Fehlversuchsgrenze
    (siehe Annahmen).
- apps/api/src/modules/registration/routes.ts (Erweiterung)
  - POST /v1/admin/registration-codes -> 201 mit Klartext-Code nur hier;
    GET /v1/admin/registration-codes -> Items mit Status
    pending/used/expired/revoked; DELETE /v1/admin/registration-codes/{id}
    -> 204, benutzt/unbekannt 404. Alle Routen mit Sitzungspflicht.
- apps/api/src/modules/devices/routes.ts (neu)
  - GET /v1/admin/devices -> server_time, online_threshold_s, items
    (inkl. zur Lesezeit berechnetem connectivity; truncated nur wenn noetig);
    GET /v1/admin/devices/{id} -> Item + last_clock_offset_ms +
    registration_code_id; POST /v1/admin/devices/{id}/revoke -> 204,
    idempotent, unbekannt 404.
- apps/api/src/modules/devices/service.ts + repository.ts (Erweiterung)
  - Detailzeile, Sperre in Transaktion mit Audit `device.revoked`
    (Actor admin), bereits gesperrt = kein Fehler. Die Sperre wirkt ueber
    die bestehende Token-Pruefung sofort (403 device_revoked).
- apps/api/src/db/cleanup.ts (neu)
  - loescht abgelaufene Challenges, Access-Tokens und Admin-Sitzungen, die
    laenger als 24 h abgelaufen sind; Codes, Geraete und Audit bleiben.
    Aufruf beim Serverstart und stuendlich (Timer unref).
- apps/api/src/http/server.ts
  - registriert @fastify/cookie, Admin-/Geraete-Routen und die Bereinigung;
    JSON-Parser toleriert leere Bodies (Logout/DELETE ohne Inhalt), damit
    der Content-Type-Zwang des Vertrags ohne 415/400 erfuellbar ist.

## Tests (echte Ausgabe)

Befehl (Wurzel): with-postgres sh -c "npm run -s typecheck && npm test -s"

    ✓ tests/integration/adminApi.test.ts (8 tests)
    ✓ tests/integration/deviceAuth.test.ts (5 tests)
    ✓ tests/integration/devicesList.test.ts (5 tests)
    ✓ tests/integration/heartbeat.test.ts (4 tests)
    ✓ tests/integration/registration.test.ts (13 tests)
    ✓ tests/unit/config.test.ts (11 tests)
    ✓ tests/unit/deviceSignature.test.ts (9 tests)
    ✓ tests/unit/deviceStatus.test.ts (4 tests)
    ✓ tests/unit/logging.test.ts (10 tests)
    ✓ tests/unit/password.test.ts (6 tests)
    ✓ tests/unit/rateLimit.test.ts (5 tests)
    ✓ tests/unit/registrationCode.test.ts (13 tests)
    ✓ tests/unit/tokens.test.ts (7 tests)
    ✓ tests/db/createDump.test.ts (4 tests)
    ✓ tests/db/migrate.test.ts (3 tests)
    ✓ tests/db/verifyRestore.test.ts (4 tests)
    ✓ tests/static/u0-scaffold.test.ts (10 tests)

    Test Files  17 passed (17)
         Tests  121 passed (121)

    RUN  v5.1.0 /workspace/apps/dashboard

    ✓ src/tests/app.test.tsx (1 test)
    Test Files  1 passed (1)
         Tests  1 passed (1)

Ergebnis: Exit-Code 0; Typecheck ohne Fehler; 122 Tests bestanden,
0 fehlgeschlagen, 0 uebersprungen.

Neue Tests in tests/integration/adminApi.test.ts:
- I-18 Sperre: bestehendes Token 403 device_revoked, neue Challenge 403,
  Liste/Detail zeigen revoked, zweite Sperre 204, unbekannt 404.
- I-19 ohne Sitzung 401; mit Sitzung 200/201; Logout invalidiert; Sitzung
  nach TTL abgelaufen -> 401.
- I-20 fremder Origin und falscher Content-Type -> 403; gleicher Origin ok.
- I-21 falsches Passwort -> generisches 401 (Meldung = Vertragstext), sechster
  Fehlversuch -> 429 mit Retry-After.
- I-22 Audit enthaelt Code erzeugt/widerrufen/benutzt, Geraet
  registriert/gesperrt, Login ok/fehl; Details ohne Code, Passwort,
  Schluessel, Token, Nonce, Signatur; Feldnamen nicht geheim.
- I-23 leere Liste, ein Eintrag mit Vertragsfeldern, Schwelle gleich/
  +1 ms, Sortierung nach last_seen_at.
- I-25 Socket-Adresse 127.0.0.1, /health ueber Loopback erreichbar.
- I-26 Bereinigung loescht je 1 lange abgelaufene Challenge/Token/Sitzung,
  behaelt kuerzlich abgelaufene und gueltige sowie Codes/Geraete/Audit.

## Entscheidungen / Annahmen

- Fuer den Admin-Login ist keine eigene Fehlversuchsgrenze spezifiziert;
  verwendet werden die Registrierungsgrenzen
  `GT_ADS_REG_MAX_FAILS_PER_SOURCE`/`_WINDOW_S` (5/900 s). Bei Erfolg wird
  der Zaehler der Quelle zurueckgesetzt.
- "abgelaufene Challenges (> 24 h)" wird als Aufbewahrung 24 h nach Ablauf
  gelesen; dasselbe gilt fuer Tokens und Admin-Sitzungen.
- CSRF-/Content-Type-Pruefung laeuft vor der Sitzungspruefung. Ein
  unangemeldeter POST ohne JSON-Content-Type ergibt daher 403 statt 401;
  alle anderen unangemeldeten Admin-Anfragen ergeben 401.
- `last_clock_offset_ms` (bigint) wird als JSON-Zahl geliefert; Werte
  ausserhalb des sicheren Zahlenbereichs werden als null geliefert.
- Leere JSON-Bodies werden als `{}` geparst (Logout, DELETE, Revoke ohne
  Inhalt); ungueltiges JSON bleibt 400 invalid_request.
- Datei `apps/api/src/db/cleanup.ts` ist neu und steht nicht in der
  Dateiliste von ARCHITEKTUR.md Abschnitt 2; sie liegt innerhalb des vom
  Auftrag erlaubten Pfads `apps/api/` und setzt die dort beschriebene
  Bereinigung um (I-26).

## Offene Punkte / Fragen

- Keine blockierenden Fragen.
- Der Vertrag nennt fuer `GET /v1/admin/devices/{id}` "ein Item wie Liste";
  umgesetzt sind alle Listenfelder plus `last_clock_offset_ms` und
  `registration_code_id`.
- Keine Secrets, keine echten Kennungen; Testdaten synthetisch (SYN-).
