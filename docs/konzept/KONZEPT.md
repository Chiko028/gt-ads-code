# GT-Ads – Konzept und Produktvision

Stand: 2026-11-09 (Protokoll Tablet-Betrieb v2.0 eingearbeitet) · Status: Planungsstand, nichts davon ist beschlossen oder implementiert, solange es nicht in `OFFENE_ENTSCHEIDUNGEN.md` als entschieden markiert ist.
Alle Zahlen sind **Annahmen des Betreibers** oder **Rechenbeispiele daraus** und mit „Annahme" gekennzeichnet.

## 1. Vision
**GT-Ads** ist ein eigenes digitales Werbenetzwerk für Taxis in Wien. Zwei fest montierte Android-Tablets im Fond zeigen Fahrgästen während der Fahrt Werbespots lokaler und überregionaler Unternehmen. GT-Ads betreibt Hardware, Plattform und Vertrieb selbst und ist nicht von kostenpflichtiger Digital-Signage-Software eines Drittanbieters abhängig.

Langfristziel: bis zu 1.000 Taxis / 2.000 Tablets. Start klein, Skalierung erst nach erfolgreichen Tests.

## 2. Geschäftsmodell
| Seite | Wer | Was |
|---|---|---|
| Einnahmen | Werbekunden | Monatliche Buchung von Werbeplätzen im Netzwerk (bzw. in Taxigruppen) |
| Ausgaben | Taxi-Partner (Unternehmen/Eigentümer) | Vereinbarte monatliche Vergütung |
| Ausgaben | Betrieb | Hardware, Mobilfunk, Wartung/Ersatz, Server, Entwicklung, Vertrieb, Steuern/Abgaben |

**Werbemodell (Planungsgrundlage, nicht verbindlich):** 12 Werbeplätze zum Start, maximal 16 pro Schleife, Spots ≈ 15 s, kontinuierliche Wiedergabe, monatliche Buchung, zentral gesetzter Beginn/Ende, Verteilung auf Taxis oder Taxigruppen.

**Konsequenz für die Software:** Preise, Pakete, Sendehäufigkeit und Verträge sind offen. Die Plattform modelliert deshalb **Buchung** (Kunde × Zeitraum × Zielgruppe × Ausspielungsregel) getrennt von **Preis/Abrechnung**. Neue Modelle (feste Plätze, Gewichtung/Share-of-Voice, Tageszeitfenster, Exklusivität) entstehen als neue Regeltypen, nicht als Umbau.

## 3. Einheitenwirtschaft (Rechenbeispiel auf Betreiber-Annahmen)
Annahmen: 80 € Partnervergütung + 10 € Mobilfunk + 10 € Wartungsreserve pro Taxi/Monat; 500 € Hardware pro Taxi, hier über 36 Monate abgeschrieben (≈ 14 €).
→ **Direkte Kosten ≈ 114 € pro Taxi und Monat** (ohne Server, Entwicklung, Vertrieb, Content-Erstellung, Support, USt/Abgaben, Ausfälle).

Bei 12 Plätzen und Auslastung *a* muss ein Werbeplatz je Taxi und Monat netto mindestens **114 / (12 · a)** erlösen:

| Auslastung der Plätze | Mindestpreis je Platz und Taxi/Monat |
|---|---|
| 100 % | ≈ 9,50 € |
| 75 % | ≈ 12,70 € |
| 50 % | ≈ 19,00 € |
| 30 % | ≈ 31,70 € |

Mit 30 % Gemeinkostenaufschlag (Vertrieb, Support, Server, Ausfälle – Annahme) liegen die Werte rund 30 % höher.
Beispiel Pilot mit 10 Taxis: ≈ 1.140 € direkte Kosten/Monat; Netzwerkpreis je Platz bei 6 von 12 Plätzen gebucht ≈ 190 €.
Beispielvolumen (Annahme: 10 h Betrieb/Tag, 25 Tage, Schleife 16 Spots × 15 s = 240 s, 2 Tablets): ≈ **7.500 Tablet-Wiedergaben je Spot und Taxi und Monat**.
Diese Rechnung ist ein **Plausibilitätswerkzeug**, kein Business Plan. Echte Preise müssen am Markt getestet werden (siehe `OFFENE_ENTSCHEIDUNGEN.md`).

## 4. Beteiligte und ihr Nutzen
- **Fahrgäste:** sehen Werbung; keine Kamera/Mikrofon/Personendaten. Kein Tracking von Personen.
- **Taxi-Partner:** erhalten monatliche Vergütung; wollen Zuverlässigkeit, keinen Aufwand, keine Störung des Fahrbetriebs.
- **Werbekunden:** wollen nachvollziehbare Ausspielung, einfache Buchung, nachweisbare Berichte.
- **GT-Ads-Betrieb:** Flottenstatus, Kampagnenplanung, Abrechnung, Wartung.

