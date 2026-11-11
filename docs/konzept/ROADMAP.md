# GT-Ads – Roadmap

Stand: 2026-11-09 (Protokoll Tablet-Betrieb v2.0 eingearbeitet) · Dauerangaben sind **grobe Schätzungen** für eine Person mit KI-Unterstützung und hängen von Hardwarelieferung, Rechtsklärung und Verfügbarkeit von Pilotpartnern ab.
**Gate** = Entscheidung des Betreibers, bevor die nächste Phase beginnt. Nichts wird produktiv ohne Freigabe; keine neuen öffentlichen Ports ohne Freigabe.

## Übersicht
```
P0 Fundament (erledigt)
 └─► P1 Validierung ──────────────┐ (parallel, ohne Code)
 └─► P2 Gerüst ─► P3 Backend-Kern ─► P4 Medien+Kampagnen+Manifest ─► P5 Android-MVP
                                                                  │
                          P1-Ergebnis ──► G1 ──► P6 Bench-Test ◄──┘
 P6 ─► P7 Stats/Monitoring/Backup ─► G2 ─► P8 Feldtest (2–3 Taxis) ─► G3 ─► P9 Pilot (10 Taxis)
 P9 ─► G4 ─► P10 V2 (Skalierung/Kundenportal/OTA) ─► P11 KI-Agenten ─► P12 Migration Dedicated
```

## P0 – Fundament · ERLEDIGT
Ergebnis: Ubuntu gehärtet (SSH nur Schlüssel, kein Root), UFW, Docker 29.9 + Compose, Verzeichnisse `/srv/taxiwerbung`, Benutzer `taxiagent` (ohne Rechte), Neustart durchgeführt, Skripte `10–40` samt Prüfsummen, `STATUS.md`.
Offen aus P0: `sudo ufw status verbose`/`docker info` gegenprüfen; Fail2ban/Dienste (`snapd`, `ModemManager`, `udisks2`, `multipathd`) bewerten; Swap-Entscheidung; unattended-upgrades-Log prüfen.

## P1 – Validierung (parallel, ohne Entwicklung) · ~2–4 Wochen
Ziel: Annahmen prüfen, **bevor** Hardware gekauft wird.
- Rechtliche/steuerliche Klärung Wien (Werbung im Taxi, Abgaben, DSGVO, Vertragsvorlagen Partner/Kunden) durch Fachperson.
- Markttest: mindestens 3–5 interessierte Werbekunden mit Preisindikation; 3–5 Taxi-Partner mit Bereitschaft für Pilot.
- Wirtschaftlichkeit: Rechenmodell (`KONZEPT.md` §3) mit echten Angeboten (Tablets, SIM, Montage) befüllen.
- Hardware: 2–3 Tablet-Modelle + Halterung + 12-V-Stromlösung bestellen (**nur nach deiner Freigabe der Kosten**).
- **Hardwaretestplan** abstimmen (`HARDWARETESTPLAN.md`): Tablet-Kandidaten, Stromlösung, Taster; Fachbetrieb für Elektro anfragen.
- Datenschutz-/arbeitsrechtliche Vorprüfung: Statusdaten, Pause-Logs, GPS (bleibt gesperrt), Presence-Sensorik.
- Domain registrieren (kostenpflichtig, Freigabe).
**Testkriterien/Ergebnis:** Ergebnisdokument; Entscheidung G1: Mindestpreis je Platz realistisch? Rechtslage unbedenklich? Pilotpartner zugesagt?

## P2 – Gerüst · ~1 Woche · abhängig von: –
Repo `gt-ads` (Monorepo: `api`, `worker`, `dashboard`, `android`, `infra`), CI (Lint/Test/Build), Compose-Grundgerüst lokal und auf VPS **ohne öffentliche Ports**, Caddy intern, Healthchecks, ADR-Verzeichnis, Variable `GT_ADS_ROOT`, Branch-/Release-Regeln.
**Test:** `docker compose up` startet alle Dienste mit Limits; CI grün; `nmap` von außen zeigt weiterhin nur Port 22.

## P3 – Backend-Kern · ~2–3 Wochen · abhängig von: P2
DB-Schema/Migrationen, Auth+MFA, Rollen, Audit-Log, Taxis/Geräte/Gruppen, Geräte-Enrollment (Token, Schlüsselregistrierung), Heartbeat-Endpunkt.
**Test:** Automatisierte API-Tests; Enrollment-Token einmalig nutzbar; widerrufenes Gerät wird abgewiesen; Audit-Log vollständig; Migrationen vor/zurück.

