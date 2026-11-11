# Telegram-Steuerung des KI-Agenten – Installationsstand, Prüfung und Plan

Status: **PLAN – nichts installiert, kein Token eingegeben, kein Dienst angelegt, keine privilegierte Änderung.** Stand: 2026-11-09 · Autor: Planer (Claude)
Auftrag (Betreiber, 2026-11-09): Telegram-Bot in die geplante 24/7-DeepSeek-Agenteninfrastruktur auf dem Contabo-VPS integrieren; zunächst nur `/start`, `/status`, einfache Nachricht an DeepSeek; keine Shell, keine Dateiänderungen, kein Git-Push/Merge/Deployment; Coding-Aufträge später nur über geprüfte Warteschlange mit dokumentierten Freigaben.
Kennzeichen: ✅ bestätigt · 🟦 vorläufig · 🔧 Annahme/Test · ⚖️ rechtlich zu prüfen · **[Q]** aus gelesener Quelle (2026-11-09), nur Übersichtsseiten/README geprüft, keine vollständige Konfigurationsreferenz · **[V]** nicht verifiziert.

## 1. Installationsstand (tatsächlich geprüft am 2026-11-09)
| Gegenstand | Befund |
|---|---|
| OpenClaw/Clawdbot/Moltbot | **nicht installiert** (kein Befehl, keine Verzeichnisse) |
| Node.js/npm | **nicht installiert** (nur `python3` und Docker vorhanden) |
| Bot-/Agent-Dienste (systemd) | **keine** Units (`lxd-agent.service` ist ein Systemdienst des Anbieters) |
| Benutzer `taxiagent` | existiert (uid 999, Shell `nologin`, **keine** sudo-Rechte, Home `/srv/taxiagents` 750) – bisher ungenutzt |
| Öffentliche Ports | nur SSH (22); **kein** neuer Port nötig (Long Polling ist ausgehend) |
| DeepSeek-Konto/-Schlüssel, Bot-Token auf dem Server | **nicht vorhanden** |
| Zugehörige Entscheidungen | E57′/E61/E62 **entschieden** (siehe §8); E68 (ID) offen; WP-005 nicht freigegeben |
Die „geplante 24/7-Agenteninfrastruktur auf dem VPS" existiert **nur als Option B** im Plan `DEEPSEEK_ENTWICKLUNGSUMGEBUNG.md` (Empfehlung dort: PC); eine Architektur wurde **nicht** gewählt (E60 offen). Dieses Dokument konkretisiert Option B für den **Chat-Agenten**.

