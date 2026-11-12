import type { FastifyInstance } from "fastify";
import { ApiError } from "../../http/errors.js";
import {
  createAdminSessionMiddleware,
  requireAdminWrite,
} from "../adminAuth/middleware.js";
import type { AdminAuthService } from "../adminAuth/service.js";
import type { DeviceDetailItem, DeviceListItem, DevicesService } from "./service.js";

export interface DevicesRoutesDeps {
  service: DevicesService;
  adminAuth: AdminAuthService;
}

interface DeviceJson {
  id: string;
  label: string | null;
  manufacturer: string;
  model: string;
  os_version: string;
  sdk_int: number;
  app_version: string;
  app_flavor: string;
  state: "active" | "revoked";
  registered_at: string;
  last_seen_at: string;
  connectivity: "reachable" | "last_seen";
}

function toItemJson(item: DeviceListItem): DeviceJson {
  return {
    id: item.id,
    label: item.label,
    manufacturer: item.manufacturer,
    model: item.model,
    os_version: item.osVersion,
    sdk_int: item.sdkInt,
    app_version: item.appVersion,
    app_flavor: item.appFlavor,
    state: item.state,
    registered_at: item.registeredAt.toISOString(),
    last_seen_at: item.lastSeenAt.toISOString(),
    connectivity: item.connectivity,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Sperr-Request hat laut Vertrag keinen Inhalt; unbekannte Felder sind 400. */
function parseEmptyBody(body: unknown): void {
  if (body === undefined || body === null) {
    return;
  }
  if (!isPlainObject(body)) {
    throw ApiError.invalidRequest();
  }
  if (Object.keys(body).length > 0) {
    throw ApiError.invalidRequest();
  }
}

/**
 * Admin-Geraeterouten (API-VERTRAG.md Abschnitt 5). Jede Route verlangt eine
 * gueltige Sitzung; schreibende Routen zusaetzlich JSON und Origin-Pruefung.
 */
export function registerAdminDeviceRoutes(
  app: FastifyInstance,
  deps: DevicesRoutesDeps,
): void {
  const sessionGuard = createAdminSessionMiddleware(deps.adminAuth);

  app.get(
    "/v1/admin/devices",
    { onRequest: [sessionGuard] },
    async (_request, reply) => {
      const result = await deps.service.listDevices();
      const body: Record<string, unknown> = {
        server_time: result.serverTime.toISOString(),
        online_threshold_s: result.onlineThresholdSeconds,
        items: result.items.map(toItemJson),
      };
      if (result.truncated) {
        body.truncated = true;
      }
      reply.code(200).send(body);
    },
  );

  app.get(
    "/v1/admin/devices/:id",
    { onRequest: [sessionGuard] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const item: DeviceDetailItem = await deps.service.getDevice(id);
      reply.code(200).send({
        ...toItemJson(item),
        last_clock_offset_ms: item.lastClockOffsetMs,
        registration_code_id: item.registrationCodeId,
      });
    },
  );

  app.post(
    "/v1/admin/devices/:id/revoke",
    { onRequest: [requireAdminWrite, sessionGuard] },
    async (request, reply) => {
      parseEmptyBody(request.body);
      const { id } = request.params as { id: string };
      await deps.service.revokeDevice(id);
      reply.code(204).send();
    },
  );
}
