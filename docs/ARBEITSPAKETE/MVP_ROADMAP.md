# Priorisierte MVP-Roadmap (Entwicklungsplanung)

Stand: 2026-11-09 · Ergänzt `docs/konzept/ROADMAP.md` (Produktphasen P0–P12, Gates G1–G4) um die konkrete **WP-Reihenfolge**. Zeitangaben bewusst weggelassen: sie hängen von Hardware, Klärungen und Review-Zyklen ab und wären Schätzung ohne Grundlage (A).
Prinzip: **Ende-zu-Ende zuerst** („Walking Skeleton"), dann in Schichten erweitern; jeder Meilenstein ist einzeln abnehmbar.

## Meilensteine
| M | Name | WPs | Abnahmekriterium (aus Dokumenten) |
|---|---|---|---|
| **M0** | Fundament | (erledigt) + WP-004 | Server gehärtet, Docker, Doku, Prozess freigegeben |
| **M1** | Rahmen & Sicherheit der Entwicklung | WP-001, 002, 003, 101 | CI grün, Secret-Scan/Prod-Guard-Tests, erster Vertragsentwurf freigegeben, Compose ohne öffentliche Ports |
| **M2** | Backend-Kern | WP-201, 202, 203, 204 | Taxis/Geräte/Gruppen verwaltbar mit MFA, Rollen, Audit |
| **M3** | Gerät verbindet sich | WP-205, 401, 402 | Testtablet enrolliert per Token; widerrufenes Gerät wird abgewiesen |
| **M4** | Spot auf dem Tablet | WP-206, 207, 208, 209, 210, 403, 404 | Synthetischer Testspot läuft **offline** auf dem Tablet gemäß Manifest und Laufzeitfenster |
| **M5** | Zustand & Telemetrie | WP-405, 406, 211, 212, 213 | Zustandsautomat laut Tabelle; Ereignisse verlustfrei/idempotent; tägliche Klassifikation korrekt auf synthetischen Verläufen |
| **M6** | Bedienung & Verwaltung | WP-301, 302, 303, 304, 214, 215, 305, 407, 408, 409 | Dashboard zeigt getrennte Status; Pause wirkt auf beide Tablets offline/online; GPS bleibt `aus` |
| **M7** | Betrieb | WP-102, 103, 104, 105, 216 | Monitoring, Restore-Test dokumentiert, Alarme nur für technische Fehler |
| **M8** | Hardware (parallel ab M4/M5) | WP-501, 502 | Ergebnismatrix mit echten Messwerten; Modellentscheidung E14 |
| **G2** | Gate | – | Elektro-/Fachbetriebsfreigabe (E42), Datenschutz (E43), Backup/Restore bestanden |
| **M9** | Fahrzeug stehend → Feldtest | WP-503, 504 | HARDWARETESTPLAN §5 Stufen 3–4 mit Kriterien |
| **G3** | Gate | WP-106 | Domain/443 oder Tunnel freigegeben; Pilot Go/No-Go |

## Priorität innerhalb des MVP
1. **Muss** (ohne diese kein Pilot): WP-001/002/003/101, 201–205, 206–210, 211, 213, 214, 401–408, 301–305, 104, 103.
2. **Sollte** (Pilot ohne sie riskant): WP-212 (Retention), 216 (Alarme), 105, 409 (Schnittstellen).
3. **Parallel/Betreiber:** WP-501–504, 601–604.
4. **Nach Pilot (V2/V3):** Bereich H, WP-306.

## Reihenfolgeregeln
- Verträge (WP-002) vor jeder Server-App-Kommunikation.
- Keine Android-Zustandslogik (WP-405ff) vor entschiedenem E36/E40 oder nur konfigurierbar.
- Backend vor Dashboard-Funktionen; Dashboard vor Pilot nur Minimalumfang laut F-D-IDs mit Prio MVP.
- Jede Meilenstein-Abnahme: Betreiber setzt Status in `docs/fortschritt/STATUS.md`; Rückblick (Annahmen/Abweichungen) wird in `docs/analyse/…` und STATUS ergänzt.

## Erster Freigabevorschlag (kleinster Schritt)
1. Betreiber gibt Prozessdokumente und ADRs frei (WP-004).
2. Betreiber entscheidet A-05 (Technologie) und L-11 (GitHub/CI/DeepSeek-Ort).
3. Danach WP-001 als **erstes** freigegebenes Arbeitspaket (klein, risikoarm, ohne Produktbezug).
