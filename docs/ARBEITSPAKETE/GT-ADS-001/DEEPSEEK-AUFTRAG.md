# GT-ADS-001 – Implementierungsauftrag für DeepSeek

**Freigabestatus: AUSSTEHEND.** Du darfst **nicht** beginnen, bevor der Betreiber in `docs/fortschritt/STATUS.md` für GT-ADS-001 den Status **„Freigegeben"** gesetzt hat. Steht dort etwas anderes: **stoppen und nur melden**. Blocker B1–B6 (§2) sind **vorläufig übernommen (🟦)**; **B7 und B8 sind offen** und betreffen **nur U9 (Android)**: U0–U8 und U10 dürfen nach der Freigabe starten, **vor U9 stoppen und auf die Betreiberentscheidung zu B7/B8 warten**.
Dieses Dokument ist **ohne Chatkontext** verständlich. Alles Nötige steht hier oder in den verlinkten Dateien im Repository.

## 1. Projektkontext in 10 Zeilen
GT-Ads ist ein eigenes digitales Werbenetzwerk für Taxis in Wien (zwei Android-Tablets je Taxi, zentrales Dashboard, Offline-Wiedergabe). Das Projekt ist in der **Planungsphase**; dies ist das **erste Implementierungspaket** (Pilotversuch der KI-Entwicklungsorganisation). Ziel: Ein Android-**Smartphone** registriert sich sicher bei einem **Testbackend** und erscheint im Dashboard (siehe `SPEZIFIKATION.md`). Der Betreiber ist die einzige Person, die freigibt und mergt. Server: Contabo-VPS, aber **du arbeitest nie auf dem Server** und **nie mit Produktivdaten**; es gibt keine Produktion. Alle Testdaten sind synthetisch.

## 2. Voraussetzungen (Blocker)
Stand 2026-11-09: B1–B6 vorläufig übernommen (🟦, siehe `docs/entscheidungen/OFFENE_ENTSCHEIDUNGEN.md`, Protokoll-Ergänzung); B7/B8 offen bis zum Gerätetest. **B1/B2 werden durch WP-005 (Plan: `docs/prozess/DEEPSEEK_ENTWICKLUNGSUMGEBUNG.md`) konkret eingelöst:** ohne bestandene Sicherheitsabnahme SA-01…SA-12 beginnt kein KI-Implementierungslauf.
| Nr. | Blocker | Quelle |
|---|---|---|
| B1 | E45: Ort/Datenschutz der KI-Ausführung geklärt (nur Code + synthetische Daten) | `OFFENE_ENTSCHEIDUNGEN.md` |
| B2 | E46: Dein Git-Zugang ist getrennt vom Server-Deploy-Key (z. B. Fork) | dito |
| B3 | E47: Technologiewahl (TypeScript/Node 22/Fastify, React+Vite, Kotlin+Compose) bestätigt | ADR-0002 |
| B4 | E48: Prozess freigegeben | ADR-0010…0012 |
| B5 | E50: Erreichbarkeit Testbackend (Variante T oder L) | SPEZIFIKATION §10 |
| B6 | E51: Pilot-Admin-Authentifizierung (ein Passwort aus Umgebung) | dito |
| B7 | E54: Handy-Modell/Android-Version, `minSdk` | dito |
| B8 | E56: Android-Build-Weg | dito |
Zu B1–B6 gilt der vorläufige Stand der Entscheidungsübersicht, nicht mehr und nicht weniger. Zu **B7/B8** (offen) ist jede Annahme **verboten**; U9 beginnt erst nach Eintrag der Entscheidung durch den Betreiber.

## 3. Pflichtlektüre (in dieser Reihenfolge, vollständig lesen)
1. `AGENTS.md` und `docs/prozess/KI_REGELN.md`
2. `docs/fortschritt/STATUS.md`
3. `docs/ARBEITSPAKETE/GT-ADS-001/SPEZIFIKATION.md`, `ARCHITEKTUR.md`, `API-VERTRAG.md`, `TESTPLAN.md`
4. `docs/prozess/DEFINITION_OF_DONE.md`, `docs/prozess/DATENTRENNUNG.md`, `docs/prozess/ENTWICKLUNGSPROZESS.md` (§3–§5a)
5. Anforderungen: `docs/konzept/ANFORDERUNGEN.md` (F-A03, S-01, S-02, F-B10, F-D02), Zustandsmodell §1/§5/§6: `docs/architektur/ZUSTANDSMODELL.md`
**Beginne nicht mit Code.** Antworte zuerst mit der Bestätigung nach `docs/prozess/SESSION_START.md` Vorlage A (WP-Status, Ziel in eigenen Worten, betroffene Dateien, Fakten/Annahmen/offene Fragen, gefundene Widersprüche). **Warte auf die Bestätigung des Betreibers.**

