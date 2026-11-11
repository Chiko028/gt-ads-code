# GT-Ads – Hardwaretestplan Tablet-Betrieb

Stand: 2026-11-09 · Status: **Plan, nichts bestellt, nichts installiert** · Grundlage: Entscheidungsprotokoll Tablet-Betrieb v2.0
> Kennzeichen: ✅ Bestätigt · 🟦 Vorläufig · 🔧 Technische Annahme (hier zu prüfen) · ⚖️ Rechtlich zu prüfen. Zahlenwerte in „Bestanden wenn" sind **Vorschläge**, nicht beschlossen.

## 1. Ziel und Regeln
Prüfen, ob Tablet, Strom, Taster und Kiosk-Betrieb die Anforderungen aus `ANFORDERUNGEN.md` (F-A20–F-A29, N-04, N-12) und das `ZUSTANDSMODELL.md` im Alltag erfüllen – **bevor** Serien-Hardware gekauft wird.
**Sicherheitsregeln (verbindlich):**
- **Keine Installation in einem Fahrzeug** ohne: Freigabe Fachbetrieb für das Fahrzeugmodell, Zustimmung des Fahrzeughalters/Partners, geklärte Versicherung/Garantie.
- **Kein Eingriff** in Hochvoltsystem oder sicherheitsrelevante Steuergeräte (Airbag, Bremse, Lenkung, Fahrzeugbus-Manipulation). Strom nur an dafür vorgesehenen, abgesicherten Zubehör-/Zündungsanschlüssen durch Fachbetrieb.
- **GPS bleibt aus** (kein Test mit Standortdaten). ⚖️
- **Presence-Sensoren:** nur Laborversuche (Stufe 1) nach Datenschutzbewertung, nur mit eingewilligten Personen, **keine Bild-/Personendaten speichern**; Kamera/ML nicht Teil dieses Plans. ⚖️
- Testdaten ohne Kundendaten; keine Produktiv-Deployments.

## 2. Teststufen
| Stufe | Ort | Dauer (Schätzung) | Freigabe nötig |
|---|---|---|---|
| **1 Labor** | Schreibtisch, regelbares Netzteil simuliert Zündung | 2 Wochen | Hardwarekauf (Budget E5) |
| **2 Klima/Dauer** | Wärme-/Kälteprüfung, Dauerlauf | 2–3 Wochen | wie 1 |
| **3 Fahrzeug stehend** | 1–2 Fahrzeuge, Fachbetrieb, kein Fahrgast | 1–2 Wochen | Fachbetrieb + Halter + Versicherung (E42) |
| **4 Fahrzeug Fahrbetrieb** | 2–3 Taxis, Feldtest (P8) | 4–6 Wochen | Gate G2/G3 |

## 3. Kandidaten und Ausstattung (Vorschlag)
- 2–3 Tablet-Modelle × 2 Stück (Kriterien: Dauerbetrieb, Temperaturbereich, Akkuschutz/Ladelimit, Device-Owner/Kiosk, Verhalten bei Laden, Updates, Preis).
- Stromversorgung: automotive DC/DC (12→5 V USB-C PD o. ä.), Sicherung, Unterspannungsabschaltung, ggf. Entkopplung/Verzögerungsrelais; regelbares Labornetzteil, Multimeter/Oszilloskop (oder Datenlogger) für Ruhestrom/Spitzen.
- Taster: BLE-Taster (Advertising) und kabelgebundene Variante.
- Präsenzsensoren (nur Labor, optional): ToF-, mmWave-Radar-Modul.
- SIM/Router-Varianten (Entscheidung E16), Halterung, Temperaturlogger, Zeitmessung (Stoppuhr/Skript).
- Test-Server GT-Ads **ohne öffentliche Ports** (lokal/VPN) bzw. Simulation der Manifest-/Status-Schnittstelle.

