import type { SqlQueryable } from "../audit/repository.js";

export interface DeviceStateRow {
  id: string;
  state: "active" | "revoked";
}

export interface RecordHeartbeatInput {
  deviceId: string;
  /** Serverzeit (nicht Geraetezeit). */
  seenAt: Date;
  seq: number;
  /** server_time - device_time in Millisekunden. */
  clockOffsetMs: bigint;
  /** app_version/os_version duerfen nur der neueste seq setzen. */
  appVersion?: string;
  osVersion?: string;
}

export interface RecordHeartbeatResult {
  last_seq: string;
}

export async function findDeviceState(
  executor: SqlQueryable,
  deviceId: string,
): Promise<DeviceStateRow | null> {
  const result = await executor.query<DeviceStateRow>(
    "select id::text as id, state from devices where id = $1",
    [deviceId],
  );
  return result.rows[0] ?? null;
}

/**
 * Aktualisiert `last_seen_at` ausschliesslich auf die uebergebene Serverzeit
 * (AC-09) und schreibt den Clock-Offset. `last_seen_at` waechst nur
 * (`greatest`): Ein frueher gestarteter Heartbeat, dessen Update erst nach
 * einem spaeter gestarteten ausgefuehrt wird, darf den neueren
 * Kontaktzeitpunkt nicht zuruecksetzen. `last_seq` waechst ebenfalls nur
 * (`greatest`), damit ein kleineres oder gleiches `seq` nichts zurueckdreht
 * (API-VERTRAG.md Abschnitt 4, I-17).
 *
 * Die Bedingung `state = 'active'` macht die Sperre auch bei einem
 * gleichzeitigen Revoke wirksam (AC-08): dann wird keine Zeile geliefert.
 */
export async function recordHeartbeat(
  executor: SqlQueryable,
  input: RecordHeartbeatInput,
): Promise<RecordHeartbeatResult | null> {
  const result = await executor.query<RecordHeartbeatResult>(
    [
      "update devices",
      "   set last_seen_at = greatest(last_seen_at, $2),",
      "       last_seq = greatest(last_seq, $3::bigint),",
      "       last_clock_offset_ms = $4::bigint,",
      "       app_version = case when $5::text is not null and $3::bigint >= last_seq",
      "                          then $5 else app_version end,",
      "       os_version = case when $6::text is not null and $3::bigint >= last_seq",
      "                         then $6 else os_version end",
      " where id = $1",
      "   and state = 'active'",
      " returning last_seq::text as last_seq",
    ].join("\n"),
    [
      input.deviceId,
      input.seenAt,
      String(input.seq),
      input.clockOffsetMs.toString(),
      input.appVersion ?? null,
      input.osVersion ?? null,
    ],
  );
  return result.rows[0] ?? null;
}
