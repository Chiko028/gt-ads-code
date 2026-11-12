import { canonicalize } from "./canonical.js";
import { RollupInputError, RollupStorageError, TelemetryRollupError } from "./errors.js";
import { computeInputFingerprint } from "./fingerprint.js";
import { loadDaySnapshot } from "./snapshot.js";
import type {
  RetentionCandidate,
  RetentionDayAssessment,
  RetentionDayAssessmentInput,
  RetentionPreview,
  RetentionPreviewOptions,
  RetentionRollupRef,
  RetentionRule,
  RetentionWithheldDay,
  RetentionWithholdReason,
  RollupSqlClient,
  RollupSqlPool,
} from "./types.js";
import { ROLLUP_ALGORITHM_VERSION } from "./types.js";
import {
  formatLocalDate,
  parseLocalDate,
  zonedDayRange,
  zonedDayStartMs,
} from "../telemetryEvaluation/timeZone.js";
import { assertIanaTimeZone } from "../telemetryEvaluation/timeZone.js";

const DAY_MS = 86_400_000;

const SELECT_RETENTION_ROLLUPS_SQL = [
  "select id::text as id,",
  "       device_id::text as device_id,",
  "       local_date::text as local_date,",
  "       time_zone,",
  "       policy_version,",
  "       algorithm_version,",
  "       revision,",
  "       evaluation_time,",
  "       day_start,",
  "       day_end,",
  "       policy_canonical,",
  "       input_fingerprint",
  "  from telemetry_daily_rollups",
  " where time_zone = $1",
  "   and algorithm_version = $2",
  " order by device_id, local_date, policy_version",
].join("\n");

interface RetentionRollupRow extends Record<string, unknown> {
  id: string;
  device_id: string;
  local_date: string;
  time_zone: string;
  policy_version: string;
  algorithm_version: string;
  revision: number | string;
  evaluation_time: Date | string;
  day_start: Date | string;
  day_end: Date | string;
  policy_canonical: unknown;
  input_fingerprint: string;
}

function isConnectable(
  client: RollupSqlClient | RollupSqlPool,
): client is RollupSqlPool {
  return typeof (client as RollupSqlPool).connect === "function";
}

function toMs(value: Date | string): number {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new RollupStorageError("Gespeicherter Zeitpunkt ist ungueltig.");
  }
  return ms;
}

function toNumber(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new RollupStorageError("Gespeicherte Zahl ist ungueltig.");
  }
  return parsed;
}

function parseEvaluationTime(value: unknown): number {
  if (!(typeof value === "string" || value instanceof Date)) {
    throw new RollupInputError("evaluationTime muss ein Zeitpunkt sein.");
  }
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new RollupInputError("evaluationTime ist kein gueltiger Zeitpunkt.");
  }
  return ms;
}

/**
 * Explizite, positive Retention-Regel. Es gibt keinen Default:
 * ohne Regel bleibt die Vorschau leer.
 */
export function validateRetentionRule(value: unknown): RetentionRule {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RollupInputError("Retention-Regel muss ein Objekt sein.");
  }
  const record = value as Record<string, unknown>;
  const ruleVersion = record.ruleVersion;
  if (typeof ruleVersion !== "string" || ruleVersion.trim() === "") {
    throw new RollupInputError("Retention-Regel braucht eine ruleVersion.");
  }
  const rawRetentionDays = record.rawRetentionDays;
  if (
    typeof rawRetentionDays !== "number" ||
    !Number.isSafeInteger(rawRetentionDays) ||
    rawRetentionDays <= 0
  ) {
    throw new RollupInputError(
      "rawRetentionDays muss eine positive Ganzzahl sein.",
    );
  }
  return { ruleVersion: ruleVersion.trim(), rawRetentionDays };
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached !== undefined) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

function localDateAt(instantMs: number, timeZone: string): {
  year: number;
  month: number;
  day: number;
} {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs));
  let year = 0;
  let month = 0;
  let day = 0;
  for (const part of parts) {
    if (part.type === "year") {
      year = Number(part.value);
    } else if (part.type === "month") {
      month = Number(part.value);
    } else if (part.type === "day") {
      day = Number(part.value);
    }
  }
  return { year, month, day };
}

