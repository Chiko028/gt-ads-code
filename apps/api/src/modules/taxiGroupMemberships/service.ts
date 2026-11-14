/**
 * CX-118 / R-104: vollstaendige, betreibergebundene Ersetzung der
 * Gruppenmitgliedschaften genau eines Taxis.
 *
 * Die Funktion ist der einzige Schreibweg fuer die bestehende Relation
 * taxi_group_memberships auf Taxiebene. Sie sperrt zuerst das Taxi, prueft
 * Betreiber und erwarteten Aenderungsstand, sperrt danach alle gewaehlten
 * Gruppen in deterministischer Reihenfolge und ersetzt erst dann die
 * Mitgliedschaften. Taxi-Revision, Mitgliedschaften und Audit entstehen auf
 * demselben Transaktionsclient. Eine unveraenderte Menge ist ein No-op ohne
 * Revisionssprung und ohne Audit. Die Manifest-Reaktion bleibt bei CX-041;
 * dieser Dienst hinterlaesst ausschliesslich den gespeicherten Zuordnungsstand.
 */
import type { Pool, PoolClient } from "pg";
import { insertAuditEvent, type SqlQueryable } from "../audit/repository.js";
import { ensureTaxiActivationSchema } from "../taxiActivation/service.js";

export const TAXI_GROUP_MEMBERSHIPS_REPLACED_ACTION =
  "taxi.group_memberships_replaced";
export const TAXI_GROUP_MEMBERSHIPS_AUDIT_TARGET_TYPE = "taxi";
export const MAX_TAXI_GROUP_SELECTION = 100;
export const MAX_TAXI_GROUP_ID_LENGTH = 128;

export interface ReplaceTaxiGroupMembershipsInput {
  /** Vertrauenswuerdiger Betreiberbereich; nie aus einem Request uebernommen. */
  ownerId: string;
  /** Vertrauenswuerdiger Akteur; nie aus einem Request uebernommen. */
  actorId: string;
  taxiId: string;
  expectedRevision: number;
  groupIds: readonly string[];
}

export interface ReplaceTaxiGroupMembershipsResult {
  taxiId: string;
  previousGroupIds: string[];
  groupIds: string[];
  revision: number;
  changed: boolean;
}

export type TaxiGroupMembershipErrorCode =
  | "invalid_request"
  | "not_found"
  | "revision_conflict"
  | "missing_schema";

export class TaxiGroupMembershipError extends Error {
  readonly code: TaxiGroupMembershipErrorCode;

  constructor(code: TaxiGroupMembershipErrorCode, message: string) {
    super(message);
    this.name = "TaxiGroupMembershipError";
    this.code = code;
  }
}

export interface TaxiGroupMembershipServiceOptions {
  pool: Pool;
  now?: () => Date;
}

type TaxiRow = { id: string; owner_id: string; revision: string };
type GroupRow = { id: string; owner_id: string };
type MembershipRow = { group_id: string };

const GROUP_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(code: TaxiGroupMembershipErrorCode, message: string): never {
  throw new TaxiGroupMembershipError(code, message);
}

function normalizeContextId(value: unknown, label: string): string {
  if (typeof value !== "string") {
    fail("invalid_request", label + " muss ein Text sein.");
  }
  const id = value.trim();
  if (id.length < 1 || id.length > MAX_TAXI_GROUP_ID_LENGTH) {
    fail(
      "invalid_request",
      label + " muss 1 bis " + MAX_TAXI_GROUP_ID_LENGTH + " Zeichen enthalten.",
    );
  }
  return id;
}

function normalizeTaxiId(value: unknown): string {
  return normalizeContextId(value, "Die Taxi-ID");
}

function normalizeRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail("invalid_request", "Die erwartete Revision muss eine ganze Zahl ab 0 sein.");
  }
  return value;
}

/**
 * Begrenzt die Rohliste auf 100 Eintraege, entfernt Duplikate und sortiert
 * kanonisch. Ungueltige Gruppen-IDs koennen keine bestehende Gruppe treffen
 * und werden wie unbekannte Gruppen behandelt.
 */
function normalizeGroupIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    fail("invalid_request", "Die Gruppen-IDs muessen als Liste vorliegen.");
  }
  if (value.length > MAX_TAXI_GROUP_SELECTION) {
    fail(
      "invalid_request",
      "Es duerfen hoechstens " + MAX_TAXI_GROUP_SELECTION + " Gruppen gewaehlt werden.",
    );
  }
  const unique = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") {
      fail("invalid_request", "Jede Gruppen-ID muss ein Text sein.");
    }
    const id = raw.trim();
    if (id.length < 1 || id.length > MAX_TAXI_GROUP_ID_LENGTH) {
      fail(
        "invalid_request",
        "Jede Gruppen-ID muss 1 bis " +
          MAX_TAXI_GROUP_ID_LENGTH +
          " Zeichen enthalten.",
      );
    }
    if (!GROUP_ID_PATTERN.test(id)) {
      fail("not_found", "Eine gewaehlte Gruppe existiert nicht.");
    }
    unique.add(id.toLowerCase());
  }
  return [...unique].sort();
}

function readRevision(value: string): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Gespeicherte Taxi-Revision ist ungueltig.");
  }
  return revision;
}

const schemaReady = new WeakMap<Pool, Promise<void>>();

/**
 * Stellt die fuer die Ersetzung vorausgesetzten CX-Strukturen idempotent
 * bereit. Die Mitgliedschaftsrelation selbst stammt aus der bestehenden
 * Migration 0010 und wird hier nicht neu definiert; fehlt sie, ist der
 * Integrationsstand unvollstaendig. Das Betreibermodell der Taxis wird wie
 * bei den Gruppen additiv um owner_id ergaenzt, ohne eine zweite Relation.
 */
export function ensureTaxiGroupMembershipSchema(pool: Pool): Promise<void> {
  const pending = schemaReady.get(pool);
  if (pending !== undefined) {
    return pending;
  }
  const created = (async () => {
    await ensureTaxiActivationSchema(pool);
    await pool.query(
      [
        "alter table taxis",
        "  add column if not exists owner_id text not null default 'legacy-admin'",
      ].join("\n"),
    );
    const relation = await pool.query<{ present: boolean }>(
      "select to_regclass('taxi_group_memberships') is not null as present",
    );
    if (relation.rows[0]?.present !== true) {
      fail(
        "missing_schema",
        "Die Relation taxi_group_memberships fehlt; Migration 0010 ist nicht angewendet.",
      );
    }
  })();
  schemaReady.set(pool, created);
  created.catch(() => {
    if (schemaReady.get(pool) === created) {
      schemaReady.delete(pool);
    }
  });
  return created;
}

async function lockAndCheckGroups(
  client: PoolClient,
  ownerId: string,
  groupIds: readonly string[],
): Promise<void> {
  if (groupIds.length === 0) {
    return;
  }
  const rows = (
    await client.query<GroupRow>(
      [
        "select id::text as id, owner_id",
        "  from taxi_groups",
        " where id = any($1::uuid[])",
        " order by id asc",
        "   for update",
      ].join("\n"),
      [groupIds],
    )
  ).rows;
  // Unbekannte und fremde Gruppen sind nach aussen nicht unterscheidbar.
  if (rows.length !== groupIds.length) {
    fail("not_found", "Eine gewaehlte Gruppe existiert nicht.");
  }
  for (const row of rows) {
    if (row.owner_id !== ownerId) {
      fail("not_found", "Eine gewaehlte Gruppe existiert nicht.");
    }
  }
}

async function lockMemberships(
  client: PoolClient,
  taxiId: string,
): Promise<string[]> {
  const rows = (
    await client.query<MembershipRow>(
      [
        "select group_id",
        "  from taxi_group_memberships",
        " where taxi_id = $1",
        " order by group_id asc",
        "   for update",
      ].join("\n"),
      [taxiId],
    )
  ).rows;
  return rows.map((row) => row.group_id);
}