## 4. Testfälle
Format: **ID · Prüfung · Vorgehen · Messgröße · Bestanden wenn**. Ergebnisse je Tablet-Modell in der Matrix (§6) erfassen.

### A. Tablet, Kiosk, Energie (Stufe 1–2)
| ID | Prüfung | Vorgehen | Bestanden wenn |
|---|---|---|---|
| T-01 | Autostart nach Boot | Strom an/aus, 20 Wiederholungen | App startet ≥ 19/20 ohne Eingriff, ≤ 2 min bis Wiedergabe |
| T-02 | **Start aus Power-off bei angelegtem Strom** 🔧 | Tablet ausschalten, Netzteil anlegen | Modell startet selbst (ja/nein dokumentieren); „nein" → Modell nur mit Alternativkonzept (Akku nie leer/Standby statt Aus) |
| T-03 | Display-Nachlauf & Aus | Netzteil trennen | Wiedergabe stoppt ≤ 5 s, Display nach Nachlauf (2 min ±10 s) aus ✅ |
| T-04 | **Wiederanlauf bei Strom** 🔧 | Netzteil anlegen aus `STANDBY`/Nachlauf/Display aus | Display an + Wiedergabe ≤ 60 s, 20/20 |
| T-05 | Kein permanenter Wake-Lock | Standby 12 h im Standby mit Akkuentladung messen | Akkuverlust ≤ Vorgabe (Vorschlag ≤ 3 %/12 h im STANDBY) |
| T-06 | Ladeverhalten bei vollem Akku 🔧 | Akku 100 %, Strom an/aus | Erkennung „Netzteil angeschlossen" zuverlässig (kein Flattern) |
| T-07 | Entprellung Zündung | Netzteil 1–30 s ein/aus/ein (Start-Stopp-Simulation) | Keine Zustandsflatter ≥ x; Entprellwert festlegen |
| T-08 | Absturz/Freeze | App killen, Out-of-Memory, Player-Fehler | Neustart der Wiedergabe ≤ 60 s selbständig |
| T-09 | Android-Neustart, Strom weg | Akku leer laufen lassen, wieder laden | Selbständig zurück in `AKTIV` (sofern T-02 ok) |
| T-10 | Kiosk-Härte | Statusleiste, Home, Zurück, Einstellungen, Notification, USB-Debugging, Safe Mode, Factory Reset-Versuche | Keine Umgehung ohne Admin-Weg; Ausnahmen dokumentieren |
| T-11 | Offline-Wiedergabe | Flugmodus 72 h | Wiedergabe unterbrechungsfrei; Ereignispuffer ≥ 100.000 verlustfrei |
| T-12 | Zeitabweichung | Tablet-Uhr ±1 h/±1 Tag | Laufzeitfenster bleibt korrekt (Server-Offset), Ereignisse korrigierbar |
| T-13 | Hitze (Stufe 2) 🔧 | Wärmeschrank bis 50–60 °C stufenweise, Display an, laden | Kein Absturz/Abschaltung; Ladeabschaltung/Temperaturmeldung; Akku nicht aufgebläht; Modell-Grenze notieren |
| T-14 | Kälte | −10 °C kurz, Kaltstart | Startet oder dokumentierte Grenze |
| T-15 | Dauerlauf | 14 Tage durchgehend mit Zündungszyklen | ≥ 99 % Wiedergabezeit, 0 Eingriffe, Speicher stabil |
| T-16 | Datenverbrauch | SIM-Zähler, 14 Tage | Wert dokumentieren (Zielvorschlag ≤ 1 GB/Monat Normalbetrieb) |
| T-17 | Update unter Last | App-/Manifest-Update während Wiedergabe | Atomar, kein Schwarzbild, Rollback funktioniert |

