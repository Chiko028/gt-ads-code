/**
 * CX-133 / R-104 Teil 2: Taxi-Stammdaten schreiben (Anlage, Aenderung).
 * Gelesen wird die Liste ueber GET /v1/admin/taxis (CX-132, http/taxiList.ts).
 *
 * Der Dienst ist der einzige Schreibweg fuer die bestehende Tabelle taxis.
 * Er legt keine neue Persistenz und keine Migration an: die vorhandenen
 * CX-Strukturen werden wie bei den bestehenden Aufrufern ueber
 * ensureTaxiActivationSchema() bereitgestellt; das Betreiberfeld der Taxis
 * stammt aus dem vorhandenen Membership-Schema.
 *
 * Gruppen werden nicht ein zweites Mal implementiert. Fuer POST und PATCH
 * wird der vorhandene CX-118-Dienst (TaxiGroupMembershipService) auf demselben
 * Transaktionsclient aufgerufen. Dafuer stellt transactionPool() eine
 * schmale, transaktionsgebundene Pool-Grenze bereit: begin/commit/rollback
 * und release des Dienstes werden zu No-ops, weil die Transaktion bereits
 * vom Taxidienst gefuehrt wird.
 *
 * Revision:
 * - POST legt genau Revision 1 an. Die Gruppenzuordnung gehoert zur Anlage;
 *   ein vom Membership-Dienst fuer die Zuordnung erhoehter Zwischenstand wird
 *   deshalb vor dem Commit auf die Anlagerevision zurueckgefuehrt.
 * - PATCH prueft die erwartete Revision und erhoeht sie bei Erfolg genau um
 *   eins. Aendert der Membership-Dienst die Gruppen, liefert er die neue
 *   Revision; andernfalls erhoeht der Taxidienst sie selbst.
 */
import type { Pool, PoolClient, QueryResult } from "pg";
import { AuditService } from "../audit/service.js";
import { ensureTaxiActivationSchema } from "../taxiActivation/service.js";
import {
  MAX_TAXI_GROUP_SELECTION,
  TaxiGroupMembershipError,
  TaxiGroupMembershipService,
  ensureTaxiGroupMembershipSchema,
} from "../taxiGroupMemberships/service.js";

export const TAXI_CREATED_ACTION = "taxi.created";
export const TAXI_UPDATED_ACTION = "taxi.updated";
export const TAXI_AUDIT_TARGET_TYPE = "taxi";
export const MAX_TAXI_ID_LENGTH = 64;
export const MAX_TAXI_DISPLAY_NAME_LENGTH = 120;

export interface TaxiRecord {
  id: string;
  display_name: string;
  active: boolean;
  revision: number;
  /** Genau zwei Plaetze; null bedeutet "nicht belegt". */
  tablet_ids: [string | null, string | null];
  group_ids: string[];
}

export type TaxiMasterDataErrorCode =
  | "invalid_request"
  | "conflict"
  | "not_found"
  | "missing_schema";

export class TaxiMasterDataError extends Error {
  readonly code: TaxiMasterDataErrorCode;

  constructor(code: TaxiMasterDataErrorCode, message: string) {
    super(message);
    this.name = "TaxiMasterDataError";
    this.code = code;
  }
}

export interface CreateTaxiInput {
  id: unknown;
  displayName: unknown;
  groupIds: unknown;
  ownerId: string;
  actorId: string;
  at: Date;
}

export interface UpdateTaxiInput {
  id: unknown;
  displayName: unknown;
  groupIds: unknown;
  expectedRevision: unknown;
  ownerId: string;
  actorId: string;
  at: Date;
}

