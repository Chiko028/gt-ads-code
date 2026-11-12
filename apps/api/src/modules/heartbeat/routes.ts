import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "../../http/errors.js";
import { createDeviceAuthMiddleware } from "../deviceAuth/middleware.js";
import type { DeviceAuthService } from "../deviceAuth/service.js";
import type { HeartbeatService } from "./service.js";

const HEARTBEAT_FIELDS: ReadonlySet<string> = new Set([
  "seq",
  "device_time",
  "app_version",
  "os_version",
]);

/** Zeiten laut API-VERTRAG.md Abschnitt 1: ISO-8601 UTC mit ms und Z. */
const ISO_UTC_MS_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface HeartbeatRoutesDeps {
  service: HeartbeatService;
  deviceAuth: DeviceAuthService;
}

function requireApiVersion(request: FastifyRequest): void {
  const raw = request.headers["x-gt-ads-api-version"];
  if (typeof raw !== "string" || raw.trim() !== "1") {
    throw ApiError.invalidRequest();
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBody(body: unknown): Record<string, unknown> {
  if (!isPlainObject(body)) {
    throw ApiError.invalidRequest();
  }
  for (const key of Object.keys(body)) {
    if (!HEARTBEAT_FIELDS.has(key)) {
      throw ApiError.invalidRequest();
    }
  }
  return body;
}

function parseSeq(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw ApiError.invalidRequest();
  }
  return value;
}

function parseDeviceTime(value: unknown): Date {
  if (typeof value !== "string" || !ISO_UTC_MS_PATTERN.test(value)) {
    throw ApiError.invalidRequest();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw ApiError.invalidRequest();
  }
  return parsed;
}

function parseShortText(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) {
    throw ApiError.invalidRequest();
  }
  return value;
}

/**
 * Geraete-Heartbeat (API-VERTRAG.md Abschnitt 4). Der PreHandler prueft das
 * Bearer-Token und den Geraetezustand bei jeder Anfrage (AC-08).
 */
export function registerHeartbeatRoutes(
  app: FastifyInstance,
  deps: HeartbeatRoutesDeps,
): void {
  app.post(
    "/v1/device/heartbeat",
    { preHandler: createDeviceAuthMiddleware(deps.deviceAuth) },
    async (request, reply) => {
      requireApiVersion(request);

      const context = request.deviceAuth;
      if (context === undefined) {
        throw ApiError.unauthorized();
      }

      const body = parseBody(request.body);
      const seq = parseSeq(body.seq);
      const deviceTime = parseDeviceTime(body.device_time);
      const appVersion = parseShortText(body.app_version);
      const osVersion = parseShortText(body.os_version);

      const result = await deps.service.record(context.deviceId, {
        seq,
        deviceTime,
        appVersion,
        osVersion,
      });

      reply.code(200).send({
        server_time: result.serverTime.toISOString(),
        device_state: result.deviceState,
        config: { heartbeat_interval_s: result.heartbeatIntervalSeconds },
      });
    },
  );
}