## 5. Kernprinzipien
1. **Offline-first:** Wiedergabe hängt nie von der Verbindung ab.
2. **Ehrliche Metriken:** Wir unterscheiden strikt **Wiedergabe (protokolliert)** von **nachweislich gesehenem Kontakt**. Letzterer ist ohne Sensorik nicht messbar und wird nicht behauptet (siehe `ANFORDERUNGEN.md` §4).
3. **Selbst betreibbar:** kein Lock-in, offene Komponenten, vollständige Dokumentation.
4. **Skalierbar ohne Neuentwicklung:** VPS → Dedicated Server durch Container, Domain, austauschbaren Speicher.
5. **Sicherheit zuerst:** Geräte-Identität, Kiosk-Härtung, getrennte KI-Agenten ohne Produktivzugriff.
6. **Klein anfangen:** Pilot beweist Technik und Wirtschaftlichkeit, bevor Hardware in Serie geht.

## 6. Abgrenzung (nicht Teil von Version 1)
Automatische Zahlungsabwicklung, vollwertiges Self-Service-Buchungssystem, Fahrgast-Interaktion (QR/Aktionscodes), Standort-Targeting, Kamera-basierte Publikumsmessung.

## 7. Offene Annahmen und Risiken auf einen Blick
Siehe `ARCHITEKTUR.md` §13 (Schwachstellen) und `OFFENE_ENTSCHEIDUNGEN.md`. Wichtigste: Wirtschaftlichkeit bei niedriger Auslastung, Hardware im Fahrzeug (Hitze, Strom, Diebstahl), Rechts-/Datenschutzlage in Wien, Messbarkeit echter Kontakte, Aufwand Fernverwaltung.

## 8. Namens- und Strukturfestlegungen
- Produkt- und Markenname: **GT-Ads**. Technischer Projektname: `gt-ads` (Repositories, Container, Compose-Projekt, Datenbank `gt_ads`).
- Serververzeichnis `/srv/taxiwerbung` bleibt vorerst bestehen (Umbenennung erst nach Abhängigkeitsprüfung, siehe `ARCHITEKTUR.md` §12).

> Statuskennzeichen: ✅ **Bestätigt** (Betreiberentscheidung) · 🟦 **Vorläufig** (Richtungsentscheidung) · 🔧 **Technische Annahme** (im Test zu prüfen) · ⚖️ **Rechtlich zu prüfen** (nicht freigegeben)

## 9. Betriebsmodell Tablet (Protokoll v2.0, 09.11.2026)
| Thema | Entscheidung | Status |
|---|---|---|
| Fahrgasterkennung | Optionales, austauschbares Modul; im MVP **nicht vorausgesetzt**. Wiedergabe bei betriebsbereitem Fahrzeug, gültiger Kampagne, ohne Pause. Sensorversuche erst nach Datenschutzprüfung; keine Bildspeicherung/-übertragung | 🟦 Vorläufig · ⚖️ (Kamera/ML, Sensoren) |
| Energie | Kein Dauerleuchten: Fahrzeug nicht betriebsbereit → Wiedergabe stoppt, Display nach Nachlauf (Start 2 min, konfigurierbar) aus; Ladesignal zurück → automatisch fortsetzen. Kein permanenter Wake-Lock. Vollständiges Einschalten aus Power-off ist geräteabhängig und **nicht zugesichert** | ✅ Bestätigt · 🔧 Gerätetest |
| Fahrersteuerung | Grundfunktion „Werbung pausieren/fortsetzen" (nicht Power-off) für beide Tablets eines Taxis. Physischer Taster bevorzugt (muss offline wirken), Fahrer-App zweiter Kanal, WhatsApp später optional | 🟦 Vorläufig · 🔧 Taster-Prototyp · ⚖️ WhatsApp |
| Stromversorgung | Geschaltet/fahrzeugabhängig statt ungesichertem Dauerplus: abgesichert, automotive DC/DC, Unterspannungsschutz; Elektrofahrzeuge: Betriebsbereit-/Zubehörsignal ermitteln. Kein Eingriff in Hochvolt/Sicherheitssysteme | ✅ Bestätigt (Richtung) · 🔧 Fachbetrieb-Freigabe je Modell |
| Überwachung | Lokale Ereignisse + Statusmeldungen (online z. B. alle 30–60 min), **tägliche zentrale Auswertung**; Zustände getrennt (aktiv, Pause angeordnet, Display aus, Akku niedrig, lädt, letzte Wiedergabe, letzter Sync, unbekannt). Fehlende Meldung beweist weder Ausschaltung noch Defekt | ✅ Bestätigt |
| GPS | Fähigkeit vorsehen, im Betreiber-Dashboard konfigurierbar, **Standard AUS**; Modi: aus · lokale Gebietserkennung ohne Rohkoordinaten-Upload · Standortübermittlung (gesondert freizugeben). Aktivierung im Dashboard ist keine DSGVO-Rechtsgrundlage | ✅ Bestätigt (Standard AUS) · ⚖️ Datenschutz/Arbeitsrecht vor jeder Nutzung |

**Auswirkung auf Metriken:** Pausen, Fahrzeug-aus und Display-aus werden getrennt erfasst; Berichte weisen Wiedergaben und Pausenzeiten aus, nie „Sichtkontakte". Detailliert in `ZUSTANDSMODELL.md`. Hardwaretests in `HARDWARETESTPLAN.md`. Es wurde nichts implementiert, nichts installiert; das Protokoll ist **keine** Freigabe für Hardwareinstallation oder GPS-Verarbeitung.
