import { RollupStorageError } from "./errors.js";
import type { RollupSqlClient, SnapshotObservation } from "./types.js";

interface SnapshotRow extends Record<string, unknown> {
  event_id: string;
  occurred_at: Date | string;
  received_at: Date | string;
  vehicle_ready: boolean | null;
  paused: boolean | null;
  playback: string;
  technical_fault: boolean | null;
  is_prior: boolean;
}

/**
 * Eine einzige SQL-Anweisung = ein konsistenter PostgreSQL-Snapshot fuer den
 * Tagesverlauf und die letzte Beobachtung davor.
 */
const LOAD_SNAPSHOT_SQL = [
  "with day_rows as (",
  "  select event_id::text as event_id, occurred_at, received_at,",
  "         vehicle_ready, paused, playback, technical_fault, false as is_prior",
  "    from telemetry_observations",
  "   where device_id = $1",
  "     and occurred_at >= $2::timestamptz",
  "     and occurred_at < $3::timestamptz",
  "), prior_row as (",
  "  select event_id::text as event_id, occurred_at, received_at,",
  "         vehicle_ready, paused, playback, technical_fault, true as is_prior",
  "    from telemetry_observations",
  "   where device_id = $1",
  "     and occurred_at < $2::timestamptz",
  "   order by occurred_at desc, event_id desc",
  "   limit 1",
  ")",
  "select * from day_rows",
  "union all",
  "select * from prior_row",
  "order by occurred_at asc, event_id asc",
].join("\n");

export interface LoadedDaySnapshot {
  priorObservation: SnapshotObservation | null;
  observations: SnapshotObservation[];
}

function toIso(value: Date | string): string {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new RollupStorageError("Gespeicherter Zeitpunkt ist ungueltig.");
  }
  return new Date(ms).toISOString();
}

function toObservation(row: SnapshotRow): SnapshotObservation {
  if (
    row.playback !== "playing" &&
    row.playback !== "stopped" &&
    row.playback !== "unknown"
  ) {
    throw new RollupStorageError("Gespeicherter Wiedergabezustand ist ungueltig.");
  }
  return {
    eventId: row.event_id.toLowerCase(),
    occurredAt: toIso(row.occurred_at),
    receivedAt: toIso(row.received_at),
    vehicleReady: row.vehicle_ready,
    paused: row.paused,
    playback: row.playback,
    technicalFault: row.technical_fault,
    priorToDay: row.is_prior,
  };
}

export async function loadDaySnapshot(
  client: RollupSqlClient,
  deviceId: string,
  dayStartMs: number,
  dayEndMs: number,
): Promise<LoadedDaySnapshot> {
  const result = await client.query<SnapshotRow>(LOAD_SNAPSHOT_SQL, [
    deviceId,
    new Date(dayStartMs).toISOString(),
    new Date(dayEndMs).toISOString(),
  ]);

  const observations: SnapshotObservation[] = [];
  let priorObservation: SnapshotObservation | null = null;
  for (const row of result.rows) {
    const observation = toObservation(row);
    if (row.is_prior) {
      priorObservation = observation;
    } else {
      observations.push(observation);
    }
  }
  return { priorObservation, observations };
}
