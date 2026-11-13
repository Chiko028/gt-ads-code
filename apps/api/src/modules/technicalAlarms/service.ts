import { insertAuditEvent } from "../audit/repository.js";
import type { AuditEventInput, SqlQueryable } from "../audit/repository.js";
import { TechnicalAlarmInputError, TechnicalAlarmStorageError } from "./errors.js";
import {
  INSERT_EPISODE_SQL,
  INSERT_OUTBOX_SQL,
  INSERT_STATE_SQL,
  LOCK_RESOURCE_SQL,
  RESOLVE_EPISODE_SQL,
  SELECT_OPEN_EPISODE_SQL,
  SELECT_OUTBOX_BY_EPISODE_SQL,
  SELECT_STATE_SQL,
  UPDATE_STATE_SQL,
  mapEpisodeRow,
  mapOutboxRow,
  mapStateVersion,
  type EpisodeRow,
  type OutboxRow,
  type StateRow,
} from "./repository.js";
import type {
  TechnicalAlarmDeliveryOrder,
  TechnicalAlarmEpisode,
  TechnicalAlarmEvaluationInput,
  TechnicalAlarmEvaluationOutcome,
  TechnicalAlarmEvaluationResult,
  TechnicalAlarmServiceOptions,
  TechnicalAlarmSqlClient,
} from "./types.js";
import {
  normalizeTechnicalAlarmInput,
  validateMinDurationSeconds,
  type NormalizedTechnicalAlarmInput,
} from "./validation.js";

/** Stabile Audit-Aktionsnamen; sie werden in Tests geprueft. */
export const TECHNICAL_ALARM_OPENED_ACTION = "technical_alarm.episode.opened";
export const TECHNICAL_ALARM_RESOLVED_ACTION =
  "technical_alarm.episode.resolved";
export const TECHNICAL_ALARM_AUDIT_TARGET_TYPE = "technical_alarm_episode";

/**
 * Freigegebene technische Felder eines Eroeffnungsereignisses. Rohe
 * Beobachtungen, Klassifikationsverteilungen oder Zeitraeume werden nie
 * gespeichert.
 */
export const TECHNICAL_ALARM_OPENED_AUDIT_FIELDS = [
  "detected_at",
  "episode_id",
  "error_code",
  "evaluation_id",
  "evaluation_version",
  "fault_started_at",
  "resource_id",
] as const;

/** Zusaetzlich zum Eroeffnungsdatensatz nur der Behebungszeitpunkt. */
export const TECHNICAL_ALARM_RESOLVED_AUDIT_FIELDS = [
  "detected_at",
  "episode_id",
  "error_code",
  "evaluation_id",
  "evaluation_version",
  "fault_started_at",
  "resolved_at",
  "resource_id",
] as const;

interface OpenedAuditValues {
  resourceId: string;
  episode: TechnicalAlarmEpisode;
  evaluationId: string;
  evaluationVersion: number;
}

interface ResolvedAuditValues extends OpenedAuditValues {
  resolvedAt: string;
}

function openedAuditDetails(values: OpenedAuditValues): Record<string, unknown> {
  return {
    resource_id: values.resourceId,
    episode_id: String(values.episode.episodeId),
    error_code: values.episode.errorCode,
    fault_started_at: values.episode.faultStartedAt,
    detected_at: values.episode.detectedAt,
    evaluation_id: values.evaluationId,
    evaluation_version: values.evaluationVersion,
  };
}

function resolvedAuditDetails(values: ResolvedAuditValues): Record<string, unknown> {
  return {
    ...openedAuditDetails(values),
    resolved_at: values.resolvedAt,
  };
}

function requireEpisode(
  episode: TechnicalAlarmEpisode | null,
  field: string,
): TechnicalAlarmEpisode {
  if (episode === null) {
    throw new TechnicalAlarmStorageError(
      "Gespeicherte Episode fuer " + field + " fehlt.",
    );
  }
  return episode;
}

/**
 * Explizit aufrufbarer Auswertungsservice ohne HTTP-Route und ohne Scheduler.
 *
 * Ein Aufruf ist eine Transaktion. Eine Advisory-Sperre je Ressource
 * serialisiert konkurrierende Auswertungen; der Ressourcenstand verhindert
 * Wiederholungen und aeltere Versionen. Eine Teilindex-Regel sichert
 * zusaetzlich hoechstens eine offene Episode je Ressource.
 *
 * Nur ein technischer Fehler mit validiertem Fehlercode und belegtem Beginn
 * kann eine Episode eroeffnen. "unknown" beendet nie eine Episode; nur ein
 * belegtes gesundes Ergebnis schliesst sie.
 */