### B. Strom und Fahrzeugsignal (Stufe 1 Labor, 3 Fahrzeug – nur Fachbetrieb)
| ID | Prüfung | Vorgehen | Bestanden wenn |
|---|---|---|---|
| P-01 | Spannungsbereich | Labornetzteil 9–16 V + Anlasseinbruch (< 6–7 V) + Lastabwurf-Spitzen (sofern Messmittel) | Wandler/Tablet unbeschädigt; Zustand definiert |
| P-02 | Unterspannungsschutz | Spannung langsam absenken | Abschaltung vor Batterieschaden, sauberer Wiederanlauf |
| P-03 | Ruhestrom | Zündung aus, nach 10 min messen | Im Zielbereich (Vorschlag < 1 mA bei vollständiger Trennung; sonst Begründung) |
| P-04 | Absicherung | Sicherung korrekt dimensioniert, Leitungsquerschnitt, Verlegung | Fachbetrieb-Abnahme dokumentiert |
| P-05 | Fahrzeugsignal Verbrenner | Zündungsplus/Zubehörplus am Sicherungskasten (Fachbetrieb) | Signal folgt Zündung zuverlässig, Verzögerung bekannt |
| P-06 | Fahrzeugsignal Hybrid/Elektro | Modellspezifisch „Betriebsbereit"/Zubehörsignal ermitteln; **kein Eingriff in Hochvolt/Sicherheitssysteme** | Signal eindeutig, dokumentierte Quelle; sonst Modell ausschließen |
| P-07 | 12-V-Bordnetz-Rückwirkung | Fehlercodes im Fahrzeug, Verhalten Start-Stopp, Bordnetzstabilität | Keine Fehlermeldung, kein Garantierisiko lt. Fachbetrieb |
| P-08 | Standzeit | Fahrzeug 7 Tage abgestellt | 12-V-Batterie ohne spürbare Zusatzentladung |
| P-09 | EMV/Funk | Radio, Mobilfunk, Navigation, Taxameter im Betrieb | Keine Störungen |

### C. Taster und Fahrersteuerung (Stufe 1, 3)
| ID | Prüfung | Vorgehen | Bestanden wenn |
|---|---|---|---|
| D-01 | Taster → beide Tablets | BLE-Advertising, 200 Betätigungen | ≥ 99 % erreichen beide Tablets ≤ 1 s (🔧) |
| D-02 | Offline | Internet getrennt | Pause/Fortsetzen unverändert wirksam |
| D-03 | Mehrfachdruck/Prellen | schnelles Drücken (5×/s) | Idempotent, definierter Endzustand |
| D-04 | Taster defekt/Batterie leer | Taster entfernen | Warnung im Dashboard; Fahrer-App weiter nutzbar |
| D-05 | Reichweite/Störung im Fahrzeug | Position Fahrerplatz, Türen zu, Phone/BLE-Störer | Zuverlässig am Fahrerplatz; Position festlegen |
| D-06 | Konkurrierende Befehle | Taster + App + Server gleichzeitig | Vorrangregeln aus `ZUSTANDSMODELL.md` §4 |
| D-07 | Ein Tablet offline | Tablet B getrennt, Taster drücken | A pausiert; B holt Zustand bei Rückkehr (Rev) |
| D-08 | Fahrerwechsel | Zwei Schichten ohne Profil | Kein Personenbezug im Log ⚖️ |
| D-09 | Bedienbarkeit | 5 Fahrer testen (Feedback) | ≥ 4/5 verstehen Pausenanzeige/Taster ohne Erklärung |
| D-10 | Fahrer-App (Prototyp) | Web/Android Pause/Fortsetzen | Befehl erreicht beide Tablets ≤ 10 s bei Verbindung |
| D-11 | WhatsApp (nur Konzept) | Kein Test vor Datenschutz-/Kostenprüfung ⚖️ | – |

