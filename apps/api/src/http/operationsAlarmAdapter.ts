/**
 * CX-060 / R-701: schmale Betriebsverdrahtung zwischen technischer Readiness
 * (CX-018), abgeschlossenen Restore-Nachweisen (CX-023) und dem vorhandenen
 * Alarmkern (CX-028/CX-029).
 *
 * Der Adapter ist kein zweiter Alarm-, Backup- oder Readiness-Kern:
 * - Die Readiness-Pruefung bleibt CX-018 (injizierter ReadinessProbe).
 * - Episoden, Deduplizierung und Entwarnung bleiben CX-028.
 * - Der Versand bleibt der austauschbare Port aus CX-029.
 *
 * Es gibt weder Timer noch Scheduler oder Netzwerkcode. Ausloeser ist
 * ausschliesslich die bestehende Readiness-Ausfuehrung; R-702 ruft spaeter
 * processBackupResult fuer bereits abgeschlossene CX-023-Ergebnisse auf.
 *
 * Alarmfehler werden vollstaendig abgefangen und als geheimnisfreier
 * Zustellfehler ausgewiesen. Sie koennen ein negatives Pruefergebnis niemals
 * in Erfolg umwandeln und verzoegern die Readiness-Antwort nur bis zur
 * vorhandenen begrenzten Frist (withDeadline).
 */
import { randomUUID } from "node:crypto";
import type { VerifyRestoreResult } from "../modules/backup/verifyRestore.js";
import {
  createTechnicalAlarmService,
  dispatchPending,
  type AlarmSender,
  type DispatchPendingResult,
  type TechnicalAlarmEpisode,
  type TechnicalAlarmEvaluationOutcome,
  type TechnicalAlarmEvaluationResult,
  type TechnicalAlarmService,
  type TechnicalAlarmSqlPool,
} from "../modules/technicalAlarms/index.js";
import {
  withDeadline,
  type ReadinessProbe,
  type TimerScheduler,
} from "../modules/operations/readiness.js";

/**
 * Getrennte, stabile Episodenschluessel. Sie sind Teil der Verdrahtung und
 * duerfen sich nicht aus Laufzeitwerten ableiten.
 */
export const OPERATIONS_READINESS_KEY_PREFIX = "ops:readiness:";
export const OPERATIONS_BACKUP_EPISODE_KEY = "ops:backup:restore-verification";

/** Feste, geheimnisfreie Fehlercodes der Verdrahtung. */
export const OPERATIONS_READINESS_ERROR_CODE = "readiness_check_failed";
export const OPERATIONS_BACKUP_ERROR_CODE = "backup_verification_failed";
export const OPERATIONS_ALARM_PERSISTENCE_ERROR = "alarm_persistence_failed";
export const OPERATIONS_ALARM_DISPATCH_ERROR = "alarm_delivery_failed";
export const OPERATIONS_ALARM_TIMEOUT_ERROR = "alarm_report_timeout";

/**
 * CX-028 verlangt eine positive Mindestdauer. Eine bestaetigte
 * Readiness-Stoerung ist bereits ein technischer Fehler; der Adapter
 * verankert ihren Beginn daher hoechstens eine Sekunde vor der Beobachtung.
 */
export const OPERATIONS_ALARM_MIN_DURATION_SECONDS = 1;

/** Frist fuer die Alarmspur; die Readiness-Antwort bleibt so begrenzt. */
export const OPERATIONS_ALARM_REPORT_TIMEOUT_MS = 800;

/** Hoechstens so viele faellige Auftraege je Alarmspur. */
const DISPATCH_BATCH_LIMIT = 5;

const COMPONENT_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/;

export type OperationsDeliveryStatus =
  | "not_required"
  | "sent"
  | "pending"
  | "blocked"
  | "failed";

export interface OperationsAlarmDelivery {
  status: OperationsDeliveryStatus;
  /** Fester Code; nie eine Meldung, Verbindung oder ein Geheimnis. */
  errorCode: string | null;
}

