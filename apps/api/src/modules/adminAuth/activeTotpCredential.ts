import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";

/**
 * CX-066 Review-Korrektur: Zugriff auf den bereits bestaetigten, aktiven
 * TOTP-Zustand des MFA-Kerns (CX-108). Der ausstehende CX-106-Speicher ist
 * ausdruecklich kein Nachweis eines aktivierten zweiten Faktors.
 *
 * Die aktive Zeile liegt in admin_mfa_totp_replay_state und ist an die
 * stabile actor_id gebunden. Gespeichert werden nur AES-256-GCM-Chiffrat,
 * Nonce und Tag; das Klartextgeheimnis verlaesst diese Funktion nur Richtung
 * TOTP-Pruefkern.
 */

export const ACTIVE_TOTP_AAD_VERSION = 2;
export const ACTIVE_TOTP_AAD_LABEL = "admin-mfa-totp-active";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export type ActiveTotpSqlClient = Pick<PoolClient, "query">;

export interface ActiveTotpCredential {
  secret: string;
  enrollmentId: string;
  lastAcceptedStep: number;
  activatedAt: Date;
}

/** Bereinigter Fehler; ohne Geheimnis, Schluessel oder Chiffrat. */
export class ActiveTotpCredentialError extends Error {
  constructor() {
    super("Aktiver TOTP-Zustand konnte nicht gelesen werden");
    this.name = "ActiveTotpCredentialError";
  }
}

interface ActiveTotpRow {
  enrollment_id: string | null;
  last_accepted_step: string;
  activated_at: Date | null;
  nonce: Buffer | null;
  ciphertext: Buffer | null;
  tag: Buffer | null;
}

/** Eindeutige AAD: Formatversion, Zweck, Admin-ID, Einrichtungs-ID. */
export function buildActiveTotpAad(
  actorId: string,
  enrollmentId: string,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      ACTIVE_TOTP_AAD_VERSION,
      ACTIVE_TOTP_AAD_LABEL,
      actorId,
      enrollmentId,
    ]),
    "utf8",
  );
}

export function encryptActiveTotpSecret(
  key: Buffer | Uint8Array,
  actorId: string,
  enrollmentId: string,
  secret: string,
): { nonce: Buffer; ciphertext: Buffer; tag: Buffer } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key), nonce);
  cipher.setAAD(buildActiveTotpAad(actorId, enrollmentId));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return { nonce, ciphertext, tag: cipher.getAuthTag() };
}

/**
 * Liest und sperrt den aktiven TOTP-Zustand eines Kontos. Es gibt genau dann
 * ein Ergebnis, wenn eine bestaetigte Aktivierung mit vollstaendigem
 * Chiffrat vorliegt; ausstehende Einrichtungen werden nie als Ersatz genutzt.
 */
export async function readActiveTotpCredential(
  client: ActiveTotpSqlClient,
  key: Buffer | Uint8Array,
  actorId: string,
): Promise<ActiveTotpCredential | null> {
  if (!(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES) {
    throw new ActiveTotpCredentialError();
  }
  const result = await client.query<ActiveTotpRow>(
    [
      "select enrollment_id::text as enrollment_id,",
      "       last_accepted_step,",
      "       activated_at, nonce, ciphertext, tag",
      "  from admin_mfa_totp_replay_state",
      " where actor_id = $1",
      "   and activated_at is not null",
      "   for update",
    ].join("\n"),
    [actorId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  if (
    typeof row.enrollment_id !== "string" ||
    row.nonce === null ||
    row.ciphertext === null ||
    row.tag === null ||
    row.nonce.length !== NONCE_BYTES ||
    row.tag.length !== TAG_BYTES
  ) {
    throw new ActiveTotpCredentialError();
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key), row.nonce);
    decipher.setAAD(buildActiveTotpAad(actorId, row.enrollment_id));
    decipher.setAuthTag(row.tag);
    const plaintext = Buffer.concat([
      decipher.update(row.ciphertext),
      decipher.final(),
    ]);
    return {
      secret: plaintext.toString("utf8"),
      enrollmentId: row.enrollment_id,
      lastAcceptedStep: Number(row.last_accepted_step),
      activatedAt: row.activated_at as Date,
    };
  } catch {
    throw new ActiveTotpCredentialError();
  }
}

