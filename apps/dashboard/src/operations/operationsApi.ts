/**
 * CX-062 / R-703: typisierter, rein lesender Dashboard-Client fuer
 * GET /v1/admin/operations aus CX-061.
 *
 * Der Client nutzt ausschliesslich den vorhandenen same-origin-Transport der
 * Admin-Client-Abstraktion. Er sendet nur GET, loest nie eine Backup-Pruefung
 * aus und veraendert die Antwort nicht: null bleibt "unbekannt", eine
 * fehlende Verfuegbarkeit bleibt eine fehlende Verfuegbarkeit.
 */
import type { ApiTransport, FetchLike } from "../admin/adminApi";
import { AdminApiError, createApiTransport } from "../admin/adminApi";

/** Relativer Pfad zur vorhandenen lesenden Betriebsroute (CX-061). */
export const OPERATIONS_API_PATH = "/admin/operations";

export type OperationsReadinessStatus = "ready" | "not_ready" | "unknown";

export interface OperationsReadiness {
  readonly status: OperationsReadinessStatus;
  readonly checkedAt: string;
}

export interface OperationsAlarmItem {
  readonly id: string;
  readonly at: string | null;
  readonly action: string;
  readonly episodeId: string | null;
  readonly resourceId: string | null;
  readonly errorCode: string | null;
  readonly resolvedAt: string | null;
  readonly unknownFields: readonly string[];
}

export interface OperationsAlarms {
  readonly available: boolean;
  readonly reason: string | null;
  readonly items: readonly OperationsAlarmItem[];
}

export interface OperationsBackupChecks {
  readonly restore: boolean | null;
  readonly content: boolean | null;
  readonly foreignKeys: boolean | null;
  readonly sequences: boolean | null;
  readonly cleanup: boolean | null;
}

export interface OperationsBackupProof {
  readonly eventId: string;
  readonly runId: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly status: string | null;
  readonly archiveSha256: string | null;
  readonly checks: OperationsBackupChecks;
  readonly errorCode: string | null;
  readonly unknownFields: readonly string[];
}

export interface OperationsLastBackupCheck {
  readonly available: boolean;
  readonly reason: string | null;
  readonly proof: OperationsBackupProof | null;
}

export interface OperationsOverview {
  readonly generatedAt: string;
  readonly readiness: OperationsReadiness;
  readonly alarms: OperationsAlarms;
  readonly lastBackupCheck: OperationsLastBackupCheck;
}

export interface OperationsRequestOptions {
  /** Schuetzt eine neuere Anfrage vor einer verspaeteten 401. */
  readonly isCurrent?: () => boolean;
}

export interface OperationsClient {
  getOperations(options?: OperationsRequestOptions): Promise<OperationsOverview>;
}

export interface OperationsClientOptions {
  /** Vorhandener Transport; ohne Angabe wird die gemeinsame Abstraktion gebaut. */
  readonly transport?: ApiTransport;
  readonly fetchImpl?: FetchLike;
  readonly baseUrl?: string;
  /** Wird ausschliesslich bei einer 401 der geschuetzten Route aufgerufen. */
  readonly onUnauthorized?: () => void;
}

const INVALID_RESPONSE_MESSAGE = "Die Antwort des Servers war ungültig.";

function invalidResponse(): AdminApiError {
  return new AdminApiError("invalid_response", INVALID_RESPONSE_MESSAGE);
}

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidResponse();
  }
  return value as Record<string, unknown>;
}

function requiredString(
  source: Record<string, unknown>,
  key: string,
): string {
  const value = source[key];
  if (typeof value !== "string") {
    throw invalidResponse();
  }
  return value;
}

function nullableString(
  source: Record<string, unknown>,
  key: string,
): string | null {
  if (!(key in source)) {
    return null;
  }
  const value = source[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw invalidResponse();
  }
  return value;
}

function requiredBoolean(
  source: Record<string, unknown>,
  key: string,
): boolean {
  const value = source[key];
  if (typeof value !== "boolean") {
    throw invalidResponse();
  }
  return value;
}

function nullableBoolean(
  source: Record<string, unknown>,
  key: string,
): boolean | null {
  if (!(key in source)) {
    return null;
  }
  const value = source[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "boolean") {
    throw invalidResponse();
  }
  return value;
}

