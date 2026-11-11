# GT-ADS-001 – Testplan

Status: Entwurf zur Freigabe · Stand: 2026-11-09 · Zugehörig: [SPEZIFIKATION.md](SPEZIFIKATION.md) (AC-01…AC-20), [API-VERTRAG.md](API-VERTRAG.md), `docs/prozess/DEFINITION_OF_DONE.md`, `docs/prozess/DATENTRENNUNG.md`
Regeln: Testdaten **ausschließlich synthetisch** (`SYN-…`); keine echten Gerätekennungen im Repo; Tests nie abschwächen oder überspringen; im PR die **echte Ausgabe** belegen; nicht ausgeführte Tests als „nicht ausgeführt" melden. Testwerkzeuge (Vitest, Testing Library, JUnit, MockWebServer) sind **technische Vorschläge** unter dem Vorbehalt E47.

## 1. Teststufen
| Stufe | Was | Wo | Wer |
|---|---|---|---|
| T1 Unit | reine Logik (Codes, Signatur, Statusableitung, Normalisierung) | Backend/Dashboard/Android (JVM) | DeepSeek |
| T2 Integration | API gegen **echte** PostgreSQL-Testinstanz (Docker), Migrationen | Backend | DeepSeek |
| T3 Contract | Beispiele und Antworten gegen JSON Schema; Server **und** App-Client gegen dieselben Beispiele | contracts/ + Backend + Android | DeepSeek |
| T4 Komponenten/UI | Dashboard-Seiten und -Dialoge | Dashboard | DeepSeek |
| T5 Instrumentiert | Keystore, Worker, App-Registrierung gegen Testserver | Android-Gerät/Emulator | DeepSeek/Betreiber |
| T6 Manuell | Handytest Ende-zu-Ende | Betreiber-Handy | Betreiber (Claude führt an) |
| T7 Statisch | Lint, Typen, Secret-Scan, Manifest/Permission-Prüfung | Repo | DeepSeek/CI später |
Umgebung: `GT_ADS_ENV=test`, eigene Datenbank `gt_ads_test`, pro Lauf neu angelegt und gelöscht; Zeit in Tests über injizierbare Uhr (keine echten Wartezeiten).

## 2. Backend – Unit (T1)
| ID | Test | Erwartung (AC) |
|---|---|---|
| U-01 | Code-Generator: Länge 12, nur Alphabet, 1.000 Codes ohne Kollision, CSPRNG-Quelle | AC-04 |
| U-02 | Normalisierung: `abcd-efgh-jkmn`, Leerzeichen, `O→0`, `I/L→1`, ungültige Zeichen → ungültig | AC-03 |
| U-03 | HMAC deterministisch je Pepper; anderer Pepper → anderer Hash; Klartext nie im Ergebnis | AC-05 |
| U-04 | Signaturprüfung: gültige ECDSA-P-256-Signatur (aus Test-Schlüsselpaar), falsche Nachricht, falscher Schlüssel, falsches Format, andere Kurve → abgelehnt | AC-07 |
| U-05 | Signaturnachricht-Aufbau exakt `gt-ads-auth-v1\n<id>\n<nonce>` ohne Schlusszeilenumbruch | Vertrag §3 |
| U-06 | Statusableitung `connectivity`: Grenzwerte (Schwelle−1 s, Schwelle, Schwelle+1 s), Uhr vor/nach Sommerzeitwechsel | AC-10 |
| U-07 | Config-Guard: `GT_ADS_ENV` fehlt/`prod`/`foo` → Start verweigert; `dev`,`test` ok; fehlendes Pepper/Hash → verweigert; Bind-Standard `127.0.0.1` | AC-14, AC-20 |
| U-08 | Passwort-Hash (scrypt): richtig/falsch, zeitkonstanter Vergleich, ungültiges Hashformat → Start verweigert | AC-12 |
| U-09 | Rate-Limiter: Fenster, Zähler, `Retry-After`, Zeitablauf | AC-04 |
| U-10 | Log-Redaktion: Felder `registration_code`, `signature`, `public_key`, `password`, Header `Authorization`/`Cookie` nie im Logstring | AC-05 |

