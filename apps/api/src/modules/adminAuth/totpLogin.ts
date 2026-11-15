import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import type { AppConfig } from "../../config.js";
import { generateAdminSessionToken, hashToken } from "../../crypto/tokens.js";
import { ApiError } from "../../http/errors.js";
import { registerJsonRoute } from "../../http/jsonContract.js";
import type { RateLimiter } from "../../http/rateLimit.js";
import { insertAuditEvent } from "../audit/repository.js";
import { readActiveTotpCredential } from "./activeTotpCredential.js";
import {
  consumeLoginChallenge,
  isLoginChallengeUsable,
  lockLoginChallenge,
  recordLoginChallengeFailure,
} from "./loginChallenge.js";
import {
  ADMIN_SESSION_COOKIE,
  createAdminSessionMiddleware,
  requireAdminWrite,
} from "./middleware.js";
import {
  ADMIN_MFA_ACCOUNT_LIMIT_PREFIX,
  ensureAdminMfaRecoverySchema,
} from "./recoveryRoutes.js";
import {
  deleteAdminSessionById,
  findAdminSessionByIdForUpdate,
  insertAdminSession,
} from "./repository.js";
import {
  LEGACY_ADMIN_ACTOR_ID,
  type AdminAuthService,
  type AdminSessionContext,
} from "./service.js";
import { matchTotpStep } from "./totp.js";

/**
 * CX-066 Review-Korrektur: TOTP als tatsaechlicher zweiter Anmeldefaktor.
 *
 * Die Route arbeitet auf derselben persistenten Login-Challenge wie die
 * Wiederherstellung (admin_mfa_recovery_challenges) und demselben
 * Fehlversuchszaehler. Ein gueltiger TOTP-Code verbraucht die Challenge,
 * ersetzt die Passwort-Vorsitzung durch eine vollstaendige MFA-Sitzung und
 * schreibt das Erfolgsaudit im selben Commit. Das Cookie folgt erst danach.
 *
 * Es gibt weiterhin keine Produktionsaktivierung; server.ts registriert diese
 * Route bewusst nicht.
 */
export const ADMIN_MFA_TOTP_LOGIN_URL = "/v1/admin/auth/totp/verify";
export const ADMIN_MFA_TOTP_LOGIN_ACTION = "admin.mfa.totp.session.issued";
export const ADMIN_MFA_TOTP_LOGIN_TARGET_TYPE = "admin_session";

const TOTP_LOGIN_BODY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["totp_code"],
  properties: {
    totp_code: { type: "string", minLength: 6, maxLength: 6 },
  },
};

