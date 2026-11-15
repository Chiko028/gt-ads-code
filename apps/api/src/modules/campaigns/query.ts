/**
 * CX-103 / R-204 (Teil 4): rein lesende Kampagnenabfrage.
 *
 * Eine einzige SQL-Anweisung liefert Stammdaten und Ziele aus demselben
 * Anweisungs-Snapshot. Saemtliche Zielreferenzen werden ueber die jeweiligen
 * Ressourcentabellen (taxis, taxi_groups) gegen den Kampagnenbetreiber
 * geprueft; betreiberfremde oder unbekannte Referenzen erscheinen nicht in
 * den Zielaufloesungen. Es gibt keine Schreibwirkung, kein Audit, keine
 * Statusableitung aus der Uhr und keine Manifestberechnung.
 */
import { ApiError } from "../../http/errors.js";
import type { SqlQueryable } from "../audit/repository.js";
import {
  CAMPAIGN_RULE_TYPE,
  isCampaignStatus,
  normalizeCampaignUuid,
  type CampaignStatus,
} from "./campaigns.js";

/** Standardlimit der Liste (bewusst kleiner als das Maximum). */
export const CAMPAIGN_QUERY_DEFAULT_LIMIT = 50;
export const CAMPAIGN_QUERY_MAX_LIMIT = 100;

export interface CampaignQueryView {
  id: string;
  customerId: string;
  mediaId: string;
  ruleType: typeof CAMPAIGN_RULE_TYPE;
  status: CampaignStatus;
  archived: boolean;
  startAt: string;
  endAt: string;
  revision: number;
  /** Direkte Taxi-Ziele, dedupliziert und aufsteigend sortiert. */
  taxiIds: string[];
  /** Direkte Gruppen-Ziele, dedupliziert und aufsteigend sortiert. */
  groupIds: string[];
  /** Vereinigung aus direkten Taxis und Mitgliedern aller Gruppen. */
  effectiveTaxiIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CampaignListFilter {
  afterId?: unknown;
  limit?: unknown;
  includeArchived?: unknown;
}

export interface CampaignQueryPage {
  items: CampaignQueryView[];
  nextAfterId: string | null;
}

interface CampaignQueryBase {
  pool: SqlQueryable;
  /** Vertrauenswuerdiger Betreiberkontext, z. B. aus der Admin-Sitzung. */
  ownerId: string;
}

export interface CampaignByIdQuery extends CampaignQueryBase {
  campaignId: unknown;
  filter?: never;
}

export interface CampaignListQuery extends CampaignQueryBase {
  campaignId?: never;
  filter: CampaignListFilter;
}

interface CampaignQueryRow {
  id: string;
  customer_id: string;
  media_id: string;
  rule_type: string;
  status: string;
  archived: boolean;
  start_at: string;
  end_at: string;
  revision: number;
  taxi_ids: string[] | null;
  group_ids: string[] | null;
  effective_taxi_ids: string[] | null;
  created_at: Date;
  updated_at: Date;
}

const CAMPAIGN_QUERY_COLUMNS = [
  "c.id::text as id",
  "c.customer_id::text as customer_id",
  "c.media_id::text as media_id",
  "c.rule_type",
  "c.status",
  "c.archived",
  "to_char(c.start_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as start_at",
  "to_char(c.end_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as end_at",
  "c.revision",
  "coalesce(t.taxi_ids, '{}') as taxi_ids",
  "coalesce(g.group_ids, '{}') as group_ids",
  "coalesce(e.taxi_ids, '{}') as effective_taxi_ids",
  "c.created_at",
  "c.updated_at",
].join(", ");

const TARGET_JOINS = [
  "left join lateral (",
  "  select array_agg(distinct tx.id order by tx.id) as taxi_ids",
  "    from campaign_targets ct",
  "    join taxis tx on tx.id = ct.target_id",
  "   where ct.campaign_id = c.id and ct.kind = 'taxi'",
  "     and tx.owner_id = c.owner_id",
  ") t on true",
  "left join lateral (",
  "  select array_agg(distinct tg.id::text order by tg.id::text) as group_ids",
  "    from campaign_targets ct",
  "    join taxi_groups tg on tg.id::text = ct.target_id",
  "   where ct.campaign_id = c.id and ct.kind = 'group'",
  "     and tg.owner_id = c.owner_id",
  ") g on true",
  "left join lateral (",
  "  select array_agg(distinct resolved.taxi_id order by resolved.taxi_id) as taxi_ids",
  "    from (",
  "      select tx.id as taxi_id",
  "        from campaign_targets ct",
  "        join taxis tx on tx.id = ct.target_id",
  "       where ct.campaign_id = c.id and ct.kind = 'taxi'",
  "         and tx.owner_id = c.owner_id",
  "      union",
  "      select tx.id",
  "        from campaign_targets ct",
  "        join taxi_groups tg on tg.id::text = ct.target_id",
  "        join taxi_group_memberships gm on gm.group_id = tg.id::text",
  "        join taxis tx on tx.id = gm.taxi_id",
  "       where ct.campaign_id = c.id and ct.kind = 'group'",
  "         and tg.owner_id = c.owner_id",
  "         and tx.owner_id = c.owner_id",
  "    ) resolved",
  ") e on true",
].join("\n");

const SELECT_CAMPAIGN = [
  "select " + CAMPAIGN_QUERY_COLUMNS,
  "  from campaigns c",
  TARGET_JOINS,
].join("\n");

const CAMPAIGN_BY_ID_SQL = [
  SELECT_CAMPAIGN,
  " where c.owner_id = $1 and c.id = $2::uuid",
].join("\n");

const CAMPAIGN_LIST_SQL = [
  SELECT_CAMPAIGN,
  " where c.owner_id = $1",
  "   and ($2::uuid is null or c.id > $2::uuid)",
  "   and ($3::boolean or not c.archived)",
  " order by c.id asc",
  " limit $4",
].join("\n");

function normalizeOwnerId(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw ApiError.invalidRequest();
  }
  return value;
}

