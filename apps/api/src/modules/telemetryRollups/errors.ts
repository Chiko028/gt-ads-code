/** CX-011: typisierte Fehler der korrigierbaren Tages-Rollups. */

export class TelemetryRollupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Eingabe oder Regel der Rollup-/Retention-Auswertung ist ungueltig. */
export class RollupInputError extends TelemetryRollupError {}

/**
 * Derselbe Policy-Version-Schluessel traegt unterschiedlichen Policy-Inhalt.
 * Das ist ein Konfigurationsfehler, kein stiller Vorrang einer Variante.
 */
export class RollupPolicyConflictError extends TelemetryRollupError {
  readonly policyVersion: string;

  constructor(policyVersion: string) {
    super(
      "Policy-Version " +
        policyVersion +
        " ist bereits mit anderem kanonischem Inhalt gespeichert.",
    );
    this.policyVersion = policyVersion;
  }
}

/** Datenbank- oder Transaktionsfehler; kein Teilwrite wird bestaetigt. */
export class RollupStorageError extends TelemetryRollupError {}
