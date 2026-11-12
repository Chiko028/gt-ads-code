import type { FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "../../http/errors.js";
import type { DeviceAuthContext, DeviceAuthService } from "./service.js";

declare module "fastify" {
  interface FastifyInstance {
    deviceAuthService: DeviceAuthService;
  }

  interface FastifyRequest {
    /** Wird von der Geraeteauthentifizierung gesetzt (U4/U5). */
    deviceAuth?: DeviceAuthContext;
  }
}

const BEARER_PATTERN = /^Bearer[ \t]+(\S+)$/i;

/**
 * PreHandler fuer geraeteauthentifizierte Routen (z. B. Heartbeat).
 * Es wird ausschliesslich Authorization: Bearer <token> akzeptiert; jeder
 * Fehler bleibt ohne Details (401 unauthorized bzw. 403 device_revoked).
 */
export function createDeviceAuthMiddleware(
  service: DeviceAuthService,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async function deviceAuthPreHandler(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    const header = request.headers.authorization;
    if (typeof header !== "string") {
      throw ApiError.unauthorized();
    }
    const match = BEARER_PATTERN.exec(header.trim());
    if (match === null) {
      throw ApiError.unauthorized();
    }
    request.deviceAuth = await service.authenticateToken(match[1] as string);
  };
}
