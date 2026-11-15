import { createCipheriv, createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import type { AppConfig } from "../../config.js";
import { ApiError } from "../../http/errors.js";
import { registerJsonRoute } from "../../http/jsonContract.js";
import type { RateLimiter } from "../../http/rateLimit.js";
import { insertAuditEvent } from "../audit/repository.js";
import { createAdminSessionMiddleware, requireAdminWrite } from "./middleware.js";
import {
  PENDING_TOTP_ENCRYPTION_KEY_BYTES,
  PendingTotpEnrollmentStore,
} from "./pendingTotpEnrollment.js";
import {
  ADMIN_MFA_ACCOUNT_LIMIT_PREFIX,
  ensureAdminMfaRecoverySchema,
} from "./recoveryRoutes.js";
import { issueRecoveryCodeSetInTransaction } from "./recoveryCodes.js";
import type { AdminAuthService, AdminSessionContext } from "./service.js";
import { matchTotpStep } from "./totp.js";

/**
 * CX-108 / R-605: Abschluss einer TOTP-Einrichtung.
 *
 * Ein gueltiger Code aktiviert MFA atomar: verschluesselter TOTP-Zustand,
 * Wiederherstellungscode-Hashes, Verbrauch der Einrichtung und bereinigtes
 * Audit committen gemeinsam. Klartext-Wiederherstellungscodes erscheinen nur
 * in der ersten erfolgreichen Antwort.
 *
 * Der aktive TOTP-Zustand liegt im bereits von CX-066 verwendeten
 * Replay-Modell (admin_mfa_totp_replay_state), gebunden an dieselbe actor_id.
 * Es entsteht keine zweite MFA-Identitaet. Die fortgeschriebene akzeptierte
 * Stufe verhindert die Wiederverwendung des Aktivierungsfensters als Login.
 */
export const ADMIN_MFA_TOTP_CONFIRM_URL = "/v1/admin/mfa/totp/setup/confirm";
export const ADMIN_MFA_TOTP_CONFIRM_ACTION = "admin.mfa.totp.setup.confirmed";
export const ADMIN_MFA_TOTP_CONFIRM_TARGET_TYPE = "admin_mfa_totp_credential";
export const ADMIN_MFA_TOTP_MAX_FAILED_CONFIRMATIONS = 5;

const ACTIVE_AAD_VERSION = 2;
const ACTIVE_AAD_LABEL = "admin-mfa-totp-active";
const NONCE_BYTES = 12;
const CODE_PATTERN = /^[0-9]{6}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdminTotpSetupConfirmRoutesDeps {
  pool: Pool;
  adminAuth: AdminAuthService;
  config: AppConfig;
  /** Gemeinsamer Fehlversuchszaehler der Admin-Anmeldung. */
  loginLimiter: RateLimiter;
  /** Exakt 32 Byte; ohne gueltigen Schluessel gibt es keine Ersatzloesung. */
  totpEncryptionKey?: Buffer | Uint8Array;
  now?: () => Date;
}

const CONFIRM_BODY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["enrollment_id", "code"],
  properties: {
    enrollment_id: { type: "string", minLength: 36, maxLength: 36 },
    code: { type: "string", minLength: 6, maxLength: 6 },
  },
};

/** Additive, idempotente DDL; vorhandene Tabellen werden nur erweitert. */
const CONFIRM_SCHEMA_SQL = [
  "create table if not exists admin_mfa_totp_confirm_attempts (",
  "  enrollment_id uuid primary key,",
  "  actor_id text not null check (actor_id <> ''),",
  "  failed_attempts integer not null default 0 check (failed_attempts >= 0),",
  "  locked_at timestamptz null,",
  "  updated_at timestamptz not null",
  ");",
  "alter table admin_mfa_totp_replay_state",
  "  add column if not exists enrollment_id uuid null,",
  "  add column if not exists nonce bytea null,",
  "  add column if not exists ciphertext bytea null,",
  "  add column if not exists tag bytea null,",
  "  add column if not exists activated_at timestamptz null;",
].join("\n");

