# GT-ADS-001 · U2 – Sitzungsprotokoll (Coding-Agent)

Datum: 2026-11-11
Unteraufgabe: U2 – Krypto und Konfiguration
Branch: agent/U2

## Umsetzung

- apps/api/src/config.ts: loadConfig liest und validiert die Umgebung.
  GT_ADS_ENV muss dev oder test sein (fehlt/prod/staging/andere -> ConfigError);
  GT_ADS_CODE_PEPPER, GT_ADS_ADMIN_PASSWORD_HASH und GT_ADS_DB_URL sind Pflicht;
  der Passwort-Hash wird auf Format geprueft. Standardwerte aus
  SPEZIFIKATION.md Abschnitt 7. Bind-Standard 127.0.0.1, Port 8080.
  Fehlermeldungen nennen nur Variablennamen, nie Werte.
  isPubliclyReachableBind kennzeichnet nicht-lokale Bind-Adressen (AC-20).
- apps/api/src/crypto/registrationCode.ts: CSPRNG-Generator (Alphabet
  0123456789ABCDEFGHJKMNPQRSTVWXYZ, Standard 12), Normalisierung
  (Grossschreibung, Bindestriche/Leerzeichen weg, O->0, I/L->1),
  HMAC-SHA-256 mit Pepper, zeitkonstanter Vergleich, Anzeigeformat
  XXXX-XXXX-XXXX.
- apps/api/src/crypto/tokens.ts: 32-Byte-Tokens/Nonces als Base64url ohne
  Padding, SHA-256-Hash fuer die Speicherung, strenge Base64url-Dekodierung,
  zeitkonstanter Vergleich.
- apps/api/src/crypto/deviceSignature.ts: SPKI-DER-Parsing mit Pruefung auf
  EC und Kurve prime256v1, Signaturnachricht exakt
  "gt-ads-auth-v1\n<device_id>\n<nonce>" ohne Schlussumbruch,
  ECDSA-P-256/SHA-256-Verifikation (DER), SHA-256-Fingerabdruck. Jeder Fehler
  fuehrt bei verifyDeviceSignature zu false (kein Wurf).
- apps/api/src/crypto/password.ts: scrypt-Hash im Format
  scrypt$N=16384,r=8,p=1$<salt>$<hash> (Base64url), 16-Byte-Salt, 32-Byte-Hash,
  zeitkonstanter Vergleich; Formatpruefung fuer den Start-Guard.
- apps/api/scripts/hash-password.ts: CLI erzeugt GT_ADS_ADMIN_PASSWORD_HASH.
  Passwort nur ueber stdin (TTY verdeckt), nie als Argument; Ausgabe nur der
  Hash auf stdout, Hinweis auf stderr. Skript in tsconfig aufgenommen,
  npm-Skript "hash-password" (tsx).
- apps/api/src/http/logging.ts: Redaktion fuer Logs. Felder registration_code,
  password, public_key, signature, nonce, access_token/token, Pepper/Hash und
  Header Authorization/Cookie/Set-Cookie werden ersetzt; "code" wird nur bei
  gueltigem Registrierungscode redigiert, Fehlercodes bleiben lesbar. Zyklen,
  Tiefe, Fehlerobjekte und Query-Parameter werden behandelt.
- apps/api/src/http/rateLimit.ts: In-Memory-Fensterzähler (max, windowMs,
  injizierbare Uhr), hit/peek/reset, Retry-After in Sekunden.
- Tests: apps/api/tests/unit/{registrationCode,deviceSignature,password,config,
  rateLimit,logging}.test.ts.

## Tests (echte Ausgabe)

Befehl: with-postgres sh -c "npm run -s typecheck && npm test -s"

    RUN  v5.1.0 /workspace/apps/api

     ✓ tests/unit/config.test.ts (11 tests) 107ms
     ✓ tests/unit/deviceSignature.test.ts (9 tests) 144ms
     ✓ tests/db/migrate.test.ts (3 tests) 150ms
     ✓ tests/unit/registrationCode.test.ts (13 tests) 265ms
     ✓ tests/unit/logging.test.ts (9 tests) 17ms
     ✓ tests/unit/rateLimit.test.ts (5 tests) 11ms
     ✓ tests/static/u0-scaffold.test.ts (7 tests) 32ms
     ✓ tests/unit/password.test.ts (6 tests) 921ms

     Test Files  8 passed (8)
          Tests  63 passed (63)

    RUN  v5.1.0 /workspace/apps/dashboard

     ✓ src/tests/app.test.tsx (1 test) 135ms

     Test Files  1 passed (1)
          Tests  1 passed (1)