export interface TaxiServiceOptions {
  pool: Pool;
  now?: () => Date;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SQL_BEGIN = "begin";
const SQL_COMMIT = "commit";
const SQL_ROLLBACK = "rollback";

function isTransactionCommand(text: unknown): boolean {
  if (typeof text !== "string") {
    return false;
  }
  const normalized = text.trim().toLowerCase();
  return (
    normalized === SQL_BEGIN ||
    normalized === SQL_COMMIT ||
    normalized === SQL_ROLLBACK
  );
}

function emptyResult(): QueryResult {
  return {
    command: "",
    rowCount: 0,
    oid: 0,
    fields: [],
    rows: [],
  } as QueryResult;
}

/**
 * Transaktionsgebundene Pool-Grenze fuer den vorhandenen Membership-Dienst.
 * Der Dienst erwartet einen Pool, fuehrt aber selbst begin/commit/rollback und
 * release aus. Auf dem bereits laufenden Transaktionsclient werden diese
 * Steuerbefehle zu No-ops; alle Fachabfragen laufen auf genau diesem Client.
 */
function transactionPool(client: PoolClient): Pool {
  const boundClient = {
    query(text: unknown, values?: unknown[]): Promise<QueryResult> {
      if (isTransactionCommand(text)) {
        return Promise.resolve(emptyResult());
      }
      return client.query(text as string, values as unknown[]);
    },
    release(): void {
      // Die Transaktion wird ausschliesslich vom Taxidienst beendet.
    },
  };
  const boundPool = {
    query(text: unknown, values?: unknown[]): Promise<QueryResult> {
      return client.query(text as string, values as unknown[]);
    },
    async connect(): Promise<typeof boundClient> {
      return boundClient;
    },
    // ensureTaxiActivationSchema haengt einen Pool-Fehlerlistener an; auf der
    // gebundenen Grenze ist das ein No-op, weil der reale Pool bereits durch
    // den Taxidienst ueberwacht wird.
    on(): unknown {
      return boundPool;
    },
  };
  return boundPool as unknown as Pool;
}

function fail(code: TaxiMasterDataErrorCode, message: string): never {
  throw new TaxiMasterDataError(code, message);
}

function normalizeId(value: unknown): string {
  if (typeof value !== "string") {
    fail("invalid_request", "Die Taxi-ID muss ein Text sein.");
  }
  const id = value.trim();
  if (id.length < 1 || id.length > MAX_TAXI_ID_LENGTH) {
    fail(
      "invalid_request",
      "Die Taxi-ID muss 1 bis " + MAX_TAXI_ID_LENGTH + " Zeichen enthalten.",
    );
  }
  return id;
}

function normalizeDisplayName(value: unknown): string {
  if (typeof value !== "string") {
    fail("invalid_request", "Der Anzeigename muss ein Text sein.");
  }
  const name = value.trim();
  if (name.length < 1 || name.length > MAX_TAXI_DISPLAY_NAME_LENGTH) {
    fail(
      "invalid_request",
      "Der Anzeigename muss 1 bis " +
        MAX_TAXI_DISPLAY_NAME_LENGTH +
        " Zeichen enthalten.",
    );
  }
  return name;
}

/** Wie im vorhandenen Membership-Dienst: max. 100, dedupliziert, sortiert. */
function normalizeGroupIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    fail("invalid_request", "Die Gruppen-IDs muessen als Liste vorliegen.");
  }
  if (value.length > MAX_TAXI_GROUP_SELECTION) {
    fail(
      "invalid_request",
      "Es duerfen hoechstens " +
        MAX_TAXI_GROUP_SELECTION +
        " Gruppen gewaehlt werden.",
    );
  }
  const unique = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") {
      fail("invalid_request", "Jede Gruppen-ID muss ein Text sein.");
    }
    const id = raw.trim();
    if (id.length < 1 || id.length > 128) {
      fail(
        "invalid_request",
        "Jede Gruppen-ID muss 1 bis 128 Zeichen enthalten.",
      );
    }
    if (!UUID_PATTERN.test(id)) {
      fail("not_found", "Eine gewaehlte Gruppe existiert nicht.");
    }
    unique.add(id.toLowerCase());
  }
  return [...unique].sort();
}

function normalizeRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(
      "invalid_request",
      "Die erwartete Revision muss eine ganze Zahl ab 0 sein.",
    );
  }
  return value;
}

function normalizeContextId(value: unknown, label: string): string {
  if (typeof value !== "string") {
    fail("invalid_request", label + " muss ein Text sein.");
  }
  const id = value.trim();
  if (id.length < 1 || id.length > 128) {
    fail("invalid_request", label + " muss 1 bis 128 Zeichen enthalten.");
  }
  return id;
}

function readRevision(value: string): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Gespeicherte Taxi-Revision ist ungueltig.");
  }
  return revision;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

function mapMembershipError(error: unknown): never {
  if (error instanceof TaxiGroupMembershipError) {
    if (error.code === "not_found") {
      fail("not_found", "Das Taxi oder eine gewaehlte Gruppe existiert nicht.");
    }
    if (error.code === "revision_conflict") {
      fail("conflict", "Die erwartete Revision ist nicht mehr aktuell.");
    }
    if (error.code === "missing_schema") {
      fail("missing_schema", "Die vorhandene Gruppenzuordnung fehlt.");
    }
    fail("invalid_request", "Die Gruppenzuordnung ist ungueltig.");
  }
  throw error;
}

