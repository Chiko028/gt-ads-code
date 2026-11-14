import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

/**
 * CX-106 / R-605: ausstehende TOTP-Einrichtung eines Admins.
 * Arbeitet nur in der Transaktion des Aufrufers: keine eigene
 * Transaktionssteuerung, kein Scheduler, keine Loeschung, keine Aktivierung.
 */
export const PENDING_TOTP_ENROLLMENT_TTL_MS = 10 * 60 * 1000;
export const PENDING_TOTP_ENCRYPTION_KEY_BYTES = 32;

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REPLACE_SQL = `insert into admin_mfa_pending_totp_enrollments
  (actor_id, enrollment_id, expires_at, nonce, ciphertext, tag)
values ($1, $2, $3, $4, $5, $6)
on conflict (actor_id) do update
   set enrollment_id = excluded.enrollment_id,
       expires_at = excluded.expires_at,
       nonce = excluded.nonce,
       ciphertext = excluded.ciphertext,
       tag = excluded.tag
returning enrollment_id::text as enrollment_id, expires_at`;

const READ_SQL = `select enrollment_id::text as enrollment_id,
       expires_at, nonce, ciphertext, tag
  from admin_mfa_pending_totp_enrollments
 where actor_id = $1
   and enrollment_id = $2
   for update`;

/** Schmale SQL-Schnittstelle einer vom Aufrufer eroeffneten Transaktion. */
export type PendingTotpSqlClient = Pick<PoolClient, "query">;

export interface PendingTotpStoreOptions {
  client: PendingTotpSqlClient;
  /** Exakt 32 Byte; keine Ableitung und kein Standardwert. */
  key: Buffer | Uint8Array;
  now?: () => Date;
}

export interface PendingTotpEnrollment { enrollmentId: string; expiresAt: Date; }
export interface ReadPendingTotpEnrollment extends PendingTotpEnrollment { secret: string; }

/** Fehlender oder falsch dimensionierter Schluessel; ohne Schluesselwerte. */
export class PendingTotpKeyError extends Error {
  constructor() { super("Ein Schluessel mit genau 32 Byte ist erforderlich"); this.name = "PendingTotpKeyError"; }
}

/** Bereinigter Kryptofehler; ohne Geheimnis, Schluessel oder Chiffrat. */
export class PendingTotpCryptoError extends Error {
  constructor() { super("Ausstehende TOTP-Einrichtung konnte nicht verarbeitet werden"); this.name = "PendingTotpCryptoError"; }
}

interface PendingRow { enrollment_id: string; expires_at: Date; nonce: Buffer; ciphertext: Buffer; tag: Buffer; }

function assertActorId(actorId: string): void {
  if (typeof actorId !== "string" || actorId.trim() === "") {
    throw new Error("Eine stabile Admin-Identitaet ist erforderlich");
  }
}

function assertSecret(secret: string): void {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("Ein TOTP-Geheimnis ist erforderlich");
  }
}

function assertClock(now: Date): void {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("Die injizierte Serveruhr liefert keinen gueltigen Zeitpunkt");
  }
}

/** Eindeutige AAD: Formatversion, Admin-ID, Einrichtungs-ID, Ablaufzeit. */
function buildAad(actorId: string, enrollmentId: string, expiresAt: Date): Buffer {
  return Buffer.from(
    JSON.stringify([FORMAT_VERSION, actorId, enrollmentId, expiresAt.toISOString()]),
    "utf8",
  );
}

export class PendingTotpEnrollmentStore {
  private readonly client: PendingTotpSqlClient;
  private readonly key: Buffer;
  private readonly now: () => Date;

  constructor(options: PendingTotpStoreOptions) {
    const key = options.key;
    if (!(key instanceof Uint8Array) || key.byteLength !== PENDING_TOTP_ENCRYPTION_KEY_BYTES) {
      throw new PendingTotpKeyError();
    }
    this.client = options.client;
    this.key = Buffer.from(key);
    this.now = options.now ?? (() => new Date());
  }

  /** Ersetzt atomar; hoechstens ein Datensatz je Admin, auch bei Konkurrenz. */
  async replace(actorId: string, secret: string): Promise<PendingTotpEnrollment> {
    assertActorId(actorId);
    assertSecret(secret);
    const now = this.now();
    assertClock(now);

    const enrollmentId = randomUUID();
    const expiresAt = new Date(now.getTime() + PENDING_TOTP_ENROLLMENT_TTL_MS);
    const nonce = randomBytes(NONCE_BYTES);

    let ciphertext: Buffer;
    let tag: Buffer;
    try {
      const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
      cipher.setAAD(buildAad(actorId, enrollmentId, expiresAt));
      ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
      tag = cipher.getAuthTag();
    } catch {
      throw new PendingTotpCryptoError();
    }

    const result = await this.client.query<PendingRow>(REPLACE_SQL, [
      actorId,
      enrollmentId,
      expiresAt,
      nonce,
      ciphertext,
      tag,
    ]);
    const row = result.rows[0];
    if (row === undefined) {
      throw new PendingTotpCryptoError();
    }
    return { enrollmentId: row.enrollment_id, expiresAt: row.expires_at };
  }

  /**
   * Gesperrtes Lesen der aktuellen Einrichtung. Unzugaengliche, abgelaufene
   * oder fremde Einrichtungen liefern einheitlich null.
   */
  async read(actorId: string, enrollmentId: string): Promise<ReadPendingTotpEnrollment | null> {
    assertActorId(actorId);
    if (typeof enrollmentId !== "string" || !UUID_PATTERN.test(enrollmentId)) {
      return null;
    }

    const result = await this.client.query<PendingRow>(READ_SQL, [actorId, enrollmentId]);
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    const now = this.now();
    assertClock(now);
    if (row.expires_at.getTime() <= now.getTime()) {
      return null;
    }
    if (row.nonce.length !== NONCE_BYTES || row.tag.length !== TAG_BYTES) {
      throw new PendingTotpCryptoError();
    }

    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, row.nonce);
      decipher.setAAD(buildAad(actorId, row.enrollment_id, row.expires_at));
      decipher.setAuthTag(row.tag);
      const plaintext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
      return {
        enrollmentId: row.enrollment_id,
        expiresAt: row.expires_at,
        secret: plaintext.toString("utf8"),
      };
    } catch {
      throw new PendingTotpCryptoError();
    }
  }
}
