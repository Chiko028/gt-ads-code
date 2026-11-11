# Bericht 2026-11-10 – Startprüfung GT-ADS-001 (Freigabe im Chat) und vorläufige MVP-Vorgaben

Stand: 2026-11-10 · Autor: Claude · Quelle der Freigabe: Betreiber im Chat („GT-ADS-001 ist hiermit ausdrücklich zur Implementierung freigegeben“; GT-ADS-002/003 „sofern Spezifikationen unverändert“). Die Freigabe im Runner erfolgt nur über Freigabecode an den Betreiber und ist an Spezifikations-Hash gebunden.

## 1. Vorläufige MVP-Vorgaben (vom Betreiber, 🟦) und Abgleich
| ID | Vorgabe | Abgleich mit GT-ADS-001 |
|---|---|---|
| L-01 | MP4, H.264, 1920×1080, 30 FPS, ohne Ton, ≤ 1000 MB | kein Bezug (Medien erst ab Medien-Paket) |
| L-02 | Tablet offen; hardwareunabhängig, Smartphone als Testgerät | deckungsgleich mit Spezifikation (E54/E56 nur für U9) |
| L-03 | ≤ 30 s je Spot, 12–16 Spots/Schleife, Offline-Wiedergabe | kein Bezug (Schleife erst später) |
| L-04 | Betreiber → Taxi → zwei Tablets; zunächst eine Standardgruppe | **kein Konflikt:** GT-ADS-001 enthält ausdrücklich keine Taxis/Gruppen (Spezifikation §Nicht-Ziele) |
| L-05 | Admin und Operator; TOTP-MFA für Admins | **kein Konflikt, aber Abgrenzung:** GT-ADS-001 nutzt laut E51 **ein** Admin-Passwort aus der Umgebung; Rollen/MFA sind Nicht-Ziel und kommen im Rollen-Paket |
| L-06 | Telegram als Alarmkanal + Ereignisprotokoll im Dashboard | später (Alarm-Paket); Telegram-Infrastruktur steht |
| L-08 | Interne Taxi-ID, Betreiber, Fahrzeugbezeichnung, Tablet-Zuordnung, Status; Kennzeichen optional | später (Taxi-Stammdaten) |
Verträge und Spezifikation von GT-ADS-001 bleiben **unverändert**. Die Eintragung in `docs/entscheidungen/OFFENE_ENTSCHEIDUNGEN.md` (geschützter Pfad) erfolgt erst mit ausdrücklicher Betreiberfreigabe dieser Datei.

## 2. Startprüfung des Runners (Fakten, 2026-11-10)
- Runner und Chatbot-Anbindung laufen; Freigabewarteschlange leer; **noch kein Auftrag je ausgeführt** (Pilot WP-009 steht aus).
- In der Runner-Konfiguration ist `GT-ADS-001` mit `enabled: false` hinterlegt (Absicht: erst nach Pilot).

## 3. Technische Blocker für den Start von GT-ADS-001 im Runner (belegt)
| Nr. | Blocker | Beleg |
|---|---|---|
| B-1 | Sandbox enthält **kein Node/npm, keine PostgreSQL, kein Gradle/Android-SDK** | `infra/openclaw/deploy/sandbox/Containerfile`: nur bash, git, python3, pytest |
| B-2 | **Kein Netz in der Sandbox** (`--network none`): `npm ci`, Gradle-Abhängigkeiten nicht ladbar | Runner-Design (gewollt); Auftrag verlangt `npm ci` (U0) |
| B-3 | **Integrationstests brauchen echte PostgreSQL** (Testplan T2); die Sandbox kann keine Container starten | `TESTPLAN.md` §3, `ARCHITEKTUR.md` (Compose) |
| B-4 | Runner-Auftragsmodell ist **ein Zug je Paket** (30 min, 3 Versuche, 300 000 Token, 2 USD) und arbeitet auf einer **Vorlage**, nicht auf dem Repo; U0–U10 sind elf Aufträge | `runner_core.py`, `runner.json` |
| B-5 | `DEEPSEEK-AUFTRAG.md` verlangt vor dem Start eine **Bestätigung durch den Betreiber** (SESSION_START Vorlage A) – im autonomen Runner nicht abbildbar | `DEEPSEEK-AUFTRAG.md` §3 |
| B-6 | Ergebnisse verlassen die Sandbox nur als **lokaler Commit/Schnappschuss**; es gibt keinen GitHub-Schreibzugriff des Agenten (bewusst) – Übernahme auf einen Integrationsbranch fehlt | `README` Runner, Sicherheitsvorgaben |
| B-7 | U9 (Android) braucht Gerät/SDK/E54/E56 und ist in der Sandbox nicht lauffähig | Spezifikation B7/B8 |

## 4. Plan zur Behebung (WP-013 „Entwicklungsumgebung v2 für TypeScript/PostgreSQL“)
Noch nicht umgesetzt; Umfang und Reihenfolge in der Betreibernachricht. Kurzfassung: Sandbox-Image v2 (Node 22 + PostgreSQL, ohne Netz), Abhängigkeiten **vorab und gepinnt** (Lockdatei) als schreibgeschützte Vorlage, Repo-Workspace aus `main`, Aufträge je Unteraufgabe mit eigener Testbefehls-Liste, Übernahme der Ergebnisse als Patch/Bundle auf einen Integrationsbranch (nur Claude/Betreiber pushen), Bestätigungsschritt des Auftrags durch Runner-Vorgaben ersetzt.