## P4 – Medien, Kampagnen, Manifest · ~3 Wochen · abhängig von: P3
Upload, Transkodierung (Worker), Hash/Metadaten, Kampagnen/Buchungen (Regeltyp `fixed_slot`), Schleifenplanung 12–16 Plätze, Manifest-Generator (versioniert), signierte Download-URLs, Ereignis-Eingang (idempotent) und Partitionierung, Dashboard-Grundfunktionen (Taxis, Medien, Kampagnen, Gruppen).
**Test:** Ein 15-s-Video → transkodiert, Hash stimmt; Kampagne ändern → neue Manifest-Version; gleiche Ereignis-Batches doppelt senden → keine Duplikate; Lasttest 2.000 simulierte Geräte (Heartbeat+Manifest-Poll) ohne Fehler.

## P5 – Android-MVP · ~4–6 Wochen · abhängig von: P3 (Enrollment), P4 (Manifest/Medien)
Autostart, Kiosk/Device Owner, Zustandsautomat mit Fahrzeugbereitschaft/Display-Nachlauf (`ZUSTANDSMODELL.md`), lokale Pause + Taster-Schnittstelle (Prototyp), leere Presence-/GPS-Schnittstellen (GPS aus), Enrollment, Manifest-Sync, resumable Download mit Hash, Offline-Wiedergabe, lokaler Scheduler, Ereignispuffer, Heartbeat, Watchdog, Fallback-Content, Wiedergabe ohne Schwarzbild.
**Test (Labor):** Flugmodus → Wiedergabe läuft weiter; Strom ziehen → Wiedergabe ≤ 2 min nach Boot; Kampagnenende wird lokal durchgesetzt; Manifestwechsel ohne Unterbrechung; 100.000 Ereignisse puffern und synchronisieren ohne Verlust/Duplikate.

## P6 – Bench-Test · ~2 Wochen · abhängig von: P5, Gate G1 · Hardware: 2–4 Tablets
Stufe 1–2 aus `HARDWARETESTPLAN.md` (Labor, Zündungssimulation per Netzteil) plus Dauerbetrieb am Schreibtisch/Wärmeschrank: ≥ 14 Tage ohne Eingriff, Temperatur-/Akku-Verhalten, Datenverbrauch (SIM), Kiosk-Ausbruchversuche (Selbsttest), Netzwechsel, Zeitabweichung.
**Kriterien:** ≥ 99 % Wiedergabezeit, 0 manuelle Eingriffe, Datenverbrauch gemessen, keine Kiosk-Umgehung ohne Admin-Zugang.

## P7 – Statistiken, Monitoring, Backup · ~2–3 Wochen · abhängig von: P4 (parallel zu P5/P6 möglich)
Rollups, Dashboard-Statistiken, Prometheus/Grafana/Kuma, Alarme (Offline, Sync-Fehler, Speicher, Hitze), pgBackRest + Offsite-Ziel (**kostenpflichtig → Freigabe**), Restore-Test dokumentiert, Retention-Job, Runbooks.
**Kriterien:** Restore in neuer Umgebung erfolgreich (Zeit gemessen); Tägliche Auswertung klassifiziert einen Testdatensatz korrekt (pausiert/Fahrzeug aus/technischer Fehler/unbekannt); technischer Alarm wird bei Schwellwert zugestellt; Berichtszahlen stimmen mit Gerätezählern überein (Abweichung ≤ 1 %).
**G2 (vor Feldtest):** Backup funktioniert, Rechts-/Versicherungsfragen für Fahrzeugmontage geklärt.

## P8 – Feldtest · ~4–6 Wochen · abhängig von: P5–P7, G2 · 2–3 Taxis (4–6 Tablets)
Stufe 3–4 aus `HARDWARETESTPLAN.md`: Montage durch Fachbetrieb **erst nach Elektro-/Fahrzeugfreigabe**, Betrieb im realen Fahrbetrieb (inkl. Hitze/Kälte, wenn möglich Sommer-/Wintertest in zwei Phasen), Mobilfunkqualität in Wien, Partner-Feedback, Ausfälle/Support-Aufwand.
**Kriterien:** ≥ 99 % Wiedergabe, ≥ 99 % Ereignisse angekommen, Sync ≤ 24 h, keine sicherheitskritischen Vorfälle, Partner bereit weiterzumachen.
**G3:** Go/No-Go für Pilot (inkl. Domain/443-Freigabe, Deployment-Freigabe).