interface TaxiRow {
  id: string;
  display_name: string;
  active: boolean;
  revision: string;
}

async function readTaxiRow(
  client: Pick<PoolClient, "query">,
  id: string,
): Promise<TaxiRecord> {
  const row = (
    await client.query<TaxiRow>(
      [
        "select id, display_name, active, revision::text as revision",
        "  from taxis",
        " where id = $1",
      ].join("\n"),
      [id],
    )
  ).rows[0];
  if (row === undefined) {
    fail("not_found", "Das Taxi existiert nicht.");
  }

  const tabletRows = (
    await client.query<{ device_id: string }>(
      [
        "select device_id::text as device_id",
        "  from device_taxi_assignments",
        " where taxi_id = $1 and active = true",
        " order by device_id asc",
        " limit 2",
      ].join("\n"),
      [id],
    )
  ).rows;
  const tabletIds: [string | null, string | null] = [
    tabletRows[0]?.device_id ?? null,
    tabletRows[1]?.device_id ?? null,
  ];

  const groupRows = (
    await client.query<{ group_id: string }>(
      [
        "select group_id",
        "  from taxi_group_memberships",
        " where taxi_id = $1",
        " order by group_id asc",
      ].join("\n"),
      [id],
    )
  ).rows;

  return {
    id: row.id,
    display_name: row.display_name,
    active: row.active,
    revision: readRevision(row.revision),
    tablet_ids: tabletIds,
    group_ids: groupRows.map((group) => group.group_id),
  };
}

export class TaxiService {
  private readonly pool: Pool;
  private readonly now: () => Date;

