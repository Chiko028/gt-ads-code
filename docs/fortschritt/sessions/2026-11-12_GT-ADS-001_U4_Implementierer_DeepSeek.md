# GT-ADS-001 · U4 – Sitzungsprotokoll (Coding-Agent)

Datum: 2026-11-12
Unteraufgabe: U4 – Geraeteauthentifizierung
Branch: agent/U4
Akzeptanz: AC-07, AC-08 (Teil); Tests: I-13, I-14, I-15

## Umsetzung

- apps/api/src/modules/deviceAuth/repository.ts
  - laedt Geraet inkl. oeffentlichem SPKI-Schluessel und Zustand (auch mit
    Zeilensperre fuer die Token-Transaktion),
  - speichert Challenge-Nonce und Access-Token ausschliesslich als SHA-256-Hash,
  - verbraucht eine Challenge atomar (used_at is null und expires_at > jetzt),
  - laedt Token zusammen mit dem aktuellen Geraetezustand,
  - setzt last_seen_at auf Serverzeit.
- apps/api/src/modules/deviceAuth/service.ts
  - createChallenge: unbekanntes Geraet -> 401 unauthorized; gesperrt ->
    403 device_revoked; Nonce 32 Byte Base64url, TTL aus
    GT_ADS_CHALLENGE_TTL_S.
  - issueToken: Signaturpruefung ECDSA P-256/SHA-256 (DER) ueber
    "gt-ads-auth-v1\n<device_id>\n<nonce>", atomarer Nonce-Verbrauch,
    last_seen_at-Update und Token-Ausstellung in einer Transaktion;
    unbekannt/abgelaufen/benutzt/falsche Signatur -> 401 challenge_invalid;
    gesperrt -> 403 device_revoked.
  - authenticateToken: prueft bei jeder Anfrage Token-Hash, Ablauf,
    Token-Widerruf und Geraetezustand; gesperrtes Geraet -> 403
    device_revoked, sonst ungueltig/abgelaufen -> 401 unauthorized.
- apps/api/src/modules/deviceAuth/middleware.ts
  - PreHandler fuer geraeteauthentifizierte Folgerouten (Bearer-Token),
    setzt request.deviceAuth; Typ-Erweiterung fuer Fastify.
- apps/api/src/modules/deviceAuth/routes.ts
  - POST /v1/device/auth/challenge und POST /v1/device/auth/token gem.
    API-VERTRAG.md Abschnitt 3; X-GT-ADS-Api-Version: 1 ist Pflicht,
    unbekannte Felder -> invalid_request.
- apps/api/src/http/server.ts
  - registriert DeviceAuthService und die beiden Routen; stellt den Service
    als app.deviceAuthService fuer U5 (Heartbeat) bereit.
- apps/api/tests/integration/deviceAuth.test.ts
  - I-13: Challenge -> Token; Token authentifiziert eine Folgeroute ueber die
    Produktions-Middleware; last_seen_at wird auf Serverzeit gesetzt; Nonce
    liegt nur als Hash in der DB.
  - I-14: falsche Signatur, wiederverwendete Nonce und abgelaufene Nonce
    (Uhr +61 s) ergeben 401 challenge_invalid.
  - I-15: abgelaufenes Token (Uhr +TTL+1), fehlendes Token, zufaelliges Token
    und falsches Authorization-Schema ergeben 401 unauthorized.
  - AC-08 (Teil): direktes Sperren des Geraets macht ein bestehendes Token
    sofort ungueltig (403 device_revoked); neue Challenge ebenfalls 403.
  - Zusatz: unbekanntes Geraet bei der Challenge -> 401 unauthorized.

## Tests (echte Ausgabe)

Befehl (Wurzel): with-postgres sh -c "npm run -s typecheck && npm test -s"

    RUN  v5.1.0 /workspace/apps/api

     ✓ tests/static/u0-scaffold.test.ts (10 tests) 79ms
     ✓ tests/unit/deviceSignature.test.ts (9 tests) 64ms
     ✓ tests/integration/deviceAuth.test.ts (5 tests) 492ms
     ✓ tests/unit/registrationCode.test.ts (13 tests) 272ms
     ✓ tests/integration/registration.test.ts (13 tests) 873ms
     ✓ tests/unit/config.test.ts (11 tests) 89ms
     ✓ tests/unit/logging.test.ts (10 tests) 13ms
     ✓ tests/unit/tokens.test.ts (7 tests) 49ms
     ✓ tests/unit/rateLimit.test.ts (5 tests) 11ms
     ✓ tests/db/migrate.test.ts (3 tests) 143ms
     ✓ tests/db/createDump.test.ts (4 tests) 2136ms
     ✓ tests/unit/password.test.ts (6 tests) 932ms
     ✓ tests/db/verifyRestore.test.ts (4 tests) 6107ms

     Test Files  13 passed (13)
          Tests  100 passed (100)

    RUN  v5.1.0 /workspace/apps/dashboard

     ✓ src/tests/app.test.tsx (1 test) 114ms

     Test Files  1 passed (1)
          Tests  1 passed (1)

Ergebnis: Exit-Code 0; Typecheck ohne Fehler; 101 Tests bestanden,
0 fehlgeschlagen, 0 uebersprungen.

Zusaetzlich isoliert ausgefuehrt:
with-postgres npx vitest run tests/integration/deviceAuth.test.ts
-> Test Files 1 passed (1), Tests 5 passed (5).

## Entscheidungen / Annahmen

- I-13 verlangt "Token funktioniert fuer Heartbeat". Der Heartbeat-Endpunkt
  gehoert zu U5. Der Test registriert deshalb eine Probe-Route, die dieselbe
  Produktions-Middleware (createDeviceAuthMiddleware) verwendet; damit ist die
  Token-Gueltigkeit fuer geraeteauthentifizierte Folgerouten belegt.
- Token- und Nonce-Hashes verwenden die vorhandene Funktion hashToken/hashNonce
  (SHA-256) aus U2.
- Ein unbekanntes Geraet beim Token-Endpunkt liefert 401 challenge_invalid
  (keine Unterscheidung zu unbekannter Nonce); die Challenge liefert dagegen
  gemaess Vertrag 401 unauthorized.
- Die Geraetesperre prueft authenticateToken vor dem Token-Ablauf, damit die
  Sperre sofort sichtbar wird (AC-08).
- Formatfehler (fehlende/falsch typisierte Felder, unbekannte Felder) ergeben
  invalid_request; inhaltlich ungueltige Nonce/Signatur challenge_invalid.

## Offene Punkte / Fragen

- Keine blockierenden Fragen. Die Bereinigung abgelaufener Challenges/Tokens
  (I-26) sowie der Heartbeat-Endpunkt folgen in U5.
- Keine Secrets, keine echten Geraetekennungen; Testdaten sind synthetisch.
