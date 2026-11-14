import type { FastifyInstance } from "fastify";

/**
 * Fehlercodes des API-Vertrags (API-VERTRAG.md Abschnitt 1). Es gibt keine
 * weiteren Codes nach aussen; interne Details bleiben im Log.
 */
export type ApiErrorCode =
  | "invalid_request"
  | "invalid_registration_code"
  | "environment_mismatch"
  | "key_already_registered"
  | "unauthorized"
  | "challenge_invalid"
  | "device_revoked"
  | "forbidden"
  | "manifest_not_ready"
  | "not_found"
  | "rate_limited"
  | "internal_error";

export const API_ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = Object.freeze({
  invalid_request: 400,
  invalid_registration_code: 400,
  environment_mismatch: 409,
  key_already_registered: 409,
  unauthorized: 401,
  challenge_invalid: 401,
  device_revoked: 403,
  forbidden: 403,
  manifest_not_ready: 404,
  not_found: 404,
  rate_limited: 429,
  internal_error: 500,
});

/** Deutsche Meldungen; bei Codefehlern bewusst identisch (AC-03). */
export const API_ERROR_MESSAGES: Readonly<Record<ApiErrorCode, string>> = Object.freeze({
  invalid_request: "Die Anfrage ist ungueltig.",
  invalid_registration_code: "Der Code ist ungueltig oder abgelaufen.",
  environment_mismatch: "Die App-Umgebung passt nicht zur Server-Umgebung.",
  key_already_registered: "Der oeffentliche Schluessel ist bereits registriert.",
  unauthorized: "Nicht autorisiert.",
  challenge_invalid: "Die Anmeldung ist ungueltig oder abgelaufen.",
  device_revoked: "Das Geraet ist gesperrt.",
  forbidden: "Zugriff verweigert.",
  manifest_not_ready: "Das Manifest ist noch nicht verfuegbar.",
  not_found: "Nicht gefunden.",
  rate_limited: "Zu viele Versuche. Bitte spaeter erneut versuchen.",
  internal_error: "Interner Fehler.",
});

export interface ApiErrorOptions {
  statusCode?: number;
  headers?: Record<string, string>;
}

/**
 * Fachlicher Fehler mit Vertragscode. Die Meldung ist immer die oeffentliche
 * Meldung; interne Ursachen werden nie uebernommen.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;

  constructor(code: ApiErrorCode, options: ApiErrorOptions = {}) {
    super(API_ERROR_MESSAGES[code]);
    this.name = "ApiError";
    this.code = code;
    this.statusCode = options.statusCode ?? API_ERROR_STATUS[code];
    this.headers = Object.freeze({ ...(options.headers ?? {}) });
  }

  static invalidRequest(): ApiError {
    return new ApiError("invalid_request");
  }

  static invalidRegistrationCode(): ApiError {
    return new ApiError("invalid_registration_code");
  }

  static environmentMismatch(): ApiError {
    return new ApiError("environment_mismatch");
  }

  static keyAlreadyRegistered(): ApiError {
    return new ApiError("key_already_registered");
  }

  static notFound(): ApiError {
    return new ApiError("not_found");
  }

  static unauthorized(): ApiError {
    return new ApiError("unauthorized");
  }

  static deviceRevoked(): ApiError {
    return new ApiError("device_revoked");
  }

  static forbidden(): ApiError {
    return new ApiError("forbidden");
  }

  static manifestNotReady(): ApiError {
    return new ApiError("manifest_not_ready");
  }

  static rateLimited(retryAfterSeconds: number): ApiError {
    const rounded = Number.isFinite(retryAfterSeconds)
      ? Math.max(1, Math.ceil(retryAfterSeconds))
      : 1;
    return new ApiError("rate_limited", {
      headers: { "Retry-After": String(rounded) },
    });
  }
}

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    request_id: string;
  };
}

/** Fehlerformat exakt nach API-VERTRAG.md Abschnitt 1. */
export function buildErrorBody(
  code: ApiErrorCode,
  requestId: string,
  message: string = API_ERROR_MESSAGES[code],
): ApiErrorBody {
  return { error: { code, message, request_id: requestId } };
}

function isFastifyClientError(error: { statusCode?: number }): boolean {
  return (
    typeof error.statusCode === "number" &&
    error.statusCode >= 400 &&
    error.statusCode < 500
  );
}

/**
 * Einheitliche Fehlerbehandlung: ApiError wird unveraendert ausgeliefert,
 * Validierungs-/Parserfehler werden zu invalid_request, alles andere zu
 * internal_error ohne Details. Dadurch gelangen keine Stacktraces oder
 * Geheimnisse nach aussen.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const requestId = request.id;

    if (error instanceof ApiError) {
      for (const [name, value] of Object.entries(error.headers)) {
        reply.header(name, value);
      }
      reply
        .code(error.statusCode)
        .type("application/json; charset=utf-8")
        .send(buildErrorBody(error.code, requestId));
      return;
    }

    const fastifyError = error as { statusCode?: number; name?: string };
    // Transportfehler behalten ihren Status: eine zu grosse Nutzlast bleibt
    // 413, ein nicht unterstuetzter Medientyp bleibt 415. Das vorhandene
    // Fehlerformat (U7) gilt unveraendert.
    if (fastifyError.statusCode === 413 || fastifyError.statusCode === 415) {
      reply
        .code(fastifyError.statusCode)
        .type("application/json; charset=utf-8")
        .send(buildErrorBody("invalid_request", requestId));
      return;
    }
    if (isFastifyClientError(fastifyError)) {
      reply
        .code(400)
        .type("application/json; charset=utf-8")
        .send(buildErrorBody("invalid_request", requestId));
      return;
    }

    // Nur Name und Request-ID protokollieren: Fehlermeldungen fremder
    // Bibliotheken koennen Werte aus der Anfrage enthalten.
    request.log.error(
      { errName: fastifyError.name ?? "UnknownError", requestId },
      "Unbehandelter Fehler",
    );
    reply
      .code(500)
      .type("application/json; charset=utf-8")
      .send(buildErrorBody("internal_error", requestId));
  });

  app.setNotFoundHandler((request, reply) => {
    reply
      .code(404)
      .type("application/json; charset=utf-8")
      .send(buildErrorBody("not_found", request.id));
  });
}
