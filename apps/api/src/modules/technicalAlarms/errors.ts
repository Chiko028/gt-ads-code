/**
 * CX-028: typisierte Fehler der technischen Alarmepisoden.
 *
 * Eingabefehler betreffen einen konkreten Auswertungsaufruf. Speicherfehler
 * bedeuten, dass ein gespeicherter Zustand nicht eindeutig gelesen werden
 * kann; in beiden Faellen wird die Transaktion zurueckgerollt.
 */

export class TechnicalAlarmError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Der konkrete Auswertungsaufruf ist ungueltig. */
export class TechnicalAlarmInputError extends TechnicalAlarmError {}

/** Gespeicherter Zustand ist unerwartet oder inkonsistent. */
export class TechnicalAlarmStorageError extends TechnicalAlarmError {}
