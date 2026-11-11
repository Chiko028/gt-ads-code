# WP-006 – Testplan

Status: Entwurf · Stand: 2026-11-09 · Zugehörig: [SPEZIFIKATION.md](SPEZIFIKATION.md) (AC-01…AC-17), [API-VERTRAG.md](API-VERTRAG.md). Regeln: nur synthetische Daten (`SYN-…`, Test-IDs, Fake-Token mit gültigem **Format**, aber wertlos); echte Ausgabe belegen; nichts abschwächen; nicht ausgeführte Tests als „nicht ausgeführt" melden. Werkzeug: `python3 -m unittest` (Standardbibliothek). Telegram/DeepSeek werden in Tests durch **lokale Fake-Server/Fake-Transports** ersetzt; es gibt in Tests **keinen** echten Netzzugriff.

## 1. Unit-Tests (T1)
| ID | Test | AC |
|---|---|---|
| U-01 | Policy: erlaubte ID, privat, Text → verarbeiten | AC-02 |
| U-02 | Policy: fremde ID, Gruppe/Supergruppe/Kanal, Bot-Absender, `edited_message`, Callback, Inline, Foto/Sprache/Sticker, Weiterleitung → **verwerfen, keine Antwort**, Zähler +1 | AC-02, AC-03 |
| U-03 | Policy: leere/fehlende Felder, ungewöhnliche Typen (String-ID, negative ID, riesige Zahl) → verwerfen ohne Fehler | AC-02 |
| U-04 | Text zu lang → Kurzmeldung, **kein** Modellaufruf | AC-09 |
| U-05 | Ratenlimit: Fenstergrenzen (5. ok, 6. blockiert, nach Ablauf wieder ok) mit injizierbarer Uhr | AC-09 |
| U-06 | Tageslimit: Grenze, Tageswechsel `Europe/Vienna` inkl. Sommerzeitwechsel | AC-09 |
| U-07 | `/start`, `/status`, unbekannter Befehl: exakte Texte/Felder; `/status` enthält **keine** ID/Pfad/Host/Schlüssel (Muster-Scan) | AC-04 |
| U-08 | Redaktion: Telegram-Tokenmuster, DeepSeek-Schlüsselmuster, `Authorization` in Logs/Exceptions/Statusausgabe vollständig ersetzt | AC-07, AC-08 |
| U-09 | Config: fehlende/ungültige Werte, unbekannte Schlüssel, fehlende ID (Normalmodus), Grenzen → Startfehler | AC-13 |
| U-10 | Credentials: fehlende Datei/leer → Startfehler; Wert erscheint nie in Fehlermeldung | AC-07 |
| U-11 | Fehlerklassen DeepSeek (401/402/429/5xx/Timeout) → richtige Klasse, Störungsphase, **genau eine** Hinweisnachricht je Phase | AC-10 |
| U-12 | Antwortkürzung auf 4096 Zeichen, Mehrbyte-Zeichen korrekt | AC-04 |
| U-13 | Backoff-Berechnung (Obergrenze, Zurücksetzen nach Erfolg) | AC-10 |
| U-14 | Setup-Modus: nur ID+Zeit im Log, keine Antwort, Selbstende nach Zeitlimit; Normalmodus ohne ID startet nicht | AC-13 |

## 2. Integrationstests (T2) mit lokalen Fakes
| ID | Szenario | AC |
|---|---|---|
| I-01 | Poll-Schleife: Fake-Telegram liefert Update-Folge; Offset wird korrekt fortgeschrieben, keine Doppelverarbeitung | AC-01 |
| I-02 | Ende-zu-Ende: `/start` → Antwort; `/status` → Statusblock; „Antworte mit OK" → Fake-DeepSeek-Antwort wird gesendet | AC-04 |
| I-03 | Fremder Absender und Gruppe: **keine** `sendMessage`-Anfrage am Fake-Server | AC-02 |
| I-04 | Netzfehler/5xx/Timeout bei Telegram und DeepSeek: Dienst läuft weiter, Backoff, danach Erholung | AC-10 |
| I-05 | Guthaben leer (402): `/status` zeigt „nicht verfügbar", eine Hinweisnachricht, kein Modellaufruf-Sturm | AC-10 |
| I-06 | Logs eines Gesamtlaufs: **kein** Nachrichtentext, keine Antwort, kein Token/Schlüssel/ID (Scan) | AC-08 |
| I-07 | Zustandsdatei: nur Metadaten, atomar, überlebt Neustart; fehlt/beschädigt → sauberer Start | AC-12 |
| I-08 | Geheimnisse aus simuliertem `$CREDENTIALS_DIRECTORY` gelesen; Prozess-Argumente/Umgebung enthalten keine Geheimnisse | AC-07 |
| I-09 | Keine Verbindung zu anderen Hosts als den zwei festen (Fake-Resolver protokolliert Ziele) | AC-05 |