Ergebnis: Exit-Code 0, Typecheck ohne Fehler, alle Tests bestanden.
Abgedeckt: U-01, U-02, U-03, U-04, U-05, U-07, U-08, U-09, U-10.
U-06 (Statusableitung) gehoert zu U5 und ist hier nicht enthalten.

## Entscheidungen / Annahmen

- scrypt-Format und Parameter sind nicht im Vertrag festgelegt; gewaehlt:
  scrypt$N=16384,r=8,p=1$salt$hash, Salt 16 Byte, Hash 32 Byte. Das Format ist
  im Modul dokumentiert und wird vom Start-Guard geprueft.
- config verlangt GT_ADS_DB_URL ohne Standardwert (wie db/client.ts); ohne
  Datenbank kann der Prozess nicht starten.
- rateLimit.ts wurde in U2 angelegt, weil TESTPLAN U-09 zu U2 zaehlt, obwohl
  DEEPSEEK-AUFTRAG die Datei unter U3 nennt. Die Datei ist innerhalb von
  apps/api/ und wird von U3 weiterverwendet.
- publicKeyFingerprint validiert den Schluessel (EC P-256), bevor gehasht wird.

## Offene Punkte / Fragen

- Q-U2-01: .env.example (nicht im Dateiumfang von U2) enthaelt kein
  GT_ADS_COOKIE_SECURE, obwohl API-VERTRAG Abschnitt 5 die Variable nennt.
  config liest sie optional mit Standard false. Soll .env.example in einer
  spaeteren Unteraufgabe ergaenzt werden?
- Keine weiteren offenen Fragen; keine Secrets im Diff.

## Nachpruefung 2026-11-12

Anlass: erneuter U2-Lauf im Runner. Der Stand aus 1afedf6 wurde geprueft und
um zwei Luecken ergaenzt; bestehende Tests wurden nicht geaendert oder
abgeschwaecht.

- apps/api/src/http/logging.ts: isSensitiveFieldName erkennt jetzt auch
  camelCase-/kebab-case-Schreibweisen (normalisierte Vergleichsform ohne
  Trennzeichen), z. B. registrationCode, publicKey, accessToken, sessionToken,
  codeHash, setCookie, adminPasswordHash. Damit werden diese Felder auch dann
  redigiert, wenn sie nicht in snake_case im Logobjekt stehen.
- apps/api/tests/unit/logging.test.ts: zusaetzlicher Test fuer camelCase- und
  kebab-case-Felder sowie die Header-Variante SetCookie.
- apps/api/tests/unit/tokens.test.ts (neu): Token-/Nonce-Erzeugung (32 Byte,
  Base64url ohne Padding, 200 eindeutige Werte), Laengengrenzen, SHA-256-Hash,
  kanonische Base64url-Dekodierung, Laengenpruefung und zeitkonstanter
  Vergleich.

### Tests (echte Ausgabe)

Befehl: with-postgres sh -c "npm run -s typecheck && npm test -s"

    RUN  v5.1.0 /workspace/apps/api

     ✓ tests/db/migrate.test.ts (3 tests) 311ms
     ✓ tests/unit/registrationCode.test.ts (13 tests) 397ms
     ✓ tests/unit/config.test.ts (11 tests) 119ms
     ✓ tests/unit/tokens.test.ts (7 tests) 98ms
     ✓ tests/unit/deviceSignature.test.ts (9 tests) 60ms
     ✓ tests/static/u0-scaffold.test.ts (10 tests) 67ms
     ✓ tests/unit/password.test.ts (6 tests) 1206ms
     ✓ tests/unit/logging.test.ts (10 tests) 15ms
     ✓ tests/unit/rateLimit.test.ts (5 tests) 11ms
     ✓ tests/db/createDump.test.ts (4 tests) 2196ms
     ✓ tests/db/verifyRestore.test.ts (4 tests) 6532ms

     Test Files  11 passed (11)
          Tests  82 passed (82)

    RUN  v5.1.0 /workspace/apps/dashboard

     ✓ src/tests/app.test.tsx (1 test) 130ms

     Test Files  1 passed (1)
          Tests  1 passed (1)

Ergebnis: Exit-Code 0, Typecheck ohne Fehler, 83 Tests bestanden, keine
uebersprungenen Tests. Abgedeckt bleiben U-01, U-02, U-03, U-04, U-05, U-07,
U-08, U-09, U-10; U-06 gehoert zu U5.

### Offene Punkte

- Q-U2-01 bleibt offen: .env.example liegt ausserhalb des erlaubten
  Dateiumfangs dieser Unteraufgabe und enthaelt kein GT_ADS_COOKIE_SECURE;
  config liest die Variable optional mit Standard false.
