/**
 * CX-041 / R-301: schmale, transaktionsgebundene Taxi-/Gruppenzuordnung.
 *
 * Der Dienst ist die einzige Mutationsstelle der additiven Mitgliedschafts-
 * tabelle. Er aendert die Mitglieder, schreibt das Audit und markiert die
 * betroffenen Taxis auf demselben Transaktionsclient. Erst nach erfolgreichem
 * Commit wird ein begrenzter Manifest-Lauf angestossen.
 */
import type { Pool } from "pg";
import { insertAuditEvent, type SqlQueryable } from "../audit/repository.js";
import {
  markGroupMembershipChange,
  type ManifestRefreshTrigger,
} from "../manifestRefresh/index.js";

export const TAXI_GROUP_MEMBERSHIP_ACTION = "taxi_group.membership_changed";
export const TAXI_GROUP_AUDIT_TARGET_TYPE = "taxi_group";
export const MAX_TAXI_GROUP_MEMBERS = 200;

export interface TaxiGroupAssignmentOptions {
  pool: Pool;
  now?: () => Date;
  manifestRefresh?: ManifestRefreshTrigger;
}

export interface TaxiGroupAssignmentResult {
  groupId: string;
  before: string[];
  after: string[];
  affected: string[];
}

export class TaxiAssignmentError extends Error {
  readonly code: "invalid_group_id" | "invalid_taxi_id" | "too_many_members";

  constructor(
    code: "invalid_group_id" | "invalid_taxi_id" | "too_many_members",
    message: string,
  ) {
    super(message);
    this.name = "TaxiAssignmentError";
    this.code = code;
  }
}

function normalizeGroupId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.trim().length > 128
  ) {
    throw new TaxiAssignmentError(
      "invalid_group_id",
      "Die Gruppen-ID muss 1 bis 128 Zeichen enthalten.",
    );
  }
  return value.trim();
}

function normalizeTaxiIds(values: readonly string[]): string[] {
  if (!Array.isArray(values)) {
    throw new TaxiAssignmentError(
      "invalid_taxi_id",
      "Die Taxi-IDs muessen als Liste vorliegen.",
    );
  }
  const unique = new Set<string>();
  for (const value of values) {
    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      value.trim().length > 128
    ) {
      throw new TaxiAssignmentError(
        "invalid_taxi_id",
        "Jede Taxi-ID muss 1 bis 128 Zeichen enthalten.",
      );
    }
    unique.add(value.trim());
  }
  if (unique.size > MAX_TAXI_GROUP_MEMBERS) {
    throw new TaxiAssignmentError(
      "too_many_members",
      "Eine Gruppe darf hoechstens " +
        MAX_TAXI_GROUP_MEMBERS +
        " Taxis enthalten.",
    );
  }
  return [...unique].sort();
}

export class TaxiGroupAssignmentService {
  private readonly pool: Pool;
  private readonly now: () => Date;
  private readonly manifestRefresh: ManifestRefreshTrigger | undefined;

  constructor(options: TaxiGroupAssignmentOptions) {
    this.pool = options.pool;
    this.now = options.now ?? (() => new Date());
    this.manifestRefresh = options.manifestRefresh;
  }

  async listGroupMembers(groupId: string): Promise<string[]> {
    const normalized = normalizeGroupId(groupId);
    const result = await this.pool.query<{ taxi_id: string }>(
      [
        "select taxi_id",
        "  from taxi_group_memberships",
        " where group_id = $1",
        " order by taxi_id asc",
      ].join("\n"),
      [normalized],
    );
    return result.rows.map((row) => row.taxi_id);
  }

  async replaceGroupMembers(
    groupId: string,
    taxiIds: readonly string[],
    actorId = "admin",
  ): Promise<TaxiGroupAssignmentResult> {
    const normalizedGroup = normalizeGroupId(groupId);
    const after = normalizeTaxiIds(taxiIds);
    const client = await this.pool.connect();

    try {
      await client.query("begin");

      // Serialisiert konkurrierende Aenderungen derselben Gruppe, auch wenn
      // die Gruppe noch gar keine Zeilen besitzt.
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        normalizedGroup,
      ]);

      const existing = await client.query<{ taxi_id: string }>(
        [
          "select taxi_id",
          "  from taxi_group_memberships",
          " where group_id = $1",
          " order by taxi_id asc",
          "   for update",
        ].join("\n"),
        [normalizedGroup],
      );
      const before = existing.rows.map((row) => row.taxi_id);
      const changed =
        before.length !== after.length ||
        before.some((taxiId, index) => taxiId !== after[index]);

      if (!changed) {
        await client.query("commit");
        return {
          groupId: normalizedGroup,
          before,
          after,
          affected: [],
        };
      }

      await client.query(
        "delete from taxi_group_memberships where group_id = $1",
        [normalizedGroup],
      );
      if (after.length > 0) {
        await client.query(
          [
            "insert into taxi_group_memberships (group_id, taxi_id)",
            "select $1, taxi_id from unnest($2::text[]) as taxi_id",
          ].join("\n"),
          [normalizedGroup, after],
        );
      }

      const at = this.now();
      const affected = await markGroupMembershipChange(
        client,
        normalizedGroup,
        before,
        after,
        at,
      );

      await insertAuditEvent(client as SqlQueryable, {
        at,
        actorType: "admin",
        actorId,
        action: TAXI_GROUP_MEMBERSHIP_ACTION,
        targetType: TAXI_GROUP_AUDIT_TARGET_TYPE,
        targetId: normalizedGroup,
        details: {
          added: after.filter((taxiId) => !before.includes(taxiId)),
          removed: before.filter((taxiId) => !after.includes(taxiId)),
        },
      });

      await client.query("commit");

      if (affected.length > 0) {
        this.scheduleRefresh();
      }

      return { groupId: normalizedGroup, before, after, affected };
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

  private scheduleRefresh(): void {
    if (this.manifestRefresh === undefined) {
      return;
    }
    void this.manifestRefresh
      .drainPending({ limit: 10 })
      .catch(() => undefined);
  }
}

