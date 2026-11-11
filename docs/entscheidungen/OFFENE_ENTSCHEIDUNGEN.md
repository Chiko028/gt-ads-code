# GT-Ads – Offene Entscheidungen (für den Betreiber)

Stand: 2026-11-09 · Spalte „Frist" bezieht sich auf die Phase in `ROADMAP.md`, vor der die Entscheidung gebraucht wird. 🔴 = blockiert den Start der genannten Phase · 🟡 = vor dem Pilot · 🟢 = später.
Mein Vorschlag steht jeweils dabei; er ist **keine** Entscheidung.

## A. Sofort nötig (blockiert Entwicklung oder Pilotstart)
| # | Frage | Vorschlag / Optionen | Frist |
|---|---|---|---|
| E1 🔴 | **Domain** (für TLS und Tablets): Name, Registrar? | `gt-ads.<tld>`; Subdomains `api.`, `admin.` (Kosten: Domain, gering) | P2 optional, spätestens P8 |
| E2 🔴 | **Öffentliche Erreichbarkeit:** Ports 80/443 öffnen oder Cloudflare-Tunnel? | 443 nur für Geräte-API; Admin über Tailscale | P8 |
| E3 🔴 | **Pilotgröße:** wie viele Taxis/Tablets, welche Partner? | Feldtest 2–3 Taxis, Pilot ~10 Taxis | P1 |
| E4 🔴 | **Rechts-/Steuerprüfung** (Werbung im Taxi Wien, Abgaben, DSGVO, Verträge): wer prüft? | Anwalt + Steuerberater, **vor** Hardware-Serienkauf | P1 |
| E5 🔴 | **Budgetrahmen** für Pilot (Hardware, SIM, Montage, Domain, Backup-Ziel, Beratung) | Obergrenze festlegen; Freigabe je Posten | P1 |

## B. Produkt und Geschäft
| # | Frage | Vorschlag / Optionen |
|---|---|---|
| E6 🟡 | Endgültige Preise/Pakete (je Platz, je Gruppe, Laufzeit, Rabatt) | im Pilot testen; Mindestpreis aus `KONZEPT.md` §3 als Untergrenze |
| E7 🟡 | Buchungs- und Vergütungsmodell Partner (fix 80 € oder variabel/umsatzabhängig) | Start fix, Datenmodell für variabel vorbereiten |
| E8 🟡 | Details Werbeschleife: 12→16 Plätze, Spotlänge fix 15 s oder variabel, Reihenfolge fix/rotierend, Exklusivität | Start: 12 Plätze fix à 15 s, feste Reihenfolge |
| E9 ✅ | Wiedergabe bei betriebsbereitem Fahrzeug, gültiger Kampagne, ohne Pause; ohne Fahrgasterkennung (Protokoll v2.0 §1) | entschieden 2026-11-09 |
| E10 🟡 | Ton: stumm/leise/auf Wunsch | Start stumm (Fahrgastkomfort, Rechtsrisiko) |
| E11 🟡 | Inhaltsrichtlinien/Freigabeprozess für Motive (Verbotsliste, Prüfer) | Manuelle Freigabe durch Betreiber vor Live |
| E12 🟢 | Kundenportal/Self-Service: wann, welcher Umfang | nach G4; MVP nur interner Betrieb |
| E13 🟢 | Interaktion (QR-Codes, Aktionscodes) | V3 |

## C. Hardware und Betrieb
| # | Frage | Vorschlag / Optionen |
|---|---|---|
| E14 🔴 | **Tablet-Modell(e)** und Android-Version | 2–3 Modelle im Bench-Test vergleichen; Kriterien: Temperatur, Dauerbetrieb, Device-Owner-Support, Updates, Preis |
| E15 🟡 | Strom: Zündungsschaltung, Dauerplus, Schutz (Sicherung, Überspannung), Fachmontage durch Werkstatt? | Fachbetrieb, Zündungsplus mit Nachlaufzeit |
| E16 🟡 | Mobilfunk: SIM je Tablet vs. ein Router je Taxi; Anbieter; Datenvolumen/Pooltarif | im Pilot beide Varianten messen |
| E17 🟡 | Halterung/Diebstahlschutz, Versicherung, Haftung bei Schäden | Abschließbar; Klärung mit Versicherung/Partner |
| E18 🟡 | Fernverwaltung: **Eigenbau Device-Owner** oder MDM (Open Source/Zukauf)? Remote-Support-Zugriff? | Eigenbau für MVP, MDM im Pilot bewerten |
| E19 🟡 | Support-Prozess: Wer fährt bei Defekt hin, Ersatzbestand (≈ 10 %), Reaktionszeit gegenüber Partnern | Festlegen vor Pilot |

