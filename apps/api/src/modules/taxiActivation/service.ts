/**
 * CX-124 / R-104: atomarer administrativer Taxi-Aktivzustand.
 *
 * Sperrreihenfolge: Taxi, dann Zuordnungen, dann Geraete. Revision,
 * Aktivzustand und Audit entstehen auf demselben Transaktionsclient.
 * Aktivierung verlangt genau zwei unterschiedliche, exklusiv zugeordnete,
 * administrativ aktive und nicht widerrufene Tablets; Deaktivierung erhaelt
 * alle Zuordnungen.
 *
 * Die bestehenden CX-Strukturen (taxis, device_taxi_assignments, devices)
 * werden vorausgesetzt und hier nicht angelegt. Fehlen Tabellen oder
 * benoetigte Spalten, blockiert der Aufruf mit einer konkreten Meldung;
 * eine Ersatzstruktur entsteht nicht.
 */
import type { Pool, PoolClient } from "pg";
import { AuditService } from "../audit/service.js";

export { ensureTaxiActivationSchema } from "./schemaBootstrap.js";

export const TAXI_ACTIVATION_AUDIT_ACTION = "taxi.activation.changed";
export const TAXI_ACTIVATION_AUDIT_TARGET_TYPE = "taxi";
export const MAX_TAXI_ID_LENGTH = 128;
export const ACTIVE_TABLET_PAIR_SIZE = 2;

export interface SetTaxiActiveStateInput {
  taxiId: string;
  expectedRevision: number;
  active: boolean;
  actorId: string;
}
export interface TaxiActiveStateResult {
  taxiId: string;
  active: boolean;
  revision: number;
  changed: boolean;
}
export type TaxiActivationServiceOptions = { pool: Pool; now?: () => Date };
export type TaxiActivationErrorCode =
  | "invalid_request"
  | "not_found"
  | "revision_conflict"
  | "invalid_pair"
  | "missing_schema";

export class TaxiActivationError extends Error {
  readonly code: TaxiActivationErrorCode;
  constructor(code: TaxiActivationErrorCode, message: string) {
    super(message);
    this.name = "TaxiActivationError";
    this.code = code;
  }
}

type TaxiRow = { id: string; active: boolean; revision: string };
type AssignmentRow = { device_id: string; taxi_id: string; active: boolean };
type DeviceRow = { id: string; state: "active" | "revoked" };
type RequiredStructure = { table: string; columns: readonly string[] };

const REQUIRED_STRUCTURE: readonly RequiredStructure[] = [
  { table: "taxis", columns: ["id", "active", "revision"] },
  {
    table: "device_taxi_assignments",
    columns: ["device_id", "taxi_id", "active"],
  },
  { table: "devices", columns: ["id", "state"] },
];

function fail(code: TaxiActivationErrorCode, message: string): never {
  throw new TaxiActivationError(code, message);
}

/**
 * Prueft die Felder einer vorausgesetzten CX-Tabelle, ohne Strukturen
 * anzulegen. Fehlt etwas, ist die Umsetzung blockiert; die Meldung nennt
 * die fehlenden Felder.
 */
async function assertStructure(
  executor: Pool | PoolClient,
  table: string,
): Promise<void> {
  const required = REQUIRED_STRUCTURE.find((entry) => entry.table === table);
  if (required === undefined) {
    throw new Error("Unbekannte CX-Struktur: " + table);
  }
  const rows = (
    await executor.query<{ column_name: string }>(
      `select column_name
         from information_schema.columns
        where table_schema = current_schema()
          and table_name = $1`,
      [table],
    )
  ).rows;
  const available = new Set(rows.map((row) => row.column_name));
  const missing = required.columns
    .filter((column) => !available.has(column))
    .map((column) => table + "." + column);
  if (missing.length > 0) {
    fail(
      "missing_schema",
      "Die bestehende CX-Struktur ist unvollstaendig; es fehlen: " +
        missing.join(", ") +
        ". Der Taxi-Aktivzustand ist blockiert, bis die Migration die " +
        "Felder bereitstellt.",
    );
  }
}

function normalizeTaxiId(value: unknown): string {
  if (typeof value !== "string") fail("invalid_request", "Die Taxi-ID muss ein Text sein.");
  const id = value.trim();
  if (id.length < 1 || id.length > MAX_TAXI_ID_LENGTH) {
    fail("invalid_request", "Die Taxi-ID muss 1 bis 128 Zeichen enthalten.");
  }
  return id;
}
function normalizeRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail("invalid_request", "Die erwartete Revision muss eine ganze Zahl ab 0 sein.");
  }
  return value;
}
function normalizeActor(value: unknown): string {
  if (typeof value !== "string") fail("invalid_request", "Der Akteur muss ein Text sein.");
  const actor = value.trim();
  if (actor.length < 1 || Array.from(actor).length > 128) {
    fail("invalid_request", "Der Akteur muss 1 bis 128 Zeichen enthalten.");
  }
  return actor;
}
function readRevision(value: string): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Gespeicherte Taxi-Revision ist ungueltig.");
  }
  return revision;
}
function conflict(): never {
  return fail("revision_conflict", "Die erwartete Revision ist nicht mehr aktuell.");
}

