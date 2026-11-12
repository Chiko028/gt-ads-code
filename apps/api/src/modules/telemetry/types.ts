/**
 * CX-009 / GT-ADS-004: interner Speicherkern fuer Telemetrie-Beobachtungen.
 *
 * Diese Typen beschreiben ausschliesslich den internen Service. Es gibt
 * bewusst keinen HTTP-Vertrag und keinen Android-Ereignispuffer.
 */

/** Wiedergabezustand laut Zustandsmodell, reduziert auf den internen Kern. */
export type PlaybackState = "playing" | "stopped" | "unknown";

/**
 * Normalisierte Beobachtung. Die Geraete-ID ist absichtlich nicht Teil dieses
 * Typs: sie stammt aus dem authentifizierten Kontext und wird dem Service
 * separat uebergeben.
 */
export interface NormalizedObservation {
  /** UUID, kleingeschrieben. */
  eventId: string;
  /** Kanonisches UTC-ISO-Datum mit Millisekunden. */
  occurredAt: string;
  vehicleReady: boolean | null;
  paused: boolean | null;
  playback: PlaybackState;
  technicalFault: boolean | null;
}

export interface IngestObservationsResult {
  /** Eindeutige fachliche Ereignis-IDs; erst nach erfolgreichem Commit. */
  acceptedEventIds: string[];
  /** Davon in diesem Aufruf neu gespeichert. */
  insertedEventIds: string[];
  /** Davon bereits identisch vorhanden (Wiederholung). */
  duplicateEventIds: string[];
}

/** Minimale Ergebnisform, die pg.QueryResult erfuellt. */
export interface TelemetryQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  rows: Row[];
  rowCount: number | null;
}

/** Minimale SQL-Schnittstelle; pg.Pool und pg.PoolClient passen strukturell. */
export interface TelemetrySqlClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<TelemetryQueryResult<Row>>;
}

export interface TelemetrySqlConnection extends TelemetrySqlClient {
  release: (error?: Error | boolean) => void;
}

export interface TelemetrySqlPool {
  connect(): Promise<TelemetrySqlConnection>;
}

export interface TelemetryIngestOptions {
  /** Vorhandener PostgreSQL-Client (Pool oder bereits ausgecheckte Verbindung). */
  client: TelemetrySqlClient | TelemetrySqlPool;
  /** Injizierbare Serveruhr; Standard ist die Systemzeit. */
  now?: () => Date;
}
