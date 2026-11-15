/**
 * CX-061 / R-702: duenne HTTP-Komposition des vorhandenen CX-023-
 * Restore-Nachweises.
 *
 * Bewusste Grenzen:
 * - Der Client liefert ausschliesslich ein leeres JSON-Objekt. Verbindungen,
 *   Archivpfade, Zieldatenbanken und Prozessargumente kommen nie aus der
 *   Anfrage, sondern nur aus der serverseitigen Testkonfiguration.
 * - Der Nachweis selbst bleibt CX-023 (verifyRestore): Isolation, Zeitlimit,
 *   Inhaltspruefung und Bereinigung werden unveraendert genutzt.
 * - Es gibt keine zweite Ergebnistabelle. Der autorisierte Start und das
 *   terminale Ergebnis landen im vorhandenen Audit-/Ereignisprotokoll
 *   (audit_events), das bereits von CX-028 genutzt wird.
 * - Ein Start ohne persistierbaren Startaudit beginnt keinen Restore.
 * - Innerhalb der Einzelprozess-App verhindert eine in finally freigegebene
 *   Sperre parallele Laeufe; weitere Anfragen erhalten 409.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import {
  AuditService,
  type AuditRecordInput,
} from "../modules/audit/service.js";
import type { DumpArtifact } from "../modules/backup/createDump.js";
import {
  verifyRestore,
  type LocalRestoreConnection,
  type RestoreVerificationContext,
  type VerifyRestoreResult,
} from "../modules/backup/verifyRestore.js";
import { assertSameOriginForWrite } from "./authorization.js";
import { ApiError } from "./errors.js";
import { isValidPrincipal, type PrincipalResolver } from "./principal.js";

/** Explizite Eintraege des Auditkatalogs dieser Komposition. */
export const BACKUP_CHECK_STARTED_ACTION = "operations.backup_check.started";
export const BACKUP_CHECK_COMPLETED_ACTION =
  "operations.backup_check.completed";
export const BACKUP_CHECK_TARGET_TYPE = "backup_check";

export const BACKUP_CHECK_AUDIT_ACTIONS = Object.freeze({
  started: BACKUP_CHECK_STARTED_ACTION,
  completed: BACKUP_CHECK_COMPLETED_ACTION,
});

/** Feste, geheimnisfreie Fehlercodes dieser Komposition. */
export const BACKUP_CHECK_UNAVAILABLE_ERROR = "backup_check_unavailable";
export const BACKUP_CHECK_IN_PROGRESS_ERROR = "backup_check_in_progress";
export const BACKUP_CHECK_START_AUDIT_ERROR = "start_audit_failed";
export const BACKUP_CHECK_RESULT_PERSISTENCE_ERROR =
  "result_persistence_failed";
export const BACKUP_CHECK_ALARM_REPORT_ERROR = "alarm_report_failed";

export type BackupCheckStatus = "succeeded" | "failed" | "incomplete";

/** Bereinigte SQL-Pruefergebnisse der Inhaltspruefung. */
export interface BackupCheckSqlChecks {
  content: boolean;
  foreignKeys: boolean;
  sequences: boolean;
}

/**
 * Serverseitig vorgegebene Testkonfiguration. Sie wird beim App-Aufbau
 * injiziert und ist niemals Teil einer Anfrage.
 */
export interface BackupCheckTestConfiguration {
  readonly environment: "test";
  readonly connection: LocalRestoreConnection;
  readonly artifact: DumpArtifact;
  /** Fuehrt die SQL-Inhaltspruefung gegen die restaurierte Zieldatenbank aus. */
  readonly verifyContent: (
    context: RestoreVerificationContext,
  ) => Promise<BackupCheckSqlChecks>;
  readonly timeoutMs?: number;
}

/** Minimale Schnittstelle des CX-060-Adapters. */
export interface BackupCheckAlarmPort {
  processBackupResult(raw: unknown): Promise<{
    processed: boolean;
    ok: boolean;
  }>;
}

/** Minimale Schnittstelle des vorhandenen Audit-Service. */
export interface BackupCheckAuditPort {
  record(input: AuditRecordInput): Promise<void>;
}

export interface OperationsBackupCheckRouteOptions {
  readonly pool: Pick<Pool, "query">;
  readonly environment: string;
  readonly configuration: BackupCheckTestConfiguration | null;
  readonly resolvePrincipal: PrincipalResolver;
  /** CX-060; null kennzeichnet eine nicht verdrahtete Meldung. */
  readonly alarm: BackupCheckAlarmPort | null;
  readonly now?: () => Date;
  /** Nur fuer Tests: vorhandener Audit-Service mit kontrolliertem Fehler. */
  readonly audit?: BackupCheckAuditPort;
}

