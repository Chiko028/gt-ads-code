/**
 * CX-105 / R-204 (Teil 6): Kampagnenlebenszyklus als abschliessender
 * Servicefolgeteil von CX-032/CX-038. Genau eine Funktion fuehrt Aktivieren,
 * Pausieren, Beenden und Archivieren aus; Sperre, Pruefungen, Schreiben,
 * Revision und Audit laufen in einer Transaktion. Keine Route, keine
 * Slotplanung, keine zweite Belegungspruefung, keine Migration.
 */
import type { Pool } from "pg";
import { ApiError } from "../../http/errors.js";
import type { SqlQueryable } from "../audit/repository.js";
import { AuditService } from "../audit/service.js";
import {
  markCampaignChange,
  type ManifestRefreshTrigger,
} from "../manifestRefresh/index.js";
import {
  CAMPAIGN_AUDIT_TARGET_TYPE,
  isCampaignStatus,
  normalizeCampaignUuid,
  type CampaignStatus,
} from "./campaigns.js";
import { validateCampaignRuntime } from "./runtimeWindow.js";

export const CAMPAIGN_TRANSITION_ACTION = "campaign.transitioned";
/** Genau eine Aktion je Aufruf; "archive" ist kein Statuswechsel. */
export const CAMPAIGN_TRANSITION_ACTIONS = Object.freeze([
  "activate",
  "pause",
  "finish",
  "archive",
] as const);
export type CampaignTransitionAction =
  (typeof CAMPAIGN_TRANSITION_ACTIONS)[number];
type StatusAction = Exclude<CampaignTransitionAction, "archive">;

const TARGET_STATUS: Readonly<Record<StatusAction, CampaignStatus>> =
  Object.freeze({ activate: "active", pause: "paused", finish: "finished" });
/** Erlaubte Statuswechsel; "finished" ist terminal. */
const ALLOWED_TRANSITIONS: Readonly<
  Record<CampaignStatus, readonly CampaignStatus[]>
> = Object.freeze({
  draft: Object.freeze(["active", "finished"] as const),
  active: Object.freeze(["paused", "finished"] as const),
  paused: Object.freeze(["active", "finished"] as const),
  finished: Object.freeze([] as const),
});

export interface CampaignTransitionOptions {
  pool: Pool;
  /** Vertrauenswuerdiger Betreiberkontext, nicht aus dem Request body. */
  ownerId: unknown;
  /** Vertrauenswuerdiger Akteur fuer das Audit. */
  actorId: unknown;
  campaignId: unknown;
  expectedRevision: unknown;
  action: unknown;
  now?: () => Date;
  manifestRefresh?: ManifestRefreshTrigger;
}

export interface CampaignTransitionResult {
  id: string;
  status: CampaignStatus;
  archived: boolean;
  revision: number;
  /** false: identische Aktion auf bereits erreichtem Zustand (No-op). */
  changed: boolean;
}

interface CampaignTransitionRow {
  id: string;
  media_id: string;
  status: string;
  archived: boolean;
  revision: number;
  start_at: string;
  end_at: string;
}

interface Targets {
  taxiIds: string[];
  groupIds: string[];
}

const COLUMNS = [
  "c.id::text as id",
  "c.media_id::text as media_id",
  "c.status",
  "c.archived",
  "c.revision",
  "to_char(c.start_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as start_at",
  "to_char(c.end_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as end_at",
].join(", ");

function contextId(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw ApiError.invalidRequest();
  }
  return value;
}

function revisionOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw ApiError.invalidRequest();
  }
  return value;
}

function actionOf(value: unknown): CampaignTransitionAction {
  if (
    typeof value !== "string" ||
    !(CAMPAIGN_TRANSITION_ACTIONS as readonly string[]).includes(value)
  ) {
    throw ApiError.invalidRequest();
  }
  return value as CampaignTransitionAction;
}

function asStatus(value: string): CampaignStatus {
  if (!isCampaignStatus(value)) {
    throw new Error("Gespeicherter Kampagnenstatus ist unbekannt");
  }
  return value;
}

function view(
  row: { id: string; status: string; archived: boolean; revision: number },
  changed: boolean,
): CampaignTransitionResult {
  return {
    id: row.id,
    status: asStatus(row.status),
    archived: row.archived,
    revision: row.revision,
    changed,
  };
}

/**
 * Identische Aktionen auf dem erreichten Zustand sind bei aktueller Revision
 * ein No-op; eine veraltete Revision bleibt ein Konflikt ohne jede Wirkung.
 */
