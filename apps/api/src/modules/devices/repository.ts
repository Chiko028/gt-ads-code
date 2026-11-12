import type { SqlQueryable } from "../audit/repository.js";

/** Zeile der Geraeteliste; enthaelt bewusst keinen oeffentlichen Schluessel. */
export interface DeviceListRow {
  id: string;
  label: string | null;
  manufacturer: string;
  model: string;
  os_version: string;
  sdk_int: number;
  app_version: string;
  app_flavor: string;
  state: "active" | "revoked";
  registered_at: Date;
  last_seen_at: Date;
}

/** Detailzeile laut API-VERTRAG.md Abschnitt 5 (Liste + Zusatzfelder). */
export interface DeviceDetailRow extends DeviceListRow {
  /** bigint aus PostgreSQL; null, solange kein Heartbeat vorliegt. */
  last_clock_offset_ms: string | null;
  registration_code_id: string;
}

/** Zustand eines Geraets fuer die Sperre. */
export interface DeviceStateSnapshot {
  id: string;
  state: "active" | "revoked";
}

/** Obergrenze der Geraeteliste laut API-VERTRAG.md Abschnitt 5. */
export const DEVICE_LIST_LIMIT = 500;

const DEVICE_LIST_COLUMNS = [
  "id::text as id",
  "label",
  "manufacturer",
  "model",
  "os_version",
  "sdk_int",
  "app_version",
  "app_flavor",
  "state",
  "registered_at",
  "last_seen_at",
].join(", ");

const DEVICE_DETAIL_COLUMNS =
  DEVICE_LIST_COLUMNS +
  ", last_clock_offset_ms::text as last_clock_offset_ms" +
  ", registration_code_id::text as registration_code_id";

/**
 * Liest die Geraeteliste sortiert nach `last_seen_at` absteigend. Es wird
 * eine Zeile mehr gelesen als erlaubt, damit der Aufrufer eine Kuerzung
 * erkennen und `truncated: true` melden kann.
 */
export async function listDeviceRows(
  executor: SqlQueryable,
  limit: number = DEVICE_LIST_LIMIT,
): Promise<{ rows: DeviceListRow[]; truncated: boolean }> {
  const result = await executor.query<DeviceListRow>(
    [
      "select " + DEVICE_LIST_COLUMNS,
      "  from devices",
      " order by last_seen_at desc, id asc",
      " limit $1",
    ].join("\n"),
    [limit + 1],
  );
  const truncated = result.rows.length > limit;
  return {
    rows: truncated ? result.rows.slice(0, limit) : result.rows,
    truncated,
  };
}

/** Detailansicht eines Geraets; null, wenn es nicht existiert. */
export async function findDeviceDetailRow(
  executor: SqlQueryable,
  deviceId: string,
): Promise<DeviceDetailRow | null> {
  const result = await executor.query<DeviceDetailRow>(
    "select " + DEVICE_DETAIL_COLUMNS + " from devices where id = $1",
    [deviceId],
  );
  return result.rows[0] ?? null;
}

/** Sperrt die Geraetezeile fuer die Dauer der Transaktion. */
export async function lockDeviceRow(
  executor: SqlQueryable,
  deviceId: string,
): Promise<DeviceStateSnapshot | null> {
  const result = await executor.query<DeviceStateSnapshot>(
    "select id::text as id, state from devices where id = $1 for update",
    [deviceId],
  );
  return result.rows[0] ?? null;
}

/**
 * Setzt die Sperre nur bei aktivem Geraet; false, wenn es schon gesperrt ist
 * (die Sperre bleibt idempotent, API-VERTRAG.md Abschnitt 5).
 */
export async function revokeDeviceRow(
  executor: SqlQueryable,
  deviceId: string,
  revokedAt: Date,
  revokedBy: string,
): Promise<boolean> {
  const result = await executor.query(
    [
      "update devices",
      "   set state = 'revoked', revoked_at = $2, revoked_by = $3",
      " where id = $1 and state = 'active'",
      " returning id",
    ].join("\n"),
    [deviceId, revokedAt, revokedBy],
  );
  return (result.rowCount ?? 0) === 1;
}
