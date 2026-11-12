import type {
  ClassificationKey,
  EvaluationPolicy,
  ObservationCoverage,
} from "../telemetryEvaluation/types.js";
import type {
  TelemetrySqlClient,
  TelemetrySqlPool,
} from "../telemetry/types.js";

/** Algorithmus-Version ist Teil des Auswertungsschluessels. */
export const ROLLUP_ALGORITHM_VERSION = "cx-011-rollup-v1";

/**
 * Optionaler, konservativer Entwurfswert fuer E22.
 * Ausdruecklich kein Default und keine bestaetigte Betreiberentscheidung.
 */
export const DRAFT_RAW_RETENTION_DAYS = 90;

/** Eine Beobachtung samt Empfangszeit und Herkunft aus dem Vortag. */
export interface SnapshotObservation {
  eventId: string;
  occurredAt: string;
  receivedAt: string;
  vehicleReady: boolean | null;
  paused: boolean | null;
  playback: "playing" | "stopped" | "unknown";
  technicalFault: boolean | null;
  /** true nur fuer die letzte Beobachtung vor dem lokalen Tagesbeginn. */
  priorToDay: boolean;
}

export interface RebuildDayInput {
  deviceId: string;
  localDate: string;
  timeZone: string;
  policy: EvaluationPolicy;
  evaluationTime: string | Date;
}

export interface DailyRollup {
  id: number;
  deviceId: string;
  localDate: string;
  timeZone: string;
  policyVersion: string;
  algorithmVersion: string;
  revision: number;
  evaluationTime: string;
  dayStart: string;
  dayEnd: string;
  dayLengthMs: number;
  classes: Record<ClassificationKey, number>;
  coverage: ObservationCoverage;
  expectedPlaybackMs: number | null;
  expectedPlaybackReason: string | null;
  policyCanonical: string;
  inputFingerprint: string;
}

export type RebuildOutcome = "created" | "replaced" | "unchanged" | "stale";

export interface RebuildDayResult {
  outcome: RebuildOutcome;
  rollup: DailyRollup;
}

export interface RollupServiceOptions {
  client: TelemetrySqlClient | TelemetrySqlPool;
}

export type RollupSqlClient = TelemetrySqlClient;
export type RollupSqlPool = TelemetrySqlPool;

/** Explizite Retention-Regel; ohne Regel wird nichts vorgeschlagen. */
export interface RetentionRule {
  ruleVersion: string;
  rawRetentionDays: number;
}

export type RetentionWithholdReason =
  | "day_not_completed"
  | "inside_retention_horizon"
  | "rollup_before_day_end"
  | "rollup_day_mismatch"
  | "no_raw_data"
  | "raw_event_inside_horizon"
  | "raw_received_inside_horizon"
  | "raw_fingerprint_mismatch";

export interface RetentionRollupRef {
  policyVersion: string;
  revision: number;
  inputFingerprint: string;
}

export interface RetentionCandidate {
  deviceId: string;
  localDate: string;
  timeZone: string;
  dayStart: string;
  dayEnd: string;
  rollups: RetentionRollupRef[];
}

export interface RetentionWithheldDay {
  deviceId: string;
  localDate: string;
  timeZone: string;
  policyVersions: string[];
  reasons: RetentionWithholdReason[];
}

export interface RetentionPreview {
  /** null bedeutet: keine aktive Regel. */
  rule: RetentionRule | null;
  timeZone: string;
  evaluationTime: string;
  /** Beginn des Aufbewahrungsfensters; null ohne aktive Regel. */
  horizonStart: string | null;
  candidates: RetentionCandidate[];
  withheld: RetentionWithheldDay[];
}

export interface RetentionPreviewOptions {
  client: TelemetrySqlClient | TelemetrySqlPool;
  evaluationTime: string | Date;
  timeZone: string;
  rule?: RetentionRule | null;
  /** Standard ist die aktuelle Algorithmus-Version. */
  algorithmVersion?: string;
}

/** Ergebnis der reinen Bewertung eines lokalen Tages. */
export interface RetentionDayAssessmentInput {
  dayStartMs: number;
  dayEndMs: number;
  evaluationTimeMs: number;
  horizonStartMs: number;
  rollupEvaluationTimeMs: number;
  rollupDayStartMs: number;
  rollupDayEndMs: number;
  rawObservationCount: number;
  latestRawOccurredAtMs: number | null;
  latestRawReceivedAtMs: number | null;
  fingerprintMatches: boolean;
}

export interface RetentionDayAssessment {
  eligible: boolean;
  reasons: RetentionWithholdReason[];
}
