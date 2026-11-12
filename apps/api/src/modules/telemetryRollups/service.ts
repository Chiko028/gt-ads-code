import { canonicalize } from "./canonical.js";
import {
  RollupInputError,
  RollupPolicyConflictError,
  RollupStorageError,
  TelemetryRollupError,
} from "./errors.js";
import { computeInputFingerprint } from "./fingerprint.js";
import { loadDaySnapshot } from "./snapshot.js";
import type {
  DailyRollup,
  RebuildDayInput,
  RebuildDayResult,
  RollupServiceOptions,
  RollupSqlClient,
  RollupSqlPool,
} from "./types.js";
import { ROLLUP_ALGORITHM_VERSION } from "./types.js";
import { classifyDay } from "../telemetryEvaluation/classify.js";
import {
  EvaluationConfigError,
  EvaluationInputError,
} from "../telemetryEvaluation/errors.js";
import { validatePolicy } from "../telemetryEvaluation/policy.js";
import {
  assertIanaTimeZone,
  formatLocalDate,
  parseLocalDate,
  zonedDayRange,
} from "../telemetryEvaluation/timeZone.js";
import type { ClassificationKey } from "../telemetryEvaluation/types.js";
import { normalizeDeviceId } from "../telemetry/validation.js";

const LOCK_POLICY_SQL =
  "select pg_advisory_xact_lock(hashtextextended($1, 0)) as locked";
const LOCK_ROLLUP_SQL =
  "select pg_advisory_xact_lock(hashtextextended($1, 0)) as locked";

const SELECT_POLICY_CONTENT_SQL = [
  "select policy_canonical",
  "  from telemetry_daily_rollups",
  " where policy_version = $1",
].join("\n");

const SELECT_ROLLUP_SQL = [
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
  "       day_length_ms::text as day_length_ms,",
  "       classes,",
  "       coverage,",
  "       expected_playback_ms::text as expected_playback_ms,",
  "       expected_playback_reason,",
  "       policy_canonical,",
  "       input_fingerprint",
  "  from telemetry_daily_rollups",
  " where device_id = $1",
  "   and local_date = $2::date",
  "   and time_zone = $3",
  "   and policy_version = $4",
  "   and algorithm_version = $5",
  " for update",
].join("\n");

const INSERT_ROLLUP_SQL = [
  "insert into telemetry_daily_rollups",
  "  (device_id, local_date, time_zone, policy_version, algorithm_version,",
  "   revision, evaluation_time, day_start, day_end, day_length_ms,",
  "   classes, coverage, expected_playback_ms, expected_playback_reason,",
  "   policy_canonical, input_fingerprint, created_at, updated_at)",
  "values ($1, $2::date, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz,",
  "        $9::timestamptz, $10, $11::jsonb, $12::jsonb, $13, $14,",
  "        $15::jsonb, $16, now(), now())",
  "returning id::text as id, revision, evaluation_time, day_start, day_end,",
  "          day_length_ms::text as day_length_ms, classes, coverage,",
  "          expected_playback_ms::text as expected_playback_ms,",
  "          expected_playback_reason, policy_canonical, input_fingerprint",
].join("\n");

const UPDATE_ROLLUP_SQL = [
  "update telemetry_daily_rollups",
  "   set revision = $2,",
  "       evaluation_time = $3::timestamptz,",
  "       day_start = $4::timestamptz,",
  "       day_end = $5::timestamptz,",
  "       day_length_ms = $6,",
  "       classes = $7::jsonb,",
  "       coverage = $8::jsonb,",
  "       expected_playback_ms = $9,",
  "       expected_playback_reason = $10,",
  "       policy_canonical = $11::jsonb,",
  "       input_fingerprint = $12,",
  "       updated_at = now()",
  " where id = $1::bigint",
  "returning id::text as id, revision, evaluation_time, day_start, day_end,",
  "          day_length_ms::text as day_length_ms, classes, coverage,",
  "          expected_playback_ms::text as expected_playback_ms,",
  "          expected_playback_reason, policy_canonical, input_fingerprint",
].join("\n");

interface RollupRow extends Record<string, unknown> {
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
  day_length_ms: string;
  classes: Record<string, number>;
  coverage: Record<string, number>;
  expected_playback_ms: string | null;
  expected_playback_reason: string | null;
  policy_canonical: unknown;
  input_fingerprint: string;
}

interface ReturnedRollupRow extends Record<string, unknown> {
  id: string;
  revision: number | string;
  evaluation_time: Date | string;
  day_start: Date | string;
  day_end: Date | string;
  day_length_ms: string;
  classes: Record<string, number>;
  coverage: Record<string, number>;
  expected_playback_ms: string | null;
  expected_playback_reason: string | null;
  policy_canonical: unknown;
  input_fingerprint: string;
}

