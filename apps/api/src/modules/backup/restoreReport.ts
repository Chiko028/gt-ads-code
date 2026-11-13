import type { RestoreErrorCode, VerifyRestoreResult } from "./verifyRestore.js";

/**
 * Seiteneffektfreier Berichtsadapter fuer Restore-Nachweise (CX-019).
 *
 * Der Adapter startet selbst keinen Dump-/Restore-Lauf und kennt weder
 * Verbindungen noch Prozesse. Er nimmt ausschliesslich bereits erhobene
 * Ergebnisse entgegen und bildet daraus einen festen, geheimnisfreien
 * JSON-Nachweis. Zusaetzliche Eingabefelder werden nie uebernommen.
 */

export const RESTORE_REPORT_SCHEMA_VERSION = 1 as const;

/** Feste, geheimnisfreie Fehlercodes des Berichts. */
export type RestoreReportErrorCode =
  | "invalid_metadata"
  | "unknown_error"
  | RestoreErrorCode;

/**
 * Tatsaechlich erhobene Pruefergebnisse.
 *
 * Die Metadatenfelder entsprechen den vorhandenen Ergebnissen aus
 * verifyRestore (artifactSha256, startedAt, restoreDurationMs). checks
 * enthaelt ausschliesslich die benannten Pflichtpruefungen.
 */
export interface RestoreReportInput
  extends Pick<VerifyRestoreResult, "artifactSha256" | "startedAt" | "restoreDurationMs"> {
  /** UTC-Zeitpunkt des Prueflaufs, z. B. VerifyRestoreResult.startedAt. */
  startedAt: string;
  /** Gemessene, nichtnegative Dauer in Millisekunden. */
  restoreDurationMs: number;
  /** SHA-256 des tatsaechlich geprueften Archivs. */
  artifactSha256: string;
  /** Benannte Pruefergebnisse; fehlende Werte gelten nie als bestanden. */
  checks: {
    restore: unknown;
    content: unknown;
    foreignKeys: unknown;
    sequences: unknown;
    cleanup: unknown;
  };
  /** Tatsaechlich gelieferte Werkzeugversionen; fehlende werden "unknown". */
  toolVersions?: {
    pgDump?: unknown;
    pgRestore?: unknown;
  };
  /** Fehler des Laufs; nur ein fester Code, nie die Rohdaten, wird uebernommen. */
  error?: unknown;
  /** Vom Aufrufer behaupteter Erfolg; wird bewusst nicht ausgewertet. */
  success?: unknown;
}

export interface RestoreReportChecks {
  restore: boolean;
  content: boolean;
  foreignKeys: boolean;
  sequences: boolean;
  cleanup: boolean;
}

export interface RestoreReportToolVersions {
  pgDump: string;
  pgRestore: string;
}

/** Feste Ausgabefeldliste des JSON-Nachweises. */
export interface RestoreReport {
  schemaVersion: typeof RESTORE_REPORT_SCHEMA_VERSION;
  checkedAt: string | null;
  durationMs: number | null;
  archiveSha256: string | null;
  toolVersions: RestoreReportToolVersions;
  checks: RestoreReportChecks;
  success: boolean;
  errorCode: RestoreReportErrorCode | null;
}

const KNOWN_RESTORE_ERROR_CODES = [
  "invalid_options",
  "invalid_environment",
  "invalid_artifact",
  "artifact_integrity_failed",
  "invalid_connection",
  "invalid_timeout",
  "aborted",
  "source_connection_failed",
  "database_create_failed",
  "pg_restore_missing",
  "pg_restore_failed",
  "timeout",
  "target_connection_failed",
  "verification_failed",
  "cleanup_failed",
  "internal_error",
] as const satisfies readonly RestoreErrorCode[];

const KNOWN_ERROR_CODE_SET: ReadonlySet<string> = new Set(
  KNOWN_RESTORE_ERROR_CODES,
);

const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/;
const UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const TOOL_VERSION_MAX_LENGTH = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCheckedAt(value: unknown): string | null {
  if (typeof value !== "string" || !UTC_TIMESTAMP_PATTERN.test(value)) {
    return null;
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    return null;
  }
  return new Date(milliseconds).toISOString();
}

function normalizeDuration(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

function normalizeSha256(value: unknown): string | null {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    return null;
  }
  return value.toLowerCase();
}

function normalizeToolVersion(value: unknown): string {
  if (typeof value !== "string") {
    return "unknown";
  }
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized === "") {
    return "unknown";
  }
  return normalized.slice(0, TOOL_VERSION_MAX_LENGTH);
}

function readChecks(value: unknown): RestoreReportChecks {
  const source = isRecord(value) ? value : {};
  return {
    restore: source.restore === true,
    content: source.content === true,
    foreignKeys: source.foreignKeys === true,
    sequences: source.sequences === true,
    cleanup: source.cleanup === true,
  };
}

function readToolVersions(value: unknown): RestoreReportToolVersions {
  const source = isRecord(value) ? value : {};
  return {
    pgDump: normalizeToolVersion(source.pgDump),
    pgRestore: normalizeToolVersion(source.pgRestore),
  };
}

function readErrorCode(value: unknown): RestoreReportErrorCode | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    isRecord(value) &&
    typeof value.code === "string" &&
    KNOWN_ERROR_CODE_SET.has(value.code)
  ) {
    return value.code as RestoreErrorCode;
  }
  // Unbekannte Fehler werden ausschliesslich durch diesen festen Code
  // dargestellt; Meldung, stderr und sonstige Details werden verworfen.
  return "unknown_error";
}

/**
 * Bildet einen festen JSON-Nachweis aus bereits erhobenen Pruefergebnissen.
 *
 * Erfolg ist nur moeglich, wenn alle fuenf benannten Pruefungen ausdruecklich
 * true sind, die Pflichtmetadaten gueltig sind und kein Fehler vorliegt. Ein
 * vom Aufrufer mitgeliefertes success wird nicht beruecksichtigt.
 */
export function buildRestoreReport(input: RestoreReportInput): RestoreReport {
  const source: Record<string, unknown> = isRecord(input) ? input : {};

  const checkedAt = normalizeCheckedAt(source.startedAt);
  const durationMs = normalizeDuration(source.restoreDurationMs);
  const archiveSha256 = normalizeSha256(source.artifactSha256);
  const checks = readChecks(source.checks);
  const toolVersions = readToolVersions(source.toolVersions);

  const metadataValid =
    checkedAt !== null && durationMs !== null && archiveSha256 !== null;

  let errorCode: RestoreReportErrorCode | null = null;
  if (!metadataValid) {
    errorCode = "invalid_metadata";
  } else {
    errorCode = readErrorCode(source.error);
  }

  const success =
    metadataValid &&
    errorCode === null &&
    checks.restore &&
    checks.content &&
    checks.foreignKeys &&
    checks.sequences &&
    checks.cleanup;

  return {
    schemaVersion: RESTORE_REPORT_SCHEMA_VERSION,
    checkedAt,
    durationMs,
    archiveSha256,
    toolVersions,
    checks,
    success,
    errorCode,
  };
}

/** Serialisiert ausschliesslich den festen Nachweis als JSON. */
export function serializeRestoreReport(input: RestoreReportInput): string {
  return JSON.stringify(buildRestoreReport(input));
}