export class TaxiActivationService {
  private readonly pool: Pool;
  private readonly now: () => Date;
  private readonly audit: AuditService;

  constructor(options: TaxiActivationServiceOptions) {
    this.pool = options.pool;
    this.now = options.now ?? (() => new Date());
    this.audit = new AuditService({ executor: options.pool });
  }

  async setActiveState(
    input: SetTaxiActiveStateInput,
  ): Promise<TaxiActiveStateResult> {
    const taxiId = normalizeTaxiId(input?.taxiId);
    const expectedRevision = normalizeRevision(input?.expectedRevision);
    const desiredActive = input?.active;
    if (typeof desiredActive !== "boolean") {
      fail("invalid_request", "Der Sollzustand muss ein boolescher Wert sein.");
    }
    const actorId = normalizeActor(input?.actorId);
    const at = this.now();
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
      throw new Error("Die Serveruhr liefert keinen gueltigen Zeitpunkt.");
    }

    await assertStructure(this.pool, "taxis");
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const taxi = (
        await client.query<TaxiRow>(
          `select id, active, revision::text as revision
             from taxis where id = $1 for update`,
          [taxiId],
        )
      ).rows[0];
      if (taxi === undefined) fail("not_found", "Das Taxi existiert nicht.");
      const currentRevision = readRevision(taxi.revision);
      if (currentRevision !== expectedRevision) conflict();

      // Ein unveraenderter Sollzustand ist nach der Revisionspruefung ein
      // No-op und verlangt weder Zuordnungen noch Aktivierungsvoraussetzungen.
      if (taxi.active === desiredActive) {
        await client.query("commit");
        return { taxiId, active: desiredActive, revision: currentRevision, changed: false };
      }

      await assertStructure(client, "device_taxi_assignments");
      await assertStructure(client, "devices");
      const assignments = await this.lockAssignments(client, taxiId);
      const devices = await this.lockDevices(
        client,
        [...new Set(assignments.map((row) => row.device_id))],
      );
      if (desiredActive) this.assertActivePair(taxiId, assignments, devices);

      const updated = (
        await client.query<{ active: boolean; revision: string }>(
          `update taxis set active = $2, revision = revision + 1
             where id = $1 and revision = $3
           returning active, revision::text as revision`,
          [taxiId, desiredActive, expectedRevision],
        )
      ).rows[0];
      if (updated === undefined) conflict();
      const revision = readRevision(updated.revision);
      await this.audit.recordWith(
        client,
        {
          actorType: "admin",
          actorId,
          action: TAXI_ACTIVATION_AUDIT_ACTION,
          targetType: TAXI_ACTIVATION_AUDIT_TARGET_TYPE,
          targetId: taxiId,
          details: { previous_active: taxi.active, active: updated.active, revision },
        },
        at,
      );
      await client.query("commit");
      return { taxiId, active: updated.active, revision, changed: true };
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // Der urspruengliche Fehler bleibt massgeblich.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockAssignments(
    client: PoolClient,
    taxiId: string,
  ): Promise<AssignmentRow[]> {
    const rows = (
      await client.query<AssignmentRow>(
        `select device_id::text as device_id, taxi_id, active
           from device_taxi_assignments where taxi_id = $1
          order by device_id asc for update`,
        [taxiId],
      )
    ).rows;
    if (rows.length === 0) return rows;
    const deviceIds = [...new Set(rows.map((row) => row.device_id))];
    return (
      await client.query<AssignmentRow>(
        `select device_id::text as device_id, taxi_id, active
           from device_taxi_assignments where device_id = any($1::uuid[])
          order by device_id asc, taxi_id asc for update`,
        [deviceIds],
      )
    ).rows;
  }

  private async lockDevices(
    client: PoolClient,
    deviceIds: readonly string[],
  ): Promise<DeviceRow[]> {
    if (deviceIds.length === 0) return [];
    return (
      await client.query<DeviceRow>(
        `select id::text as id, state from devices
          where id = any($1::uuid[]) order by id asc for update`,
        [deviceIds],
      )
    ).rows;
  }

  private assertActivePair(
    taxiId: string,
    assignments: readonly AssignmentRow[],
    devices: readonly DeviceRow[],
  ): void {
    const distinct = new Set(assignments.map((row) => row.device_id));
    if (assignments.length !== ACTIVE_TABLET_PAIR_SIZE ||
        distinct.size !== ACTIVE_TABLET_PAIR_SIZE) {
      fail("invalid_pair", "Eine Aktivierung verlangt genau zwei unterschiedliche Tablets.");
    }
    if (assignments.some((row) => row.taxi_id !== taxiId || !row.active) ||
        devices.length !== ACTIVE_TABLET_PAIR_SIZE ||
        devices.some((device) => device.state !== "active")) {
      fail("invalid_pair", "Beide Tablets muessen exklusiv, aktiv und nicht widerrufen sein.");
    }
  }
}