const ensuredPools = new WeakMap<Pool, Promise<void>>();

export function ensureAdminTotpConfirmSchema(pool: Pool): Promise<void> {
  const existing = ensuredPools.get(pool);
  if (existing !== undefined) {
    return existing;
  }
  const pending = (async () => {
    await ensureAdminMfaRecoverySchema(pool);
    await pool.query(CONFIRM_SCHEMA_SQL);
  })();
  ensuredPools.set(pool, pending);
  pending.catch(() => ensuredPools.delete(pool));
  return pending;
}

/** Leitet den 32-Byte-Schluessel domaenenspezifisch aus dem Servergeheimnis ab. */
export function deriveAdminTotpEncryptionKey(secret: string): Buffer {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("Ein Servergeheimnis fuer den TOTP-Schluessel fehlt");
  }
  return createHash("sha256")
    .update("gt-ads:admin-mfa-totp-encryption:v1", "utf8")
    .update("\u0000", "utf8")
    .update(secret, "utf8")
    .digest();
}

function hasValidKey(
  key: Buffer | Uint8Array | undefined,
): key is Buffer | Uint8Array {
  return key instanceof Uint8Array &&
    key.byteLength === PENDING_TOTP_ENCRYPTION_KEY_BYTES;
}

function conflict(): ApiError {
  return new ApiError("invalid_request", { statusCode: 409 });
}

function mfaUnavailable(): ApiError {
  return new ApiError("internal_error", { statusCode: 503 });
}

interface AttemptReservation {
  commitFailure(): void;
  release(): void;
}

function beginAttempt(
  limiter: RateLimiter,
  sourceKey: string,
  accountKey: string,
): AttemptReservation {
  const source = limiter.reserve(sourceKey);
  if (!source.allowed) {
    throw ApiError.rateLimited(source.retryAfterSeconds);
  }
  const account = limiter.reserve(accountKey);
  if (!account.allowed) {
    source.ticket.release();
    throw ApiError.rateLimited(account.retryAfterSeconds);
  }
  return {
    commitFailure: () => {
      source.ticket.commitFailure();
      account.ticket.commitFailure();
    },
    release: () => {
      source.ticket.release();
      account.ticket.release();
    },
  };
}

