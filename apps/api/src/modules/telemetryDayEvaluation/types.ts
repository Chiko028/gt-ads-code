import type { EvaluationPolicy } from "../telemetryEvaluation/types.js";
import type {
  DailyRollup,
  RebuildOutcome,
  RollupSqlClient,
  RollupSqlPool,
} from "../telemetryRollups/types.js";

/**
 * CX-047 / R-402: explizite Konfiguration eines internen Tagesauswertungslaufs.
 *
 * Beide Felder sind Pflicht. Die Policy ist die vorhandene, versionierte
 * CX-010-Konfiguration inklusive E36 und E40; es gibt keine Defaults.
 */
export interface DayEvaluationConfiguration {
  /** Pflicht: IANA-Zeitzone, kein fester UTC-Offset. */
  timeZone: string;
  /** Pflicht: versionierte Klassifikationskonfiguration aus CX-010. */
  policy: EvaluationPolicy;
}

/** Genau ein Geraet und genau ein lokaler Kalendertag. */
export interface DayEvaluationInput {
  deviceId: string;
  /** Lokales Kalenderdatum YYYY-MM-DD in der konfigurierten Zeitzone. */
  localDate: string;
  configuration: DayEvaluationConfiguration;
}

/** Tatsaechlicher Verarbeitungsstatus aus CX-011, erst nach Commit sichtbar. */
export type DayEvaluationStatus = RebuildOutcome;

export interface DayEvaluationResult {
  deviceId: string;
  localDate: string;
  timeZone: string;
  /** Verwendete Konfigurationsversion (CX-010-Policy). */
  policyVersion: string;
  algorithmVersion: string;
  status: DayEvaluationStatus;
  revision: number;
  evaluationTime: string;
  rollup: DailyRollup;
}

export interface DayEvaluationServiceOptions {
  client: RollupSqlClient | RollupSqlPool;
  /**
   * Injizierte Uhr. Es gibt bewusst keinen Fallback auf die Systemzeit:
   * Tagesgrenze und Auswertungszeitpunkt stammen ausschliesslich hierher.
   */
  now: () => Date;
}
