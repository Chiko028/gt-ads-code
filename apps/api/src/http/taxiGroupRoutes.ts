/**
 * CX-115 / R-104: geschuetzte Anlageroute fuer leere Taxigruppen.
 *
 * Die Route ist die einzige HTTP-Schnittstelle zum Anlegen; sie verwendet
 * ausschliesslich vorhandene Bausteine: Admin-Sitzung und Schreibschutz
 * (CX-032/U6), den gekapselten JSON-Vertrag (CX-033), den Rechtekern
 * (CX-015) und das Audit-Repository (CX-016). Betreiber, Akteur und
 * Revision stammen nie aus dem Request.
 *
 * Die Anlage delegiert genau einmal an die Anlagefunktion des
 * Gruppenbestands (R-104 / CX-114). Die Route erzeugt weder Identitaet noch
 * Revision, fuehrt kein INSERT aus, schreibt kein Audit und legt kein Schema
 * an; sie prueft Schutz und DTO, bildet Fehler ab und projiziert die Antwort.
 *
 * CX-116 / R-104: Die Liste liest ausschliesslich den Betreiberbereich des
 * angemeldeten Prinzipals (owner_id, Muster CX-103). Es entsteht keine zweite
 * Persistenz und keine Migration: dieselbe Tabelle wird additiv um die
 * Betreiberspalte ergaenzt; Revision bleibt der vorhandene Aenderungsstand.
 */
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
import {
  createTaxiGroup,
  ensureTaxiGroupSchema,
  MAX_TAXI_GROUP_NAME_LENGTH,
  TAXI_GROUP_AUDIT_TARGET_TYPE,
  TaxiGroupCreateError,
  type CreatedTaxiGroup,
} from "./taxiGroupCreateService.js";

// Kompatibilitaets-Reexport der Anlagefunktion fuer bestehende Aufrufer; die
// Route selbst legt kein Schema an.
export {
  ensureTaxiGroupSchema,
  MAX_TAXI_GROUP_NAME_LENGTH,
  TAXI_GROUP_AUDIT_TARGET_TYPE,
  TAXI_GROUP_CREATED_ACTION,
} from "./taxiGroupCreateService.js";

/** Kanonischer Pfad des Dashboard-Adapters (apps/dashboard/src/fleet). */
export const TAXI_GROUP_CREATE_PATH = "/v1/admin/taxi-groups";
export const TAXI_GROUP_LIST_PATH = TAXI_GROUP_CREATE_PATH;
/** CX-117 / R-104: Umbenennung verwendet den bestehenden Ressourcenpfad. */
export const TAXI_GROUP_RENAME_PATH = TAXI_GROUP_CREATE_PATH + "/:id";
export const TAXI_GROUP_RENAMED_ACTION = "taxi_group.renamed";
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

/**
 * CX-117: geschlossenes DTO der Umbenennung. Nur der neue Name und der
 * bestehende erwartete Aenderungsstand sind zulaessig; Betreiber, Mitglieder
 * und Revision stammen nie aus dem Request.
 */
const RENAME_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["name", "revision"],
  properties: {
    name: {
      type: "string",
      minLength: 1,
      maxLength: MAX_TAXI_GROUP_NAME_LENGTH,
    },
    revision: { type: "integer", minimum: 0 },
  },
};

const GROUP_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** Uebernimmt exakt die Namensregel der CX-114-Anlage: trimmen, 1..120. */
function normalizeTaxiGroupName(rawName: unknown): string {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (name.length < 1 || name.length > MAX_TAXI_GROUP_NAME_LENGTH) {
    throw ApiError.invalidRequest();
  }
  return name;
}

/**
 * CX-117 / R-104: benennt genau eine Gruppe des angemeldeten Betreibers um.
 *
 * Der Datensatz wird in der Transaktion gesperrt; der zusaetzliche
 * Versionsvergleich im UPDATE schuetzt auch dann, wenn zwei Anfragen mit
 * demselben Ausgangsstand konkurrieren. Fremde und unbekannte Gruppen sind
 * nach aussen nicht unterscheidbar (404). Gleicher Name bei aktuellem Stand
 * ist ein erfolgreicher No-op ohne Revisionssprung und ohne Aenderungs-Audit.
 * Audit und Name entstehen auf demselben Client und damit in derselben
 * Transaktion.
 */
