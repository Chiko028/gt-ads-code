import type { ClassificationKey } from "../telemetryEvaluation/types.js";
import { TechnicalAlarmStorageError } from "./errors.js";
import type {
  TechnicalAlarmDeliveryOrder,
  TechnicalAlarmDeliveryStatus,
  TechnicalAlarmEpisode,
  TechnicalAlarmEpisodeStatus,
  TechnicalAlarmRepositoryPort,
  TechnicalAlarmSqlClient,
} from "./types.js";

export const LOCK_RESOURCE_SQL =
  "select pg_advisory_xact_lock(hashtextextended($1, 0)) as locked";

export const SELECT_STATE_SQL = [
  "select resource_id,",
  "       last_evaluation_version::text as last_evaluation_version,",
  "       last_evaluation_id, last_classification, updated_at",
  "  from technical_alarm_resource_state",
  " where resource_id = $1",
  " for update",
].join("\n");

export const INSERT_STATE_SQL = [
  "insert into technical_alarm_resource_state",
  "  (resource_id, last_evaluation_version, last_evaluation_id,",
  "   last_classification, updated_at)",
  "values ($1, $2, $3, $4, $5)",
].join("\n");

export const UPDATE_STATE_SQL = [
  "update technical_alarm_resource_state",
  "   set last_evaluation_version = $2,",
  "       last_evaluation_id = $3,",
  "       last_classification = $4,",
  "       updated_at = $5",
  " where resource_id = $1",
].join("\n");

export const EPISODE_COLUMNS = [
  "episode_id::text as episode_id",
  "resource_id",
  "status",
  "error_code",
  "fault_started_at",
  "detected_at",
  "resolved_at",
  "opened_evaluation_id",
  "opened_evaluation_version::text as opened_evaluation_version",
  "resolution_evaluation_id",
].join(",\n       ");

export const SELECT_OPEN_EPISODE_SQL = [
  "select " + EPISODE_COLUMNS,
  "  from technical_alarm_episodes",
  " where resource_id = $1 and status = 'open'",
  " for update",
].join("\n");

export const SELECT_EPISODE_SQL = [
  "select " + EPISODE_COLUMNS,
  "  from technical_alarm_episodes",
  " where episode_id = $1::bigint",
].join("\n");

export const INSERT_EPISODE_SQL = [
  "insert into technical_alarm_episodes",
  "  (resource_id, status, error_code, fault_started_at, detected_at,",
  "   opened_evaluation_id, opened_evaluation_version)",
  "values ($1, 'open', $2, $3::timestamptz, $4::timestamptz, $5, $6)",
  "returning " + EPISODE_COLUMNS,
].join("\n");

export const RESOLVE_EPISODE_SQL = [
  "update technical_alarm_episodes",
  "   set status = 'resolved',",
  "       resolved_at = $2::timestamptz,",
  "       resolution_evaluation_id = $3",
  " where episode_id = $1::bigint and status = 'open'",
  "returning " + EPISODE_COLUMNS,
].join("\n");

export const OUTBOX_COLUMNS = [
  "outbox_id::text as outbox_id",
  "episode_id::text as episode_id",
  "resource_id",
  "message_kind",
  "status",
  "attempt_count",
  "next_attempt_at",
  "lease_owner",
  "lease_expires_at",
  "last_error_code",
  "created_at",
  "updated_at",
].join(",\n       ");

export const INSERT_OUTBOX_SQL = [
  "insert into technical_alarm_outbox",
  "  (episode_id, resource_id, message_kind, status, attempt_count,",
  "   next_attempt_at, lease_owner, lease_expires_at, last_error_code,",
  "   created_at, updated_at)",
  "values ($1::bigint, $2, 'technical_alarm_opened', 'pending', 0,",
  "        $3::timestamptz, null, null, null, $3::timestamptz, $3::timestamptz)",
  "returning " + OUTBOX_COLUMNS,
].join("\n");

export const SELECT_OUTBOX_BY_EPISODE_SQL = [
  "select " + OUTBOX_COLUMNS,
  "  from technical_alarm_outbox",
  " where episode_id = $1::bigint",
].join("\n");

export const SELECT_PENDING_OUTBOX_SQL = [
  "select " + OUTBOX_COLUMNS,
  "  from technical_alarm_outbox",
  " where status in ('pending', 'leased')",
  " order by outbox_id",
  " limit $1",
].join("\n");

export interface StateRow extends Record<string, unknown> {
  resource_id: string;
  last_evaluation_version: string | number;
  last_evaluation_id: string;
  last_classification: ClassificationKey;
  updated_at: Date | string;
}

export interface EpisodeRow extends Record<string, unknown> {
  episode_id: string | number;
  resource_id: string;
  status: TechnicalAlarmEpisodeStatus;
  error_code: string;
  fault_started_at: Date | string;
  detected_at: Date | string;
  resolved_at: Date | string | null;
  opened_evaluation_id: string;
  opened_evaluation_version: string | number;
  resolution_evaluation_id: string | null;
}

