# WP-005 – Implementierungsauftrag

**Freigabestatus: AUSSTEHEND.** Nicht beginnen, bevor (1) der Betreiber WP-005 in `docs/fortschritt/STATUS.md` auf **„Freigegeben"** setzt und (2) E57–E63 entschieden sind (Antwortzeile laut [SPEZIFIKATION.md](SPEZIFIKATION.md) §4). Fehlt etwas: **stoppen und melden.**
Abweichung von der Vorlage: Der Implementierer ist hier **Claude**, nicht DeepSeek, denn die DeepSeek-Umgebung existiert noch nicht (Henne-Ei). Die Dateien werden daher ohne DeepSeek erstellt; das Review erfolgt durch den Betreiber bzw. eine unabhängige Sitzung (E64).

## 1. Kontext (ohne Chatverweise)
GT-Ads ist ein Taxi-Werbenetzwerk in Planung. Für KI-gestützte Implementierung braucht es eine isolierte Umgebung (siehe `docs/prozess/DEEPSEEK_ENTWICKLUNGSUMGEBUNG.md`). Dieses Paket erzeugt **nur Dateien im Repo** (Compose, Dockerfiles, Proxy-Konfiguration, Hooks, SA-Skripte, README). Aufgebaut, gestartet und abgenommen wird auf dem **PC des Betreibers**; auf dem VPS passiert nichts.

## 2. Pflichtlektüre
`CLAUDE.md`, `KI_REGELN.md`, `docs/fortschritt/STATUS.md`, `docs/prozess/DEEPSEEK_ENTWICKLUNGSUMGEBUNG.md`, `docs/prozess/GITHUB_ARBEITSWEISE.md` (§3, §6, §10), alle Dateien in `docs/ARBEITSPAKETE/WP-005/`, `DEFINITION_OF_DONE.md`, `DATENTRENNUNG.md`.

## 3. Harte Regeln
- Branch `wp/WP-005-devenv` von aktuellem `main`; nie auf `main` pushen; PR nur über `gh`, Merge nur nach „Merge freigegeben".
- Nur Pfade aus `ARCHITEKTUR.md` §2 anlegen/ändern; **nichts** unter `infra/server-setup/**`, `.github/**`, `docs/architektur/vertraege/**`, `docs/entscheidungen/adr/**`.
- **Keine Geheimnisse**, keine echten Schlüssel, keine echten E-Mail/IP; Platzhalter `<…>` nur dort, wo eine Entscheidung fehlt – nie raten.
- Keine Installation und kein Docker-Lauf auf dem VPS; keine Änderung an Firewall/Benutzern/Diensten.
- Keine Kontoerstellung, kein Kauf; Modellkonto/Limit macht der Betreiber.
- Pins (Digests, Versionen) beim Erstellen aus **tatsächlichen** Registry-Angaben ermitteln und im PR belegen; nicht aus dem Gedächtnis eintragen.
- Nichts als „getestet" melden, was nur der Betreiber auf dem PC ausführen kann.

## 4. Unteraufgaben (je eigener Commit `WP-005: U<n> …`)
| U | Inhalt | Dateien | Test |
|---|---|---|---|
| U1 | Compose-Gerüst, Netze, Härtung | `infra/devenv/docker-compose.yml` | ST-02, ST-03 |
| U2 | Agent-Image (Digest, uid 10001, gepinnte Tools) | `infra/devenv/agent.Dockerfile` | ST-03, ST-04 |
| U3 | Proxy (Squid, Allowlist, Log, fail-closed) | `infra/devenv/proxy/**` | ST-05, ST-06 |
| U4 | Devcontainer, `.gitattributes`, `.gitignore`, `.env.local.example` | `.devcontainer/devcontainer.json`, … | ST-07, ST-10 |
| U5 | Hook-Vorlagen und Pfadliste | `infra/devenv/hooks/**` | ST-08 |
| U6 | SA-Skripte und Berichtsvorlage (nach `TESTPLAN.md` §3) | `infra/devenv/sa/**` | ST-01, ST-11 |
| U7 | Betreiber-README | `infra/devenv/README.md` | ST-09 |
| U8 | Statische Prüfungen ausführen (ST-01…ST-12), PR vorbereiten | – | echte Ausgabe |
| U9 | Betreiber-Schritte begleiten: S4 Aufbau, S6 SA-Auswertung, S5 Probelauf | – | SA-01…SA-12 |

## 5. Definition of Done
Siehe `SPEZIFIKATION.md` §7. Zusätzlich: PR-Beschreibung mit Tabelle AC-01…AC-15, ausdrücklicher Liste der **nicht ausgeführten (Betreiber-)Tests** und der **automatisch ermittelten** geschützten Pfade.

## 6. Stoppregeln
Widerspruch zwischen Dokumenten · fehlende/geänderte Entscheidung (E57–E63) · Notwendigkeit einer Änderung am VPS, an Firewall/Ports oder an geschützten Pfaden außerhalb des Auftrags · Pin lässt sich nicht verifizieren · Verdacht auf Geheimnis im Repo · SA schlägt fehl. Meldeformat: `Q-0nn: <Frage>; Kontext; Optionen; Blockiert`.

## 7. Abschlussbericht
Format `GITHUB_ARBEITSWEISE.md` §5 (PR, Head-SHA, Änderungen, Tests mit echter Ausgabe, Review, Risiken, Empfehlung).