async function renameTaxiGroup(
  pool: Pool,
  rawId: unknown,
  rawName: unknown,
  rawRevision: unknown,
  actorId: string,
  at: Date,
): Promise<CreatedTaxiGroup> {
  const id = typeof rawId === "string" ? rawId.trim().toLowerCase() : "";
  if (!GROUP_ID_PATTERN.test(id)) {
    throw ApiError.notFound();
  }
  const name = normalizeTaxiGroupName(rawName);
  if (
    typeof rawRevision !== "number" ||
    !Number.isInteger(rawRevision) ||
    rawRevision < 0
  ) {
    throw ApiError.invalidRequest();
  }

  await ensureTaxiGroupSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const current = (
      await client.query<TaxiGroupRow & { owner_id: string }>(
        [
          "select id::text as id, name, revision::int as revision, owner_id",
          "  from taxi_groups where id = $1::uuid for update",
        ].join("\n"),
        [id],
      )
    ).rows[0];
    // Nichtoffenlegung: fremde und unbekannte Gruppen liefern dasselbe 404.
    if (current === undefined || current.owner_id !== actorId) {
      throw ApiError.notFound();
    }
    if (current.revision !== rawRevision) {
      throw new ApiError("invalid_request", { statusCode: 409 });
    }
    if (current.name === name) {
      await client.query("commit");
      return {
        id: current.id,
        name: current.name,
        revision: current.revision,
      };
    }

    const updated = (
      await client.query<TaxiGroupRow>(
        [
          "update taxi_groups set name = $2, revision = revision + 1",
          " where id = $1::uuid and revision = $3",
          "returning id::text as id, name, revision::int as revision",
        ].join("\n"),
        [id, name, rawRevision],
      )
    ).rows[0];
    if (updated === undefined) {
      throw new ApiError("invalid_request", { statusCode: 409 });
    }

    await insertAuditEvent(client, {
      at,
      actorType: "admin",
      actorId,
      action: TAXI_GROUP_RENAMED_ACTION,
      targetType: TAXI_GROUP_AUDIT_TARGET_TYPE,
      targetId: updated.id,
      details: {
        previous_name: current.name,
        name: updated.name,
        revision: updated.revision,
      },
    });
    await client.query("commit");
    return { id: updated.id, name: updated.name, revision: updated.revision };
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
      const principalId = actorIdOf(request);
      let group: CreatedTaxiGroup;
      try {
        group = await createTaxiGroup(deps.pool, {
          name: body.name,
          ownerId: principalId,
          actorId: principalId,
          at: now(),
        });
      } catch (error) {
        if (error instanceof TaxiGroupCreateError) {
          if (error.code === "conflict") {
            throw new ApiError("invalid_request", { statusCode: 409 });
          }
          throw ApiError.invalidRequest();
        }
        throw error;
      }
      reply.code(201).send({
        id: group.id,
        name: group.name,
        revision: group.revision,
      });
    },
  });
}

/**
 * Registriert PATCH /v1/admin/taxi-groups/:id genau einmal. Der Rechtekern
 * klassifiziert die Route als menschliche Schreibaktion groups.write; der
 * vorhandene Schreibschutz und die Sitzungspruefung gelten zusaetzlich.
 */
export function registerTaxiGroupRenameRoute(
  app: FastifyInstance,
  deps: TaxiGroupRoutesDeps,
): void {
  const sessionGuard = createAdminSessionMiddleware(deps.adminAuth);
  const now = (): Date => new Date();

  registerJsonRoute(app, {
    method: "PATCH",
    url: TAXI_GROUP_RENAME_PATH,
    bodySchema: RENAME_SCHEMA,
    onRequest: [requireAdminWrite, sessionGuard],
    handler: async (request, reply) => {
      const params = request.params as { id?: unknown };
      const body = request.body as Record<string, unknown>;
      const group = await renameTaxiGroup(
        deps.pool,
        params.id,
        body.name,
        body.revision,
        actorIdOf(request),
        now(),
      );
      reply.header("Cache-Control", "no-store");
      reply.code(200).send({
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