function isConnectable(
  client: RollupSqlClient | RollupSqlPool,
): client is RollupSqlPool {
  return typeof (client as RollupSqlPool).connect === "function";
}

function parseTime(value: unknown, field: string): number {
  if (!(typeof value === "string" || value instanceof Date)) {
    throw new RollupInputError(field + " muss ein Zeitpunkt sein.");
  }
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new RollupInputError(field + " ist kein gueltiger Zeitpunkt.");
  }
  return ms;
}

function toIso(value: Date | string): string {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new RollupStorageError("Gespeicherter Zeitpunkt ist ungueltig.");
  }
  return new Date(ms).toISOString();
}

function toNumber(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new RollupStorageError("Gespeicherte Zahl ist ungueltig.");
  }
  return parsed;
}

function baseRollup(
  row: ReturnedRollupRow,
  deviceId: string,
  localDate: string,
  timeZone: string,
  policyVersion: string,
  algorithmVersion: string,
): DailyRollup {
  const expectedRaw = row.expected_playback_ms;
  return {
    id: toNumber(row.id),
    deviceId,
    localDate,
    timeZone,
    policyVersion,
    algorithmVersion,
    revision: toNumber(row.revision),
    evaluationTime: toIso(row.evaluation_time),
    dayStart: toIso(row.day_start),
    dayEnd: toIso(row.day_end),
    dayLengthMs: toNumber(row.day_length_ms),
    classes: row.classes as Record<ClassificationKey, number>,
    coverage: row.coverage as unknown as DailyRollup["coverage"],
    expectedPlaybackMs:
      expectedRaw === null ? null : toNumber(expectedRaw),
    expectedPlaybackReason: row.expected_playback_reason,
    policyCanonical: canonicalize(row.policy_canonical),
    inputFingerprint: row.input_fingerprint,
  };
}

function fromStoredRow(row: RollupRow): DailyRollup {
  return baseRollup(
    row,
    row.device_id,
    row.local_date,
    row.time_zone,
    row.policy_version,
    row.algorithm_version,
  );
}

function rollupLockKey(
  deviceId: string,
  localDate: string,
  timeZone: string,
  policyVersion: string,
  algorithmVersion: string,
): string {
  return [
    "rollup",
    deviceId,
    localDate,
    timeZone,
    policyVersion,
    algorithmVersion,
  ].join("|");
}

/**
 * Korrigierbare, versionierte Tagesauswertung.
 *
 * Ein Aufruf ist eine Transaktion. Die Sperrreihenfolge ist immer
 * Policy-Version -> Auswertungsschluessel; dadurch gibt es keinen Zyklus.
 * Der Tagesverlauf wird in genau einer SQL-Anweisung (ein Snapshot) gelesen.
 * Ein Lauf mit aelterem Auswertungszeitpunkt ueberschreibt nie ein bereits
 * gespeichertes neueres Ergebnis.
 */
export class TelemetryRollupService {
  private readonly client: RollupSqlClient | RollupSqlPool;

  constructor(options: RollupServiceOptions) {
    this.client = options.client;
  }