## 3. Backend – Integration (T2) gegen echte PostgreSQL
| ID | Szenario | Erwartung |
|---|---|---|
| I-01 | Migration `0001` hoch → Schema vorhanden; runter → leer; erneut hoch | AC-18 |
| I-02 | Down-Migration mit `GT_ADS_ENV=prod` verweigert | AC-14/18 |
| I-03 | Admin erzeugt Code → DB enthält nur Hash, kein Klartext (Tabellenscan nach Code-String) | AC-05 |
| I-04 | Registrierung Erfolgsfall → 201, Gerät `active`, Code `used`, Audit-Eintrag | AC-01 |
| I-05 | Zweite Registrierung mit gleichem Code und anderem Schlüssel → 400 `invalid_registration_code` | AC-02 |
| I-06 | **Race:** 10 parallele Registrierungen mit demselben Code (verschiedene Schlüssel) → genau **1** × 201, 9 × 400, genau 1 Gerät | AC-02 |
| I-07 | Idempotenz: gleiche Wiederholung (Code, `client_request_id`, Schlüssel) → 201 mit gleicher `device_id`, kein zweites Gerät | AC-02 |
| I-08 | Abgelaufen / widerrufen / unbekannt / benutzt → **bytegleiche** Fehlerantwort (außer `request_id`) | AC-03 |
| I-09 | `app_env` ≠ Server-Env → 409, Code **nicht** verbraucht | AC-15 |
| I-10 | Gleicher öffentlicher Schlüssel zweimal → 409 `key_already_registered` | Vertrag §2 |
| I-11 | Ungültiger Schlüssel (kein EC / andere Kurve / kein Base64) → 400 `invalid_request` | Vertrag §2 |
| I-12 | Rate-Limit: 6. Fehlversuch → 429 mit `Retry-After`; danach auch gültiger Code in der Sperrzeit → 429 (global/pro Quelle laut Konfig) | AC-04 |
| I-13 | Challenge → Token Erfolgsfall; Token funktioniert für Heartbeat | AC-07 |
| I-14 | Falsche Signatur → 401 `challenge_invalid`; Nonce wiederverwendet → 401; Nonce abgelaufen (Uhr +61 s) → 401 | AC-07 |
| I-15 | Token abgelaufen (Uhr +TTL+1) → 401; ohne Token/mit zufälligem Token → 401 | AC-07 |
| I-16 | Heartbeat setzt `last_seen_at` = Serverzeit, unabhängig von `device_time` (Gerätezeit +1 Jahr/−1 Jahr); `last_clock_offset_ms` gesetzt | AC-09 |
| I-17 | `seq` kleiner/gleich bisher → 200, `last_seq` nicht zurückgesetzt | AC-09 |
| I-18 | Gerät sperren → vorhandenes Token sofort 403 `device_revoked`; neue Challenge 403; Liste zeigt `revoked` | AC-08 |
| I-19 | Admin-Endpunkte ohne Sitzung → 401; mit Sitzung ok; Logout invalidiert; Sitzung abgelaufen → 401 | AC-12 |
| I-20 | CSRF: `Origin` fremd bei POST/DELETE → 403; falscher Content-Type → 403 | Vertrag §5 |
| I-21 | Admin-Login: falsches Passwort → generisches 401; 6. Fehlversuch → 429 | AC-04 |
| I-22 | Audit: Einträge für Code erzeugt/widerrufen/benutzt, Gerät registriert/gesperrt, Login ok/fehl; `details` ohne Geheimnisse (Scan nach Code/Token/Nonce/Signatur) | AC-13 |
| I-23 | Geräteliste: leer → `items: []`; nach Registrierung 1 Eintrag; `connectivity` reachable/last_seen je Schwelle; Sortierung | AC-10, AC-12 |
| I-24 | Server-Logs eines Gesamtlaufs enthalten kein Code-/Token-/Signatur-/Passwort-Muster | AC-05 |
| I-25 | Bindung: Server lauscht nur auf `127.0.0.1` (Socket-Prüfung) | AC-20 |
| I-26 | Bereinigung löscht abgelaufene Challenges/Tokens/Sessions, lässt Codes/Geräte/Audit | ARCHITEKTUR §3 |