export type OperationsAlarmOutcome =
  | TechnicalAlarmEvaluationOutcome
  | "not_persisted";

export interface OperationsAlarmReport {
  outcome: OperationsAlarmOutcome;
  episodeId: number | null;
  delivery: OperationsAlarmDelivery;
}

export interface OperationsReadinessResult {
  ready: boolean;
  alarm: OperationsAlarmReport;
}

export interface OperationsBackupResult {
  /**
   * false bedeutet: kein abgeschlossenes CX-023-Ergebnis. Pausen-,
   * Fahrzeug-aus- oder Offline-Zustaende werden nie als technischer Alarm
   * ausgelegt.
   */
  processed: boolean;
  /** Unveraendertes Erfolgsergebnis des Nachweises. */
  ok: boolean;
  alarm: OperationsAlarmReport | null;
}

export interface OperationsAlarmAdapterOptions {
  pool: TechnicalAlarmSqlPool;
  readiness: ReadinessProbe;
  /** Standard: echter CX-028-Service mit dieser Verdrahtung. */
  alarmService?: TechnicalAlarmService;
  /** CX-029-Versandport; null/undefined blockiert sichtbar, ohne Netzwerk. */
  sender?: AlarmSender | null;
  now?: () => Date;
  /** Nur fuer Tests: kontrollierte Frist. */
  reportTimeoutMs?: number;
  scheduler?: TimerScheduler;
  /** Readiness-Komponente; Standard "postgres". */
  readinessComponent?: string;
}

interface CompletedBackup {
  startedAt: string;
  success: boolean;
  errorCode: string | null;
  evaluationId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeComponent(component: string): string {
  if (!COMPONENT_PATTERN.test(component)) {
    throw new Error("Ungueltige Readiness-Komponente.");
  }
  return component;
}

export function readinessEpisodeKey(component: string): string {
  return OPERATIONS_READINESS_KEY_PREFIX + normalizeComponent(component);
}

function parseUtcTimestamp(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    return null;
  }
  return new Date(ms).toISOString();
}

function safeErrorCode(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const code = value.trim();
  return ERROR_CODE_PATTERN.test(code) ? code : fallback;
}

/**
 * Nur ein vollstaendig abgeschlossenes CX-023-Ergebnis wird ausgewertet.
 * Alle anderen Objekte (z. B. Pause, Fahrzeug-aus, fehlende
 * Tablet-Verbindung) sind keine technischen Betriebssignale.
 */
function readCompletedBackup(raw: unknown): CompletedBackup | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (typeof raw.success !== "boolean") {
    return null;
  }
  const startedAt = parseUtcTimestamp(raw.startedAt);
  if (startedAt === null) {
    return null;
  }
  const sha =
    typeof raw.artifactSha256 === "string" &&
    SHA256_PATTERN.test(raw.artifactSha256)
      ? raw.artifactSha256.toLowerCase()
      : null;
  if (sha === null) {
    return null;
  }
  const errorCode =
    raw.success === true
      ? null
      : safeErrorCode(
          isRecord(raw.error) ? raw.error.code : null,
          OPERATIONS_BACKUP_ERROR_CODE,
        );
  // Die Laufidentitaet ist stabil: dasselbe Ergebnis desselben Laufs bleibt
  // eine Auswertung und erzeugt keinen zweiten Alarm.
  const outcomeTag = raw.success === true ? "ok" : "fail";
  return {
    startedAt,
    success: raw.success,
    errorCode,
    evaluationId: "backup-run:" + startedAt + ":" + sha + ":" + outcomeTag,
  };
}

