import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppConfig } from "../../config.js";
import { ApiError } from "../../http/errors.js";
import type { RegistrationRateLimiter } from "../../http/rateLimit.js";
import type { RegistrationService } from "./service.js";
import { parseRegistrationRequest } from "./validation.js";

export interface RegistrationRoutesDeps {
  service: RegistrationService;
  limiter: RegistrationRateLimiter;
  config: AppConfig;
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