## P9 – Pilotbetrieb · ~8–12 Wochen · abhängig von: G3 · ~10 Taxis (20 Tablets), 3–6 Kunden
Echte Kampagnen, Berichte an Kunden, Partnervergütung als Datenexport, Support-Prozess, Ersatzgeräte (≈ 10 %), Betriebskosten real erfassen.
**Kriterien (Auswahl):** Auslastung der Plätze ≥ Zielwert aus P1; Kosten je Taxi ≤ Planwert; mindestens ein Kunde verlängert; keine Rechtsbeanstandung; Support ≤ definierter Zeitaufwand.
**G4:** Skalierungsentscheidung auf Basis echter Zahlen (Preise, Kosten, Technik).

## P10 – Version 2 · nach G4
OTA-Updates mit Staffelung, Fernbefehle/Log-Upload, verifizierte Wiedergaben, signierte Ereignisse, weitere Buchungsregeln, Freigabe-Workflow für Motive, Kundenportal (eingeschränkt), Reports/PDF, Dedup je Taxi, Skalierungstest 500 → 2.000 Tablets.
**Kriterien:** Lasttest 2.000 simulierte Tablets, Update-Rollout mit Rollback getestet.

## P11 – KI-Agenten (sandboxed) · nach P9, Freigabe je Agent
Agent-API/Tokens, getrenntes Netz/Container, Testumgebung mit Testdaten, Berichts-Agent (read-only) zuerst, dann Diagnose-Agent; Entwicklungs-Agenten nur mit Testdaten und ohne Deploy-Rechte.
**Kriterien:** Penetrationsversuch (Agent will auf DB/Secrets/Docker-Socket) scheitert; alle Aktionen im Audit; Rücknahme in < 5 min.

## P12 – Migration auf Dedicated Server · nach Bedarf (Last/Kosten)
Setup-Playbooks, Replikation, rsync, DNS-Cutover, Rückfallfenster 7 Tage.
**Kriterien:** Probe-Umzug in Testumgebung; Cutover-Downtime ≤ 15 min; Tablets ohne Änderung weiter online.

## Abhängigkeitsmatrix (Kurz)
| Phase | braucht | blockiert |
|---|---|---|
| P2 | P0 | alles Technische |
| P3 | P2 | P4, P5 |
| P4 | P3 | P5, P7 |
| P5 | P3, P4 | P6 |
| P6 | P5, G1, Hardware | P8 |
| P7 | P4 | G2, P9 |
| P8 | P5–P7, G2 | P9 |
| P9 | G3, Domain, 443 | P10 |
| P11 | P9 | – |
| P12 | Last/Kosten | – |

## Qualitätsregeln für alle Phasen
Automatisierte Tests, Code-Review, kein Merge ohne grüne CI, Dokumentation (README/Runbook/ADR) als Teil der Fertigstellung, Sicherheitsprüfung je Phase, keine Zugangsdaten in Git, keine Produktiv-Deployments ohne Freigabe.

> Statuskennzeichen: ✅ **Bestätigt** (Betreiberentscheidung) · 🟦 **Vorläufig** (Richtungsentscheidung) · 🔧 **Technische Annahme** (im Test zu prüfen) · ⚖️ **Rechtlich zu prüfen** (nicht freigegeben)

## Querschnitt Protokoll v2.0
- **GPS** bleibt in allen Phasen **gesperrt** (Modus `aus`), bis Datenschutz- und arbeitsrechtliche Freigaben schriftlich vorliegen (Gate „G-GPS", nicht terminiert).
- **Presence-Sensorik:** zuerst nur Schnittstelle; Laborversuche frühestens nach Datenschutzbewertung; Kamera nicht im Pilot (⚖️).
- **WhatsApp-Steuerung:** frühestens V2/V3 nach Kosten-/Datenschutzprüfung.
- **Taster:** Prototyp in P5/P6; Entscheidung BLE vs. kabelgebunden vor P8.
- **Keine Installation in Fahrzeugen** vor Gate G2 (Elektro-/Fachbetriebsfreigabe je Fahrzeugmodell, Halter-Zustimmung).