export interface AdminTotpLoginRoutesDeps {
  pool: Pool;
  adminAuth: AdminAuthService;
  config: AppConfig;
  /** Gemeinsamer Fehlversuchszaehler der Admin-Anmeldung. */
  loginLimiter: RateLimiter;
  /** Exakt 32 Byte; ohne gueltigen Schluessel gibt es keine Ersatzloesung. */
  totpEncryptionKey?: Buffer | Uint8Array;
  now?: () => Date;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTotpCodeBody(body: unknown): string {
  if (!isPlainObject(body)) {
    throw ApiError.invalidRequest();
  }
  const code = body.totp_code;
  if (typeof code !== "string" || !/^[0-9]{6}$/.test(code)) {
    throw ApiError.invalidRequest();
  }
  return code;
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

function mfaUnavailable(): ApiError {
  return new ApiError("internal_error", { statusCode: 503 });
}

function hasValidKey(
  key: Buffer | Uint8Array | undefined,
): key is Buffer | Uint8Array {
  return key instanceof Uint8Array && key.byteLength === 32;
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

interface RotatedSession {
  token: string;
  expiresAt: Date;
}

type TotpLoginOutcome =
  | { kind: "rotated"; session: RotatedSession }
  | { kind: "wrong" }
  | { kind: "blocked" };

export function registerAdminTotpLoginRoutes(
  app: FastifyInstance,
  deps: AdminTotpLoginRoutesDeps,
): void {
  const sessionGuard = createAdminSessionMiddleware(deps.adminAuth);
  const now = deps.now ?? (() => new Date());
  const maxAttempts = deps.config.registrationMaxFailsPerSource;

  registerJsonRoute(app, {
    method: "POST",
    url: ADMIN_MFA_TOTP_LOGIN_URL,
    bodySchema: TOTP_LOGIN_BODY_SCHEMA,
    onRequest: [requireAdminWrite, sessionGuard],
    handler: async (request, reply) => {
      const key = deps.totpEncryptionKey;
      if (!hasValidKey(key)) {
        throw mfaUnavailable();
      }
      const session = requireAdminSession(request);
      await ensureAdminMfaRecoverySchema(deps.pool);

      // Format vor der Reservierung validieren: kein Ticket fuer 400er.
      const totpCode = parseTotpCodeBody(request.body);

      const attempt = beginAttempt(
        deps.loginLimiter,
        request.ip,
        ADMIN_MFA_ACCOUNT_LIMIT_PREFIX + session.actorId,
      );

      let outcome: TotpLoginOutcome;
      try {
        outcome = await withTransaction<TotpLoginOutcome>(
          deps.pool,
          async (client) => {
            const at = now();

            const preSession = await findAdminSessionByIdForUpdate(
              client,
              session.sessionId,
            );
            if (preSession === null) {
              return { kind: "blocked" };
            }

            const challenge = await lockLoginChallenge(
              client,
              session.sessionId,
              session.actorId,
              at,
              session.expiresAt,
            );
            if (
              challenge === null ||
              !isLoginChallengeUsable(challenge, at, maxAttempts)
            ) {
              return { kind: "blocked" };
            }

            const credential = await readActiveTotpCredential(
              client,
              key,
              session.actorId,
            );
            if (credential === null) {
              return { kind: "blocked" };
            }
            const step = matchTotpStep(
              credential.secret,
              totpCode,
              at.getTime(),
              credential.lastAcceptedStep,
            );
            if (step === null) {
              await recordLoginChallengeFailure(
                client,
                challenge.id,
                maxAttempts,
                at,
              );
              return { kind: "wrong" };
            }

            const advanced = await client.query(
              [
                "insert into admin_mfa_totp_replay_state",
                "  (actor_id, last_accepted_step, updated_at)",
                "values ($1, $2, $3)",
                "on conflict (actor_id) do update",
                "   set last_accepted_step = excluded.last_accepted_step,",
                "       updated_at = excluded.updated_at",
                " where admin_mfa_totp_replay_state.last_accepted_step",
                "       < excluded.last_accepted_step",
                "returning last_accepted_step",
              ].join("\n"),
              [session.actorId, step, at],
            );
            if ((advanced.rowCount ?? 0) !== 1) {
              await recordLoginChallengeFailure(
                client,
                challenge.id,
                maxAttempts,
                at,
              );
              return { kind: "wrong" };
            }

            if (!(await consumeLoginChallenge(client, challenge.id, at))) {
              throw new Error("Challenge konnte nicht verbraucht werden");
            }

            const removed = await deleteAdminSessionById(
              client,
              session.sessionId,
            );
            if (removed !== 1) {
              throw new Error("Vorsitzung konnte nicht ersetzt werden");
            }

            const token = generateAdminSessionToken();
            const sessionExpiresAt = new Date(
              at.getTime() + deps.config.adminSessionTtlSeconds * 1000,
            );
            await insertAdminSession(client, {
              id: randomUUID(),
              tokenHash: hashToken(token),
              createdAt: at,
              expiresAt: sessionExpiresAt,
              mfaVerifiedAt: at,
              actorId:
                session.actorId === LEGACY_ADMIN_ACTOR_ID
                  ? null
                  : session.actorId,
            });
            await insertAuditEvent(client, {
              at,
              actorType: "admin",
              actorId: session.actorId,
              action: ADMIN_MFA_TOTP_LOGIN_ACTION,
              targetType: ADMIN_MFA_TOTP_LOGIN_TARGET_TYPE,
              targetId: session.sessionId,
              details: {
                rotated_session_id: session.sessionId,
                accepted_step: step,
              },
            });

            return {
              kind: "rotated",
              session: { token, expiresAt: sessionExpiresAt },
            };
          },
        );
      } catch (error) {
        attempt.release();
        throw error;
      }

      if (outcome.kind === "wrong") {
        attempt.commitFailure();
        throw ApiError.unauthorized();
      }
      if (outcome.kind === "blocked") {
        attempt.release();
        throw ApiError.unauthorized();
      }

      attempt.release();
      reply.header("Cache-Control", "no-store");
      reply.setCookie(ADMIN_SESSION_COOKIE, outcome.session.token, {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        secure: deps.config.cookieSecure,
        maxAge: deps.config.adminSessionTtlSeconds,
      });
      reply.code(204).send();
    },
  });
}

