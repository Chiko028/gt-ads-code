/**
 * CX-132 / R-104 Teil 1: geschuetzte, ausschliesslich lesende Taxi-Liste fuer
 * die vorhandene Dashboard-Seite (apps/dashboard/src/fleet/fleetApi.ts,
 * parseTaxi/parseTaxiList).
 *
 * GET /v1/admin/taxis -> 200 {items:[{id, display_name, active, revision,
 * tablet_ids:[a|null, b|null], group_ids:[...]}]}, nach id sortiert,
 * einschliesslich inaktiver Taxis.
 *
 * Gelesen wird in genau einer SQL-Anweisung (konsistenter Schnappschuss) aus
 * den vorhandenen Tabellen taxis, device_taxi_assignments und
 * taxi_group_memberships. Gruppen und Tablets werden in getrennten
 * Unterabfragen aggregiert, damit Joins keine Duplikate erzeugen. Es gibt
 * kein DDL, keine Schemainitialisierung und keine Schreiboperation; Rechte
 * (devices.read) prueft der zentrale Rechtekern vor dem Handler.
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { ApiError } from "./errors.js";
import { registerJsonRoute } from "./jsonContract.js";
import { createAdminSessionMiddleware } from "../modules/adminAuth/middleware.js";
import type { AdminAuthService } from "../modules/adminAuth/service.js";

export const TAXI_LIST_PATH = "/v1/admin/taxis";

/** Plaetze je Taxi (Paarzuordnung: genau zwei Tablets je Taxi). */
const TABLET_SLOTS = 2;

export interface TaxiListDeps {
  pool: Pool;
  adminAuth: AdminAuthService;
}

export interface TaxiListItem {
  id: string;
  display_name: string;
  active: boolean;
  revision: number;
  tablet_ids: [string | null, string | null];
  group_ids: string[];
}

interface TaxiListRow {
  id: string;
  display_name: string;
  active: boolean;
  revision: string;
  tablet_ids: string[] | null;
  group_ids: string[] | null;
}

const LIST_SQL = [
  "select t.id,",
  "       t.display_name,",
  "       t.active,",
  "       t.revision::text as revision,",
  "       (select array_agg(a.device_id::text order by a.device_id::text)",
  "          from device_taxi_assignments a",
  "         where a.taxi_id = t.id and a.active = true) as tablet_ids,",
  "       (select array_agg(g.group_id order by g.group_id)",
  "          from (select distinct m.group_id",
  "                  from taxi_group_memberships m",
  "                 where m.taxi_id = t.id) g) as group_ids",
  "  from taxis t",
  " order by t.id asc",
].join("\n");

function revisionOf(raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    // Gespeicherte Revision ausserhalb des darstellbaren Bereichs: bereinigter 500.
    throw new Error("Taxi-Revision ist nicht darstellbar.");
  }
  return value;
}

function itemOf(row: TaxiListRow): TaxiListItem {
  const tablets = row.tablet_ids ?? [];
  if (tablets.length > TABLET_SLOTS) {
    // Verletzte Paarinvariante wird nicht still abgeschnitten, sondern als
    // bereinigter Serverfehler sichtbar (vorhandene Fehlerbehandlung).
    throw new Error("Taxi hat mehr als zwei aktive Tablet-Zuordnungen.");
  }
  return {
    id: row.id,
    display_name: row.display_name,
    active: row.active,
    revision: revisionOf(row.revision),
    tablet_ids: [tablets[0] ?? null, tablets[1] ?? null],
    group_ids: [...(row.group_ids ?? [])],
  };
}

/** Liest alle Taxis in der Dashboard-Form; veraendert nichts. */
export async function listTaxis(pool: Pick<Pool, "query">): Promise<TaxiListItem[]> {
  const result = await pool.query<TaxiListRow>(LIST_SQL);
  return result.rows.map(itemOf);
}

/** Registriert GET /v1/admin/taxis genau einmal. */
export function registerTaxiListRoute(
  app: FastifyInstance,
  deps: TaxiListDeps,
): void {
  const sessionGuard = createAdminSessionMiddleware(deps.adminAuth);

  registerJsonRoute(app, {
    method: "GET",
    url: TAXI_LIST_PATH,
    onRequest: [sessionGuard],
    handler: async (request, reply) => {
      if (request.accessPrincipal === undefined) {
        throw ApiError.unauthorized();
      }
      const items = await listTaxis(deps.pool);
      reply.header("Cache-Control", "no-store");
      reply.code(200).send({ items });
    },
  });
}