function nullableNumber(
  source: Record<string, unknown>,
  key: string,
): number | null {
  if (!(key in source)) {
    return null;
  }
  const value = source[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidResponse();
  }
  return value;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw invalidResponse();
  }
  return value.map((entry) => {
    if (typeof entry !== "string") {
      throw invalidResponse();
    }
    return entry;
  });
}

function parseReadiness(value: unknown): OperationsReadiness {
  const body = recordOf(value);
  const status = requiredString(body, "status");
  if (status !== "ready" && status !== "not_ready" && status !== "unknown") {
    throw invalidResponse();
  }
  return {
    status,
    checkedAt: requiredString(body, "checked_at"),
  };
}

function parseAlarmItem(value: unknown): OperationsAlarmItem {
  const body = recordOf(value);
  return {
    id: requiredString(body, "id"),
    at: nullableString(body, "at"),
    action: requiredString(body, "action"),
    episodeId: nullableString(body, "episode_id"),
    resourceId: nullableString(body, "resource_id"),
    errorCode: nullableString(body, "error_code"),
    resolvedAt: nullableString(body, "resolved_at"),
    unknownFields: stringList(body.unknown_fields ?? []),
  };
}

function parseAlarms(value: unknown): OperationsAlarms {
  const body = recordOf(value);
  if (!Array.isArray(body.items)) {
    throw invalidResponse();
  }
  return {
    available: requiredBoolean(body, "available"),
    reason: nullableString(body, "reason"),
    items: body.items.map(parseAlarmItem),
  };
}

function parseChecks(value: unknown): OperationsBackupChecks {
  const body = recordOf(value);
  return {
    restore: nullableBoolean(body, "restore"),
    content: nullableBoolean(body, "content"),
    foreignKeys: nullableBoolean(body, "foreign_keys"),
    sequences: nullableBoolean(body, "sequences"),
    cleanup: nullableBoolean(body, "cleanup"),
  };
}

function parseBackupProof(value: unknown): OperationsBackupProof {
  const body = recordOf(value);
  return {
    eventId: requiredString(body, "event_id"),
    runId: nullableString(body, "run_id"),
    startedAt: nullableString(body, "started_at"),
    finishedAt: nullableString(body, "finished_at"),
    durationMs: nullableNumber(body, "duration_ms"),
    status: nullableString(body, "status"),
    archiveSha256: nullableString(body, "archive_sha256"),
    checks: parseChecks(body.checks),
    errorCode: nullableString(body, "error_code"),
    unknownFields: stringList(body.unknown_fields ?? []),
  };
}

function parseLastBackupCheck(value: unknown): OperationsLastBackupCheck {
  const body = recordOf(value);
  const proofValue = body.proof;
  const proof =
    proofValue === null || proofValue === undefined
      ? null
      : parseBackupProof(proofValue);
  return {
    available: requiredBoolean(body, "available"),
    reason: nullableString(body, "reason"),
    proof,
  };
}

/** Prueft die Antwortstruktur, ohne Werte umzudeuten. */
export function parseOperationsOverview(value: unknown): OperationsOverview {
  const body = recordOf(value);
  return {
    generatedAt: requiredString(body, "generated_at"),
    readiness: parseReadiness(body.readiness),
    alarms: parseAlarms(body.alarms),
    lastBackupCheck: parseLastBackupCheck(body.last_backup_check),
  };
}

export function createOperationsClient(
  options: OperationsClientOptions = {},
): OperationsClient {
  const transport =
    options.transport ??
    createApiTransport({
      fetchImpl: options.fetchImpl,
      baseUrl: options.baseUrl,
      onUnauthorized: options.onUnauthorized,
    });

  return {
    async getOperations(
      request: OperationsRequestOptions = {},
    ): Promise<OperationsOverview> {
      // Ausschliesslich lesend: GET auf die vorhandene Route. Es gibt hier
      // bewusst keinen POST-Zweig und keine Backup-Pruefung.
      return transport.json(
        OPERATIONS_API_PATH,
        {
          method: "GET",
          protectedOperation: true,
          ...(request.isCurrent === undefined
            ? {}
            : { isCurrent: request.isCurrent }),
        },
        parseOperationsOverview,
      );
    },
  };
}
