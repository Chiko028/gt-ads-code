import { randomUUID } from "node:crypto";
import { insertAuditEvent } from "../audit/repository.js";
import type { AuditEventInput } from "../audit/repository.js";
import { TechnicalAlarmInputError, TechnicalAlarmStorageError } from "./errors.js";
import type {
  TechnicalAlarmAuditWriter,
  TechnicalAlarmSqlPool,
} from "./types.js";
import { validateErrorCode } from "./validation.js";
import type {
  AlarmDeliveryMessage,
  AlarmSendOutcome,
  AlarmSender,
} from "./telegramSender.js";

/**
 * CX-029: begrenzter Versandlauf ueber die persistente Outbox aus CX-028.
 *
 * Es gibt weder Timer noch oeffentliche API. Ein Aufruf beansprucht faellige
 * Auftraege atomar mit befristeter Lease, ruft den Adapter ausserhalb der
 * Datenbanktransaktion auf und speichert das Ergebnis nur, solange dieselbe
 * Claim-ID noch gilt. Abgelaufene Claims duerfen erneut verarbeitet werden;
 * eine Exactly-once-Zustellung wird nicht behauptet.
 */

export const TECHNICAL_ALARM_DELIVERY_TARGET_TYPE = "technical_alarm_outbox";
export const TECHNICAL_ALARM_DELIVERY_SENT_ACTION =
  "technical_alarm.delivery.sent";
export const TECHNICAL_ALARM_DELIVERY_RETRY_ACTION =
  "technical_alarm.delivery.retry_scheduled";
export const TECHNICAL_ALARM_DELIVERY_FAILED_ACTION =
  "technical_alarm.delivery.failed";
export const TECHNICAL_ALARM_DELIVERY_BLOCKED_ACTION =
  "technical_alarm.delivery.blocked";

/** Freigegebene Audit-Felder; keine Rohdaten, Ziel-IDs oder Geheimnisse. */
export const TECHNICAL_ALARM_DELIVERY_AUDIT_FIELDS = [
  "alarm_id",
  "attempt_count",
  "error_code",
  "next_attempt_at",
  "occurred_at",
  "outbox_id",
  "status",
] as const;

export const TECHNICAL_ALARM_DEFAULT_BATCH_LIMIT = 25;
export const TECHNICAL_ALARM_DEFAULT_LEASE_SECONDS = 60;
export const TECHNICAL_ALARM_DEFAULT_SEND_TIMEOUT_MS = 10_000;
export const TECHNICAL_ALARM_DEFAULT_MAX_ATTEMPTS = 5;
export const TECHNICAL_ALARM_DEFAULT_BACKOFF_BASE_SECONDS = 30;
export const TECHNICAL_ALARM_DEFAULT_BACKOFF_MAX_SECONDS = 3600;

export const CLAIM_DUE_ORDER_SQL = [
  "with candidate as (",
  "  select o.outbox_id",
  "    from technical_alarm_outbox o",
  "   where o.status in ('pending', 'leased')",
  "     and (o.next_attempt_at is null or o.next_attempt_at <= $1::timestamptz)",
  "     and (o.lease_expires_at is null or o.lease_expires_at <= $1::timestamptz)",
  "   order by o.outbox_id",
  "   limit 1",
  "   for update skip locked",
  ")",
  "update technical_alarm_outbox o",
  "   set status = 'leased',",
  "       lease_owner = $2,",
  "       lease_expires_at = $3::timestamptz,",
  "       updated_at = $1::timestamptz",
  "  from candidate c, technical_alarm_episodes e",
  " where o.outbox_id = c.outbox_id",
  "   and e.episode_id = o.episode_id",
  "returning o.outbox_id::text as outbox_id,",
  "          o.episode_id::text as episode_id,",
  "          o.resource_id,",
  "          o.attempt_count,",
  "          o.next_attempt_at,",
  "          e.error_code,",
  "          e.fault_started_at",
].join("\n");

