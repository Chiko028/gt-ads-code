/**
 * CX-168: HTTP-Grenze der App-Updates.
 *
 * Admin-Routen (Sitzung, Rolle und Aktion kommen aus dem Rechtekern):
 *   GET   /v1/admin/app-releases              (devices.read)
 *   POST  /v1/admin/app-releases              (appReleases.manage)
 *   PATCH /v1/admin/app-releases/:id          (appReleases.manage)
 *   PATCH /v1/admin/devices/:id/update-channel (appReleases.manage)
 *
 * Geraeterouten (Bearer der vorhandenen Geraeteauthentifizierung):
 *   GET  /v1/device/app-update
 *   GET  /v1/device/app-downloads/:id   (zusaetzlich HMAC-Ticket)
 *   POST /v1/device/app-update/report
 *
 * Es gibt keine zweite Speicherung und keinen zweiten Rechtepfad; alle
 * Fachaenderungen laufen ueber modules/appReleases.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { AdminAuthService } from "../modules/adminAuth/service.js";
import type { DeviceAuthService } from "../modules/deviceAuth/service.js";
import { createAdminSessionMiddleware } from "../modules/adminAuth/middleware.js";
import { createDeviceAuthMiddleware } from "../modules/deviceAuth/middleware.js";
import {
  AppReleaseConflictError,
  AppReleaseNotFoundError,
  AppReleaseStorageError,
  AppReleaseValidationError,
  createAppReleaseService,
  issueAppDownloadTicket,
  APP_RELEASE_MAX_BYTES,
  type AppReleaseOverview,
} from "../modules/appReleases/index.js";
import { ApiError } from "./errors.js";
import { registerJsonRoute } from "./jsonContract.js";

export const APP_RELEASES_PATH = "/v1/admin/app-releases";
export const APP_RELEASE_PATH = "/v1/admin/app-releases/:id";
export const DEVICE_UPDATE_CHANNEL_PATH = "/v1/admin/devices/:id/update-channel";
export const DEVICE_APP_UPDATE_PATH = "/v1/device/app-update";
export const DEVICE_APP_DOWNLOAD_PATH = "/v1/device/app-downloads/:id";
export const DEVICE_APP_REPORT_PATH = "/v1/device/app-update/report";

/** Upload-Obergrenze einschliesslich (200 MB). */
export const APP_RELEASE_UPLOAD_LIMIT_BYTES = APP_RELEASE_MAX_BYTES;

const OCTET_STREAM = "application/octet-stream";

export interface AppReleaseRoutesDeps {
  pool: Pool;
  adminAuth: AdminAuthService;
  deviceAuth: DeviceAuthService;
  /** Ablageort der APK-Dateien; es entsteht <root>/app-releases. */
  storageRoot: string;
  /** Download-Geheimnis; ohne Geheimnis wird kein Ziel angeboten. */
  downloadSecret?: string | null;
  now?: () => Date;
}

