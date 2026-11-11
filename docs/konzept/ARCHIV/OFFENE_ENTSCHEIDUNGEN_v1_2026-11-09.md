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
| E9 🟡 | Pausen-/Leerlaufregeln: spielen bei leerem Fond, bei Standzeit, Nachts? | Start: spielen, solange Fahrzeug an; „verifiziert" nur bei Fahrzeug aktiv |
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
| E20 🟡 | **GPS/Standort:** ja/nein, Genauigkeit, Rechtsgrundlage, Löschfrist | MVP ohne Standort; später nur grob/aggregiert nach Rechtsprüfung |
| E21 🟡 | Fahrgast-Anwesenheit messen (Sensor/Kamera)? | MVP nein; nur Schätzmodell (Kontaktchance) |
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
