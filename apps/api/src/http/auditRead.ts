/**
 * Geschuetzter lesender Audit-Zugriff (CX-016 / CX-058 / R-603).
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
const ALLOWED_QUERY_FIELDS: ReadonlySet<string> = new Set([
  "cursor",
  "limit",
  "from",
  "to",
  "actor_id",
  "action",
]);

/** Groesster Wert des vorhandenen Typs bigint (signed 64 Bit). */
const BIGINT_MAX = 9223372036854775807n;

/** Obergrenze fuer die exakten Textfilter (keine Suche, nur Gleichheit). */
const MAX_FILTER_LENGTH = 256;

/**
 * RFC 3339 mit expliziter Zeitzone. Sekundenbruchteile sind optional; die
 * Zeitzone ist entweder Z/z oder ein numerischer Offset mit Doppelpunkt.
 */
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

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

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) {
    return 30;
  }
  return 31;
}

/**
 * Parst einen optionalen RFC-3339-Zeitpunkt. Eine fehlende Zeitzone, ein
 * unmoeglicher Kalendertag oder eine ungueltige Uhrzeit ergibt 400. Die
 * Umrechnung erfolgt ohne lokale Zeitzone des Servers.
 */
function parseTimestamp(raw: unknown): Date | null {
  if (raw === undefined) {
    return null;
  }
  if (typeof raw !== "string") {
    throw ApiError.invalidRequest();
  }
  const match = TIMESTAMP_PATTERN.exec(raw);
  if (match === null) {
    throw ApiError.invalidRequest();
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw ApiError.invalidRequest();
  }

  const fraction = match[7] ?? "";
  const millis = Number((fraction + "000").slice(0, 3));
  const instant = new Date(0);
  instant.setUTCFullYear(year, month - 1, day);
  instant.setUTCHours(hour, minute, second, millis);
  let time = instant.getTime();

  if (match[8] === undefined) {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (offsetHour > 23 || offsetMinute > 59) {
      throw ApiError.invalidRequest();
    }
    const sign = match[9] === "+" ? 1 : -1;
    time -= sign * (offsetHour * 60 + offsetMinute) * 60_000;
  }
  if (!Number.isFinite(time)) {
    throw ApiError.invalidRequest();
  }
  return new Date(time);
}

/** Exakter Textfilter; keine Suche, keine Trimung, keine SQL-Interpretation. */
function parseExactFilter(raw: unknown): string | null {
  if (raw === undefined) {
    return null;
  }
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > MAX_FILTER_LENGTH ||
    raw.includes("\u0000")
  ) {
    throw ApiError.invalidRequest();
  }
  return raw;
}

interface ParsedAuditQuery {
  cursor: string | null;
  limit: number;
  from: Date | null;
  to: Date | null;
  actorId: string | null;
  action: string | null;
}

/**
 * Liest und validiert ausschliesslich die erlaubten Filter. Filter werden mit
 * UND verknuepft; der Zeitraum ist [from, to).
 */
function parseQuery(query: unknown): ParsedAuditQuery {
  if (typeof query !== "object" || query === null || Array.isArray(query)) {
    throw ApiError.invalidRequest();
  }
  const record = query as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_QUERY_FIELDS.has(key)) {
      throw ApiError.invalidRequest();
    }
  }
  const from = parseTimestamp(record.from);
  const to = parseTimestamp(record.to);
  if (from !== null && to !== null && from.getTime() >= to.getTime()) {
    throw ApiError.invalidRequest();
  }
  return {
    cursor: parseCursor(record.cursor),
    limit: parseLimit(record.limit),
    from,
    to,
    actorId: parseExactFilter(record.actor_id),
    action: parseExactFilter(record.action),
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
      const parsed = parseQuery(request.query);

      // Parametrisierte Abfrage. Alle Filter wirken vor LIMIT; der Cursor
      // bezeichnet die zuletzt ausgegebene ID und wird aufsteigend fortgesetzt.
      const conditions: string[] = [];
      const params: Array<string | number | Date> = [];
      if (parsed.cursor !== null) {
        params.push(parsed.cursor);
        conditions.push("id > $" + params.length + "::bigint");
      }
      if (parsed.from !== null) {
        params.push(parsed.from);
        conditions.push("at >= $" + params.length + "::timestamptz");
      }
      if (parsed.to !== null) {
        params.push(parsed.to);
        conditions.push("at < $" + params.length + "::timestamptz");
      }
      if (parsed.actorId !== null) {
        params.push(parsed.actorId);
        conditions.push("actor_id = $" + params.length);
      }
      if (parsed.action !== null) {
        params.push(parsed.action);
        conditions.push("action = $" + params.length);
      }
      const where =
        conditions.length === 0 ? "" : " where " + conditions.join("\n  and ");
      params.push(parsed.limit + 1);

      const sql = [
        "select id::text as id, at, actor_type, actor_id, action,",
        "       target_type, target_id",
        "  from audit_events",
        where,
        " order by audit_events.id asc",
        " limit $" + params.length,
      ]
        .filter((part) => part !== "")
        .join("\n");

      const result = await deps.pool.query<AuditReadRow>(sql, params);
      const rows = result.rows;
      const hasMore = rows.length > parsed.limit;
      const page = hasMore ? rows.slice(0, parsed.limit) : rows;
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
