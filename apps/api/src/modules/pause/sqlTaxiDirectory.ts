/**
 * CX-052 / R-501: duenne SQL-Anbindung der vorhandenen CX-035-Zuordnung.
 *
 * Gelesen werden ausschliesslich die bestehenden Strukturen "taxis" und
 * "device_taxi_assignments". Es gibt keine zweite Zuordnungstabelle, keine
 * Kopie des CX-012-Pausenkerns und keine Schreiboperation.
 */
import type { Pool } from "pg";
import { ensureTaxiActivationSchema } from "../taxiActivation/index.js";
import type {
  TaxiDeviceAssignment,
  TaxiDirectory,
} from "../remoteControl/index.js";

export interface SqlTaxiDirectory extends TaxiDirectory {
  /** Wahr, wenn das Taxi in der vorhandenen Taxi-Stammtabelle existiert. */
  taxiExists(taxiId: string): Promise<boolean>;
}

interface AssignmentRow {
  device_id: string;
  taxi_id: string;
  active: boolean;
}

export function createSqlTaxiDirectory(pool: Pool): SqlTaxiDirectory {
  // CX-124 stellt die vorausgesetzten CX-Strukturen idempotent bereit; dieser
  // Adapter nutzt dieselbe vorhandene Struktur und legt nichts Neues an.
  const schemaReady = (): Promise<void> => ensureTaxiActivationSchema(pool);

  return {
    async taxiExists(taxiId: string): Promise<boolean> {
      await schemaReady();
      const result = await pool.query<{ id: string }>(
        "select id from taxis where id = $1",
        [taxiId],
      );
      return result.rows.length > 0;
    },

    async listActiveDeviceIds(taxiId: string): Promise<readonly string[]> {
      await schemaReady();
      const result = await pool.query<{ device_id: string }>(
        [
          "select device_id::text as device_id",
          "  from device_taxi_assignments",
          " where taxi_id = $1",
          "   and active = true",
          " order by device_id asc",
        ].join("\n"),
        [taxiId],
      );
      return result.rows.map((row) => row.device_id);
    },

    async findDeviceAssignment(
      deviceId: string,
    ): Promise<TaxiDeviceAssignment | null> {
      await schemaReady();
      const result = await pool.query<AssignmentRow>(
        [
          "select device_id::text as device_id, taxi_id, active",
          "  from device_taxi_assignments",
          " where device_id = $1",
          " order by taxi_id asc",
        ].join("\n"),
        [deviceId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        deviceId: row.device_id,
        taxiId: row.taxi_id,
        active: row.active,
      };
    },
  };
}