export const FINISH_CLAIMED_ORDER_SQL = [
  "update technical_alarm_outbox",
  "   set status = $2,",
  "       attempt_count = attempt_count + $3,",
  "       next_attempt_at = $4::timestamptz,",
  "       lease_owner = null,",
  "       lease_expires_at = null,",
  "       last_error_code = $5,",
  "       updated_at = $6::timestamptz",
  " where outbox_id = $1::bigint",
  "   and status = 'leased'",
  "   and lease_owner = $7",
  "returning outbox_id::text as outbox_id,",
  "          status,",
  "          attempt_count,",
  "          next_attempt_at,",
  "          last_error_code",
].join("\n");

export interface DispatchPendingOptions {
  pool: TechnicalAlarmSqlPool;
  /**
   * Austauschbarer Adapter. Fehlt er, wird der Auftrag sichtbar blockiert.
   * Es gibt keinen Standardtransport.
   */
  sender?: AlarmSender | null;
  /** Injizierte Uhr; es gibt keinen versteckten Produktionsdefault. */
  now: () => Date;
  /** Konfigurierbares Batchlimit je Lauf. */
  batchLimit?: number;
  /** Befristete Lease, nach deren Ablauf der Auftrag erneut faellig ist. */
  leaseSeconds?: number;
  /** Obergrenze fuer einen Adapteraufruf. */
  sendTimeoutMs?: number;
  /** Nach so vielen erfolglosen Versuchen wird der Auftrag endgueltig failed. */
  maxAttempts?: number;
  backoffBaseSeconds?: number;
  backoffMaxSeconds?: number;
  auditWriter?: TechnicalAlarmAuditWriter;
}

export type DispatchOrderOutcome =
  | "sent"
  | "retry_scheduled"
  | "failed"
  | "blocked"
  | "claim_lost";

export interface DispatchOrderResult {
  outboxId: number;
  episodeId: number;
  outcome: DispatchOrderOutcome;
  errorCode: string | null;
}

export interface DispatchPendingResult {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  blocked: number;
  claimLost: number;
  orders: DispatchOrderResult[];
}

interface ClaimedOrderRow extends Record<string, unknown> {
  outbox_id: string | number;
  episode_id: string | number;
  resource_id: string;
  attempt_count: number | string;
  next_attempt_at: Date | string | null;
  error_code: string;
  fault_started_at: Date | string;
}

interface FinishRow extends Record<string, unknown> {
  outbox_id: string | number;
  status: string;
  attempt_count: number | string;
  next_attempt_at: Date | string | null;
  last_error_code: string | null;
}

interface ClaimedOrder {
  outboxId: number;
  episodeId: number;
  resourceId: string;
  attemptCount: number;
  nextAttemptAt: Date | null;
  errorCode: string;
  faultStartedAt: Date;
  claimId: string;
}

interface Settings {
  batchLimit: number;
  leaseSeconds: number;
  sendTimeoutMs: number;
  maxAttempts: number;
  backoffBaseSeconds: number;
  backoffMaxSeconds: number;
}

function readInteger(
  value: unknown,
  fallback: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  const candidate = value === undefined ? fallback : value;
  if (
    typeof candidate !== "number" ||
    !Number.isSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw new TechnicalAlarmInputError(
      field +
        " muss eine sichere Ganzzahl zwischen " +
        minimum +
        " und " +
        maximum +
        " sein.",
    );
  }
  return candidate;
}

function readSettings(options: DispatchPendingOptions): Settings {
  const settings: Settings = {
    batchLimit: readInteger(
      options.batchLimit,
      TECHNICAL_ALARM_DEFAULT_BATCH_LIMIT,
      "batchLimit",
      1,
      1000,
    ),
    leaseSeconds: readInteger(
      options.leaseSeconds,
      TECHNICAL_ALARM_DEFAULT_LEASE_SECONDS,
      "leaseSeconds",
      1,
      86_400,
    ),
    sendTimeoutMs: readInteger(
      options.sendTimeoutMs,
      TECHNICAL_ALARM_DEFAULT_SEND_TIMEOUT_MS,
      "sendTimeoutMs",
      1,
      600_000,
    ),
    maxAttempts: readInteger(
      options.maxAttempts,
      TECHNICAL_ALARM_DEFAULT_MAX_ATTEMPTS,
      "maxAttempts",
      1,
      1000,
    ),
    backoffBaseSeconds: readInteger(
      options.backoffBaseSeconds,
      TECHNICAL_ALARM_DEFAULT_BACKOFF_BASE_SECONDS,
      "backoffBaseSeconds",
      1,
      86_400,
    ),
    backoffMaxSeconds: readInteger(
      options.backoffMaxSeconds,
      TECHNICAL_ALARM_DEFAULT_BACKOFF_MAX_SECONDS,
      "backoffMaxSeconds",
      1,
      604_800,
    ),
  };
  if (settings.backoffMaxSeconds < settings.backoffBaseSeconds) {
    throw new TechnicalAlarmInputError(
      "backoffMaxSeconds darf nicht kleiner als backoffBaseSeconds sein.",
    );
  }
  return settings;
}

