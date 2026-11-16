/**
 * CX-133 / R-104 Teil 2: geschuetzte schreibende Taxi-Stammdatenrouten des
 * Dashboards (fleetApi.ts createTaxi/updateTaxi):
 * POST /v1/admin/taxis und PATCH /v1/admin/taxis/:id. Sie enthalten keine
 * eigene Persistenz und kein eigenes Audit; DTO, Fehlerabbildung und Antwort
 * bleiben hier, Transaktion und Audit liegen im Taxidienst.
 *
 * Rechte laut zentralem Rechtekern: POST/PATCH -> taxi.activation. Schreibende Routen tragen zusaetzlich den vorhandenen
 * Schreibschutz (Origin/Content-Type) und die Admin-Sitzungspruefung.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "./errors.js";
import { registerJsonRoute } from "./jsonContract.js";
import {
  createAdminSessionMiddleware,
  requireAdminWrite,
} from "../modules/adminAuth/middleware.js";
import type { AdminAuthService } from "../modules/adminAuth/service.js";
import { MAX_TAXI_GROUP_SELECTION } from "../modules/taxiGroupMemberships/service.js";
import {
  MAX_TAXI_DISPLAY_NAME_LENGTH,
  MAX_TAXI_ID_LENGTH,
  TaxiMasterDataError,
  type TaxiRecord,
  type TaxiService,
} from "../modules/taxis/service.js";

export const TAXI_COLLECTION_PATH = "/v1/admin/taxis";
export const TAXI_ITEM_PATH = "/v1/admin/taxis/:id";

export interface TaxiWriteRoutesDeps {
  service: TaxiService;
  adminAuth: AdminAuthService;
}

const GROUP_IDS_SCHEMA: Record<string, unknown> = {
  type: "array",
  maxItems: MAX_TAXI_GROUP_SELECTION,
  items: { type: "string", format: "uuid" },
};

/** Geschlossenes DTO der Anlage: id, Anzeigename und Gruppen. */
const CREATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["id", "display_name", "group_ids"],
  properties: {
    id: {
      type: "string",
      minLength: 1,
      maxLength: MAX_TAXI_ID_LENGTH,
    },
    display_name: {
      type: "string",
      minLength: 1,
      maxLength: MAX_TAXI_DISPLAY_NAME_LENGTH,
    },
    group_ids: GROUP_IDS_SCHEMA,
  },
};

/** Geschlossenes DTO der Aenderung: Name, Gruppen und erwartete Revision. */
const UPDATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["display_name", "group_ids", "revision"],
  properties: {
    display_name: {
      type: "string",
      minLength: 1,
      maxLength: MAX_TAXI_DISPLAY_NAME_LENGTH,
    },
    group_ids: GROUP_IDS_SCHEMA,
    revision: { type: "integer", minimum: 0 },
  },
};

function actorIdOf(request: FastifyRequest): string {
  const principal = request.accessPrincipal;
  if (principal === undefined || principal.id.length === 0) {
    throw ApiError.unauthorized();
  }
  return principal.id;
}

function bodyOf(request: FastifyRequest): Record<string, unknown> {
  const body = request.body as Record<string, unknown> | null;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw ApiError.invalidRequest();
  }
  return body;
}

function taxiIdOf(request: FastifyRequest): string {
  const params = request.params as { id?: unknown };
  if (typeof params.id !== "string" || params.id.trim() === "") {
    throw ApiError.notFound();
  }
  return params.id;
}

/** Bildet ausschliesslich die typisierten Taxidienstfehler auf HTTP ab. */
function mapTaxiError(error: unknown): never {
  if (error instanceof TaxiMasterDataError) {
    if (error.code === "not_found") {
      throw ApiError.notFound();
    }
    if (error.code === "conflict") {
      throw new ApiError("invalid_request", { statusCode: 409 });
    }
    if (error.code === "invalid_request") {
      throw ApiError.invalidRequest();
    }
  }
  // Unbekannte und interne Ursachen bleiben beim bereinigten 500.
  throw error;
}

function responseOf(taxi: TaxiRecord): Record<string, unknown> {
  return {
    id: taxi.id,
    display_name: taxi.display_name,
    active: taxi.active,
    revision: taxi.revision,
    tablet_ids: taxi.tablet_ids,
    group_ids: taxi.group_ids,
  };
}

/** Registriert POST /v1/admin/taxis und PATCH /v1/admin/taxis/:id je einmal (GET: CX-132, taxiList.ts). */
export function registerTaxiWriteRoutes(
  app: FastifyInstance,
  deps: TaxiWriteRoutesDeps,
): void {
  const sessionGuard = createAdminSessionMiddleware(deps.adminAuth);
  const now = (): Date => new Date();

  registerJsonRoute(app, {
    method: "POST",
    url: TAXI_COLLECTION_PATH,
    bodySchema: CREATE_SCHEMA,
    onRequest: [requireAdminWrite, sessionGuard],
    handler: async (request, reply) => {
      const body = bodyOf(request);
      const actorId = actorIdOf(request);
      let taxi: TaxiRecord;
      try {
        taxi = await deps.service.createTaxi({
          id: body.id,
          displayName: body.display_name,
          groupIds: body.group_ids,
          ownerId: actorId,
          actorId,
          at: now(),
        });
      } catch (error) {
        mapTaxiError(error);
      }
      reply.header("Cache-Control", "no-store");
      reply.code(201).send(responseOf(taxi));
    },
  });

  registerJsonRoute(app, {
    method: "PATCH",
    url: TAXI_ITEM_PATH,
    bodySchema: UPDATE_SCHEMA,
    onRequest: [requireAdminWrite, sessionGuard],
    handler: async (request, reply) => {
      const body = bodyOf(request);
      const actorId = actorIdOf(request);
      let taxi: TaxiRecord;
      try {
        taxi = await deps.service.updateTaxi({
          id: taxiIdOf(request),
          displayName: body.display_name,
          groupIds: body.group_ids,
          expectedRevision: body.revision,
          ownerId: actorId,
          actorId,
          at: now(),
        });
      } catch (error) {
        mapTaxiError(error);
      }
      reply.header("Cache-Control", "no-store");
      reply.code(200).send(responseOf(taxi));
    },
  });
}

