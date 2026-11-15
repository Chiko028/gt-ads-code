/**
 * CX-126 / R-104 Teil 17: atomarer Verwaltungs-Aktivzustand eines Tablets.
 * Identitaetszustand (devices.state) bleibt unberuehrt; der getrennte
 * Verwaltungszustand liegt in tablet_admin_states (fehlender Satz: aktiv,
 * Revision 0). Sperrreihenfolge wie CX-124: Taxi, Zuordnungen, Geraet.
 * Deaktivierung deaktiviert Taxi und Tablet-Zuordnung mit; Reaktivierung
 * laesst Taxi und Zuordnung unveraendert.
 */
import type { Pool, PoolClient } from "pg";
import { AuditService } from "../audit/service.js";
import { ensureTaxiActivationSchema } from "../taxiActivation/service.js";

export const TABLET_ACTIVATION_AUDIT_ACTION = "tablet.activation.changed";
export const TABLET_ACTIVATION_AUDIT_TARGET_TYPE = "tablet";
export const MAX_ACTOR_ID_LENGTH = 128;

export interface SetTabletActiveStateInput {
  deviceId: string; expectedRevision: number; active: boolean; actorId: string;
}
/** Nur ein tatsaechlich geaendertes Taxi; sonst null. */
export interface TabletTaxiState {
  taxiId: string; active: boolean; revision: number; changed: boolean;
}
export interface TabletActiveStateResult {
  deviceId: string; active: boolean; revision: number;
  changed: boolean; taxi: TabletTaxiState | null;
}
export type TabletActivationServiceOptions = { pool: Pool; now?: () => Date };
export type TabletActivationErrorCode =
  | "invalid_request"
  | "not_found"
  | "revision_conflict"
  | "revoked_identity"
  | "invalid_assignment";

export class TabletActivationError extends Error {
  readonly code: TabletActivationErrorCode;
  constructor(code: TabletActivationErrorCode, message: string) {
    super(message);
    this.name = "TabletActivationError";
    this.code = code;
  }
}

type TabletStateRow = { active: boolean; revision: string };
type AssignmentRow = { taxi_id: string; active: boolean };
type TaxiRow = { active: boolean; revision: string };

const SCHEMA_SQL = "create table if not exists tablet_admin_states (" +
  "device_id uuid primary key references devices(id) on delete cascade," +
  "active boolean not null default true," +
  "revision bigint not null default 1 check (revision >= 1));";
const schemaReady = new WeakMap<Pool, Promise<void>>();

/** Legt die additive Verwaltungszustandstabelle genau einmal je Pool an. */
export function ensureTabletActivationSchema(pool: Pool): Promise<void> {
  const pending = schemaReady.get(pool);
  if (pending !== undefined) return pending;
  const created = pool.query(SCHEMA_SQL).then(() => undefined);
  schemaReady.set(pool, created);
  created.catch(() => {
    if (schemaReady.get(pool) === created) schemaReady.delete(pool);
  });
  return created;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(code: TabletActivationErrorCode, message: string): never {
  throw new TabletActivationError(code, message);
}
function normalizeDeviceId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    fail("invalid_request", "Die Tablet-ID muss eine UUID sein.");
  }
  return value.trim().toLowerCase();
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
  if (actor.length < 1 || Array.from(actor).length > MAX_ACTOR_ID_LENGTH) {
    fail("invalid_request", "Der Akteur muss 1 bis 128 Zeichen enthalten.");
  }
  return actor;
}
function readRevision(value: string): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Gespeicherte Tablet-Revision ist ungueltig.");
  }
  return revision;
}
function conflict(): never {
  return fail("revision_conflict", "Die erwartete Revision ist nicht mehr aktuell.");
}
function invalidAssignment(message: string): never {
  return fail("invalid_assignment", message);
}

export class TabletActivationService {
  private readonly pool: Pool;
  private readonly now: () => Date;
  private readonly audit: AuditService;

  constructor(options: TabletActivationServiceOptions) {
    this.pool = options.pool;
    this.now = options.now ?? (() => new Date());
    this.audit = new AuditService({ executor: options.pool });
  }