async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let open = false;
  try {
    await client.query("begin");
    open = true;
    const result = await operation(client);
    await client.query("commit");
    open = false;
    return result;
  } catch (error) {
    if (open) {
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ParsedConfirmBody {
  enrollmentId: string;
  code: string;
}

function parseConfirmBody(body: unknown): ParsedConfirmBody {
  if (!isPlainObject(body) || Object.keys(body).length !== 2) {
    throw ApiError.invalidRequest();
  }
  const enrollmentId = body.enrollment_id;
  const code = body.code;
  if (
    typeof enrollmentId !== "string" ||
    !UUID_PATTERN.test(enrollmentId) ||
    typeof code !== "string" ||
    !CODE_PATTERN.test(code)
  ) {
    throw ApiError.invalidRequest();
  }
  return { enrollmentId: enrollmentId.toLowerCase(), code };
}

function requireAdminSession(request: FastifyRequest): AdminSessionContext {
  const session = request.adminSession;
  if (session === undefined) {
    throw ApiError.unauthorized();
  }
  if (session.role !== "Admin") {
    throw ApiError.forbidden();
  }
  return session;
}

interface PendingStateRow {
  expires_at: Date;
}

interface AttemptRow {
  failed_attempts: number;
  locked_at: Date | null;
}

interface ActiveStateRow {
  last_accepted_step: string;
  activated_at: Date | null;
}

type ConfirmOutcome =
  | { readonly kind: "activated"; readonly codes: string[]; readonly activatedAt: Date }
  | { readonly kind: "wrong" }
  | { readonly kind: "missing" }
  | { readonly kind: "locked" }
  | { readonly kind: "conflict" };

function buildActiveAad(actorId: string, enrollmentId: string): Buffer {
  return Buffer.from(
    JSON.stringify([ACTIVE_AAD_VERSION, ACTIVE_AAD_LABEL, actorId, enrollmentId]),
    "utf8",
  );
}

function encryptActiveSecret(
  key: Buffer,
  actorId: string,
  enrollmentId: string,
  secret: string,
): { nonce: Buffer; ciphertext: Buffer; tag: Buffer } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(buildActiveAad(actorId, enrollmentId));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return { nonce, ciphertext, tag: cipher.getAuthTag() };
}

/**
 * Registriert genau POST /v1/admin/mfa/totp/setup/confirm. Sitzung, Adminrolle
 * und JSON-Schreibschutz werden in der Route selbst geprueft.
 */
export function registerAdminTotpSetupConfirmRoutes(
  app: FastifyInstance,
  deps: AdminTotpSetupConfirmRoutesDeps,
): void {
  const sessionGuard = createAdminSessionMiddleware(deps.adminAuth);
  const now = deps.now ?? (() => new Date());
  const maxFailedConfirmations = Math.min(
    ADMIN_MFA_TOTP_MAX_FAILED_CONFIRMATIONS,
    deps.config.registrationMaxFailsPerSource,
  );

  registerJsonRoute(app, {
    method: "POST",
    url: ADMIN_MFA_TOTP_CONFIRM_URL,
    bodySchema: CONFIRM_BODY_SCHEMA,
    onRequest: [requireAdminWrite, sessionGuard],
    handler: async (request, reply) => {
      const key = deps.totpEncryptionKey;
      if (!hasValidKey(key)) {
        throw mfaUnavailable();
      }
      const session = requireAdminSession(request);
      const { enrollmentId, code } = parseConfirmBody(request.body);
      await ensureAdminTotpConfirmSchema(deps.pool);

      const attempt = beginAttempt(
        deps.loginLimiter,
        request.ip,
        ADMIN_MFA_ACCOUNT_LIMIT_PREFIX + session.actorId,
      );

      let outcome: ConfirmOutcome;
      try {
        outcome = await withTransaction(deps.pool, async (client) => {
          const at = now();
          await client.query(
            "select pg_advisory_xact_lock(hashtextextended($1::text, 0))",
            [session.actorId],
          );

          const active = await client.query<ActiveStateRow>(
            [
              "select last_accepted_step, activated_at",
              "  from admin_mfa_totp_replay_state",
              " where actor_id = $1",
              "   for update",
            ].join("\n"),
            [session.actorId],
          );
          if (active.rows[0]?.activated_at != null) {
            return { kind: "conflict" };
          }

          const state = await client.query<PendingStateRow>(
            [
              "select expires_at",
              "  from admin_mfa_pending_totp_enrollments",
              " where actor_id = $1",
              "   and enrollment_id = $2::uuid",
              "   for update",
            ].join("\n"),
            [session.actorId, enrollmentId],
          );
          const pending = state.rows[0];
          if (pending === undefined || at.getTime() >= pending.expires_at.getTime()) {
            return { kind: "missing" };
          }

          const attempts = await client.query<AttemptRow>(
            [
              "select failed_attempts, locked_at",
              "  from admin_mfa_totp_confirm_attempts",
              " where enrollment_id = $1::uuid",
              "   and actor_id = $2",
            ].join("\n"),
            [enrollmentId, session.actorId],
          );
          if (attempts.rows[0]?.locked_at != null) {
            return { kind: "locked" };
          }

          const store = new PendingTotpEnrollmentStore({ client, key, now: () => at });
          const credential = await store.read(session.actorId, enrollmentId);
          if (credential === null) {
            return { kind: "missing" };
          }

          const lastAcceptedStep =
            active.rows[0] === undefined
              ? null
              : Number(active.rows[0].last_accepted_step);
          const step = matchTotpStep(
            credential.secret,
            code,
            at.getTime(),
            lastAcceptedStep,
          );

          if (step === null) {
            const counted = await client.query<AttemptRow>(
              [
                "insert into admin_mfa_totp_confirm_attempts",
                "  (enrollment_id, actor_id, failed_attempts, locked_at, updated_at)",
                "values ($1::uuid, $2, 1,",
                "        case when 1 >= $3::integer then $4::timestamptz else null end,",
                "        $4::timestamptz)",
                "on conflict (enrollment_id) do update",
                "   set failed_attempts =",
                "         admin_mfa_totp_confirm_attempts.failed_attempts + 1,",
                "       locked_at = case",
                "         when admin_mfa_totp_confirm_attempts.failed_attempts + 1 >= $3::integer",
                "         then $4::timestamptz",
                "         else admin_mfa_totp_confirm_attempts.locked_at",
                "       end,",
                "       updated_at = $4::timestamptz",
                "returning failed_attempts, locked_at",
              ].join("\n"),
              [enrollmentId, session.actorId, maxFailedConfirmations, at],
            );
            return counted.rows[0]?.locked_at != null
              ? { kind: "locked" }
              : { kind: "wrong" };
          }

          const encrypted = encryptActiveSecret(
            Buffer.from(key),
            session.actorId,
            enrollmentId,
            credential.secret,
          );

          // Aktiver Zustand im vorhandenen CX-066-Authmodell: dieselbe
          // actor_id, dieselbe Replay-Zeile. Nur die erste Aktivierung zaehlt.
          const advanced = await client.query(
            [
              "insert into admin_mfa_totp_replay_state",
              "  (actor_id, last_accepted_step, updated_at, enrollment_id,",
              "   nonce, ciphertext, tag, activated_at)",
              "values ($1, $2, $3, $4::uuid, $5, $6, $7, $8)",
              "on conflict (actor_id) do update",
              "   set last_accepted_step = excluded.last_accepted_step,",
              "       updated_at = excluded.updated_at,",
              "       enrollment_id = excluded.enrollment_id,",
              "       nonce = excluded.nonce,",
              "       ciphertext = excluded.ciphertext,",
              "       tag = excluded.tag,",
              "       activated_at = excluded.activated_at",
              " where admin_mfa_totp_replay_state.activated_at is null",
              "returning actor_id",
            ].join("\n"),
            [
              session.actorId,
              step,
              at,
              enrollmentId,
              encrypted.nonce,
              encrypted.ciphertext,
              encrypted.tag,
              at,
            ],
          );
          if ((advanced.rowCount ?? 0) !== 1) {
            return { kind: "conflict" };
          }

          const issued = await issueRecoveryCodeSetInTransaction(
            client,
            session.actorId,
            { now: () => at },
          );

          const consumed = await client.query(
            [
              "delete from admin_mfa_pending_totp_enrollments",
              " where actor_id = $1",
              "   and enrollment_id = $2::uuid",
            ].join("\n"),
            [session.actorId, enrollmentId],
          );
          if ((consumed.rowCount ?? 0) !== 1) {
            throw new Error("Einrichtung konnte nicht verbraucht werden");
          }
          await client.query(
            "delete from admin_mfa_totp_confirm_attempts where enrollment_id = $1::uuid",
            [enrollmentId],
          );

          await insertAuditEvent(client, {
            at,
            actorType: "admin",
            actorId: session.actorId,
            action: ADMIN_MFA_TOTP_CONFIRM_ACTION,
            targetType: ADMIN_MFA_TOTP_CONFIRM_TARGET_TYPE,
            targetId: enrollmentId,
            details: { enrollment_id: enrollmentId, accepted_step: step },
          });

          return { kind: "activated", codes: issued.codes, activatedAt: at };
        });
      } catch (error) {
        // Unerwartete Fehler (z. B. Auditfehler) sind keine Fehlversuche.
        attempt.release();
        throw error;
      }

      if (outcome.kind === "activated") {
        attempt.release();
        reply.header("Cache-Control", "no-store");
        reply.code(201).send({
          codes: outcome.codes,
          activated_at: outcome.activatedAt.toISOString(),
        });
        return;
      }
      if (outcome.kind === "wrong") {
        attempt.commitFailure();
        throw ApiError.unauthorized();
      }
      attempt.release();
      if (outcome.kind === "locked" || outcome.kind === "conflict") {
        throw conflict();
      }
      throw ApiError.unauthorized();
    },
  });
}