### D. Fahrgasterkennung (nur Labor, optional) ⚖️
| ID | Prüfung | Vorgehen | Messgrößen |
|---|---|---|---|
| S-01 | ToF/Radar auf Rückbank-Attrappe | Leere Bank, 1–3 Personen, Gepäck, Kleidung, Sitzwechsel, Dunkelheit | Erkennungsrate, Fehlalarme, Reaktionszeit (Ein/Aus) |
| S-02 | Näherungssensor des Tablets (Android) | Gleiche Szenen | Nur Referenz; erwartet unzureichend 🔧 |
| S-03 | Fahrzeugsitzsignal | **Nicht Teil** (Fahrzeug-Sicherheitssystem; nur wenn rechtlich/technisch freigegeben) | – |
Vorschlag Mindestgüte (nur Orientierung): Erkennung ≥ 95 %, Fehlauslösung ≤ 5 %, Ein/Aus ≤ 5 s. Datenschutz: nur boolescher Ausgabewert, kein Rohdatenspeicher, Einwilligung der Testpersonen. Kamera/ML bewusst nicht getestet. ⚖️

### E. Mobilfunk und Betrieb
| ID | Prüfung | Bestanden wenn |
|---|---|---|
| M-01 | Funkqualität Wien (Tunnel, Parkhaus, Flughafen) | Sync wird nach Rückkehr automatisch nachgeholt ≤ 15 min |
| M-02 | SIM je Tablet vs. Router je Taxi | Kosten, Ausfallrisiko, Datenvolumen dokumentiert (E16) |
| M-03 | Statusmeldungen 30–60 min | Eingang vollständig, Jitter funktioniert, Datenvolumen klein |
| M-04 | Tägliche Auswertung | Klassifikation trifft bekannte Testfälle (Pause/aus/Fehler/unbekannt) |
| M-05 | Montage/Austausch | Austausch eines Tablets ≤ 15 min, Neuprovisionierung ≤ 20 min |
| M-06 | Diebstahlschutz/Halterung | Abschließbar, keine scharfen Kanten, kein Verletzungsrisiko |
| M-07 | Sicherheit der Fahrgäste | Befestigung auch bei Vollbremsung/Verkehrsunfallkräften plausibel; Fachbetrieb-Freigabe |

## 5. Ablauf der Stufen
1. **Stufe 1 (Labor):** T-01…T-12, P-01…P-03, D-01…D-07, S-01 (optional), M-03/M-04 mit Simulationsdaten.
2. **Stufe 2 (Klima/Dauer):** T-13…T-17.
3. **Gate G2:** Ergebnisse je Modell bewerten; Modell(e) auswählen; Fachbetrieb + Halter + Versicherung bestätigt (E42).
4. **Stufe 3 (Fahrzeug stehend):** P-04…P-09 an je einem Fahrzeug jedes Typs (Verbrenner/Hybrid/Elektro, E42), T-02…T-09 im Fahrzeug, D-05.
5. **Stufe 4 (Fahrbetrieb, P8):** alle relevanten Tests im Echtbetrieb, D-09, M-01/M-02/M-05…M-07; Auswertung nach 4–6 Wochen.

## 6. Ergebnismatrix (Vorlage je Modell)
| Modell | T-02 Boot aus Power-off | T-04 Wiederanlauf | T-13 Hitze max °C | Kiosk | Ladeabschaltung | Verbrauch | Strompreis/Stk. | Entscheidung |
|---|---|---|---|---|---|---|---|---|
| (Modell A) | | | | | | | | |
| (Modell B) | | | | | | | | |
| (Modell C) | | | | | | | | |
Dokumentation je Test: Datum, Gerät/Seriennummer, Firmware/Android-Version, App-Version, Messwerte, Foto/Log, Abweichungen.

## 7. Abbruchkriterien
Überhitzung/Aufblähen des Akkus, Rauch/Geruch, Fahrzeugfehlermeldung, Spannungsprobleme → sofort trennen, Fachbetrieb informieren, Modell/Variante sperren.

## 8. Offene Punkte
Fachbetrieb und Fahrzeugmodelle (E42), Taster-Technik (E37), Nachlauf (E40), SIM-Variante (E16), Budget (E5), Datenschutzbewertung Sensoren/Statusdaten (E43).