## D. Daten, Datenschutz und Technik
| # | Frage | Vorschlag / Optionen |
|---|---|---|
| E20 ✅ | **GPS:** Fähigkeit vorsehen, Betreiber-Schalter, Standard **AUS**, Modi aus/lokal/Übermittlung; Nutzung erst nach Freigaben | entschieden 2026-11-09 · Freigabe ⚖️ offen |
| E21 🟦 | Fahrgasterkennung: optionales Modul, nicht im MVP; Sensorpilot nach Datenschutzprüfung, keine Bildspeicherung | vorläufig 2026-11-09 |
| E22 🟡 | Aufbewahrung Rohereignisse (60/90 Tage) und Aggregate | 90 Tage Rohdaten, Aggregate dauerhaft |
| E23 🟡 | **Offsite-Backup:** Anbieter/Ziel (kostenpflichtig), Aufbewahrung | Objektspeicher/Storage in EU; Budget in E5 |
| E24 🟡 | Medienspeicher: lokal auf VPS (190 GB) vs. Objektspeicher; Originale wo? | lokal + Offsite für Originale |
| E25 🟡 | Swap 2–4 GB auf dem VPS | Ja, 2–4 GB (Sicherheitsnetz) |
| E26 🟢 | Fail2ban installieren? Überflüssige Dienste abschalten (`snapd`, `ModemManager`, `udisks2`, `multipathd`)? | Dienste abschalten ja; Fail2ban optional (Brute-Force bereits durch Schlüsselpflicht neutralisiert) |
| E27 🟡 | Bandbreite/Trafficlimit des VPS-Tarifs klären (Spitze 15 GB bei Neu-Spot für 2.000 Tablets) | bei Contabo erfragen, bevor Pilot >50 Tablets |
| E28 🟡 | Admin-Zugang: Tailscale, IP-Allowlist oder VPN | Tailscale |
| E29 🟡 | Repository: GitHub-Konto/Organisation (privat), Namensgebung `gt-ads` | privates Repo `gt-ads` |
| E30 🟡 | Notfallzugang: zweite Person mit Zugang/Anleitung (R13) | Notfall-Runbook + versiegelte Zugangsdaten außerhalb des Servers |

## E. Struktur und Namen
| # | Frage | Vorschlag |
|---|---|---|
| E31 🟢 | `/srv/taxiwerbung` in `/srv/gt-ads` umbenennen? | Vorerst nein; Variable `GT_ADS_ROOT`; Umbenennung nur nach Abhängigkeitsprüfung (`ARCHITEKTUR.md` §12) und mit Freigabe |
| E32 🟢 | Alias/Gruppen/Benutzer umbenennen (`taxiwerbung`, `taxiops`) | Nein, kein Nutzen, nur Risiko |

## F. KI-Agenten
| # | Frage | Vorschlag |
|---|---|---|
| E33 🟢 | Welche Agenten zuerst? | 1) Berichts-/Flotten-Agent (read-only) 2) Diagnose-Agent 3) Test-/Entwicklungs-Agent (nur Testdaten) |
| E34 🟢 | Freigabekonzept: wer genehmigt Agenten-Änderungen, wie dokumentiert, welches Budget je Agent | Jede Änderung als Entwurf; du gibst frei; Agent-Token mit Budget/Rate-Limit |
| E35 🟢 | Eigene Testumgebung für Agenten (zweites kleines System/Compose) | Ja, mit synthetischen Daten |

