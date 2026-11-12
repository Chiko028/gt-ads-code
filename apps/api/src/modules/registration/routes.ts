import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppConfig } from "../../config.js";
import { ApiError } from "../../http/errors.js";
import type { RegistrationRateLimiter } from "../../http/rateLimit.js";
import {
  createAdminSessionMiddleware,
  requireAdminWrite,
} from "../adminAuth/middleware.js";
import type { AdminAuthService } from "../adminAuth/service.js";
import type {
  RegistrationCodeListItem,
  RegistrationService,
} from "./service.js";
import { parseRegistrationRequest } from "./validation.js";

export interface RegistrationRoutesDeps {
  service: RegistrationService;
  limiter: RegistrationRateLimiter;
  config: AppConfig;
}

export interface AdminRegistrationRoutesDeps {
  service: RegistrationService;
  adminAuth: AdminAuthService;
}

function requireApiVersion(request: FastifyRequest): void {
  const raw = request.headers["x-gt-ads-api-version"];
  if (typeof raw !== "string" || raw.trim() !== "1") {
    throw ApiError.invalidRequest();
  }
}

function isCountedFailure(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === "invalid_registration_code" ||
      error.code === "key_already_registered")
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Body des Code-Erzeugens: optionales Label, keine weiteren Felder. */
function parseLabelBody(body: unknown): unknown {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (!isPlainObject(body)) {
    throw ApiError.invalidRequest();
  }
  for (const key of Object.keys(body)) {
    if (key !== "label") {
      throw ApiError.invalidRequest();
    }
  }
  return body.label;
}

function toCodeJson(item: RegistrationCodeListItem): {
  id: string;
  label: string | null;
  created_at: string;
  expires_at: string;
  status: string;
} {
  return {
    id: item.id,
    label: item.label,
    created_at: item.createdAt.toISOString(),
    expires_at: item.expiresAt.toISOString(),
    status: item.status,
  };
}

/**
 * Geraete-Registrierung (API-VERTRAG.md Abschnitt 2). Der Fehlversuchszaehler
 * wird nur bei fachlichen Codefehlern erhoeht, nicht bei Formatfehlern.
 */
export function registerRegistrationRoutes(
  app: FastifyInstance,
  deps: RegistrationRoutesDeps,
): void {
  app.post("/v1/device/register", async (request, reply) => {
    requireApiVersion(request);

    const sourceKey = request.ip;
    const gate = deps.limiter.check(sourceKey);
    if (!gate.allowed) {
      throw ApiError.rateLimited(gate.retryAfterSeconds);
    }

    const input = parseRegistrationRequest(
      request.body,
      deps.config.registrationCodeLength,
    );

    let result;
    try {
      result = await deps.service.register(input);
    } catch (error) {
      if (isCountedFailure(error)) {
        deps.limiter.recordFailure(sourceKey);
      }
      throw error;
    }

    reply.code(201).send({
      device_id: result.deviceId,
      server_time: result.serverTime.toISOString(),
      server_env: result.serverEnv,
      config: {
        heartbeat_interval_s: result.heartbeatIntervalSeconds,
        api_version: 1,
      },
    });
  });
}

/**
 * Admin-Routen fuer Registrierungscodes (API-VERTRAG.md Abschnitt 5).
 * Der Klartext-Code erscheint nur in der Antwort des Erzeugens (AC-05).
 */
export function registerAdminRegistrationCodeRoutes(
  app: FastifyInstance,
  deps: AdminRegistrationRoutesDeps,
): void {
  const sessionGuard = createAdminSessionMiddleware(deps.adminAuth);

  app.post(
    "/v1/admin/registration-codes",
    { onRequest: [requireAdminWrite, sessionGuard] },
    async (request, reply) => {
      const label = parseLabelBody(request.body);
      const created = await deps.service.createRegistrationCode({ label });
      reply.code(201).send({
        id: created.id,
        code: created.code,
        label: created.label,
        expires_at: created.expiresAt.toISOString(),
      });
    },
  );

  app.get(
    "/v1/admin/registration-codes",
    { onRequest: [sessionGuard] },
    async (_request, reply) => {
      const items = await deps.service.listRegistrationCodes();
      reply.code(200).send({ items: items.map(toCodeJson) });
    },
  );

  app.delete(
    "/v1/admin/registration-codes/:id",
    { onRequest: [requireAdminWrite, sessionGuard] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await deps.service.revokeRegistrationCode(id);
      reply.code(204).send();
    },
  );
}
