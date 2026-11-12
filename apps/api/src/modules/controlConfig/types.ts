import type { Pool, PoolClient } from "pg";
import type { AuditEventInput, SqlQueryable } from "../audit/repository.js";

/** Minimale SQL-Schnittstellen; pg.Pool und pg.PoolClient erfuellen sie. */
export type ControlConfigSqlClient = Pick<PoolClient, "query">;
export type ControlConfigSqlPool = Pick<Pool, "connect">;

/** Standard ist der bestehende Audit-Schreibweg; Tests duerfen ihn ersetzen. */
export type ControlConfigAuditWriter = (
  executor: SqlQueryable,
  event: AuditEventInput,
) => Promise<void>;

/** Authentifizierter Verwaltungsakteur aus dem aufrufenden Kontext. */
export interface AdminActor {
  id: string;
  type?: "admin";
}

/**
 * Vollstaendige taxiweise Konfiguration.
 *
 * Null bedeutet "unentschieden"; es ist weder "unbegrenzt" noch
 * "deaktiviert" und wird hier nicht in Laufzeitverhalten uebersetzt.
 * gps_mode ist in diesem Paket ausschliesslich "aus".
 */
export interface TaxiControlConfigValues {
  gps_mode: "aus";
  /** Positive sichere Ganzzahl in Sekunden oder null. */
  pause_max_duration_s: number | null;
  pause_end_on_vehicle_off: boolean | null;
  /** Nichtnegative sichere Ganzzahl in Sekunden oder null. */
  display_run_on_s: number | null;
}

export interface TaxiControlConfig extends TaxiControlConfigValues {
  taxi_id: string;
  revision: number;
  /**
   * Nur wahr, wenn alle drei offenen E36/E40-Parameter explizit gesetzt
   * sind. Eine unvollstaendige Konfiguration ist keine aktivierbare
   * Tablet-Policy.
   */
  policy_complete: boolean;
}

export interface ReadTaxiConfigInput {
  actor: AdminActor;
  taxi_id: string;
}

export interface UpdateTaxiConfigInput {
  actor: AdminActor;
  taxi_id: string;
  change_id: string;
  expected_revision: number;
  config: TaxiControlConfigValues;
}

export interface UpdateTaxiConfigResult extends TaxiControlConfig {
  change_id: string;
  /** Wahr, wenn dieselbe change_id unveraendert wiederholt wurde. */
  idempotent: boolean;
}

export interface ControlConfigServiceOptions {
  pool: ControlConfigSqlPool;
  now?: () => Date;
  auditWriter?: ControlConfigAuditWriter;
}
