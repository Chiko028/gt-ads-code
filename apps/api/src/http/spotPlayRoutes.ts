/**
 * CX-159: HTTP-Grenze der Spot-Abspielnachweise.
 *
 * POST /v1/device/spot-plays nutzt dieselbe Geraeteauthentifizierung wie
 * /v1/device/events und denselben geschlossenen JSON-Vertragsbaustein.
 * GET /v1/admin/spot-plays/summary ist eine menschliche Leseroute; die
 * Sitzung, die Rolle und die Aktion devices.read pruefen der Rechtekern und
 * der vorhandene Sitzungsguard vor dem Handler.
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { AdminAuthService } from "../modules/adminAuth/service.js";
import type { DeviceAuthService } from "../modules/deviceAuth/service.js";
import {
  createSpotPlayService,
  parseMonth,
  SpotPlayConflictError,
  SpotPlayStorageError,
  SpotPlayValidationError,
  type MonthlySpotPlaySummary,
  type SpotPlayIngestResult,
} from "../modules/spotPlays/index.js";
import { createAdminSessionMiddleware } from "../modules/adminAuth/middleware.js";
import { createDeviceAuthMiddleware } from "../modules/deviceAuth/middleware.js";
import { ApiError } from "./errors.js";
import { registerJsonRoute } from "./jsonContract.js";

/** Einzige Schreibroute dieses Arbeitspakets. */
export const SPOT_PLAYS_PATH = "/v1/device/spot-plays";
/** Einzige Leseroute dieses Arbeitspakets. */
export const SPOT_PLAY_SUMMARY_PATH = "/v1/admin/spot-plays/summary";
/** Arbeitsspezifische Obergrenze des JSON-Bodys. */
export const SPOT_PLAYS_BODY_LIMIT_BYTES = 256 * 1024;

const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 100;

const PLAY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "play_id",
    "campaign_id",
    "media_id",
    "started_at",
    "ended_at",
    "played_ms",
    "completed",
  ],
  properties: {
    play_id: { type: "string" },
    campaign_id: { type: "string" },
    media_id: { type: "string" },
    started_at: { type: "string" },
    ended_at: { type: "string" },
    played_ms: { type: "integer", minimum: 0, maximum: 3_600_000 },
    completed: { type: "boolean" },
  },
};

/** Geschlossenes Wurzel-Body-Schema mit 1 bis 100 Meldungen. */
export const SPOT_PLAYS_BODY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["plays"],
  properties: {
    plays: {
      type: "array",
      minItems: MIN_BATCH_SIZE,
      maxItems: MAX_BATCH_SIZE,
      items: PLAY_SCHEMA,
    },
  },
};

export interface SpotPlayRoutesDeps {
  pool: Pool;
  deviceAuth: DeviceAuthService;
  adminAuth: AdminAuthService;
  /** Injizierbare Serveruhr; ohne Angabe gilt die reale Uhr. */
  now?: () => Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** API-VERTRAG.md Abschnitt 1: Geraeteheader ist Pflicht. */
function requireApiVersion(headers: Record<string, unknown>): void {
  const raw = headers["x-gt-ads-api-version"];
  if (typeof raw !== "string" || raw.trim() !== "1") {
    throw ApiError.invalidRequest();
  }
}

function playsOf(body: unknown): unknown {
  if (!isRecord(body)) {
    throw ApiError.invalidRequest();
  }
  const plays = body.plays;
  if (plays === undefined) {
    throw ApiError.invalidRequest();
  }
  return plays;
}

/** Nur genau der Parameter month ist zulaessig. */
function monthOf(query: unknown): string {
  if (!isRecord(query)) {
    throw ApiError.invalidRequest();
  }
  const keys = Object.keys(query);
  if (keys.length !== 1 || keys[0] !== "month") {
    throw ApiError.invalidRequest();
  }
  try {
    return parseMonth(query.month);
  } catch (error) {
    if (error instanceof SpotPlayValidationError) {
      throw ApiError.invalidRequest();
    }
    throw error;
  }
}

export function registerSpotPlayRoutes(
  app: FastifyInstance,
  deps: SpotPlayRoutesDeps,
): void {
  const service = createSpotPlayService({
    pool: deps.pool,
    now: deps.now,
  });
  const sessionGuard = createAdminSessionMiddleware(deps.adminAuth);

  registerJsonRoute(app, {
    method: "POST",
    url: SPOT_PLAYS_PATH,
    bodyLimit: SPOT_PLAYS_BODY_LIMIT_BYTES,
    bodySchema: SPOT_PLAYS_BODY_SCHEMA,
    onRequest: createDeviceAuthMiddleware(deps.deviceAuth),
    handler: async (request, reply) => {
      const context = request.deviceAuth;
      if (context === undefined) {
        throw ApiError.unauthorized();
      }
      requireApiVersion(request.headers as Record<string, unknown>);
      const plays = playsOf(request.body);

      let result: SpotPlayIngestResult;
      try {
        result = await service.ingest(context.deviceId, plays);
      } catch (error) {
        if (error instanceof SpotPlayValidationError) {
          throw ApiError.invalidRequest();
        }
        if (error instanceof SpotPlayConflictError) {
          // Abweichende Wiederverwendung derselben play_id: 409 ohne
          // Ueberschreiben und ohne Teilbestaetigung des Batches.
          throw new ApiError("invalid_request", { statusCode: 409 });
        }
        if (error instanceof SpotPlayStorageError) {
          throw new ApiError("internal_error");
        }
        throw error;
      }

      reply.code(200).send({
        accepted: result.acceptedPlayIds.length,
        inserted: result.insertedPlayIds.length,
        duplicate_play_ids: result.duplicatePlayIds,
        accepted_play_ids: result.acceptedPlayIds,
      });
    },
  });

  registerJsonRoute(app, {
    method: "GET",
    url: SPOT_PLAY_SUMMARY_PATH,
    onRequest: sessionGuard,
    handler: async (request, reply) => {
      if (request.accessPrincipal === undefined) {
        throw ApiError.unauthorized();
      }
      const month = monthOf(request.query);

      let summary: MonthlySpotPlaySummary;
      try {
        summary = await service.monthlySummary(month);
      } catch (error) {
        if (error instanceof SpotPlayValidationError) {
          throw ApiError.invalidRequest();
        }
        throw error;
      }

      reply.header("Cache-Control", "no-store");
      reply.code(200).send(summary);
    },
  });
}
