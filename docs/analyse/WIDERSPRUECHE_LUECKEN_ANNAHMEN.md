# Analyse: Widersprüche, fehlende Informationen, unbelegte Annahmen

Stand: 2026-11-09 · Grundlage: `docs/konzept/*` (Konzept, Anforderungen, Architektur v2.1, Roadmap, Offene Entscheidungen, Zustandsmodell, Hardwaretestplan, Protokoll Tablet-Betrieb v2.0) und Servermessung.
Zweck: Diese Liste ist **Eingangsprüfung** für alle Arbeitspakete. Kein WP darf auf einem hier als „offen/Annahme" geführten Punkt Verhalten festlegen, ohne dass der Betreiber den Punkt entschieden hat.

## 1. Widersprüche und Inkonsistenzen
| ID | Befund | Fundstellen | Bewertung / Behandlung |
|---|---|---|---|
| K-01 | Heartbeat: früher 5 min, jetzt 30–60 min + Zustandswechsel | ARCHITEKTUR §0 (Historie), ANFORDERUNGEN F-A09/N-13 | **Aufgelöst** durch Protokoll v2.0 §5 ✅. Nur als Konfiguration (`C-08`) umsetzen, Bereich statt Festwert |
| K-02 | RAM-Budget summiert auf ~11,9 „GB" inkl. 2,5 GB Reserve; gemessen `MemTotal` = 12.247.544 kB ≈ **11,68 GiB** (OS + Kernel noch nicht abgezogen) → Reserve real kleiner, Budget evtl. leicht überbucht | ARCHITEKTUR §3, Servermessung 2026-11-09 | **Offen/Annahme.** Limits sind Obergrenzen, aber Budget ist ungemessen → WP-101 misst und passt an |
| K-03 | Pause bei Fahrzeug-aus: Zustandsmodell sagt „Pause bleibt gespeichert", Entscheidungsliste schlägt „endet bei Fahrzeug-aus" vor | ZUSTANDSMODELL §3, OFFENE_ENTSCHEIDUNGEN E36 | **Offen.** Nicht implementieren, bis E36 entschieden; Verhalten als Konfigurationswert vorsehen |
| K-04 | Abgrenzung nennt „Standort-Targeting" als nicht Teil V1, F-A17 sieht GPS-Modul mit „lokaler Gebietserkennung" vor | KONZEPT §6 vs ANFORDERUNGEN F-A17 | **Geklärt als Auslegung (Annahme):** MVP enthält nur die geschlossene Schnittstelle; keine Gebietserkennung/Verarbeitung bis ⚖️-Freigabe |
| K-05 | ADR-Nummerierung ADR-01…09 (Architektur §14) vs Dateischema `docs/entscheidungen/adr/ADR-00nn` | ARCHITEKTUR §14 | **Behandelt:** Mapping in `docs/entscheidungen/adr/README.md` |
| K-06 | Aufbewahrung Rohereignisse „60–90 Tage" (Architektur) vs „90 Tage" (E22-Vorschlag) vs „zeitlich begrenzt" (S-09) – kein entschiedener Wert | ARCHITEKTUR §6, E22, S-09 | **Offen.** Retention als Konfiguration, Standardwert erst nach E22 |
| K-07 | Statusdoku `infra/server-setup/STATUS_SERVER.md` enthält unter „Ist-Zustand" Aussagen vor der Härtung (z. B. PermitRootLogin yes), obwohl erledigt | STATUS_SERVER.md | **Veraltet.** Ist als historisch gekennzeichnet; gültiger Stand: `docs/fortschritt/STATUS.md` |
| K-08 | Partnervergütung „bis zu 80 €" (Briefing) vs Modell „fix 80 €" (E7-Vorschlag) | KONZEPT §2/§3, E7 | **Offen.** Rechenmodell nutzt 80 € als Obergrenze; E7 entscheiden |
| K-09 | Hardwarekosten „≈ 500 € pro Taxi" – unklar, ob Taster, DC/DC-Wandler, Fachmontage, Router/SIM-Hardware enthalten (Hardwaretestplan führt diese Posten) | KONZEPT §3 vs HARDWARETESTPLAN §3 | **Lücke/Risiko:** Einheitenwirtschaft evtl. zu optimistisch; Betreiber klärt E5/E14–E16 |
| K-10 | Entscheidungsnummern: OFFENE_ENTSCHEIDUNGEN nutzt Emojis 🟡/🔴/✅ teils für Dringlichkeit, teils (neu) für Status | OFFENE_ENTSCHEIDUNGEN | **Handhabung:** Status immer aus dem Entscheidungsprotokoll ablesen, nicht aus Emojis der Tabellen |
| K-11 | **ID-Konflikt:** Betreiber nennt das Paket `GT-ADS-001`; im Katalog ist `WP-001` das Repo-Gerüst | `GT-ADS-001/SPEZIFIKATION` §3 vs `KATALOG.md` | **Behandelt:** ID-Schema (Q-004), wartet auf Bestätigung |
| K-12 | **TLS-Anforderung (S-02) vs. Testverkehr ohne TLS** über lokalen Tunnel (kein Zertifikat ohne Domain/Port 443) | ANFORDERUNGEN S-02 vs GT-ADS-001 | **Bewusste Ausnahme (🔧)**: Klartext nur Debug/localhost; Release verbietet; TLS in WP-106 |
| K-13 | **MFA (F-D01, MVP) vs. Pilot-Admin ohne MFA** | ANFORDERUNGEN F-D01 vs GT-ADS-001 | **Bewusste Abweichung**, nur dev/test; Freigabe E51 |
| K-14 | **Heartbeat 30–60 min (✅ Tablets) vs. 15-min-Testintervall** und Android-WorkManager-Mindestintervall 15 min (🔧 Plattformfakt) | Protokoll §5 vs GT-ADS-001 | Intervall konfigurierbar; Testwert nur dev/test |
| K-15 | **Katalog-Abhängigkeiten werden übersprungen:** GT-ADS-001 braucht Teile von WP-001/002/003/101/201/202 vor deren Abschluss | KATALOG, ABHAENGIGKEITEN | Minimalgerüst im Paket; freigabepflichtig (Q-004) |
| K-16 | **Review-Unabhängigkeit:** ADR-0010 verlangt Review durch frische Sitzung; die Betreiberanweisung lässt Claude planen, prüfen, PR erstellen und mergen | ADR-0010/`ENTWICKLUNGSPROZESS` vs Anweisung 2026-11-09 | **Offen (E64):** Review in frischer Sitzung/Subagent; bis dahin Kennzeichnung „Autor-Selbstprüfung" |
| K-17 | **Status-Dokumentation nach Merge (Schritt 8)** vs. „keine direkten Pushes auf `main`": jede Doku-Nachführung braucht wieder einen PR | Anweisung 2026-11-09 | **Offen (E65):** Status vorab im Feature-PR, gebündelte Folge-PRs |
| K-18 | **Ablauf Schritt 3→4 (DeepSeek → Claude) vs. Git-Zugangsstufe 0** (manuelle Übergabe) | Anweisung vs `DEEPSEEK_ENTWICKLUNGSUMGEBUNG` §4 | **Offen (E67):** Posteingangs-Repo vorgeschlagen |
| K-19 | **Token mit `Contents: write` ermöglicht Push auf `main`**, Branch-Schutz nicht durchsetzbar | GitHub-Tarif, `GITHUB_ARBEITSWEISE` §2 | **Restrisiko,** durch Regeln/Hook/Kontrolle begrenzt (E66) |
| K-20 | Telegram-Agent auf dem **VPS** (Auftrag) vs. Plan **PC** (E57 = A) | `TELEGRAM_STEUERUNG` §3 | **Offen (E57′):** Neubewertung für den Chat-Agenten |
| K-21 | Anbieter/Budget/Vertraulichkeit (E58/E61/E62) offen, aber Chat und Dokumente gehen an DeepSeek/Telegram | dito | **Offen**, vor Start entscheiden ⚖️ |
| K-22 | OpenClaw führt Tools standardmäßig auf dem Host aus vs. „keine Shell/Dateiänderung" | dito (Quelle: README) | Nur mit strikter Tool-Policy/Sandbox; Standardinstallation unzulässig |
| K-23 | OpenClaw: Node 24 fehlt, 68 Abhängigkeiten, Install-Skripte, 1 Tag alte Version | dito | Evaluierung im Wegwerf-Umfeld, Empfehlung Eigenbau M (E69) |
| K-24 | „Pairing aktivieren **und** nur meine ID" – Pairing erlaubt zunächst jedem eine Anfrage | dito | Allowlist mit numerischer ID; Pairing nur zur ID-Ermittlung |
| K-25 | Bot-Benutzername öffentlich | dito | Gruppen bei Telegram sperren, Unbekannte ohne Antwort verwerfen |
| K-26 | Lesezugriff auf Dokumente vs. Host mit Repo/Skripten | dito | nur schreibgeschützte Kopie von `docs/` |
| K-27 | Bot-Token und DeepSeek-Schlüssel liegen auf dem Server | dito | systemd-Credentials (root-lesbar), Limits, Rotation, Widerruf |

