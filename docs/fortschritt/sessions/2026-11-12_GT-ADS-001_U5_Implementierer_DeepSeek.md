# GT-ADS-001 · U5 – Sitzungsprotokoll (Coding-Agent)

Datum: 2026-11-12
Unteraufgabe: U5 – Heartbeat und Status
Branch: agent/U5
Akzeptanz: AC-09, AC-10; Tests: U-06, I-16, I-17, I-23

## Umsetzung

- apps/api/src/modules/heartbeat/repository.ts
  - aktualisiert `last_seen_at` ausschliesslich auf die uebergebene
    Serverzeit und schreibt `last_clock_offset_ms` (Server - Geraet),
  - `last_seq = greatest(last_seq, $seq)`, damit ein kleineres oder gleiches
    `seq` nichts zurueckdreht (I-17),
  - Update nur bei `state = 'active'`; damit wirkt eine gleichzeitige Sperre
    auch zwischen Token-Pruefung und Update (AC-08).
- apps/api/src/modules/heartbeat/service.ts
  - Heartbeat-Ablauf: Serverzeit bestimmen, Offset als BigInt berechnen,
    Update ausfuehren; keine Zeile -> Zustand nachladen und 403
    `device_revoked` bzw. 401 `unauthorized` liefern.
- apps/api/src/modules/heartbeat/routes.ts
  - POST /v1/device/heartbeat gemaess API-VERTRAG.md Abschnitt 4:
    Bearer-Token ueber die U4-Middleware, Pflichtheader
    `X-GT-Ads-Api-Version: 1`, exakt die Felder `seq`, `device_time`,
    `app_version`, `os_version` (unbekannte Felder -> invalid_request),
    Antwort `server_time`, `device_state`, `config.heartbeat_interval_s`.
- apps/api/src/modules/devices/status.ts
  - reine Funktion `deriveConnectivity`: `reachable` genau dann, wenn
    `serverTime - lastSeenAt <= T_online` (Grenzfall gleich = erreichbar);
    nur absolute Zeitpunkte, daher unabhaengig von Sommer-/Winterzeit.
- apps/api/src/modules/devices/repository.ts
  - Geraeteliste ohne oeffentlichen Schluessel, sortiert nach
    `last_seen_at` absteigend, Obergrenze 500 mit `truncated`-Erkennung.
- apps/api/src/modules/devices/service.ts
  - `DevicesService.listDevices`: Serverzeit + `online_threshold_s` +
    Items mit zur Lesezeit berechnetem `connectivity` (Grundlage fuer die
    Admin-Route in U6, noch ohne HTTP-Route/Admin-Session).
- apps/api/src/http/server.ts
  - registriert HeartbeatService und die Heartbeat-Route mit derselben
    Geraeteauthentifizierung wie U4.
- Tests
  - tests/unit/deviceStatus.test.ts (U-06): Schwellen -1 s/gleich/+1 s,
    Sommer- und Winterzeitwechsel in Europe/Vienna, Serverzeit vor
    `last_seen_at`, ungueltige Schwelle.
  - tests/integration/heartbeat.test.ts (I-16, I-17): Geraeteuhr +1 Jahr
    und -1 Jahr aendern `last_seen_at` nicht (Serverzeit), Offset wird
    gesetzt; `seq` gleich/kleiner laesst `last_seq` unveraendert, setzt
    aber `last_seen_at`; fehlendes/gesperrtes Token 401/403;
    Formatfehler 400 ohne Statusaenderung.
  - tests/integration/devicesList.test.ts (I-23): leere Liste, ein Eintrag
    mit Vertragsfeldern, Schwelle gleich/+1 ms, Sortierung nach
    `last_seen_at`, gesperrtes Geraet bleibt mit `state=revoked` sichtbar.

## Tests (echte Ausgabe)

Befehl (Wurzel): with-postgres sh -c "npm run -s typecheck && npm test -s"

    ✓ tests/integration/deviceAuth.test.ts (5 tests)
    ✓ tests/integration/registration.test.ts (13 tests)
    ✓ tests/integration/heartbeat.test.ts (4 tests)
    ✓ tests/integration/devicesList.test.ts (5 tests)
    ✓ tests/unit/deviceStatus.test.ts (4 tests)
    ✓ tests/unit/config.test.ts (11 tests)
    ✓ tests/unit/tokens.test.ts (7 tests)
    ✓ tests/unit/deviceSignature.test.ts (9 tests)
    ✓ tests/unit/registrationCode.test.ts (13 tests)
    ✓ tests/unit/logging.test.ts (10 tests)
    ✓ tests/unit/rateLimit.test.ts (5 tests)
    ✓ tests/unit/password.test.ts (6 tests)
    ✓ tests/db/migrate.test.ts (3 tests)
    ✓ tests/db/createDump.test.ts (4 tests)
    ✓ tests/db/verifyRestore.test.ts (4 tests)
    ✓ tests/static/u0-scaffold.test.ts (10 tests)

    Test Files  16 passed (16)
         Tests  113 passed (113)

    RUN  v5.1.0 /workspace/apps/dashboard

    ✓ src/tests/app.test.tsx (1 test)
    Test Files  1 passed (1)
         Tests  1 passed (1)

Ergebnis: Exit-Code 0; Typecheck ohne Fehler; 114 Tests bestanden,
0 fehlgeschlagen, 0 uebersprungen.

Zusaetzlich isoliert ausgefuehrt:
- with-postgres npx vitest run tests/integration/heartbeat.test.ts
  tests/unit/deviceStatus.test.ts -> 2 Dateien, 8 Tests bestanden.
- with-postgres npx vitest run tests/integration/devicesList.test.ts
  -> 1 Datei, 5 Tests bestanden.

## Entscheidungen / Annahmen

- I-23 wird auf Service-Ebene geprueft (DevicesService.listDevices), weil
  die Admin-Session und die HTTP-Route /v1/admin/devices erst in U6
  entstehen. Der Service liefert bereits die Vertragswerte (Serverzeit,
  Schwelle, Items mit `connectivity`); U6 ergaenzt nur Route und
  Serialisierung.
- `device_time` wird strikt als ISO-8601 UTC mit Millisekunden und `Z`
  validiert (API-VERTRAG.md Abschnitt 1); abweichende Formate ergeben
  `invalid_request`.
- `app_version` und `os_version` sind Pflichtfelder des Heartbeats und
  werden validiert, aber nicht gespeichert (Datensparsamkeit; der Vertrag
  verlangt kein Update der Geraetestammdaten).
- Der Grenzfall `serverTime - lastSeenAt == T_online` gilt als
  `reachable` (API-VERTRAG.md Abschnitt 5).

## Offene Punkte / Fragen

- Keine blockierenden Fragen.
- `truncated: true` bei mehr als 500 Geraeten ist im Service umgesetzt,
  aber noch nicht ueber HTTP sichtbar (U6).
- Keine Secrets, keine echten Geraetekennungen; Testdaten sind synthetisch.