  constructor(options: TaxiServiceOptions) {
    this.pool = options.pool;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Stellt die vorhandenen Strukturen bereit. Es entsteht keine Migration und
   * keine Ersatztabelle; fehlt die Mitgliedschaftsrelation, blockiert der
   * vorhandene Membership-Dienst sichtbar.
   */
  private async ensureSchema(): Promise<void> {
    await ensureTaxiActivationSchema(this.pool);
    // Das Membership-Schema ergaenzt taxis.owner_id additiv und prueft die
    // vorhandene Relation taxi_group_memberships.
    await ensureTaxiGroupMembershipSchema(this.pool);
  }

  /** Legt genau ein inaktives Taxi mit Revision 1 und seinen Gruppen an. */
  async createTaxi(input: CreateTaxiInput): Promise<TaxiRecord> {
    const id = normalizeId(input?.id);
    const displayName = normalizeDisplayName(input?.displayName);
    const groupIds = normalizeGroupIds(input?.groupIds);
    const ownerId = normalizeContextId(input?.ownerId, "Der Betreiber");
    const actorId = normalizeContextId(input?.actorId, "Der Akteur");
    const at = input?.at;
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
      throw new Error("Die Serveruhr liefert keinen gueltigen Zeitpunkt.");
    }

    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query(SQL_BEGIN);
      const inserted = (
        await client.query<TaxiRow>(
          [
            "insert into taxis",
            "  (id, display_name, active, revision, owner_id)",
            "values ($1, $2, false, 1, $3)",
            "returning id, display_name, active, revision::text as revision",
          ].join("\n"),
          [id, displayName, ownerId],
        )
      ).rows[0];
      if (inserted === undefined) {
        throw new Error("Taxi wurde nicht gespeichert.");
      }

      // Der vorhandene Dienst prueft Gruppen, Betreiber und setzt die
      // Mitgliedschaften auf demselben Transaktionsclient.
      const membership = new TaxiGroupMembershipService({
        pool: transactionPool(client),
        now: () => at,
      });
      const membershipResult = await membership.replaceTaxiGroupMemberships({
        ownerId,
        actorId,
        taxiId: id,
        expectedRevision: 1,
        groupIds,
      });

      // Die Gruppenzuordnung ist Teil der Anlage, nicht eine zweite
      // Aenderung: die Anlagerevision bleibt 1.
      if (membershipResult.revision !== 1) {
        await client.query(
          "update taxis set revision = 1 where id = $1 and revision = $2",
          [id, membershipResult.revision],
        );
      }

      await new AuditService({ executor: client }).recordWith(
        client,
        {
          actorType: "admin",
          actorId,
          action: TAXI_CREATED_ACTION,
          targetType: TAXI_AUDIT_TARGET_TYPE,
          targetId: id,
          details: {
            display_name: displayName,
            group_ids: membershipResult.groupIds,
            revision: 1,
          },
        },
        at,
      );

      const created = await readTaxiRow(client, id);
      await client.query(SQL_COMMIT);
      return created;
    } catch (error) {
      try {
        await client.query(SQL_ROLLBACK);
      } catch {
        // Der urspruengliche Fehler bleibt massgeblich.
      }
      if (error instanceof TaxiMasterDataError) {
        throw error;
      }
      if (isUniqueViolation(error)) {
        fail("conflict", "Ein Taxi mit dieser ID existiert bereits.");
      }
      mapMembershipError(error);
    } finally {
      client.release();
    }
  }

  /** Aendert Name und Gruppen revisioniert; unbekannt -> 404. */
  async updateTaxi(input: UpdateTaxiInput): Promise<TaxiRecord> {
    const id = normalizeId(input?.id);
    const displayName = normalizeDisplayName(input?.displayName);
    const groupIds = normalizeGroupIds(input?.groupIds);
    const expectedRevision = normalizeRevision(input?.expectedRevision);
    const ownerId = normalizeContextId(input?.ownerId, "Der Betreiber");
    const actorId = normalizeContextId(input?.actorId, "Der Akteur");
    const at = input?.at;
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
      throw new Error("Die Serveruhr liefert keinen gueltigen Zeitpunkt.");
    }

    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query(SQL_BEGIN);
      const current = (
        await client.query<TaxiRow & { owner_id: string }>(
          [
            "select id, display_name, active, revision::text as revision, owner_id",
            "  from taxis",
            " where id = $1",
            "   for update",
          ].join("\n"),
          [id],
        )
      ).rows[0];
      // Fremde und unbekannte Taxis sind nach aussen nicht unterscheidbar.
      if (current === undefined || current.owner_id !== ownerId) {
        fail("not_found", "Das Taxi existiert nicht.");
      }
      const currentRevision = readRevision(current.revision);
      if (currentRevision !== expectedRevision) {
        fail("conflict", "Die erwartete Revision ist nicht mehr aktuell.");
      }

      // Der Name selbst erhoeht die Revision nicht; die eine Erhoehung
      // entsteht unten genau einmal (durch den Membership-Dienst oder hier).
      const renamed = (
        await client.query<{ id: string }>(
          [
            "update taxis set display_name = $2",
            " where id = $1 and revision = $3",
            "returning id",
          ].join("\n"),
          [id, displayName, expectedRevision],
        )
      ).rows[0];
      if (renamed === undefined) {
        fail("conflict", "Die erwartete Revision ist nicht mehr aktuell.");
      }

      const membership = new TaxiGroupMembershipService({
        pool: transactionPool(client),
        now: () => at,
      });
      const membershipResult = await membership.replaceTaxiGroupMemberships({
        ownerId,
        actorId,
        taxiId: id,
        expectedRevision,
        groupIds,
      });

      if (!membershipResult.changed) {
        const bumped = (
          await client.query<{ id: string }>(
            [
              "update taxis set revision = revision + 1",
              " where id = $1 and revision = $2",
              "returning id",
            ].join("\n"),
            [id, expectedRevision],
          )
        ).rows[0];
        if (bumped === undefined) {
          fail("conflict", "Die erwartete Revision ist nicht mehr aktuell.");
        }
      }

      const revision = expectedRevision + 1;
      await new AuditService({ executor: client }).recordWith(
        client,
        {
          actorType: "admin",
          actorId,
          action: TAXI_UPDATED_ACTION,
          targetType: TAXI_AUDIT_TARGET_TYPE,
          targetId: id,
          details: {
            previous_display_name: current.display_name,
            display_name: displayName,
            group_ids: membershipResult.groupIds,
            revision,
          },
        },
        at,
      );

      const updated = await readTaxiRow(client, id);
      await client.query(SQL_COMMIT);
      return updated;
    } catch (error) {
      try {
        await client.query(SQL_ROLLBACK);
      } catch {
        // Der urspruengliche Fehler bleibt massgeblich.
      }
      if (error instanceof TaxiMasterDataError) {
        throw error;
      }
      mapMembershipError(error);
    } finally {
      client.release();
    }
  }
}