## 2. Fehlende Informationen (Lücken) – blockieren Umsetzung betroffener WPs
| ID | Fehlt | Blockiert |
|---|---|---|
| L-01 | Videoformat/Anforderungen an angelieferte Spots (Container, Codec, Auflösung, Seitenverhältnis, Bildraten, Max-Größe, Ton) | WP-206, 207, 404 |
| L-02 | Tablet-Modell(e), Android-Version, Display (Größe/Auflösung/Ausrichtung) | WP-401…409, 501 |
| L-03 | Verhalten bei Spots unterschiedlicher Länge, Bildern (Standzeit), Reihenfolge/Rotation der Schleife | WP-208, 209, 404 |
| L-04 | Ziel-/Gruppenkriterien („Taxigruppen"): wonach gruppiert wird, Überschneidungen | WP-204, 208 |
| L-05 | Rollenmodell (wer sieht/darf was), Anzahl Betreiber-Nutzer, MFA-Methode (TOTP/Passkey), Passwort-Wiederherstellung | WP-202, 301 |
| L-06 | Alarmkanal (E-Mail/Chat), SMTP/Versandanbieter, Empfänger | WP-216 |
| L-07 | Sprache/Lokalisierung der Oberflächen, Zeitzone (Annahme `Europe/Vienna`), Umgang mit Zeitumstellung | WP-301…306, 213 |
| L-08 | Taxi-Stammdaten: Pflichtfelder (Kennzeichen-Format, Partner-Zuordnung, Fahrzeugtyp) | WP-201, 204 |
| L-09 | Fallback-Inhalt bei leerer Playlist: Quelle/Gestaltung | WP-404, 408 |
| L-10 | Aufbewahrungsfristen (E22), Lösch-/Datenschutzkonzept, Statusdaten | WP-212, 602 |
| L-11 | Wie DeepSeek angebunden wird (Hosting, Tooling, Datenschutz), GitHub-Konto/Organisation, CI-Umgebung | Prozess, WP-001 |
| L-12 | Verfügbarkeits- und Supportziele (SLA), Wartungsfenster, Reaktionszeiten | WP-103, 603 |
| L-13 | Abrechnungs-/Vergütungsdaten: gewünschte Felder und Exportformat (CSV-Spalten) | WP-306 (V2) |
| L-14 | Freigabeprozess für Kundenmotive (wer, wann, Kriterien) | V2 |
| L-15 | Update-/Rollout-Verfahren der App im Pilot (ADB, QR, MDM) | WP-401, 504 |
| L-16 | Backup-Ziel/Offsite-Budget | WP-104 (Offsite) |
| L-17 | Domain, öffentliche Erreichbarkeit (443 vs Tunnel) | WP-106, 504 |
| L-18 | Pilotumfang (Anzahl Taxis/Kunden), Zeitplan, Partner | Roadmap |
| L-19 | Rechtsstatus Partner/Fahrer (Arbeitsrecht), Rechtsgrundlagen Statusdaten | WP-602, GPS ⚖️ |
| L-20 | Messmethode „verifizierte Wiedergabe" (genaue Kriterien/Schwellen) | V2 |
| L-21 | Test-Handy: Modell, Android-Version, `minSdk` | GT-ADS-001 (E54) |
| L-22 | Build-/Installationsweg der App (Android Studio/ADB) | GT-ADS-001 (E56) |
| L-23 | Pilot-Admin-Auth: wer hat das Passwort, wo liegt der Hash (außerhalb des Repos) | GT-ADS-001 (E51) |
| L-24 | Wie wird der Dev-Stack auf dem VPS gestartet (Betreiber mit sudo) und wann (Freigabe) | GT-ADS-001 (E50) |
| L-25 | PC des Betreibers: Betriebssystem, Docker Desktop/WSL2 vorhanden? (aus dem SSH-Prompt vermutlich Windows, nicht bestätigt) | WP-005 (E63) |
| L-26 | Modellanbieter: Konditionen, Standort, Trainingsnutzung, Aufbewahrung, API-Endpunkt-Domains, Ausgabenlimit-Funktion | WP-005 (E58/E62) |
| L-27 | GitHub Free: kann ein Collaborator mit Leserecht ein privates Repo forken (für Git-Stufe 1)? | WP-005 (E59) |
| L-28 | Eignung/Lizenz/AGENTS.md-Unterstützung der Agenten-Werkzeuge (Aider, OpenCode, Cline/Roo, Continue) | WP-005 (E60) |
| L-29 | Numerische Telegram-ID des Betreibers (E68) | WP-006 |
| L-30 | Umfang „freigegebener" Dokumente für lesenden Zugriff (E70), Tageslimit/Budget (E61/E73) | WP-006 |

## 3. Unbelegte Annahmen (nicht vom Betreiber bestätigt)
Jede dieser Annahmen darf in Code/Tests nur als **konfigurierbarer** Standardwert mit Markierung „Annahme" vorkommen.
| ID | Annahme | Herkunft | Auswirkung bei Irrtum |
|---|---|---|---|
| A-01 | Hardware 36 Monate abgeschrieben (≈ 14 €/Monat) | Claude (KONZEPT §3) | Einheitenwirtschaft |
| A-02 | Gemeinkosten-Aufschlag 30 % | Claude | Preisuntergrenze |
| A-03 | 10 h Betrieb/Tag, 25 Tage/Monat | Claude | Datenmengen, Wiedergabezahlen |
| A-04 | Videobitrate ≈ 4 Mbit/s, 15 s ≈ 7,5 MB | Claude | Traffic, Speicher, Mobilfunk |
| A-05 | Technologiewahl (Node/Fastify, Postgres, pg-boss, Caddy, React, Kotlin/Media3) | Claude-Vorschlag, **nicht freigegeben** | Rework; vor WP-001 bestätigen (ADR-0002…0008) |
| A-06 | Ressourcenbudget je Container | Claude | K-02 |
| A-07 | Entprellung Fahrzeugsignal 10–30 s; Nachlauf 2 min (✅ nur Startwert) | Claude / Protokoll | Zustandsflattern |
| A-08 | Akzeptanzwerte (≥ 99 % Wiedergabe, Sync ≤ 24 h, Boot ≤ 2 min, ≤ 1 GB/Monat, Abweichung ≤ 1 %, Toleranz ±3 %) | Claude (Vorschläge) | Testkriterien, Pilot-Entscheid |
| A-09 | Device-Owner-Provisionierung auf Zielmodell möglich; Kiosk ausreichend manipulationssicher | Annahme | Hardwarewahl |
| A-10 | BLE-Advertising-Taster wird von beiden Tablets im Hintergrund zuverlässig empfangen | Annahme (Android-Hintergrundlimits) | Tasterkonzept |
| A-11 | „Netzteil angeschlossen" ≈ Fahrzeugbereitschaft | Annahme (🔧) | Zustandsmodell |
| A-12 | Contabo-Traffic/Bandbreite reicht für Neu-Spot-Wellen | Annahme | Auslieferung |
| A-13 | pg-boss reicht als Queue für erwartete Last | Annahme | Architektur |
| A-14 | Zeitzone `Europe/Vienna` | Annahme | Laufzeitfenster |
| A-15 | Wien hat ausreichend viele Taxis/Interessenten für 1.000 Taxis | Betreiber-Ziel, nicht belegt | Geschäftsmodell |
| A-16 | Prozess/ADR-0010–0012 (Rollen, Review, Datentrennung, Kontext) | Claude-Vorschlag | wartet auf Freigabe |
| A-17 | GT-ADS-001: Standardwerte für Code (12 Zeichen/15 min), Rate-Limits, Token-/Challenge-TTL, Heartbeat 900 s, Schwelle 1800 s, App-ID `gtads.device`, `minSdk` 26 | Claude (Planung 2026-11-09) | konfigurierbar; Betreiber bestätigt (E52–E54) |
| A-18 | Android-WorkManager erlaubt periodische Arbeit frühestens alle 15 min | Plattformwissen, im Test zu bestätigen | Intervalltests |
| A-19 | Android Keystore unterstützt EC P-256 ab API 23 und StrongBox nur auf Teilen der Geräte | Plattformwissen, im Test zu bestätigen | Fallback TEE |
| A-20 | Dev-Container-Limits (z. B. 4 vCPU/8 GB), Reset ≤ 15 min, Schlüsselrotation 30 Tage | Claude (Plan WP-005) | Dimensionierung, Aufwand |

## 4. Regeln für den Umgang
1. Neue Widersprüche/Lücken/Annahmen werden hier mit nächster ID ergänzt (Planer).
2. Auflösung nur durch Betreiberentscheidung (Eintrag im Entscheidungsprotokoll) oder belegten Test; dann hier „Aufgelöst" + Quelle.
3. Ein WP, das einen offenen Punkt berührt, bleibt `Blockiert` oder implementiert nur den konfigurierbaren, standardmäßig neutralen Teil.
