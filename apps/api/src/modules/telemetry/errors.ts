/** Stabile, typisierte Fehlercodes des internen Telemetrie-Speicherkerns. */
export const TELEMETRY_ERROR_CODES = Object.freeze({
  invalid: "telemetry_invalid",
  conflict: "telemetry_conflict",
  storage: "telemetry_storage_failed",
} as const);

export type TelemetryErrorCode =
  (typeof TELEMETRY_ERROR_CODES)[keyof typeof TELEMETRY_ERROR_CODES];

/** Eingabe verletzt das interne Ereignisschema. */
export class TelemetryValidationError extends Error {
  readonly code = TELEMETRY_ERROR_CODES.invalid;
  readonly field: string | null;
  readonly eventIndex: number | null;

  constructor(message: string, field?: string, eventIndex?: number) {
    super(message);
    this.name = "TelemetryValidationError";
    this.field = field ?? null;
    this.eventIndex = eventIndex ?? null;
  }
}

/**
 * Dieselbe (device_id, event_id) wurde mit abweichendem fachlichem Inhalt
 * wiederverwendet. Der gesamte Batch wird zurueckgerollt.
 */
export class TelemetryConflictError extends Error {
  readonly code = TELEMETRY_ERROR_CODES.conflict;
  readonly eventId: string;

  constructor(eventId: string) {
    super("Ereignis " + eventId + " existiert bereits mit abweichendem Inhalt.");
    this.name = "TelemetryConflictError";
    this.eventId = eventId;
  }
}

/** Transaktion, Commit oder Datenbankzugriff ist fehlgeschlagen. */
export class TelemetryStorageError extends Error {
  readonly code = TELEMETRY_ERROR_CODES.storage;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TelemetryStorageError";
  }
}
