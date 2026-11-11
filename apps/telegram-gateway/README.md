# GT-Ads Telegram-Gateway (Phase 1)

Kleiner Dienst: Der Betreiber kann per Telegram **chatten**, den **Status** abfragen und einfache Fragen an **DeepSeek** stellen.
**Nur Chat, schreibgeschützt.** Kein Shell-, Datei-, Git-, Merge- oder Deployment-Zugriff; im Code gibt es dafür keine Funktion.
Spezifikation: `docs/ARBEITSPAKETE/WP-006/` · Plan und Sicherheitsüberlegungen: `docs/prozess/TELEGRAM_STEUERUNG.md`.

## Eigenschaften
- **Nur Python-Standardbibliothek** (Python ≥ 3.11; auf dem VPS 3.12). Keine Fremdpakete, kein Node.
- **Long Polling** (`getUpdates`), nur **ausgehende** HTTPS-Verbindungen zu `api.telegram.org` und `api.deepseek.com` (feste Konstanten). **Kein** Webhook, **kein** Port.
- **Zugriffsschutz:** Verarbeitet wird nur ein privater Textchat des konfigurierten Betreibers (`allowed_user_id`). Gruppen, Kanäle, andere Nutzer, Bots, Weiterleitungen, Medien, bearbeitete Nachrichten, Inline/Callbacks werden **ohne Antwort verworfen** und nur gezählt.
- **Befehle:** `/start`, `/status`; freier Text → DeepSeek (Modell `deepseek-flash`, ohne Verlauf, ohne Werkzeuge, Denkmodus aus).
- **Limits:** Eingabelänge, Ausgabe-Tokens, Ratenlimit pro Minute, Tageslimit (Schutz des Prepaid-Guthabens).
- **Datensparsamkeit:** Logs und Zustandsdatei enthalten nur Metadaten, **keine** Nachrichten, Antworten, Token, Schlüssel oder IDs (Ausnahme: Setup-Modus loggt die numerische Absender-ID).
- **Geheimnisse:** nur als systemd-Credentials aus root-eigenen Dateien; nie in Repo, Konfiguration, Logs oder Prozessliste.

## Aufbau
`gtads_tg/` `config` · `policy` · `telegram` · `deepseek` · `commands` · `state` · `redact` · `main`. Tests unter `tests/`, Betriebsdateien unter `deploy/`, Beispielkonfiguration unter `config/`.

## Tests (lokal, ohne Netzzugriff)
```
cd apps/telegram-gateway
python3 -W error -m unittest discover -s tests -t . -v
```
Die Tests verwenden ausschließlich lokale Fakes und synthetische Werte. Zusätzlich: `bash -n deploy/*.sh`, `systemd-analyze verify deploy/gt-ads-telegram.service`, `systemd-analyze security --offline=true deploy/gt-ads-telegram.service`.

## Einrichtung und Betrieb
Siehe [`deploy/README.md`](deploy/README.md). Installation **nur durch den Betreiber mit `sudo`** nach Freigabe (Schritt S5).

## Bekannte Grenzen und Annahmen
- Ausgehender Netzverkehr ist **nicht** per Firewall begrenzt; Schutz bietet der Code (feste Hosts, kein Werkzeug). Optionale spätere Härtung (privilegiert, nur mit Freigabe): Egress-Allowlist.
- Parameter der Telegram-Bot-API und der DeepSeek-API wurden am 2026-11-09 gegen die aktuelle Dokumentation geprüft; Änderungen der Anbieter sind im Review zu prüfen.
- Modellname und Standardwerte (Limits) sind Annahmen und konfigurierbar (`config/telegram-gateway.toml.example`).
- Echter Betrieb mit Telegram/DeepSeek wurde **nicht** getestet; das geschieht erst nach Einrichtung durch den Betreiber (Tests M-01…M-03 in `docs/ARBEITSPAKETE/WP-006/TESTPLAN.md`).
