# CX-028 – Sitzungsprotokoll (Coding-Agent)

Datum: 2026-11-13
Arbeitspaket: CX-028 v1 – R-003 / CX-020-Ersatz A: dauerhafte Alarmepisoden
Branch: agent/CX-028
Status: Implementierung und Tests abgeschlossen, keine offenen Blocker

## Umsetzung

- apps/api/src/db/migrations/0006_cx_028_technical_alarms.{up,down}.sql
  - additive Tabellen fuer Ressourcenstand, Episoden und Outbox;
  - Teilindex: hoechstens eine offene Episode je Ressource;
  - eindeutiger Schluessel: hoechstens ein Versandauftrag je Episode;
  - Outbox vorbereitet fuer Status, Versuchszahl, naechsten Versuch, Lease
    und bereinigten Fehlercode; kein Versand.
- apps/api/src/modules/technicalAlarms/
  - explizit aufrufbarer Service ohne HTTP-Route oder Scheduler;
  - CX-010 bleibt unveraendert; ein schmaler Adapter validiert dessen
    Klassifikationsschluessel und reicht technische Evidenz weiter;
  - Advisory-Sperre je Ressource, Ressourcenstand gegen Wiederholungen und
    aeltere Versionen, Transaktion fuer Episode/Auftrag/Audit;
  - Audit ueber den vorhandenen transaktionsgebundenen Schreiber aus U3;
  - Erholung schliesst ohne weiteren Versandauftrag; "unknown" nicht;
  - lesender Repository-Port fuer CX-029.
- apps/api/src/modules/technicalAlarms/technicalAlarms.test.ts
  - vier colocated Vitest-Datenbanktests gegen PostgreSQL 17;
  - Testdatenbank und Migration-Client werden in finally geschlossen.

## Tests (echte Ausgabe)

CX-028-Tests (temporaerer, nicht eingecheckter Vitest-Include, weil die
bestehende Vitest-Konfiguration nur tests/** erfasst):

    src/modules/technicalAlarms/technicalAlarms.test.ts (4 tests)  pass
    Test Files  1 passed (1)
         Tests  4 passed (4)
    EXIT:0

Wurzel-Typecheck:

    npm run -s typecheck
    EXIT:0

Wurzel-Tests unter with-postgres (PostgreSQL 17):

    @gt-ads/api:       Test Files 43 passed (43), Tests 545 passed (545)
    @gt-ads/dashboard: Test Files  4 passed (4),  Tests  28 passed (28)
    EXIT:0

Es wurden keine Tests geloescht, uebersprungen oder abgeschwaecht. Die
Ausgabe enthaelt nur bestehende Fastify-Hinweise FSTDEP023.

## Annahmen / Hinweise

- [Fakt] Nur outcome = technical_fault mit validiertem Fehlercode und
  belegtem Beginn ist alarmfaehig.
- [Fakt] "unknown" beendet keine Episode; als belegte nichttechnische
  Erholung wird das CX-010-Ergebnis "healthy" behandelt.
- [Annahme] Die Mindestdauer wird vom Aufrufer explizit konfiguriert; der
  Test verwendet 300 Sekunden. Es gibt keinen versteckten Default.
