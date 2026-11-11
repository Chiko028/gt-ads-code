# GT-Ads – Zustandsmodell: zwei Tablets pro Taxi

Stand: 2026-11-09 · Grundlage: Entscheidungsprotokoll Tablet-Betrieb v2.0 · Status: **Entwurf, nichts implementiert**
> Kennzeichen: ✅ Bestätigt · 🟦 Vorläufig · 🔧 Technische Annahme (Test) · ⚖️ Rechtlich zu prüfen

## 1. Grundsätze
1. Jedes Tablet hat einen **eigenen, autonomen** Zustand. Das Taxi-Gesamtbild entsteht auf dem Server aus beiden Meldungen. ✅
2. Der Server unterscheidet **Beobachtung** (was gemeldet wurde) von **Schluss** (was wir daraus ableiten). Fehlende Meldung = „unbekannt", nie automatisch „defekt" oder „aus". ✅
3. **Vorrang** bei Konflikten: (1) Fahrzeug nicht betriebsbereit → keine Wiedergabe · (2) lokaler Pausenbefehl · (3) zentrale Kampagnenregeln. 🟦
4. Keine Fahrerprofile: Befehle tragen Taxi- und Quellenbezug (`taster|app|whatsapp|server|lokal`), keine Personenkennung. 🟦 ⚖️
5. Wiedergaben sind **protokollierte Wiedergaben**, keine Sichtkontakte. ✅

## 2. Zustandsdimensionen je Tablet
| Dimension | Werte | Quelle |
|---|---|---|
| **Fahrzeugbereitschaft** (`veh`) | `bereit`, `nicht_bereit`, `unbekannt` | Netzteil-/Ladesignal, entprellt 🔧 |
| **Pause** (`pause`) | `keine`, `fahrer` (Taster/App/WhatsApp), `betreiber` (Server), `auto` (Zeitregel) | Befehlslog 🟦 |
| **Display** (`disp`) | `an`, `gedimmt`, `aus` | App/Device Owner 🔧 |
| **Wiedergabe** (`play`) | `laeuft`, `gestoppt`, `fallback`, `fehler` | Player |
| **Inhalt** (`content`) | `gueltig`, `keine_gueltige_kampagne`, `lade_neu` | Manifest, Laufzeitfenster |
| **Sync** (`sync`) | `aktuell`, `veraltet`, `offline` | letzte erfolgreiche Verbindung |
| **Energie** (`bat`) | Akku %, `lädt`/`lädt_nicht`, `niedrig`, `kritisch`, Temperatur | Android |
| **Gesundheit** (`health`) | `ok`, `warnung`, `fehler` (+ Code) | Selbstprüfung |
| **GPS-Modus** (`gps`) | `aus` (Standard), `lokal_gebiet`, `uebermittlung` | Konfiguration ⚖️ |

## 3. Zustandsautomat Wiedergabe (je Tablet)
Hauptzustände (`state`):
| Zustand | Bedeutung | Display | Wiedergabe |
|---|---|---|---|
| `BOOT` | Start/Prüfung | an | nein |
| `AKTIV` | Fahrzeug bereit, Kampagne gültig, keine Pause | an | **ja** |
| `PAUSE_FAHRER` | lokal/App/WhatsApp pausiert | an (dunkel/Standbild konfigurierbar) | nein |
| `PAUSE_BETREIBER` | zentral angeordnet | wie oben | nein |
| `NACHLAUF` | Fahrzeug nicht mehr bereit, Wartezeit (Standard 2 min) | an → aus | nein (gestoppt sofort) ✅ |
| `STANDBY` | Fahrzeug aus | **aus** | nein |
| `KEIN_INHALT` | keine gültige Kampagne | an | Fallback-Inhalt |
| `FEHLER` | technischer Fehler (Player, Speicher, Hitze) | an/aus je Fehler | eingeschränkt |
| `UPDATE` | App-/Inhaltsupdate | an | ggf. unterbrochen |
| `DEAKTIVIERT` | Gerät per Betreiber deaktiviert | aus | nein |

