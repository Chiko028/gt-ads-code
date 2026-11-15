import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import type { AppConfig } from "../config.js";
import { verifyPassword } from "../crypto/password.js";
import { ApiError } from "./errors.js";
import { registerJsonRoute } from "./jsonContract.js";
import type { RateLimiter } from "./rateLimit.js";
import { insertAuditEvent } from "../modules/audit/repository.js";
import {
  createAdminSessionMiddleware,
  requireAdminWrite,
} from "../modules/adminAuth/middleware.js";
import {
  PENDING_TOTP_ENCRYPTION_KEY_BYTES,
  PendingTotpEnrollmentStore,
} from "../modules/adminAuth/pendingTotpEnrollment.js";
import type {
  AdminAuthService,
  AdminSessionContext,
} from "../modules/adminAuth/service.js";
import { generateTotpSecret } from "../modules/adminAuth/totp.js";

/**
 * CX-107 / R-605: Beginn einer TOTP-Einrichtung.
 *
 * Der Endpunkt prueft die bestehende Admin-Sitzung, den vorhandenen
 * Schreibschutz und das aktuelle Passwort erneut. Erst danach wird ein
 * 20-Byte-TOTP-Geheimnis erzeugt und ueber den CX-106-Speicher verschluesselt
 * abgelegt. Es gibt keine Aktivierung, kein MFA-Flag, keine
 * Wiederherstellungscodes und keine frei waehlbare Benutzer-ID.
 */
export const ADMIN_MFA_TOTP_SETUP_URL = "/v1/admin/mfa/totp/setup";
export const ADMIN_MFA_TOTP_SETUP_ACTION = "admin.mfa.totp.setup.started";
export const ADMIN_MFA_TOTP_SETUP_TARGET_TYPE =
  "admin_mfa_pending_totp_enrollment";
export const TOTP_ISSUER = "GT-Ads";

export interface AdminTotpSetupRoutesDeps {
  pool: Pool;
  adminAuth: AdminAuthService;
  config: AppConfig;
  /** Gemeinsamer Fehlversuchszaehler der Admin-Anmeldung. */
  loginLimiter: RateLimiter;
  /** Exakt 32 Byte; ohne gueltigen Schluessel gibt es keine Ersatzloesung. */
  encryptionKey?: Buffer | Uint8Array;
  now?: () => Date;
}

const SETUP_BODY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["password"],
  properties: {
    password: { type: "string", minLength: 1, maxLength: 4096 },
  },
};

/**
 * Im aktuellen Schema ist ein aktiver Wiederherstellungscodesatz der einzige
 * persistente Nachweis einer bereits eingerichteten MFA. CX-107 setzt
 * bewusst kein MFA-Flag und erzeugt keine Wiederherstellungscodes.
 */
const ACTIVE_MFA_SQL = [
  "select 1",
  "  from admin_mfa_recovery_code_sets",
  " where actor_id = $1",
  "   and invalidated_at is null",
  " limit 1",
].join("\n");

function mfaUnavailable(): ApiError {
  return new ApiError("internal_error", { statusCode: 503 });
}

function mfaAlreadyActive(): ApiError {
  // CX-107 fuehrt bewusst keinen neuen oeffentlichen Fehlercode ein.
  return new ApiError("invalid_request", { statusCode: 409 });
}

function hasValidKey(key: Buffer | Uint8Array | undefined): key is Buffer | Uint8Array {
  return key instanceof Uint8Array && key.byteLength === PENDING_TOTP_ENCRYPTION_KEY_BYTES;
}

/**
 * Standardkonforme otpauth-URI: GT-Ads, SHA1, sechs Stellen, 30 Sekunden.
 * Das Konto ist die serverseitig aufgeloeste Admin-ID; sie stammt nie aus
 * der Anfrage.
 */
