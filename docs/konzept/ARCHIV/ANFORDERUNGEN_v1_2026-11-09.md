# GT-Ads – Anforderungen

Stand: 2026-11-09 · Priorität: **MVP** = Pilotbetrieb · **V2** = nach erfolgreichem Pilot · **V3** = langfristig · **Offen** = fachliche Grundlage fehlt.
IDs: F = funktional, N = nichtfunktional, S = Sicherheit/Datenschutz.

## 1. Tablet-App (Android)
| ID | Anforderung | Prio |
|---|---|---|
| F-A01 | Autostart nach Boot, direkt in die Wiedergabe | MVP |
| F-A02 | Kiosk-Modus (Lock-Task, Device Owner), Statusleiste/Navigation gesperrt, Einstellungen nicht erreichbar | MVP |
| F-A03 | Geräte-Enrollment per einmaligem Code/QR; danach geräteeigene Identität | MVP |
| F-A04 | Manifest (Playlist) vom Server holen, versioniert, ETag/Polling | MVP |
| F-A05 | Videos/Bilder lokal laden: fortsetzbar (Range), Hash-Prüfung, nur WLAN/Mobil nach Regel, Speicherlimit | MVP |
| F-A06 | Offline-Wiedergabe aus lokalem Speicher, lückenlos/ohne Schwarzbild | MVP |
| F-A07 | Playlist-Reihenfolge und Laufzeiten (Start/Ende) lokal durchsetzen, Atomares Umschalten auf neue Manifest-Version | MVP |
| F-A08 | Wiedergabeereignisse lokal speichern (Room), später idempotent hochladen | MVP |
| F-A09 | Heartbeat: online/offline, Akku, Speicher, Temperatur, App-/OS-Version, Manifest-Version, Fehlerzähler | MVP |
| F-A10 | Selbstheilung: Absturz/Freeze → automatischer Neustart der Wiedergabe (Watchdog) | MVP |
| F-A11 | Wiederherstellung nach Strom-/Verbindungsunterbrechung ohne Eingriff | MVP |
| F-A12 | App-Updates kontrolliert (signiert, Kanal „Pilot/Stabil", Rollback) | V2 (MVP: manuell per ADB/MDM) |
| F-A13 | Fernbefehle: Neustart, Manifest neu laden, Log-Upload, Helligkeit/Lautstärke | V2 |
| F-A14 | Lokaler Fallback-Content bei leerer Playlist (GT-Ads-Eigenwerbung/Platzhalter) | MVP |
| F-A15 | Tag/Nacht-Helligkeit, Bildschirm-Zeitplan (Aus bei Fahrzeug-Aus) | V2 |
| F-A16 | QR-Codes/Aktionscodes im Spot | V3 |
| F-A17 | Standortbezogene Ausspielung | Offen (Datenschutz) |
| F-A18 | Ton: Standard stumm; Lautstärkeregeln | Offen (Betreiber) |

## 2. Server / Backend
| ID | Anforderung | Prio |
|---|---|---|
| F-B01 | Geräte-/Taxi-/Gruppenverwaltung (Taxi hat 2 Tablets) | MVP |
| F-B02 | Medien-Upload, Prüfung, Transkodierung auf Tablet-Profil, Hash/Metadaten | MVP |
| F-B03 | Kampagnen: Kunde, Medien, Laufzeit, Zielgruppe (Taxis/Gruppen), Status (Entwurf/Aktiv/Pausiert/Beendet) | MVP |
| F-B04 | **Schleifenplanung:** Plätze (12–16), Spotdauer, Regeltypen (fest, gewichtet, Zeitfenster) als erweiterbares Regelmodell | MVP (fest) / V2 (weitere) |
| F-B05 | Manifest-Erzeugung pro Gerät/Gruppe, unveränderlich versioniert | MVP |
| F-B06 | Medien-Auslieferung mit signierten, kurzlebigen URLs | MVP |
| F-B07 | Ereignis-Eingang (idempotent), Validierung, Plausibilitätsprüfung | MVP |
| F-B08 | Aggregation Tages-/Kampagnen-/Gerätestatistik | MVP |
| F-B09 | Statusüberwachung/Alarme (Gerät seit X h offline, Sync-Fehler, Speicher voll, Hitze) | MVP |
| F-B10 | Audit-Log aller Verwaltungsaktionen | MVP |
| F-B11 | Freigabe-Workflow für Werbemotive (Entwurf → geprüft → live) | V2 |
| F-B12 | Buchung, Vertragsdaten, Partnervergütung als Daten/Export (CSV), keine Zahlungsabwicklung | V2 |
| F-B13 | Reports als PDF/CSV für Werbekunden | V2 |
| F-B14 | Mandantenfähigkeit (Kundenportal) | V2/V3 |

## 3. Dashboard (intern) und Kundenportal
| ID | Anforderung | Prio |
|---|---|---|
| F-D01 | Login mit MFA, Rollen (Admin, Betrieb, Lesend) | MVP |
| F-D02 | Taxis/Tablets anlegen, zuordnen, aktivieren/deaktivieren, Status/Karte der Flotte (ohne Standort: Liste) | MVP |
| F-D03 | Medien hochladen/Vorschau, Kampagnen anlegen/pausieren/beenden | MVP |
| F-D04 | Taxigruppen erstellen, Kampagnen zuweisen | MVP |
| F-D05 | Statistiken: Wiedergaben je Kampagne/Gerät/Taxi/Zeit, Geräteverfügbarkeit, Sync-Fehler | MVP |
| F-D06 | Kundenstamm, Buchungszeiträume, Vertragsinfos (einfach) | V2 |
| F-D07 | Kundenportal: eigene Kampagnen ansehen, Material hochladen, Berichte laden | V2/V3 |
| F-D08 | Rechnungen/Buchungsinfos im Portal | V3 |

## 4. Messbarkeit – Definitionen (verbindlich)
| Begriff | Bedeutung | Messbar? |
|---|---|---|
| **Wiedergabe (Play)** | Spot wurde auf dem Tablet vollständig gestartet und beendet, von der App protokolliert | Ja, MVP |
| **Verifizierte Wiedergabe** | Play **und** Bildschirm an, App im Vordergrund, Lautstärke/Helligkeit über Schwelle, Fahrzeug in Betrieb (Laden/Bewegung), Gerät nicht manipuliert | Ja, V2 (durch Sensor-/Statusdaten) |
| **Kontaktchance (OTS, geschätzt)** | Modellierte Zahl, wie viele Personen den Spot sehen konnten (z. B. Fahrten × Schleifen × durchschn. Insassen) | Nur als Schätzung, klar als solche gekennzeichnet |
| **Gesehener Kontakt** | Mensch hat Spot tatsächlich wahrgenommen | **Nicht messbar** ohne Sensorik; wird nicht behauptet |

Kundenberichte weisen **Wiedergaben** aus und kennzeichnen Schätzungen. Keine Kameras/Mikrofone im MVP (Datenschutz). Fahrgast-Anwesenheit: Offen (siehe Entscheidungen).

## 5. Nichtfunktional
| ID | Anforderung | Zielwert (Pilot) | Prio |
|---|---|---|---|
| N-01 | Verfügbarkeit Wiedergabe unabhängig vom Server | Wiedergabe ≥ 99 % der Betriebszeit | MVP |
| N-02 | Datenvollständigkeit: ankommende Wiedergabeereignisse | ≥ 99 % der real gespielten | MVP |
| N-03 | Synchronisierung nach Reconnect | ≤ 24 h, Normalfall ≤ 15 min | MVP |
| N-04 | Wiederherstellung nach Strom-Aus | Wiedergabe ≤ 2 min nach Boot | MVP |
| N-05 | Skalierung | 2.000 Tablets, Heartbeat/Events ohne Architekturwechsel | V3 (Design jetzt) |
| N-06 | Datenvolumen je Tablet mobil | ≤ ca. 1 GB/Monat im Normalbetrieb (Annahme, Messen im Pilot) | MVP |
| N-07 | Betrieb auf einem VPS mit 6 vCPU / 12 GB | Ressourcenlimits je Container | MVP |
| N-08 | Wartbarkeit/Doku: README, Runbooks, ADRs, Tests, CI | durchgehend | MVP |
| N-09 | Backup/Restore PostgreSQL getestet; RPO ≤ 24 h (MVP), ≤ 15 min (V2) | | MVP |
| N-10 | Migration auf Dedicated Server ohne Software-Neuentwicklung und ohne App-Neuauslieferung | | V3 (Design jetzt) |
| N-11 | Beobachtbarkeit: Metriken, Logs, Alarme | | MVP |
| N-12 | Betriebstemperatur/Hardware (Hitze im Fahrzeug) | Nachweis durch Testbetrieb | MVP |

## 6. Sicherheit und Datenschutz
| ID | Anforderung | Prio |
|---|---|---|
| S-01 | Geräte-Identität (Schlüsselpaar im Android Keystore), widerrufbar | MVP |
| S-02 | Verschlüsselte Übertragung (TLS), Zertifikatsprüfung | MVP |
| S-03 | Signierte Ereignisse oder gesicherte Gerätesitzung gegen gefälschte Wiedergaben | V2 |
| S-04 | Kiosk-Härtung, USB-Debugging aus, Bootloader gesperrt, Manipulationserkennung | MVP |
| S-05 | MFA + Rollen im Dashboard, Audit-Log | MVP |
| S-06 | Secrets nie in Git; Rotation | MVP |
| S-07 | Datensparsamkeit: keine Personendaten von Fahrgästen; Fahrzeug-/Fahrerbezug nur wenn nötig | MVP |
| S-08 | GPS/Standort nur mit dokumentierter Rechtsgrundlage, grob/aggregiert, Löschfristen | Offen |
| S-09 | Löschkonzept: Rohereignisse zeitlich begrenzt, Aggregate behalten | MVP |
| S-10 | KI-Agenten isoliert, ohne Root/DB-Zugriff, Freigabepflicht für Änderungen | V3 |
| S-11 | Rechtliche Prüfung (Werbung im Taxi Wien, Abgaben, DSGVO, Verträge) durch Fachperson | vor Pilot |

## 7. Betrieb und Fernverwaltung
| ID | Anforderung | Prio |
|---|---|---|
| B-01 | Flottenübersicht, Alarme per E-Mail/Chat | MVP |
| B-02 | Log-Abruf aus Tablets bei Fehlern | V2 |
| B-03 | OTA-Updates der App, gestaffelter Rollout | V2 |
| B-04 | Fernneustart/Fernkonfiguration | V2 |
| B-05 | Ersatzteil-/Austauschprozess, Seriennummern, Inventar | MVP (einfach) |
| B-06 | Remote-Support-Zugriff (z. B. MDM/Screen) | Offen |

## 8. Spätere KI-Agenten (V3)
Aufgaben: Flottenüberwachung, Fehlerdiagnose, Tagesberichte, Entwicklungsunterstützung, Tests, Wartungsvorbereitung. Regeln: eigener Linux-Benutzer (`taxiagent`), eigenes Netz, nur API-Tokens mit minimalen Rechten, Schreibaktionen nur als Entwurf, Freigabe durch Mensch, vollständiges Audit. Keine produktiven Änderungen ohne Freigabekonzept.