export interface OutboxRow extends Record<string, unknown> {
  outbox_id: string | number;
  episode_id: string | number;
  resource_id: string;
  message_kind: "technical_alarm_opened";
  status: TechnicalAlarmDeliveryStatus;
  attempt_count: number | string;
  next_attempt_at: Date | string | null;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  last_error_code: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function parseSafeInteger(
  value: string | number,
  field: string,
  minimum = 0,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new TechnicalAlarmStorageError(
      "Gespeicherter Wert fuer " + field + " ist ungueltig.",
    );
  }
  return parsed;
}

function toIso(value: Date | string, field: string): string {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new TechnicalAlarmStorageError(
      "Gespeicherter Zeitpunkt fuer " + field + " ist ungueltig.",
    );
  }
  return new Date(ms).toISOString();
}

function toIsoOrNull(
  value: Date | string | null,
  field: string,
): string | null {
  return value === null ? null : toIso(value, field);
}

export function mapStateVersion(row: StateRow): number {
  return parseSafeInteger(
    row.last_evaluation_version,
    "last_evaluation_version",
    1,
  );
}

export function mapEpisodeRow(row: EpisodeRow): TechnicalAlarmEpisode {
  return {
    episodeId: parseSafeInteger(row.episode_id, "episode_id", 1),
    resourceId: row.resource_id,
    status: row.status,
    errorCode: row.error_code,
    faultStartedAt: toIso(row.fault_started_at, "fault_started_at"),
    detectedAt: toIso(row.detected_at, "detected_at"),
    resolvedAt: toIsoOrNull(row.resolved_at, "resolved_at"),
    openedEvaluationId: row.opened_evaluation_id,
    openedEvaluationVersion: parseSafeInteger(
      row.opened_evaluation_version,
      "opened_evaluation_version",
      1,
    ),
    resolutionEvaluationId: row.resolution_evaluation_id,
  };
}

export function mapOutboxRow(row: OutboxRow): TechnicalAlarmDeliveryOrder {
  return {
    outboxId: parseSafeInteger(row.outbox_id, "outbox_id", 1),
    episodeId: parseSafeInteger(row.episode_id, "episode_id", 1),
    resourceId: row.resource_id,
    messageKind: row.message_kind,
    status: row.status,
    attemptCount: parseSafeInteger(row.attempt_count, "attempt_count", 0),
    nextAttemptAt: toIsoOrNull(row.next_attempt_at, "next_attempt_at"),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: toIsoOrNull(row.lease_expires_at, "lease_expires_at"),
    lastErrorCode: row.last_error_code,
    createdAt: toIso(row.created_at, "created_at"),
    updatedAt: toIso(row.updated_at, "updated_at"),
  };
}

/**
 * Lesender Repository-Port fuer CX-029. Der Port bietet bewusst keine
 * Schreibmethoden an: Versandzustandsaenderungen muessen ihren eigenen
 * transaktionalen Regeln folgen.
 */
export class PostgresTechnicalAlarmRepository
  implements TechnicalAlarmRepositoryPort
{
  private readonly executor: TechnicalAlarmSqlClient;

  constructor(executor: TechnicalAlarmSqlClient) {
    this.executor = executor;
  }

  async findOpenEpisode(
    resourceId: string,
  ): Promise<TechnicalAlarmEpisode | null> {
    const result = await this.executor.query<EpisodeRow>(
      SELECT_OPEN_EPISODE_SQL,
      [resourceId],
    );
    return result.rows.length === 0 ? null : mapEpisodeRow(result.rows[0]);
  }

  async findEpisode(episodeId: number): Promise<TechnicalAlarmEpisode | null> {
    const result = await this.executor.query<EpisodeRow>(SELECT_EPISODE_SQL, [
      episodeId,
    ]);
    return result.rows.length === 0 ? null : mapEpisodeRow(result.rows[0]);
  }

  async findDeliveryOrder(
    episodeId: number,
  ): Promise<TechnicalAlarmDeliveryOrder | null> {
    const result = await this.executor.query<OutboxRow>(
      SELECT_OUTBOX_BY_EPISODE_SQL,
      [episodeId],
    );
    return result.rows.length === 0 ? null : mapOutboxRow(result.rows[0]);
  }

  async listPendingDeliveryOrders(
    limit: number,
  ): Promise<TechnicalAlarmDeliveryOrder[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new TechnicalAlarmStorageError(
        "limit muss eine sichere Ganzzahl zwischen 1 und 1000 sein.",
      );
    }
    const result = await this.executor.query<OutboxRow>(
      SELECT_PENDING_OUTBOX_SQL,
      [limit],
    );
    return result.rows.map(mapOutboxRow);
  }
}