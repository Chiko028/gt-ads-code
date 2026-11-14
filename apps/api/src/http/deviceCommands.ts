/**
 * CX-054 / R-503: geraetegebundener Abruf und Quittierung des taxiweiten
 * Pausensollzustands.
 *
 * Die beiden Routen sind ausschliesslich die HTTP-Grenze des vorhandenen
 * CX-012/CX-052-Kerns:
 * - GET liest nur; es gibt kein Loeschen, kein Timeout und keine Mutation.
 * - POST quittiert ausschliesslich die tatsaechlich angewandte Revision und
 *   delegiert die monotone, idempotente Statusaenderung an
 *   RemoteControlService.acknowledgeApplied().
 *
 * Tablet und Taxi stammen ausschliesslich aus der authentifizierten
 * Geraeteidentitaet (U4) und der aktuellen serverseitigen Zuordnung. Der Body
 * enthaelt nur command_id und revision; eine frei waehlbare Geraete- oder
 * Taxi-ID existiert nicht. Der Widerrufsschutz aus CX-036 wirkt bereits in der
 * vorhandenen Geraeteauthentifizierung vor dem Fachhandler.
 *
 * Vor der Quittierung wird geprueft, dass genau diesem Tablet fuer genau
 * dieses Taxi die angegebene command_id in der angegebenen Revision
 * zugestellt wurde. Damit werden unbekannte, fremde und zukuenftige Auftraege
 * ohne Datenaenderung als Konflikt abgewiesen. Die eigentliche
 * Zustandsaenderung bleibt allein im vorhandenen Kern.
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { ApiError } from "./errors.js";
import { registerJsonRoute } from "./jsonContract.js";
import { createDeviceAuthMiddleware } from "../modules/deviceAuth/middleware.js";
import type { DeviceAuthService } from "../modules/deviceAuth/service.js";
import {
  RemoteControlAckRejectedError,
  RemoteControlDeviceRejectedError,
  RemoteControlValidationError,
  type RemoteControlService,
  type TaxiDirectory,
} from "../modules/remoteControl/index.js";

export const DEVICE_COMMANDS_PATH = "/v1/device/commands";
export const DEVICE_COMMANDS_ACK_PATH = "/v1/device/commands/ack";

/** Geschlossenes Quittungs-DTO: nur Auftrag und Revision. */
const ACK_BODY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["command_id", "revision"],
  properties: {
    command_id: { type: "string", format: "uuid" },
    revision: { type: "integer", minimum: 1 },
  },
};

interface AckBody {
  command_id: string;
  revision: number;
}

interface DeliveryBindingRow {
  status: "pending" | "applied" | "superseded";
}

interface TaxiApplicationRow {
  revision: number;
  pending: number;
  applied: number;
  total: number;
}

export interface DeviceCommandRoutesDeps {
  service: RemoteControlService;
  directory: TaxiDirectory;
  deviceAuth: DeviceAuthService;
  pool: Pool;
}

function bodyOf(request: { body: unknown }): AckBody {
  const body = request.body as Record<string, unknown> | null;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw ApiError.invalidRequest();
  }
  return {
    command_id: body.command_id as string,
    revision: body.revision as number,
  };
}

/** Bildet ausschliesslich die typisierten Kernfehler auf den Vertrag ab. */
function mapCoreError(error: unknown): never {
  if (error instanceof RemoteControlDeviceRejectedError) {
    // Kein Datenbezug nach aussen: Zuordnung/Zustand bleibt ein 403.
    throw ApiError.forbidden();
  }
  if (error instanceof RemoteControlAckRejectedError) {
    // Unbekannt, zukuenftig oder ueberholt: Konflikt ohne Mutation.
    throw new ApiError("invalid_request", { statusCode: 409 });
  }
  if (error instanceof RemoteControlValidationError) {
    throw ApiError.invalidRequest();
  }
  throw error;
}

/**
 * Wahr, wenn fuer die aktuelle Revision des Taxis genau zwei Zustellungen
 * existieren und keine davon mehr ausstehend ist. Nur Lesen.
 */
async function isTaxiFullyApplied(
  pool: Pool,
  taxiId: string,
): Promise<boolean> {
  const result = await pool.query<TaxiApplicationRow>(
    [
      "select s.revision::int as revision,",
      "       count(d.id) filter (where d.status = 'pending')::int as pending,",
      "       count(d.id) filter (where d.status = 'applied')::int as applied,",
      "       count(d.id)::int as total",
      "  from remote_control_taxi_state s",
      "  left join remote_control_deliveries d",
      "    on d.taxi_id = s.taxi_id and d.revision = s.revision",
      " where s.taxi_id = $1",
      " group by s.revision",
    ].join("\n"),
    [taxiId],
  );
  const row = result.rows[0];
  return (
    row !== undefined &&
    row.pending === 0 &&
    row.total === 2 &&
    row.applied === 2
  );
}

