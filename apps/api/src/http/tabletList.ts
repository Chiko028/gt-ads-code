/**
 * CX-134 / R-104 Teil 3: geschuetzte, ausschliesslich lesende Tablet-Liste fuer
 * die vorhandene Dashboard-Seite Taxis (apps/dashboard/src/fleet/fleetApi.ts,
 * parseTablet/parseTabletList).
 *
 * GET /v1/admin/tablets -> 200 {items:[{id, label, available, active, revision}]},
 * nach Geraete-ID sortiert.
 *
 * - label: vorhandenes Geraetefeld devices.label, andernfalls die Geraete-ID.
 * - active/revision: Verwaltungszustand aus tablet_admin_states (CX-126);
 *   fehlender Satz bedeutet aktiv mit Revision 0 – exakt die Semantik des
 *   vorhandenen Aktivierungsdienstes, damit PATCH .../activation mit dieser
 *   Revision passt.
 * - available: genau dann wahr, wenn die Identitaet nicht widerrufen, das
 *   Tablet verwaltungsseitig aktiv ist und keine aktuelle Paarbindung besteht
 *   (device_taxi_assignments.active, wie CX-124/CX-131). Beendete Bindungen
 *   blockieren nicht; ein deaktiviertes Taxi loest eine Bindung nicht.
 *
 * Die Liste entsteht aus genau einer lesenden SQL-Abfrage (LEFT JOIN fuer den
 * Verwaltungszustand, NOT EXISTS fuer aktuelle Bindungen; keine Duplikate,
 * kein N+1). Im Handler gibt es weder DDL noch INSERT/UPDATE: Die Tabelle
 * tablet_admin_states legt der Aktivierungsdienst bei Bedarf an; solange sie
 * nicht existiert, gilt fuer alle Tablets der Standard aktiv/0. Rechte
 * (devices.read) prueft der zentrale Rechtekern vor dem Handler.
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { ApiError } from "./errors.js";
import { registerJsonRoute } from "./jsonContract.js";
import { createAdminSessionMiddleware } from "../modules/adminAuth/middleware.js";
import type { AdminAuthService } from "../modules/adminAuth/service.js";

export const TABLET_LIST_PATH = "/v1/admin/tablets";

export interface TabletListDeps {
  pool: Pool;
  adminAuth: AdminAuthService;
}

export interface TabletListItem {
  id: string;
  label: string;
  available: boolean;
  active: boolean;
  revision: number;
}

interface TabletListRow {
  id: string;
  label: string;
  available: boolean;
  active: boolean;
  revision: string;
}

/** Liste mit Verwaltungssatz; adminState ist entweder die Tabelle oder eine leere Relation. */
function listSql(adminState: string): string {
  return [
    "select d.id::text as id,",
    "       coalesce(nullif(d.label, ''), d.id::text) as label,",
    "       coalesce(s.active, true) as active,",
    "       coalesce(s.revision, 0)::text as revision,",
    "       (d.state = 'active'",
    "        and coalesce(s.active, true)",
    "        and not exists (select 1 from device_taxi_assignments a",
    "                         where a.device_id = d.id and a.active = true)) as available",
    "  from devices d",
    "  left join " + adminState + " s on s.device_id = d.id",
    " order by d.id asc",
  ].join("\n");
}

const WITH_ADMIN_STATES = listSql("tablet_admin_states");
const WITHOUT_ADMIN_STATES = listSql(
  "(select null::uuid as device_id, null::boolean as active, null::bigint as revision where false)",
);

function revisionOf(raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Tablet-Revision ist nicht darstellbar.");
  }
  return value;
}

/** Liest alle Tablets in der Dashboard-Form; veraendert keine Fachdaten. */
export async function listTablets(pool: Pool): Promise<TabletListItem[]> {
  const exists = await pool.query<{ present: boolean }>(
    "select to_regclass('tablet_admin_states') is not null as present",
  );
  const sql = exists.rows[0]?.present === true ? WITH_ADMIN_STATES : WITHOUT_ADMIN_STATES;
  const result = await pool.query<TabletListRow>(sql);
  return result.rows.map((row) => ({
    id: row.id,
    label: row.label,
    available: row.available,
    active: row.active,
    revision: revisionOf(row.revision),
  }));
}

/** Registriert GET /v1/admin/tablets genau einmal. */
export function registerTabletListRoute(
  app: FastifyInstance,
  deps: TabletListDeps,
): void {
  const sessionGuard = createAdminSessionMiddleware(deps.adminAuth);

  registerJsonRoute(app, {
    method: "GET",
    url: TABLET_LIST_PATH,
    onRequest: [sessionGuard],
    handler: async (request, reply) => {
      if (request.accessPrincipal === undefined) {
        throw ApiError.unauthorized();
      }
      const items = await listTablets(deps.pool);
      reply.header("Cache-Control", "no-store");
      reply.code(200).send({ items });
    },
  });
}
