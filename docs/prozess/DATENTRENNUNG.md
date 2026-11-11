# Trennung von Entwicklungs-, Test- und Produktivdaten

Status: **Vorgeschlagen – wartet auf Freigabe** (ADR-0011). Grundsatz: Es gibt **keine** automatische Daten- oder Testdatenerzeugung in Produktion und keinen Datenfluss von Produktion in Entwicklung/Test.

## 1. Umgebungen
| Umgebung | Zweck | Daten | Wo | KI-Zugriff |
|---|---|---|---|---|
| `dev` | Entwicklung lokal/Container | synthetisch (Generator mit festem Seed) | Entwicklerrechner oder `taxiagent`-Umgebung | ja (Code + synthetische Daten) |
| `test` | automatisierte Tests/CI | synthetisch, pro Testlauf neu erzeugt, danach verworfen | CI-Container, Test-DB | ja |
| `staging` (später, optional) | Abnahme vor Produktiv | synthetisch oder anonymisiert, nur nach Freigabe | eigener Compose-Stack | eingeschränkt |
| `prod` | Betrieb | echte Daten | VPS `/srv/taxiwerbung`, DB-Volume | **nein** (nur Betreiber/ausgewählte Admins; Agenten nur über API-Token mit minimalen Rechten, später) |

## 2. Regeln
1. **Umgebungsvariable `GT_ADS_ENV`** ∈ {`dev`,`test`,`staging`,`prod`}; fehlt sie → Start verweigert. Jeder Prozess protokolliert beim Start die Umgebung.
2. **Seed-/Fixture-Code** läuft nur bei `dev`/`test` und **bricht in `prod` hart ab** (Guard + Test, der das prüft). Kein Seed in Migrationen.
3. **Synthetische Daten** sind erkennbar: Präfix/Kennzeichen `SYN-`, Domain `example.invalid`, Kennzeichen-/Seriennummernformat `SYN-…` – keine realistisch nachgeahmten echten Kennzeichen, Firmen, Personen oder Telefonnummern. Die Generator-Logik liegt im Repo (`testdata/`, später WP-003); jeder Datensatz trägt `synthetic=true`.
4. **Keine Produktivkopien:** Dumps/Backups der Produktion gelangen nicht in `dev`/`test`/CI/Git/KI-Prompts. Falls ein Produktivfall reproduziert werden muss: anonymisierte Ableitung, nur nach Betreiberfreigabe, dokumentiert.
5. **Secrets** getrennt je Umgebung; `.env.example` ohne Werte im Repo, echte Werte nur in `/srv/taxiwerbung/secrets` (prod) bzw. lokalen ungetrackten Dateien. Secret-Scan in CI.
6. **Geräte:** Testgeräte haben eigene Enrollment-Tokens/Kennungen, nur gegen `dev`/`test`-Server. Produktive Tablets sprechen ausschließlich `prod`. Die App erkennt Umgebung am Server-Endpunkt-Profil; Testbuilds sind sichtbar markiert und können sich nicht bei `prod` registrieren.
7. **Datenbanken:** getrennte Instanzen/Namen (`gt_ads_dev`, `gt_ads_test`, `gt_ads_prod`), getrennte Zugangsdaten; die Produktivinstanz ist aus dev/test-Netzen nicht erreichbar.
8. **Testdaten für Zahlen:** Kennzahlen, Statistiken und „realistische" Verläufe entstehen nur aus nachvollziehbaren Generatoren/Fixtures mit dokumentierter Parametrisierung (Seed, Anzahl), nie aus Schätzungen der KI. Berichte aus Testdaten tragen den Hinweis „SYNTHETISCH".
9. **Produktivfreigabe:** Deployment nach `prod` nur nach Betreiberfreigabe; Datenbankmigrationen in `prod` nur mit vorherigem Backup und Rückwegplan.
10. **Externe KI (DeepSeek u. a.):** erhält nur Inhalte aus `dev`/`test` (Code, Doku, synthetische Daten).

## 3. Prüfungen (automatisiert, Umsetzung in WP-003/WP-001)
Test „Seed in prod verweigert", Secret-Scan, Check „keine nicht-synthetischen Fixtures", CI-Regel „kein Zugriff auf prod-Hostnamen".
