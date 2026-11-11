# WP-006 – Telegram-Gateway (Phase 1): Spezifikation

Status: **Spezifiziert – wartet auf Freigabe durch den Betreiber; nichts implementiert, nichts installiert, kein Token eingegeben.** Stand: 2026-11-09 · Autor: Planer (Claude)
Zugehörig: [ARCHITEKTUR.md](ARCHITEKTUR.md) · [API-VERTRAG.md](API-VERTRAG.md) · [TESTPLAN.md](TESTPLAN.md) · [IMPLEMENTIERUNGSAUFTRAG.md](IMPLEMENTIERUNGSAUFTRAG.md) · Übergeordnet: `docs/prozess/TELEGRAM_STEUERUNG.md` (Prüfung, Optionen, Quellen)
Kennzeichen: ✅ bestätigt · 🟦 vorläufig · 🔧 Annahme/Test · ⚖️ rechtlich zu prüfen · **[A]** Annahme dieses Pakets (konfigurierbar) · **[V]** nicht verifiziert.

## 1. Ziel
Ein kleiner, auditierbarer Dienst auf dem VPS, über den der Betreiber per Telegram (Bot `Dipshit28_bot`) **chatten, den Agentenstatus abfragen und einfache Fragen an DeepSeek stellen** kann – **ohne** Shell, Dateiänderung, Git-Push, Merge oder Deployment, ohne neue öffentliche Ports, mit Autostart nach Neustart.

## 2. Entscheidungsstand (Betreiberantworten 2026-11-09)
| # | Stand | Inhalt |
|---|---|---|
| E57′ | ✅ | Ort: **VPS** (Chat-Agent); privilegierte Einrichtung später nur mit ausdrücklicher Freigabe |
| E61 | ✅ | **Kein hartes Limit beim Anbieter**; Obergrenze = **vorab geladenes Guthaben, Auto-Aufladung aus** (Betreiberangabe). Zusätzlich Schutzlimit im Gateway (E73) |
| E62 | ✅ | **ja** (bestätigt 2026-11-09; zuvor „la“): Chat-Inhalte dürfen an DeepSeek und über Telegram. ⚖️ Rechtliche Prüfung der Anbieterbedingungen bleibt beim Betreiber; Projektdokumente (Phase 1b) nur mit E70 |
| E68 | **offen** | Es wurde der **Bot-Link** genannt, nicht die **numerische Telegram-Benutzer-ID** → Ermittlung im Setup-Modus (ARCHITEKTUR §6) |
| E58, E69, E70, E71, E72, E73 | 🟦 | Vorschläge ohne Widerspruch übernommen: Modell `deepseek-flash` (konfigurierbar) · Variante **M** (Eigenbau, Python-Standardbibliothek) · Dokumentenzugriff erst Phase 1b · privilegierte Einrichtung durch den Betreiber mit `sudo` · **keine Chat-Inhalte speichern** · Tageslimit [A] |

## 3. Einordnung (Quellen)
ADR-0008 (Agenten isoliert), `KI_REGELN.md` §4, `DATENTRENNUNG.md` §2.10, `GITHUB_ARBEITSWEISE.md` §3 (Inhalte sind Daten, nie Freigaben), `TELEGRAM_STEUERUNG.md` §3–§5, Quellenprüfung DeepSeek-Modell `deepseek-flash` (V4.1-Flash-1017).

## 4. Nicht-Ziele
Shell-/Datei-/Git-/Merge-/Deployment-Fähigkeit · Zugriff auf Projektdokumente (**Phase 1b**, eigenes Paket) · Aufgabenwarteschlange/Coding-Aufträge (**Phase 2**) · Webhook oder jeder eingehende Port · Gruppen, Kanäle, Inline, Medien, Sprachnachrichten · Gesprächsgedächtnis/Verlauf · OpenClaw oder andere Fremd-Agentensoftware · Änderung an Firewall/UFW · Zugriff auf `/srv/taxiwerbung`, Secrets, Docker · Kundendaten.