  async setActiveState(
    input: SetTabletActiveStateInput,
  ): Promise<TabletActiveStateResult> {
    const deviceId = normalizeDeviceId(input?.deviceId);
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

    await ensureTabletActivationSchema(this.pool);
    await ensureTaxiActivationSchema(this.pool);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const initial = await this.readAssignments(client, deviceId);
      const taxiId = initial.find((row) => row.active)?.taxi_id ?? null;
      let taxi: TaxiRow | undefined;
      if (taxiId !== null) {
        taxi = (await client.query<TaxiRow>(
          "select active, revision::text as revision from taxis where id = $1 for update",
          [taxiId],
        )).rows[0];
        if (taxi === undefined) invalidAssignment("Die aktive Zuordnung verweist auf kein Taxi.");
      }
      await this.lockAssignments(client, taxiId, deviceId);

      const device = (await client.query<{ state: "active" | "revoked" }>(
        "select state from devices where id = $1::uuid for update",
        [deviceId],
      )).rows[0];
      if (device === undefined) fail("not_found", "Das Tablet existiert nicht.");

      // Der Verwaltungszustand wird unter denselben Sperren gelesen; die
      // Revision entscheidet vor jeder fachlichen Vorbedingung. Auch eine
      // widerrufene Identitaet mit veralteter Revision bleibt ein Konflikt.
      const state = (await client.query<TabletStateRow>(
        "select active, revision::text as revision from tablet_admin_states" +
          " where device_id = $1::uuid for update",
        [deviceId],
      )).rows[0];
      const previousActive = state?.active ?? true;
      const currentRevision = state === undefined ? 0 : readRevision(state.revision);
      if (currentRevision !== expectedRevision) conflict();

      if (desiredActive && device.state === "revoked") {
        fail("revoked_identity", "Eine widerrufene Geraeteidentitaet ist nicht reaktivierbar.");
      }

      // Nach der Geraetesperre ist die Zuordnungsmenge stabil; konkurrierende
      // Einfuegungen warten auf den Fremdschluessel-Check der Geraetezeile.
      const activeAssignment = this.assertSingleActive(
        await this.readAssignments(client, deviceId),
        taxiId,
      );

      const tabletChanged = previousActive !== desiredActive;
      const taxiChanged = !desiredActive && taxi !== undefined && taxi.active;
      const assignmentChanged = !desiredActive && activeAssignment?.active === true;
      if (!tabletChanged && !taxiChanged && !assignmentChanged) {
        await client.query("commit");
        return { deviceId, active: previousActive, revision: currentRevision, changed: false, taxi: null };
      }

      let revision = currentRevision;
      if (tabletChanged) {
        const result = state === undefined
          ? await client.query<TabletStateRow>(
              "insert into tablet_admin_states (device_id, active, revision)" +
                " values ($1::uuid, $2, 1) returning active, revision::text as revision",
              [deviceId, desiredActive],
            )
          : await client.query<TabletStateRow>(
              "update tablet_admin_states set active = $2, revision = revision + 1" +
                " where device_id = $1::uuid and revision = $3" +
                " returning active, revision::text as revision",
              [deviceId, desiredActive, expectedRevision],
            );
        const row = result.rows[0];
        if (row === undefined) conflict();
        revision = readRevision(row.revision);
      }

      if (assignmentChanged) {
        await client.query(
          "update device_taxi_assignments set active = false, updated_at = $3" +
            " where device_id = $1::uuid and taxi_id = $2 and active = true",
          [deviceId, taxiId, at],
        );
      }
      let taxiResult: TabletTaxiState | null = null;
      if (taxiChanged) {
        const updated = await client.query<{ active: boolean; revision: string }>(
          "update taxis set active = false, revision = revision + 1" +
            " where id = $1 and revision = $2 returning active, revision::text as revision",
          [taxiId, taxi!.revision],
        );
        const row = updated.rows[0];
        if (row === undefined) conflict();
        taxiResult = {
          taxiId: taxiId!, active: row.active,
          revision: readRevision(row.revision), changed: true,
        };
      }

      const details: Record<string, unknown> = {
        previous_active: previousActive, active: desiredActive, revision,
      };
      if (taxiChanged) {
        Object.assign(details, {
          taxi_id: taxiId, taxi_previous_active: taxi!.active,
          taxi_active: taxiResult!.active, taxi_revision: taxiResult!.revision,
        });
      }
      if (assignmentChanged) details.assignment_active = false;
      await this.audit.recordWith(client, {
        actorType: "admin", actorId,
        action: TABLET_ACTIVATION_AUDIT_ACTION,
        targetType: TABLET_ACTIVATION_AUDIT_TARGET_TYPE,
        targetId: deviceId, details,
      }, at);
      await client.query("commit");
      return { deviceId, active: desiredActive, revision, changed: true, taxi: taxiResult };
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

  private async readAssignments(
    client: PoolClient, deviceId: string,
  ): Promise<AssignmentRow[]> {
    const result = await client.query<AssignmentRow>(
      "select taxi_id, active from device_taxi_assignments" +
        " where device_id = $1::uuid order by taxi_id asc",
      [deviceId],
    );
    return result.rows;
  }

  private assertSingleActive(
    rows: readonly AssignmentRow[], taxiId: string | null,
  ): AssignmentRow | null {
    const active = rows.filter((row) => row.active);
    if (active.length > 1) {
      invalidAssignment("Ein Tablet darf nicht mehreren Taxis aktiv zugeordnet sein.");
    }
    if (taxiId === null) {
      if (active.length > 0) {
        invalidAssignment("Die Zuordnung hat sich waehrend der Aenderung veraendert.");
      }
      return null;
    }
    if (active.length !== 1 || active[0]?.taxi_id !== taxiId) {
      invalidAssignment("Die Zuordnung hat sich waehrend der Aenderung veraendert.");
    }
    return active[0]!;
  }

  /** Sperrt in CX-124-Reihenfolge: erst Taxi-Zuordnungen, dann Geraetezeilen. */
  private async lockAssignments(
    client: PoolClient, taxiId: string | null, deviceId: string,
  ): Promise<void> {
    if (taxiId !== null) {
      await client.query(
        "select 1 from device_taxi_assignments where taxi_id = $1" +
          " order by device_id asc for update",
        [taxiId],
      );
    }
    await client.query(
      "select 1 from device_taxi_assignments where device_id = $1::uuid" +
        " order by taxi_id asc for update",
      [deviceId],
    );
  }
}
