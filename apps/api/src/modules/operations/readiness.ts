import type { Pool, PoolClient, QueryConfig } from "pg";

/** Frist fuer Readiness und SQL-Abbruch laut CX-018. */
export const READINESS_TIMEOUT_MS = 1000;
export const READINESS_SQL = "SELECT 1";

export interface TimerScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Produktionsscheduler; Tests koennen eine kontrollierte Uhr injizieren. */
export const SYSTEM_SCHEDULER: TimerScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface QueryWithDeadlineOptions {
  timeoutMs?: number;
  scheduler?: TimerScheduler;
}

export interface DeadlineOptions {
  timeoutMs?: number;
  scheduler?: TimerScheduler;
}

function normalizedTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return READINESS_TIMEOUT_MS;
  }
  return Math.max(1, Math.floor(timeoutMs));
}

function readinessTimeoutError(): Error {
  const error = new Error("readiness_timeout");
  error.name = "ReadinessTimeoutError";
  return error;
}

/**
 * Fuehrt eine SQL-Anfrage mit wirksamer Frist aus.
 *
 * Die Frist wirkt auf drei Ebenen: PostgreSQL erhaelt ein
 * statement_timeout, der pg-Client ein query_timeout, und ein Waechter
 * beendet die Verbindung, falls selbst das Verbindungs-Holen haengt.
 * Damit bleibt bei einem Ablauf kein unbegrenztes Hintergrund-Promise
 * zurueck; die Verbindung wird verworfen.
 */
export function queryWithDeadline(
  pool: Pool,
  sql: string,
  options: QueryWithDeadlineOptions = {},
): Promise<unknown> {
  const timeoutMs = normalizedTimeout(options.timeoutMs);
  const scheduler = options.scheduler ?? SYSTEM_SCHEDULER;

  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let released = false;
    let client: PoolClient | undefined;
    let timer: unknown;

    const releaseClient = (error?: Error): void => {
      if (client === undefined || released) {
        return;
      }
      released = true;
      client.release(error);
    };

    const finish = (error?: unknown, value?: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      scheduler.clearTimeout(timer);
      if (error !== undefined) {
        reject(error);
      } else {
        resolve(value);
      }
    };

    timer = scheduler.setTimeout(() => {
      timedOut = true;
      releaseClient(readinessTimeoutError());
      finish(readinessTimeoutError());
    }, timeoutMs);

    pool.connect().then(
      async (acquired) => {
        client = acquired;
        if (timedOut) {
          releaseClient();
          return;
        }

        try {
          await acquired.query(
            "SET statement_timeout = " + String(timeoutMs),
          );
          if (timedOut) {
            return;
          }

          const result = await acquired.query({
            text: sql,
            query_timeout: timeoutMs,
          } as QueryConfig & { query_timeout: number });

          if (timedOut) {
            return;
          }

          try {
            await acquired.query("RESET statement_timeout");
          } catch {
            // Die Verbindung wird unten freigegeben; ein fehlgeschlagenes
            // RESET darf das Ergebnis von SELECT 1 nicht veraendern.
          }

          if (timedOut) {
            return;
          }
          releaseClient();
          finish(undefined, result);
        } catch (error: unknown) {
          try {
            await acquired.query("RESET statement_timeout");
          } catch {
            // Verbindung wird verworfen bzw. freigegeben.
          }

          if (timedOut) {
            releaseClient(error instanceof Error ? error : undefined);
            return;
          }
          releaseClient();
          finish(error);
        }
      },
      (error: unknown) => {
        finish(error);
      },
    );
  });
}

/** Waechter fuer die HTTP-Antwort, auch bei einem fehlerhaften Adapter. */
export function withDeadline<T>(
  operation: Promise<T>,
  options: DeadlineOptions = {},
): Promise<T> {
  const timeoutMs = normalizedTimeout(options.timeoutMs);
  const scheduler = options.scheduler ?? SYSTEM_SCHEDULER;

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const finish = (error?: unknown, value?: T): void => {
      if (settled) {
        return;
      }
      settled = true;
      scheduler.clearTimeout(timer);
      if (error !== undefined) {
        reject(error);
      } else {
        resolve(value as T);
      }
    };

    const timer = scheduler.setTimeout(() => {
      finish(readinessTimeoutError());
    }, timeoutMs);

    operation.then(
      (value) => finish(undefined, value),
      (error: unknown) => finish(error),
    );
  });
}

export interface ReadinessProbe {
  /** Loest ein; jeder Fehler oder Ablauf bedeutet not_ready. */
  check(): Promise<void>;
}

/** PostgreSQL-Adapter: SELECT 1 ueber den vorhandenen Pool. */
export function createPostgresReadinessProbe(
  pool: Pool,
  options: QueryWithDeadlineOptions = {},
): ReadinessProbe {
  return {
    async check(): Promise<void> {
      await queryWithDeadline(pool, READINESS_SQL, options);
    },
  };
}