## 4. Harte Regeln (Auszug; vollständig in `KI_REGELN.md`)
- Arbeite **nur** auf dem Branch `wp/GT-ADS-001-geraeteregistrierung` (von `main`). **Niemals** auf `main` pushen, nie mergen, nie Force-Push.
- Ändere **nur** die Pfade aus `ARCHITEKTUR.md` §2. **Nicht ändern:** `docs/**` (außer `docs/fortschritt/**` laut §9), `docs/architektur/vertraege/**`, `docs/entscheidungen/**`, `.github/**`, `infra/server-setup/**`, `CLAUDE.md`, `AGENTS.md`.
- **Nichts erfinden:** Keine Zahlen/Grenzwerte/Entitäten außer den hier festgelegten. Fehlt etwas → Frage `Q-0nn` in `docs/fortschritt/STATUS.md` und an der Stelle **anhalten** (andere Aufgaben nur fortsetzen, wenn sie nicht davon abhängen).
- **Keine Secrets:** keine echten Passwörter, Pepper, Tokens, Schlüssel, IPs, Gerätekennungen im Repo, in Tests, Logs, Doku. `.env.example` nur Platzhalter wie `CHANGE_ME`.
- **Keine Produktivbezüge, keine Ports öffnen, kein Root, kein Docker-Socket des Hosts, keine Deployments.** Compose-Dateien schreiben ist erlaubt, ausführen auf dem Server nicht.
- **Keine neuen Technologien** außer den in `ARCHITEKTUR.md` genannten. Abhängigkeiten minimal, gepinnt (exakte Versionen), vor Aufnahme Lizenz und Notwendigkeit im PR begründen.
- **Tests zuerst/zugleich**, nie abschwächen oder überspringen. Behaupte nie „funktioniert", ohne echte Testausgabe.
- Vertrag `API-VERTRAG.md` **exakt** umsetzen. Abweichung gewünscht → Frage, **nicht** umsetzen.

## 5. Unteraufgaben (Reihenfolge verbindlich; je Unteraufgabe eigene Commits `GT-ADS-001: U<n> <Kurztext>`)
Jede Unteraufgabe endet mit grünen Tests ihrer Stufe, bevor die nächste beginnt. Ziel pro Commit/Sitzung: klein halten (≈ 400 Zeilen); bei Überschreitung aufteilen.

### U0 – Minimalgerüst
Dateien: `package.json` (Workspaces `apps/api`, `apps/dashboard`), `.env.example`, `apps/api/{package.json,tsconfig.json,vitest.config.ts,Dockerfile}`, `apps/dashboard/{package.json,vite.config.ts,tsconfig.json,index.html}`, `infra/compose/{docker-compose.dev.yml,README.md}`, `.gitignore` ergänzen (nur falls nötig).
Akzeptanz: `npm ci` und leere Testläufe laufen; Compose-Datei veröffentlicht **nur** `127.0.0.1:8080:8080`, DB ohne Port, `GT_ADS_ENV=dev`, Image-Tags gepinnt (kein `latest`); `.env.example` ohne Werte. Tests: Compose-/Secret-Check (TESTPLAN Statik).

### U1 – Datenbank
Dateien: `apps/api/src/db/{client.ts,migrate.ts}`, `…/migrations/0001_gt_ads_001.up.sql`, `…down.sql`. Schema **exakt** `ARCHITEKTUR.md` §3.
Akzeptanz: AC-18; Down verweigert außerhalb dev/test. Tests: I-01, I-02.

### U2 – Krypto und Konfiguration
Dateien: `apps/api/src/config.ts`, `src/crypto/{registrationCode.ts,tokens.ts,deviceSignature.ts,password.ts}`, `scripts/hash-password.ts`, `src/http/logging.ts` (Redaktion).
Akzeptanz: AC-04/05/14/20 (Unit). Tests: U-01…U-05, U-07…U-10.

### U3 – Registrierung (Gerät) + Audit
Dateien: `src/modules/registration/*`, `src/modules/audit/*`, `src/http/{server.ts,errors.ts,rateLimit.ts}`.
Akzeptanz: AC-01…AC-05, AC-13 (Teil), AC-15. Tests: I-03…I-12, I-22 (Teil), I-24.

### U4 – Geräteauthentifizierung
Dateien: `src/modules/deviceAuth/*`. Akzeptanz: AC-07, AC-08 (Teil). Tests: I-13…I-15.

### U5 – Heartbeat und Status
Dateien: `src/modules/heartbeat/*`, `src/modules/devices/status.ts`. Akzeptanz: AC-09, AC-10. Tests: U-06, I-16, I-17, I-23.

### U6 – Admin-API
Dateien: `src/modules/adminAuth/*`, `src/modules/devices/{routes,service,repository}.ts`, Erweiterung `registration` (Admin-Routen). Akzeptanz: AC-08, AC-12, AC-13. Tests: I-18…I-23, I-25, I-26.

### U7 – Maschinenlesbarer Vertrag und Contract-Tests
Dateien: `contracts/gt-ads-001/**` gemäß `API-VERTRAG.md` §9; `apps/api/tests/contract/*`. Akzeptanz: Schemas/Beispiele vollständig und synthetisch; Server-Antworten validieren. Tests: Contract (TESTPLAN §4).