interface UploadQuery {
  readonly versionCode: string;
  readonly versionName: string;
  readonly sha256: string;
  readonly notes: string | undefined;
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

/** Nur genau die vier Uploadparameter; jeder Zusatz ist ein Fehler. */
function parseUploadQuery(query: unknown): UploadQuery {
  if (!isRecord(query)) {
    throw ApiError.invalidRequest();
  }
  const record = query;
  const allowed = new Set(["version_code", "version_name", "sha256", "notes"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw ApiError.invalidRequest();
    }
  }
  const versionCode = record.version_code;
  const versionName = record.version_name;
  const sha256 = record.sha256;
  const notes = record.notes;
  if (
    typeof versionCode !== "string" ||
    typeof versionName !== "string" ||
    typeof sha256 !== "string"
  ) {
    throw ApiError.invalidRequest();
  }
  if (notes !== undefined && typeof notes !== "string") {
    throw ApiError.invalidRequest();
  }
  return {
    versionCode,
    versionName,
    sha256,
    notes: notes as string | undefined,
  };
}

function mapServiceError(error: unknown): never {
  if (error instanceof AppReleaseValidationError) {
    throw ApiError.invalidRequest();
  }
  if (error instanceof AppReleaseConflictError) {
    throw new ApiError("invalid_request", { statusCode: 409 });
  }
  if (error instanceof AppReleaseNotFoundError) {
    throw ApiError.notFound();
  }
  if (error instanceof AppReleaseStorageError) {
    throw new ApiError("internal_error");
  }
  throw error;
}

export function registerAppReleaseRoutes(
  app: FastifyInstance,
  deps: AppReleaseRoutesDeps,
): void {
  const service = createAppReleaseService({
    pool: deps.pool,
    storageRoot: deps.storageRoot,
    downloadSecret: deps.downloadSecret ?? null,
    now: deps.now,
  });
  const sessionGuard = createAdminSessionMiddleware(deps.adminAuth);
  const deviceGuard = createDeviceAuthMiddleware(deps.deviceAuth);
  const clock = (): Date => (deps.now ? deps.now() : new Date());

  void app.register(async (scope) => {
    scope.addContentTypeParser(
      OCTET_STREAM,
      { parseAs: "buffer", bodyLimit: APP_RELEASE_UPLOAD_LIMIT_BYTES },
      (_request, body, done) => {
        done(null, body);
      },
    );

    // Upload: rohe APK-Bytes, Metadaten ausschliesslich in der Query.
    scope.post<{ Querystring: Record<string, unknown> }>(
      APP_RELEASES_PATH,
      { bodyLimit: APP_RELEASE_UPLOAD_LIMIT_BYTES, onRequest: sessionGuard },
      async (request, reply) => {
        const principal = request.accessPrincipal;
        if (principal === undefined) {
          throw ApiError.unauthorized();
        }
        const query = parseUploadQuery(request.query);
        if (!Buffer.isBuffer(request.body)) {
          throw ApiError.invalidRequest();
        }
        let release;
        try {
          release = await service.create({
            versionCode: query.versionCode,
            versionName: query.versionName,
            notes: query.notes,
            sha256: query.sha256,
            content: request.body,
            actorId: principal.id,
          });
        } catch (error) {
          mapServiceError(error);
        }
        reply
          .code(201)
          .type("application/json; charset=utf-8")
          .send(release);
      },
    );

    // Uebersicht: Versionen mit Zaehlern und Tablets mit letzter Meldung.
    registerJsonRoute(scope, {
      method: "GET",
      url: APP_RELEASES_PATH,
      onRequest: sessionGuard,
      handler: async (request, reply) => {
        if (request.accessPrincipal === undefined) {
          throw ApiError.unauthorized();
        }
        let overview: AppReleaseOverview;
        try {
          overview = await service.overview();
        } catch (error) {
          mapServiceError(error);
        }
        reply.header("Cache-Control", "no-store");
        reply.code(200).send(overview);
      },
    });

    registerJsonRoute(scope, {
      method: "PATCH",
      url: APP_RELEASE_PATH,
      bodySchema: {
        type: "object",
        additionalProperties: false,
        required: ["rollout"],
        properties: {
          rollout: { type: "string", enum: ["none", "pilot", "all"] },
        },
      },
      onRequest: sessionGuard,
      handler: async (request, reply) => {
        const principal = request.accessPrincipal;
        if (principal === undefined) {
          throw ApiError.unauthorized();
        }
        const body = request.body as { rollout: string };
        const id = String((request.params as { id?: unknown }).id ?? "");
        let release;
        try {
          release = await service.setRollout(id, body.rollout, principal.id);
        } catch (error) {
          mapServiceError(error);
        }
        reply.code(200).send(release);
      },
    });

    registerJsonRoute(scope, {
      method: "PATCH",
      url: DEVICE_UPDATE_CHANNEL_PATH,
      bodySchema: {
        type: "object",
        additionalProperties: false,
        required: ["update_channel"],
        properties: {
          update_channel: { type: "string", enum: ["stable", "pilot"] },
        },
      },
      onRequest: sessionGuard,
      handler: async (request, reply) => {
        const principal = request.accessPrincipal;
        if (principal === undefined) {
          throw ApiError.unauthorized();
        }
        const body = request.body as { update_channel: string };
        const id = String((request.params as { id?: unknown }).id ?? "");
        let result;
        try {
          result = await service.setUpdateChannel(id, body.update_channel, principal.id);
        } catch (error) {
          mapServiceError(error);
        }
        reply.code(200).send(result);
      },
    });
  });

  // Zielversion fuer das authentifizierte Tablet.
  registerJsonRoute(app, {
    method: "GET",
    url: DEVICE_APP_UPDATE_PATH,
    onRequest: deviceGuard,
    handler: async (request, reply) => {
      const context = request.deviceAuth;
      if (context === undefined) {
        throw ApiError.unauthorized();
      }
      requireApiVersion(request.headers as Record<string, unknown>);
      const target = await service.targetFor(context.deviceId);
      reply.header("Cache-Control", "no-store");
      if (target === null || deps.downloadSecret === null || deps.downloadSecret === undefined) {
        reply.code(200).send({ update: null });
        return;
      }
      const ticket = issueAppDownloadTicket({
        deviceId: context.deviceId,
        release: target.release,
        secret: deps.downloadSecret,
        now: clock(),
      });
      reply.code(200).send({
        update: {
          release_id: target.release.id,
          version_code: target.release.version_code,
          version_name: target.release.version_name,
          notes: target.release.notes,
          sha256: target.release.sha256,
          size_bytes: target.release.size_bytes,
          download_path:
            "/v1/device/app-downloads/" + target.release.id + "?" + ticket.query,
        },
      });
    },
  });

  // Download: Ticket bindet Tablet und Version; Range/If-Range wie CX-008.
  // Ein gesperrtes Tablet liefert 404 (nicht 403), damit der Zustand nicht
  // von einer zurueckgezogenen Version unterscheidbar ist.
  const downloadGuard = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    try {
      await deviceGuard(request, reply);
    } catch (error) {
      if (error instanceof ApiError && error.code === "device_revoked") {
        throw ApiError.notFound();
      }
      throw error;
    }
  };