function parseId(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TechnicalAlarmStorageError(
      "Gespeicherter Wert fuer " + field + " ist ungueltig.",
    );
  }
  return parsed;
}

function parseCount(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TechnicalAlarmStorageError(
      "Gespeicherter Wert fuer " + field + " ist ungueltig.",
    );
  }
  return parsed;
}

function parseTime(value: Date | string, field: string): Date {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new TechnicalAlarmStorageError(
      "Gespeicherter Zeitpunkt fuer " + field + " ist ungueltig.",
    );
  }
  return new Date(ms);
}

function parseTimeOrNull(value: Date | string | null): Date | null {
  return value === null ? null : parseTime(value, "next_attempt_at");
}

function toClaimedOrder(row: ClaimedOrderRow, claimId: string): ClaimedOrder {
  return {
    outboxId: parseId(row.outbox_id, "outbox_id"),
    episodeId: parseId(row.episode_id, "episode_id"),
    resourceId: row.resource_id,
    attemptCount: parseCount(row.attempt_count, "attempt_count"),
    nextAttemptAt: parseTimeOrNull(row.next_attempt_at),
    errorCode: row.error_code,
    faultStartedAt: parseTime(row.fault_started_at, "fault_started_at"),
    claimId,
  };
}

/** Exponentialbackoff in Sekunden; 30 s, 60 s, ... bis zur Obergrenze. */
export function backoffSeconds(
  attempt: number,
  baseSeconds: number,
  maxSeconds: number,
): number {
  const exponent = Math.max(0, attempt - 1);
  const raw = baseSeconds * Math.pow(2, exponent);
  return Math.min(raw, maxSeconds);
}

function messageFor(order: ClaimedOrder): AlarmDeliveryMessage {
  return {
    alarmId: String(order.episodeId),
    resourceRef: order.resourceId,
    errorCode: validateErrorCode(order.errorCode),
    occurredAt: order.faultStartedAt.toISOString(),
  };
}

function deliveryAuditDetails(
  order: ClaimedOrder,
  status: string,
  attemptCount: number,
  errorCode: string | null,
  nextAttemptAt: Date | null,
): Record<string, unknown> {
  return {
    alarm_id: String(order.episodeId),
    attempt_count: attemptCount,
    error_code: errorCode,
    next_attempt_at: nextAttemptAt === null ? null : nextAttemptAt.toISOString(),
    occurred_at: order.faultStartedAt.toISOString(),
    outbox_id: String(order.outboxId),
    status,
  };
}

function blockedOutcome(): AlarmSendOutcome {
  return { kind: "blocked", reason: "sender_missing" };
}

/**
 * Ruft den Adapter mit Timeout und Abbruchsignal auf. Fehler werden auf feste,
 * protokollierbare Codes abgebildet; Rohtexte werden nie weitergereicht.
 */