## 3. Statische Prüfungen (T7)
| ID | Prüfung | AC |
|---|---|---|
| ST-01 | Alle Importe stammen aus der Python-Standardbibliothek (AST-Scan; kein `pip`-Paket) | AC-06 |
| ST-02 | Verbotene Aufrufe nicht vorhanden: `subprocess`, `os.system`, `os.popen`, `eval`, `exec`, `compile`, `__import__`, `ctypes`, `socket` (direkt), `shutil`, `pickle`, `http.server`, `socketserver` | AC-05 |
| ST-03 | Dateischreibzugriffe nur im Zustandsmodul und nur auf den Zustandspfad | AC-05 |
| ST-04 | Zielhosts nur als Konstanten `api.telegram.org`, `api.deepseek.com`; keine URL aus Konfiguration oder Nachricht | AC-05 |
| ST-05 | Unit-Vorlage: alle Sandbox-Optionen aus ARCHITEKTUR §4 vorhanden, `User=taxiagent`, `LoadCredential`, `Restart=on-failure`, `WantedBy=multi-user.target`; **kein** `ports`, kein `ExecStartPre` mit Shell | AC-11, AC-12 |
| ST-06 | Skripte: `#!/usr/bin/env bash`, `set -Eeuo pipefail`, Geheimnisse nie als Argument/`echo`; `install.sh` mit `--dry-run`, ändert **nicht** UFW/Firewall/SSH/Benutzer | AC-14, AC-15 |
| ST-07 | Secret-Scan über das Paket (Token-/Schlüsselmuster, echte IDs, echte E-Mail/IP): 0 Treffer; `.example`-Datei ohne Werte | AC-07 |
| ST-08 | Link-/INDEX-Prüfung der Dokumentation | DoD |

## 4. Betriebsnachweise auf dem VPS (T6, nach S5, nur durch Betreiber mit sudo)
| ID | Prüfung | Erwartung |
|---|---|---|
| OP-01 | `systemctl status gt-ads-telegram`, `is-enabled`, `is-active` | enabled, active |
| OP-02 | `ss -tlnp` vor/nach | **kein** neuer Listener |
| OP-03 | `systemd-analyze security gt-ads-telegram` | Ergebnis dokumentiert, Ausnahmen begründet |
| OP-04 | Rechte: `sudo -u taxiagent` kann `/srv/taxiwerbung`, `/home/taxiadmin`, `/etc/gt-ads/credentials` **nicht** lesen; Code-Verzeichnis nicht schreibbar | AC-11 |
| OP-05 | Secret-Scan über Journal (`journalctl -u gt-ads-telegram`) und Zustandsverzeichnis | kein Token/Schlüssel/Inhalt |
| OP-06 | `systemctl restart` → Dienst wieder aktiv; **echter Neustart nur mit ausdrücklicher Zustimmung** | AC-12 |

## 5. Manuelle Tests in Telegram (T6) – **nur diese drei**, danach Negativtests
Voraussetzungen: S1 (BotFather), S2 (DeepSeek-Schlüssel), E62 bestätigt (2026-11-09), S5 durchgeführt, ID eingetragen.
| Nr. | Schritt | Erwartung |
|---|---|---|
| M-01 | `/start` senden | feste Begrüßung mit „nur Chat, schreibgeschützt" |
| M-02 | `/status` senden | Statusblock mit allen Feldern aus API-VERTRAG §3, **ohne** ID/Pfad/Schlüssel; Nachrichtenzähler steigt |
| M-03 | „Antworte mit dem Wort OK." senden | kurze Antwort von DeepSeek; `/status` zeigt „Letzter Modellaufruf OK" |
| M-N1 | (Negativ, optional) Nachricht von **zweitem** Telegram-Konto | **keine** Antwort; `/status` zeigt „Verworfen" +1 |
| M-N2 | (Negativ) Bot in eine Gruppe einladen versuchen | nicht möglich (BotFather) bzw. keine Reaktion |
Ergebnisprotokoll (ohne Geheimnisse, ohne Chatinhalte über die Testsätze hinaus): Datum, M-01…M-03, Auffälligkeiten.

## 6. Pflichtbelege im PR
Befehl + vollständige Ausgabe (`python3 -m unittest -v`), Zahl bestanden/fehlgeschlagen/übersprungen (Übersprungene = Blocker), Tabelle AC-01…AC-17 mit Belegtest, Hinweis auf nicht ausführbare (Betreiber-)Tests.