export interface BackupCheckChecks {
  restore: boolean;
  content: boolean;
  foreign_keys: boolean;
  sequences: boolean;
  cleanup: boolean;
}

/** Nur diese Felder sind Teil der Antwort und des Ereignisprotokolls. */
export interface BackupCheckResult {
  run_id: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  status: BackupCheckStatus;
  archive_sha256: string | null;
  checks: BackupCheckChecks;
  error_code: string | null;
}

interface TerminalDetails {
  run_id: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  status: BackupCheckStatus;
  archive_sha256: string | null;
  checks: BackupCheckChecks;
  error_code: string | null;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeSha256(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.toLowerCase();
  return SHA256_PATTERN.test(normalized) ? normalized : null;
}

function sanitizeErrorCode(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const code = value.trim();
  return ERROR_CODE_PATTERN.test(code) ? code : null;
}

function utcNow(now: () => Date): string {
  return now().toISOString();
}

function durationBetween(startedAt: string, finishedAt: string): number {
  const start = Date.parse(startedAt);
  const finish = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish)) {
    return 0;
  }
  return Math.max(0, Math.round(finish - start));
}

function assertEmptyClientInput(request: FastifyRequest): void {
  const query = request.query;
  if (isRecord(query) && Object.keys(query).length > 0) {
    throw ApiError.invalidRequest();
  }
  const body: unknown = request.body;
  if (!isRecord(body) || Object.keys(body).length > 0) {
    throw ApiError.invalidRequest();
  }
}

function sendError(
  reply: FastifyReply,
  request: FastifyRequest,
  statusCode: number,
  code: string,
  message: string,
): FastifyReply {
  reply.header("Cache-Control", "no-store");
  return reply
    .code(statusCode)
    .type("application/json; charset=utf-8")
    .send({ error: { code, message, request_id: request.id } });
}

function restoreCheckPassed(
  result: VerifyRestoreResult,
  verifierRan: boolean,
): boolean {
  if (verifierRan || result.verificationPassed) {
    return true;
  }
  if (
    result.restoreDurationMs > 0 &&
    (result.error?.code === "verification_failed" ||
      result.error?.code === "target_connection_failed" ||
      result.error?.code === "cleanup_failed")
  ) {
    return true;
  }
  return false;
}

function terminalDetails(
  runId: string,
  startedAt: string,
  finishedAt: string,
  status: BackupCheckStatus,
  archiveSha256: string | null,
  checks: BackupCheckChecks,
  errorCode: string | null,
): TerminalDetails {
  return {
    run_id: runId,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationBetween(startedAt, finishedAt),
    status,
    archive_sha256: archiveSha256,
    checks,
    error_code: errorCode,
  };
}

function toResult(details: TerminalDetails): BackupCheckResult {
  return { ...details };
}

/**
 * Registriert POST /v1/admin/operations/backup-check.
 *
 * Der Rechtekern klassifiziert die Route explizit als oeffentlich, weil der
 * vorhandene Audit-Schreibkatalog keine neue Route kennt. Genau wie die
 * bestehenden Sicherheitsrouten (CX-108/CX-109) prueft der Handler daher
 * Admin-Sitzung, Adminrolle und den vorhandenen Origin-Schreibschutz selbst.
 */