Übergänge:
| Von | Ereignis | Nach | Anmerkung |
|---|---|---|---|
| `BOOT` | Prüfung ok, `veh=bereit` | `AKTIV` / `KEIN_INHALT` | |
| `BOOT` | `veh=nicht_bereit` | `STANDBY` | |
| `AKTIV` | `veh→nicht_bereit` (entprellt) | `NACHLAUF` | Wiedergabe stoppt sofort ✅ |
| `NACHLAUF` | Nachlauf abgelaufen | `STANDBY` | Display aus; kein Wake-Lock ✅ |
| `NACHLAUF`/`STANDBY` | `veh→bereit` | `AKTIV` (bzw. Pause/Kein Inhalt) | automatisch fortsetzen ✅ · 🔧 geräteabhängig |
| `AKTIV` | Pausebefehl | `PAUSE_FAHRER`/`PAUSE_BETREIBER` | sofort, offline wirksam 🟦 |
| `PAUSE_*` | Fortsetzen | `AKTIV` | |
| `PAUSE_FAHRER` | `veh→nicht_bereit` | `NACHLAUF` | Pause bleibt gespeichert; Aufhebung bei Fahrzeug-aus: **E36 offen** |
| `AKTIV` | Kampagne endet/keine gültige | `KEIN_INHALT` | |
| beliebig | Fehler erkannt | `FEHLER` | Watchdog versucht Wiederherstellung → `AKTIV` |
| beliebig | Betreiber deaktiviert | `DEAKTIVIERT` | |
| `STANDBY` | Gerät komplett aus (Akku leer/Strom weg) | – (keine Meldung) | Server: „unbekannt" 🔧 |
Entprellung `veh`: Wechsel erst nach stabilem Signal (Startwert 10–30 s, 🔧 aus Test). Start-Stopp-Phasen dürfen keine Pause/Nachlauf-Flattern erzeugen.

## 4. Pausenlogik und Abgleich der beiden Tablets
- Jeder Befehl: `command_id` (UUID), `taxi_id`, `origin`, `type` (`pause`|`resume`), `rev` (monotone Revision je Taxi), `ts_wall`, `ts_mono`. Tablets führen **idempotent** aus (gleiche `command_id` nur einmal). 🟦
- **Taster:** sendet Advertising mit Zähler; **beide** Tablets empfangen und wenden denselben Befehl an → kein Master. 🔧
- **Fahrer-App/WhatsApp/Server:** Befehl geht an den Server, der ihn an beide Tablets verteilt (nur wenn erreichbar). Status „ausstehend/ausgeführt/nicht zustellbar" je Tablet sichtbar. ✅
- Abgleich bei Wiederverbindung: höhere `rev` gewinnt; bei Gleichstand „Pause gewinnt". Wenn beide Tablets verschieden sind, meldet das Dashboard **„Taxi uneinheitlich"** (kein Fehler per se).
- Auto-Wiederaufnahme/Maximaldauer: **E36 offen**.
- Pausen werden als Ereignis gespeichert (Beginn/Ende/Quelle) – für Auswertung getrennt von technischen Fehlern. 🟦

## 5. Meldungen und Ereignisse
**Statusmeldung** (`status`): alle 30–60 min bei Verbindung (mit Jitter) und bei Zustandswechsel (gepuffert, falls offline). Inhalt: `state`, `veh`, `pause` (+ Quelle/seit), `disp`, `play`, `content`, `sync`, Akku/Temp/lädt, `health`+Code, App-/Manifest-Version, Zähler seit letzter Meldung (Wiedergaben, Fehler), `last_full_play_ts`, `last_sync_ts`, `gps`-Modus (kein Standort). ✅
**Ereignisse** (lokal gespeichert, später gebündelt): `play_completed`, `state_changed`, `veh_changed`, `pause_started/ended`, `display_off/on`, `error`, `sync_ok/failed`, `reboot`, `app_crash`. Zeitstempel: Wall + monotone Uhr; Server berechnet Offset. 🔧
**Datensparsamkeit:** kurze Aufbewahrung der Statusdaten, zweckgebunden; keine Standorte (GPS aus), keine Bilder. ⚖️