## Entscheidungsprotokoll
Entschiedene Punkte hier mit Datum eintragen (Format: `E# – Entscheidung – Datum`), damit Dokumente und Roadmap konsistent bleiben:
- E31/E32 – Serverordner und Benutzer bleiben unverändert, Projektname `gt-ads` für neue Dinge – 2026-11-09

> Statuskennzeichen: ✅ **Bestätigt** (Betreiberentscheidung) · 🟦 **Vorläufig** (Richtungsentscheidung) · 🔧 **Technische Annahme** (im Test zu prüfen) · ⚖️ **Rechtlich zu prüfen** (nicht freigegeben)

## G. Neu aus Protokoll v2.0 (09.11.2026)
| # | Frage | Vorschlag / Optionen |
|---|---|---|
| E36 🟡 | **Pausen-Semantik:** endet Pause automatisch bei nächster Zündung? Maximale Pausendauer? | Pause endet bei Fahrzeug-aus; Maximaldauer z. B. 60 min (sonst Dauerpause als Umsatzrisiko) |
| E37 🟡 | **Taster-Technik:** BLE (beide Tablets empfangen) vs. kabelgebunden | Beides im Hardwaretest, BLE zuerst prüfen |
| E38 🟡 | Fahrer-App: Android oder Web/PWA; Taxi-Bindung ohne Fahrerprofil | Web/PWA zuerst |
| E39 🟢 | WhatsApp-Steuerung: ja/nein, Kostenrahmen, Datenschutz (Telefonnummer) | V3, nach Prüfung |
| E40 🟡 | Nachlauf Display aus: 2 min bestätigen (konfigurierbar) | 2 min |
| E41 🟡 | Vertragliche Pausenregeln gegenüber Partnern (Häufigkeit/Dauer, Folgen für Vergütung) | Pausenstatistik je Taxi, Regeln im Partnervertrag |
| E42 🔴 | Elektro-/Montagefreigabe: welcher Fachbetrieb, welche Fahrzeugmodelle im Pilot (Verbrenner/Hybrid/Elektro)? | Pilot mit 2 Modelltypen, Fachbetrieb vor P8 |
| E43 ⚖️ | **Datenschutz/Arbeitsrecht:** wer erstellt DSFA/Interessenabwägung (Status-/Pausedaten, GPS, Presence)? Zustimmungen der Partner | Externe Fachperson vor P8 |
| E44 🟡 | Zählt pausierte/„Fahrzeug aus"-Zeit zur gebuchten Leistung? | Berichte weisen Wiedergaben und Pausenzeiten getrennt aus |

## Entscheidungsprotokoll (Ergänzung 2026-11-09, Protokoll v2.0)
- ✅ Energie: kein Dauerleuchten, Stopp bei Fahrzeug-aus, Display-Nachlauf (Start 2 min), Fortsetzen bei Ladesignal; Einschalten aus Power-off nicht zugesichert
- ✅ Stromrichtung: geschaltet/abgesichert/fahrzeugabhängig; Fachbetrieb; kein Eingriff in Hochvolt/Sicherheitssysteme
- ✅ Überwachung: Statusmeldungen 30–60 min, tägliche Auswertung, Zustände getrennt
- ✅ GPS: Standard aus, Betreiber-Schalter, drei Modi
- 🟦 Fahrersteuerung: Pause/Fortsetzen (nicht Power-off), Taster bevorzugt, App zweiter Kanal, WhatsApp später
- 🟦 Fahrgasterkennung: optionales Modul, nicht MVP
- Hinweis: Das Protokoll ist keine Freigabe für Hardwareinstallation oder GPS-Verarbeitung.

## H. Neu aus Entwicklungsprozess (2026-11-09) – blockieren WP-001 bzw. Prozessfreigabe
| # | Frage | Vorschlag / Optionen |
|---|---|---|
| E45 🟦 vorläufig | **Wo und wie läuft DeepSeek?** (API/Tool, Gerät, Server, Datenschutz: nur Code + synthetische Daten) | Läuft auf Entwicklungsrechner oder in isolierter `taxiagent`-Umgebung, nie mit Produktivzugang; Betreiber entscheidet (L-11) |
| E46 🟦 vorläufig | **GitHub:** Konto/Organisation, privates Repo `gt-ads`, Branch-Schutz, Zugang für den Server (Deploy-Key) | Privates Repo, Branch-Schutz an, Auto-Merge aus |
| E47 🟦 vorläufig | **Technologiewahl bestätigen** (ADR-0002, A-05) | Vorschlag laut ADR-0002 |
| E48 🟦 vorläufig | **Prozess freigeben** (ADR-0010/0011/0012): Rollen, Review durch frische Claude-Sitzung, Merge nur Betreiber | Freigeben |
| E49 🟦 vorläufig | CI-Umgebung (GitHub Actions gehostet vs. lokal) und Kostenrahmen | GitHub Actions, kostenfreier Rahmen prüfen |

