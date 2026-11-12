import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "../../http/errors.js";
import type { DeviceAuthService } from "./service.js";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const CHALLENGE_FIELDS: ReadonlySet<string> = new Set(["device_id"]);
const TOKEN_FIELDS: ReadonlySet<string> = new Set([
  "device_id",
  "nonce",
  "signature",
]);

export interface DeviceAuthRoutesDeps {
  service: DeviceAuthService;
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

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw ApiError.invalidRequest();
    }
  }
}

function parseBody(
  body: unknown,
  allowed: ReadonlySet<string>,
): Record<string, unknown> {
  if (!isPlainObject(body)) {
    throw ApiError.invalidRequest();
  }
  rejectUnknownFields(body, allowed);
  return body;
}

function parseDeviceId(value: unknown): string {
  if (typeof value !== "string") {
    throw ApiError.invalidRequest();
  }
  const normalized = value.toLowerCase();
  if (!UUID_V4_PATTERN.test(normalized)) {
    throw ApiError.invalidRequest();
  }
  return normalized;
}

function parseNonce(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw ApiError.invalidRequest();
  }
  return value;
}

function parseSignature(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    throw ApiError.invalidRequest();
  }
  return value;
}

/**
 * Geraeteauthentifizierung nach API-VERTRAG.md Abschnitt 3. Formatfehler
 * ergeben invalid_request; fachliche Fehler bleiben gleichfoermig.
 */
export function registerDeviceAuthRoutes(
  app: FastifyInstance,
  deps: DeviceAuthRoutesDeps,
): void {
  app.post("/v1/device/auth/challenge", async (request, reply) => {
    requireApiVersion(request);
    const body = parseBody(request.body, CHALLENGE_FIELDS);
    const deviceId = parseDeviceId(body.device_id);

    const result = await deps.service.createChallenge(deviceId);
    reply.code(200).send({
      nonce: result.nonce,
      expires_at: result.expiresAt.toISOString(),
    });
  });

  app.post("/v1/device/auth/token", async (request, reply) => {
    requireApiVersion(request);
    const body = parseBody(request.body, TOKEN_FIELDS);
    const deviceId = parseDeviceId(body.device_id);
    const nonce = parseNonce(body.nonce);
    const signature = parseSignature(body.signature);

    const result = await deps.service.issueToken({ deviceId, nonce, signature });
    reply.code(200).send({
      access_token: result.accessToken,
      token_type: result.tokenType,
      expires_at: result.expiresAt.toISOString(),
    });
  });
}