export class TechnicalAlarmService {
  private readonly pool: TechnicalAlarmServiceOptions["pool"];
  private readonly minDurationMs: number;
  private readonly now: () => Date;
  private readonly auditWriter:
    | NonNullable<TechnicalAlarmServiceOptions["auditWriter"]>
    | undefined;

  constructor(options: TechnicalAlarmServiceOptions) {
    this.pool = options.pool;
    this.minDurationMs =
      validateMinDurationSeconds(options.minDurationSeconds) * 1000;
    this.now = options.now ?? (() => new Date());
    this.auditWriter = options.auditWriter;
  }

  private async writeAudit(
    executor: SqlQueryable,
    event: AuditEventInput,
  ): Promise<void> {
    if (this.auditWriter !== undefined) {
      await this.auditWriter(executor, event);
      return;
    }
    await insertAuditEvent(executor, event);
  }

  private async readDeliveryOrder(
    client: TechnicalAlarmSqlClient,
    episodeId: number,
  ): Promise<TechnicalAlarmDeliveryOrder> {
    const result = await client.query<OutboxRow>(
      SELECT_OUTBOX_BY_EPISODE_SQL,
      [episodeId],
    );
    if (result.rows.length === 0) {
      throw new TechnicalAlarmStorageError(
        "Versandauftrag zur Episode " + episodeId + " fehlt.",
      );
    }
    return mapOutboxRow(result.rows[0]);
  }

