# CX-029 – Sitzungsprotokoll (Coding-Agent)

Datum: 2026-11-13
Arbeitspaket: CX-029 v1 – R-003 / CX-020-Ersatz B: austauschbarer Telegram-Adapter
Branch: agent/CX-029
Status: Implementierung und Tests abgeschlossen, keine offenen Blocker

## Umsetzung

- apps/api/src/modules/technicalAlarms/telegramSender.ts
  - austauschbarer AlarmSender-Port ohne Netzwerkcode;
  - TelegramSender bildet sendMessage auf einen verpflichtend injizierten
    Transport-Port ab; kein fetch, kein HTTP-Client, kein SDK als Default;
  - Token und Ziel-ID werden getrennt vom protokollierbaren Text uebergeben;
  - Nachricht enthaelt nur Alarm-ID, pseudonyme Ressourcenkennung, validierten
    Fehlercode und UTC-Zeit; kein parse_mode, keine Rohdaten;
  - ohne Transport oder Zielkonfiguration: sichtbarer Blocker, kein Erfolg;
  - Erfolg nur bei HTTP 2xx und Telegram ok=true; 429 mit Retry-After bzw.
    parameters.retry_after; andere 4xx endgueltig; 5xx/Timeout wiederholbar.
- apps/api/src/modules/technicalAlarms/dispatch.ts
  - dispatchPending mit injizierter Uhr, konfigurierbarem Batchlimit und
    austauschbarem Sender;
  - atomarer Claim faelliger Auftraege mit befristeter Lease und Claim-ID
    (SKIP LOCKED); Adapteraufruf ausserhalb der Datenbanktransaktion;
  - Ergebnis und Audit-Ereignis atomar und nur bei weiterhin gueltiger
    Claim-ID; abgelaufene Claims werden erneut aufgenommen;
  - Timeout und Abbruchsignal begrenzen den Adapteraufruf;
  - exponentieller Backoff ab 30 s bis 3600 s; nach fuenf erfolglosen
    Versuchen Endstatus failed;
  - blockierte Auftraege bleiben pending, behalten next_attempt_at und
    protokollieren den Grund in last_error_code und Audit;
  - keine Exactly-once-Zustellung, kein Timer, keine oeffentliche API.
- apps/api/src/modules/technicalAlarms/index.ts: neue Exporte.
- apps/api/src/modules/technicalAlarms/dispatch.test.ts: vier colocated
  Vitest-Datenbanktests gegen PostgreSQL 17 mit deterministischen
  Transport-Doubles; Testdatenbank und Migrationsclient werden geschlossen.

## Tests (echte Ausgabe)

CX-029-Tests (temporaerer, nicht eingecheckter Vitest-Include, weil die
bestehende Vitest-Konfiguration nur tests/** erfasst):

    src/modules/technicalAlarms/dispatch.test.ts (4 tests)  pass
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

- [Fakt] Die Outbox und die Audit-Anbindung aus CX-028/U3 werden unveraendert
  genutzt; es gibt keine Migration und keine Aenderung fremder Module.
- [Fakt] Eine Nachricht enthaelt nur die vier freigegebenen Felder; die
  Ressourcenkennung ist die pseudonyme Ressourcen-ID aus CX-028.
- [Annahme] Blockierte Auftraege zaehlen nicht als Versandversuch und bleiben
  sofort erneut bearbeitbar, sobald Transport/Zielkonfiguration vorhanden sind.
- [Annahme] Der Nachrichtenzeitpunkt ist fault_started_at der Episode.
- [Hinweis] Der Dienst behauptet keine Exactly-once-Zustellung; abgelaufene
  Claims koennen erneut verarbeitet werden.