  async rebuildDay(input: RebuildDayInput): Promise<RebuildDayResult> {
    const deviceId = normalizeDeviceId(input.deviceId);
    const timeZone = assertIanaTimeZone(input.timeZone);
    const dateParts = parseLocalDate(input.localDate);
    const localDate = formatLocalDate(dateParts);
    const policy = validatePolicy(input.policy);
    const policyCanonical = canonicalize(policy);
    const evaluationMs = parseTime(input.evaluationTime, "evaluationTime");
    const { startMs, endMs } = zonedDayRange(dateParts, timeZone);
    const algorithmVersion = ROLLUP_ALGORITHM_VERSION;

    let connection: RollupSqlClient;
    let release: () => void;
    try {
      if (isConnectable(this.client)) {
        const checkedOut = await this.client.connect();
        connection = checkedOut;
        release = () => checkedOut.release();
      } else {
        connection = this.client;
        release = () => undefined;
      }
    } catch (error) {
      throw new RollupStorageError(
        "PostgreSQL-Verbindung fuer Rollups fehlgeschlagen.",
        { cause: error },
      );
    }

    let inTransaction = false;
    try {
      await connection.query("begin");
      inTransaction = true;

      // Feste Sperrreihenfolge: erst Policy-Version, dann Auswertungsschluessel.
      await connection.query(LOCK_POLICY_SQL, ["policy|" + policy.policyVersion]);
      await this.assertPolicyContent(
        connection,
        policy.policyVersion,
        policyCanonical,
      );

      await connection.query(LOCK_ROLLUP_SQL, [
        rollupLockKey(
          deviceId,
          localDate,
          timeZone,
          policy.policyVersion,
          algorithmVersion,
        ),
      ]);

      const existingResult = await connection.query<RollupRow>(
        SELECT_ROLLUP_SQL,
        [deviceId, localDate, timeZone, policy.policyVersion, algorithmVersion],
      );
      const existingRow = existingResult.rows[0] ?? null;

      if (
        existingRow !== null &&
        parseTime(existingRow.evaluation_time, "evaluation_time") > evaluationMs
      ) {
        // Ein paralleler, aber fachlich neuerer Lauf hat bereits gewonnen.
        await connection.query("commit");
        inTransaction = false;
        return { outcome: "stale", rollup: fromStoredRow(existingRow) };
      }

      const snapshot = await loadDaySnapshot(
        connection,
        deviceId,
        startMs,
        endMs,
      );

      const effectiveObservations = snapshot.observations.filter(
        (observation) => Date.parse(observation.occurredAt) <= evaluationMs,
      );
      const priorObservation =
        snapshot.priorObservation !== null &&
        Date.parse(snapshot.priorObservation.occurredAt) <= evaluationMs
          ? snapshot.priorObservation
          : null;

      const fingerprint = computeInputFingerprint({
        deviceId,
        localDate,
        timeZone,
        policyCanonical,
        algorithmVersion,
        dayStartMs: startMs,
        dayEndMs: endMs,
        priorObservation,
        observations: effectiveObservations,
      });

      if (
        existingRow !== null &&
        parseTime(existingRow.evaluation_time, "evaluation_time") ===
          evaluationMs &&
        existingRow.input_fingerprint === fingerprint
      ) {
        await connection.query("commit");
        inTransaction = false;
        return { outcome: "unchanged", rollup: fromStoredRow(existingRow) };
      }

      const classification = classifyDay({
        tabletId: deviceId,
        localDate,
        timeZone,
        evaluatedAt: new Date(evaluationMs).toISOString(),
        observations:
          priorObservation === null
            ? snapshot.observations
            : [priorObservation, ...snapshot.observations],
        policy,
      });

      const nextRevision =
        existingRow === null ? 1 : toNumber(existingRow.revision) + 1;

      let returned: ReturnedRollupRow;
      if (existingRow === null) {
        const inserted = await connection.query<ReturnedRollupRow>(
          INSERT_ROLLUP_SQL,
          [
            deviceId,
            localDate,
            timeZone,
            policy.policyVersion,
            algorithmVersion,
            nextRevision,
            new Date(evaluationMs).toISOString(),
            classification.dayStart,
            classification.dayEnd,
            classification.dayLengthMs,
            JSON.stringify(classification.classes),
            JSON.stringify(classification.observationCoverage),
            classification.expectedPlaybackMs,
            classification.expectedPlaybackReason,
            policyCanonical,
            fingerprint,
          ],
        );
        returned = inserted.rows[0] as ReturnedRollupRow;
      } else {
        const updated = await connection.query<ReturnedRollupRow>(
          UPDATE_ROLLUP_SQL,
          [
            existingRow.id,
            nextRevision,
            new Date(evaluationMs).toISOString(),
            classification.dayStart,
            classification.dayEnd,
            classification.dayLengthMs,
            JSON.stringify(classification.classes),
            JSON.stringify(classification.observationCoverage),
            classification.expectedPlaybackMs,
            classification.expectedPlaybackReason,
            policyCanonical,
            fingerprint,
          ],
        );
        returned = updated.rows[0] as ReturnedRollupRow;
      }

      await connection.query("commit");
      inTransaction = false;

      return {
        outcome: existingRow === null ? "created" : "replaced",
        rollup: baseRollup(
          returned,
          deviceId,
          localDate,
          timeZone,
          policy.policyVersion,
          algorithmVersion,
        ),
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
      if (
        error instanceof EvaluationInputError ||
        error instanceof EvaluationConfigError
      ) {
        throw new RollupInputError(error.message, { cause: error });
      }
      throw new RollupStorageError(
        "Rollup-Transaktion fehlgeschlagen; kein Teilwrite bestaetigt.",
        { cause: error },
      );
    } finally {
      release();
    }
  }

  private async assertPolicyContent(
    connection: RollupSqlClient,
    policyVersion: string,
    policyCanonical: string,
  ): Promise<void> {
    const result = await connection.query<{ policy_canonical: unknown }>(
      SELECT_POLICY_CONTENT_SQL,
      [policyVersion],
    );
    for (const row of result.rows) {
      if (canonicalize(row.policy_canonical) !== policyCanonical) {
        throw new RollupPolicyConflictError(policyVersion);
      }
    }
  }
}

export function createTelemetryRollupService(
  options: RollupServiceOptions,
): TelemetryRollupService {
  return new TelemetryRollupService(options);
}