export function buildTotpOtpauthUri(actorId: string, secret: string): string {
  const label = TOTP_ISSUER + ":" + encodeURIComponent(actorId);
  const params = new URLSearchParams({
    secret,
    issuer: TOTP_ISSUER,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return "otpauth://totp/" + label + "?" + params.toString();
}

function parsePassword(body: unknown): string {
  // Das geschlossene CX-033-Schema hat den Body bereits validiert. Diese
  // Pruefung schuetzt zusaetzlich den direkten Aufruf des Handlers.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw ApiError.invalidRequest();
  }
  const password = (body as Record<string, unknown>).password;
  if (
    typeof password !== "string" ||
    password.length === 0 ||
    password.length > 4096
  ) {
    throw ApiError.invalidRequest();
  }
  return password;
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

/**
 * Sitzung und Rolle stammen ausschliesslich aus der serverseitigen
 * Sitzungspruefung. Wie CX-108/CX-109 prueft die Route beides selbst; der
 * oeffentliche Katalogeintrag fuegt keine Authentifizierung hinzu.
 */
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

/**
 * Registriert genau POST /v1/admin/mfa/totp/setup. Der vorhandene
 * JSON-Schreibschutz und die Sitzungs-/Rollenpruefung laufen vor dem Handler;
 * eine Identitaet stammt nie aus dem Request-Body.
 */
export function registerAdminTotpSetupRoutes(
  app: FastifyInstance,
  deps: AdminTotpSetupRoutesDeps,
): void {
  const sessionGuard = createAdminSessionMiddleware(deps.adminAuth);
  const now = deps.now ?? (() => new Date());

  registerJsonRoute(app, {
    method: "POST",
    url: ADMIN_MFA_TOTP_SETUP_URL,
    bodySchema: SETUP_BODY_SCHEMA,
    onRequest: [requireAdminWrite, sessionGuard],
    handler: async (request, reply) => {
      const sourceKey = request.ip;
      const gate = deps.loginLimiter.peek(sourceKey);
      if (!gate.allowed) {
        throw ApiError.rateLimited(gate.retryAfterSeconds);
      }

      // Rolle vor der Passwortpruefung: eine Operator-Sitzung darf den
      // Endpunkt nicht als Passwort-Orakel verwenden.
      const session = requireAdminSession(request);

      const password = parsePassword(request.body);
      const valid = await verifyPassword(
        password,
        deps.config.adminPasswordHash,
      );
      if (!valid) {
        deps.loginLimiter.hit(sourceKey);
        throw ApiError.unauthorized();
      }
      deps.loginLimiter.reset(sourceKey);

      const key = deps.encryptionKey;
      if (!hasValidKey(key)) {
        throw mfaUnavailable();
      }

      const startedAt = now();
      const secret = generateTotpSecret();

      const enrollment = await withTransaction(deps.pool, async (client) => {
        // Serialisiert parallele Einrichtungen desselben Kontos, auch wenn
        // noch kein ausstehender Datensatz existiert.
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1::text, 0))",
          [session.actorId],
        );

        const active = await client.query(ACTIVE_MFA_SQL, [session.actorId]);
        if ((active.rowCount ?? 0) > 0) {
          throw mfaAlreadyActive();
        }

        const store = new PendingTotpEnrollmentStore({
          client,
          key,
          now: () => startedAt,
        });
        const pending = await store.replace(session.actorId, secret);

        // Bereinigter Audit-Eintrag in derselben Transaktion: nur
        // Benutzer-ID, Aktion, Ziel und Einrichtungs-ID. Kein Geheimnis,
        // kein Passwort, keine URI.
        await insertAuditEvent(client, {
          at: startedAt,
          actorType: "admin",
          actorId: session.actorId,
          action: ADMIN_MFA_TOTP_SETUP_ACTION,
          targetType: ADMIN_MFA_TOTP_SETUP_TARGET_TYPE,
          targetId: pending.enrollmentId,
          details: { enrollment_id: pending.enrollmentId },
        });

        return pending;
      });

      reply.header("Cache-Control", "no-store");
      reply.code(201).send({
        enrollment_id: enrollment.enrollmentId,
        expires_at: enrollment.expiresAt.toISOString(),
        secret,
        otpauth_uri: buildTotpOtpauthUri(session.actorId, secret),
      });
    },
  });
}

