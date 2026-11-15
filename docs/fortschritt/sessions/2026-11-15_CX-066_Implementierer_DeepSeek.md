# Sitzungsprotokoll CX-066 (R-605) – Wiederherstellung im MFA-Anmeldefluss

- Datum: 2026-11-15
- Branch: agent/CX-066
- Rolle: Coding-Agent (DeepSeek)
- Arbeitspaket: CX-066 v1 – HTTP-Integration des Wiederherstellungskerns aus CX-065

## Auftrag (Kurzfassung)

POST /v1/admin/auth/recovery/verify und POST /v1/admin/auth/recovery-codes im
bestehenden MFA-Kontext registrieren: Wiederherstellungscode ersetzt nur den
zweiten Faktor, Codesatz-Ausgabe nur mit vollstaendiger Admin-Sitzung und
frischem, replaygeschuetztem TOTP-Code. Code, Challenge, Sitzung und Audit
gemeinsam committen; Cookie erst nach Commit; no-store; generische Fehler;
bestehende Limits und Zugriffspolitik; keine Pfadpraefix-Ausnahmen.

## Umsetzung (Fakt)

- Neu: apps/api/src/modules/adminAuth/recoveryRoutes.ts
  - registerAdminMfaRecoveryRoutes() registriert beide Routen ueber den
    bestehenden registerJsonRoute-Baustein (geschlossene Schemata).
  - Beide Routen laufen unter der bestehenden Zugriffspolitik
    POST ... = human("security.manage") (nur Admin) plus vorhandener
    Origin-/Content-Type-Pruefung (requireAdminWrite) und
    Sitzungspruefung (createAdminSessionMiddleware).
  - verify: Vorsitzung wird per select ... for update gesperrt, genau eine
    Challenge je Vorsitzung, Codeverbrauch ueber den CX-065-Kern
    (bedingter UPDATE), Challenge-Verbrauch, Loeschung der Vorsitzung,
    Einfuegung der rotierten Sitzung und Erfolgsaudit in einer Transaktion;
    Cookie erst nach Commit. Fehlversuche erhoehen failed_attempts und
    sperren nach der vorhandenen Grenze (registrationMaxFailsPerSource).
  - recovery-codes: TOTP-Pruefung gegen das vorhandene CX-106-Geheimnis
    (readForActor), Fortschreibung der Replay-Sperre ueber bedingten Upsert,
    Codesatz-Erzeugung/-Ersetzung und Audit in derselben Transaktion.
    Antwort genau einmal mit Cache-Control: no-store.
  - Fehlversuchszaehler: derselbe RateLimiter wie die Admin-Anmeldung, mit
    quellenbezogenem (request.ip) und kontobezogenem Schluessel; 429 mit
    Retry-After.
- Ergaenzt: recoveryCodes.ts (issueRecoveryCodeSetInTransaction, additive
  Wiederverwendung des Kerns), pendingTotpEnrollment.ts (readForActor),
  repository.ts (findAdminSessionByIdForUpdate, deleteAdminSessionById),
  accessPolicy.ts (zwei Katalogeintraege), server.ts (Redaktion von
  req.body.code/req.body.totp_code im Zugriffslog).
- Nicht geaendert: Vertragsdateien, bestehende Migrationen, bestehende
  Tabellen, andere Module.

## Tests (Fakt)

- Neu: apps/api/src/modules/adminAuth/recoveryRoutes.test.ts (vier Faelle,
  echte Fastify-Instanz, echte PostgreSQL-Datenbank, echte Cookies) plus
  Vitest-Bruecke apps/api/tests/db/cx066-recovery-http.test.ts (bestehender
  Aufbau wie CX-106/CX-065).
- Ausgefuehrt: with-postgres npx vitest run tests/db/cx066-recovery-http.test.ts
  -> 4/4 bestanden.
- Ausgefuehrt: with-postgres npx vitest run (apps/api) -> 83 Dateien,
  720 Tests bestanden.
- Ausgefuehrt: npm run typecheck (Wurzel, beide Workspaces) -> ohne Fehler.

## Annahmen

- Die "Admin-Passwort-Vorsitzung" ist die bestehende Sitzung aus
  POST /v1/admin/login; ein eigener MFA-Pre-Session-Endpunkt existiert im
  Bestand nicht.
- Die Challenge wird beim ersten Verifizierungsversuch materialisiert
  (genau eine je Vorsitzung). Ihre Lebensdauer ist durch die vorhandene
  MFA-Frist PENDING_TOTP_ENROLLMENT_TTL_MS (10 Minuten) und die
  Sitzungsablaufzeit begrenzt.
- Challenge- und Replay-Zustand liegen in zwei additiven, modul-eigenen
  Tabellen, die idempotent beim ersten Zugriff angelegt werden (Muster der
  vorhandenen ensure-Schema-Funktionen). Eine Migration war ausserhalb der
  erlaubten Pfade nicht moeglich.
- Die Sperrgrenze der Challenge entspricht registrationMaxFailsPerSource
  (vorhandener Wert 5).

## Offene Punkte / Blocker

1. Der TOTP-Zweig (CX-017) besitzt keine HTTP-Verifikationsroute und keinen
   persistierten "aktiven" TOTP-Zustand: totpSetup.ts legt nur eine
   ausstehende Einrichtung ab (admin_mfa_pending_totp_enrollments, 10 Min
   TTL), und registerAdminTotpSetupRoutes wird von server.ts nicht
   aufgerufen. Die Codesatz-Ausgabe prueft deshalb gegen dieses vorhandene
   ausstehende Geheimnis; ohne Aktivierung/Schluesselverwaltung ist nach
   Ablauf der Einrichtung keine frische TOTP-Pruefung mehr moeglich.
2. Keine Produktionsaktivierung: server.ts registriert die neuen Routen
   nicht. Eine Registrierung wuerde den bestehenden Audit-Abdeckungstest
   (apps/api/tests/integration/audit/audit-action-catalog.test.ts)
   brechen, weil AUDIT_WRITE_ROUTE_ACTIONS in
   apps/api/src/modules/audit/repository.ts (ausserhalb der erlaubten
   Pfade) keinen Eintrag hat.
3. Fuer die Aufnahme in die bestehende Vitest-Include-Konfiguration war eine
   Brueckendatei unter apps/api/tests/db/ noetig (ausserhalb der erlaubten
   Pfade, gleiches Muster wie tests/db/cx106-pending-totp.test.ts).
4. Es gibt weiterhin keinen MFA-Pre-Session-Endpunkt; ein Wechsel zwischen
   TOTP- und Wiederherstellungspruefung innerhalb desselben Kontingents ist
   deshalb nur ueber die gemeinsame Sitzung und den gemeinsamen Zaehler
   abgebildet.