  registerJsonRoute(app, {
    method: "GET",
    url: DEVICE_APP_DOWNLOAD_PATH,
    onRequest: downloadGuard,
    handler: async (request, reply) => {
      const context = request.deviceAuth;
      if (context === undefined) {
        throw ApiError.unauthorized();
      }
      requireApiVersion(request.headers as Record<string, unknown>);
      const query = request.query;
      if (!isRecord(query)) {
        throw ApiError.forbidden();
      }
      const keys = Object.keys(query);
      const ticket = query.ticket;
      if (keys.length !== 1 || keys[0] !== "ticket" || typeof ticket !== "string" || ticket.length === 0) {
        throw ApiError.forbidden();
      }
      const releaseId = String((request.params as { id?: unknown }).id ?? "");
      const result = await service.download({
        releaseId,
        ticket,
        deviceId: context.deviceId,
        rangeHeader:
          typeof request.headers.range === "string" ? request.headers.range : null,
        ifRangeHeader:
          typeof request.headers["if-range"] === "string"
            ? request.headers["if-range"]
            : null,
      });
      if (result.status === 403) {
        throw ApiError.forbidden();
      }
      if (result.status === 404) {
        throw ApiError.notFound();
      }
      if (result.status === 400) {
        throw ApiError.invalidRequest();
      }
      if (result.status === 416) {
        throw new ApiError("invalid_request", {
          statusCode: 416,
          headers: result.headers,
        });
      }
      for (const [name, value] of Object.entries(result.headers)) {
        reply.header(name, value);
      }
      reply.header("Cache-Control", "no-store");
      reply.header("Content-Type", "application/octet-stream");
      reply.code(result.status).send(Buffer.from(result.bytes));
    },
  });

  // Rueckmeldung des Tablets (downloaded|installed|failed).
  registerJsonRoute(app, {
    method: "POST",
    url: DEVICE_APP_REPORT_PATH,
    bodySchema: {
      type: "object",
      additionalProperties: false,
      required: ["release_id", "status"],
      properties: {
        release_id: { type: "string" },
        status: { type: "string", enum: ["downloaded", "installed", "failed"] },
        detail: { type: "string", pattern: "^[a-z0-9_]{1,64}$" },
      },
    },
    onRequest: deviceGuard,
    handler: async (request, reply) => {
      const context = request.deviceAuth;
      if (context === undefined) {
        throw ApiError.unauthorized();
      }
      requireApiVersion(request.headers as Record<string, unknown>);
      try {
        await service.report(context.deviceId, request.body);
      } catch (error) {
        mapServiceError(error);
      }
      reply.code(204).send();
    },
  });
}