function deliveryFromDispatch(
  dispatch: DispatchPendingResult,
  episodeId: number,
): OperationsAlarmDelivery {
  const order = dispatch.orders.find((entry) => entry.episodeId === episodeId);
  if (order === undefined) {
    return { status: "failed", errorCode: OPERATIONS_ALARM_DISPATCH_ERROR };
  }
  switch (order.outcome) {
    case "sent":
      return { status: "sent", errorCode: null };
    case "retry_scheduled":
      return { status: "pending", errorCode: order.errorCode };
    case "blocked":
      return { status: "blocked", errorCode: order.errorCode };
    case "failed":
      return { status: "failed", errorCode: order.errorCode };
    case "claim_lost":
      return { status: "failed", errorCode: OPERATIONS_ALARM_DISPATCH_ERROR };
    default:
      return { status: "failed", errorCode: OPERATIONS_ALARM_DISPATCH_ERROR };
  }
}

function reportForEvaluation(
  result: TechnicalAlarmEvaluationResult,
): OperationsAlarmReport {
  return {
    outcome: result.outcome,
    episodeId: result.episode === null ? null : result.episode.episodeId,
    delivery: {
      status: result.outcome === "opened" ? "pending" : "not_required",
      errorCode: null,
    },
  };
}

/**
 * Typisierter Adapter; alle Methoden sind explizit aufrufbar und ohne
 * versteckte Hintergrundarbeit. Ein Alarmfehler wird zum Zustellfehler,
 * niemals zum Pruefergebnis.
 */
export class OperationsAlarmAdapter {
  private readonly pool: TechnicalAlarmSqlPool;
  private readonly readiness: ReadinessProbe;
  private readonly alarmService: TechnicalAlarmService;
  private readonly sender: AlarmSender | null;
  private readonly now: () => Date;
  private readonly reportTimeoutMs: number;
  private readonly scheduler: TimerScheduler | undefined;
  private readonly readinessKey: string;
  private readonly versions = new Map<string, number>();

  constructor(options: OperationsAlarmAdapterOptions) {
    this.pool = options.pool;
    this.readiness = options.readiness;
    this.alarmService =
      options.alarmService ??
      createTechnicalAlarmService({
        pool: options.pool,
        minDurationSeconds: OPERATIONS_ALARM_MIN_DURATION_SECONDS,
        now: options.now,
      });
    this.sender = options.sender ?? null;
    this.now = options.now ?? (() => new Date());
    this.reportTimeoutMs =
      options.reportTimeoutMs ?? OPERATIONS_ALARM_REPORT_TIMEOUT_MS;
    this.scheduler = options.scheduler;
    this.readinessKey = readinessEpisodeKey(
      options.readinessComponent ?? "postgres",
    );
  }

  private nextVersion(key: string): number {
    const previous = this.versions.get(key) ?? 0;
    const next = Math.max(Date.now(), previous + 1);
    this.versions.set(key, next);
    return next;
  }

  private episodeFaultStart(now: Date, startedAt: string | null): Date {
    const minimumMs = OPERATIONS_ALARM_MIN_DURATION_SECONDS * 1000;
    const boundary = new Date(now.getTime() - minimumMs);
    if (startedAt === null) {
      return boundary;
    }
    const parsed = Date.parse(startedAt);
    if (!Number.isFinite(parsed) || parsed > boundary.getTime()) {
      return boundary;
    }
    return new Date(parsed);
  }

