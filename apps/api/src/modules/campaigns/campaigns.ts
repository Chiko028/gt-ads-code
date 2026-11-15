/**
 * CX-038 / R-205: Kampagnen-Routen auf dem vorhandenen Kundenkern (CX-032),
 * der Laufzeitpruefung (CX-004) und dem gekapselten JSON-Vertrag (CX-033).
 *
 * Der Integrationsstand enthaelt keinen Kampagnenkern (CX-035). Damit dieses
 * Arbeitspaket keine zweite Persistenz erzeugt, ist dieses Modul die einzige
 * Kampagnenpersistenz: eine minimale, additive Tabelle plus Zuordnungstabelle.
 * Es gibt keine Migrationsdatei und keine Vertragsaenderung; das Schema wird
 * idempotent beim Registrieren des Plugins angelegt (schema.ts).
 *
 * Bewusst NICHT enthalten: Preis-/Abrechnungslogik, Tablet-/Geraetemodell,
 * Stammdatenverwaltung fuer Taxis/Gruppen und eine zweite Laufzeitpruefung.
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ApiError } from "../../http/errors.js";
import { ADMIN_ACTOR_ID } from "../adminAuth/service.js";
import type { SqlQueryable } from "../audit/repository.js";
import { AuditService } from "../audit/service.js";
import { validateCampaignRuntime } from "./runtimeWindow.js";
import { ensureCampaignSchema } from "./schema.js";
import {
  markCampaignChange,
  type ManifestRefreshTrigger,
} from "../manifestRefresh/index.js";

export const CAMPAIGN_LIST_PATH = "/v1/admin/campaigns";
export const CAMPAIGN_DETAIL_PATH = "/v1/admin/campaigns/:id";

/** Einziger Regeltyp des MVP (ADR-0005). */
export const CAMPAIGN_RULE_TYPE = "fixed_slot";

/** Zulaessige Zustaende der vorhandenen Domaene (vgl. playout/types.ts). */
export const CAMPAIGN_STATUSES = Object.freeze([
  "draft",
  "active",
  "paused",
  "finished",
] as const);
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** Erlaubte Statuswechsel; "finished" ist terminal. */
const ALLOWED_TRANSITIONS: Readonly<Record<CampaignStatus, readonly CampaignStatus[]>> =
  Object.freeze({
    draft: Object.freeze(["active", "finished"] as const),
    active: Object.freeze(["paused", "finished"] as const),
    paused: Object.freeze(["active", "finished"] as const),
    finished: Object.freeze([] as const),
  });

export const CAMPAIGN_CREATED_ACTION = "campaign.created";
export const CAMPAIGN_UPDATED_ACTION = "campaign.updated";
export const CAMPAIGN_AUDIT_TARGET_TYPE = "campaign";

export const CAMPAIGN_TARGET_MAX_ITEMS = 200;
export const CAMPAIGN_TARGET_MAX_LENGTH = 128;

export const CAMPAIGN_LIST_DEFAULT_LIMIT = 100;
export const CAMPAIGN_LIST_MAX_LIMIT = 100;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CAMPAIGN_COLUMNS = [
  "c.id::text as id",
  "c.customer_id::text as customer_id",
  "c.media_id::text as media_id",
  "c.owner_id",
  "c.status",
  "c.archived",
  "to_char(c.start_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as start_at",
  "to_char(c.end_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as end_at",
  "c.revision",
  "c.created_at",
  "c.updated_at",
].join(", ");

interface CampaignRow {
  id: string;
  customer_id: string;
  media_id: string;
  owner_id: string;
  status: string;
  archived: boolean;
  start_at: string;
  end_at: string;
  revision: number;
  created_at: Date;
  updated_at: Date;
}

export interface Campaign {
  id: string;
  customerId: string;
  mediaId: string;
  status: CampaignStatus;
  archived: boolean;
  startAt: string;
  endAt: string;
  taxiIds: string[];
  groupIds: string[];
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCampaignInput {
  customerId: unknown;
  mediaId: unknown;
  startAt: unknown;
  endAt: unknown;
  taxiIds?: unknown;
  groupIds?: unknown;
  status?: unknown;
  ruleType?: unknown;
  ownerId?: string;
  actorId?: string;
}

export interface UpdateCampaignInput {
  status?: unknown;
  archived?: unknown;
  mediaId?: unknown;
  startAt?: unknown;
  endAt?: unknown;
  taxiIds?: unknown;
  groupIds?: unknown;
  revision?: unknown;
  actorId?: string;
}

export interface CampaignServiceOptions {
  pool: Pool;
  /** Nur fuer deterministische Tests; Standard ist die vorhandene UUID-Quelle. */
  idFactory?: () => string;
  now?: () => Date;
  manifestRefresh?: ManifestRefreshTrigger;
}

interface TargetMapValue {
  taxi: string[];
  group: string[];
}

/** Akzeptiert ausschliesslich eine kanonische UUID. */
export function normalizeCampaignUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw ApiError.invalidRequest();
  }
  return value.toLowerCase();
}

