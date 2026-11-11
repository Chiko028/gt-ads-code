# GT-Ads – Projektstatus (Single Source of Truth für den aktuellen Stand)

Stand: 2026-11-10 · Pflege: bei **jeder** Sitzung und jedem WP-Statuswechsel aktualisieren (siehe `prozess/KONTEXTMANAGEMENT.md`).

## Phase
**Planung, daneben Aufbau der KI-Entwicklungsinfrastruktur auf dem VPS.** Es ist **kein Produkt-Code implementiert** und **kein fachliches Arbeitspaket freigegeben** (GT-ADS-001 bleibt gesperrt, im Runner mit `enabled: false`). Auf dem VPS laufen seit 2026-11-10: **OpenClaw** (Chat-/Statusagent, DeepSeek, Telegram-Bot @Dipshit28_bot, nur Betreiber-ID, lesend), der **Egress-Proxy** und der **Coding-Runner** (Warteschlange, Freigabe per Code, Limits). Das frühere Python-Telegram-Gateway (WP-006) ist **entfernt** und wird nicht mehr verwendet (Betreiberentscheidung). Der **Coding-Agent ist noch nicht erprobt**: Der erste Lauf (Pilot WP-009, synthetisch) steht aus.

## Repository-Stand
- `main` = `b3bb77f` (Stand 2026-11-10; Squash-Merges #7 `d3f98fb`, #8 `89cb05c`, #12 `a4441d1` (ersetzt #9), #10 `11837f7`, #11 `b3bb77f` jeweils nach „Merge freigegeben“ des Betreibers; keine geschützten Pfade berührt). Offen: PR #13 (Chatbot-Anbindung an den Runner, Installer-Korrekturen).
- Verbleibende Remote-Branches: `docs/github-einstellungen` und `docs/github-arbeitsweise` (veraltet; Löschung durch den Betreiber in GitHub empfohlen). Lokaler Push-Hook sperrt `main`; Branch-Schutz auf GitHub nicht durchsetzbar (§5a).
- `docs/gt-ads-001-planung` wurde von GitHub nach dem Merge automatisch gelöscht.

## GitHub-Zugang
`gh` v2.103.3 (`~/.local/bin/gh`) **angemeldet als `Chiko028`** mit fein granuliertem Token (nur Repo `gt-ads` als privates Repo sichtbar, Ablauf 2027-02-07). **Blocker B-GH1 erledigt (2026-11-09).** Claude erstellt PRs und merged **nur** nach ausdrücklichem „Merge freigegeben" (`GITHUB_ARBEITSWEISE.md` §6). Restrisiko: Token erlaubt technisch Pushes auf `main` (Branch-Schutz nicht durchsetzbar). Hinweis: Ein Force-Push auf einen eigenen Feature-Branch wurde vom Sicherheitsfilter blockiert; Rebases werden daher unter neuem Branch-Namen normal gepusht.

## Aktives Arbeitspaket
**Keines.** (Kein Code ohne freigegebenes WP.) **GT-ADS-001** (Android-Geräteregistrierung) ist **spezifiziert und wartet auf Freigabe** – Ordner `docs/ARBEITSPAKETE/GT-ADS-001/`. Katalog-Alternative: WP-001 zuerst (siehe Q-004).

## Freigabestatus
| Gegenstand | Status |
|---|---|
| Prozessdokumente (`docs/prozess/*`, ADR-0010…0012) | Entwurf – **wartet auf Betreiberfreigabe** (E48) |
| Arbeitspaketkatalog, Abhängigkeiten, MVP-Roadmap | Entwurf – wartet auf Freigabe |
| Technologiewahl (ADR-0002) | **nicht bestätigt** (E47) |
| Verträge (`docs/architektur/vertraege/`) | noch nicht ausgearbeitet; nichts eingefroren |
| Arbeitspakete WP-001 … WP-711 | alle `Entwurf` |
| **WP-006** Telegram-Gateway (Python) | **Abgelöst und entfernt** (Betreiberentscheidung 2026-11-10: nie wieder verwenden); der Bot wird von OpenClaw bedient (WP-007). Code des Gateways nur noch in der Git-Historie. |
| **WP-007** OpenClaw (Chat-/Statusagent) | **Läuft auf dem VPS** (installiert 2026-11-09/10, Telegram umgeschaltet, Statusagent nur lesend: wirksame Werkzeuge `ls`, `read`, `presence`, `session_status` laut `check-tools.sh`; `verify.sh` bestanden am 2026-11-09). Siehe `docs/ARBEITSPAKETE/WP-007/STATUSBERICHT.md` (Stand vor Installation, wird nachgeführt) und `infra/openclaw/README.md`. |
| **WP-008** Rootless-Podman-Sandbox | **Läuft** (Podman 4.9.3, Benutzer `occoder`, Image `gtads-sandbox:1`); Grenztests mit Positivkontrollen am 2026-11-10 vom Betreiber bestätigt („passt alles“). |
| **WP-009** Coding-Agent-Pilot (synthetisch) | `Spezifiziert`; Pilot vom Betreiber im Chat freigegeben (2026-11-09: „ersten ungefährlichen Sandbox-Test“, nur synthetische Dateien). **Noch nicht ausgeführt.** |
| **WP-010** Coding-Runner | **Installiert und aktiv** (`gt-ads-coding-runner.service`); Chatbot-Anbindung (MCP) per `coder_status` bestätigt (2026-11-10). **Nicht erprobt:** Agentenlauf in der Sandbox, Kostenmessung (Preise nicht eingetragen: Token-Limit 300 000 je Auftrag begrenzt hart), Bericht per Telegram. |
| **WP-005** DeepSeek-Entwicklungsumgebung | `Spezifiziert` (Ordner `docs/ARBEITSPAKETE/WP-005/`) – **wartet auf Entscheidungen E57–E63 und Freigabe**; blockiert GT-ADS-001-Start |
| **GT-ADS-001** | `Spezifiziert` – **wartet auf endgültige Freigabe**; E45–E51 und Q-004 vorläufig 🟦 übernommen; E54, E56 offen bis Gerätetest (nur U9 Android); Details: `docs/fortschritt/berichte/2026-11-09_GT-ADS-001_Freigabebericht.md` |

## Infrastruktur (Stand 2026-11-10)
Contabo VPS `vmi3737797`, Ubuntu 24.04, Kernel 6.8.0-149; SSH nur Schlüssel (Root-Login und Passwort aus, bestätigt); UFW aktiv, nur 22/tcp öffentlich; Docker 29.9.3 + Compose v5.7.0 installiert, keine Container; `/srv/taxiwerbung/*` und `/srv/taxiagents` eingerichtet; Benutzer `taxiagent` ohne Rechte; **kein Port zusätzlich geöffnet**, **keine Produktivdaten**, **keine Deployments**. Details/Historie: `infra/server-setup/STATUS_SERVER.md` (teils historisch, siehe K-07).
Neu seit 2026-11-09/10 (vom Betreiber per sudo installiert): `gt-ads-openclaw` (Loopback:18789, Benutzer `openclaw`), `gt-ads-egress-proxy` (Loopback:3128, erlaubt nur `api.telegram.org` und `api.deepseek.com`), `gt-ads-coding-runner` (Benutzer `occoder`, Unix-Socket `/run/gtads-runner/control.sock`), rootless Podman. Öffentlich weiterhin **nur SSH:22**. Bekannte, bewusst akzeptierte Abweichungen: `exec security=full` des Coder-Agenten nur im Container; Runner-Unit mit `NoNewPrivileges=no` (rootless Podman). Nicht verifiziert: Preise/Kostenmessung, `mincore`-Syscall wird vom Filter blockiert (nur Cache-Vorwärmung betroffen). Noch mit sudo gegenzuprüfen: `sudo ufw status verbose`, `sudo docker info`. Offene Server-Restpunkte: WP-105.

## Offene Entscheidungen, die als Nächstes blockieren
E45–E51 und Q-004 sind **vorläufig übernommen (🟦)**, aber nicht endgültig bestätigt; offen: **E54, E56** (bis Gerätetest) und die **endgültige Freigabe** von GT-ADS-001; danach E36/E37/E40 (Pause/Taster/Nachlauf), E1–E5 (Domain, Erreichbarkeit, Pilotumfang, Rechtsprüfung, Budget), E42/E43 (Fachbetrieb, Datenschutz).
Vollständig: `docs/entscheidungen/OFFENE_ENTSCHEIDUNGEN.md`. Analyse: `docs/analyse/WIDERSPRUECHE_LUECKEN_ANNAHMEN.md`.

## Offene Fragen (Q-nnn, aus Sitzungen)
| ID | Frage | Gestellt von | Datum |
|---|---|---|---|
| Q-004 | ID-Schema `GT-ADS-nnn` vs `WP-xxx` bestätigen; GT-ADS-001 vor WP-001/002/003/101/201/202 zulassen (Minimalgerüst im Paket)? | Claude | 2026-11-09 |
| Q-001 | Wird die Arbeitskopie unter `/srv/taxiwerbung/app/gt-ads` gehalten (vorgeschlagen) oder lokal beim Betreiber? | Claude | 2026-11-09 |
| Q-003 | **Geklärt 2026-11-09:** Rulesets werden im privaten Repo ohne GitHub Team nicht durchgesetzt; vorerst Arbeitsvereinbarung (ENTWICKLUNGSPROZESS §5/§5a). Offen: Entscheidung über GitHub Team später; Repo-Einstellungen (Squash-only, Auto-Delete) durch Betreiber bestätigen | Betreiber/Claude | 2026-11-09 |
| Q-002 | Soll `~/taxiwerbung-setup` nach Übernahme ins Repo archiviert werden (es enthält die gleichen Dokumente)? | Claude | 2026-11-09 |

## Bekannte Konflikte (aus Analyse)
K-02 (RAM-Budget), K-03 (Pause bei Fahrzeug-aus), K-06 (Retention), K-08 (Vergütung „bis zu 80 €"), K-09 (Hardwarekosten) – siehe Analyse. Keine blockiert bereits Dokumentationsarbeit.

## Letzte Änderungen
- 2026-11-10: **OpenClaw, Coding-Runner und Podman-Sandbox auf dem VPS in Betrieb** (WP-007/008/010, PRs #7, #8, #10, #11, #12 gemergt; #13 offen). Das Python-Gateway wurde entfernt. Chatbot ruft den Runner über MCP ab (`coder_status` bestätigt). Pilot WP-009 steht aus. Docs-Spiegel des Statusagenten ist neu zu synchronisieren (`sudo bash infra/openclaw/deploy/sync-status-docs.sh`).
- 2026-11-09 (Branch `wp/WP-006-telegram-gateway`): **WP-006 umgesetzt** (PR): `apps/telegram-gateway/` (Python-Standardbibliothek, 8 Module), 57 Tests (Unit/Integration/Statik, ohne Netz, alle bestanden), 8 gezielte Fehler-Einbauten wurden erkannt, systemd-Units (Sicherheitsbewertung offline 1.4 OK), Skripte mit Trockenlauf. **Nichts installiert, kein Token, keine Verbindung zu Telegram/DeepSeek**, keine Änderung am VPS. PR #5 (`962c4be`) wurde vorher gemergt (Freigabe „1. freigegeben“).
- 2026-11-09: **PR #4 gemergt** (`b38c967`, Squash, Freigabe des Betreibers; keine geschützten Pfade). **E62 = ja bestätigt** (Betreiber, im Chat). Telegram-Branch auf neuen `main` aufgesetzt (`docs/telegram-steuerung-v2`).
- 2026-11-09 (Branch `docs/telegram-steuerung-plan`): **WP-006 Telegram-Gateway spezifiziert** (`docs/ARBEITSPAKETE/WP-006/`); Betreiberantworten E57′ (VPS), E61 (Prepaid-Guthaben, kein hartes Limit), E62 (vermutlich ja), E68 offen (Bot-Link statt ID) im Entscheidungsprotokoll. Nichts implementiert/installiert, kein Token eingegeben.
- 2026-11-09 (Branch `docs/telegram-steuerung-plan`, aufgebaut auf `docs/wp-005-planung`): **Telegram-Steuerung geprüft und geplant** (`docs/prozess/TELEGRAM_STEUERUNG.md`): Installationsstand (nichts installiert), Quellenprüfung (DeepSeek-Modell `deepseek-flash` = V4.1-Flash-1017 bestätigt; OpenClaw-Risiken), Konflikte K-20…K-27, Optionen M/O, Schritte S0–S10, Entscheidungen E57′/E68–E73. **Kein Token eingegeben, nichts installiert, keine privilegierte Änderung.**
- 2026-11-09 (Branch `docs/wp-005-planung`): **WP-005 spezifiziert** (Spezifikation, Entwurf, Schnittstellenvereinbarung, Testplan, Implementierungsauftrag) inkl. Entscheidungsblatt E57–E63 mit Ein-Zeilen-Antwortformat. Nichts implementiert/installiert/bestellt. STATUS-Zeilen zu PR #3 korrigiert.
- 2026-11-09: **PR #2 gemergt** (`28d44a7`, Squash, Freigabe durch den Betreiber inkl. geschützter Datei `OFFENE_ENTSCHEIDUNGEN.md`). Ein Fehler im Abschlussbericht (fälschlich „keine geschützten Pfade") wurde vor dem Merge bemerkt, offengelegt und neu freigegeben; die Pfadprüfung erfolgt künftig automatisch.
- 2026-11-09 (PR #3, gemergt `e7de8fa`): **GitHub-Betrieb über Claude Code**: `gh` v2.103.3 in `~/.local/bin` (ohne Root, Prüfsumme ok), authentifiziert (B-GH1 erledigt), Arbeitsweise `docs/prozess/GITHUB_ARBEITSWEISE.md`, Entscheidungen E64–E67, Konflikte K-16…K-19. Kein Merge, nichts auf `main`.
- 2026-11-09 (PR #2, gemergt): **Einrichtungsplan DeepSeek-Entwicklungsumgebung** (`docs/prozess/DEEPSEEK_ENTWICKLUNGSUMGEBUNG.md`), neuer Baustein **WP-005**, neue Entscheidungen E57–E63, Lücken L-25…L-28, Annahme A-20. Nichts installiert, nichts bestellt, kein Server verändert.
- 2026-11-09: PR #1 (Squash `fabff64`) in `main` übernommen; lokaler Stand synchronisiert und kontrolliert.
- 2026-11-09 (Branch `docs/gt-ads-001-planung`): **GT-ADS-001 geplant** (Spezifikation, Entwurf, API-Vertrag v0.1.0, Testplan, DeepSeek-Auftrag). Dokumentation **umstrukturiert** (`git mv`, Historie erhalten): `architektur/`, `entscheidungen/`, `ARBEITSPAKETE/`, `tests/`, `fortschritt/`; Index `docs/INDEX.md`, README mit Links. Neue Analysepunkte K-11…K-15, L-21…L-24, A-17…A-19; neue Entscheidungen E50–E56, Q-004. Keine Software, keine Serveränderung, kein Port.
- 2026-11-09: Entwicklungsorganisation erstellt (CLAUDE.md, AGENTS.md, Prozess, Datentrennung, Kontextmanagement, Verträge, Arbeitspaketkatalog, Abhängigkeiten, MVP-Roadmap, ADRs 0001–0013, Analyse). Protokoll Tablet-Betrieb v2.0 eingearbeitet. Quellen des Betreibers unter `docs/konzept/QUELLEN/`.
- GitHub: privates Repo `Chiko028/gt-ads`; Server-Zugang per Deploy-Key (Schreibrecht, nur dieses Repo, Alias `github-gt-ads`). Erstcommit hochgeladen (siehe Git-Verlauf).
- **Branch-Schutz nicht durchsetzbar** (GitHub-Hinweis: Rulesets in privaten Repos erst mit GitHub Team). GitHub Team vorerst nicht kaufen (Empfehlung, vom Betreiber übernommen: Auto-Merge aus). Es gilt die **Ersatzregel** in `docs/prozess/ENTWICKLUNGSPROZESS.md` §5a; lokaler Push-Hook auf dem Server sperrt `main`.

## Nächste Schritte
00. **Pilot WP-009** (synthetisch) über Telegram: „Bereite WP-009 zur Freigabe vor“ → Freigabecode kommt direkt vom Runner → „Freigabe <Nr> <Code>“ → Bericht. Danach Auswertung (Kosten, Dauer, Versuche) und erst dann Entscheidung über GT-ADS-001. PR #13 mergen. Preise je Million Tokens in `runner.json` eintragen.
0. **Telegram-Agent:** WP-006-PR prüfen und mit „Merge freigegeben" übernehmen; danach Betreiber-Schritte laut `apps/telegram-gateway/deploy/README.md`: S1 (BotFather: Gruppen sperren, Privacy-Modus), S2 (DeepSeek-Schlüssel), Einrichtung mit `sudo` (S5), ID im Setup-Modus ermitteln (E68), Tests `/start`, `/status`, eine Nachricht.
1. Betreiber beantwortet **E57–E63** in einer Zeile (Format: `docs/ARBEITSPAKETE/WP-005/SPEZIFIKATION.md` §4; besonders E62 Vertraulichkeit/Datenschutz und E61 Budget).
2. Betreiber gibt **WP-005** frei; Umsetzung der Dateien als PR (Claude), Aufbau und Sicherheitsabnahme SA-01…SA-12 auf dem PC des Betreibers.
3. Betreiber gibt **GT-ADS-001** frei (`Freigegeben` in diesem Dokument) – erst danach Implementierung (U0–U8, U10; U9 nach E54/E56).
4. Implementierung (DeepSeek) auf Branch `wp/GT-ADS-001-geraeteregistrierung`, Review durch frische Claude-Sitzung, Merge durch den Betreiber.
