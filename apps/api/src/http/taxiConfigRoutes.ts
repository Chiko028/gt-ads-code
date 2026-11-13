/**
 * CX-053 / R-502: duenne HTTP-Verdrahtung der versionierten Taxi-Konfiguration.
 *
 * Der Adapter enthaelt weder eine zweite Konfigurationstabelle noch eigene
 * Fachlogik. Gelesen und geschrieben wird ausschliesslich ueber den
 * vorhandenen CX-013-Service samt dessen Validierung, Revisionspruefung und
 * Audit-Transaktion. Die Route ergaenzt lediglich:
 *   - die vorhandene Admin-Sitzung und den vorhandenen Schreibschutz
 *     (JSON-Content-Type und Origin),
 *   - die Rechtepruefung aus CX-015 (Admin und Operator lesen, nur Admin
 *     schreibt),
 *   - eine Existenzpruefung des Taxis, damit ein unbekanntes Taxi 404 ergibt,
 *     waehrend ein bekanntes, aber noch nicht konfiguriertes Taxi die
 *     CX-013-Antwort mit Revision 0 und null-Werten liefert.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { ApiError } from "./errors.js";
import { registerJsonRoute } from "./jsonContract.js";
import {
  createAdminSessionMiddleware,
  requireAdminWrite,
} from "../modules/adminAuth/middleware.js";
import type { AdminAuthService } from "../modules/adminAuth/service.js";
import {
  ControlConfigChangeConflictError,
  ControlConfigRevisionConflictError,
  ControlConfigValidationError,
  type ControlConfigService,
  type TaxiControlConfigValues,
} from "../modules/controlConfig/index.js";

/** Routentemplate; der Parametername entspricht dem CX-015-Katalog. */
export const TAXI_CONFIG_PATH = "/v1/admin/taxis/:taxiId/config";

/**
 * Existenzpruefung eines Taxis. Sie ist ein reiner Adapterport: CX-013 kennt
 * bewusst keine Taxi-Stammdaten und liefert fuer eine unbekannte ID dieselbe
 * leere Konfiguration wie fuer ein noch nicht konfiguriertes Taxi.
 */
export type TaxiExists = (taxiId: string) => Promise<boolean>;

/**
 * Standardpruefung gegen die vorhandenen Taxi-bezogenen Tabellen. Es wird
 * keine neue Tabelle und kein neuer Stammdatenbegriff eingefuehrt; ein Taxi
 * gilt als bekannt, sobald es in einer der bestehenden Persistenzen
 * referenziert ist.
 */
export function createSqlTaxiExists(
  queryable: Pick<Pool, "query">,
): TaxiExists {
  return async function taxiExists(taxiId: string): Promise<boolean> {
    const tables = [
      "control_config_taxi",
      "remote_control_taxi_state",
      "taxi_manifest_state",
      "taxi_group_memberships",
    ];
    for (const table of tables) {
      const present = await queryable.query<{ present: boolean }>(
        "select to_regclass($1) is not null as present",
        [table],
      );
      if (present.rows[0]?.present !== true) {
        continue;
      }
      const hit = await queryable.query<{ present: boolean }>(
        "select exists (select 1 from " + table + " where taxi_id = $1) as present",
        [taxiId],
      );
      if (hit.rows[0]?.present === true) {
        return true;
      }
    }
    return false;
  };
}

export interface TaxiConfigRoutesDeps {
  service: ControlConfigService;
  adminAuth: AdminAuthService;
  taxiExists: TaxiExists;
}

