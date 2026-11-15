/**
 * CX-061 / R-703: lesende Betriebsuebersicht.
 *
 * Die Route liest ausschliesslich vorhandene Daten:
 * - die bestehende Readiness-Pruefung ohne Alarmadapter (keine Episoden,
 *   keine Zustellung, keine Schreibvorgaenge),
 * - hoechstens 20 letzte technische Alarmereignisse aus dem vorhandenen
 *   Audit-/Ereignisprotokoll (CX-028-Namen),
 * - den letzten terminalen Backup-Nachweis aus demselben Protokoll.
 *
 * Eine Backup-Pruefung wird hier nie ausgeloest. Sortiert wird nach
 * Serverzeit und ID; fehlende oder unbekannte Werte bleiben ausdruecklich
 * als null bzw. unknown_fields sichtbar.
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  TECHNICAL_ALARM_OPENED_ACTION,
  TECHNICAL_ALARM_RESOLVED_ACTION,
} from "../modules/technicalAlarms/index.js";
import {
  READINESS_TIMEOUT_MS,
  withDeadline,
  type ReadinessProbe,
  type TimerScheduler,
} from "../modules/operations/readiness.js";
import { ApiError } from "./errors.js";
import { BACKUP_CHECK_COMPLETED_ACTION } from "./operationsBackupCheck.js";
import { isValidPrincipal } from "./principal.js";

const MAX_ALARM_EVENTS = 20;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type OverviewReadinessStatus = "ready" | "not_ready" | "unknown";

export interface OverviewAlarmItem {
  id: string;
  at: string | null;
  action: string;
  episode_id: string | null;
  resource_id: string | null;
  error_code: string | null;
  resolved_at: string | null;
  unknown_fields: string[];
}

export interface OverviewAlarms {
  available: boolean;
  reason: string | null;
  items: OverviewAlarmItem[];
}

export interface OverviewBackupProof {
  event_id: string;
  run_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  status: string | null;
  archive_sha256: string | null;
  checks: {
    restore: boolean | null;
    content: boolean | null;
    foreign_keys: boolean | null;
    sequences: boolean | null;
    cleanup: boolean | null;
  };
  error_code: string | null;
  unknown_fields: string[];
}

export interface OverviewLastBackupCheck {
  available: boolean;
  reason: string | null;
  proof: OverviewBackupProof | null;
}

export interface OperationsOverviewResponse {
  generated_at: string;
  readiness: {
    status: OverviewReadinessStatus;
    checked_at: string;
  };
  alarms: OverviewAlarms;
  last_backup_check: OverviewLastBackupCheck;
}

export interface OperationsOverviewRouteOptions {
  readonly pool: Pick<Pool, "query">;
  readonly readiness: ReadinessProbe;
  readonly readinessTimeoutMs?: number;
  readonly scheduler?: TimerScheduler;
  readonly now?: () => Date;
}

interface AuditRow {
  id: string;
  at: Date | string;
  action: string;
  details: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function shaOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.toLowerCase();
  return SHA256_PATTERN.test(normalized) ? normalized : null;
}

function missingFields(
  entries: ReadonlyArray<readonly [string, unknown]>,
): string[] {
  return entries.filter(([, value]) => value === null).map(([name]) => name);
}

function toAlarmItem(row: AuditRow): OverviewAlarmItem {
  const details = isRecord(row.details) ? row.details : {};
  const episodeId = textOrNull(details.episode_id);
  const resourceId = textOrNull(details.resource_id);
  const errorCode = textOrNull(details.error_code);
  const resolvedAt = isoOrNull(details.resolved_at);
  const unknown = missingFields([
    ["episode_id", episodeId],
    ["resource_id", resourceId],
    ["error_code", errorCode],
  ]);
  return {
    id: row.id,
    at: isoOrNull(row.at),
    action: row.action,
    episode_id: episodeId,
    resource_id: resourceId,
    error_code: errorCode,
    resolved_at: resolvedAt,
    unknown_fields: unknown,
  };
}

function toBackupProof(row: AuditRow): OverviewBackupProof {
  const details = isRecord(row.details) ? row.details : {};
  const checks = isRecord(details.checks) ? details.checks : {};
  const proof: OverviewBackupProof = {
    event_id: row.id,
    run_id: textOrNull(details.run_id),
    started_at: isoOrNull(details.started_at),
    finished_at: isoOrNull(details.finished_at),
    duration_ms: numberOrNull(details.duration_ms),
    status: textOrNull(details.status),
    archive_sha256: shaOrNull(details.archive_sha256),
    checks: {
      restore: boolOrNull(checks.restore),
      content: boolOrNull(checks.content),
      foreign_keys: boolOrNull(checks.foreign_keys),
      sequences: boolOrNull(checks.sequences),
      cleanup: boolOrNull(checks.cleanup),
    },
    error_code: textOrNull(details.error_code),
    unknown_fields: [],
  };
  proof.unknown_fields = missingFields([
    ["run_id", proof.run_id],
    ["started_at", proof.started_at],
    ["finished_at", proof.finished_at],
    ["duration_ms", proof.duration_ms],
    ["status", proof.status],
    ["archive_sha256", proof.archive_sha256],
    ["checks.restore", proof.checks.restore],
    ["checks.content", proof.checks.content],
    ["checks.foreign_keys", proof.checks.foreign_keys],
    ["checks.sequences", proof.checks.sequences],
    ["checks.cleanup", proof.checks.cleanup],
  ]);
  return proof;
}

async function readReadiness(
  options: OperationsOverviewRouteOptions,
): Promise<{ status: OverviewReadinessStatus; checked_at: string }> {
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  try {
    await withDeadline(options.readiness.check(), {
      timeoutMs: options.readinessTimeoutMs ?? READINESS_TIMEOUT_MS,
      ...(options.scheduler === undefined
        ? {}
        : { scheduler: options.scheduler }),
    });
    return { status: "ready", checked_at: checkedAt };
  } catch (error: unknown) {
    const timedOut =
      error instanceof Error && error.name === "ReadinessTimeoutError";
    return {
      status: timedOut ? "unknown" : "not_ready",
      checked_at: checkedAt,
    };
  }
}

async function readAlarms(
  options: OperationsOverviewRouteOptions,
): Promise<OverviewAlarms> {
  try {
    const result = await options.pool.query<AuditRow>(
      [
        "select id::text as id, at, action, details",
        "  from audit_events",
        " where action in ($1, $2)",
        " order by at desc, id desc",
        " limit " + String(MAX_ALARM_EVENTS),
      ].join("\n"),
      [TECHNICAL_ALARM_OPENED_ACTION, TECHNICAL_ALARM_RESOLVED_ACTION],
    );
    return {
      available: true,
      reason: null,
      items: result.rows.map(toAlarmItem),
    };
  } catch {
    return {
      available: false,
      reason: "alarm_log_unavailable",
      items: [],
    };
  }
}

async function readLastBackupCheck(
  options: OperationsOverviewRouteOptions,
): Promise<OverviewLastBackupCheck> {
  let rows: AuditRow[];
  try {
    const result = await options.pool.query<AuditRow>(
      [
        "select id::text as id, at, action, details",
        "  from audit_events",
        " where action = $1",
        " order by at desc, id desc",
        " limit 1",
      ].join("\n"),
      [BACKUP_CHECK_COMPLETED_ACTION],
    );
    rows = result.rows;
  } catch {
    return {
      available: false,
      reason: "backup_log_unavailable",
      proof: null,
    };
  }

  const row = rows[0];
  if (row === undefined) {
    return {
      available: false,
      reason: "no_backup_check",
      proof: null,
    };
  }
  if (!isRecord(row.details)) {
    return {
      available: false,
      reason: "invalid_backup_check_record",
      proof: null,
    };
  }
  return {
    available: true,
    reason: null,
    proof: toBackupProof(row),
  };
}

/**
 * Registriert GET /v1/admin/operations. Die Route ist im Rechtekern als
 * menschliche Aktion operations.read klassifiziert; nur Admin besitzt sie.
 */
export function registerOperationsOverviewRoutes(
  app: FastifyInstance,
  options: OperationsOverviewRouteOptions,
): void {
  app.get("/v1/admin/operations", async (request, reply) => {
    const principal = request.accessPrincipal;
    if (!isValidPrincipal(principal) || principal.role !== "Admin") {
      throw ApiError.forbidden();
    }

    const readiness = await readReadiness(options);
    const alarms = await readAlarms(options);
    const lastBackupCheck = await readLastBackupCheck(options);

    const body: OperationsOverviewResponse = {
      generated_at: (options.now ?? (() => new Date()))().toISOString(),
      readiness,
      alarms,
      last_backup_check: lastBackupCheck,
    };

    reply.header("Cache-Control", "no-store");
    return body;
  });
}
