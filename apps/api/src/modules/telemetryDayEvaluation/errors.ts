/**
 * CX-047 / R-402: typisierte Fehler des internen Tagesauswertungseinstiegs.
 *
 * Ein fehlgeschlagener Lauf liefert nie ein Ergebnisobjekt. Persistenzfehler
 * aus CX-011 werden unveraendert weitergereicht.
 */

export class TelemetryDayEvaluationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Aufrufargumente (Geraet, Tag, Uhr) sind ungueltig. */
export class DayEvaluationInputError extends TelemetryDayEvaluationError {}

/** Pflichtkonfiguration fehlt oder ist ungueltig; es wird nichts geschrieben. */
export class DayEvaluationConfigError extends TelemetryDayEvaluationError {}

/** Der angefragte Kalendertag ist zum Zeitpunkt der Uhr noch nicht beendet. */
export class DayNotCompletedError extends TelemetryDayEvaluationError {
  readonly localDate: string;
  readonly timeZone: string;
  readonly dayEnd: string;

  constructor(localDate: string, timeZone: string, dayEnd: string) {
    super(
      "Der lokale Tag " +
        localDate +
        " in " +
        timeZone +
        " ist erst ab " +
        dayEnd +
        " abgeschlossen.",
    );
    this.localDate = localDate;
    this.timeZone = timeZone;
    this.dayEnd = dayEnd;
  }
}