## 5. Akzeptanzkriterien
| ID | Kriterium | Quelle |
|---|---|---|
| AC-01 | Long Polling (`getUpdates`), **keine** eingehende Verbindung, **kein** Webhook, `ss -tlnp` zeigt **keinen** neuen Port | Auftrag 1 |
| AC-02 | Verarbeitet werden **nur** private Chats **und** `from.id` = konfigurierte Betreiber-ID **und** kein Bot-Absender **und** Textnachricht; alles andere wird **ohne Antwort** verworfen und nur gezählt | Auftrag 3, 4 |
| AC-03 | Gruppen, Kanäle, `edited_message`, Callback-Queries, Inline, Medien, Weiterleitungen fremder Nutzer werden nicht verarbeitet (`allowed_updates=["message"]`, zusätzlich Filter im Code) | Auftrag 4 |
| AC-04 | `/start` liefert festen Text (Hinweis „nur Chat, schreibgeschützt"), `/status` liefert den Statusblock nach API-VERTRAG §3 **ohne** Geheimnisse/Pfade/IDs, freie Nachricht → eine Antwort von DeepSeek (`deepseek-flash`, konfigurierbar) | Auftrag 5, Tests |
| AC-05 | **Kein** Werkzeug: im Code kein `subprocess`, `os.system`, `eval/exec`, kein Dateischreiben außer Zustandsdatei, keine frei wählbare URL/Host (Zielhosts fest: `api.telegram.org`, `api.deepseek.com`) | Auftrag 6, 7 |
| AC-06 | Nur Python-**Standardbibliothek** (keine Fremdpakete, kein Node) | Entscheidung E69 |
| AC-07 | Geheimnisse (Bot-Token, DeepSeek-Schlüssel) **nur** über systemd-Credentials aus root-eigenen Dateien; nie in Repo, Konfiguration, Logs, Fehlermeldungen, `ps`, Statusausgabe | Auftrag 2, 10 |
| AC-08 | Logs enthalten **nur Metadaten** (Zeit, Ereignisart, Länge, Ergebnis); **keine** Nachrichteninhalte, Antworten, Tokens, Telegram-IDs; Exceptions mit URL (Token im Pfad) werden **redigiert** | E72, S-… |
| AC-09 | Schutzlimits: max. Eingabelänge, max. Antwort-Tokens, Ratenlimit, **Tageslimit**; bei Überschreitung höfliche Kurzantwort/Verwerfen, kein Modellaufruf | E73 |
| AC-10 | Fehlerrobust: Netz-/API-Fehler → Backoff, Dienst läuft weiter; Modell nicht erreichbar/Guthaben leer → `/status` zeigt „Modell nicht verfügbar", genau **eine** Hinweisnachricht je Störungsphase | Betrieb |
| AC-11 | systemd-Dienst unter `taxiagent`, Härtung nach ARCHITEKTUR §4, `systemd-analyze security` dokumentiert; Code **root-eigen und für `taxiagent` nur lesbar** | Auftrag 9, 10 |
| AC-12 | Autostart: `enabled`, `Restart=on-failure`, `After=network-online.target`; Nachweis per `systemctl restart` + `is-enabled`; echter Neustart **nur mit Zustimmung** | Auftrag 9 |
| AC-13 | Setup-Modus für E68: zeitlich begrenzt (≤ 10 min [A]), nur numerische ID im Journal, **keine** Antworten, danach automatisch beendet; Normalmodus startet nicht ohne Betreiber-ID | E68 |
| AC-14 | Zugangsdaten-Skript: Eingabe per verstecktem Prompt, Dateirechte 0600 root, Validierung ohne Ausgabe des Werts, kein Wert in Shell-History/Prozessliste | Auftrag 2 |
| AC-15 | Installations-/Deinstallationsskript nur von **Betreiber mit sudo** ausführbar, mit Trockenlauf, Rollback, ohne Firewall-/Port-/Benutzeränderung außer Verzeichnissen und Unit | Auftrag 10 |
| AC-16 | Tests (TESTPLAN) ausgeführt, echte Ausgabe im PR; manuelle Tests nur `/start`, `/status`, eine einfache Nachricht (+ Negativtests) | Auftrag „Teste zuerst" |
| AC-17 | Keine Änderung am VPS durch das Paket selbst (Dateien im Repo); Installation separater, freigabepflichtiger Schritt S5 | Prozess |

## 6. Konfiguration und Standardwerte (alle **[A]**, Datei `/etc/gt-ads/telegram-gateway.toml`, nicht geheim)
`allowed_user_id` (E68) · `model = "deepseek-flash"` · `max_input_chars = 2000` · `max_output_tokens = 800` · `rate_per_minute = 5` · `daily_message_limit = 100` · `poll_timeout_s = 50` · `http_timeout_s = 60` · `setup_mode_max_s = 600` · `status_text_language = "de"`. Werte sind Vorschläge; E73 bestätigt oder ändert sie.

## 7. Definition of Done (zusätzlich zu `DEFINITION_OF_DONE.md`)
AC-01…AC-17 einzeln belegt · alle Unit-/Integrationstests ausgeführt und grün (echte Ausgabe) · statische Prüfungen (nur Standardbibliothek, verbotene Aufrufe) grün · Review (frische Sitzung bzw. Betreiber) · Merge nur nach „Merge freigegeben" · Installation (S5) und Handytest (Telegram) durch den Betreiber, Ergebnisse protokolliert · Rollback beschrieben und getestet (Trockenlauf).

## 8. Blocker vor Freigabe/Start
Betreiberfreigabe WP-006 · (E62 bestätigt 2026-11-09) · E68 (ID, Setup-Modus) · S1 (BotFather: Gruppen deaktivieren, Privacy-Modus; Token ggf. rotieren) · DeepSeek-Schlüssel erzeugt (Betreiber) · PR #4-Kette gemergt bzw. Rebase. Das Gateway läuft **nicht** vor S5.

## 9. Risiken (Auszug; vollständig `TELEGRAM_STEUERUNG.md` §3)
Bot-Name öffentlich (Verwerfen ohne Antwort) · Telegram sieht Nachrichten (E62) · Token auf dem Server (Credentials, Rotation, Widerruf) · Prompt-Injection über Chat (kein Werkzeug vorhanden → begrenzter Schaden; Modellantworten sind Text) · Guthaben leert sich (Tageslimit) · Eigenbau-Fehler (kleiner Umfang, Tests) · ausgehender Verkehr nicht per Firewall begrenzt (Restrisiko bei Codekompromittierung; spätere Härtung mit Freigabe).
