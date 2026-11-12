import type { SqlQueryable } from "../modules/audit/repository.js";

/**
 * Aufbewahrung abgelaufener Authentifizierungsartefakte (ARCHITEKTUR.md 3):
 * Challenges, Tokens und Admin-Sitzungen werden erst 24 h nach Ablauf
 * geloescht; Codes, Geraete und Audit-Eintraege bleiben erhalten.
 */
export const EXPIRED_AUTH_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Standardintervall der Bereinigung: stuendlich (ARCHITEKTUR.md 3). */
export const AUTH_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface AuthCleanupResult {
  challenges: number;
  tokens: number;
  sessions: number;
}

/**
 * Loescht abgelaufene Challenges, Access-Tokens und Admin-Sitzungen, die
 * laenger als die Aufbewahrungsfrist abgelaufen sind. Gibt die Anzahl der
 * geloeschten Zeilen je Tabelle zurueck (fuer Tests/Protokoll).
 */
export async function cleanupExpiredAuthArtifacts(
  executor: SqlQueryable,
  now: Date = new Date(),
): Promise<AuthCleanupResult> {
  const cutoff = new Date(now.getTime() - EXPIRED_AUTH_RETENTION_MS);

  const challenges = await executor.query(
    "delete from device_auth_challenges where expires_at < $1",
    [cutoff],
  );
  const tokens = await executor.query(
    "delete from device_access_tokens where expires_at < $1",
    [cutoff],
  );
  const sessions = await executor.query(
    "delete from admin_sessions where expires_at < $1",
    [cutoff],
  );

  return {
    challenges: challenges.rowCount ?? 0,
    tokens: tokens.rowCount ?? 0,
    sessions: sessions.rowCount ?? 0,
  };
}

export interface AuthCleanupScheduleOptions {
  executor: SqlQueryable;
  now?: () => Date;
  intervalMs?: number;
  /** Optionaler Fehlerpfad; Bereinigung darf den Start nicht verhindern. */
  onError?: (error: unknown) => void;
}

/**
 * Fuehrt die Bereinigung sofort und danach periodisch aus. Der Timer haelt
 * den Prozess nicht am Leben (unref) und wird von der Rueckgabefunktion
 * gestoppt.
 */
export function startExpiredAuthCleanup(
  options: AuthCleanupScheduleOptions,
): () => void {
  const now = options.now ?? (() => new Date());
  const run = (): void => {
    void cleanupExpiredAuthArtifacts(options.executor, now()).catch((error) => {
      options.onError?.(error);
    });
  };

  run();
  const timer = setInterval(run, options.intervalMs ?? AUTH_CLEANUP_INTERVAL_MS);
  timer.unref();

  return () => {
    clearInterval(timer);
  };
}
