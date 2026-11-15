import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { ApiError } from "../../http/errors.js";
import { registerJsonRoute } from "../../http/jsonContract.js";
import { insertAuditEvent } from "../audit/repository.js";
import {
  createAdminSessionMiddleware,
  requireAdminWrite,
} from "./middleware.js";
import type { AdminAuthService, AdminSessionContext } from "./service.js";

/**
 * CX-109 / R-605: Abbruch einer ausstehenden TOTP-Einrichtung.
 *
 * Der Endpunkt loescht ausschliesslich den CX-106-Datensatz des angemeldeten
 * Admins. Aktive MFA, Wiederherstellungscodes und Sitzungen werden nicht
 * beruehrt. Die Sperre ist dieselbe Advisory-Lock wie in CX-108, damit
 * Bestaetigung und Abbruch serialisiert sind. Nur eine tatsaechliche
 * Loeschung erzeugt Audit; Wiederholungen bleiben idempotent (204).
 */
export const ADMIN_MFA_TOTP_CANCEL_URL = "/v1/admin/mfa/totp/setup/:id";
export const ADMIN_MFA_TOTP_CANCEL_ACTION = "admin.mfa.totp.setup.cancelled";
export const ADMIN_MFA_TOTP_CANCEL_TARGET_TYPE =
  "admin_mfa_pending_totp_enrollment";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdminTotpSetupCancelRoutesDeps {
  pool: Pool;
  adminAuth: AdminAuthService;
  now?: () => Date;
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
 * Liefert die kanonische UUID oder 400. Eine formal ungueltige ID ist keine
 * fremde Einrichtungs-ID und wird deshalb nicht als Erfolg maskiert.
 */
function parseEnrollmentId(params: unknown): string {
  const raw =
    typeof params === "object" && params !== null
      ? (params as Record<string, unknown>).id
      : undefined;
  if (typeof raw !== "string" || !UUID_PATTERN.test(raw)) {
    throw ApiError.invalidRequest();
  }
  return raw.toLowerCase();
}

/**
 * Registriert genau DELETE /v1/admin/mfa/totp/setup/:id. Sitzung, Adminrolle
 * und der vorhandene JSON-Schreibschutz laufen vor dem Fachhandler.
 */
export function registerAdminTotpSetupCancelRoutes(
  app: FastifyInstance,
  deps: AdminTotpSetupCancelRoutesDeps,
): void {
  const sessionGuard = createAdminSessionMiddleware(deps.adminAuth);
  const now = deps.now ?? (() => new Date());

  registerJsonRoute(app, {
    method: "DELETE",
    url: ADMIN_MFA_TOTP_CANCEL_URL,
    onRequest: [requireAdminWrite, sessionGuard],
    handler: async (request, reply) => {
      const session = requireAdminSession(request);
      const enrollmentId = parseEnrollmentId(request.params);

      await withTransaction(deps.pool, async (client) => {
        // Dieselbe Serialisierung wie CX-108: Bestaetigung und Abbruch
        // desselben Kontos koennen nicht gleichzeitig entscheiden.
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1::text, 0))",
          [session.actorId],
        );

        const deleted = await client.query(
          [
            "delete from admin_mfa_pending_totp_enrollments",
            " where actor_id = $1",
            "   and enrollment_id = $2::uuid",
            "returning enrollment_id::text as enrollment_id",
          ].join("\n"),
          [session.actorId, enrollmentId],
        );
        if ((deleted.rowCount ?? 0) === 0) {
          // Unbekannt, fremd oder bereits entfernt: einheitlich Erfolg ohne
          // Informationsleck und ohne zweiten Audit-Eintrag.
          return;
        }

        // Bereinigt: nur Einrichtungs-ID. Kein Geheimnis, keine URI, kein
        // Passwort. Ein Auditfehler rollt die Loeschung zurueck.
        await insertAuditEvent(client, {
          at: now(),
          actorType: "admin",
          actorId: session.actorId,
          action: ADMIN_MFA_TOTP_CANCEL_ACTION,
          targetType: ADMIN_MFA_TOTP_CANCEL_TARGET_TYPE,
          targetId: enrollmentId,
          details: { enrollment_id: enrollmentId },
        });
      });

      reply.header("Cache-Control", "no-store");
      reply.code(204).send();
    },
  });
}
