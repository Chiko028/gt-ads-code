import type { SqlQueryable } from "../audit/repository.js";

export interface DeviceAuthRow {
  id: string;
  state: "active" | "revoked";
  public_key_spki: Buffer;
  last_seen_at: Date;
}

export interface ChallengeRow {
  id: string;
}

export interface TokenWithDeviceRow {
  token_id: string;
  device_id: string;
  token_expires_at: Date;
  token_revoked_at: Date | null;
  device_state: "active" | "revoked";
}

export interface InsertChallengeInput {
  id: string;
  deviceId: string;
  nonceHash: Buffer;
  createdAt: Date;
  expiresAt: Date;
}

export interface InsertAccessTokenInput {
  id: string;
  deviceId: string;
  tokenHash: Buffer;
  createdAt: Date;
  expiresAt: Date;
}

const DEVICE_COLUMNS = [
  "id::text as id",
  "state",
  "public_key_spki",
  "last_seen_at",
].join(", ");

/** Laedt ein Geraet inklusive oeffentlichem Schluessel und Zustand. */
export async function findDeviceById(
  executor: SqlQueryable,
  deviceId: string,
): Promise<DeviceAuthRow | null> {
  const result = await executor.query<DeviceAuthRow>(
    "select " + DEVICE_COLUMNS + " from devices where id = $1",
    [deviceId],
  );
  return result.rows[0] ?? null;
}

/**
 * Laedt ein Geraet und sperrt die Zeile fuer die Dauer der Transaktion.
 * Dadurch wirkt eine Sperre auch bei gleichzeitiger Token-Ausstellung.
 */
export async function findDeviceByIdForUpdate(
  executor: SqlQueryable,
  deviceId: string,
): Promise<DeviceAuthRow | null> {
  const result = await executor.query<DeviceAuthRow>(
    "select " + DEVICE_COLUMNS + " from devices where id = $1 for update",
    [deviceId],
  );
  return result.rows[0] ?? null;
}

/** Speichert nur den Hash der Challenge-Nonce, nie die Nonce selbst. */
export async function insertChallenge(
  executor: SqlQueryable,
  input: InsertChallengeInput,
): Promise<void> {
  await executor.query(
    [
      "insert into device_auth_challenges",
      "  (id, device_id, nonce_hash, created_at, expires_at)",
      "values ($1, $2, $3, $4, $5)",
    ].join("\n"),
    [input.id, input.deviceId, input.nonceHash, input.createdAt, input.expiresAt],
  );
}

/**
 * Verbraucht eine Challenge atomar. Liefert nur dann eine Zeile, wenn sie zur
 * Device gehoert, noch nicht benutzt und nicht abgelaufen ist. Parallele
 * Einloesungen derselben Nonce koennen daher nicht beide gewinnen.
 */
export async function consumeChallenge(
  executor: SqlQueryable,
  input: { deviceId: string; nonceHash: Buffer; usedAt: Date },
): Promise<ChallengeRow | null> {
  const result = await executor.query<ChallengeRow>(
    [
      "update device_auth_challenges",
      "   set used_at = $3",
      " where device_id = $1",
      "   and nonce_hash = $2",
      "   and used_at is null",
      "   and expires_at > $3",
      " returning id::text as id",
    ].join("\n"),
    [input.deviceId, input.nonceHash, input.usedAt],
  );
  return result.rows[0] ?? null;
}

/** Speichert nur den Hash des Access-Tokens. */
export async function insertAccessToken(
  executor: SqlQueryable,
  input: InsertAccessTokenInput,
): Promise<void> {
  await executor.query(
    [
      "insert into device_access_tokens",
      "  (id, device_id, token_hash, created_at, expires_at)",
      "values ($1, $2, $3, $4, $5)",
    ].join("\n"),
    [input.id, input.deviceId, input.tokenHash, input.createdAt, input.expiresAt],
  );
}

/**
 * Laedt Token und Geraetezustand. Gueltigkeit (Ablauf, Widerruf) wird im
 * Service geprueft, damit die Sperre eines Geraets sofort wirkt (AC-08).
 */
export async function findTokenWithDevice(
  executor: SqlQueryable,
  tokenHash: Buffer,
): Promise<TokenWithDeviceRow | null> {
  const result = await executor.query<TokenWithDeviceRow>(
    [
      "select t.id::text as token_id,",
      "       t.device_id::text as device_id,",
      "       t.expires_at as token_expires_at,",
      "       t.revoked_at as token_revoked_at,",
      "       d.state as device_state",
      "  from device_access_tokens t",
      "  join devices d on d.id = t.device_id",
      " where t.token_hash = $1",
    ].join("\n"),
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

/** Setzt den letzten authentifizierten Kontakt auf Serverzeit. */
export async function updateLastSeenAt(
  executor: SqlQueryable,
  deviceId: string,
  at: Date,
): Promise<void> {
  await executor.query("update devices set last_seen_at = $2 where id = $1", [
    deviceId,
    at,
  ]);
}