export function isCampaignStatus(value: unknown): value is CampaignStatus {
  return (
    typeof value === "string" &&
    (CAMPAIGN_STATUSES as readonly string[]).includes(value)
  );
}

export function normalizeCampaignStatus(
  value: unknown,
  allowed: readonly CampaignStatus[] = CAMPAIGN_STATUSES,
): CampaignStatus {
  if (!isCampaignStatus(value) || !allowed.includes(value)) {
    throw ApiError.invalidRequest();
  }
  return value;
}

/**
 * Prueft und dedupliziert Taxi- bzw. Gruppenziele. Tablets sind kein Ziel:
 * mehrere Tablets eines Taxis fuehren zu genau einem Taxi-Eintrag.
 */
export function normalizeCampaignTargets(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > CAMPAIGN_TARGET_MAX_ITEMS) {
    throw ApiError.invalidRequest();
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw ApiError.invalidRequest();
    }
    const trimmed = entry.trim();
    const length = Array.from(trimmed).length;
    if (length < 1 || length > CAMPAIGN_TARGET_MAX_LENGTH) {
      throw ApiError.invalidRequest();
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

/** Nutzt ausschliesslich die vorhandene Laufzeitpruefung aus CX-004. */
export function normalizeCampaignRuntime(
  startAt: unknown,
  endAt: unknown,
): { startAt: string; endAt: string } {
  const result = validateCampaignRuntime(startAt, endAt);
  if (!result.ok) {
    throw ApiError.invalidRequest();
  }
  return result.value;
}

/** Prueft den Statuswechsel gegen die feste Zustandsmaschine. */
export function assertCampaignTransition(
  from: CampaignStatus,
  to: CampaignStatus,
): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw ApiError.invalidRequest();
  }
}

function normalizeRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw ApiError.invalidRequest();
  }
  return value;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function asStatus(value: string): CampaignStatus {
  if (!isCampaignStatus(value)) {
    throw new Error("Gespeicherter Kampagnenstatus ist unbekannt");
  }
  return value;
}

