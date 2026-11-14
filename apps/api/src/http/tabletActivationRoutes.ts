/**
 * CX-127 / R-104 Teil 18: geschuetzte HTTP-Route fuer den administrativen
 * Aktivzustand eines Tablets.
 *
 * Der Adapter enthaelt keine eigene Fachlogik, kein SQL und keinen zweiten
 * Audit-Eintrag. Er validiert den geschlossenen JSON-Body und die Tablet-ID,
 * bestimmt den Akteur serverseitig aus der vorhandenen Sitzung und ruft den
 * CX-126-Dienst genau einmal auf. Dessen Transaktion und Audit bleiben
 * allein massgeblich; zurueckgegeben werden nur bestaetigte Zustaende und
 * Revisionen. Revisionskonflikte werden zu 409, eine unbekannte Tablet-ID zu
 * 404, alle uebrigen unbekannten Ausnahmen zu einem bereinigten 500.
 *
 * Pfad und Methode folgen der Vorgabe, weil im Bestand keine gleichwertige
 * Tablet-Aktivierungsroute registriert ist (CX-037 nutzt den Inventar-PATCH).
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
  TabletActivationError,
  type TabletActivationService,
  type TabletActiveStateResult,
} from "../modules/tabletActivation/index.js";

/** Routentemplate der Tablet-Aktivierung. */
export const TABLET_ACTIVATION_PATH =
  "/v1/admin/tablets/:tabletId/activation";

export interface TabletActivationRoutesDeps {
  service: TabletActivationService;
  adminAuth: AdminAuthService;
}

/** Geschlossenes DTO: nur Sollzustand und erwartete Revision. */
const ACTIVATION_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["active", "expectedRevision"],
  properties: {
    active: { type: "boolean" },
    expectedRevision: { type: "integer", minimum: 0 },
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

function bodyOf(request: FastifyRequest): {
  active: boolean;
  expectedRevision: number;
} {
  const body = request.body as Record<string, unknown> | null;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw ApiError.invalidRequest();
  }
  return {
    active: body.active as boolean,
    expectedRevision: body.expectedRevision as number,
  };
}

/** Bildet ausschliesslich die typisierten CX-126-Fehler auf HTTP ab. */
function mapTabletActivationError(error: unknown): never {
  if (error instanceof TabletActivationError) {
    if (error.code === "not_found") {
      throw ApiError.notFound();
    }
    if (
      error.code === "revision_conflict" ||
      error.code === "revoked_identity" ||
      error.code === "invalid_assignment"
    ) {
      throw new ApiError("invalid_request", { statusCode: 409 });
    }
    if (error.code === "invalid_request") {
      throw ApiError.invalidRequest();
    }
  }
  throw error;
}

/** Nur bestaetigte Verwaltungszustaende und Revisionen nach aussen. */
function responseBody(result: TabletActiveStateResult): Record<string, unknown> {
  return {
    active: result.active,
    revision: result.revision,
    taxi:
      result.taxi === null
        ? null
        : {
            taxiId: result.taxi.taxiId,
            active: result.taxi.active,
            revision: result.taxi.revision,
          },
  };
}

/** Registriert die Tablet-Aktivierungsroute genau einmal. */
export function registerTabletActivationRoute(
  app: FastifyInstance,
  deps: TabletActivationRoutesDeps,
): void {
  const sessionGuard = createAdminSessionMiddleware(deps.adminAuth);

  registerJsonRoute(app, {
    method: "PATCH",
    url: TABLET_ACTIVATION_PATH,
    bodySchema: ACTIVATION_SCHEMA,
    onRequest: [requireAdminWrite, sessionGuard],
    handler: async (request, reply) => {
      const body = bodyOf(request);
      let result: TabletActiveStateResult;
      try {
        result = await deps.service.setActiveState({
          deviceId: tabletIdOf(request),
          expectedRevision: body.expectedRevision,
          active: body.active,
          actorId: actorIdOf(request),
        });
      } catch (error) {
        mapTabletActivationError(error);
      }
      reply.code(200).send(responseBody(result));
    },
  });
}