/**
 * Bindet die Bestaetigung an den gespeicherten Auftrag dieses authentifizierten
 * Tablets. Liefert den Zustellstatus oder null. Es wird nichts geschrieben.
 */
async function findDeliveryBinding(
  pool: Pool,
  input: {
    deviceId: string;
    taxiId: string;
    commandId: string;
    revision: number;
  },
): Promise<DeliveryBindingRow | null> {
  const result = await pool.query<DeliveryBindingRow>(
    [
      "select d.status",
      "  from remote_control_deliveries d",
      " where d.device_id = $1::uuid",
      "   and d.taxi_id = $2",
      "   and d.command_id = $3::uuid",
      "   and d.revision = $4",
      " order by d.id desc",
      " limit 1",
    ].join("\n"),
    [input.deviceId, input.taxiId, input.commandId, input.revision],
  );
  return result.rows[0] ?? null;
}

async function resolveActiveAssignment(
  deps: DeviceCommandRoutesDeps,
  deviceId: string,
): Promise<{ taxiId: string }> {
  const assignment = await deps.directory.findDeviceAssignment(deviceId);
  if (assignment === null || !assignment.active) {
    throw ApiError.forbidden();
  }
  return { taxiId: assignment.taxiId };
}

/**
 * Registriert GET /v1/device/commands und POST /v1/device/commands/ack genau
 * einmal. Beide Routen sind im zentralen Rechtekern als "device" katalogisiert;
 * Admin-Cookies gewaehren keinen Zugriff.
 */
export function registerDeviceCommandRoutes(
  app: FastifyInstance,
  deps: DeviceCommandRoutesDeps,
): void {
  const deviceGuard = createDeviceAuthMiddleware(deps.deviceAuth);

  registerJsonRoute(app, {
    method: "GET",
    url: DEVICE_COMMANDS_PATH,
    onRequest: deviceGuard,
    handler: async (request, reply) => {
      const context = request.deviceAuth;
      if (context === undefined) {
        throw ApiError.unauthorized();
      }

      const { taxiId } = await resolveActiveAssignment(deps, context.deviceId);

      let pending: Awaited<ReturnType<RemoteControlService["getPendingForDevice"]>>;
      try {
        pending = await deps.service.getPendingForDevice(context.deviceId);
      } catch (error) {
        mapCoreError(error);
      }

      const fullyApplied = await isTaxiFullyApplied(deps.pool, taxiId);
      reply.code(200).send({
        commands:
          pending === null
            ? []
            : [
                {
                  command_id: pending.commandId,
                  revision: pending.revision,
                  desired_paused: pending.desiredPaused,
                },
              ],
        taxi_fully_applied: fullyApplied,
      });
    },
  });

  registerJsonRoute(app, {
    method: "POST",
    url: DEVICE_COMMANDS_ACK_PATH,
    bodySchema: ACK_BODY_SCHEMA,
    onRequest: deviceGuard,
    handler: async (request, reply) => {
      const context = request.deviceAuth;
      if (context === undefined) {
        throw ApiError.unauthorized();
      }
      const body = bodyOf(request);
      const { taxiId } = await resolveActiveAssignment(deps, context.deviceId);

      const binding = await findDeliveryBinding(deps.pool, {
        deviceId: context.deviceId,
        taxiId,
        commandId: body.command_id,
        revision: body.revision,
      });
      if (binding === null || binding.status === "superseded") {
        // Unbekannter/fremder/zukuenftiger Auftrag oder ueberholte Revision.
        throw new ApiError("invalid_request", { statusCode: 409 });
      }

      let result: Awaited<ReturnType<RemoteControlService["acknowledgeApplied"]>>;
      try {
        result = await deps.service.acknowledgeApplied({
          deviceId: context.deviceId,
          taxiId,
          revision: body.revision,
        });
      } catch (error) {
        mapCoreError(error);
      }

      if (result.commandId !== body.command_id.toLowerCase()) {
        // Der Kern hat einen anderen Auftrag gebunden; der Read-Check oben
        // schliesst diesen Fall aus. Trotzdem keine Erfolgsmeldung.
        throw new ApiError("invalid_request", { statusCode: 409 });
      }

      const fullyApplied = await isTaxiFullyApplied(deps.pool, taxiId);
      reply.code(200).send({
        status: "acknowledged",
        command_id: result.commandId,
        revision: result.revision,
        duplicate: result.duplicate,
        taxi_fully_applied: fullyApplied,
      });
    },
  });
}
