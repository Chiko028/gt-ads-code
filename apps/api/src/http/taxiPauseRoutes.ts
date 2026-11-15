/**
 * CX-052 / R-501: geschuetzte HTTP-Anbindung des vorhandenen CX-012-Kerns.
 *
 * Beide Routen bestimmen den Sollzustand explizit (Pause/Fortsetzen); es gibt
 * keinen Toggle. Der Adapter enthaelt kein SQL, keine eigene Idempotenz und
 * keine zweite Audit-Schreibstelle. Er prueft Taxi und Zielzuordnung ueber die
 * vorhandene CX-035-Leseflaeche, bestimmt den Akteur aus dem bestehenden
 * Admin-Sitzungskontext und ruft den taxiweiten Service genau einmal auf.
 *
 * Die Aktion ist im zentralen Routenkatalog (CX-015) als "taxi.pause"
 * eingetragen. Damit kann CX-015 Operatorrechte ergaenzen, ohne diese Route
 * umzubauen.
 *
 * PFADBLOCKER (CX-052): Der vorhandene CX-012-Kern muesste fuer eine
 * Request-ID im Audit um SetDesiredPauseInput, Normalisierung und den
 * Audit-Datensatz in apps/api/src/modules/remoteControl/ erweitert werden.
 * Dieser Kern liegt ausserhalb der fuer CX-052 freigegebenen Pfade
 * (apps/api/src/http/, apps/api/src/modules/pause/). Die Request-ID wird
 * deshalb hier nicht an den Kern uebergeben; die Anbindung bleibt bis zur
 * ausdruecklichen Freigabe des tatsaechlichen Kernpfads blockiert.
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
  RemoteControlCommandConflictError,
  RemoteControlRevisionConflictError,
  RemoteControlTaxiTargetError,
  RemoteControlValidationError,
  type RemoteControlService,
} from "../modules/remoteControl/index.js";

/** Routentemplates; der Parametername folgt dem CX-052-Auftrag. */
export const TAXI_PAUSE_PATH = "/v1/admin/taxis/:taxi_id/pause";
export const TAXI_RESUME_PATH = "/v1/admin/taxis/:taxi_id/resume";

export interface TaxiPauseRoutesDeps {
  service: RemoteControlService;
  adminAuth: AdminAuthService;
  /** Liest ausschliesslich die vorhandene Taxi-Stammtabelle. */
  taxiExists: (taxiId: string) => Promise<boolean>;
}

/** Geschlossenes DTO: Idempotenzschluessel und erwartete Auftragsrevision. */
const PAUSE_BODY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["command_id", "expected_revision"],
  properties: {
    command_id: { type: "string", format: "uuid" },
    expected_revision: { type: "integer", minimum: 0 },
  },
};

interface PauseBody {
  command_id: string;
  expected_revision: number;
}

function actorIdOf(request: FastifyRequest): string {
  const principal = request.accessPrincipal;
  if (principal === undefined || principal.id.length === 0) {
    throw ApiError.unauthorized();
  }
  return principal.id;
}

function taxiIdOf(request: FastifyRequest): string {
  const params = request.params as { taxi_id?: unknown };
  if (typeof params.taxi_id !== "string" || params.taxi_id.trim() === "") {
    throw ApiError.notFound();
  }
  return params.taxi_id;
}

function bodyOf(request: FastifyRequest): PauseBody {
  const body = request.body as Record<string, unknown> | null;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw ApiError.invalidRequest();
  }
  return {
    command_id: body.command_id as string,
    expected_revision: body.expected_revision as number,
  };
}

/**
 * Bildet ausschliesslich die typisierten CX-012-Fehler auf den vorhandenen
 * Fehlervertrag ab. Konflikte werden 409, ein unbekanntes Taxi 404.
 */
function mapPauseError(error: unknown): never {
  if (error instanceof RemoteControlCommandConflictError) {
    throw new ApiError("invalid_request", { statusCode: 409 });
  }
  if (error instanceof RemoteControlRevisionConflictError) {
    throw new ApiError("invalid_request", { statusCode: 409 });
  }
  if (error instanceof RemoteControlTaxiTargetError) {
    throw new ApiError("invalid_request", { statusCode: 409 });
  }
  if (error instanceof RemoteControlValidationError) {
    throw ApiError.invalidRequest();
  }
  throw error;
}

function registerAction(
  app: FastifyInstance,
  deps: TaxiPauseRoutesDeps,
  action: "pause" | "resume",
): void {
  const sessionGuard = createAdminSessionMiddleware(deps.adminAuth);
  const desiredPaused = action === "pause";

  registerJsonRoute(app, {
    method: "POST",
    url: action === "pause" ? TAXI_PAUSE_PATH : TAXI_RESUME_PATH,
    bodySchema: PAUSE_BODY_SCHEMA,
    onRequest: [requireAdminWrite, sessionGuard],
    handler: async (request, reply) => {
      const body = bodyOf(request);
      const taxiId = taxiIdOf(request);

      if (!(await deps.taxiExists(taxiId))) {
        throw ApiError.notFound();
      }

      let result: Awaited<ReturnType<RemoteControlService["setDesiredPause"]>>;
      try {
        result = await deps.service.setDesiredPause({
          actor: { id: actorIdOf(request), type: "admin" },
          taxiId,
          commandId: body.command_id,
          expectedRevision: body.expected_revision,
          desiredPaused,
        });
      } catch (error) {
        mapPauseError(error);
      }

      // 202: Der taxiweite Sollzustand ist angenommen, aber noch nicht von
      // beiden Tablets quittiert. Es gibt keine vorgetaeuschte Ausfuehrung.
      reply.code(202).send({
        status: "accepted",
        taxi_id: result.taxiId,
        command_id: result.commandId,
        revision: result.revision,
        desired_paused: result.desiredPaused,
        target_device_ids: result.targetDeviceIds,
        acknowledgements_pending: true,
        idempotent: result.idempotent,
      });
    },
  });
}

/** Registriert Pause und Fortsetzen genau einmal am gemeinsamen Kern. */
export function registerTaxiPauseRoutes(
  app: FastifyInstance,
  deps: TaxiPauseRoutesDeps,
): void {
  registerAction(app, deps, "pause");
  registerAction(app, deps, "resume");
}
