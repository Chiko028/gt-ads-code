# WP-006 – Implementierungsauftrag

**Freigabestatus: AUSSTEHEND.** Nicht beginnen, bevor der Betreiber WP-006 in `docs/fortschritt/STATUS.md` auf **„Freigegeben"** setzt. Fehlt etwas oder passt etwas nicht: **stoppen und melden.**
Implementierer: **Claude** (die DeepSeek-Umgebung WP-005 existiert noch nicht). Review durch frische Sitzung bzw. Betreiber (E64).

## 1. Kontext (ohne Chatverweise)
GT-Ads plant einen kleinen Telegram-Chatdienst auf dem Contabo-VPS (Phase 1: nur `/start`, `/status` und Chat mit DeepSeek). Das Paket liefert **nur Dateien im Repo** (`apps/telegram-gateway/**`). Auf dem VPS wird in diesem Paket **nichts** installiert oder verändert; Installation ist ein separater, vom Betreiber mit `sudo` ausgeführter Schritt (S5) nach Freigabe.

## 2. Pflichtlektüre
`CLAUDE.md`, `KI_REGELN.md`, `docs/fortschritt/STATUS.md`, `docs/prozess/TELEGRAM_STEUERUNG.md`, `docs/prozess/GITHUB_ARBEITSWEISE.md` (§3, §6, §10), alle Dateien in `docs/ARBEITSPAKETE/WP-006/`, `DEFINITION_OF_DONE.md`, `DATENTRENNUNG.md`.

## 3. Harte Regeln
- Branch `wp/WP-006-telegram-gateway` von aktuellem `main`; nie auf `main` pushen; PR per `gh`; Merge nur nach „Merge freigegeben".
- Nur Pfade aus `ARCHITEKTUR.md` §2; nichts unter `infra/server-setup/**`, `.github/**`, `docs/architektur/vertraege/**`, `docs/entscheidungen/adr/**`, `docs/entscheidungen/OFFENE_ENTSCHEIDUNGEN.md`.
- **Nur Python-Standardbibliothek.** Keine Fremdpakete, kein Node, keine neue Technologie.
- **Kein Werkzeug im Code:** kein `subprocess`/`os.system`/`eval`/`exec`, keine frei wählbaren Hosts/URLs, kein Dateischreiben außer Zustandsdatei, keine Funktion für Shell/Git/Merge/Deployment.
- **Keine Geheimnisse:** keine echten Token/Schlüssel/IDs im Repo, in Tests, Logs, Doku; Fake-Werte nur als offensichtliche Testwerte.
- **Kein Zugriff auf den echten Telegram-/DeepSeek-Dienst** während der Entwicklung (nur lokale Fakes). Kein Token vom Betreiber im Chat anfordern.
- Keine Änderung an UFW/Firewall/SSH/Benutzern; Skripte müssen `--dry-run` unterstützen und dürfen nur die in ARCHITEKTUR §4/§7 genannten Dinge tun.
- Aktuelle Bot-API-/DeepSeek-Dokumentation vor Umsetzung der Aufrufe prüfen; Abweichungen vom Vertrag melden, nicht stillschweigend anpassen.
- Nichts als „getestet" melden, was nur der Betreiber auf dem VPS/Telegram ausführen kann.

## 4. Unteraufgaben (je Commit `WP-006: U<n> …`)
| U | Inhalt | Dateien | Tests |
|---|---|---|---|
| U1 | Konfiguration, Credentials-Lesen, Redaktion | `config.py`, `redact.py` | U-08, U-09, U-10 |
| U2 | Policy, Limits (Rate/Tag, Uhr injizierbar) | `policy.py` | U-01…U-06 |
| U3 | Telegram-Client, DeepSeek-Client (Fehlerklassen) | `telegram.py`, `deepseek.py` | U-11, U-12, I-04 |
| U4 | Befehle, Zustand, Statusblock | `commands.py`, `state.py` | U-07, I-07 |
| U5 | Hauptschleife, Backoff, Setup-Modus, Signale | `main.py` | U-13, U-14, I-01, I-02, I-03, I-05 |
| U6 | Integrations-/Statik-Tests | `tests/**` | I-06, I-08, I-09, ST-01…ST-04 |
| U7 | systemd-Unit-Vorlage, Skripte, Beispielkonfiguration | `deploy/**`, `config/**` | ST-05, ST-06 |
| U8 | README, Betriebsanleitung (Schritte S5, Rollback, Prüfbefehle) | `README.md`, `deploy/README.md` | ST-07, ST-08 |
| U9 | Testlauf, PR, Abschlussbericht | – | echte Ausgabe |
| U10 | Betreiber-Schritte begleiten: S1/S2 (Voraussetzungen), S5 (Einrichtung), Tests M-01…M-03, OP-01…OP-06 | – | Auswertung |

## 5. Definition of Done
Siehe `SPEZIFIKATION.md` §7. PR-Beschreibung mit AC-Tabelle, **automatisch ermittelter** Liste geschützter Pfade, ausdrücklicher Liste der **nicht ausgeführten (Betreiber-)Tests**.

## 6. Stoppregeln
Widerspruch zwischen Dokumenten · geänderte/fehlende Entscheidung (E68 offen bei Normalmodus, E69 ≠ M, E62 widerrufen) · Wunsch nach Werkzeug-/Dateizugriff im Code · neue Abhängigkeit nötig · Verdacht auf Geheimnis im Repo · Änderung an geschützten Pfaden/Firewall nötig · Abweichung der Bot-API/DeepSeek-Dokumentation vom Vertrag. Meldeformat: `Q-0nn: <Frage>; Kontext; Optionen; Blockiert`.

## 7. Abschlussbericht
Format `GITHUB_ARBEITSWEISE.md` §5 (PR, Head-SHA, Änderungen, Tests mit echter Ausgabe, geschützte Pfade, Review, Risiken, Empfehlung).
