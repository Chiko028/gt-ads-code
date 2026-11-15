import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import { ApiError } from "../../http/errors.js";
import { RateLimiter } from "../../http/rateLimit.js";
import {
  ADMIN_SESSION_COOKIE,
  createAdminSessionMiddleware,
  requireAdminWrite,
} from "./middleware.js";
import type { AdminAuthService } from "./service.js";

export interface AdminAuthRoutesDeps {
  service: AdminAuthService;
  /** Fehlversuchszaehler fuer den Login (in-memory, ARCHITEKTUR.md 4). */
  loginLimiter: RateLimiter;
  config: AppConfig;
}

const LOGIN_FIELDS: ReadonlySet<string> = new Set(["password", "username"]);

/**
 * Baut den Login-Rate-Limiter. Es gelten die Fehlversuchsgrenzen des
 * Registrierungsendpunkts (SPEZIFIKATION.md 7): fuer den Pilotbetrieb mit
 * einem Admin ist eine eigene Grenze nicht spezifiziert.
 */
export function createAdminLoginRateLimiter(
  config: AppConfig,
  now: () => number,
): RateLimiter {
  return new RateLimiter({
    max: config.registrationMaxFailsPerSource,
    windowMs: config.registrationMaxFailsWindowSeconds * 1000,
    now,
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ParsedLoginBody {
  password: string;
  username?: string;
}

/**
 * Geschlossenes Login-DTO: password ist Pflicht, username ist optional.
 * Ohne Kennung bleibt die konfigurierte CX-015-Identitaet massgeblich; mit
 * Kennung prueft der Service gezielt genau ein Operatorkonto.
 */
function parseLoginBody(body: unknown): ParsedLoginBody {
  if (!isPlainObject(body)) {
    throw ApiError.invalidRequest();
  }
  for (const key of Object.keys(body)) {
    if (!LOGIN_FIELDS.has(key)) {
      throw ApiError.invalidRequest();
    }
  }
  const password = body.password;
  if (typeof password !== "string" || password.length === 0 || password.length > 4096) {
    throw ApiError.invalidRequest();
  }
  const username = body.username;
  if (username !== undefined) {
    if (typeof username !== "string" || username.length > 128) {
      throw ApiError.invalidRequest();
    }
    return { password, username };
  }
  return { password };
}

/**
 * Admin-Anmeldung und -Abmeldung (API-VERTRAG.md Abschnitt 5). Die Sitzung
 * liegt in einem HttpOnly-/SameSite=Strict-Cookie; der Klartext-Token wird
 * nie gespeichert.
 */
export function registerAdminAuthRoutes(
  app: FastifyInstance,
  deps: AdminAuthRoutesDeps,
): void {
  const sessionGuard = createAdminSessionMiddleware(deps.service);

  app.post(
    "/v1/admin/login",
    { onRequest: [requireAdminWrite] },
    async (request, reply) => {
      const sourceKey = request.ip;
      const gate = deps.loginLimiter.peek(sourceKey);
      if (!gate.allowed) {
        throw ApiError.rateLimited(gate.retryAfterSeconds);
      }

      const body = parseLoginBody(request.body);

      let result;
      try {
        result = await deps.service.login(body.password, body.username);
      } catch (error) {
        // Nur falsche Passwoerter und unbekannte/gesperrte Kennungen zaehlen;
        // Formatfehler sind bereits 400.
        if (error instanceof ApiError && error.code === "unauthorized") {
          deps.loginLimiter.hit(sourceKey);
        }
        throw error;
      }

      deps.loginLimiter.reset(sourceKey);
      reply.setCookie(ADMIN_SESSION_COOKIE, result.token, {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        secure: deps.config.cookieSecure,
        maxAge: deps.config.adminSessionTtlSeconds,
      });
      reply.code(204).send();
    },
  );

  app.post(
    "/v1/admin/logout",
    { onRequest: [requireAdminWrite, sessionGuard] },
    async (request, reply) => {
      const session = request.adminSession;
      if (session === undefined) {
        throw ApiError.unauthorized();
      }
      await deps.service.logout(session.token);
      reply.clearCookie(ADMIN_SESSION_COOKIE, {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        secure: deps.config.cookieSecure,
      });
      reply.code(204).send();
    },
  );
}
