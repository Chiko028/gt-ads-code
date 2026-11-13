/**
 * Geschuetzter lesender Audit-Zugriff (CX-016 / R-603).
 *
 * Der Adapter liest bestehende Audit-Ereignisse ausschliesslich ueber die
 * vorhandene Tabelle audit_events. Authentifizierung und Autorisierung
 * erfolgen vor dem Handler durch den Rechtekern (CX-015); hier wird nur noch
 * gelesen. Es werden weder Erfolgsereignisse geschrieben noch Details
 * ausgegeben.
 *
 * Projektion: nur die vorhandenen Kernfelder. request_id und outcome sind im
 * Bestand nicht vorhanden und werden deshalb nicht erfunden. details wird
 * niemals ausgewaehlt.
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { ApiError } from "./errors.js";

/** Standard- und Hoechstlimit laut Arbeitspaket CX-016. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** Einzige erlaubte Queryparameter. */
const ALLOWED_QUERY_FIELDS: ReadonlySet<string> = new Set(["cursor", "limit"]);

/** Groesster Wert des vorhandenen Typs bigint (signed 64 Bit). */
const BIGINT_MAX = 9223372036854775807n;

/**
 * Zeile der expliziten Projektion. id wird in SQL nach text konvertiert, damit
 * die JavaScript-Number-Grenze keine Rolle spielt.
 */
interface AuditReadRow {
  id: string;
  at: Date;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
}

export interface AuditReadItem {
  id: string;
  at: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
}

export interface AuditReadResponse {
  items: AuditReadItem[];
  next_cursor: string | null;
}

export interface AuditReadDeps {
  /** Vorhandener Datenbankzugriff; es wird keine parallele Ablage erzeugt. */
  pool: Pick<Pool, "query">;
}

/**
 * Parst limit streng: ganze Zahl 1..100, Standard 50. Arrays (mehrfach
 * gesetzter Parameter), Bruchzahlen, Vorzeichen und Exponentialschreibweise
 * werden abgelehnt.
 */
function parseLimit(raw: unknown): number {
  if (raw === undefined) {
    return DEFAULT_LIMIT;
  }
  if (typeof raw !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw ApiError.invalidRequest();
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw ApiError.invalidRequest();
  }
  return value;
}

/**
 * Parst cursor streng nach dem tatsaechlichen Datenbanktyp bigint: nur eine
 * nicht negative Dezimaldarstellung ohne Vorzeichen, Leerraum oder
 * Exponentialanteil. Die Bereichspruefung nutzt BigInt, damit keine
 * unsichere Number-Konvertierung stattfindet. Der Wert muss keinem Datensatz
 * entsprechen.
 */
function parseCursor(raw: unknown): string | null {
  if (raw === undefined) {
    return null;
  }
  if (typeof raw !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw ApiError.invalidRequest();
  }
  const value = BigInt(raw);
  if (value > BIGINT_MAX) {
    throw ApiError.invalidRequest();
  }
  return raw;
}

/** Liest und validiert ausschliesslich cursor und limit. */
function parseQuery(query: unknown): { cursor: string | null; limit: number } {
  if (typeof query !== "object" || query === null || Array.isArray(query)) {
    throw ApiError.invalidRequest();
  }
  const record = query as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_QUERY_FIELDS.has(key)) {
      throw ApiError.invalidRequest();
    }
  }
  return {
    cursor: parseCursor(record.cursor),
    limit: parseLimit(record.limit),
  };
}

function toItem(row: AuditReadRow): AuditReadItem {
  return {
    id: row.id,
    at: row.at.toISOString(),
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
  };
}

/**
 * Registriert GET /v1/admin/audit. Die Route wird vom Rechtekern als
 * menschliche Aktion audit.read klassifiziert; nur Admin besitzt dieses Recht.
 */
export function registerAuditReadRoutes(
  app: FastifyInstance,
  deps: AuditReadDeps,
): void {
  app.get<{ Querystring: Record<string, unknown> }>(
    "/v1/admin/audit",
    async (request, reply) => {
      const { cursor, limit } = parseQuery(request.query);

      // Parametrisierte Abfrage; LIMIT limit+1 erkennt eine weitere Seite.
      const conditions = cursor === null ? "" : " where id > $1::bigint";
      const limitPlaceholder = cursor === null ? "$1" : "$2";
      const sql = [
        "select id::text as id, at, actor_type, actor_id, action,",
        "       target_type, target_id",
        "  from audit_events",
        conditions,
        " order by audit_events.id asc",
        " limit " + limitPlaceholder,
      ]
        .filter((part) => part !== "")
        .join("\n");
      const params: Array<string | number> =
        cursor === null ? [limit + 1] : [cursor, limit + 1];

      const result = await deps.pool.query<AuditReadRow>(sql, params);
      const rows = result.rows;
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const items = page.map(toItem);
      const nextCursor =
        hasMore && items.length > 0
          ? (items[items.length - 1] as AuditReadItem).id
          : null;

      reply.header("Cache-Control", "no-store");
      const body: AuditReadResponse = { items, next_cursor: nextCursor };
      return body;
    },
  );
}

