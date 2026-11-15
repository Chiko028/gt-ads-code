import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { PENDING_TOTP_ENROLLMENT_TTL_MS } from "./pendingTotpEnrollment.js";

/**
 * CX-066 Review-Korrektur: gemeinsame, persistente Login-Challenge beider
 * zweiter Faktoren (TOTP und Wiederherstellungscode). Beide Routen sperren
 * dieselbe Zeile je Vorsitzung und erhoehen denselben Fehlversuchszaehler.
 */

export interface LoginChallengeRow {
  id: string;
  expires_at: Date;
  failed_attempts: number;
  consumed_at: Date | null;
  locked_at: Date | null;
}

/**
 * Legt die Challenge bei Bedarf an und sperrt sie in der laufenden
 * Transaktion. Die Lebensdauer ist wie bisher durch die vorhandene
 * MFA-Frist und die Sitzungsablaufzeit begrenzt.
 */
export async function lockLoginChallenge(
  client: Pick<PoolClient, "query">,
  sessionId: string,
  actorId: string,
  at: Date,
  sessionExpiresAt: Date,
): Promise<LoginChallengeRow | null> {
  const expiresAt = new Date(
    Math.min(
      at.getTime() + PENDING_TOTP_ENROLLMENT_TTL_MS,
      sessionExpiresAt.getTime(),
    ),
  );
  await client.query(
    [
      "insert into admin_mfa_recovery_challenges",
      "  (id, session_id, actor_id, created_at, expires_at,",
      "   failed_attempts, consumed_at, locked_at)",
      "values ($1, $2::uuid, $3, $4, $5, 0, null, null)",
      "on conflict (session_id) do nothing",
    ].join("\n"),
    [randomUUID(), sessionId, actorId, at, expiresAt],
  );
  const result = await client.query<LoginChallengeRow>(
    [
      "select id::text as id, expires_at, failed_attempts,",
      "       consumed_at, locked_at",
      "  from admin_mfa_recovery_challenges",
      " where session_id = $1::uuid",
      "   for update",
    ].join("\n"),
    [sessionId],
  );
  return result.rows[0] ?? null;
}

/** Eine Challenge ist nur offen, nicht abgelaufen und nicht gesperrt. */
export function isLoginChallengeUsable(
  challenge: LoginChallengeRow,
  at: Date,
  maxAttempts: number,
): boolean {
  return (
    challenge.consumed_at === null &&
    challenge.locked_at === null &&
    at.getTime() < challenge.expires_at.getTime() &&
    challenge.failed_attempts < maxAttempts
  );
}

/**
 * Erhoeht den persistenten Fehlversuchszaehler und sperrt die Challenge
 * genau an der vorhandenen Grenze. Liefert true, wenn die Sperre erreicht ist.
 */
export async function recordLoginChallengeFailure(
  client: Pick<PoolClient, "query">,
  challengeId: string,
  maxAttempts: number,
  at: Date,
): Promise<boolean> {
  const result = await client.query<{ locked_at: Date | null }>(
    [
      "update admin_mfa_recovery_challenges",
      "   set failed_attempts = failed_attempts + 1,",
      "       locked_at = case",
      "         when failed_attempts + 1 >= $2 then $3",
      "         else locked_at",
      "       end",
      " where id = $1::uuid",
      "   and consumed_at is null",
      "   and locked_at is null",
      "returning locked_at",
    ].join("\n"),
    [challengeId, maxAttempts, at],
  );
  return result.rows[0]?.locked_at != null;
}

/** Verbraucht die Challenge genau einmal; parallele Aufrufer verlieren. */
export async function consumeLoginChallenge(
  client: Pick<PoolClient, "query">,
  challengeId: string,
  at: Date,
): Promise<boolean> {
  const result = await client.query(
    [
      "update admin_mfa_recovery_challenges",
      "   set consumed_at = $2",
      " where id = $1::uuid",
      "   and consumed_at is null",
      "   and locked_at is null",
      "returning id::text as id",
    ].join("\n"),
    [challengeId, at],
  );
  return (result.rowCount ?? 0) === 1;
}

