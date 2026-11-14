/**
 * CX-115 / R-104: geschuetzte Anlageroute fuer leere Taxigruppen.
 *
 * Die Route ist die einzige HTTP-Schnittstelle zum Anlegen; sie verwendet
 * ausschliesslich vorhandene Bausteine: Admin-Sitzung und Schreibschutz
 * (CX-032/U6), den gekapselten JSON-Vertrag (CX-033), den Rechtekern
 * (CX-015) und das Audit-Repository (CX-016). Betreiber, Akteur und
 * Revision stammen nie aus dem Request.
 *
 * Der additive Gruppenbestand wird idempotent bereitgestellt (Muster
 * CX-038), weil CX-115 keine Migration einfuehren darf. Name ist eindeutig;
 * die Datenbank entscheidet damit auch bei parallelen Anfragen, und Audit
 * wird in derselben Transaktion geschrieben.
 *
 * CX-116 / R-104: Die Liste liest ausschliesslich den Betreiberbereich des
 * angemeldeten Prinzipals (owner_id, Muster CX-103). Es entsteht keine zweite
 * Persistenz und keine Migration: dieselbe Tabelle wird additiv um die
 * Betreiberspalte ergaenzt; Revision bleibt der vorhandene Aenderungsstand.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { ApiError } from "./errors.js";
import {
  compileClosedObjectSchema,
  registerJsonRoute,
} from "./jsonContract.js";
import {
  createAdminSessionMiddleware,
  requireAdminWrite,
} from "../modules/adminAuth/middleware.js";
import { insertAuditEvent } from "../modules/audit/repository.js";
import type { AdminAuthService } from "../modules/adminAuth/service.js";

/** Kanonischer Pfad des Dashboard-Adapters (apps/dashboard/src/fleet). */
export const TAXI_GROUP_CREATE_PATH = "/v1/admin/taxi-groups";
export const TAXI_GROUP_LIST_PATH = TAXI_GROUP_CREATE_PATH;
export const TAXI_GROUP_CREATED_ACTION = "taxi_group.created";
export const TAXI_GROUP_AUDIT_TARGET_TYPE = "taxi_group";
export const MAX_TAXI_GROUP_NAME_LENGTH = 120;
export const TAXI_GROUP_LIST_DEFAULT_LIMIT = 50;
export const TAXI_GROUP_LIST_MAX_LIMIT = 100;

/** Der Betreiberbereich ist die serverseitige Principal-ID, nie ein Requestfeld. */
const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-" +
  "[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

export interface TaxiGroupRoutesDeps {
  pool: Pool;
  adminAuth: AdminAuthService;
}

export interface CreatedTaxiGroup {
  id: string;
  name: string;
  revision: number;
}

/** Geschlossenes DTO: ausschliesslich name, keine Mitglieder/Betreiber. */
const CREATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: {
      type: "string",
      minLength: 1,
      maxLength: MAX_TAXI_GROUP_NAME_LENGTH,
    },
  },
};

/** Geschlossene Querystring-Parameter: limit 1..100, after als Gruppen-ID. */
const LIST_QUERY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: {
      type: "string",
      pattern: "^(?:[1-9]|[1-9][0-9]|100)$",
    },
    after: { type: "string", pattern: UUID_PATTERN },
  },
};

const validateListQuery = compileClosedObjectSchema(LIST_QUERY_SCHEMA);

const SCHEMA_SQL = [
  "create table if not exists taxi_groups (",
  "  id uuid primary key,",
  "  name text not null,",
  "  owner_id text not null default 'legacy-admin',",
  "  revision integer not null default 1,",
  "  created_at timestamptz not null,",
  "  constraint taxi_groups_name_unique unique (name),",
  "  constraint taxi_groups_name_length check",
  "    (char_length(name) between 1 and 120),",
  "  constraint taxi_groups_revision_positive check (revision >= 1)",
  ");",
  // Additive Spalte fuer bestehende Datenbestaende; auf neuen Datenbanken
  // ist die Anweisung folgenlos. Keine Migration, keine zweite Tabelle.
  "alter table taxi_groups",
  "  add column if not exists owner_id text not null default 'legacy-admin';",
].join("\n");

const schemaReady = new WeakMap<Pool, Promise<void>>();

/** Legt den additiven Bestand genau einmal je Pool an; Wiederholung ist folgenlos. */
export function ensureTaxiGroupSchema(pool: Pool): Promise<void> {
  const pending = schemaReady.get(pool);
  if (pending !== undefined) {
    return pending;
  }
  const created = pool.query(SCHEMA_SQL).then(() => undefined);
  schemaReady.set(pool, created);
  created.catch(() => {
    if (schemaReady.get(pool) === created) {
      schemaReady.delete(pool);
    }
  });
  return created;
}