function toCampaign(row: CampaignRow, targets: TargetMapValue): Campaign {
  return {
    id: row.id,
    customerId: row.customer_id,
    mediaId: row.media_id,
    status: asStatus(row.status),
    archived: row.archived,
    startAt: row.start_at,
    endAt: row.end_at,
    taxiIds: [...targets.taxi],
    groupIds: [...targets.group],
    revision: row.revision,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * Kampagnenkern. Jede Mutation (Fachzustand, Zuordnungen und U3-Audit) laeuft
 * auf genau einem Transaktionsclient; ein Auditfehler rollt alles zurueck.
 */
export class CampaignService {
  private readonly pool: Pool;
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private readonly audit: AuditService;
  private readonly manifestRefresh: ManifestRefreshTrigger | undefined;
  private schemaReady: Promise<void> | null = null;

  constructor(options: CampaignServiceOptions) {
    this.pool = options.pool;
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.now = options.now ?? (() => new Date());
    this.audit = new AuditService({ executor: this.pool });
    this.manifestRefresh = options.manifestRefresh;
  }

  private scheduleRefresh(): void {
    if (this.manifestRefresh === undefined) {
      return;
    }
    void this.manifestRefresh
      .drainPending({ limit: 10 })
      .catch(() => undefined);
  }

  /** Legt das minimale, additive Schema idempotent an (keine Migration). */
  async ensureSchema(): Promise<void> {
    await ensureCampaignSchema(this.pool);
  }

  /**
   * Einmalige, faule Bereitstellung des additiven Schemas. Sie laeuft nur
   * beim ersten Kampagnenzugriff; fremde DB-Bereiche ohne Kampagnenrouten
   * bleiben unberuehrt.
   */
  private ensureSchemaOnce(): Promise<void> {
    if (this.schemaReady === null) {
      this.schemaReady = ensureCampaignSchema(this.pool).catch((error: unknown) => {
        this.schemaReady = null;
        throw error;
      });
    }
    return this.schemaReady;
  }

  async createCampaign(input: CreateCampaignInput): Promise<Campaign> {
    await this.ensureSchemaOnce();
    const customerId = normalizeCampaignUuid(input.customerId);
    const mediaId = normalizeCampaignUuid(input.mediaId);
    const runtime = normalizeCampaignRuntime(input.startAt, input.endAt);
    const ruleType = input.ruleType ?? CAMPAIGN_RULE_TYPE;
    if (ruleType !== CAMPAIGN_RULE_TYPE) {
      throw ApiError.invalidRequest();
    }
    const status =
      input.status === undefined
        ? "draft"
        : normalizeCampaignStatus(input.status, ["draft", "active"]);
    const taxiIds = normalizeCampaignTargets(input.taxiIds);
    const groupIds = normalizeCampaignTargets(input.groupIds);
    if (status === "active") {
      assertActivatable(taxiIds, groupIds);
    }

    const id = this.idFactory();
    const ownerId = input.ownerId ?? ADMIN_ACTOR_ID;
    const actorId = input.actorId ?? ADMIN_ACTOR_ID;
    const at = this.now();
    const client = await this.pool.connect();

    try {
      await client.query("begin");
      const mediaReady = await this.assertReferences(client, customerId, mediaId);
      if (status === "active" && !mediaReady) {
        throw ApiError.invalidRequest();
      }

      const result = await client.query<CampaignRow>(
        [
          "insert into campaigns as c",
          "  (id, customer_id, media_id, owner_id, rule_type, status, archived,",
          "   start_at, end_at, revision, created_at, updated_at)",
          "values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, false,",
          "        $7::timestamptz, $8::timestamptz, 1, $9, $9)",
          "returning " + CAMPAIGN_COLUMNS,
        ].join("\n"),
        [
          id,
          customerId,
          mediaId,
          ownerId,
          CAMPAIGN_RULE_TYPE,
          status,
          runtime.startAt,
          runtime.endAt,
          at,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("Kampagne wurde nicht angelegt");
      }
      await this.replaceTargets(client, row.id, taxiIds, groupIds);
      if (status === "active") {
        await markCampaignChange(client, null, { taxiIds, groupIds }, at);
      }
      await this.audit.recordWith(
        client,
        {
          actorType: "admin",
          actorId,
          action: CAMPAIGN_CREATED_ACTION,
          targetType: CAMPAIGN_AUDIT_TARGET_TYPE,
          targetId: row.id,
          details: {
            fields: [
              "customer_id",
              "media_id",
              "start_at",
              "end_at",
              "group_ids",
              "taxi_ids",
              "status",
            ],
          },
        },
        row.updated_at,
      );
      await client.query("commit");
      this.scheduleRefresh();
      return toCampaign(row, { taxi: taxiIds, group: groupIds });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async getCampaign(id: string, ownerId: string): Promise<Campaign | null> {
    await this.ensureSchemaOnce();
    const campaignId = normalizeCampaignUuid(id);
    const result = await this.pool.query<CampaignRow>(
      "select " + CAMPAIGN_COLUMNS + " from campaigns c where c.id = $1::uuid and c.owner_id = $2",
      [campaignId, ownerId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    const targets = await this.loadTargets(this.pool, [row.id]);
    return toCampaign(row, targets.get(row.id) ?? { taxi: [], group: [] });
  }

  async listCampaigns(
    ownerId: string,
    limit: number = CAMPAIGN_LIST_DEFAULT_LIMIT,
  ): Promise<Campaign[]> {
    await this.ensureSchemaOnce();
    const checkedLimit = normalizeListLimit(limit);
    const result = await this.pool.query<CampaignRow>(
      [
        "select " + CAMPAIGN_COLUMNS,
        "  from campaigns c",
        " where c.owner_id = $1",
        " order by c.id asc",
        " limit $2",
      ].join("\n"),
      [ownerId, checkedLimit],
    );
    const targets = await this.loadTargets(
      this.pool,
      result.rows.map((row) => row.id),
    );
    return result.rows.map((row) =>
      toCampaign(row, targets.get(row.id) ?? { taxi: [], group: [] }),
    );
  }

  /**
   * Fachliche Aenderung unter Zeilensperre. Der erwartete Aenderungsstand
   * (revision) wird gegen den gesperrten Datensatz geprueft; ohne Angabe
   * serialisiert allein die Zeilensperre konkurrierende Mutationen.
   */
  async updateCampaign(
    id: string,
    patch: UpdateCampaignInput,
    ownerId: string,
  ): Promise<Campaign> {
    await this.ensureSchemaOnce();
    const campaignId = normalizeCampaignUuid(id);
    const actorId = patch.actorId ?? ADMIN_ACTOR_ID;
    const client = await this.pool.connect();

    try {
      await client.query("begin");
      const locked = await client.query<CampaignRow>(
        [
          "select " + CAMPAIGN_COLUMNS,
          "  from campaigns c",
          " where c.id = $1::uuid and c.owner_id = $2",
          "   for update of c",
        ].join("\n"),
        [campaignId, ownerId],
      );
      const currentRow = locked.rows[0];
      if (currentRow === undefined) {
        throw ApiError.notFound();
      }
      if (patch.revision !== undefined) {
        const expected = normalizeRevision(patch.revision);
        if (expected !== currentRow.revision) {
          throw ApiError.invalidRequest();
        }
      }
      const targetMap = await this.loadTargets(client, [campaignId]);
      const current = toCampaign(
        currentRow,
        targetMap.get(campaignId) ?? { taxi: [], group: [] },
      );
      if (current.archived) {
        throw ApiError.invalidRequest();
      }

      const nextStatus =
        patch.status === undefined
          ? current.status
          : normalizeCampaignStatus(patch.status);
      const archived =
        patch.archived === undefined ? current.archived : patch.archived;
      if (typeof archived !== "boolean") {
        throw ApiError.invalidRequest();
      }
      if (patch.archived !== undefined && archived === false) {
        // Einmal archiviert bleibt schreibgeschuetzt; es gibt kein Zurueck.
        throw ApiError.invalidRequest();
      }
      const nextArchived = archived;

      if (nextStatus !== current.status) {
        assertCampaignTransition(current.status, nextStatus);
      }
      if (nextArchived && nextStatus !== "draft" && nextStatus !== "finished") {
        throw ApiError.invalidRequest();
      }

      const mediaId =
        patch.mediaId === undefined
          ? current.mediaId
          : normalizeCampaignUuid(patch.mediaId);
      const runtime = normalizeCampaignRuntime(
        patch.startAt === undefined ? current.startAt : patch.startAt,
        patch.endAt === undefined ? current.endAt : patch.endAt,
      );
      const taxiIds =
        patch.taxiIds === undefined
          ? current.taxiIds
          : normalizeCampaignTargets(patch.taxiIds);
      const groupIds =
        patch.groupIds === undefined
          ? current.groupIds
          : normalizeCampaignTargets(patch.groupIds);

      if (nextStatus === "active") {
        assertActivatable(taxiIds, groupIds);
      }

      const fields: string[] = [];
      if (nextStatus !== current.status) {
        fields.push("status");
      }
      if (nextArchived !== current.archived) {
        fields.push("archived");
      }
      if (mediaId !== current.mediaId) {
        fields.push("media_id");
      }
      if (
        runtime.startAt !== current.startAt ||
        runtime.endAt !== current.endAt
      ) {
        fields.push("start_at", "end_at");
      }
      if (!sameIds(taxiIds, current.taxiIds)) {
        fields.push("taxi_ids");
      }
      if (!sameIds(groupIds, current.groupIds)) {
        fields.push("group_ids");
      }
      if (fields.length === 0) {
        throw ApiError.invalidRequest();
      }

      const mediaReady = await this.assertReferences(
        client,
        current.customerId,
        mediaId,
      );
      if (nextStatus === "active" && !mediaReady) {
        throw ApiError.invalidRequest();
      }

      const at = this.now();
      const updated = await client.query<CampaignRow>(
        [
          "update campaigns c",
          "   set media_id = $2::uuid,",
          "       status = $3,",
          "       archived = $4,",
          "       start_at = $5::timestamptz,",
          "       end_at = $6::timestamptz,",
          "       revision = c.revision + 1,",
          "       updated_at = $7",
          " where c.id = $1::uuid and c.owner_id = $8",
          " returning " + CAMPAIGN_COLUMNS,
        ].join("\n"),
        [
          campaignId,
          mediaId,
          nextStatus,
          nextArchived,
          runtime.startAt,
          runtime.endAt,
          at,
          ownerId,
        ],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        throw ApiError.notFound();
      }
      if (patch.taxiIds !== undefined || patch.groupIds !== undefined) {
        await this.replaceTargets(client, campaignId, taxiIds, groupIds);
      }
      if (current.status === "active" || nextStatus === "active") {
        await markCampaignChange(
          client,
          current.status === "active"
            ? { taxiIds: current.taxiIds, groupIds: current.groupIds }
            : null,
          nextStatus === "active" ? { taxiIds, groupIds } : null,
          at,
        );
      }
      await this.audit.recordWith(
        client,
        {
          actorType: "admin",
          actorId,
          action: CAMPAIGN_UPDATED_ACTION,
          targetType: CAMPAIGN_AUDIT_TARGET_TYPE,
          targetId: campaignId,
          details: { fields: [...fields].sort() },
        },
        at,
      );
      await client.query("commit");
      this.scheduleRefresh();
      return toCampaign(row, { taxi: taxiIds, group: groupIds });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  private async assertReferences(
    executor: SqlQueryable,
    customerId: string,
    mediaId: string,
  ): Promise<boolean> {
    const customer = await executor.query(
      "select 1 from customers where id = $1::uuid",
      [customerId],
    );
    if (customer.rowCount !== 1) {
      throw ApiError.invalidRequest();
    }
    // Gemeinsame Zeilensperre mit Aktivierung und Loeschung: Eine Zuordnung
    // darf weder an einem geloeschten Medium haengen noch parallel zu dessen
    // Markierung entstehen.
    const media = await executor.query<{
      status: string;
      deleted_at: Date | null;
    }>(
      [
        "select status, deleted_at",
        "  from media_objects",
        " where id = $1::uuid",
        "   for share",
      ].join("\n"),
      [mediaId],
    );
    const row = media.rows[0];
    if (row === undefined || row.deleted_at !== null) {
      throw ApiError.invalidRequest();
    }
    return row.status === "ready";
  }

  private async replaceTargets(
    executor: SqlQueryable,
    campaignId: string,
    taxiIds: readonly string[],
    groupIds: readonly string[],
  ): Promise<void> {
    await executor.query(
      "delete from campaign_targets where campaign_id = $1::uuid",
      [campaignId],
    );
    if (taxiIds.length > 0) {
      await executor.query(
        [
          "insert into campaign_targets (campaign_id, kind, target_id)",
          "select $1::uuid, 'taxi', value",
          "  from jsonb_array_elements_text($2::jsonb)",
        ].join("\n"),
        [campaignId, JSON.stringify(taxiIds)],
      );
    }
    if (groupIds.length > 0) {
      await executor.query(
        [
          "insert into campaign_targets (campaign_id, kind, target_id)",
          "select $1::uuid, 'group', value",
          "  from jsonb_array_elements_text($2::jsonb)",
        ].join("\n"),
        [campaignId, JSON.stringify(groupIds)],
      );
    }
  }

  private async loadTargets(
    executor: SqlQueryable,
    campaignIds: readonly string[],
  ): Promise<Map<string, TargetMapValue>> {
    const map = new Map<string, TargetMapValue>();
    if (campaignIds.length === 0) {
      return map;
    }
    const result = await executor.query<{
      campaign_id: string;
      kind: string;
      target_id: string;
    }>(
      [
        "select campaign_id::text as campaign_id, kind, target_id",
        "  from campaign_targets",
        " where campaign_id = any($1::uuid[])",
        " order by campaign_id asc, kind asc, target_id asc",
      ].join("\n"),
      [campaignIds],
    );
    for (const row of result.rows) {
      const entry = map.get(row.campaign_id) ?? { taxi: [], group: [] };
      if (row.kind === "taxi") {
        entry.taxi.push(row.target_id);
      } else if (row.kind === "group") {
        entry.group.push(row.target_id);
      }
      map.set(row.campaign_id, entry);
    }
    return map;
  }
}

function assertActivatable(
  taxiIds: readonly string[],
  groupIds: readonly string[],
): void {
  if (taxiIds.length + groupIds.length < 1) {
    throw ApiError.invalidRequest();
  }
}

function normalizeListLimit(limit: number): number {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > CAMPAIGN_LIST_MAX_LIMIT
  ) {
    throw ApiError.invalidRequest();
  }
  return limit;
}