function normalizeQueryLimit(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > CAMPAIGN_QUERY_MAX_LIMIT
  ) {
    throw ApiError.invalidRequest();
  }
  return value;
}

function toView(row: CampaignQueryRow): CampaignQueryView {
  if (!isCampaignStatus(row.status)) {
    throw new Error("Gespeicherter Kampagnenstatus ist unbekannt");
  }
  return {
    id: row.id,
    customerId: row.customer_id,
    mediaId: row.media_id,
    ruleType: CAMPAIGN_RULE_TYPE,
    status: row.status,
    archived: row.archived,
    startAt: row.start_at,
    endAt: row.end_at,
    revision: row.revision,
    taxiIds: [...(row.taxi_ids ?? [])].sort(),
    groupIds: [...(row.group_ids ?? [])].sort(),
    effectiveTaxiIds: [...(row.effective_taxi_ids ?? [])].sort(),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function queryCampaigns(
  options: CampaignByIdQuery,
): Promise<CampaignQueryView | null>;
export function queryCampaigns(
  options: CampaignListQuery,
): Promise<CampaignQueryPage>;
/**
 * Liest genau eine Kampagne (ID) oder eine begrenzte, per afterId
 * fortsetzbare Liste. Unbekannte und fremde IDs liefern beide null; die
 * Listenabfrage enthaelt ausschliesslich Ressourcen des Betreibers.
 */
export async function queryCampaigns(
  options: CampaignByIdQuery | CampaignListQuery,
): Promise<CampaignQueryView | CampaignQueryPage | null> {
  const ownerId = normalizeOwnerId(options.ownerId);

  if (options.campaignId !== undefined) {
    const campaignId = normalizeCampaignUuid(options.campaignId);
    const result = await options.pool.query<CampaignQueryRow>(
      CAMPAIGN_BY_ID_SQL,
      [ownerId, campaignId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toView(row);
  }

  const filter: CampaignListFilter = options.filter ?? {};
  const afterId =
    filter.afterId === undefined || filter.afterId === null
      ? null
      : normalizeCampaignUuid(filter.afterId);
  const limit =
    filter.limit === undefined
      ? CAMPAIGN_QUERY_DEFAULT_LIMIT
      : normalizeQueryLimit(filter.limit);
  const includeArchived =
    filter.includeArchived === undefined ? false : filter.includeArchived;
  if (typeof includeArchived !== "boolean") {
    throw ApiError.invalidRequest();
  }

  // Eine Zeile mehr entscheidet ueber nextAfterId, ohne einen zweiten Lauf.
  const result = await options.pool.query<CampaignQueryRow>(
    CAMPAIGN_LIST_SQL,
    [ownerId, afterId, includeArchived, limit + 1],
  );
  const hasMore = result.rows.length > limit;
  const items = result.rows.slice(0, limit).map(toView);
  const last = items[items.length - 1];
  return {
    items,
    nextAfterId: hasMore && last !== undefined ? last.id : null,
  };
}