## 4. Contract (T3), Dashboard (T4), Android (T5), Statik (T7)
**Contract:** alle Beispiele in `contracts/gt-ads-001/examples/` validieren gegen Schemas (gültige bestehen, ungültige scheitern); reale Antworten aus I-04, I-13, I-16, I-23 validieren gegen Response-Schemas; Fehlerantworten gegen Fehler-Schema; OpenAPI-Datei syntaktisch gültig; Android-`ApiClient` deserialisiert dieselben Beispiele (C-01..C-04).
**Dashboard (T4):**
| ID | Test | AC |
|---|---|---|
| D-01 | Login-Fehler zeigt generische Meldung, keine Passwort-Reflektion | AC-12 |
| D-02 | Leere Liste zeigt „Noch keine Geräte registriert." und **keine** Demo-/Platzhalterzeilen | AC-12, AC-16 |
| D-03 | Gerät mit `reachable` → „Erreichbar"; `last_seen` → „Zuletzt gesehen"; Zeitformat `Europe/Vienna`; **nie** die Wörter „offline", „defekt", „ausgeschaltet" im Gerätestatus (Textscan) | AC-10 |
| D-04 | Code erzeugen zeigt Code einmal + Ablauf; nach Schließen nicht mehr sichtbar; Liste ohne Klartext | AC-05, AC-12 |
| D-05 | Sperren verlangt Bestätigung; Abbruch ändert nichts; Bestätigung ruft `revoke` genau einmal | AC-12 |
| D-06 | Auto-Refresh alle 30 s (Fake-Timer); Fehler beim Refresh zeigt Hinweis, behält letzte Daten | AC-12 |
| D-07 | Labels mit `<script>`/HTML werden als Text dargestellt | Sicherheit |
**Android (JVM/Instrumentiert):**
| ID | Test | AC |
|---|---|---|
| A-01 | `SignatureMessage` baut exakt die Vertragsnachricht (gleicher Wert wie U-05) | Vertrag §3 |
| A-02 | `ApiClient` gegen MockWebServer mit Vertragsbeispielen: 201/200 Erfolgsfälle, jede Fehlerklasse → richtiger `ApiError`, Netzfehler/Timeouts → `NetworkError` | AC-11 |
| A-03 | `AuthManager`: Token nur im Speicher; 401 → genau ein Erneuerungsversuch | AC-07 |
| A-04 | `RegistrationUseCase`: Erfolg speichert `device_id`; `invalid_registration_code`, `rate_limited`, `environment_mismatch` → passende UI-Zustände; Netzfehler ändert nichts am lokalen Zustand | AC-01, AC-11 |
| A-05 | `HeartbeatUseCase`: `seq` steigt und wird persistiert; `device_revoked` → Zustand `GESPERRT`, Scheduler gestoppt | AC-08 |
| A-06 | `HeartbeatScheduler`: periodisch ≥ 15 min, Constraint `CONNECTED`, Backoff (WorkManager-Testbibliothek) | AC-11 |
| A-07 (instr.) | Keystore: Schlüssel erzeugt, `getEncoded` des privaten Schlüssels nicht verfügbar, Signatur vom Server-Algorithmus verifizierbar (Test-Verifikation mit öffentlichem Schlüssel) | AC-06 |
| A-08 (instr.) | Neu-Registrierung nach `GESPERRT` und Debug-„Registrierung zurücksetzen" löschen alten Schlüssel (Alias) und lokalen Zustand | AC-08 |
| A-09 | Manifest-Prüfung (Lint/Test): **nur** `INTERNET`-Permission; `allowBackup=false`; Release ohne Klartext; Debug-Konfig erlaubt nur `127.0.0.1`/`localhost` | AC-17 |
| A-10 | Release-Build mit `http://`-URL bricht ab | AC-17 |
**Statik:** Lint/Format/Typprüfung ohne Fehler; Secret-Scan (keine Pepper/Passwörter/Tokens/Schlüssel im Repo, `.env.example` ohne Werte); Check „kein `latest`-Image-Tag"; Compose-Check „nur `127.0.0.1:8080` veröffentlicht, DB ohne Port"; Textscan Repo auf nicht-synthetische Kennungen (Muster `SYN-` Pflicht in Testdaten).

## 5. Pflichtbelege im PR
Befehl + vollständige Ausgabe je Teststufe (T1–T4, T7 sowie T5 soweit ausführbar), Anzahl bestanden/fehlgeschlagen/übersprungen (Übersprungene = Begründung, **Blocker**), Abdeckung nur zur Orientierung, Tabelle AC-01…AC-20 mit Verweis auf den belegenden Test.