## 2. Geprüfte Quellen (Fakten)
- **DeepSeek-API-Dokumentation** (api-docs.deepseek.com, Seite „pricing/quick_start") **[Q]**: Modellname **`deepseek-flash`**, aktuell bedient von **DeepSeek-V4.1-Flash-1017**; Basis-URL `https://api.deepseek.com` (OpenAI-Format), `https://api.deepseek.com/anthropic` (Anthropic-Format); ältere Namen (`deepseek-v4-flash`, `…-vision-exp`) sind außer Betrieb. → „V4.1 Flash" ist **bestätigt**; Modellname im Code als Konfiguration führen (kann sich ändern).
- **OpenClaw** (github.com/openclaw/openclaw, README, SECURITY.md; docs.openclaw.ai Übersichtsseiten; npm-Registry) **[Q]**: Open Source (MIT), sehr verbreitet, aktiv gepflegt; npm-Version **2026.11.2 vom 2026-11-08** (einen Tag alt); **Node ≥ 24.16 (<25) oder ≥ 26.1** nötig; **68 direkte Abhängigkeiten**, `preinstall`/`postinstall`-Skripte (Installation per `npm install -g openclaw@latest --allow-scripts=openclaw`); `openclaw onboard --install-daemon` richtet einen Dienst ein; Telegram über **Long Polling (Standard)**; **DM-Richtlinie Standard „pairing"**, Freigabe per `openclaw pairing approve <channel> <code>`; Optionen DM-Zugriff `pairing|allowlist|open|disabled`; **„Tools laufen auf dem Host der Hauptsitzung, solange Sandboxing nicht konfiguriert ist"**; Vertrauensmodell: **„lokale Agenteninfrastruktur für vertrauenswürdige Betreiber"**, „wer einen Agenten bedienen kann, kann ihn alles tun lassen, was er kann"; Prompt-Injection ohne Umgehung einer Richtlinie/Sandbox gilt laut SECURITY.md **nicht** als Sicherheitslücke; Kommandos wie `openclaw security audit` werden erwähnt.
- **Telegram:** Bots sind für jeden auffindbar (öffentlicher Benutzername); Nachrichten laufen über Telegram-Server (nicht Ende-zu-Ende verschlüsselt) **[V]** – Datenschutzfrage E62/E72.

## 3. Konflikte und Risiken
| # | Befund | Folge |
|---|---|---|
| K-20 | Auftrag „VPS" vs. Plan „PC (E57 = A)" | E57 für den Chat-Agenten **neu entscheiden**; Option B braucht privilegierte Einrichtung (sudo, systemd) und erhöht die Nähe zur späteren Produktion |
| K-21 | Anbieter/Budget/Vertraulichkeit offen (E58/E61/E62) | Nachrichten **und** gelesene Projektdokumente gehen an DeepSeek; vor Start entscheiden ⚖️ |
| K-22 | OpenClaw führt Tools standardmäßig **auf dem Host** aus; Auftrag verlangt „keine Shell/Dateiänderung" | nur mit strikter Tool-Policy + Sandbox vertretbar; Standardinstallation **nicht** zulässig |
| K-23 | OpenClaw: Node 24 nicht vorhanden, 68 Abhängigkeiten, Install-Skripte, 1 Tag alte Version, großes Plugin-/Skill-Ökosystem | große Lieferketten- und Angriffsfläche auf einem Host, der später Produktion trägt |
| K-24 | „Pairing aktivieren **und** nur meine ID autorisieren": Pairing erlaubt zunächst *jedem* eine Anfrage | Ziel erreichen mit **Allowlist (nur numerische Betreiber-ID)**; Pairing nur zur einmaligen ID-Ermittlung, danach aus |
| K-25 | Bot-Benutzername ist öffentlich | Gruppen auch bei Telegram sperren (BotFather), unbekannte Absender **ohne Antwort** verwerfen |
| K-26 | „Lesender Zugriff auf freigegebene Dokumente" auf Host mit Repo/Skripten | nur **Kopie** von `docs/` (ohne `.git`, ohne Skripte/Secrets), schreibgeschützt |
| K-27 | Schlüssel (Bot-Token, DeepSeek-Key) liegen auf dem Server | Ablage root-lesbar via systemd-Credentials, nicht für `taxiagent` lesbar; Limits, Rotation, Widerruf |

## 4. Optionen für die Software (Entscheidung E69)
| | **M – Minimal-Gateway (Eigenbau, Python-Standardbibliothek)** | **O – OpenClaw (gehärtet)** |
|---|---|---|
| Umfang Phase 1 | `/start`, `/status`, Chat mit DeepSeek, später `/doc` (read-only) | vollständiger Agent mit Kanälen, Tools, Plugins |
| Abhängigkeiten | **keine** Fremdpakete (nur `python3` vorhanden) | Node ≥ 24, 68 Pakete + Skripte |
| Angriffsfläche | sehr klein, vollständig lesbar (~300 Zeilen **[A]**) | groß; Sicherheit hängt an korrekter Konfiguration |
| Shell/Dateischreiben | **nicht im Code vorhanden** | muss per Policy/Sandbox abgeschaltet werden |
| Warteschlange/Freigaben später | selbst zu bauen (eigenes WP) | teilweise vorhanden, aber an unsere Freigaberegeln anzupassen |
| Aufwand jetzt | WP-006: Spezifikation + Implementierung + Tests | Installation + Härtung + Evaluierung |
| Risiko | Eigenbau-Fehler → klein halten, Tests | Lieferkette, Fehlkonfiguration, Host-Tools |
**Empfehlung (🟦 Vorschlag):** **Phase 1 mit M** (erfüllt Anforderungen 1–10 mit minimaler Fläche, ohne Node, ohne Pakete). OpenClaw erst **evaluieren** (WP-005 S5 im Wegwerf-Umfeld, nicht auf dem VPS), danach über Phase 2 (Aufgabenwarteschlange) entscheiden (E60/E69). Bei Entscheidung für O gelten die Mindestvorgaben aus §6.

## 5. Zielarchitektur Phase 1 (Variante M)
- **Dienst:** `gt-ads-telegram.service` (systemd, Systemdienst), Benutzer `taxiagent` (kein Login, keine Rechte, **kein** sudo, **keine** Docker-Gruppe). Autostart nach Neustart über `WantedBy=multi-user.target`, `Restart=on-failure`.
- **Kommunikation:** ausgehend HTTPS zu `api.telegram.org` (Long Polling `getUpdates`, ~50 s) und `api.deepseek.com`; **keine** eingehenden Verbindungen, **kein** Webhook, **kein** Port. Zielhosts im Code fest verdrahtet (keine URL-Eingabe durch Nachrichten).
- **Zugriffsschutz:** Nur `chat.type == private` **und** `from.id == <Betreiber-ID>` werden verarbeitet; alles andere (andere Nutzer, Gruppen, Kanäle, Inline) wird **verworfen ohne Antwort**; Zähler im Statusblock, keine Inhalte protokolliert.
- **Funktionen Phase 1:** `/start` (feste Begrüßung, Hinweis „nur Chat, schreibgeschützt"), `/status` (Version, Laufzeit, Modellname `deepseek-flash`, Zeit des letzten erfolgreichen Polls/Modellaufrufs, Fehlerzähler, Zähler verworfener Nachrichten, Betriebsmodus „read-only", **keine** Systemgeheimnisse/Pfade), freie Nachricht → DeepSeek-Chat (Systemprompt mit Regeln; **kein** Werkzeugzugriff).
- **Grenzen:** max. Nachrichtenlänge, Ratenlimit, max. Antwort-Tokens, **Tageslimit** an Aufrufen/Tokens (Kosten), Timeouts; Konfiguration per Datei/Umgebung, Werte **[A]** festzulegen (E61).
- **Datensparsamkeit:** Logs (journald) nur Metadaten (Zeit, Typ, Länge, Ergebnis); **kein** Nachrichteninhalt, keine Antworten; Chat-Verlauf nur im Speicher (begrenzt) oder gar nicht (E72).
- **Geheimnisse:** `LoadCredential=` aus root-eigenen Dateien (`/etc/gt-ads/credentials/*`, 0600 root) → für `taxiagent` nicht direkt lesbar; Eingabe **nur** per verstecktem Terminal-Prompt (`read -rs`), nie im Chat/Repo/Log/`ps`.
- **Härtung (systemd):** `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `PrivateDevices`, `ProtectKernel*`, `RestrictAddressFamilies=AF_INET AF_INET6`, leeres `CapabilityBoundingSet`, `SystemCallFilter=@system-service`, `MemoryMax`, `CPUQuota`, `TasksMax`, schreibbar nur `/srv/taxiagents/telegram/state`, lesbar nur `/srv/taxiagents/docs-ro` (ab Phase 1b). Prüfung: `systemd-analyze security` **[A]** Ziel „OK" oder besser mit dokumentierten Ausnahmen.
- **Netzzugriff nach außen:** Phase 1 **ohne** zusätzliche Firewall-Regeln (der Code kennt nur die zwei Hosts; kein Werkzeug zum Abrufen beliebiger URLs). Restrisiko: bei Codekompromittierung wäre ausgehender HTTPS-Verkehr möglich. Optionale spätere Härtung (privilegiert, nur mit Freigabe): Egress-Allowlist per UID/Proxy.
- **Dokumentenzugriff (Phase 1b, nach E70):** schreibgeschützte **Kopie** von `docs/` aus `main` unter `/srv/taxiagents/docs-ro/` (ohne `.git`, ohne `infra/`, ohne Skripte); Aktualisierung durch `taxiadmin` (hat den Repo-Zugang), **nicht** durch den Agenten; `/doc <Suchbegriff>` liefert Textauszüge; keine Dateiliste außerhalb dieser Kopie.
- **Später (Phase 2, eigene Freigabe):** Coding-Aufträge nur als **Entwurf** in einer Aufgabenwarteschlange (Datei/PR im Repo), Ausführung erst nach dokumentierter Freigabe laut `GITHUB_ARBEITSWEISE.md`; Telegram bleibt Bedien- und Statuskanal, **nie** direkter Ausführungsweg für Shell, Push, Merge, Deployment.

## 6. Mindestvorgaben, falls OpenClaw (Variante O) gewählt wird
Erst Evaluierung im Wegwerf-Umfeld; Node nur im Benutzerbereich (Tarball mit geprüfter Prüfsumme), **keine** globale Installation; Installationsskripte vorher lesen und freigeben (`--allow-scripts` nur bewusst); Versionspinning (keine `@latest`, bewusst ältere, geprüfte Version); `dmPolicy`/Telegram **allowlist** nur numerische Betreiber-ID, Gruppen aus; alle Werkzeuge (Shell, Dateischreiben, Browser, Plugins, Skills/ClawHub, Node-Ausführung, Elevated) **verweigern**, nur lesender Dokumentenzugriff; Sandbox aktiviert; Gateway **nur Loopback**, keine Control-UI-/Tailscale-Freigabe; `openclaw security audit` ausführen und Ergebnis dokumentieren; keine Fremd-Skills/-Plugins; Update nur per freigegebenem PR.

## 7. Schritte (je getrennt freigabepflichtig)
| Schritt | Inhalt | Wer | Freigabe/Kosten |
|---|---|---|---|
| S0 | Entscheidungen §8 (E57′, E58, E61, E62, E68–E73) | Betreiber | – |
| S1 | BotFather: Gruppen **deaktivieren** (`/setjoingroups`), Privacy-Modus an; Token rotieren, falls er je außerhalb des Terminals gezeigt wurde; numerische Telegram-ID ermitteln (E68) | Betreiber | – |
| S2 | DeepSeek-Konto, API-Schlüssel mit **hartem Ausgabenlimit**, nur für dieses Projekt | Betreiber | **kostenpflichtig, ausdrücklich** |
| S3 | **WP-006 Telegram-Gateway:** Spezifikation (Claude) → Freigabe → Implementierung als PR (`apps/telegram-gateway/**`: Code, Tests, systemd-Unit-Vorlage, Credential-Skript, README) | Claude | Paketfreigabe |
| S4 | Review + Merge | frische Sitzung/Betreiber | „Merge freigegeben" |
| S5 | **Privilegierte Einrichtung** durch den Betreiber mit `sudo` anhand geprüfter Skripte: Verzeichnisse, Credentials (Token/Key per Terminal-Prompt), Unit installieren und aktivieren, Kopie `docs-ro` (Phase 1b) | Betreiber | **ausdrücklich je Schritt**; **keine** Firewall-/Portänderung |
| S6 | **Tests (nur diese):** `/start`; `/status`; eine einfache Nachricht an DeepSeek („Antworte mit OK") | Betreiber in Telegram, Claude wertet Statusausgabe/Journal-Metadaten aus | – |
| S7 | Negativtests: fremder Absender, Gruppe, Kanal werden **ohne Antwort** verworfen (zweites Telegram-Konto oder Unit-Tests mit simulierten Updates) | Betreiber/Claude | – |
| S8 | Autostart: `systemctl restart` + `is-enabled`; echter Neustart **nur mit deiner Zustimmung** | Betreiber | Neustart ausdrücklich |
| S9 | Härtungsnachweis: `systemd-analyze security`, `ss -tlnp` (kein neuer Port), Rechteprüfung `taxiagent` (kein Zugriff auf `/srv/taxiwerbung`, `/home/taxiadmin`, Secrets), Secret-Scan | Claude/Betreiber | – |
| S10 | Phase 1b (Doku-Lesezugriff) und Phase 2 (Warteschlange) als **eigene Pakete** | – | je Freigabe |
**Rollback:** `systemctl disable --now gt-ads-telegram`; Credentials löschen; Bot-Token bei BotFather widerrufen (`/revoke`); DeepSeek-Schlüssel widerrufen; Unit-Datei entfernen. Alles ohne Datenverlust (Zustandsverzeichnis enthält nur Metadaten).

## 8. Entscheidungen (neu: E68–E73; E57′ = Neubewertung)
**Stand nach Betreiberantwort 2026-11-09:** E57′ = **VPS** ✅ · E61 = **kein hartes Limit beim Anbieter; Obergrenze = vorab geladenes Guthaben, Auto-Aufladung aus** ✅ (Schutzlimit im Gateway zusätzlich, E73) · E62 = **ja** ✅ (bestätigt 2026-11-09; zuvor „la“, vermutlich Tippfehler; gilt für Chat-Inhalte, Projektdokumente erst mit E70) ⚖️ · E68 **offen** (genannt wurde der Bot-Link, nicht die numerische ID; Ermittlung im Setup-Modus) · E58/E69/E70/E71/E72/E73 = Vorschläge ohne Widerspruch (🟦). Umsetzung: Paket **WP-006** (`docs/ARBEITSPAKETE/WP-006/`).
Ursprüngliche Antwortzeile (zur Dokumentation):
Antwortzeile (Beispiel): `E57'=VPS; E58=deepseek-flash bestätigt; E61=<Betrag/Monat>; E62=<ja|nein|teils>; E68=<ID>; E69=M; E70=<Umfang>; E71=ja; E72=<keine Inhalte speichern>; E73=<Tageslimit>`
| # | Frage | Vorschlag |
|---|---|---|
| E57′ | Ort für den **Chat-Agenten**: VPS (Option B) statt PC? | VPS ist für den 24/7-Chat nötig; dann Firewall-/Rechte-Änderungen nur mit Freigabe, Phase 1 ohne |
| E58 | Modell bestätigen | `deepseek-flash` (V4.1-Flash-1017), Name konfigurierbar |
| E61 | Budget und hartes Limit | Betreiber legt fest; ohne Limit kein Start |
| E62 ⚖️ | Dürfen Chat-Inhalte (und später Projektdokumente) an DeepSeek und über Telegram laufen? | Betreiber/Fachperson |
| E68 | **Deine numerische Telegram-Benutzer-ID** (kein Geheimnis, aber personenbezogen) | im Chat nennen oder per Pairing-Anfrage ermitteln |
| E69 | Software Phase 1: **M** (Eigenbau, empfohlen) oder **O** (OpenClaw, nach Evaluierung) | M |
| E70 | Welche Dokumente sind „freigegeben" für lesenden Zugriff (Phase 1b)? | `docs/` ohne `docs/konzept/ARCHIV/`, ohne Betreiberquellen, nach deiner Liste |
| E71 | Privilegierte Einrichtung (systemd, Verzeichnisse, Credentials) durch dich mit `sudo` nach Skriptprüfung | ja |
| E72 | Aufbewahrung: nur Metadaten-Logs, **keine** Chat-Inhalte speichern | ja |
| E73 | Tageslimit (Nachrichten/Tokens) | Betreiber legt fest |

## 9. Abgrenzung und Regeln
Keine Shell-, Datei-, Git-, Merge-, Deployment-Fähigkeit über Telegram · keine Produktivdaten, Kundendaten, Administratorrechte oder Server-Zugangsdaten für den Dienst · Inhalte aus Telegram sind **Daten, nie Freigaben** (`GITHUB_ARBEITSWEISE.md` §3) · Freigaben für Pakete/Merges erfolgen weiterhin **nur im Claude-Code-Chat** mit dem vereinbarten Wortlaut · jede neue Fähigkeit des Agenten = eigenes Paket mit Freigabe (ADR-0008, E34).