function sameGroups(before: readonly string[], after: readonly string[]): boolean {
  return (
    before.length === after.length &&
    before.every((groupId, index) => groupId === after[index])
  );
}

export class TaxiGroupMembershipService {
  private readonly pool: Pool;
  private readonly now: () => Date;

  constructor(options: TaxiGroupMembershipServiceOptions) {
    this.pool = options.pool;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Ersetzt die Gruppenmitgliedschaften genau eines Taxis vollstaendig.
   * Erwartet einen bereits authentifizierten Betreiber und Akteur; beide
   * werden nie aus der Eingabeliste abgeleitet.
   */
  async replaceTaxiGroupMemberships(
    input: ReplaceTaxiGroupMembershipsInput,
  ): Promise<ReplaceTaxiGroupMembershipsResult> {
    const ownerId = normalizeContextId(input?.ownerId, "Der Betreiber");
    const actorId = normalizeContextId(input?.actorId, "Der Akteur");
    const taxiId = normalizeTaxiId(input?.taxiId);
    const expectedRevision = normalizeRevision(input?.expectedRevision);
    const groupIds = normalizeGroupIds(input?.groupIds);
    const at = this.now();
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
      throw new Error("Die Serveruhr liefert keinen gueltigen Zeitpunkt.");
    }

    await ensureTaxiGroupMembershipSchema(this.pool);
    const client = await this.pool.connect();
    try {
      await client.query("begin");

      // Sperrreihenfolge: Taxi, dann Gruppen, dann bestehende Mitgliedschaften.
      const taxi = (
        await client.query<TaxiRow>(
          [
            "select id, owner_id, revision::text as revision",
            "  from taxis",
            " where id = $1",
            "   for update",
          ].join("\n"),
          [taxiId],
        )
      ).rows[0];
      if (taxi === undefined || taxi.owner_id !== ownerId) {
        fail("not_found", "Das Taxi existiert nicht.");
      }
      const currentRevision = readRevision(taxi.revision);
      if (currentRevision !== expectedRevision) {
        fail("revision_conflict", "Die erwartete Revision ist nicht mehr aktuell.");
      }

      // Alle gewaehlten Gruppen muessen im selben Betreiberbereich liegen.
      await lockAndCheckGroups(client, ownerId, groupIds);
      const previousGroupIds = await lockMemberships(client, taxiId);

      if (sameGroups(previousGroupIds, groupIds)) {
        await client.query("commit");
        return {
          taxiId,
          previousGroupIds,
          groupIds,
          revision: currentRevision,
          changed: false,
        };
      }

      await client.query("delete from taxi_group_memberships where taxi_id = $1", [
        taxiId,
      ]);
      if (groupIds.length > 0) {
        await client.query(
          [
            "insert into taxi_group_memberships (group_id, taxi_id)",
            "select id, $2",
            "  from unnest($1::text[]) as id",
          ].join("\n"),
          [groupIds, taxiId],
        );
      }

      const updated = (
        await client.query<{ revision: string }>(
          [
            "update taxis",
            "   set revision = revision + 1",
            " where id = $1",
            "   and revision = $2",
            "returning revision::text as revision",
          ].join("\n"),
          [taxiId, expectedRevision],
        )
      ).rows[0];
      if (updated === undefined) {
        fail("revision_conflict", "Die erwartete Revision ist nicht mehr aktuell.");
      }
      const revision = readRevision(updated.revision);

      await insertAuditEvent(client as SqlQueryable, {
        at,
        actorType: "admin",
        actorId,
        action: TAXI_GROUP_MEMBERSHIPS_REPLACED_ACTION,
        targetType: TAXI_GROUP_MEMBERSHIPS_AUDIT_TARGET_TYPE,
        targetId: taxiId,
        details: {
          added: groupIds.filter((groupId) => !previousGroupIds.includes(groupId)),
          removed: previousGroupIds.filter((groupId) => !groupIds.includes(groupId)),
          revision,
        },
      });

      await client.query("commit");
      return {
        taxiId,
        previousGroupIds,
        groupIds,
        revision,
        changed: true,
      };
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
}