  /**
   * Persistiert eine Auswertung und versendet ausschliesslich neu
   * eroeffnete Episoden. Die gesamte Spur ist begrenzt; jeder Fehler wird
   * geheimnisfrei als Zustellfehler gemeldet.
   */
  private async evaluateAndDeliver(
    key: string,
    evaluationId: string,
    classification:
      | { outcome: "healthy" }
      | {
          outcome: "technical_fault";
          errorCode: string;
          faultStartedAt: Date;
        },
  ): Promise<OperationsAlarmReport> {
    const version = this.nextVersion(key);
    let stage: "persist" | "deliver" = "persist";
    let openedEpisode: TechnicalAlarmEpisode | null = null;

    const work = (async (): Promise<OperationsAlarmReport> => {
      const result = await this.alarmService.evaluate({
        resourceId: key,
        evaluationId,
        evaluationVersion: version,
        classification,
      });
      const report = reportForEvaluation(result);
      if (result.outcome !== "opened" || result.episode === null) {
        return report;
      }
      openedEpisode = result.episode;
      stage = "deliver";
      const dispatch = await dispatchPending({
        pool: this.pool,
        sender: this.sender,
        now: this.now,
        batchLimit: DISPATCH_BATCH_LIMIT,
      });
      report.delivery = deliveryFromDispatch(
        dispatch,
        openedEpisode.episodeId,
      );
      return report;
    })();
    // Nach einer Frist kann die Spur spaeter noch abschliessen; ein
    // unbehandelter Abschluss darf den Prozess nicht stoeren.
    work.catch(() => undefined);

    try {
      return await withDeadline(work, {
        timeoutMs: this.reportTimeoutMs,
        scheduler: this.scheduler,
      });
    } catch (error: unknown) {
      const timedOut =
        error instanceof Error && error.name === "ReadinessTimeoutError";
      return {
        outcome: "not_persisted",
        episodeId: null,
        delivery: {
          status: "failed",
          errorCode: timedOut
            ? OPERATIONS_ALARM_TIMEOUT_ERROR
            : stage === "persist"
              ? OPERATIONS_ALARM_PERSISTENCE_ERROR
              : OPERATIONS_ALARM_DISPATCH_ERROR,
        },
      };
    }
  }

  /**
   * Fuehrt die vorhandene CX-018-Pruefung aus und meldet ihr Ergebnis an
   * CX-028. Ein negatives Ergebnis bleibt negativ, auch wenn die Alarmspur
   * fehlschlaegt.
   */
  async checkReadiness(): Promise<OperationsReadinessResult> {
    let ready = true;
    try {
      await this.readiness.check();
    } catch {
      ready = false;
    }

    const now = this.now();
    const evaluationId = "readiness:" + randomUUID();
    const alarm = ready
      ? await this.evaluateAndDeliver(this.readinessKey, evaluationId, {
          outcome: "healthy",
        })
      : await this.evaluateAndDeliver(this.readinessKey, evaluationId, {
          outcome: "technical_fault",
          errorCode: OPERATIONS_READINESS_ERROR_CODE,
          faultStartedAt: this.episodeFaultStart(now, null),
        });
    return { ready, alarm };
  }

  /** Fuer die bestehende Route: negativ bedeutet 503, nie Erfolg. */
  async checkReadinessOrThrow(): Promise<void> {
    const result = await this.checkReadiness();
    if (!result.ready) {
      throw new Error("readiness_not_ready");
    }
  }

  /**
   * Verarbeitet ein bereits abgeschlossenes CX-023-Ergebnis. R-702 ruft
   * diese Funktion spaeter auf; hier wird kein Restore gestartet.
   */
  async processBackupResult(raw: unknown): Promise<OperationsBackupResult> {
    const completed = readCompletedBackup(raw);
    if (completed === null) {
      return { processed: false, ok: false, alarm: null };
    }

    const now = this.now();
    const alarm = completed.success
      ? await this.evaluateAndDeliver(
          OPERATIONS_BACKUP_EPISODE_KEY,
          completed.evaluationId,
          { outcome: "healthy" },
        )
      : await this.evaluateAndDeliver(
          OPERATIONS_BACKUP_EPISODE_KEY,
          completed.evaluationId,
          {
            outcome: "technical_fault",
            errorCode: completed.errorCode ?? OPERATIONS_BACKUP_ERROR_CODE,
            faultStartedAt: this.episodeFaultStart(now, completed.startedAt),
          },
        );
    return { processed: true, ok: completed.success, alarm };
  }
}

export function createOperationsAlarmAdapter(
  options: OperationsAlarmAdapterOptions,
): OperationsAlarmAdapter {
  return new OperationsAlarmAdapter(options);
}

export type { VerifyRestoreResult };
