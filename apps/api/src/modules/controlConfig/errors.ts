/** CX-013: typisierte Fehler der versionierten Pausenkonfiguration. */

export class ControlConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Eingabe ist ungueltig; es wurde nichts geschrieben. */
export class ControlConfigValidationError extends ControlConfigError {}

/**
 * Dieselbe change_id wurde mit abweichendem kanonischem Inhalt verwendet.
 * Idempotenz wird vor der Revisionspruefung ausgewertet; nichts wird mutiert.
 */
export class ControlConfigChangeConflictError extends ControlConfigError {
  readonly changeId: string;

  constructor(changeId: string) {
    super(
      "change_id " +
        changeId +
        " ist bereits mit anderem Inhalt gespeichert.",
    );
    this.changeId = changeId;
  }
}

/** expected_revision passt nicht zur aktuellen Revision des Taxis. */
export class ControlConfigRevisionConflictError extends ControlConfigError {
  readonly expectedRevision: number;
  readonly currentRevision: number;

  constructor(expectedRevision: number, currentRevision: number) {
    super(
      "Revisionskonflikt: erwartet " +
        expectedRevision +
        ", aktuell " +
        currentRevision +
        ".",
    );
    this.expectedRevision = expectedRevision;
    this.currentRevision = currentRevision;
  }
}