## I. Neu aus GT-ADS-001 (2026-11-09) – Planung Android-Geräteregistrierung
| # | Frage | Vorschlag / Optionen | Blockiert |
|---|---|---|---|
| E50 🟦 vorläufig | **Erreichbarkeit des Testbackends vom Handy ohne öffentlichen Port** | **T:** Dev-Stack auf dem VPS (nur `127.0.0.1:8080`), PC: `ssh -L 8080:127.0.0.1:8080`, Handy: `adb reverse` · **L:** Stack lokal auf dem PC (Docker nötig) · Tailscale nur nach E28 | GT-ADS-001 |
| E51 🟦 vorläufig | **Admin-Authentifizierung im Pilot-Dashboard** (F-D01 verlangt MFA; MFA ist WP-202) | Ein Admin-Passwort aus Umgebungsvariable (scrypt-Hash), nur dev/test, nur lokal erreichbar; MFA folgt in WP-202 | GT-ADS-001 |
| E52 🟡 | Registrierungscode: Länge/Alphabet/Gültigkeit/Versuchsgrenzen | 12 Zeichen Base32 (60 Bit), 15 min, 5 Fehlversuche/15 min je Quelle (alles konfigurierbar) | – (Standardwerte) |
| E53 🟡 | Schwelle „Erreichbar" | 2 × Heartbeat-Intervall (Test: 900 s → 1800 s); Tablets später 30–60 min (✅) | – (Standardwert) |
| E54 🔴 **offen bis Gerätetest** | **Test-Handy:** Modell und Android-Version; `minSdk` | Vorschlag `minSdk` 26; erst nach Kenntnis der Version bestätigen | GT-ADS-001 (Android) |
| E55 🟡 | Klartext-HTTP über lokalen Tunnel nur im Debug-Build, nur `127.0.0.1`/`localhost`; Release immer HTTPS | Ja | – |
| E56 🔴 **offen bis Gerätetest** | **Android-Build-Weg:** Betreiber baut in Android Studio auf dem PC (USB-Installation) oder später CI | Android Studio auf PC; CI später (WP-001) | GT-ADS-001 (Android) |
| Q-004 🟦 vorläufig | **ID-Schema und Reihenfolge:** `GT-ADS-nnn` = Implementierungspaket, `WP-xxx` = Katalogbaustein; GT-ADS-001 darf **vor** WP-001/002/003/101/201/202 starten (Minimalgerüst im Paket) | Vorschlag so; Alternative: erst WP-001…003 | GT-ADS-001 |
Hinweis: E45–E48 aus Abschnitt H blockieren ebenfalls.

