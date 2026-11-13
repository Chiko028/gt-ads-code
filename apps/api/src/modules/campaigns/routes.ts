import type { FastifyInstance } from "fastify";
import { ApiError } from "../../http/errors.js";
import {
  createAdminSessionMiddleware,
  requireAdminWrite,
} from "../adminAuth/middleware.js";
import {
  ADMIN_ACTOR_ID,
  type AdminAuthService,
} from "../adminAuth/service.js";
import {
  CUSTOMER_LIST_DEFAULT_LIMIT,
  CustomerService,
  normalizeCustomerDisplayName,
  normalizeCustomerListLimit,
  type Customer,
} from "./customers.js";

export const CUSTOMER_LIST_PATH = "/v1/admin/customers";
export const CUSTOMER_DETAIL_PATH = "/v1/admin/customers/:id";

export interface CustomerRoutesDeps {
  service: CustomerService;
  adminAuth: AdminAuthService;
}

interface CustomerJson {
  id: string;
  display_name: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

function toJson(customer: Customer): CustomerJson {
  return {
    id: customer.id,
    display_name: customer.displayName,
    revision: customer.revision,
    created_at: customer.createdAt.toISOString(),
    updated_at: customer.updatedAt.toISOString(),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** additionalProperties=false: genau display_name, keine stille Bereinigung. */
function parseCreateBody(body: unknown): string {
  if (!isPlainObject(body)) {
    throw ApiError.invalidRequest();
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "display_name") {
    throw ApiError.invalidRequest();
  }
  return normalizeCustomerDisplayName(body.display_name);
}

/** Ausschliesslich optionales limit als ganze Zahl 1..100. */
function parseListLimit(query: unknown): number {
  if (!isPlainObject(query)) {
    throw ApiError.invalidRequest();
  }
  for (const key of Object.keys(query)) {
    if (key !== "limit") {
      throw ApiError.invalidRequest();
    }
  }
  const raw = query.limit;
  if (raw === undefined) {
    return CUSTOMER_LIST_DEFAULT_LIMIT;
  }
  if (typeof raw !== "string" || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(raw)) {
    throw ApiError.invalidRequest();
  }
  return normalizeCustomerListLimit(Number(raw));
}

/**
 * Exportiertes Fastify-Plugin des Kundenkerns. Alle Routen nutzen die
 * vorhandene Admin-Sitzung; POST zusaetzlich den vorhandenen U6-Schreibschutz
 * (JSON-Content-Type und Origin). Die Rechtekern-Policy der Route wird bei der
 * Komposition in CX-033 ergaenzt; hier wird keine eigene Rechtehierarchie
 * erzeugt.
 */
export function registerCustomerRoutes(
  app: FastifyInstance,
  deps: CustomerRoutesDeps,
): void {
  const sessionGuard = createAdminSessionMiddleware(deps.adminAuth);

  app.get(
    CUSTOMER_LIST_PATH,
    { onRequest: [sessionGuard] },
    async (request, reply) => {
      const limit = parseListLimit(request.query);
      const items = await deps.service.listCustomer(limit);
      reply.code(200).send({ items: items.map(toJson) });
    },
  );

  app.get(
    CUSTOMER_DETAIL_PATH,
    { onRequest: [sessionGuard] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const customer = await deps.service.getCustomer(id);
      if (customer === null) {
        throw ApiError.notFound();
      }
      reply.code(200).send(toJson(customer));
    },
  );

  app.post(
    CUSTOMER_LIST_PATH,
    { onRequest: [requireAdminWrite, sessionGuard] },
    async (request, reply) => {
      const displayName = parseCreateBody(request.body);
      const customer = await deps.service.createCustomer({
        displayName,
        actorId: ADMIN_ACTOR_ID,
      });
      reply.code(201).send(toJson(customer));
    },
  );
}
