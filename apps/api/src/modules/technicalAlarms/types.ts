import type { AuditEventInput, SqlQueryable } from "../audit/repository.js";
import type { ClassificationKey } from "../telemetryEvaluation/types.js";

/**
 * Die Klassifikationsschluessel stammen unveraendert aus CX-010. Der
 * Alarmdienst fuehrt keine zweite, abweichende Zustandssprache ein.
 */
export type TechnicalAlarmClassificationKey = ClassificationKey;

/**
 * Klassifikationsergebnis eines Aufrufs.
 *
 * Nur outcome = "technical_fault" ist alarmfaehig; dann muessen errorCode und
 * faultStartedAt belegt sein. Die uebrigen Ergebnisse sind ausdruecklich
 * nichttechnisch. "unknown" ist kein Erholungsnachweis.
 */
export interface TechnicalAlarmClassification {
  outcome: ClassificationKey;
  /** Validierter technischer Fehlercode; nur bei technical_fault zulaessig. */
  errorCode?: string | null;
  /** Belegter Beginn des technischen Fehlers; nur bei technical_fault. */
  faultStartedAt?: string | Date | null;
}

export interface TechnicalAlarmEvaluationInput {
  /** Ressourcenkennung, z. B. Tablet- oder Taxi-ID. */
  resourceId: string;
  /** Eindeutige Auswertungs-ID des Aufrufs. */
  evaluationId: string;
  /** Monotone Version; kleinere oder gleiche Versionen sind wirkungslos. */
  evaluationVersion: number;
  classification: TechnicalAlarmClassification;
}

export type TechnicalAlarmEpisodeStatus = "open" | "resolved";

export interface TechnicalAlarmEpisode {
  episodeId: number;
  resourceId: string;
  status: TechnicalAlarmEpisodeStatus;
  errorCode: string;
  faultStartedAt: string;
  detectedAt: string;
  resolvedAt: string | null;
  openedEvaluationId: string;
  openedEvaluationVersion: number;
  resolutionEvaluationId: string | null;
}

export type TechnicalAlarmDeliveryStatus =
  | "pending"
  | "leased"
  | "sent"
  | "failed"
  | "cancelled";

/** Dauerhafter Versandauftrag; in diesem Paket wird nichts versendet. */
export interface TechnicalAlarmDeliveryOrder {
  outboxId: number;
  episodeId: number;
  resourceId: string;
  messageKind: "technical_alarm_opened";
  status: TechnicalAlarmDeliveryStatus;
  attemptCount: number;
  nextAttemptAt: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export type TechnicalAlarmEvaluationOutcome =
  | "opened"
  | "resolved"
  | "existing_open"
  | "no_change"
  | "stale";

export interface TechnicalAlarmEvaluationResult {
  outcome: TechnicalAlarmEvaluationOutcome;
  episode: TechnicalAlarmEpisode | null;
  deliveryOrder: TechnicalAlarmDeliveryOrder | null;
}

/** Minimale SQL-Schnittstellen; pg.Pool und pg.PoolClient erfuellen sie. */
import type { Pool, PoolClient } from "pg";

export type TechnicalAlarmSqlClient = Pick<PoolClient, "query">;
export type TechnicalAlarmSqlConnection = PoolClient;
export type TechnicalAlarmSqlPool = Pick<Pool, "connect">;

/** Standard ist der transaktionsgebundene Audit-Schreiber aus U3. */
export type TechnicalAlarmAuditWriter = (
  executor: SqlQueryable,
  event: AuditEventInput,
) => Promise<void>;

export interface TechnicalAlarmServiceOptions {
  pool: TechnicalAlarmSqlPool;
  /** Explizite Mindestdauer; es gibt keinen versteckten Produktionsdefault. */
  minDurationSeconds: number;
  now?: () => Date;
  auditWriter?: TechnicalAlarmAuditWriter;
}

/**
 * Kleiner Repository-Port fuer CX-029. Er liest nur den dauerhaften Zustand;
 * Schreibwege bleiben im Auswertungsservice und damit transaktional.
 */
export interface TechnicalAlarmRepositoryPort {
  findOpenEpisode(resourceId: string): Promise<TechnicalAlarmEpisode | null>;
  findEpisode(episodeId: number): Promise<TechnicalAlarmEpisode | null>;
  findDeliveryOrder(
    episodeId: number,
  ): Promise<TechnicalAlarmDeliveryOrder | null>;
  listPendingDeliveryOrders(
    limit: number,
  ): Promise<TechnicalAlarmDeliveryOrder[]>;
}