## Entscheidungsprotokoll (Ergänzung 2026-11-09, nach Planung GT-ADS-001) – Betreiber: Vorschläge **vorläufig übernommen**
Die folgenden Vorschläge gelten als **🟦 vorläufig** (Richtung entschieden, noch nicht endgültig bestätigt). Sie sind **keine** Implementierungsfreigabe. Endgültig ✅ werden sie erst mit der ausdrücklichen Freigabe von GT-ADS-001 bzw. mit Betreiberbestätigung.
- 🟦 **E45** DeepSeek läuft auf einem Entwicklungsrechner oder in isolierter `taxiagent`-Umgebung, nie mit Produktivzugang; nur Code, Doku, synthetische Daten. *Restpunkt:* konkreter Ort/Tool und Datenschutzbewertung noch festzulegen.
- 🟦 **E46** Privates Repo `Chiko028/gt-ads`, Auto-Merge aus, Arbeit nur über Branches und Pull Requests. Fakt: Branch-Schutz im Tarif nicht durchsetzbar (Arbeitsvereinbarung, `ENTWICKLUNGSPROZESS.md` §5a). *Restpunkt:* **getrennter Git-Zugang für DeepSeek** (Empfehlung: eigenes GitHub-Konto mit Fork) ist **noch nicht eingerichtet**; DeepSeek erhält nie den Server-Deploy-Key.
- 🟦 **E47** Technologiewahl laut ADR-0002 (TypeScript/Node 22/Fastify, React+Vite, Kotlin+Compose, PostgreSQL). ADR-0002 bleibt formal „Vorgeschlagen".
- 🟦 **E48** Prozess (ADR-0010/0011/0012: Rollen, Review durch frische Claude-Sitzung, Merge nur Betreiber, Datentrennung, Kontextmanagement). ADRs bleiben formal „Vorgeschlagen".
- 🟦 **E49** CI mit GitHub Actions im kostenfreien Rahmen (Kosten vor Einrichtung prüfen; Einrichtung erst mit WP-001/Freigabe).
- 🟦 **E50** Testbackend ohne öffentlichen Port: Variante **T** (Dev-Stack auf dem VPS nur `127.0.0.1:8080`, SSH-Tunnel, `adb reverse`). *Restpunkt:* Start des Stacks auf dem VPS nur durch den Betreiber (Docker braucht `sudo`) und nur nach gesonderter Freigabe zum Zeitpunkt des Tests.
- 🟦 **E51** Pilot-Admin: ein Passwort aus Umgebungsvariable (scrypt-Hash), nur dev/test, nur lokal; MFA folgt in WP-202. *Restpunkt:* Betreiber erzeugt Passwort/Hash selbst, außerhalb des Repos.
- 🟦 **Q-004** `GT-ADS-nnn` = Implementierungspaket, `WP-xxx` = Katalogbaustein; GT-ADS-001 darf mit Minimalgerüst vor WP-001/002/003/101/201/202 starten.
- **Weiter offen (nicht übernommen):** **E54** Handymodell/Android-Version/`minSdk` und **E56** konkreter Android-Buildweg bleiben **bis zum Gerätetest offen**; **E52, E53, E55** bleiben Vorschlags-Standardwerte (nicht entschieden).

## J. Neu aus dem Plan der DeepSeek-Entwicklungsumgebung (2026-11-09) – Details: `docs/prozess/DEEPSEEK_ENTWICKLUNGSUMGEBUNG.md`
| # | Frage | Vorschlag / Optionen | Blockiert |
|---|---|---|---|
| E57 🔴 | **Ausführungsort** der DeepSeek-Umgebung | **A** Dev-Container auf dem Betreiber-PC (Vorschlag für den Pilot) · B isolierte Umgebung auf dem VPS unter `taxiagent` (später, mit Freigabe für Firewall/Rechte) · C eigener Dev-Server (kostenpflichtig) | WP-005, GT-ADS-001 |
| E58 🔴 | **Modellzugang/Anbieter** | DeepSeek-API direkt oder Drittanbieter mit EU-Hosting; Self-Hosting später | WP-005 |
| E59 🔴 | **Git-Zugangsstufe** | Stufe 0 (keine Git-Zugangsdaten für DeepSeek, Übergabe durch Betreiber) für GT-ADS-001; Stufe 1 (Maschinenkonto + Fork + Token) erst nach Pilot | WP-005 |
| E60 🟡 | **Agenten-Werkzeug** | Entscheidung nach Probelauf auf Wegwerf-Repo (Kriterien K1–K9) | WP-005 |
| E61 🔴 | **Budget** und hartes Ausgabenlimit für Modellnutzung (kostenpflichtig) | Betrag legt der Betreiber fest; ohne Limit keine Einrichtung | WP-005 |
| E62 🔴 ⚖️ | **Vertraulichkeit/Datenschutz:** darf der Quellcode (ohne Personenbezug) an Anbieter/Standort gehen? | ja / nein / Teilmengen; Prüfung der Anbieterbedingungen | WP-005 |
| E63 🟡 | **PC-Voraussetzungen:** Betriebssystem, Docker Desktop/WSL2 vorhanden? | Auskunft des Betreibers | WP-005 (S2) |
Hinweis: E45/E46 (🟦) werden durch E57–E59 konkretisiert.

