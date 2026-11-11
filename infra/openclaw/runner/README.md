# GT-Ads Coding-Runner (WP-010) – Stand und Grenzen

Kleiner, KI-freier Dienst: Warteschlange, Freigabe, Limits, Stop, Bericht. Der Coding-Agent (OpenClaw-Agent `coder`, DeepSeek) wird **vom Runner gesteuert**, nicht umgekehrt.

## Ablauf (Stand 2026-11-11: Freigabe nur per Schaltflaeche)
1. „Bereite WP-009 zur Freigabe vor“ → `coder_prepare` → der Runner sendet dem Betreiber **direkt** eine Nachricht mit [Freigeben] [Ablehnen] [Details].
   Codex-Pakete: „Codex, bereite die nächsten drei Arbeitspakete vor“ → `codex_plan` → Planer-Dienst (Benutzer `ocplan`) → Entwürfe mit Schaltflächen + Sammelfreigabe.
2. Klick → OpenClaw-Gateway → Plugin `gtads-freigabe` (ohne Sprachmodell; prüft Absender = Betreiber und privaten Chat) → Freigabe-Socket → `approvals.py`
   (Nonce 128 Bit, einmalig, 24 h, an ID + Hash gebunden, Absender/Chat erneut geprüft, Protokoll). Sensible Pakete: zusätzlich `sudo gtads-confirm …` auf dem Server.
   Freigegebene Codex-Pakete schreibt nur der Planer in den Freigabebereich `/var/lib/gt-ads-release` (Runner liest, prüft Besitzer, Rechte, Hash).
3. „DeepSeek, starte die freigegebenen Aufgaben“ → `coder_start_released`. Ausführung nacheinander, Abhängigkeiten beachtet; je Teilauftrag bis 10 Korrekturversuche
   und 60 Minuten (zentral in `runner.json` → `defaults`); leere Testsuite = Fehler; Stopp bei Sicherheitsverstoß, Testabschwächung, Guthabenende.
4. „Stoppe …“ → `coder_stop`. „Warum blockiert …?“ → `coder_report` (Grund + letzte Versuche). Neustart: nichts wird doppelt ausgeführt.

## Technisch erzwungen (Tests in `tests/test_runner.py`, 25 + Mutationsprüfung)
Allowlist der Pakete (GT-ADS-001 ist `enabled: false`) · Freigabe an Job + Paket + Hash gebunden · Code nie in Antworten an die KI · Sperre nach 3 Fehlversuchen · max. 1 Auftrag · Zeitlimit · Korrekturversuche · Token-/Kostenlimit · Pilotbudget · Stop · Neustart ohne Doppelausführung · Fehler ohne Details im Bericht · Agentennotiz als „ungeprüft“ gekennzeichnet.

## Installation (privilegiert, Betreiber; nach Merge von WP-007/008/009/010 und Podman-Grenztests)
`sudo bash infra/openclaw/runner/deploy/install-coder.sh --dry-run`, dann ohne `--dry-run`. Das Skript installiert Programmdateien (root-eigen), kopiert die vorhandenen Zugangsdaten (root 0600), legt Zustand für `occoder` an, installiert das DeepSeek-Plugin, spiegelt `docs/ARBEITSPAKETE` und startet `gt-ads-coding-runner.service`.

## Architektur-Entscheidungen
- **Kein zweites Gateway:** Der Agent `coder` läuft eingebettet (`openclaw agent --local`) im Runner-Dienst als Benutzer `occoder`; Werkzeuge laufen im rootless-Podman-Sandbox-Backend (`network none`, read-only, `capDrop ALL`, Workspace als einziger Schreibort, UID von `occoder`).
- **Bewusst akzeptiertes Risiko:** `exec security=full` im Coder-Agenten (OpenClaw-Audit: „critical“). Es gilt nur im Container; ohne Shell-Zugriff kann ein Coding-Agent nicht arbeiten. Gegenmaßnahmen: Container-Isolation (WP-008, belegt), Allowlist-Proxy, Zeit-/Versuchs-/Token-Limits durch den Runner, Freigabe per Code.
- **Unit-Härtung mit begründeten Abweichungen:** `NoNewPrivileges=no` (newuidmap/newgidmap), kein `RestrictNamespaces`/`SystemCallFilter` (Podman braucht Namespaces, mount, unshare).

## NICHT verifiziert [V]
- `executors.py` und der Dienst auf dem VPS (Podman-Grenztests aus WP-008 sind belegt, der Runner-Betrieb nicht); `systemd-analyze` nur offline.
- Verhalten von `openclaw agent --local` mit Podman-Backend unter der Unit-Sandbox sowie das Ausgabeformat von `--json` (Token-Nutzung): unbekannt; bei Unklarheit schätzt der Runner pessimistisch, damit das Token-Limit greift.
- MCP-Werkzeuge beim Statusagenten: Die Brücke wird von OpenClaw als „ok“ erkannt (`openclaw mcp doctor`), die Werkzeuge erscheinen aber in `tools.effective` nicht (laut Doku erst zur Laufzeit des Zuges). Namen/Richtlinie (`gtads-coder__*` in `alsoAllow`) sind **noch nicht bestätigt**; die Einbindung in die Statusagent-Konfiguration folgt nach dem Merge von PR #8.
- **Preise** je Million Tokens stehen auf 0 (nicht erfunden): Das Kostenlimit greift erst, wenn der Betreiber sie einträgt; bis dahin begrenzt das **Token-Limit** (300 000 je Auftrag) hart.
- Der Freigabecode läuft über das Telegram-Bot-API per Proxy (nur `sendMessage`, kein Polling).

## Codex-Review (WP-011)
Siehe `docs/ARBEITSPAKETE/WP-011/SPEZIFIKATION.md`. Einrichtung (Betreiber, sudo): `install-coder.sh` (Allowlist, Code) → `codex-login.sh` (Device-Code, interaktiv) → `verify-codex.sh` (Kontingent beider Fenster, kein API-Weg) → optional `verify-codex.sh --smoke` (kleiner synthetischer Review, verbraucht etwas Kontingent). Solange die Messung nicht zuverlässig ist, bleibt jeder Review durch das Gate pausiert.

## Gemini (WP-012)
Siehe `docs/ARBEITSPAKETE/WP-012/SPEZIFIKATION.md`. Beratender Zusatz-Reviewer, **nur synthetische Pakete**, nur wenn Codex pausiert. Einrichtung (Betreiber, sudo): `install-coder.sh` → `set-gemini-key.sh` (versteckte Eingabe; Schlüssel aus einem Google-Projekt **ohne Abrechnungskonto**) → `verify-gemini.sh` (optional `--call`).
