import type { SqlQueryable } from "../audit/repository.js";

export interface RegistrationCodeRow {
  id: string;
  label: string | null;
  created_at: Date;
  created_by: string;
  expires_at: Date;
  used_at: Date | null;
  used_by_device_id: string | null;
  revoked_at: Date | null;
  revoked_by: string | null;
}

export interface DeviceRow {
  id: string;
  label: string | null;
  public_key_fingerprint: string;
  registration_request_id: string;
  state: "active" | "revoked";
  registered_at: Date;
  last_seen_at: Date;
}

export interface InsertRegistrationCodeInput {
  id: string;
  codeHash: Buffer;
  label: string | null;
  createdAt: Date;
  createdBy: string;
  expiresAt: Date;
}

export interface InsertDeviceInput {
  id: string;
  label: string | null;
  publicKeySpki: Buffer;
  publicKeyFingerprint: string;
  manufacturer: string;
  model: string;
  osVersion: string;
  sdkInt: number;
  appVersion: string;
  appFlavor: string;
  registrationCodeId: string;
  registrationRequestId: string;
  registeredAt: Date;
  lastSeenAt: Date;
}

const CODE_COLUMNS = [
  "id::text as id",
  "label",
  "created_at",
  "created_by",
  "expires_at",
  "used_at",
  "used_by_device_id::text as used_by_device_id",
  "revoked_at",
  "revoked_by",
].join(", ");

export async function insertRegistrationCode(
  executor: SqlQueryable,
  input: InsertRegistrationCodeInput,
): Promise<void> {
  await executor.query(
    [
      "insert into registration_codes",
      "  (id, code_hash, label, created_at, created_by, expires_at)",
      "values ($1, $2, $3, $4, $5, $6)",
    ].join("\n"),
    [
      input.id,
      input.codeHash,
      input.label,
      input.createdAt,
      input.createdBy,
      input.expiresAt,
    ],
  );
}

/**
 * Sperrt die Codezeile fuer die Dauer der Transaktion. Dadurch gewinnt bei
 * gleichzeitigen Registrierungen mit demselben Code genau eine (AC-02).
 */
export async function findCodeByHashForUpdate(
  executor: SqlQueryable,
  codeHash: Buffer,
): Promise<RegistrationCodeRow | null> {
  const result = await executor.query<RegistrationCodeRow>(
    "select " + CODE_COLUMNS + " from registration_codes where code_hash = $1 for update",
    [codeHash],
  );
  return result.rows[0] ?? null;
}

export async function findRegistrationCodeById(
  executor: SqlQueryable,
  id: string,
): Promise<RegistrationCodeRow | null> {
  const result = await executor.query<RegistrationCodeRow>(
    "select " + CODE_COLUMNS + " from registration_codes where id = $1",
    [id],
  );
  return result.rows[0] ?? null;
}

export async function findDeviceByRegistrationCodeId(
  executor: SqlQueryable,
  registrationCodeId: string,
): Promise<DeviceRow | null> {
  const result = await executor.query<DeviceRow>(
    [
      "select id::text as id, label, public_key_fingerprint,",
      "       registration_request_id::text as registration_request_id,",
      "       state, registered_at, last_seen_at",
      "  from devices",
      " where registration_code_id = $1",
      " order by registered_at asc",
      " limit 1",
    ].join("\n"),
    [registrationCodeId],
  );
  return result.rows[0] ?? null;
}

export async function findDeviceByFingerprint(
  executor: SqlQueryable,
  fingerprint: string,
): Promise<{ id: string } | null> {
  const result = await executor.query<{ id: string }>(
    "select id::text as id from devices where public_key_fingerprint = $1",
    [fingerprint],
  );
  return result.rows[0] ?? null;
}

export async function insertDevice(
  executor: SqlQueryable,
  input: InsertDeviceInput,
): Promise<void> {
  await executor.query(
    [
      "insert into devices",
      "  (id, label, public_key_spki, public_key_fingerprint, state,",
      "   manufacturer, model, os_version, sdk_int, app_version, app_flavor,",
      "   registration_code_id, registration_request_id,",
      "   registered_at, last_seen_at)",
      "values ($1, $2, $3, $4, 'active',",
      "        $5, $6, $7, $8, $9, $10,",
      "        $11, $12,",
      "        $13, $14)",
    ].join("\n"),
    [
      input.id,
      input.label,
      input.publicKeySpki,
      input.publicKeyFingerprint,
      input.manufacturer,
      input.model,
      input.osVersion,
      input.sdkInt,
      input.appVersion,
      input.appFlavor,
      input.registrationCodeId,
      input.registrationRequestId,
      input.registeredAt,
      input.lastSeenAt,
    ],
  );
}

/** Markiert den Code atomar als benutzt; false, wenn er schon benutzt war. */
export async function markCodeUsed(
  executor: SqlQueryable,
  codeId: string,
  usedAt: Date,
  deviceId: string,
): Promise<boolean> {
  const result = await executor.query(
    [
      "update registration_codes",
      "   set used_at = $2, used_by_device_id = $3",
      " where id = $1 and used_at is null",
      " returning id",
    ].join("\n"),
    [codeId, usedAt, deviceId],
  );
  return (result.rowCount ?? 0) === 1;
}

/** Widerruft einen noch unbenutzten Code; null, wenn nicht moeglich. */
export async function revokeUnusedCode(
  executor: SqlQueryable,
  codeId: string,
  revokedAt: Date,
  revokedBy: string,
): Promise<{ id: string } | null> {
  const result = await executor.query<{ id: string }>(
    [
      "update registration_codes",
      "   set revoked_at = $2, revoked_by = $3",
      " where id = $1 and used_at is null and revoked_at is null",
      " returning id::text as id",
    ].join("\n"),
    [codeId, revokedAt, revokedBy],
  );
  return result.rows[0] ?? null;
}

export async function listRegistrationCodes(
  executor: SqlQueryable,
): Promise<RegistrationCodeRow[]> {
  const result = await executor.query<RegistrationCodeRow>(
    "select " + CODE_COLUMNS + " from registration_codes order by created_at desc, id asc",
  );
  return result.rows;
}
