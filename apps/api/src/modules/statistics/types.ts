/**
 * CX-049 / R-404: lesende Wiedergabe-Statistik.
 *
 * Der Dienst liest ausschliesslich vorhandene Persistenz:
 * - gemeldete Wiedergabeabschnitte aus telemetry_observations (CX-009),
 * - technische Tageswerte und Abdeckung aus telemetry_daily_rollups (CX-011),
 * - historische Geraete-/Taxi-Zuordnung aus device_taxi_assignments,
 * - Kundenkampagnen und Taxi-Ziele aus campaigns/campaign_targets,
 * - deduplizierte technische Fehlerereignisse aus technical_alarm_episodes.
 *
 * Es entsteht keine neue Tabelle, keine Migration, keine zweite
 * Aggregationspipeline und kein Schreibpfad.
 */

export type CompletenessStatus = "complete" | "incomplete";

export interface StatisticsFilters {
  campaign_id: string | null;
  device_id: string | null;
  taxi_id: string | null;
}

export interface StatisticsQuery {
  /** Kanonischer UTC-Zeitpunkt aus der Anfrage. */
  from: string;
  to: string;
  fromMs: number;
  toMs: number;
  campaignId: string | null;
  deviceId: string | null;
  taxiId: string | null;
}

export interface PlayRow {
  campaign_id: string | null;
  device_id: string;
  /** Historische Zuordnung zum Wiedergabezeitpunkt; null ohne Beleg. */
  taxi_id: string | null;
  play_count: number;
  first_played_at: string;
  last_played_at: string;
}

export interface DeviceQualityRow {
  device_id: string;
  /** Historische Zuordnung am Beginn des Zeitraums; null ohne Beleg. */
  taxi_id: string | null;
  /** 0..1 oder null, wenn kein belastbarer Nenner vorliegt. */
  availability_ratio: number | null;
  availability_reason: string | null;
  observed_ms: number | null;
  technical_fault_ms: number | null;
  /** Deduplizierte Sync-Fehlerereignisse im Geraete-/Zeitbereich. */
  sync_errors: number;
  sync_error_scope: "device_or_taxi_time";
}

export interface MissingDay {
  day: string;
  reason: "no_raw_evidence" | "raw_retention_gap";
}

export interface StatisticsCompleteness {
  status: CompletenessStatus;
  reasons: string[];
  /** Zeitpunkt des juengsten beruecksichtigten Belegs. */
  data_as_of: string;
  missing_days: MissingDay[];
}

export interface MeasurementDefinition {
  interval: "[from,to)";
  play_count: string;
  campaign_attribution: string;
  taxi_attribution: string;
  availability: string;
  sync_errors: string;
  excludes: string[];
}

export interface StatisticsResponse {
  from: string;
  to: string;
  generated_at: string;
  filters: StatisticsFilters;
  definition: MeasurementDefinition;
  completeness: StatisticsCompleteness;
  row_limit: number;
  row_count: number;
  quality_scope: "device_taxi_time";
  plays: PlayRow[];
  device_quality: DeviceQualityRow[];
}

export interface StatisticsServiceOptions {
  pool: import("pg").Pool;
  /** Injizierbare Serveruhr; ohne Angabe gilt die reale Uhr. */
  now?: () => Date;
}

/** Obergrenze der Ergebniszeilen; Ueberschreitung wird abgelehnt. */
export const STATISTICS_ROW_LIMIT = 10_000;

/** Maximaler anfragbarer Zeitraum in Millisekunden. */
export const STATISTICS_MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000;

/** Nur diese Fehlercodes gelten als Sync-Fehler. */
export const SYNC_ERROR_CODE_PREFIX = "sync";