## 6. Manueller Testablauf auf dem Handy des Betreibers (T6)
**Zweck:** Ende-zu-Ende-Beweis auf echter Hardware, ohne öffentlichen Port. Claude führt Schritt für Schritt an; Ergebnisse trägt der Betreiber ein (Vorlage am Ende).
### 6.1 Voraussetzungen (vor Testbeginn)
1. Entscheidungen E50, E51, E54, E56 getroffen; Handy-Modell/Android-Version bekannt (E54).
2. PC mit Android Studio (oder anderem Build-Weg laut E56), USB-Kabel, auf dem Handy **Entwickleroptionen + USB-Debugging** aktiv, `adb` funktioniert (`adb devices` zeigt das Handy).
3. Testbackend läuft (Variante **T**: Dev-Stack auf dem VPS durch den Betreiber gestartet; auf dem PC `ssh -N -L 8080:127.0.0.1:8080 taxiwerbung`; Variante **L**: lokal). Browser: `http://127.0.0.1:8080`.
4. `adb reverse tcp:8080 tcp:8080` ausgeführt.
5. Debug-APK (`dev`) installiert; Server-Test-Konfiguration für Schwellen (nur Testwerte): `GT_ADS_REG_CODE_TTL_S=120`, `GT_ADS_ONLINE_THRESHOLD_S=120`, `GT_ADS_REG_MAX_FAILS_WINDOW_S=60` (damit die Sperre aus M-08 nach 60 s endet und M-15 nicht blockiert; Server danach neu starten).
6. Dashboard-Login mit dem Pilot-Admin-Passwort (liegt nur beim Betreiber, nie im Chat oder Repo).
### 6.2 Ablauf
| Nr. | Schritt | Erwartung | AC |
|---|---|---|---|
| M-01 | `GET /health` im Browser (`/health`) | `status: ok`, `env: dev` | AC-14 |
| M-02 | Dashboard öffnen, Login | Geräteliste leer: „Noch keine Geräte registriert." | AC-12, AC-16 |
| M-03 | „Registrierungscode erzeugen" (Label z. B. `SYN-Testhandy`) | Code angezeigt, Countdown läuft; Fenster schließen → Code nicht mehr abrufbar | AC-05 |
| M-04 | App öffnen → Code eingeben | „Registriert", Geräte-ID gekürzt, letzter Kontakt „gerade eben" | AC-01 |
| M-05 | Dashboard nach ≤ 30 s | Gerät sichtbar: Modell, Android-Version, App-Version, **Erreichbar**, Kontaktzeit stimmt mit Uhr (Europe/Vienna) | AC-01, AC-10 |
| M-06 | Im Debug-Menü „Registrierung zurücksetzen" wählen, **denselben** (benutzten) Code erneut eingeben | Fehler „Code ungültig oder abgelaufen"; Dashboard zeigt weiterhin nur das erste Gerät | AC-02 |
| M-07 | Neuen Code erzeugen, **120 s warten**, dann eingeben | gleiche Fehlermeldung wie M-06 | AC-03 |
| M-08 | 6 × falschen Code eingeben | nach Fehlversuchsgrenze Hinweis „zu viele Versuche, später erneut"; danach **60 s warten** (Sperre endet) | AC-04 |
| M-09 | **Flugmodus** am Handy an, App geöffnet lassen, „Jetzt senden" (Debug) drücken | App: Hinweis „Keine Verbindung", Absturz? **nein**; letzter Erfolg bleibt angezeigt | AC-11 |
| M-10 | > 120 s warten, Dashboard prüfen | Status **Zuletzt gesehen** (nicht „offline/defekt"), Zeit = letzter Kontakt; Tooltip vorhanden | AC-10 |
| M-11 | Flugmodus aus, „Jetzt senden" | Dashboard (≤ 30 s) wieder **Erreichbar** | AC-11 |
| M-12 | App im Task-Manager beenden, wieder öffnen | sofortiger Heartbeat, Zustand weiter „Registriert" (kein erneuter Code nötig) | AC-07 |
| M-13 | Handy-Uhrzeit um +1 h verstellen, „Jetzt senden"; Dashboard prüfen; Uhr zurückstellen | Letzter Kontakt im Dashboard bleibt **Serverzeit** | AC-09 |
| M-14 | Im Dashboard **Sperren** (Bestätigen) | Dashboard „Gesperrt"; App nach nächstem Senden: „Gerät gesperrt" | AC-08 |
| M-15 | App: „Neu registrieren" mit **neuem** Code | Zweites Geräteeintrag (neue ID), erster bleibt „Gesperrt" | AC-08 |
| M-16 | Prüfen: App-Berechtigungen in Android-Einstellungen | nur Internet; keine Standort-/Kamera-/Mikrofon-Berechtigung | AC-17 |
| M-17 | Port-Kontrolle auf dem VPS (Betreiber): `ss -tlnp` | **kein** neuer öffentlicher Port; `8080` nur auf `127.0.0.1` | AC-20 |
| M-18 | Aufräumen: Dev-Stack stoppen; Testdaten löschen (`docker compose down -v`) | keine Daten bleiben; Repo enthält keine Gerätedaten | AC-16 |
### 6.3 Ergebnisprotokoll (Vorlage; vom Betreiber auszufüllen, **keine** Geheimnisse eintragen)
```
Datum:  Handy-Modell/Android:  App-Version/Build:  Variante (T/L):
M-01 ok/nok Bemerkung | M-02 … | … | M-18
Auffälligkeiten (Screenshots ohne Codes/Tokens):
```

## 7. Abnahme
Reihenfolge: T1–T4/T7 grün (Beleg im PR) → Review → Betreiber-Handytest (T6) → Betreiber merged. Fehlerhafte oder nicht ausführbare Tests blockieren **Done**.
