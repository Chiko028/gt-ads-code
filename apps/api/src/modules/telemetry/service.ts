import {
  TelemetryConflictError,
  TelemetryStorageError,
} from "./errors.js";
import type {
  IngestObservationsResult,
  NormalizedObservation,
  TelemetryIngestOptions,
  TelemetrySqlClient,
  TelemetrySqlPool,
} from "./types.js";
import {
  collapseDuplicateObservations,
  normalizeDeviceId,
  normalizeObservationBatch,
} from "./validation.js";

const INSERT_SQL = [
  "insert into telemetry_observations",
  "  (device_id, event_id, occurred_at, vehicle_ready, paused,",
  "   playback, technical_fault, received_at)",
  "values ($1, $2, $3::timestamptz, $4, $5, $6, $7, $8::timestamptz)",
  "on conflict (device_id, event_id) do nothing",
  "returning event_id::text as event_id",
].join("\n");

const SELECT_EXISTING_SQL = [
  "select event_id::text as event_id,",
  "       occurred_at,",
  "       vehicle_ready,",
  "       paused,",
  "       playback,",
  "       technical_fault",
  "  from telemetry_observations",
  " where device_id = $1",
  "   and event_id = any($2::uuid[])",
].join("\n");

interface StoredObservationRow extends Record<string, unknown> {
  event_id: string;
  occurred_at: Date | string;
  vehicle_ready: boolean | null;
  paused: boolean | null;
  playback: string;
  technical_fault: boolean | null;
}

function isConnectable(
  client: TelemetrySqlClient | TelemetrySqlPool,
): client is TelemetrySqlPool {
  return typeof (client as TelemetrySqlPool).connect === "function";
}

function storedTimeMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function sameContent(
  observation: NormalizedObservation,
  row: StoredObservationRow,
): boolean {
  return (
    storedTimeMs(row.occurred_at) === Date.parse(observation.occurredAt) &&
    row.vehicle_ready === observation.vehicleReady &&
    row.paused === observation.paused &&
    row.playback === observation.playback &&
    row.technical_fault === observation.technicalFault
  );
}

/**
 * Interner, idempotenter Speicherkern fuer Telemetrie-Beobachtungen.
 *
 * Ein Batch wird vollstaendig validiert, innerhalb genau einer Transaktion
 * geschrieben und erst nach erfolgreichem Commit bestaetigt. Identische
 * Wiederholungen sind erfolgreich; abweichende Wiederverwendungen derselben
 * (device_id, event_id) sind ein typisierter Konflikt und rollen den gesamten
 * Batch zurueck.
 */
export class TelemetryIngestService {
  private readonly client: TelemetrySqlClient | TelemetrySqlPool;
  private readonly now: () => Date;

  constructor(options: TelemetryIngestOptions) {
    this.client = options.client;
    this.now = options.now ?? (() => new Date());
  }

  async ingestObservations(
    deviceId: string,
    events: unknown,
  ): Promise<IngestObservationsResult> {
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    const batch = normalizeObservationBatch(events);
    const collapsed = collapseDuplicateObservations(batch);
    const receivedAt = this.now();

    if (!(receivedAt instanceof Date) || Number.isNaN(receivedAt.getTime())) {
      throw new TelemetryStorageError(
        "Die injizierte Serveruhr liefert keinen gueltigen Zeitpunkt.",
      );
    }

    // Sortierte Einfuege-Reihenfolge verhindert Deadlocks bei konkurrierenden
    // Batches mit ueberlappenden Ereignissen.
    const ordered = [...collapsed.observations].sort((left, right) =>
      left.eventId.localeCompare(right.eventId),
    );

    let connection: TelemetrySqlClient;
    let release: () => void;
    try {
      if (isConnectable(this.client)) {
        const checkedOut = await this.client.connect();
        connection = checkedOut;
        release = () => checkedOut.release();
      } else {
        connection = this.client;
        release = () => undefined;
      }
    } catch (error) {
      throw new TelemetryStorageError(
        "PostgreSQL-Verbindung fuer Telemetrie fehlgeschlagen.",
        { cause: error },
      );
    }

    let inTransaction = false;
    try {
      await connection.query("begin");
      inTransaction = true;

      const insertedEventIds: string[] = [];
      const possiblyExisting: NormalizedObservation[] = [];

      for (const observation of ordered) {
        const result = await connection.query<{ event_id: string }>(INSERT_SQL, [
          normalizedDeviceId,
          observation.eventId,
          observation.occurredAt,
          observation.vehicleReady,
          observation.paused,
          observation.playback,
          observation.technicalFault,
          receivedAt.toISOString(),
        ]);

        if (result.rows.length === 0) {
          possiblyExisting.push(observation);
        } else {
          insertedEventIds.push(observation.eventId);
        }
      }

      if (possiblyExisting.length > 0) {
        const existing = await connection.query<StoredObservationRow>(
          SELECT_EXISTING_SQL,
          [normalizedDeviceId, possiblyExisting.map((event) => event.eventId)],
        );
        const byEventId = new Map<string, StoredObservationRow>();
        for (const row of existing.rows) {
          byEventId.set(row.event_id.toLowerCase(), row);
        }

        for (const observation of possiblyExisting) {
          const row = byEventId.get(observation.eventId);
          if (row === undefined) {
            throw new TelemetryStorageError(
              "Bereits konfliktfreies Ereignis ist nicht lesbar: " +
                observation.eventId,
            );
          }
          if (!sameContent(observation, row)) {
            throw new TelemetryConflictError(observation.eventId);
          }
        }
      }

      await connection.query("commit");
      inTransaction = false;

      const insertedSet = new Set(insertedEventIds);
      const acceptedEventIds = collapsed.observations.map(
        (observation) => observation.eventId,
      );
      return {
        acceptedEventIds,
        insertedEventIds: acceptedEventIds.filter((eventId) =>
          insertedSet.has(eventId),
        ),
        duplicateEventIds: acceptedEventIds.filter(
          (eventId) => !insertedSet.has(eventId),
        ),
      };
    } catch (error) {
      if (inTransaction) {
        try {
          await connection.query("rollback");
        } catch {
          // Der urspruengliche Fehler bleibt massgeblich; kein stilles Weiter.
        }
      }
      if (
        error instanceof TelemetryConflictError ||
        error instanceof TelemetryStorageError
      ) {
        throw error;
      }
      throw new TelemetryStorageError(
        "Telemetrie-Transaktion fehlgeschlagen; keine Bestaetigung.",
        { cause: error },
      );
    } finally {
      release();
    }
  }
}

/** Fabrik fuer den internen Service; erwartet einen vorhandenen pg-Client. */
export function createTelemetryIngestService(
  options: TelemetryIngestOptions,
): TelemetryIngestService {
  return new TelemetryIngestService(options);
}
