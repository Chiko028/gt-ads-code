/**
 * CX-125 / R-104: geschuetzte HTTP-Route fuer den administrativen
 * Taxi-Aktivzustand.
 *
 * Der Adapter enthaelt keine eigene Fachlogik, kein SQL und keinen zweiten
 * Audit-Eintrag. Er validiert ausschliesslich den geschlossenen JSON-Body,
 * bestimmt den Akteur serverseitig aus der vorhandenen Sitzung und ruft
 * CX-124 genau einmal auf. Antwort sind nur der bestaetigte Zustand und die
 * bestaetigte Revision; Konflikte werden zu 409, ein unbekanntes Taxi zu 404.
 *
 * Pfad und Methode entsprechen dem bereits vorhandenen Dashboard-Adapter
 * (apps/dashboard/src/fleet/fleetApi.ts, setTaxiActive: POST .../activation).
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
  TaxiActivationError,
  type TaxiActivationService,
} from "../modules/taxiActivation/index.js";

/** Routentemplate; der Parametername entspricht dem CX-015-Katalog. */
export const TAXI_ACTIVATION_PATH = "/v1/admin/taxis/:taxiId/activation";

export interface TaxiActivationRoutesDeps {
  service: TaxiActivationService;
  adminAuth: AdminAuthService;
}

/** Geschlossenes DTO: nur der boolesche Sollzustand und die Revision. */
const ACTIVATION_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["active", "revision"],
  properties: {
    active: { type: "boolean" },
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

function taxiIdOf(request: FastifyRequest): string {
  const params = request.params as { taxiId?: unknown };
  if (typeof params.taxiId !== "string" || params.taxiId.trim() === "") {
    throw ApiError.notFound();
  }
  return params.taxiId;
}

function bodyOf(request: FastifyRequest): { active: boolean; revision: number } {
  const body = request.body as Record<string, unknown> | null;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw ApiError.invalidRequest();
  }
  return { active: body.active as boolean, revision: body.revision as number };
}

/** Bildet ausschliesslich die typisierten CX-124-Fehler auf HTTP ab. */
function mapTaxiActivationError(error: unknown): never {
  if (error instanceof TaxiActivationError) {
    if (error.code === "not_found") {
      throw ApiError.notFound();
    }
    if (error.code === "revision_conflict" || error.code === "invalid_pair") {
      throw new ApiError("invalid_request", { statusCode: 409 });
    }
    if (error.code === "invalid_request") {
      throw ApiError.invalidRequest();
    }
  }
  throw error;
}

/** Registriert die Aktivierungsroute genau einmal. */
export function registerTaxiActivationRoute(
  app: FastifyInstance,
  deps: TaxiActivationRoutesDeps,
): void {
  const sessionGuard = createAdminSessionMiddleware(deps.adminAuth);

  registerJsonRoute(app, {
    method: "POST",
    url: TAXI_ACTIVATION_PATH,
    bodySchema: ACTIVATION_SCHEMA,
    onRequest: [requireAdminWrite, sessionGuard],
    handler: async (request, reply) => {
      const body = bodyOf(request);
      let result: Awaited<ReturnType<TaxiActivationService["setActiveState"]>>;
      try {
        result = await deps.service.setActiveState({
          taxiId: taxiIdOf(request),
          expectedRevision: body.revision,
          active: body.active,
          actorId: actorIdOf(request),
        });
      } catch (error) {
        mapTaxiActivationError(error);
      }
      reply.code(200).send({ active: result.active, revision: result.revision });
    },
  });
}
