/**
 * CX-129 / R-106 Teil 2: geschuetzte, paginierte Inventarliste.
 *
 * Der Adapter liest bestehende Tablet-Geraete und deren optionalen
 * Inventarsatz (CX-128) in einer einzigen LEFT-JOIN-Abfrage. Der getrennte
 * Verwaltungs-Aktivzustand stammt aus CX-126; ein fehlender Satz bedeutet
 * dort aktiv. Fehlende Inventarsaetze liefern null-Felder und Revision 0.
 *
 * Authentifizierung und Autorisierung erzwingt der vorhandene Rechtekern
 * (CX-015, Aktion devices.read) vor dem Handler; zusaetzlich gilt der
 * bestehende Admin-Sitzungsschutz. Geraete-Bearer-Tokens werden hier nicht
 * ausgewertet. Die Projektion enthaelt ausschliesslich die sechs
 * Inventarfelder, keine Schluessel, Codes, Tokens oder internen Pfade.
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { ApiError } from "./errors.js";
import { registerJsonRoute } from "./jsonContract.js";
import { createAdminSessionMiddleware } from "../modules/adminAuth/middleware.js";
import type { AdminAuthService } from "../modules/adminAuth/service.js";
import { ensureTabletActivationSchema } from "../modules/tabletActivation/index.js";

/** Einzige registrierte Route; Kanon des Dashboard-Adapters (CX-037). */
export const INVENTORY_LIST_PATH = "/v1/admin/inventory";
export const INVENTORY_LIST_DEFAULT_LIMIT = 50;
export const INVENTORY_LIST_MAX_LIMIT = 100;

export interface InventoryListDeps {
  pool: Pool;
  adminAuth: AdminAuthService;
}

/** Explizite oeffentliche Projektion; keine internen Felder. */
export interface InventoryListItem {
  id: string;
  serial_number: string | null;
  device_type: string | null;
  replacement_note: string | null;
  admin_active: boolean;
  revision: number;
}

export interface InventoryListResponse {
  items: InventoryListItem[];
  /** Nur vorhanden, wenn eine weitere Seite existiert. */
  nextCursor?: string;
}

interface InventoryListRow {
  id: string;
  serial_number: string | null;
  device_type: string | null;
  replacement_note: string | null;
  admin_active: boolean;
  revision: number;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMIT_PATTERN = /^(?:[1-9]|[1-9][0-9]|100)$/;

/**
 * Liest ausschliesslich limit und after. Mehrfach gesetzte Parameter werden
 * von Fastify als Array geliefert und damit wie jeder unbekannte oder
 * ungueltige Wert abgewiesen.
 */
function parseQuery(query: unknown): { limit: number; after: string | null } {
  if (typeof query !== "object" || query === null || Array.isArray(query)) {
    throw ApiError.invalidRequest();
  }
  const record = query as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "limit" && key !== "after") {
      throw ApiError.invalidRequest();
    }
  }

  const rawLimit = record.limit;
  let limit = INVENTORY_LIST_DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== "string" || !LIMIT_PATTERN.test(rawLimit)) {
      throw ApiError.invalidRequest();
    }
    limit = Number(rawLimit);
  }

  const rawAfter = record.after;
  let after: string | null = null;
  if (rawAfter !== undefined) {
    if (typeof rawAfter !== "string" || !UUID_PATTERN.test(rawAfter)) {
      throw ApiError.invalidRequest();
    }
    after = rawAfter.toLowerCase();
  }

  return { limit, after };
}

/**
 * Keyset-Pagination aufsteigend nach der unveraenderlichen Geraete-ID.
 * limit wird um eins erweitert; nextCursor ist die zuletzt gelieferte ID und
 * wird nur bei tatsaechlich weiterer Seite gesetzt.
 */
async function listInventory(
  pool: Pool,
  query: unknown,
): Promise<InventoryListResponse> {
  const parsed = parseQuery(query);
  await ensureTabletActivationSchema(pool);

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (parsed.after !== null) {
    params.push(parsed.after);
    conditions.push("d.id > $" + params.length + "::uuid");
  }
  params.push(parsed.limit + 1);

  const result = await pool.query<InventoryListRow>(
    [
      "select d.id::text as id,",
      "       i.serial_number,",
      "       i.device_type,",
      "       i.replacement_note,",
      "       coalesce(i.revision, 0)::int as revision,",
      "       coalesce(t.active, true) as admin_active",
      "  from devices d",
      "  left join device_inventory i on i.device_id = d.id",
      "  left join tablet_admin_states t on t.device_id = d.id",
      conditions.length === 0 ? "" : " where " + conditions.join(" and "),
      " order by d.id asc",
      " limit $" + params.length,
    ]
      .filter((line) => line !== "")
      .join("\n"),
    params,
  );

  const rows = result.rows;
  const hasMore = rows.length > parsed.limit;
  const items = hasMore ? rows.slice(0, parsed.limit) : rows;
  const last = items[items.length - 1];
  return hasMore && last !== undefined
    ? { items, nextCursor: last.id }
    : { items };
}

/**
 * Registriert GET /v1/admin/inventory genau einmal. Der Rechtekern
 * klassifiziert die Route als menschliche Leseaktion devices.read; der
 * vorhandene Sitzungsschutz gilt zusaetzlich. Es gibt keine Schreibroute.
 */
export function registerInventoryListRoute(
  app: FastifyInstance,
  deps: InventoryListDeps,
): void {
  const sessionGuard = createAdminSessionMiddleware(deps.adminAuth);

  registerJsonRoute(app, {
    method: "GET",
    url: INVENTORY_LIST_PATH,
    onRequest: [sessionGuard],
    handler: async (request, reply) => {
      if (request.accessPrincipal === undefined) {
        throw ApiError.unauthorized();
      }
      const body = await listInventory(deps.pool, request.query);
      reply.header("Cache-Control", "no-store");
      reply.code(200).send(body);
    },
  });
}
