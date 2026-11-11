# MASTERBRIEFING – GT-Ads | Eigene digitale Taxiwerbung-Plattform (Quelle: Betreiber)

> Ablage 2026-11-09 durch Claude. Inhalt des Betreiber-Briefings sinngemäß vollständig übernommen; Projektname laut Betreiberanweisung „CabAds" → „GT-Ads" ersetzt (technisch `gt-ads`; Serververzeichnisse unter `/srv/taxiwerbung` bleiben vorerst bestehen). Bei Zweifel gilt das Originaltext-Dokument des Betreibers.

## Geschäftsidee
Digitales Werbenetzwerk in Wien. In teilnehmenden Taxis zwei Android-Tablets im hinteren Fahrgastbereich, feste Montage; Fahrgäste sehen Spots lokaler und überregionaler Unternehmen. Werbekunden zahlen für Ausstrahlung; Taxiunternehmen/Fahrzeugeigentümer erhalten monatliche Vergütung. Eigenbetrieb, keine Abhängigkeit von kostenpflichtiger Digital-Signage-Software. Langfristig bis zu 1.000 Taxis / 2.000 Tablets; Start klein, Skalierung nach Tests.

## Werbemodell (Planungsgrundlage, nicht verbindlich)
12 Werbeplätze zum Start, max. 16 pro Schleife; Spots ≈ 15 s; kontinuierliche automatische Wiedergabe; monatliche Buchungen; zentral gesetzter Beginn/Ende; Verteilung auf Taxis oder Gruppen. Preise, Pakete, Sendehäufigkeiten, Verträge nicht beschlossen. Software muss unterschiedliche Buchungsmodelle später ermöglichen.

## Hardware in den Taxis
Zwei Android-Tablets je Taxi, feste Halterung im Fahrgastbereich, Fahrzeugstrom, SIM/eSIM, lokaler Speicher, Autostart, möglichst manipulationssicherer Kiosk-Modus, Wiederherstellung nach Verbindungs-/Stromunterbrechung. Modelle, Stromversorgung, Batterieabsicherung, Montage noch festzulegen/zu testen.

## Android-App (Soll)
1 automatischer Start · 2 Kampagnen vom Server empfangen · 3 Videos/Bilder lokal laden · 4 Offline-Wiedergabe · 5 Playlist/Reihenfolge einhalten · 6 Kampagnen nur in Laufzeit · 7 Wiedergabeereignisse lokal protokollieren · 8 Statistiken bei Verbindung synchronisieren · 9 Online-/Offline-Status melden · 10 Software-/Inhaltsupdates kontrolliert · 11 Kiosk-Modus gegen Bedienung geschützt · 12 Bei Fehlern automatisch zur Wiedergabe zurück. Später: QR-Codes, Aktionscodes, standortabhängige Werbung, Interaktionen. **Wichtig:** technisch sauber zwischen protokollierten Wiedergaben und nachweislich gesehenen Werbekontakten unterscheiden.

## Dashboard
Taxi-/Geräteverwaltung (Taxis registrieren, je Taxi zwei Tablets, aktivieren/deaktivieren, Online-Status, App-Versionen/Fehler, Taxigruppen) · Werbekunden (Daten, Kampagnen, Buchungszeiträume, Vertrags-/Abrechnungsinfos vorbereiten) · Kampagnen (Upload, Plätze, Start/Ende, Zuordnung zu Fahrzeugen/Gruppen, Regeln, pausieren/beenden) · Statistiken (Wiedergaben nach Kampagne/Gerät/Taxi, Verfügbarkeit, Sync-Fehler, Kundenberichte).

## Werbekundenportal (langfristig)
Eigene Kampagnen ansehen, Material zur Freigabe hochladen, Laufzeiten kontrollieren, Auswertungen herunterladen, Rechnungen/Buchungsinfos. Vollwertiges Self-Service-Buchungssystem in Version 1 nicht zwingend.

## Abrechnung / Geschäftsprozesse
Einnahmen: Werbekampagnen. Ausgaben: Partnervergütung, Hardware, Mobilfunk, Wartung, Server. **Frühere Kalkulationsannahmen (nicht bestätigt):** bis zu 80 € Partner/Taxi/Monat; ca. 10 € Mobilfunk; ca. 10 € Wartungsreserve; ca. 500 € Hardware pro Taxi. Plattform liefert Daten für spätere Abrechnung/Vergütung; automatische Zahlungsabwicklung zunächst keine Pflicht.

## Vorhandene Infrastruktur
Contabo Cloud VPS 6, Ubuntu 24.04 LTS, 6 vCPU, 12 GB RAM (gebuchte Konfiguration), Docker + Compose, Git, SSH-Schlüssel, UFW, Administrator `taxiadmin`, `/srv/taxiwerbung`, Benutzer `taxiagent`. Bestehende Architektur ist Vorschlag, keine unveränderliche Entscheidung.

## Architekturziele
Selbst betreib- und weiterentwickelbar · startet auf dem VPS · testbar mit wenigen Tablets · skalierbar bis 2.000 Tablets · Offline-Wiedergabe · effiziente Inhaltsverteilung · sichere Geräteauthentifizierung · nachvollziehbare Wiedergabeprotokolle · später auf Dedicated Server migrierbar · wartbar und dokumentiert · niedrige laufende Kosten ohne Abstriche bei Sicherheit/Zuverlässigkeit.

## Spätere KI-Agenten
Flottenüberwachung, Fehlerdiagnose, Tagesberichte, Entwicklungsunterstützung, automatisierte Tests, Wartungsvorbereitung; unabhängig vom Privatcomputer lauffähig; kein uneingeschränkter Zugriff auf Produktiv-/Kundendaten/Root; autonome produktive Änderungen nur mit gesondertem Freigabekonzept.

## Ausdrücklich offen
Tablet-Modelle · Fahrzeuganzahl Pilot · Werbepreise · Buchungs-/Vergütungsmodelle · Details Werbeschleife · Pausen-/Interaktionsregeln · GPS und Datenschutz · Kunden-Self-Service · Domains/öffentliche Erreichbarkeit · Offsite-Backups/Mediendateispeicher · Fernverwaltung. **Keine endgültigen Produktentscheidungen ohne fachliche Grundlage.**

## Auftrag damals
Dokumente erstellen: KONZEPT, ANFORDERUNGEN, ARCHITEKTUR, ROADMAP, OFFENE_ENTSCHEIDUNGEN; Schwachstellen analysieren; priorisierte Empfehlung für kleinsten sinnvollen Pilot; keine Anwendungsentwicklung, keine Serverkonfigurationsänderung, keine zusätzlichen Ports.
