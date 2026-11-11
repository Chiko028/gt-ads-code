# AGENTS.md – Einstieg für KI-Agenten (DeepSeek u. a.)

Modellunabhängiger Einstiegspunkt. Inhalt entspricht `CLAUDE.md`; bei Abweichung gilt `docs/prozess/KI_REGELN.md`.

## Du darfst nur arbeiten, wenn
- ein **Arbeitsauftrag** (`docs/ARBEITSPAKETE/KATALOG.md`, WP-xxx) den Status **Freigegeben** hat und du ihn von der Betreiberin/dem Betreiber zugewiesen bekommen hast, und
- du auf dem Branch `wp/<ID>-<kurzname>` arbeitest (`<ID>` = `WP-xxx` oder `GT-ADS-nnn`).

## Pflichtlektüre (vor der ersten Änderung)
1. `docs/prozess/KI_REGELN.md`
2. `docs/fortschritt/STATUS.md`
3. Dein Arbeitsauftrag + referenzierte Anforderungs-IDs und Verträge (`docs/architektur/vertraege/`)
4. `docs/prozess/DEFINITION_OF_DONE.md` und `docs/prozess/DATENTRENNUNG.md`

## Verbote
- Keine Anforderungen, Zahlen, Schwellwerte, Daten oder Entitäten erfinden. Unklar → Frage in `docs/fortschritt/STATUS.md` unter „Offene Fragen" eintragen und **anhalten**.
- Keine Änderungen an `docs/architektur/vertraege/`, `docs/konzept/` (außer Status), ADRs oder fremden Modulen außerhalb deines Arbeitsauftrags.
- Keine Secrets, `.env`-Werte, Produktivdaten, Kundendaten, echten Gerätekennungen lesen, erzeugen oder committen.
- Kein Zugriff auf produktive Systeme, Docker-Socket des Hosts, Root, öffentliche Ports.
- Kein Merge, kein `git push --force`, keine Änderung an geschützten Branches.
- Tests nicht abschwächen, überspringen oder so schreiben, dass sie immer bestehen.

## Pflichten
- Kleine, nachvollziehbare Commits: `WP-xxx: <Änderung>`.
- Pull Request mit Vorlage `.github/pull_request_template.md`, inkl. Kennzeichnung Fakt/Annahme/Offen.
- Tests **zuerst oder zusammen** mit dem Code; Ergebnis der Testausführung im PR belegen (echte Ausgabe).
- Am Ende: Sitzungsprotokoll `docs/fortschritt/sessions/` anlegen.
