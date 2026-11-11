# WP-011 – Codex als automatischer Code-Reviewer: Spezifikation und Stand

Stand: 2026-11-10 · Status: **Umgesetzt (Branch/PR), nicht installiert, Anmeldung und Kontingentmessung unverifiziert** · Freigabe: Betreiber im Chat (2026-11-10): unprivilegierte Konfiguration, Implementierung und ungefährliche Tests; privilegierte Eingriffe und Merge nur mit gesonderter Zustimmung.

## 1. Rollen
Claude Code: Architektur/Spezifikation · DeepSeek (Runner): autonome Programmierung · **Codex: Review, Sicherheits- und Fehleranalyse (nur lesend)** · Gemini: optional, **nicht eingerichtet** · OpenClaw: Koordination, Telegram, Status.

## 2. Anmeldung und Kosten
- Ausschließlich ChatGPT/Codex-OAuth des bestehenden Abos, Anmeldung per Device-Code (`openclaw models auth login --provider openai --device-code --agent reviewer`, Skript `codex-login.sh`, Benutzer `occoder`). Voraussetzung laut OpenAI: Device-Code-Anmeldung in den ChatGPT-Sicherheitseinstellungen aktiviert.
- **Kein API-Key, keine API-Abrechnung:** `api.openai.com` steht **nicht** in der Egress-Allowlist (nur `auth.openai.com`, `chatgpt.com`); die Reviewer-Umgebung enthält keine `OPENAI_API_KEY`/`CODEX_API_KEY`; `verify-codex.sh` prüft das.
- Der Reviewer nutzt OpenClaws eigene Laufzeit (`agentRuntime.id: "openclaw"`), nicht den Codex-App-Server: unsere Werkzeugpolitik gilt. Modell laut OpenClaw-Doku für Abo-Login: `openai/gpt-6-astra`; **nach dem Login zu bestätigen** (`models list`).

## 3. Kontingent-Gate (technisch erzwungen, `runner/quota.py`, 18 Tests + Mutationsprüfung)
Quelle: von OpenClaw gelieferter Anbieter-Snapshot (`status --usage --json`, ruft `chatgpt.com/backend-api/wham/usage` ab, **kontoweit**). Ein Review startet nur, wenn **beide** Fenster (5 h und Woche) gemessen sind und je Fenster `Auslastung + Reserve ≤ 80 %` gilt. Die Reserve beträgt mindestens 10 Punkte oder das 1,5-Fache des größten gemessenen Review-Verbrauchs. Gesperrt bei: fehlendem Fenster, falscher Bezeichnung, fehlender/unplausibler Prozentzahl oder Rücksetzzeit, veralteter Messung (> 120 s), Fehler beim Abruf, **Anomalie** (Auslastung sinkt im selben Fenster; Schutz gegen OpenClaws stilles `used_percent || 0`). Es wird nie geschätzt.
**Wichtige Grenze:** Hat der Tarif kein 5-Stunden-Fenster (laut OpenAI-Hilfecenter u. a. Pro-Tarife), ist nur ein Fenster messbar → Codex bleibt gesperrt (Vorgabe des Betreibers).
**Gemeinsamer Pool:** Laut OpenAI teilen sich Codex und ChatGPT Work die Limits. Die 20-%-Reserve ist daher keine Garantie für unbegrenzte ChatGPT-Nutzung.

## 4. Review-Ablauf (`runner/review_core.py`, 16 + 5 Tests)
Auftrag erfolgreich (Tests grün) → unveränderlicher Schnappschuss (Commit + SHA-256) → Review wartet → Gate → Codex liest nur (Workspace read-only) → Bericht streng validiert (Struktur, Schwere, Kategorie, Pfad ohne `..`, Zeile ≥ 1) → **Fundstellen objektiv geprüft** (Datei vorhanden, Zeile existiert; nur hoch/mittel gelten als bestätigt) → DeepSeek korrigiert bestätigte Fehler (Budget des Auftrags, Tests, Commit) → Folge-Review. **Höchstens drei Korrekturrunden.** Kein Merge, kein Deployment. Ohne Kontingent bleibt der Review pausiert; DeepSeek arbeitet weiter; nichts wird ungeprüft übernommen.

## 5. Telegram
Neue MCP-Werkzeuge `coder_limits`, `coder_reviews`, `coder_review_findings`, `coder_agents`; der Chatbot beantwortet `/limits`, `/codex`, `/reviews`, `/agenten` und die gewünschten Fragen nur aus diesen Daten (Anweisung in `AGENTS.md` des Statusagenten). Review-Berichte kommen vom Runner direkt per Telegram.

## 6. Nicht verifiziert [V] / offen
- Anmeldung per Device-Code, Kontoprofil/Tarif, tatsächlich verfügbares Modell.
- Ob der Abo-Tarif **beide** Fenster meldet (5 h und Woche); sonst bleibt Codex gesperrt.
- Ausgabeformat von `openclaw agent --json` beim Reviewer (Marker-Extraktion ist format-unabhängig, aber ungetestet gegen echte Ausgabe).
- Gemini: nicht umgesetzt (nur kostenlos und nur nach ausdrücklicher Datenfreigabe).
- Ob ChatGPT-Guthaben/Credits des Kontos bei Erschöpfung des Kontingents automatisch genutzt werden (nicht steuerbar; das Gate stoppt vor 80 %).
