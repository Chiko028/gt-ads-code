/**
 * CX-042 / R-302: Fastify-Plugin fuer GET /v1/device/manifest.
 *
 * Die Route hat weder Pfad- noch Query-Parameter fuer Taxi- oder Geraete-IDs.
 * Einzige Identitaet ist die von GT-ADS-001 U4 gesetzte Geraeteauthentisierung.
 * Die Registrierung erfolgt zentral ueber CX-033 (http/composition.ts).
 */
import type { FastifyInstance } from "fastify";
import { ApiError } from "../../http/errors.js";
import { createDeviceAuthMiddleware } from "../deviceAuth/middleware.js";
import type { DeviceAuthService } from "../deviceAuth/service.js";
import {
  MANIFEST_CACHE_CONTROL,
  type DeviceManifestService,
} from "./service.js";

export const DEVICE_MANIFEST_PATH = "/v1/device/manifest";

export interface DeviceManifestRoutesDeps {
  service: DeviceManifestService;
  deviceAuth: DeviceAuthService;
}

export function registerDeviceManifestRoutes(
  app: FastifyInstance,
  deps: DeviceManifestRoutesDeps,
): void {
  app.get(
    DEVICE_MANIFEST_PATH,
    { preHandler: createDeviceAuthMiddleware(deps.deviceAuth) },
    async (request, reply) => {
      const context = request.deviceAuth;
      if (context === undefined) {
        // Die Middleware setzt den Kontext oder wirft; dieser Zweig ist eine
        // reine Absicherung gegen eine falsch verdrahtete Route.
        throw ApiError.unauthorized();
      }

      const result = await deps.service.getManifest(
        context.deviceId,
        request.headers["if-none-match"],
      );

      reply.header("ETag", result.etag);
      reply.header("Cache-Control", MANIFEST_CACHE_CONTROL);

      if (result.statusCode === 304) {
        reply.code(304);
        return reply.send();
      }

      reply.code(200).type("application/json; charset=utf-8");
      return reply.send(result.body);
    },
  );
}