function actorIdOf(request: FastifyRequest): string {
  const principal = request.accessPrincipal;
  if (principal === undefined || principal.id.length === 0) {
    throw ApiError.unauthorized();
  }
  return principal.id;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

/**
 * Legt genau eine leere Gruppe an und schreibt genau einen Audit-Eintrag.
 * Ein doppelter Name wird als Konflikt (409) ohne Folgedatensatz abgebildet.
 */
async function createTaxiGroup(
  pool: Pool,
  rawName: unknown,
  actorId: string,
  at: Date,
): Promise<CreatedTaxiGroup> {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (name.length < 1 || name.length > MAX_TAXI_GROUP_NAME_LENGTH) {
    throw ApiError.invalidRequest();
  }
  await ensureTaxiGroupSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const inserted = await client.query<{
      id: string;
      name: string;
      revision: number;
    }>(
      [
        "insert into taxi_groups (id, name, revision, created_at, owner_id)",
        "values ($1, $2, 1, $3, $4)",
        "returning id, name, revision::int as revision",
      ].join("\n"),
      [randomUUID(), name, at, actorId],
    );
    const row = inserted.rows[0];
    if (row === undefined) {
      throw new Error("Gruppe wurde nicht gespeichert");
    }
    await insertAuditEvent(client, {
      at,
      actorType: "admin",
      actorId,
      action: TAXI_GROUP_CREATED_ACTION,
      targetType: TAXI_GROUP_AUDIT_TARGET_TYPE,
      targetId: row.id,
      details: { name: row.name },
    });
    await client.query("commit");
    return { id: row.id, name: row.name, revision: row.revision };
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Der urspruengliche Fehler bleibt massgeblich.
    }
    if (isUniqueViolation(error)) {
      throw new ApiError("invalid_request", { statusCode: 409 });
    }
    throw error;
  } finally {
    client.release();
  }
}

interface TaxiGroupRow {
  id: string;
  name: string;
  revision: number;
}

export interface TaxiGroupPage {
  items: CreatedTaxiGroup[];
  next_after: string | null;
}

/**
 * Liest ausschliesslich Gruppen des uebergebenen Betreiberbereichs in
 * aufsteigender ID-Reihenfolge. after ist die zuletzt gelieferte ID und wird
 * als strikter Keyset-Anker verwendet; limit wird um eins erweitert, damit
 * die Fortsetzung ohne Ueberschneidung bestimmbar ist.
 */
async function listTaxiGroups(
  pool: Pool,
  ownerId: string,
  query: unknown,
): Promise<TaxiGroupPage> {
  if (!validateListQuery(query)) {
    throw ApiError.invalidRequest();
  }
  const record = query as Record<string, unknown>;
  const limit =
    record.limit === undefined
      ? TAXI_GROUP_LIST_DEFAULT_LIMIT
      : Number(record.limit);
  const after = typeof record.after === "string" ? record.after : null;

  await ensureTaxiGroupSchema(pool);
  const conditions = ["owner_id = $1"];
  const params: unknown[] = [ownerId];
  if (after !== null) {
    params.push(after);
    conditions.push("id > $" + params.length + "::uuid");
  }
  params.push(limit + 1);

  const result = await pool.query<TaxiGroupRow>(
    [
      "select id::text as id, name, revision::int as revision",
      "  from taxi_groups",
      " where " + conditions.join(" and "),
      " order by id asc",
      " limit $" + params.length,
    ].join("\n"),
    params,
  );

  const rows = result.rows;
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    next_after: hasMore && last !== undefined ? last.id : null,
  };
}

/** Registriert die Anlageroute genau einmal; Antwort ist die Projektion id/name/revision. */
export function registerTaxiGroupCreateRoute(
  app: FastifyInstance,
  deps: TaxiGroupRoutesDeps,
): void {
  const sessionGuard = createAdminSessionMiddleware(deps.adminAuth);
  const now = (): Date => new Date();

  registerJsonRoute(app, {
    method: "POST",
    url: TAXI_GROUP_CREATE_PATH,
    bodySchema: CREATE_SCHEMA,
    onRequest: [requireAdminWrite, sessionGuard],
    handler: async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      const group = await createTaxiGroup(
        deps.pool,
        body.name,
        actorIdOf(request),
        now(),
      );
      reply.code(201).send({
        id: group.id,
        name: group.name,
        revision: group.revision,
      });
    },
  });
}

/**
 * Registriert GET /v1/admin/taxi-groups genau einmal. Der Rechtekern
 * klassifiziert die Route als menschliche Leseaktion groups.read; zusaetzlich
 * gilt der vorhandene Admin-Sitzungsschutz.
 */
export function registerTaxiGroupListRoute(
  app: FastifyInstance,
  deps: TaxiGroupRoutesDeps,
): void {
  const sessionGuard = createAdminSessionMiddleware(deps.adminAuth);

  registerJsonRoute(app, {
    method: "GET",
    url: TAXI_GROUP_LIST_PATH,
    onRequest: [sessionGuard],
    handler: async (request, reply) => {
      const principal = request.accessPrincipal;
      if (principal === undefined || principal.id.length === 0) {
        throw ApiError.unauthorized();
      }
      const page = await listTaxiGroups(deps.pool, principal.id, request.query);
      reply.header("Cache-Control", "no-store");
      reply.code(200).send({
        items: page.items,
        next_after: page.next_after,
      });
    },
  });
}

