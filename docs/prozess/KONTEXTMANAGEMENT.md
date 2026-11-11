# Kontextmanagement und neue KI-Sitzungen

Ziel: Eine neue Sitzung (Claude oder DeepSeek) lädt das nötige Projektwissen **zuverlässig aus Dateien**, nicht aus Erinnerung. Status: Vorgeschlagen (ADR-0012).

## 1. Prinzipien
1. **Dateien sind das Gedächtnis.** Was nicht in Dateien steht, gilt als unbekannt.
2. **Kleiner Kontext:** pro Sitzung ein Arbeitspaket; nur referenzierte Dokumente laden („Session-Pack").
3. **Single Source of Truth:** jede Information lebt an genau einer Stelle; andere verweisen darauf (ID/Pfad).
4. **Stand-Datum** in jedem Dokument; ältere/archivierte Fassungen liegen in `ARCHIV/` und sind **nicht verbindlich**.
5. **Kontextverlust erkennen:** Sitzung stoppt und lädt neu, wenn sie sich widerspricht, Dateien nicht mehr zitieren kann oder > ca. 60 % des Kontextfensters verbraucht sind (Sitzungsprotokoll schreiben, neue Sitzung starten).

## 2. Session-Pack (Ladereihenfolge)
| # | Datei | Zweck |
|---|---|---|
| 1 | `CLAUDE.md` / `AGENTS.md` | Einstieg, harte Regeln |
| 2 | `docs/prozess/KI_REGELN.md` | verbindliche Regeln |
| 3 | `docs/fortschritt/STATUS.md` | aktives WP, Blockaden, offene Fragen, letzte Änderungen |
| 4 | WP-Abschnitt in `docs/ARBEITSPAKETE/KATALOG.md` (bzw. `docs/ARBEITSPAKETE/<ID>/`) | Auftrag |
| 5 | Referenzierte Anforderungen (IDs), Verträge, Zustandsmodell-Abschnitte | Details |
| 6 | Letztes Sitzungsprotokoll zu diesem WP (`docs/fortschritt/sessions/`) | Übergabe |
| 7 | Bei Bedarf: `docs/konzept/*`, ADRs | Hintergrund |
Reviewer-Sitzung: zusätzlich PR-Diff, Testausgabe, `DEFINITION_OF_DONE.md`; **nicht** das Protokoll des Implementierers vor dem eigenen ersten Urteil.

## 3. Sitzungsstart (Pflichtablauf)
1. Dateien laut Session-Pack lesen.
2. **Bestätigung ausgeben** (Vorlage in `SESSION_START.md`): aktives WP, Status, Rolle, was erlaubt/verboten ist, bekannte offene Fragen, Konflikte, die aufgefallen sind.
3. Fehlt etwas oder passen Doku/Code nicht zusammen → Konflikt melden, nicht beginnen.

## 4. Sitzungsende (Pflichtablauf)
1. `docs/fortschritt/STATUS.md` aktualisieren (WP-Status, nächste Schritte, offene Fragen).
2. Sitzungsprotokoll `docs/fortschritt/sessions/YYYY-MM-DD_WP-xxx_<rolle>.md` aus Vorlage: Ziel, getan, Entscheidungen (mit Quelle), **Annahmen**, **offene Fragen**, Testausführung (echte Ausgabe/Pfad), nächste Schritte, geänderte Dateien.
3. Commit(s) und PR-Stand sauber; nichts Unversioniertes zurücklassen.

## 5. Schutz vor Drift und Halluzination
- **Konfliktmeldung** statt stiller Korrektur (Doku ↔ Code ↔ Doku).
- **Quellenpflicht:** Anforderungen und Zahlen immer mit ID/Datei zitieren.
- **Frage-statt-Raten:** offene Punkte → `STATUS.md` „Offene Fragen" mit ID `Q-nnn`.
- **Vertragstests** in CI fangen unbemerkte Schnittstellenänderungen ab.
- **Dokumenten-Konsistenzprüfung** (Skript, später WP-001): prüft, dass referenzierte IDs/Dateien existieren und „Stand"-Daten gesetzt sind.
- **Regelmäßige Neustarts:** nach jedem WP neue Sitzung; keine Dauer-Sitzungen über mehrere WPs.

## 6. Wissenszugang für neue Sitzung (Kurzfassung)
`CLAUDE.md` → `KI_REGELN.md` → `STATUS.md` → WP → referenzierte IDs/Verträge → Bestätigung. Das genügt; alles Weitere ist verlinkt.
