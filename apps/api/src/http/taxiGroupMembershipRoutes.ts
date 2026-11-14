/**
 * CX-119 / R-104 Teil 10: geschuetzte HTTP-Route fuer die vollstaendige
 * Gruppenzuordnung genau eines Taxis.
 *
 * Der Adapter enthaelt keine Fachlogik, kein SQL und keinen zweiten
 * Audit-Eintrag. Er validiert den geschlossenen JSON-Body, bestimmt Betreiber
 * und Akteur ausschliesslich aus dem serverseitig geprueften Principal und
 * ruft den CX-118-Dienst genau einmal auf. Dessen Transaktion, Revisionspruefung
 * und Audit bleiben allein massgeblich; es gibt keine Wiederholung und keine
 * automatische Konfliktbehandlung.
 *
 * Pfad und Methode folgen dem bestehenden Verwaltungsmuster
 * (PUT /v1/admin/taxis/:id/groups). Der zentrale Rechtekern klassifiziert die
 * Route als menschliche Schreibaktion groups.write; Origin-/Content-Type-
 * Schutz und Sitzungspruefung gelten zusaetzlich.
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
  MAX_TAXI_GROUP_SELECTION,
  TaxiGroupMembershipError,
  type TaxiGroupMembershipService,
} from "../modules/taxiGroupMemberships/service.js";

/** Einzige registrierte Route; Parametername entspricht dem CX-015-Katalog. */
export const TAXI_GROUP_MEMBERSHIP_PATH = "/v1/admin/taxis/:id/groups";

export interface TaxiGroupMembershipRoutesDeps {
  service: TaxiGroupMembershipService;
  adminAuth: AdminAuthService;
}

/**
 * Geschlossenes DTO: ausschliesslich die gewaehlte Gruppenmenge und der
 * bestehende erwartete Taxi-Aenderungsstand. Betreiber, Akteur und Revision
 * stammen nie aus dem Request. Hoechstens 100 Gruppen-IDs; jede ID muss die
 * vorhandene UUID-Form haben.
 */
const REPLACE_GROUPS_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["group_ids", "revision"],
  properties: {
    group_ids: {
      type: "array",
      maxItems: MAX_TAXI_GROUP_SELECTION,
      items: { type: "string", format: "uuid" },
    },
    revision: { type: "integer", minimum: 0 },
  },
};

interface ReplaceGroupsBody {
  groupIds: string[];
  expectedRevision: number;
}

function actorIdOf(request: FastifyRequest): string {
  const principal = request.accessPrincipal;
  if (principal === undefined || principal.id.length === 0) {
    throw ApiError.unauthorized();
  }
  return principal.id;
}

function taxiIdOf(request: FastifyRequest): string {
  const params = request.params as { id?: unknown };
  if (typeof params.id !== "string" || params.id.trim() === "") {
    throw ApiError.notFound();
  }
  return params.id.trim();
}

/** Der Validator hat Typen und Anzahl bereits geprueft. */
function bodyOf(request: FastifyRequest): ReplaceGroupsBody {
  const body = request.body as Record<string, unknown> | null;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw ApiError.invalidRequest();
  }
  return {
    groupIds: body.group_ids as string[],
    expectedRevision: body.revision as number,
  };
}

/** Bildet ausschliesslich die typisierten CX-118-Fehler auf HTTP ab. */
function mapMembershipError(error: unknown): never {
  if (error instanceof TaxiGroupMembershipError) {
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
  // Unbekannte und interne Ursachen bleiben beim bereinigten 500.
  throw error;
}

/**
 * Registriert PUT /v1/admin/taxis/:id/groups genau einmal. Antwort enthaelt
 * nur die bestaetigte Taxi-ID, die bestaetigte Gruppenmenge und den aktuellen
 * Aenderungsstand; es werden keine weiteren Taxifelder gelesen.
 */
export function registerTaxiGroupMembershipRoute(
  app: FastifyInstance,
  deps: TaxiGroupMembershipRoutesDeps,
): void {
  const sessionGuard = createAdminSessionMiddleware(deps.adminAuth);

  registerJsonRoute(app, {
    method: "PUT",
    url: TAXI_GROUP_MEMBERSHIP_PATH,
    bodySchema: REPLACE_GROUPS_SCHEMA,
    onRequest: [requireAdminWrite, sessionGuard],
    handler: async (request, reply) => {
      const body = bodyOf(request);
      const actorId = actorIdOf(request);
      let result: Awaited<
        ReturnType<TaxiGroupMembershipService["replaceTaxiGroupMemberships"]>
      >;
      try {
        result = await deps.service.replaceTaxiGroupMemberships({
          ownerId: actorId,
          actorId,
          taxiId: taxiIdOf(request),
          expectedRevision: body.expectedRevision,
          groupIds: body.groupIds,
        });
      } catch (error) {
        mapMembershipError(error);
      }
      reply.header("Cache-Control", "no-store");
      reply.code(200).send({
        taxi_id: result.taxiId,
        group_ids: result.groupIds,
        revision: result.revision,
      });
    },
  });
}
