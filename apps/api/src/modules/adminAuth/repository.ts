import type { SqlQueryable } from "../audit/repository.js";

/** Zeile der Admin-Sitzung; das Token selbst wird nie gespeichert. */
export interface AdminSessionRow {
  id: string;
  expires_at: Date;
}

export interface InsertAdminSessionInput {
  id: string;
  tokenHash: Buffer;
  createdAt: Date;
  expiresAt: Date;
}

/** Speichert nur den SHA-256-Hash des Sitzungstokens (ARCHITEKTUR.md 3). */
export async function insertAdminSession(
  executor: SqlQueryable,
  input: InsertAdminSessionInput,
): Promise<void> {
  await executor.query(
    [
      "insert into admin_sessions",
      "  (id, token_hash, created_at, expires_at)",
      "values ($1, $2, $3, $4)",
    ].join("\n"),
    [input.id, input.tokenHash, input.createdAt, input.expiresAt],
  );
}

/** Laedt eine Sitzung ueber den Hash des Tokens. */
export async function findAdminSessionByTokenHash(
  executor: SqlQueryable,
  tokenHash: Buffer,
): Promise<AdminSessionRow | null> {
  const result = await executor.query<AdminSessionRow>(
    "select id::text as id, expires_at from admin_sessions where token_hash = $1",
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