  async evaluate(
    rawInput: TechnicalAlarmEvaluationInput,
  ): Promise<TechnicalAlarmEvaluationResult> {
    const input = normalizeTechnicalAlarmInput(rawInput);
    const evaluatedAt = this.now();
    if (!(evaluatedAt instanceof Date) || Number.isNaN(evaluatedAt.getTime())) {
      throw new TechnicalAlarmInputError(
        "Die injizierte Serveruhr liefert keinen gueltigen Zeitpunkt.",
      );
    }

    const client = await this.pool.connect();
    let inTransaction = false;
    try {
      await client.query("begin");
      inTransaction = true;

      // Erste Grenze: alle Auswertungen derselben Ressource sind seriell.
      await client.query(LOCK_RESOURCE_SQL, [input.resourceId]);

      const stateResult = await client.query<StateRow>(SELECT_STATE_SQL, [
        input.resourceId,
      ]);
      const state = stateResult.rows.length === 0 ? null : stateResult.rows[0];

      if (state !== null) {
        const currentVersion = mapStateVersion(state);
        if (
          input.evaluationVersion <= currentVersion ||
          state.last_evaluation_id === input.evaluationId
        ) {
          await client.query("rollback");
          inTransaction = false;
          return {
            outcome: "stale",
            episode: null,
            deliveryOrder: null,
          };
        }
      }

      const openResult = await client.query<EpisodeRow>(
        SELECT_OPEN_EPISODE_SQL,
        [input.resourceId],
      );
      const openEpisode =
        openResult.rows.length === 0 ? null : mapEpisodeRow(openResult.rows[0]);

      let outcome: TechnicalAlarmEvaluationOutcome = "no_change";
      let episode: TechnicalAlarmEpisode | null = openEpisode;
      let deliveryOrder: TechnicalAlarmDeliveryOrder | null = null;

      if (input.classification.outcome === "technical_fault") {
        const startedAtMs = input.classification.faultStartedAtMs;
        const errorCode = input.classification.errorCode;
        if (startedAtMs === null || errorCode === null) {
          throw new TechnicalAlarmInputError(
            "technical_fault benoetigt Fehlercode und belegten Beginn.",
          );
        }
        const evaluatedAtMs = evaluatedAt.getTime();
        if (startedAtMs > evaluatedAtMs) {
          throw new TechnicalAlarmInputError(
            "classification.faultStartedAt liegt nach dem Auswertungszeitpunkt.",
          );
        }

        if (evaluatedAtMs - startedAtMs >= this.minDurationMs) {
          if (openEpisode === null) {
            const inserted = await client.query<EpisodeRow>(
              INSERT_EPISODE_SQL,
              [
                input.resourceId,
                errorCode,
                new Date(startedAtMs),
                evaluatedAt,
                input.evaluationId,
                input.evaluationVersion,
              ],
            );
            if (inserted.rows.length !== 1) {
              throw new TechnicalAlarmStorageError(
                "Episode konnte nicht angelegt werden.",
              );
            }
            episode = mapEpisodeRow(inserted.rows[0]);
            const orderResult = await client.query<OutboxRow>(
              INSERT_OUTBOX_SQL,
              [episode.episodeId, input.resourceId, evaluatedAt],
            );
            if (orderResult.rows.length !== 1) {
              throw new TechnicalAlarmStorageError(
                "Versandauftrag konnte nicht angelegt werden.",
              );
            }
            deliveryOrder = mapOutboxRow(orderResult.rows[0]);
            outcome = "opened";

            await this.writeAudit(client, {
              at: evaluatedAt,
              actorType: "system",
              actorId: null,
              action: TECHNICAL_ALARM_OPENED_ACTION,
              targetType: TECHNICAL_ALARM_AUDIT_TARGET_TYPE,
              targetId: String(episode.episodeId),
              details: openedAuditDetails({
                resourceId: input.resourceId,
                episode,
                evaluationId: input.evaluationId,
                evaluationVersion: input.evaluationVersion,
              }),
            });
          } else {
            // Hoechstens eine offene Episode je Ressource: eine weitere
            // bestaetigte technische Auswertung erzeugt weder Episode noch
            // Auftrag und keine zusaetzliche Alarmnachricht.
            episode = openEpisode;
            deliveryOrder = await this.readDeliveryOrder(
              client,
              openEpisode.episodeId,
            );
            outcome = "existing_open";
          }
        }
      } else if (
        input.classification.outcome === "healthy" &&
        openEpisode !== null
      ) {
        const resolvedResult = await client.query<EpisodeRow>(
          RESOLVE_EPISODE_SQL,
          [openEpisode.episodeId, evaluatedAt, input.evaluationId],
        );
        if (resolvedResult.rows.length !== 1) {
          throw new TechnicalAlarmStorageError(
            "Offene Episode konnte nicht beendet werden.",
          );
        }
        episode = mapEpisodeRow(resolvedResult.rows[0]);
        outcome = "resolved";

        await this.writeAudit(client, {
          at: evaluatedAt,
          actorType: "system",
          actorId: null,
          action: TECHNICAL_ALARM_RESOLVED_ACTION,
          targetType: TECHNICAL_ALARM_AUDIT_TARGET_TYPE,
          targetId: String(episode.episodeId),
          details: resolvedAuditDetails({
            resourceId: input.resourceId,
            episode,
            evaluationId: input.evaluationId,
            evaluationVersion: input.evaluationVersion,
            resolvedAt: requireEpisode(episode, "resolution").resolvedAt as string,
          }),
        });
      }

      // Der Ressourcenstand wird auch fuer wirkungslose, aber neuere
      // nichttechnische Auswertungen fortgeschrieben. Das ist der Anker gegen
      // Wiederholungen und aus der Reihenfolge laufende Versionen.
      if (state === null) {
        await client.query(INSERT_STATE_SQL, [
          input.resourceId,
          input.evaluationVersion,
          input.evaluationId,
          input.classification.outcome,
          evaluatedAt,
        ]);
      } else {
        await client.query(UPDATE_STATE_SQL, [
          input.resourceId,
          input.evaluationVersion,
          input.evaluationId,
          input.classification.outcome,
          evaluatedAt,
        ]);
      }

      await client.query("commit");
      inTransaction = false;
      return { outcome, episode, deliveryOrder };
    } catch (error) {
      if (inTransaction) {
        try {
          await client.query("rollback");
        } catch {
          // Der urspruengliche Fehler bleibt massgeblich.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createTechnicalAlarmService(
  options: TechnicalAlarmServiceOptions,
): TechnicalAlarmService {
  return new TechnicalAlarmService(options);
}

export type {
  NormalizedTechnicalAlarmInput,
  TechnicalAlarmEvaluationInput,
  TechnicalAlarmEvaluationResult,
};
