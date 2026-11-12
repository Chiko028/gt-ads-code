/**
 * CX-010: typisierte Fehler der Tagesklassifikation.
 *
 * Konfigurationsfehler verhindern die Auswertung; Eingabefehler betreffen den
 * konkreten Aufruf. Beide sind fachlich von "Unbekannt" zu unterscheiden:
 * Unbekannt ist ein Ergebnis, kein Ausnahmefall.
 */

export class TelemetryEvaluationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Policy oder Konfiguration ist unvollstaendig bzw. ungueltig. */
export class EvaluationConfigError extends TelemetryEvaluationError {}

/** Eingabedaten des konkreten Auswertungsaufrufs sind ungueltig. */
export class EvaluationInputError extends TelemetryEvaluationError {}
