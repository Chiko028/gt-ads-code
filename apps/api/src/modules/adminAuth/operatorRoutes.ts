/**
 * CX-057 / R-602: genau zwei administrative Operatorrouten.
 *
 * POST /v1/admin/operators legt ein Konto an; POST
 * /v1/admin/operators/:operatorId/disable sperrt es. Es gibt bewusst keine
 * Rollen-, Status-, Entsperr-, Loesch- oder Passwortresetfelder. Der Akteur
 * kommt ausschliesslich aus dem serverseitig aufgeloesten Principal; die
 * Fehlerantworten enthalten weder Passwort noch Hash.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "../../http/errors.js";
import {
  createAdminSessionMiddleware,
  requireAdminWrite,
} from "./middleware.js";
import type {
  AdminAuthService,
  CreatedOperator,
} from "./service.js";

export const ADMIN_OPERATORS_PATH = "/v1/admin/operators";
export const ADMIN_OPERATOR_DISABLE_PATH =
  "/v1/admin/operators/:operatorId/disable";

export interface AdminOperatorRoutesDeps {
  service: AdminAuthService;
}

const CREATE_FIELDS: ReadonlySet<string> = new Set(["username", "password"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Geschlossenes Anlage-DTO: genau username und password. */
function parseCreateBody(body: unknown): { username: string; password: string } {
  if (!isPlainObject(body)) {
    throw ApiError.invalidRequest();
  }
  for (const key of Object.keys(body)) {
    if (!CREATE_FIELDS.has(key)) {
      throw ApiError.invalidRequest();
    }
  }
  const username = body.username;
  const password = body.password;
  if (typeof username !== "string" || typeof password !== "string") {
    throw ApiError.invalidRequest();
  }
  return { username, password };
}

/** Sperren akzeptiert keinen frei waehlbaren Status. */
function assertEmptyBody(body: unknown): void {
  if (body === undefined || body === null) {
    return;
  }
  if (!isPlainObject(body) || Object.keys(body).length !== 0) {
    throw ApiError.invalidRequest();
  }
}

function actorIdOf(request: FastifyRequest): string {
  const principal = request.accessPrincipal;
  if (principal === undefined || principal.id.length === 0) {
    throw ApiError.unauthorized();
  }
  return principal.id;
}

function operatorIdOf(request: FastifyRequest): string {
  const params = request.params as { operatorId?: unknown };
  if (typeof params.operatorId !== "string" || params.operatorId.trim() === "") {
    throw ApiError.notFound();
  }
  return params.operatorId;
}

/** Registriert beide Operatorrouten genau einmal. */
export function registerAdminOperatorRoutes(
  app: FastifyInstance,
  deps: AdminOperatorRoutesDeps,
): void {
  const sessionGuard = createAdminSessionMiddleware(deps.service);

  app.post(
    ADMIN_OPERATORS_PATH,
    { onRequest: [requireAdminWrite, sessionGuard] },
    async (request, reply) => {
      const body = parseCreateBody(request.body);
      const created: CreatedOperator = await deps.service.createOperator({
        username: body.username,
        password: body.password,
        actorId: actorIdOf(request),
      });
      reply.code(201).send(created);
    },
  );

  app.post(
    ADMIN_OPERATOR_DISABLE_PATH,
    { onRequest: [requireAdminWrite, sessionGuard] },
    async (request, reply) => {
      assertEmptyBody(request.body);
      await deps.service.disableOperator({
        operatorId: operatorIdOf(request),
        actorId: actorIdOf(request),
      });
      reply.code(204).send();
    },
  );
}