export function registerOperationsBackupCheckRoutes(
  app: FastifyInstance,
  options: OperationsBackupCheckRouteOptions,
): void {
  const audit: BackupCheckAuditPort =
    options.audit ??
    new AuditService({
      executor: options.pool,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  const now = options.now ?? (() => new Date());
  let inProgress = false;

  app.post(
    "/v1/admin/operations/backup-check",
    async (request, reply) => {
      // Vor Authentifizierung und vor jedem Prozessstart: derselbe
      // Origin-Schreibschutz wie im zentralen Rechtekern.
      assertSameOriginForWrite(request);

      // Die Sperre wird vor dem ersten await gesetzt, damit eine gleichzeitig
      // eintreffende zweite Startanfrage ohne weiteren Restore 409 erhaelt.
      // Sie wird in finally in jedem Fehlerfall freigegeben.
      if (inProgress) {
        return sendError(
          reply,
          request,
          409,
          BACKUP_CHECK_IN_PROGRESS_ERROR,
          "Ein Backup-Nachweis laeuft bereits.",
        );
      }
      inProgress = true;

      try {
        const principal = await options.resolvePrincipal(request);
        if (!isValidPrincipal(principal)) {
          throw ApiError.unauthorized();
        }
        if (principal.role !== "Admin") {
          throw ApiError.forbidden();
        }

        assertEmptyClientInput(request);

        if (options.environment !== "test" || options.configuration === null) {
          return sendError(
            reply,
            request,
            503,
            BACKUP_CHECK_UNAVAILABLE_ERROR,
            "Keine sichere Backup-Testkonfiguration verfuegbar.",
          );
        }

        const configuration = options.configuration;
        const runId = randomUUID();
        const startedAt = utcNow(now);
        try {
          await audit.record({
            actorType: "admin",
            actorId: principal.id,
            action: BACKUP_CHECK_STARTED_ACTION,
            targetType: BACKUP_CHECK_TARGET_TYPE,
            targetId: runId,
            details: {
              request_id: request.id,
              run_id: runId,
              started_at: startedAt,
            },
          });
        } catch {
          return sendError(
            reply,
            request,
            503,
            BACKUP_CHECK_START_AUDIT_ERROR,
            "Der Backup-Nachweis konnte nicht protokolliert gestartet werden.",
          );
        }

        const sqlChecks: BackupCheckSqlChecks = {
          content: false,
          foreignKeys: false,
          sequences: false,
        };
        let verifierRan = false;
        let result: VerifyRestoreResult;

        try {
          result = await verifyRestore({
            environment: "test",
            artifact: configuration.artifact,
            connection: configuration.connection,
            ...(configuration.timeoutMs === undefined
              ? {}
              : { timeoutMs: configuration.timeoutMs }),
            verifyContent: async (context) => {
              verifierRan = true;
              const checks = await configuration.verifyContent(context);
              sqlChecks.content = checks?.content === true;
              sqlChecks.foreignKeys = checks?.foreignKeys === true;
              sqlChecks.sequences = checks?.sequences === true;
              return (
                sqlChecks.content &&
                sqlChecks.foreignKeys &&
                sqlChecks.sequences
              );
            },
          });
        } catch {
          result = {
            success: false,
            artifactSha256: sanitizeSha256(configuration.artifact.sha256) ?? "",
            startedAt,
            restoreDurationMs: 0,
            verificationPassed: false,
            cleanupSucceeded: false,
            error: {
              code: "internal_error",
              message: "Der Restore-Nachweis ist unerwartet fehlgeschlagen",
            },
          };
        }

        const finishedAt = utcNow(now);
        const archiveSha256 =
          sanitizeSha256(result.artifactSha256) ??
          sanitizeSha256(configuration.artifact.sha256);
        const checks: BackupCheckChecks = {
          restore: restoreCheckPassed(result, verifierRan),
          content: sqlChecks.content,
          foreign_keys: sqlChecks.foreignKeys,
          sequences: sqlChecks.sequences,
          cleanup: result.cleanupSucceeded === true,
        };

        let status: BackupCheckStatus = result.success
          ? "succeeded"
          : "failed";
        let errorCode = result.success
          ? null
          : (sanitizeErrorCode(result.error?.code) ?? "internal_error");

        // CX-060 meldet das terminale Ergebnis. Ein Fehler der Meldung macht
        // aus einem bestandenen Restore keinen vollstaendigen Nachweis.
        let alarmReported = options.alarm !== null;
        if (options.alarm !== null) {
          try {
            await options.alarm.processBackupResult({
              success: result.success === true,
              startedAt: result.startedAt,
              artifactSha256: archiveSha256,
              restoreDurationMs: result.restoreDurationMs,
              verificationPassed: result.verificationPassed,
              cleanupSucceeded: result.cleanupSucceeded,
              ...(result.success
                ? {}
                : {
                    error: {
                      code: errorCode ?? "internal_error",
                      message: "Der Restore-Nachweis ist fehlgeschlagen",
                    },
                  }),
            });
          } catch {
            alarmReported = false;
          }
        }

        if (status === "succeeded" && !alarmReported) {
          status = "incomplete";
          errorCode = BACKUP_CHECK_ALARM_REPORT_ERROR;
        }

        const details = terminalDetails(
          runId,
          startedAt,
          finishedAt,
          status,
          archiveSha256,
          checks,
          errorCode,
        );

        // Terminales Ergebnis im vorhandenen Ereignisprotokoll. Schlaegt
        // diese Persistenz nach bestandenem Restore fehl, bleibt der
        // Gesamtnachweis ausdruecklich unvollstaendig.
        try {
          await audit.record({
            actorType: "admin",
            actorId: principal.id,
            action: BACKUP_CHECK_COMPLETED_ACTION,
            targetType: BACKUP_CHECK_TARGET_TYPE,
            targetId: runId,
            details: { ...details },
          });
        } catch {
          if (status === "succeeded") {
            details.status = "incomplete";
            details.error_code = BACKUP_CHECK_RESULT_PERSISTENCE_ERROR;
          }
        }

        reply.header("Cache-Control", "no-store");
        return reply
          .code(200)
          .type("application/json; charset=utf-8")
          .send(toResult(details));
      } finally {
        inProgress = false;
      }
    },
  );
}
