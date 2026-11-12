import type { FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "../../http/errors.js";
import type { AdminAuthService, AdminSessionContext } from "./service.js";

/** Cookie-Name laut API-VERTRAG.md Abschnitt 5. */
export const ADMIN_SESSION_COOKIE = "gt_ads_session";

declare module "fastify" {
  interface FastifyRequest {
    /** Wird von der Admin-Sitzungspruefung gesetzt. */
    adminSession?: AdminSessionContext;
  }
}

/** Schreibende Methoden, fuer die der CSRF-Schutz gilt (Vertrag Abschnitt 5). */
const WRITE_METHODS: ReadonlySet<string> = new Set(["POST", "DELETE", "PUT", "PATCH"]);

const JSON_CONTENT_TYPE = /^application\/json(?:\s*;.*)?$/i;

function readSessionToken(request: FastifyRequest): string | undefined {
  const cookies = request.cookies as
    | Record<string, string | undefined>
    | undefined;
  if (cookies === undefined) {
    return undefined;
  }
  return cookies[ADMIN_SESSION_COOKIE];
}

/**
 * PreHandler/onRequest fuer alle Admin-Routen: ohne gueltige, nicht
 * abgelaufene Sitzung 401 unauthorized (AC-12, I-19).
 */
export function createAdminSessionMiddleware(
  service: AdminAuthService,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async function adminSessionPreHandler(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    const token = readSessionToken(request);
    if (token === undefined || token.length === 0) {
      throw ApiError.unauthorized();
    }
    const session = await service.verifySession(token);
    if (session === null) {
      throw ApiError.unauthorized();
    }
    request.adminSession = session;
  };
}

/**
 * CSRF-Schutz fuer schreibende Admin-Requests (API-VERTRAG.md Abschnitt 5):
 * Content-Type muss application/json sein; ein gesendeter Origin-Header muss
 * dem eigenen Ursprung entsprechen. Sonst 403 forbidden.
 *
 * Laeuft als onRequest-Hook, damit die Pruefung vor dem Body-Parser greift
 * (ein falscher Content-Type darf keinen 415 erzeugen).
 */
export async function requireAdminWrite(request: FastifyRequest): Promise<void> {
  if (!WRITE_METHODS.has(request.method)) {
    return;
  }

  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !JSON_CONTENT_TYPE.test(contentType.trim())
  ) {
    throw ApiError.forbidden();
  }

  const origin = request.headers.origin;
  if (origin === undefined) {
    return;
  }
  const host = request.headers.host;
  if (typeof host !== "string" || host.length === 0) {
    throw ApiError.forbidden();
  }
  const expected = request.protocol + "://" + host;
  if (origin !== expected) {
    throw ApiError.forbidden();
  }
}