/** Die vier freigegebenen Konfigurationsfelder; GPS bleibt ausschliesslich "aus". */
const CONFIG_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "gps_mode",
    "pause_max_duration_s",
    "pause_end_on_vehicle_off",
    "display_run_on_s",
  ],
  properties: {
    gps_mode: { type: "string", enum: ["aus"] },
    pause_max_duration_s: {
      type: ["integer", "null"],
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    pause_end_on_vehicle_off: { type: ["boolean", "null"] },
    display_run_on_s: {
      type: ["integer", "null"],
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
  },
};

/**
 * Geschlossenes PATCH-Schema: expected_revision plus die vier Felder. Ein
 * optionales change_id erlaubt die vorhandene CX-013-Idempotenz; fehlt es,
 * erzeugt der Adapter eine eindeutige ID. Unbekannte Felder und jede
 * GPS-Aktivierung werden vor dem Handler abgewiesen.
 */
const UPDATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "expected_revision",
    "gps_mode",
    "pause_max_duration_s",
    "pause_end_on_vehicle_off",
    "display_run_on_s",
  ],
  properties: {
    expected_revision: { type: "integer", minimum: 0 },
    change_id: { type: "string", minLength: 1 },
    ...(CONFIG_SCHEMA.properties as Record<string, unknown>),
  },
};

function actorIdOf(request: FastifyRequest): string {
  const principal = request.accessPrincipal;
  if (principal === undefined || principal.id.length === 0) {
    // Der Rechtekern laesst keinen unauthentifizierten Aufruf bis hierher;
    // die Pruefung bleibt als Verteidigung in der Tiefe erhalten.
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

function bodyOf(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw ApiError.invalidRequest();
  }
  return body as Record<string, unknown>;
}

function configOf(body: Record<string, unknown>): TaxiControlConfigValues {
  return {
    gps_mode: "aus",
    pause_max_duration_s: body.pause_max_duration_s as number | null,
    pause_end_on_vehicle_off: body.pause_end_on_vehicle_off as
      | boolean
      | null,
    display_run_on_s: body.display_run_on_s as number | null,
  };
}

/**
 * Bildet die typisierten CX-013-Fehler auf das zentrale HTTP-Fehlerformat ab.
 * Der API-Vertrag kennt keinen eigenen Revisionskonflikt-Code; der einzige
 * 409-Code der bestehenden Liste bleibt environment_mismatch. Inhaltliche
 * Validierungsfehler bleiben 400 invalid_request. Es wird nichts mutiert,
 * weil der Service vor jeder Schreiboperation abbricht.
 */
function mapControlConfigError(error: unknown): never {
  if (
    error instanceof ControlConfigRevisionConflictError ||
    error instanceof ControlConfigChangeConflictError
  ) {
    throw new ApiError("environment_mismatch");
  }
  if (error instanceof ControlConfigValidationError) {
    throw ApiError.invalidRequest();
  }
  throw error;
}

export function registerTaxiConfigRoutes(
  app: FastifyInstance,
  deps: TaxiConfigRoutesDeps,
): void {
  const sessionGuard = createAdminSessionMiddleware(deps.adminAuth);

  app.get(
    TAXI_CONFIG_PATH,
    { onRequest: [sessionGuard] },
    async (request, reply) => {
      const taxiId = taxiIdOf(request);
      if (!(await deps.taxiExists(taxiId))) {
        throw ApiError.notFound();
      }
      const config = await deps.service.readTaxiConfig({
        actor: { id: actorIdOf(request), type: "admin" },
        taxi_id: taxiId,
      });
      reply.code(200).send(config);
    },
  );

  registerJsonRoute(app, {
    method: "PATCH",
    url: TAXI_CONFIG_PATH,
    bodySchema: UPDATE_SCHEMA,
    onRequest: [requireAdminWrite, sessionGuard],
    handler: async (request, reply) => {
      const taxiId = taxiIdOf(request);
      if (!(await deps.taxiExists(taxiId))) {
        throw ApiError.notFound();
      }

      const body = bodyOf(request);
      const changeId =
        typeof body.change_id === "string" && body.change_id.trim() !== ""
          ? body.change_id.trim()
          : randomUUID();

      try {
        const result = await deps.service.updateTaxiConfig({
          actor: { id: actorIdOf(request), type: "admin" },
          taxi_id: taxiId,
          change_id: changeId,
          expected_revision: body.expected_revision as number,
          config: configOf(body),
        });
        reply.code(200).send(result);
      } catch (error) {
        mapControlConfigError(error);
      }
    },
  });
}

