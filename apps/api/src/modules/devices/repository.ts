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