## K. GitHub-Betrieb über Claude Code (2026-11-09) – Details: `docs/prozess/GITHUB_ARBEITSWEISE.md`
**Entscheidungsprotokoll:** ✅ Betreiberanweisung 2026-11-09: GitHub-Schritte (Branch, Pull Request, Squash-Merge, Synchronisation) laufen über Claude Code; Merge **nur** nach ausdrücklichem „Merge freigegeben"; keine Pushes auf `main`; Fehlschläge offenlegen. Authentifizierung eingerichtet am 2026-11-09 (Blocker B-GH1 erledigt).
| # | Frage | Vorschlag / Optionen | Blockiert |
|---|---|---|---|
| **B-GH1** ✅ erledigt 2026-11-09 | **Token-Einrichtung durch den Betreiber** (fein granuliert, nur `gt-ads`, Ablauf ≤ 90 Tage; Eingabe nur im eigenen Server-Terminal, nie im Chat) | Schritte in `GITHUB_ARBEITSWEISE.md` §2 | PR-Erstellung/Merge durch Claude |
| E64 🟡 | Review-Unabhängigkeit bei Claude-Alleinbetrieb (K-16) | frische Sitzung oder Review-Subagent mit dauerhafter Erlaubnis; Doku-PRs: Betreiber ist Reviewer | Code-PRs |
| E65 🟡 | Doku/Status nach Merge (K-17) | Status vorab im Feature-PR; gebündelte Folge-PRs mit eigener Freigabe | – |
| E66 🟡 | Authentifizierungsverfahren | Fine-grained PAT (empfohlen, ≤ 90 Tage) · GitHub App (später) · kein Device-Flow mit breitem Scope | B-GH1 |
| E67 🟡 | Übergabe DeepSeek → Claude (K-18) | Posteingangs-Repo (zweites privates Repo, eigenes Token nur dort) · Stufe 0 manuell · Stufe 1 Fork-Konto | WP-005 |

## L. Telegram-Steuerung (2026-11-09) – Details: `docs/prozess/TELEGRAM_STEUERUNG.md`, Paket `docs/ARBEITSPAKETE/WP-006/`
**Entscheidungsprotokoll (Betreiberantwort im Chat):**
- ✅ **E57′** Ort des Chat-Agenten: **VPS** (privilegierte Einrichtung später nur mit ausdrücklicher Freigabe).
- ✅ **E61** Kein hartes Limit beim Anbieter; Obergrenze ist das **vorab geladene Guthaben ohne automatische Aufladung** (Betreiberangabe). Gateway erhält zusätzlich ein Tageslimit (E73) als Schutz.
- ✅ **E62** ⚖️ **bestätigt am 2026-11-09 („E62 = ja“)**: Chat-Inhalte dürfen an DeepSeek und über Telegram laufen (zuvor Antwort „la“, vermutlich Tippfehler). Entscheidung des Betreibers; die **rechtliche Prüfung** der Anbieterbedingungen bleibt beim Betreiber bzw. einer Fachperson und wurde von Claude nicht vorgenommen. Gilt für Chat-Inhalte; **Projektdokumente (Phase 1b)** bleiben eine gesonderte Freigabe (E70).
- ⬜ **E68** offen: genannt wurde `t.me/Dipshit28_bot` (der Bot), **nicht** die numerische Benutzer-ID des Betreibers; Ermittlung über den zeitlich begrenzten Setup-Modus des Gateways.
- 🟦 **E58** Modell `deepseek-flash` (V4.1-Flash-1017, konfigurierbar) · **E69** Variante M (Eigenbau, Python-Standardbibliothek) · **E70** Dokumentenzugriff erst Phase 1b · **E71** privilegierte Einrichtung durch den Betreiber mit `sudo` · **E72** keine Chat-Inhalte speichern · **E73** Tageslimit als Schutz (Standard 100 Nachrichten/Tag [A]) – als Vorschläge ohne Widerspruch übernommen.