async function invokeSender(
  sender: AlarmSender,
  message: AlarmDeliveryMessage,
  timeoutMs: number,
): Promise<AlarmSendOutcome> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<AlarmSendOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "retryable", errorCode: "timeout" });
    }, timeoutMs);
  });
  try {
    const sending = Promise.resolve()
      .then(() => sender.send(message, { signal: controller.signal }))
      .catch((): AlarmSendOutcome => {
        if (controller.signal.aborted) {
          return { kind: "retryable", errorCode: "timeout" };
        }
        return { kind: "retryable", errorCode: "transport_error" };
      });
    return await Promise.race([sending, timedOut]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

interface FinishPlan {
  status: "pending" | "sent" | "failed";
  attemptIncrement: number;
  nextAttemptAt: Date | null;
  errorCode: string | null;
  action: string;
}

function planForOutcome(
  order: ClaimedOrder,
  outcome: AlarmSendOutcome,
  now: Date,
  settings: Settings,
): FinishPlan {
  if (outcome.kind === "blocked") {
    return {
      status: "pending",
      attemptIncrement: 0,
      // Unveraendert: der Auftrag bleibt sofort erneut bearbeitbar, sobald
      // Transport oder Zielkonfiguration vorhanden sind.
      nextAttemptAt: order.nextAttemptAt,
      errorCode: outcome.reason,
      action: TECHNICAL_ALARM_DELIVERY_BLOCKED_ACTION,
    };
  }

  if (outcome.kind === "sent") {
    return {
      status: "sent",
      attemptIncrement: 1,
      nextAttemptAt: null,
      errorCode: null,
      action: TECHNICAL_ALARM_DELIVERY_SENT_ACTION,
    };
  }

  if (outcome.kind === "permanent") {
    return {
      status: "failed",
      attemptIncrement: 1,
      nextAttemptAt: null,
      errorCode: outcome.errorCode,
      action: TECHNICAL_ALARM_DELIVERY_FAILED_ACTION,
    };
  }

  const attempt = order.attemptCount + 1;
  if (attempt >= settings.maxAttempts) {
    return {
      status: "failed",
      attemptIncrement: 1,
      nextAttemptAt: null,
      errorCode: outcome.errorCode,
      action: TECHNICAL_ALARM_DELIVERY_FAILED_ACTION,
    };
  }

  const retryAfter =
    outcome.retryAfterSeconds !== undefined &&
    outcome.retryAfterSeconds !== null &&
    outcome.retryAfterSeconds > 0
      ? outcome.retryAfterSeconds
      : backoffSeconds(
          attempt,
          settings.backoffBaseSeconds,
          settings.backoffMaxSeconds,
        );
  return {
    status: "pending",
    attemptIncrement: 1,
    nextAttemptAt: new Date(now.getTime() + retryAfter * 1000),
    errorCode: outcome.errorCode,
    action: TECHNICAL_ALARM_DELIVERY_RETRY_ACTION,
  };
}

/**
 * Beansprucht bis zu batchLimit faellige Auftraege atomar in einer
 * Transaktion. SKIP LOCKED verhindert, dass zwei Laeufe denselben Auftrag
 * erhalten; die Lease macht den Anspruch nach Ablauf wieder aufnehmbar.
 */
async function claimDueOrders(
  pool: TechnicalAlarmSqlPool,
  now: Date,
  settings: Settings,
): Promise<ClaimedOrder[]> {
  const client = await pool.connect();
  const claimed: ClaimedOrder[] = [];
  let inTransaction = false;
  try {
    await client.query("begin");
    inTransaction = true;
    const leaseExpiresAt = new Date(
      now.getTime() + settings.leaseSeconds * 1000,
    );
    for (let index = 0; index < settings.batchLimit; index += 1) {
      const claimId = "cx029-" + randomUUID();
      const result = await client.query<ClaimedOrderRow>(
        CLAIM_DUE_ORDER_SQL,
        [now, claimId, leaseExpiresAt],
      );
      if (result.rows.length === 0) {
        break;
      }
      claimed.push(toClaimedOrder(result.rows[0], claimId));
    }
    await client.query("commit");
    inTransaction = false;
    return claimed;
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

/**
 * Speichert Versuchsergebnis und Audit-Ereignis atomar -- aber nur, wenn die
 * Claim-ID noch gilt. Ein zwischenzeitlich neu vergebener Claim verwirft das
 * Ergebnis, statt einen fremden Anspruch zu ueberschreiben.
 */
async function finishOrder(
  pool: TechnicalAlarmSqlPool,
  auditWriter: TechnicalAlarmAuditWriter | undefined,
  order: ClaimedOrder,
  plan: FinishPlan,
  now: Date,
): Promise<number | null> {
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query("begin");
    inTransaction = true;
    const result = await client.query<FinishRow>(FINISH_CLAIMED_ORDER_SQL, [
      order.outboxId,
      plan.status,
      plan.attemptIncrement,
      plan.nextAttemptAt,
      plan.errorCode,
      now,
      order.claimId,
    ]);
    if (result.rows.length === 0) {
      await client.query("rollback");
      inTransaction = false;
      return null;
    }
    const storedAttempts = parseCount(
      result.rows[0].attempt_count,
      "attempt_count",
    );
    const event: AuditEventInput = {
      at: now,
      actorType: "system",
      actorId: null,
      action: plan.action,
      targetType: TECHNICAL_ALARM_DELIVERY_TARGET_TYPE,
      targetId: String(order.outboxId),
      details: deliveryAuditDetails(
        order,
        plan.status,
        storedAttempts,
        plan.errorCode,
        plan.nextAttemptAt,
      ),
    };
    if (auditWriter !== undefined) {
      await auditWriter(client, event);
    } else {
      await insertAuditEvent(client, event);
    }
    await client.query("commit");
    inTransaction = false;
    return storedAttempts;
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

/**
 * Ein begrenzter Versandlauf. Kein Timer, keine oeffentliche API und keine
 * Telegram-Verbindung ohne injizierten Transport.
 */
export async function dispatchPending(
  options: DispatchPendingOptions,
): Promise<DispatchPendingResult> {
  const settings = readSettings(options);
  if (typeof options.now !== "function") {
    throw new TechnicalAlarmInputError("now muss eine injizierte Uhr sein.");
  }
  const now = options.now();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TechnicalAlarmInputError(
      "Die injizierte Uhr liefert keinen gueltigen Zeitpunkt.",
    );
  }

  const claimed = await claimDueOrders(options.pool, now, settings);
  const result: DispatchPendingResult = {
    claimed: claimed.length,
    sent: 0,
    retried: 0,
    failed: 0,
    blocked: 0,
    claimLost: 0,
    orders: [],
  };

  for (const order of claimed) {
    let outcome: AlarmSendOutcome;
    if (options.sender === null || options.sender === undefined) {
      outcome = blockedOutcome();
    } else {
      let message: AlarmDeliveryMessage;
      try {
        message = messageFor(order);
      } catch {
        // Defensiv: eine gespeicherte, aber ungueltige Episode wird sichtbar
        // beendet, ohne einen Adapteraufruf zu erfinden.
        const stored = await finishOrder(
          options.pool,
          options.auditWriter,
          order,
          {
            status: "failed",
            attemptIncrement: 0,
            nextAttemptAt: null,
            errorCode: "invalid_error_code",
            action: TECHNICAL_ALARM_DELIVERY_FAILED_ACTION,
          },
          now,
        );
        result.orders.push({
          outboxId: order.outboxId,
          episodeId: order.episodeId,
          outcome: stored === null ? "claim_lost" : "failed",
          errorCode: "invalid_error_code",
        });
        if (stored === null) {
          result.claimLost += 1;
        } else {
          result.failed += 1;
        }
        continue;
      }
      outcome = await invokeSender(
        options.sender,
        message,
        settings.sendTimeoutMs,
      );
    }

    const plan = planForOutcome(order, outcome, now, settings);
    const stored = await finishOrder(
      options.pool,
      options.auditWriter,
      order,
      plan,
      now,
    );

    if (stored === null) {
      result.claimLost += 1;
      result.orders.push({
        outboxId: order.outboxId,
        episodeId: order.episodeId,
        outcome: "claim_lost",
        errorCode: plan.errorCode,
      });
      continue;
    }

    const outcomeName: DispatchOrderOutcome =
      plan.status === "sent"
        ? "sent"
        : plan.status === "failed"
          ? "failed"
          : plan.action === TECHNICAL_ALARM_DELIVERY_BLOCKED_ACTION
            ? "blocked"
            : "retry_scheduled";
    result.orders.push({
      outboxId: order.outboxId,
      episodeId: order.episodeId,
      outcome: outcomeName,
      errorCode: plan.errorCode,
    });
    if (outcomeName === "sent") {
      result.sent += 1;
    } else if (outcomeName === "failed") {
      result.failed += 1;
    } else if (outcomeName === "blocked") {
      result.blocked += 1;
    } else {
      result.retried += 1;
    }
  }

  return result;
}