export async function transitionCampaign(
  options: CampaignTransitionOptions,
): Promise<CampaignTransitionResult> {
  const ownerId = contextId(options.ownerId);
  const actorId = contextId(options.actorId);
  const campaignId = normalizeCampaignUuid(options.campaignId);
  const expectedRevision = revisionOf(options.expectedRevision);
  const action = actionOf(options.action);
  const at = (options.now ?? (() => new Date()))();
  const audit = new AuditService({ executor: options.pool });
  const client = await options.pool.connect();
  let marked = false;

  try {
    await client.query("begin");
    // 1. Kampagnendatensatz samt Betreiberbindung sperren.
    const locked = await client.query<CampaignTransitionRow>(
      [
        "select " + COLUMNS,
        "  from campaigns c",
        " where c.id = $1::uuid and c.owner_id = $2",
        "   for update of c",
      ].join("\n"),
      [campaignId, ownerId],
    );
    const current = locked.rows[0];
    if (current === undefined) {
      throw ApiError.notFound();
    }
    if (current.revision !== expectedRevision) {
      throw ApiError.invalidRequest();
    }

    // 2. Archivierung ist irreversibel; nur Entwurf/Beendet.
    if (action === "archive") {
      const status = asStatus(current.status);
      if (!current.archived && status !== "draft" && status !== "finished") {
        throw ApiError.invalidRequest();
      }
      if (current.archived) {
        await client.query("commit");
        return view(current, false);
      }
      const archived = await writeTransition(client, audit, {
        current, nextStatus: status, nextArchived: true, action, actorId, ownerId, at,
      });
      await client.query("commit");
      return archived;
    }
    if (current.archived) {
      throw ApiError.invalidRequest();
    }

    const status = asStatus(current.status);
    const nextStatus = TARGET_STATUS[action];
    if (nextStatus === status) {
      await client.query("commit");
      return view(current, false);
    }
    if (!ALLOWED_TRANSITIONS[status].includes(nextStatus)) {
      throw ApiError.invalidRequest();
    }
    if (nextStatus === "active") {
      await assertActivatable(client, current);
    }

    const targets = await loadTargets(client, campaignId);
    const change = await writeTransition(client, audit, {
      current, nextStatus, nextArchived: false, action, actorId, ownerId, at,
    });
    // 3. Vorhandene Manifest-Konvention; kein eigener Scheduler.
    if (status === "active" || nextStatus === "active") {
      await markCampaignChange(
        client,
        status === "active" ? targets : null,
        nextStatus === "active" ? targets : null,
        at,
      );
      marked = true;
    }
    await client.query("commit");
    if (marked && options.manifestRefresh !== undefined) {
      void options.manifestRefresh.drainPending({ limit: 10 }).catch(() => undefined);
    }
    return change;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Aktivierungsvoraussetzungen in fester Reihenfolge: Laufzeit (CX-004),
 * Medium (ready, nicht geloescht, Zeilensperre), effektives Taxiziel.
 */
async function assertActivatable(
  client: SqlQueryable,
  current: CampaignTransitionRow,
): Promise<void> {
  if (!validateCampaignRuntime(current.start_at, current.end_at).ok) {
    throw ApiError.invalidRequest();
  }
  const media = await client.query<{ status: string; deleted_at: Date | null }>(
    [
      "select status, deleted_at",
      "  from media_objects",
      " where id = $1::uuid",
      "   for share",
    ].join("\n"),
    [current.media_id],
  );
  const mediaRow = media.rows[0];
  if (
    mediaRow === undefined ||
    mediaRow.status !== "ready" ||
    mediaRow.deleted_at !== null
  ) {
    throw ApiError.invalidRequest();
  }
  const effective = await client.query<{ count: number }>(
    [
      "select count(*)::int as count",
      "  from (",
      "    select target_id as taxi_id",
      "      from campaign_targets",
      "     where campaign_id = $1::uuid and kind = 'taxi'",
      "    union",
      "    select gm.taxi_id",
      "      from campaign_targets ct",
      "      join taxi_group_memberships gm on gm.group_id = ct.target_id",
      "     where ct.campaign_id = $1::uuid and ct.kind = 'group'",
      "  ) effective",
    ].join("\n"),
    [current.id],
  );
  if ((effective.rows[0]?.count ?? 0) < 1) {
    throw ApiError.invalidRequest();
  }
}

async function loadTargets(
  client: SqlQueryable,
  campaignId: string,
): Promise<Targets> {
  const rows = await client.query<{ kind: string; target_id: string }>(
    [
      "select kind, target_id",
      "  from campaign_targets",
      " where campaign_id = $1::uuid",
      " order by kind asc, target_id asc",
    ].join("\n"),
    [campaignId],
  );
  const targets: Targets = { taxiIds: [], groupIds: [] };
  for (const row of rows.rows) {
    if (row.kind === "taxi") {
      targets.taxiIds.push(row.target_id);
    } else if (row.kind === "group") {
      targets.groupIds.push(row.target_id);
    }
  }
  return targets;
}

/** Eine Aktualisierung, Revision genau einmal, genau ein bereinigtes Audit. */
async function writeTransition(
  client: SqlQueryable,
  audit: AuditService,
  input: {
    current: CampaignTransitionRow;
    nextStatus: CampaignStatus;
    nextArchived: boolean;
    action: CampaignTransitionAction;
    actorId: string;
    ownerId: string;
    at: Date;
  },
): Promise<CampaignTransitionResult> {
  const updated = await client.query<{
    id: string;
    status: string;
    archived: boolean;
    revision: number;
  }>(
    [
      "update campaigns c",
      "   set status = $3,",
      "       archived = $4,",
      "       revision = c.revision + 1,",
      "       updated_at = $5",
      " where c.id = $1::uuid and c.owner_id = $2",
      "   and c.revision = $6",
      " returning c.id::text as id, c.status, c.archived, c.revision",
    ].join("\n"),
    [
      input.current.id,
      input.ownerId,
      input.nextStatus,
      input.nextArchived,
      input.at,
      input.current.revision,
    ],
  );
  const row = updated.rows[0];
  if (row === undefined) {
    throw ApiError.notFound();
  }
  await audit.recordWith(
    client,
    {
      actorType: "admin",
      actorId: input.actorId,
      action: CAMPAIGN_TRANSITION_ACTION,
      targetType: CAMPAIGN_AUDIT_TARGET_TYPE,
      targetId: input.current.id,
      details: {
        action: input.action,
        from_status: asStatus(input.current.status),
        to_status: input.nextStatus,
        archived: input.nextArchived,
      },
    },
    input.at,
  );
  return view(row, true);
}
