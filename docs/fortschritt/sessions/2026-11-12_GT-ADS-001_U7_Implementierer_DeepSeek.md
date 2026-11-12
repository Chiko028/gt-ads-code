# GT-ADS-001 · U7 – Sitzungsprotokoll (Coding-Agent)

Datum: 2026-11-12
Unteraufgabe: U7 – Maschinenlesbarer Vertrag und Contract-Tests
Branch: agent/U7
Akzeptanz: Schemas/Beispiele vollstaendig und synthetisch; Server-Antworten validieren (TESTPLAN Abschnitt 4, T3)

## Umsetzung

- contracts/gt-ads-001/device-registration.openapi.yaml
  - OpenAPI 3.0.3 fuer /health, Geraete-Registrierung, Challenge, Token,
    Heartbeat sowie Admin-Login/-Logout, Code- und Geraeterouten;
    Sicherheits schemata (Bearer, Cookie) und Fehlerantworten inklusive
    Retry-After; validierende Schemas per relativem $ref auf schemas/.
- contracts/gt-ads-001/schemas/ (17 Dateien, JSON Schema Draft 2020-12)
  - je Request: register, challenge, token, heartbeat, admin-login,
    registration-code-create, device-revoke.
  - je Response: register 201, challenge 200, token 200, heartbeat 200,
    code-create 201, code-list 200, devices-list 200, device-detail 200,
    health 200 sowie das gemeinsame Fehlerformat.
  - Muster kodieren die Vertragsregeln: 12 Zeichen nach Normalisierung,
    Base64url 32 Byte, UUID, ISO-8601 UTC mit Millisekunden, feste Enums.
- contracts/gt-ads-001/examples/ (25 Dateien, synthetisch)
  - je Request mindestens ein gueltiges und ein ungueltiges Beispiel;
    zusaetzlich Beispielantworten fuer alle Response-Schemas.
  - Testschluessel/Nonce/Signatur wurden eigens erzeugt; nur der
    oeffentliche Schluessel ist eingebettet, kein privater Schluessel.
- contracts/gt-ads-001/README.md
  - Aufbau, Konventionen und die Auslegung der Code-Schreibweise.
- apps/api/tests/contract/contractFiles.ts
  - Pfadauflösung, Ajv-2020-12-Instanz, Zuordnung Schema -> Beispiele.
- apps/api/tests/contract/schemas.test.ts (11 Tests)
  - alle Schemas Draft 2020-12 und kompilierbar; jedes Request-Schema hat
    gueltige und ungueltige Beispiele; Beispiele bestehen/scheitern wie
    erwartet; Response-Beispiele gueltig; Fehlerschema streng; keine
    nicht zugeordneten Beispieldateien; OpenAPI 3.0.3 syntaktisch gueltig,
    alle Vertragspfade vorhanden, alle $ref-Dateien existieren.
- apps/api/tests/contract/serverResponses.test.ts (2 Tests)
  - echter Gesamtlauf (Health, Login, Code erzeugen/listen, Registrierung,
    Challenge, Token, Heartbeat, Geraeteliste, Detail, Sperre, Logout):
    jede Erfolgsantwort gegen ihr Response-Schema.
  - Fehlerfaelle (400 invalid_registration_code/invalid_request,
    401 unauthorized, 403 device_revoked, 404, Admin ohne Sitzung):
    jede Fehlerantwort gegen das Fehlerschema.

## Tests (echte Ausgabe)

Befehl (Wurzel): with-postgres sh -c \"npm run -s typecheck && npm test -s\"

    apps/api:      Test Files  19 passed (19)
                   Tests       134 passed (134)
    apps/dashboard: Test Files  1 passed (1)
                   Tests       1 passed (1)
    EXIT:0

Einzelbelege:

    tests/contract/schemas.test.ts (11 tests)  pass
    tests/contract/serverResponses.test.ts (2 tests)  pass

Die Ausgabe enthaelt nur die bereits bestehenden Fastify-Hinweise
FSTDEP023 (disableRequestLogging); keine Fehler, keine uebersprungenen Tests.

## Annahmen / offene Punkte

- Annahme [A]: Das Response-Schema fuer den Registrierungscode akzeptiert die
  kanonische 12-Zeichen-Form und die im Vertragsbeispiel gezeigte gruppierte
  Form XXXX-XXXX-XXXX. Der Server liefert derzeit die kanonische Form ohne
  Trennzeichen; der Vertragstext legt die Schreibweise nicht explizit fest.
  Keine Codeaenderung in U7; bei anderer Auslegung ist ein CR noetig.
- Keine offenen Fragen, die U7 blockieren.
