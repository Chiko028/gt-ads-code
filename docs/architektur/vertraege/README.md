# Schnittstellenverträge (unveränderlich ohne Änderungsantrag)

Status: **Vorgeschlagen.** Es existieren noch keine ausgearbeiteten Vertragsdateien – sie werden in den genannten Arbeitspaketen erstellt und vom Betreiber **freigegeben und eingefroren**. Bis dahin gilt: **nichts implementieren, was einen Vertrag voraussetzt.**

## 1. Vertragsverzeichnis
| ID | Vertrag | Zwischen | Format (geplant) | Ausarbeitung in | Quelle der Anforderungen |
|---|---|---|---|---|---|
| C-01 | Geräte-API (Enrollment, Gerätesitzung, Manifest, Download, Status, Ereignisse, Befehle) | Tablet-App ↔ Backend | OpenAPI (`contracts/device-api.yaml`) | WP-002, WP-205, 211 | F-A03…F-A11, F-B05…F-B07 |
| C-02 | Manifest-Schema (Playlist, Medien, Hashes, Gültigkeit, Version) | Backend → Tablet | JSON Schema (`contracts/manifest.schema.json`) | WP-209 | F-A04, F-A07, F-B05 |
| C-03 | Status- und Ereignis-Schema (inkl. Zustände, Idempotenzschlüssel) | Tablet → Backend | JSON Schema | WP-211, 406 | F-A08, F-A09, ZUSTANDSMODELL §5 |
| C-04 | Befehls-Schema (Pause/Fortsetzen, Quelle, Revision) | Backend/Taster/App ↔ Tablet | JSON Schema | WP-214, 407 | F-A23…F-A27, ZUSTANDSMODELL §4 |
| C-05 | **Zustandsmodell** (Zustände, Übergänge, Klassifikation) | Tablet, Backend, Dashboard | `docs/architektur/ZUSTANDSMODELL.md` (+ maschinenlesbare Tabelle in `contracts/`) | WP-002 | ZUSTANDSMODELL |
| C-06 | Admin-API (Dashboard ↔ Backend) | Dashboard ↔ Backend | OpenAPI (`contracts/admin-api.yaml`) | WP-204…208, 214, 215 | F-D01…F-D09 |
| C-07 | Konfigurationsschlüssel (Statusintervall, Nachlauf, GPS-Modus, Retention, Pausenregeln) mit Typen/Grenzen/Defaults | Backend ↔ Tablet ↔ Dashboard | JSON Schema | WP-215 | Protokoll v2.0 |
| C-08 | Fehler-/Health-Codes | alle | Tabelle (`contracts/codes.md`) | WP-002 | F-A09, F-B09 |
| C-09 | Datenbankschema-Regeln (nur vorwärts migrieren, Rückweg/Backup, Namensschema) | Backend ↔ DB | Regeln in `docs/architektur/vertraege/` + Migrationsdateien | WP-201 | N-09 |
| C-10 | Agenten-API (V3) | KI-Agent ↔ Backend | OpenAPI | WP-705 | S-10 |
Zahlen/Defaults in Verträgen müssen eine Quelle haben; Annahmen (A-xx) werden als Default mit Kennzeichen geführt.

## 2. Regeln
1. **Einfrieren:** Ein Vertrag gilt ab Status „Freigegeben" (Betreiber) als unveränderlich. Version nach SemVer (`1.0.0`); Datei trägt Version und Freigabedatum.
2. **Änderung nur per Change Request (CR)** in `CHANGE_REQUESTS.md`: Begründung, betroffene Module/WPs, Auswirkung auf Geräte im Feld, Migration/Kompatibilität, neue Version, Tests. Betreiber genehmigt; erst dann Änderung in `contracts/**`. Ein ADR dokumentiert die Entscheidung.
3. **Abwärtskompatibilität:** Tablets im Feld lassen sich nicht sofort aktualisieren. Breaking Changes nur mit Übergangszeit (Server unterstützt alte und neue Version), Version im Geräte-Request (`api_version`).
4. **Contract-Tests in CI:** Server und Tablet-App werden gegen dieselben Schemas getestet (Beispiel-Nachrichten **synthetisch** und im Vertragsverzeichnis `contracts/examples/`). Änderung an `contracts/**` ohne genehmigten CR → CI schlägt fehl (geschützter Pfad).
5. **Kein Vertrag durch Code:** Verhalten, das nicht im Vertrag steht, ist nicht garantiert; fehlende Vertragsteile werden als Frage gemeldet, nicht durch Implementierung „festgelegt".
6. **Erweiterungen** (neue optionale Felder) sind CRs mit Minor-Version; Löschen/Umbenennen = Major.

## 3. Änderungsprotokoll
Siehe `CHANGE_REQUESTS.md` (leer, noch keine Verträge freigegeben).
