import type { SqlQueryable } from "../audit/repository.js";

/** Zeile der Admin-Sitzung; das Token selbst wird nie gespeichert. */
export interface AdminSessionRow {
  id: string;
  expires_at: Date;
  /**
   * Stabile Actor-ID der Sitzung. NULL kennzeichnet die bisherige
   * konfigurierte Administrationsidentitaet (legacy-admin); Operator-
   * Sitzungen tragen hier ihre persistente actor_id.
   */
  actor_id: string | null;
}

export interface InsertAdminSessionInput {
  id: string;
  tokenHash: Buffer;
  createdAt: Date;
  expiresAt: Date;
  /** Nur fuer persistente Operatorkonten; Legacy-Sitzungen lassen ihn weg. */
  actorId?: string | null;
}

/**
 * Speichert nur den SHA-256-Hash des Sitzungstokens (ARCHITEKTUR.md 3).
 * Legacy-Sitzungen bleiben ohne actor_id, damit bestehende Datenbanken ohne
 * Migration 0015 weiter funktionieren. Operator-Sitzungen schreiben die
 * stabile Actor-ID in derselben Zeile.
 */
export async function insertAdminSession(
  executor: SqlQueryable,
  input: InsertAdminSessionInput,
): Promise<void> {
  if (input.actorId === undefined || input.actorId === null) {
    await executor.query(
      [
        "insert into admin_sessions",
        "  (id, token_hash, created_at, expires_at)",
        "values ($1, $2, $3, $4)",
      ].join("\n"),
      [input.id, input.tokenHash, input.createdAt, input.expiresAt],
    );
    return;
  }
  await executor.query(
    [
      "insert into admin_sessions",
      "  (id, token_hash, created_at, expires_at, actor_id)",
      "values ($1, $2, $3, $4, $5::uuid)",
    ].join("\n"),
    [
      input.id,
      input.tokenHash,
      input.createdAt,
      input.expiresAt,
      input.actorId,
    ],
  );
}

/**
 * Laedt eine Sitzung ueber den Hash des Tokens. actor_id wird ueber to_jsonb
 * gelesen, damit derselbe Code auch auf Datenbanken ohne Migration 0015
 * laeuft (dort ist das Feld schlicht NULL).
 */
export async function findAdminSessionByTokenHash(
  executor: SqlQueryable,
  tokenHash: Buffer,
): Promise<AdminSessionRow | null> {
  const result = await executor.query<AdminSessionRow>(
    [
      "select s.id::text as id, s.expires_at,",
      "       to_jsonb(s) ->> 'actor_id' as actor_id",
      "  from admin_sessions s",
      " where s.token_hash = $1",
    ].join("\n"),
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

/** Loescht eine Sitzung (Logout). Liefert die Anzahl geloeschter Zeilen. */
export async function deleteAdminSessionByTokenHash(
  executor: SqlQueryable,
  tokenHash: Buffer,
): Promise<number> {
  const result = await executor.query(
    "delete from admin_sessions where token_hash = $1",
    [tokenHash],
  );
  return result.rowCount ?? 0;
}

export type OperatorStatus = "active" | "disabled";

/** Persistente Operatorzeile; der Klartext des Passworts existiert nie. */
export interface OperatorRow {
  actor_id: string;
  username: string;
  password_hash: string;
  status: OperatorStatus;
  created_at: Date;
  disabled_at: Date | null;
}

export interface InsertOperatorInput {
  actorId: string;
  username: string;
  passwordHash: string;
  createdAt: Date;
}

/** Legt genau ein Operatorkonto an; ein Unique-Verstoss bleibt beim Aufrufer. */
export async function insertOperator(
  executor: SqlQueryable,
  input: InsertOperatorInput,
): Promise<void> {
  await executor.query(
    [
      "insert into operators",
      "  (actor_id, username, password_hash, status, created_at, disabled_at)",
      "values ($1::uuid, $2, $3, 'active', $4, null)",
    ].join("\n"),
    [input.actorId, input.username, input.passwordHash, input.createdAt],
  );
}

/** Gezielte Suche ausschliesslich ueber die normalisierte Kennung. */
export async function findOperatorByUsername(
  executor: SqlQueryable,
  username: string,
): Promise<OperatorRow | null> {
  const result = await executor.query<OperatorRow>(
    [
      "select actor_id::text as actor_id, username, password_hash, status,",
      "       created_at, disabled_at",
      "  from operators",
      " where username = $1",
    ].join("\n"),
    [username],
  );
  return result.rows[0] ?? null;
}

/** Frischer Statuscheck je Autorisierung; es gibt keinen Aktivitaetscache. */
export async function findOperatorStatusById(
  executor: SqlQueryable,
  actorId: string,
): Promise<OperatorStatus | null> {
  const result = await executor.query<{ status: OperatorStatus }>(
    "select status from operators where actor_id = $1::uuid",
    [actorId],
  );
  return result.rows[0]?.status ?? null;
}

export interface OperatorForUpdateRow {
  actor_id: string;
  username: string;
  status: OperatorStatus;
}

/** Sperrt die Operatorzeile in der laufenden Transaktion. */
export async function findOperatorForUpdate(
  executor: SqlQueryable,
  actorId: string,
): Promise<OperatorForUpdateRow | null> {
  const result = await executor.query<OperatorForUpdateRow>(
    [
      "select actor_id::text as actor_id, username, status",
      "  from operators",
      " where actor_id = $1::uuid",
      "   for update",
    ].join("\n"),
    [actorId],
  );
  return result.rows[0] ?? null;
}

/**
 * Sperrt genau ein noch aktives Konto. Die Bedingung status = 'active'
 * macht die Wiederholung wirkungslos (rowCount 0, kein zweiter Audit).
 */
export async function markOperatorDisabled(
  executor: SqlQueryable,
  actorId: string,
  disabledAt: Date,
): Promise<number> {
  const result = await executor.query(
    [
      "update operators",
      "   set status = 'disabled', disabled_at = $2",
      " where actor_id = $1::uuid",
      "   and status = 'active'",
    ].join("\n"),
    [actorId, disabledAt],
  );
  return result.rowCount ?? 0;
}