### U8 – Dashboard
Dateien laut `ARCHITEKTUR.md` §2/§7. Akzeptanz: AC-12, AC-10, AC-16. Tests: D-01…D-07. Der Server liefert `apps/dashboard/dist` statisch aus (nur wenn Verzeichnis vorhanden).

### U9 – Android-App
Dateien laut `ARCHITEKTUR.md` §5 unter `apps/android/**`. `minSdk`/`targetSdk` laut Betreiberentscheidung B7. Akzeptanz: AC-01, AC-06…AC-08, AC-11, AC-15, AC-17. Tests: A-01…A-10 (A-07/A-08 instrumentiert: wenn kein Gerät/Emulator verfügbar → **als nicht ausgeführt melden**, nicht simulieren).
Keine Standort-/Kamera-/Mikrofon-Berechtigung. Release: Klartext verboten, `https://`-Pflicht. Debug-Menü: „Registrierung zurücksetzen" und „Jetzt senden" (nur Debug-Build, im Release nicht vorhanden).

### U10 – Betriebsunterlagen
Dateien: `infra/compose/README.md` (Start/Stopp/Reset der Dev-Umgebung, Variante T/L, Hinweis: nur Betreiber startet auf dem VPS), `apps/api/README.md`, `apps/android/README.md` (Build, `gtads.apiBaseUrl`, `adb reverse`), `apps/dashboard/README.md`. Inhalt: nur Fakten aus diesem Paket, Annahmen als „Annahme" gekennzeichnet; keine Secrets.

### U11 – Abschluss
`docs/fortschritt/sessions/<Datum>_GT-ADS-001_Implementierer.md` (Vorlage `SESSION_START.md` D), `docs/fortschritt/STATUS.md`: Status `PR offen`, Q-Fragen, Annahmen. PR mit `.github/pull_request_template.md` ausfüllen.

## 6. Verbindliche Parameter (nicht ändern; sind Annahmen [A] des Planers, alle konfigurierbar)
Code 12 Zeichen Alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, TTL 900 s, Fehlversuche 5/900 s je Quelle und 30/h global; Challenge 60 s; Token 900 s; Heartbeat 900 s; Online-Schwelle 1800 s; Admin-Session 3600 s; Zeitzone Anzeige `Europe/Vienna`; Dashboard-Refresh 30 s; App-ID `gtads.device`; Keystore-Alias `gt-ads-device-key`; Signatur ECDSA P-256 + SHA-256; Hashes SHA-256/HMAC-SHA-256; Passwort scrypt. Standardwerte stehen in `SPEZIFIKATION.md` §7.

## 7. Definition of Done (alles belegen, nichts behaupten)
1. AC-01…AC-20 einzeln mit Testverweis (Tabelle im PR).
2. Alle Tests T1–T4, T7 **ausgeführt**, grün, **echte Ausgabe** eingefügt; T5 ausgeführt oder ausdrücklich „nicht ausgeführt (Grund)".
3. Vertrag unverändert umgesetzt (keine Abweichung); Beispiele synthetisch.
4. Secret-Scan sauber, keine echten Kennungen, keine Demo-Daten im Dashboard.
5. Nur erlaubte Pfade geändert (Diff-Liste im PR).
6. README/Betriebsunterlagen, Sitzungsprotokoll, STATUS aktualisiert; Annahmen/offene Fragen benannt.
7. `git revert` des Squash-Commits genügt; Migration mit Down-Skript.
8. Review durch frische Claude-Sitzung, Handytest durch Betreiber, Merge durch Betreiber (nicht du).

## 8. Stoppregeln – bei jedem Punkt **sofort anhalten und melden**
Widerspruch zwischen Dokumenten oder Dokument und Code · fehlende Entscheidung/Information (B1–B8, L-nn; **B7/B8 stoppen U9**) · Wunsch, den Vertrag oder geschützte Pfade zu ändern · neue Abhängigkeit nötig, die nicht in `ARCHITEKTUR.md` steht · Test lässt sich nur durch Abschwächen grün machen · Verdacht auf Geheimnis im Repo/Log · Aufgabe würde Produktionssysteme, Ports oder Server berühren.
Meldeformat: `Q-0nn: <Frage>; Kontext: <Datei/Abschnitt>; Optionen: <A/B>; Blockiert: <Unteraufgabe>`.

## 9. Abschlussbericht (Vorlage, in PR-Beschreibung und Sitzungsprotokoll)
```
Umsetzung: Unteraufgaben U0…U11 (Stand je Aufgabe)
Tests (echte Ausgabe/Pfad): T1 … T2 … T3 … T4 … T5 (ausgeführt/nicht) … T7 …
Abweichungen vom Auftrag (sollte leer sein) / gestellte Fragen:
Annahmen:
Bekannte Lücken:
Geänderte Dateien (Liste):
Nicht gemacht (Nicht-Ziele bestätigt):
```
