# Arbeitspakete – Übersicht, Status, Abhängigkeiten, Fortschritt

Stand: 2026-11-09 · Pflege: bei jedem Statuswechsel (zusammen mit `docs/fortschritt/STATUS.md`).

## Ordnerstruktur
| Datei/Ordner | Inhalt |
|---|---|
| [KATALOG.md](KATALOG.md) | Katalog der Bausteine `WP-xxx` (Ziele, Akzeptanz, Tests; Bereiche A–H) |
| [ABHAENGIGKEITEN.md](ABHAENGIGKEITEN.md) | Abhängigkeitsgraph der Bausteine |
| [MVP_ROADMAP.md](MVP_ROADMAP.md) | Meilensteine und Reihenfolge |
| [PROJEKTSTRUKTUR.md](PROJEKTSTRUKTUR.md) | Entwicklungsbereiche, Repo-Struktur, Modulgrenzen |
| [_VORLAGE/](_VORLAGE/) | Vorlage für ein Arbeitspaket-Ordner (5 Dateien) |
| `GT-ADS-nnn/` | **Je Implementierungspaket ein Ordner:** `SPEZIFIKATION.md`, `ARCHITEKTUR.md`, `API-VERTRAG.md`, `TESTPLAN.md`, `DEEPSEEK-AUFTRAG.md` |

## ID-Schema (🟦 Q-004)
`GT-ADS-nnn` = Implementierungspaket (vertikaler Durchstich, vom Betreiber nummeriert) · `WP-xxx` = Katalogbaustein. Ein Paket bündelt Teile mehrerer Bausteine; der Katalog bleibt maßgeblich für den Gesamtumfang.

## Statusübersicht Implementierungspakete
Statuswerte: Entwurf · Spezifiziert · **Freigegeben** (nur Betreiber) · In Arbeit · PR offen · Review · Gemergt · Done · Blockiert.
| ID | Titel | Status | Blocker/Abhängigkeiten | Fortschritt | Ordner |
|---|---|---|---|---|---|
| WP-006 | Telegram-Gateway Phase 1 (Python) | **Abgelöst und entfernt** (2026-11-10, Betreiberentscheidung); ersetzt durch OpenClaw (WP-007) | – | – | [WP-006/](WP-006/SPEZIFIKATION.md) |
| WP-007 | OpenClaw als Chat-/Statusagent (DeepSeek, Telegram, lesend) | **Läuft** (VPS, 2026-11-10) | – | Betrieb · Doku-Nachführung offen | [WP-007/](WP-007/STATUSBERICHT.md) |
| WP-008 | Rootless-Podman-Sandbox für den Coding-Agenten | **Läuft**, Grenztests vom Betreiber bestätigt | – | Betrieb | `infra/openclaw/deploy/setup-podman-sandbox.sh` |
| WP-010 | Coding-Runner (Warteschlange, Freigabe per Code, Limits, MCP-Anbindung) | **Aktiv**, Agentenlauf noch nicht erprobt | WP-009 (Pilot) | Betrieb | `infra/openclaw/runner/README.md` |
| WP-009 | Coding-Agent-Pilot (synthetischer Sandbox-Test: Telegram-Freigabe → Warteschlange → Podman-Sandbox → Tests → Bericht) – Implementierer: Coding-Agent (DeepSeek über OpenClaw) | **Spezifiziert** – Pilot vom Betreiber im Chat freigegeben (2026-11-09), STATUS-Eintrag ausstehend | WP-007 (Installation/Umschaltung), WP-008 (Podman-Sandbox, PR #9), WP-010 Coding-Runner (noch zu planen) | Planung 100 % · Umsetzung 0 % | [WP-009/](WP-009/SPEZIFIKATION.md) |
| WP-011 | Codex als automatischer Code-Reviewer (ChatGPT-OAuth, Kontingent-Gate 80 % in beiden Fenstern, max. 3 Korrekturrunden) | **Umgesetzt im PR**, nicht installiert; Anmeldung/Messung unverifiziert | WP-010 (PR #13), Betreiber: Device-Code-Anmeldung | Code/Tests fertig (104 Tests) | [WP-011/](WP-011/SPEZIFIKATION.md) |
| WP-012 | Gemini als optionaler, beratender Zusatz-Reviewer (API-Schlüssel, nur synthetische Beispiele, eigenes Anfragebudget) | **Umgesetzt im PR**, nicht installiert | WP-011 | Code/Tests fertig (123 Tests) | [WP-012/](WP-012/SPEZIFIKATION.md) |
| WP-005 | DeepSeek-Entwicklungsumgebung (isolierter Dev-Container, Proxy-Allowlist, Sicherheitsabnahme) – Implementierer: Claude (Henne-Ei, siehe Auftrag) | **Spezifiziert – wartet auf Entscheidungen E57–E63 und Freigabe** | E57–E63; blockiert GT-ADS-001 | Planung 100 % · Umsetzung 0 % | [WP-005/](WP-005/SPEZIFIKATION.md) |
| GT-ADS-001 | Android-Geräteregistrierung (Handy ↔ Testbackend ↔ Dashboard) | **Spezifiziert – wartet auf Freigabe** | Endgültige Freigabe fehlt; **WP-005 (DeepSeek-Umgebung) zuerst**; E45–E51, Q-004 vorläufig 🟦; E54, E56 offen (nur U9 Android); siehe Freigabebericht | Planung 100 % · Umsetzung 0 % | [GT-ADS-001/](GT-ADS-001/SPEZIFIKATION.md) |

## Statusübersicht Katalogbausteine
Alle Bausteine `WP-xxx` stehen auf **Entwurf**; keiner begonnen. Teile erledigt durch Pakete werden hier nachgeführt.
| Baustein | Teilweise durch Paket | Bemerkung |
|---|---|---|
| WP-001, 003, 101 | GT-ADS-001 (Minimalgerüst) | Vollumfang bleibt offen |
| WP-201, 203, 204, 205, 211, 301, 302, 401, 402 | GT-ADS-001 (Teile) | siehe SPEZIFIKATION §3 |
| übrige | – | – |

## Ablauf eines Pakets
Plan (Claude: Ordner mit 5 Dateien) → **Freigabe Betreiber** → Implementierung (DeepSeek, Branch `wp/<ID>-<kurz>`) → Tests (CI/lokal) → Review (frische Claude-Sitzung) → Merge (nur Betreiber, Squash) → Done/Verifiziert. Details: `docs/prozess/ENTWICKLUNGSPROZESS.md`.
