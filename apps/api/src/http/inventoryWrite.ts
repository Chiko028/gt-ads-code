/**
 * CX-130 / R-106 Teil 3: geschuetzte, revisionsgebundene Inventaraenderung.
 *
 * Der Adapter enthaelt keine Fachlogik, kein SQL und keinen zweiten
 * Audit-Eintrag. Er validiert Methode, Tablet-ID und den geschlossenen
 * JSON-Body, bestimmt den Akteur serverseitig aus der Sitzung und ruft den
 * CX-128-Dienst genau einmal auf. Dessen Transaktion und Audit bleiben
 * allein massgeblich; es gibt keine Wiederholung und keine Teilaenderung.
 *
 * Der bestehende Clientvertrag (CX-037 / Dashboard) legt Methode, Pfad und
 * die externen Feldnamen bereits fest: PATCH /v1/admin/inventory/:deviceId
 * mit serial_number, device_type, replacement_note und revision. Diese
 * snake_case-Namen werden unveraendert uebernommen; die vier Felder sind
 * Pflicht, die drei Inventarfelder duerfen null sein. Aktivierungs- und
 * Identitaetsfelder sind nicht Teil des Vertrags und werden abgewiesen.
 *
 * Antwort: nur die bestaetigten Inventarfelder und die neue Revision.
 * Geraeteidentitaet, Zuordnung und Aktivzustand werden weder gelesen noch
 * geaendert.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "./errors.js";
import { registerJsonRoute } from "./jsonContract.js";
import {
  createAdminSessionMiddleware,
  requireAdminWrite,
} from "../modules/adminAuth/middleware.js";
import type { AdminAuthService } from "../modules/adminAuth/service.js";
import {
  InventoryError,
  type DeviceInventory,
  type DeviceInventoryService,
} from "../modules/inventory/service.js";

/** Einzige registrierte Route; Kanon des Dashboard-Adapters (CX-037). */
export const INVENTORY_WRITE_PATH = "/v1/admin/inventory/:tabletId";
/** Begrenzte Nutzlast: vier kurze Felder, keine Freitext-Uploads. */
export const INVENTORY_WRITE_BODY_LIMIT = 8 * 1024;

export interface InventoryWriteDeps {
  service: DeviceInventoryService;
  adminAuth: AdminAuthService;
}

/** Geschlossenes DTO mit den externen Feldnamen des bestehenden Clients. */
const INVENTORY_WRITE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "serial_number",
    "device_type",
    "replacement_note",
    "revision",
  ],
  properties: {
    serial_number: { type: ["string", "null"] },
    device_type: { type: ["string", "null"] },
    replacement_note: { type: ["string", "null"] },
    revision: { type: "integer", minimum: 0 },
  },
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function actorIdOf(request: FastifyRequest): string {
  const principal = request.accessPrincipal;
  if (principal === undefined || principal.id.length === 0) {
    throw ApiError.unauthorized();
  }
  return principal.id;
}

function tabletIdOf(request: FastifyRequest): string {
  const params = request.params as { tabletId?: unknown };
  if (
    typeof params.tabletId !== "string" ||
    !UUID_PATTERN.test(params.tabletId.trim())
  ) {
    throw ApiError.invalidRequest();
  }
  return params.tabletId.trim().toLowerCase();
}

/** Der Validator hat die Typen bereits geprueft; hier nur die vier Felder. */
function bodyOf(request: FastifyRequest): {
  serialNumber: string | null;
  deviceType: string | null;
  replacementNote: string | null;
  expectedRevision: number;
} {
  const body = request.body as Record<string, unknown> | null;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw ApiError.invalidRequest();
  }
  return {
    serialNumber: body.serial_number as string | null,
    deviceType: body.device_type as string | null,
    replacementNote: body.replacement_note as string | null,
    expectedRevision: body.revision as number,
  };
}

/** Bildet ausschliesslich die typisierten CX-128-Fehler auf HTTP ab. */
function mapInventoryError(error: unknown): never {
  if (error instanceof InventoryError) {
    if (error.code === "not_found") {
      throw ApiError.notFound();
    }
    if (error.code === "revision_conflict") {
      throw new ApiError("invalid_request", { statusCode: 409 });
    }
    if (error.code === "invalid_request") {
      throw ApiError.invalidRequest();
    }
  }
  throw error;
}

/** Nur bestaetigte Inventarfelder und Revision nach aussen. */
function responseBody(result: DeviceInventory): Record<string, unknown> {
  return {
    id: result.deviceId,
    serial_number: result.serialNumber,
    device_type: result.deviceType,
    replacement_note: result.replacementNote,
    revision: result.revision,
  };
}

/**
 * Registriert PATCH /v1/admin/inventory/:tabletId genau einmal. Der
 * Rechtekern klassifiziert die Route als menschliche Schreibaktion
 * devices.inventory (Admin und Operator); Origin-/Content-Type-Schutz und
 * Sitzungspruefung gelten zusaetzlich. Geraete-Bearer-Nachweise erreichen
 * den Handler nie.
 */
export function registerInventoryWriteRoute(
  app: FastifyInstance,
  deps: InventoryWriteDeps,
): void {
  const sessionGuard = createAdminSessionMiddleware(deps.adminAuth);

  registerJsonRoute(app, {
    method: "PATCH",
    url: INVENTORY_WRITE_PATH,
    bodySchema: INVENTORY_WRITE_SCHEMA,
    bodyLimit: INVENTORY_WRITE_BODY_LIMIT,
    onRequest: [requireAdminWrite, sessionGuard],
    handler: async (request, reply) => {
      const tabletId = tabletIdOf(request);
      const body = bodyOf(request);
      const actorId = actorIdOf(request);
      let result: DeviceInventory;
      try {
        result = await deps.service.replaceInventory(tabletId, body, actorId);
      } catch (error) {
        mapInventoryError(error);
      }
      reply.header("Cache-Control", "no-store");
      reply.code(200).send(responseBody(result));
    },
  });
}