## 6. Serverseitige Klassifikation (tägliche Auswertung) ✅
Je Tablet und Tag (Zeitfenster = Ereigniszeitraum, nicht Kalenderzeit des Tablets):
- `bereit_min` (Fahrzeug bereit), `pause_min` (je Quelle), `aktiv_min`, `fallback_min`, `fehler_min`, `unbekannt_min`
- `soll_wiedergaben` = (aktiv-fähige Minuten · 60 / Schleifenlänge) je gültigem Spot; `ist_wiedergaben` = protokollierte; `luecke` = Soll − Ist

| Klasse | Regel (Entwurf) |
|---|---|
| **Gesund** | Ist ≈ Soll (Toleranz z. B. ±3 %), keine Fehlercodes |
| **Fahrzeug aus (erwartet)** | Zeiten mit `veh=nicht_bereit` laut Meldung/Ereignis; keine Lücke daraus |
| **Bewusst pausiert** | `pause_min` > 0 mit Befehlsereignis; Lücke wird als Pause erklärt |
| **Technischer Fehler** | `health=fehler`/`play=fehler`/Absturz/Speicher voll/Überhitzung belegt **oder** unerklärte Lücke > Schwelle trotz `veh=bereit` und ohne Pause |
| **Unbekannt/nicht erreichbar** | keine Meldung und keine Ereignisse; Ursache nicht belegbar (Gerät aus, Funkloch, Defekt, Strom weg) |
Eskalation: „Unbekannt" über n Tage (z. B. 3) → Prüfliste („Techniker-Kontrolle"), **kein** automatischer Defektschluss. Alarme nur für „Technischer Fehler" und anhaltend „Unbekannt". Berichte an Kunden nennen **Wiedergaben** und weisen **Pausenzeiten** separat aus (E44). 🟦

## 7. Taxi-Ebene (zwei Tablets)
| Tablet A | Tablet B | Taxi-Gesamtstatus (Dashboard) |
|---|---|---|
| AKTIV | AKTIV | Läuft |
| AKTIV | FEHLER/unbekannt | Läuft eingeschränkt (1 von 2) |
| PAUSE_* | PAUSE_* (gleich) | Pausiert |
| PAUSE_* | AKTIV | **Uneinheitlich** |
| STANDBY | STANDBY | Fahrzeug aus |
| STANDBY | AKTIV/NACHLAUF | Uneinheitlich (Signalprüfung) |
| FEHLER | FEHLER | Technischer Fehler |
| unbekannt | unbekannt | Unbekannt |
Fehleinschätzungen vermeiden: gleicher Zeitversatz-Toleranzbereich (z. B. 2 Statusmeldungen) vor „Uneinheitlich"-Alarm.

## 8. Sonderfälle und Testfälle (Auszug, siehe Hardwaretestplan)
Start-Stopp, kurze Spannungsabfälle beim Anlassen, Akku leer, Android-Neustart, App-Absturz, Taster doppelt gedrückt, Taster defekt, Internet weg, ein Tablet offline, konkurrierende Fernbefehle, Fahrerwechsel, Zeit falsch eingestellt, Update während Wiedergabe, Fahrzeug lange abgestellt (Akku-Entladung), Betreiber deaktiviert Gerät offline (Befehl bleibt ausstehend).

## 9. Offene Punkte
E36 (Pause bei Fahrzeug-aus aufheben? Maximaldauer), E37 (Tasterart), E40 (Nachlauf), E44 (Zählung Pausenzeit), Entprellzeit und Ladesignal-Verhalten je Tablet 🔧, Datenschutzbewertung der Statusdaten ⚖️.