function shiftCalendarDays(
  date: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number } {
  const shifted = new Date(
    Date.UTC(date.year, date.month - 1, date.day) + days * DAY_MS,
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function uniqueReasons(
  reasons: readonly RetentionWithholdReason[],
): RetentionWithholdReason[] {
  const order: RetentionWithholdReason[] = [
    "day_not_completed",
    "inside_retention_horizon",
    "rollup_before_day_end",
    "rollup_day_mismatch",
    "no_raw_data",
    "raw_event_inside_horizon",
    "raw_received_inside_horizon",
    "raw_fingerprint_mismatch",
  ];
  const present = new Set(reasons);
  return order.filter((reason) => present.has(reason));
}

/**
 * Reine Bewertung eines lokalen Tages. Es wird nichts geloescht und nichts
 * geschrieben; das Ergebnis ist die Grundlage der Vorschau.
 */
export function assessRetentionDay(
  input: RetentionDayAssessmentInput,
): RetentionDayAssessment {
  const reasons: RetentionWithholdReason[] = [];

  if (
    input.rollupDayStartMs !== input.dayStartMs ||
    input.rollupDayEndMs !== input.dayEndMs
  ) {
    reasons.push("rollup_day_mismatch");
  }
  if (input.dayEndMs > input.evaluationTimeMs) {
    reasons.push("day_not_completed");
  }
  if (input.dayEndMs > input.horizonStartMs) {
    reasons.push("inside_retention_horizon");
  }
  if (input.rollupEvaluationTimeMs < input.dayEndMs) {
    reasons.push("rollup_before_day_end");
  }
  if (input.rawObservationCount === 0) {
    reasons.push("no_raw_data");
  }
  // Maximalwerte reichen: "alle Ereignisse vor dem Horizont" ist genau dann
  // erfuellt, wenn auch das jeweils spaetzte Ereignis davor liegt.
  if (
    input.latestRawOccurredAtMs !== null &&
    input.latestRawOccurredAtMs >= input.horizonStartMs
  ) {
    reasons.push("raw_event_inside_horizon");
  }
  if (
    input.latestRawReceivedAtMs !== null &&
    input.latestRawReceivedAtMs >= input.horizonStartMs
  ) {
    reasons.push("raw_received_inside_horizon");
  }
  if (!input.fingerprintMatches) {
    reasons.push("raw_fingerprint_mismatch");
  }

  const unique = uniqueReasons(reasons);
  return { eligible: unique.length === 0, reasons: unique };
}

interface GroupState {
  deviceId: string;
  localDate: string;
  timeZone: string;
  rollups: RetentionRollupRow[];
}

function groupKey(row: RetentionRollupRow): string {
  return row.device_id + "|" + row.local_date;
}

/**
 * Read-only Retention-Vorschau. Der Aufruf oeffnet eine wiederholbare
 * Lesetransaktion und liefert ausschliesslich Kandidaten und Gruende.
 * Es gibt weder DELETE noch Partition-Drop, Scheduler oder Regelaktivierung.
 */
export async function previewRetention(
  options: RetentionPreviewOptions,
): Promise<RetentionPreview> {
  const timeZone = assertIanaTimeZone(options.timeZone);
  const evaluationMs = parseEvaluationTime(options.evaluationTime);
  const evaluationTime = new Date(evaluationMs).toISOString();
  const algorithmVersion =
    options.algorithmVersion ?? ROLLUP_ALGORITHM_VERSION;

  if (options.rule === undefined || options.rule === null) {
    // Keine aktive Regel: keine Kandidaten, kein Datenbankzugriff.
    return {
      rule: null,
      timeZone,
      evaluationTime,
      horizonStart: null,
      candidates: [],
      withheld: [],
    };
  }

  const rule = validateRetentionRule(options.rule);
  const horizonDate = shiftCalendarDays(
    localDateAt(evaluationMs, timeZone),
    -rule.rawRetentionDays,
  );
  const horizonStartMs = zonedDayStartMs(horizonDate, timeZone);

  let connection: RollupSqlClient;
  let release: () => void;
  try {
    if (isConnectable(options.client)) {
      const checkedOut = await options.client.connect();
      connection = checkedOut;
      release = () => checkedOut.release();
    } else {
      connection = options.client;
      release = () => undefined;
    }
  } catch (error) {
    throw new RollupStorageError(
      "PostgreSQL-Verbindung fuer Retention-Vorschau fehlgeschlagen.",
      { cause: error },
    );
  }

  let inTransaction = false;
  try {
    await connection.query("begin isolation level repeatable read read only");
    inTransaction = true;

    const result = await connection.query<RetentionRollupRow>(
      SELECT_RETENTION_ROLLUPS_SQL,
      [timeZone, algorithmVersion],
    );

    const groups = new Map<string, GroupState>();
    for (const row of result.rows) {
      const key = groupKey(row);
      const existing = groups.get(key);
      if (existing === undefined) {
        groups.set(key, {
          deviceId: row.device_id,
          localDate: row.local_date,
          timeZone: row.time_zone,
          rollups: [row],
        });
      } else {
        existing.rollups.push(row);
      }
    }

    const candidates: RetentionCandidate[] = [];
    const withheld: RetentionWithheldDay[] = [];

    for (const group of groups.values()) {
      const dateParts = parseLocalDate(group.localDate);
      const localDate = formatLocalDate(dateParts);
      const { startMs, endMs } = zonedDayRange(dateParts, group.timeZone);
      const snapshot = await loadDaySnapshot(
        connection,
        group.deviceId,
        startMs,
        endMs,
      );

      const latestOccurred = snapshot.observations.reduce<number | null>(
        (latest, observation) => {
          const ms = Date.parse(observation.occurredAt);
          return latest === null || ms > latest ? ms : latest;
        },
        null,
      );
      const latestReceived = snapshot.observations.reduce<number | null>(
        (latest, observation) => {
          const ms = Date.parse(observation.receivedAt);
          return latest === null || ms > latest ? ms : latest;
        },
        null,
      );

      const reasons: RetentionWithholdReason[] = [];
      const refs: RetentionRollupRef[] = [];
      for (const row of group.rollups) {
        const policyCanonical = canonicalize(row.policy_canonical);
        const fingerprint = computeInputFingerprint({
          deviceId: group.deviceId,
          localDate,
          timeZone: group.timeZone,
          policyCanonical,
          algorithmVersion: row.algorithm_version,
          dayStartMs: startMs,
          dayEndMs: endMs,
          priorObservation: snapshot.priorObservation,
          observations: snapshot.observations,
        });
        const assessment = assessRetentionDay({
          dayStartMs: startMs,
          dayEndMs: endMs,
          evaluationTimeMs: evaluationMs,
          horizonStartMs,
          rollupEvaluationTimeMs: toMs(row.evaluation_time),
          rollupDayStartMs: toMs(row.day_start),
          rollupDayEndMs: toMs(row.day_end),
          rawObservationCount: snapshot.observations.length,
          latestRawOccurredAtMs: latestOccurred,
          latestRawReceivedAtMs: latestReceived,
          fingerprintMatches: fingerprint === row.input_fingerprint,
        });
        reasons.push(...assessment.reasons);
        refs.push({
          policyVersion: row.policy_version,
          revision: toNumber(row.revision),
          inputFingerprint: row.input_fingerprint,
        });
      }

      const unique = uniqueReasons(reasons);
      if (unique.length === 0) {
        candidates.push({
          deviceId: group.deviceId,
          localDate,
          timeZone: group.timeZone,
          dayStart: new Date(startMs).toISOString(),
          dayEnd: new Date(endMs).toISOString(),
          rollups: refs,
        });
      } else {
        withheld.push({
          deviceId: group.deviceId,
          localDate,
          timeZone: group.timeZone,
          policyVersions: group.rollups.map((row) => row.policy_version),
          reasons: unique,
        });
      }
    }

    await connection.query("commit");
    inTransaction = false;

    return {
      rule,
      timeZone,
      evaluationTime,
      horizonStart: new Date(horizonStartMs).toISOString(),
      candidates,
      withheld,
    };
  } catch (error) {
    if (inTransaction) {
      try {
        await connection.query("rollback");
      } catch {
        // Der urspruengliche Fehler bleibt massgeblich.
      }
    }
    if (error instanceof TelemetryRollupError) {
      throw error;
    }
    throw new RollupStorageError(
      "Retention-Vorschau fehlgeschlagen; es wurde nichts veraendert.",
      { cause: error },
    );
  } finally {
    release();
  }
}
