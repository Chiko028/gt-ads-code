/**
 * CX-046 / R-401: authentifizierter, idempotenter Tablet-Ereigniseingang.
 *
 * Der Adapter ist ausschliesslich die HTTP-Grenze des vorhandenen
 * CX-009-Speicherkerns. Er validiert den gesamten Batch (AJV und CX-009) vor
 * dem Speichern, leitet die Geraeteidentitaet ausschliesslich aus dem
 * authentifizierten Kontext ab und uebergibt den Batch transaktional an
 * ingestObservations(). Es gibt keinen zweiten Deduplizierungs- oder
 * Ereignisspeicher.
 *
 * Die Route nutzt die vorhandene Geraeteauthentifizierung (GT-ADS-001 U4) und
 * damit den Widerrufsschutz aus CX-036. Ereigniszeit bleibt unveraendert;
 * received_at bestimmt der CX-009-Kern serverseitig.
 */
import type { FastifyInstance } from "fastify";
import { createDeviceAuthMiddleware } from "../modules/deviceAuth/middleware.js";
import type { DeviceAuthService } from "../modules/deviceAuth/service.js";
import type {
  IngestObservationsResult,
  TelemetryIngestService,
} from "../modules/telemetry/index.js";
import {
  TelemetryConflictError,
  TelemetryStorageError,
  TelemetryValidationError,
} from "../modules/telemetry/index.js";
import { ApiError } from "./errors.js";
import { registerJsonRoute } from "./jsonContract.js";

/** Einzige registrierte Ereignisroute (siehe Rechtekern-Katalog). */
export const DEVICE_EVENTS_PATH = "/v1/device/events";

/** Arbeitsspezifische Obergrenze des JSON-Bodys. */
export const DEVICE_EVENTS_BODY_LIMIT_BYTES = 256 * 1024;

/** Batchgrenzen des vorhandenen CX-009-Kerns. */
export const DEVICE_EVENTS_MIN_BATCH_SIZE = 1;
export const DEVICE_EVENTS_MAX_BATCH_SIZE = 100;

/**
 * Kanonischer UTC-Zeitpunkt mit Millisekunden. Die inhaltliche Pruefung
 * (Kalendergueltigkeit, Rueckvergleich) bleibt zusaetzlich im CX-009-Kern.
 */
const UTC_MILLISECOND_PATTERN =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$";

/** Exakt die bestehenden Felder des CX-009-Ereignistyps. */
const EVENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "event_id",
    "occurred_at",
    "vehicle_ready",
    "paused",
    "playback",
    "technical_fault",
  ],
  properties: {
    event_id: { type: "string", format: "uuid" },
    occurred_at: { type: "string", pattern: UTC_MILLISECOND_PATTERN },
    vehicle_ready: { type: ["boolean", "null"] },
    paused: { type: ["boolean", "null"] },
    playback: { type: "string", enum: ["playing", "stopped", "unknown"] },
    technical_fault: { type: ["boolean", "null"] },
  },
};

/** Geschlossenes Wurzel-Body-Schema mit 1 bis 100 Ereignissen. */
export const DEVICE_EVENTS_BODY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["events"],
  properties: {
    events: {
      type: "array",
      minItems: DEVICE_EVENTS_MIN_BATCH_SIZE,
      maxItems: DEVICE_EVENTS_MAX_BATCH_SIZE,
      items: EVENT_SCHEMA,
    },
  },
};

/** Schmale Speichergrenze; die Produktionsverdrahtung bindet CX-009. */
export interface DeviceEventIngest {
  ingestObservations(
    deviceId: string,
    events: unknown,
  ): Promise<IngestObservationsResult>;
}

export interface DeviceEventRoutesDeps {
  ingest: DeviceEventIngest;
  deviceAuth: DeviceAuthService;
}

/** API-VERTRAG.md Abschnitt 1: Geraeteheader ist Pflicht. */
function requireApiVersion(headers: Record<string, unknown>): void {
  const raw = headers["x-gt-ads-api-version"];
  if (typeof raw !== "string" || raw.trim() !== "1") {
    throw ApiError.invalidRequest();
  }
}

function eventsOf(body: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw ApiError.invalidRequest();
  }
  const events = (body as { events?: unknown }).events;
  if (events === undefined) {
    throw ApiError.invalidRequest();
  }
  return events;
}

/**
 * Registriert POST /v1/device/events genau einmal. Die Geraeteauthentifizierung
 * laeuft als onRequest-Hook vor der Bodyverarbeitung; die Identitaet stammt
 * ausschliesslich aus dem Bearer-Nachweis.
 */
export function registerDeviceEventRoutes(
  app: FastifyInstance,
  deps: DeviceEventRoutesDeps,
): void {
  registerJsonRoute(app, {
    method: "POST",
    url: DEVICE_EVENTS_PATH,
    bodyLimit: DEVICE_EVENTS_BODY_LIMIT_BYTES,
    bodySchema: DEVICE_EVENTS_BODY_SCHEMA,
    onRequest: createDeviceAuthMiddleware(deps.deviceAuth),
    handler: async (request, reply) => {
      const context = request.deviceAuth;
      if (context === undefined) {
        throw ApiError.unauthorized();
      }

      requireApiVersion(request.headers as Record<string, unknown>);
      const events = eventsOf(request.body);

      let result: IngestObservationsResult;
      try {
        result = await deps.ingest.ingestObservations(
          context.deviceId,
          events,
        );
      } catch (error) {
        if (error instanceof TelemetryValidationError) {
          throw ApiError.invalidRequest();
        }
        if (error instanceof TelemetryConflictError) {
          // CX-009-Konfliktsemantik: abweichende Wiederverwendung derselben
          // (device_id, event_id) ist ein 409 ohne Ueberschreiben.
          throw new ApiError("invalid_request", { statusCode: 409 });
        }
        if (error instanceof TelemetryStorageError) {
          throw new ApiError("internal_error");
        }
        // Unbekannte Datenbankfehler werden vom CX-033-Baustein bereinigt zu
        // 500 internal_error; eine Erfolgsbestaetigung entsteht nie.
        throw error;
      }

      // Nur tatsaechlich persistierte oder bereits identisch vorhandene
      // Ereignisse; IDs sind je Batch eindeutig.
      reply.code(200).send({
        accepted_event_ids: result.acceptedEventIds,
        inserted_event_ids: result.insertedEventIds,
        duplicate_event_ids: result.duplicateEventIds,
      });
    },
  });
}

/** Nur fuer die Produktionsverdrahtung: CX-009-Kern als schmale Grenze. */
export function telemetryIngestAdapter(
  service: TelemetryIngestService,
): DeviceEventIngest {
  return {
    ingestObservations: (deviceId, events) =>
      service.ingestObservations(deviceId, events),
  };
}

