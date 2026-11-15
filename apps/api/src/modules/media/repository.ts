import type { SqlQueryable } from "../audit/repository.js";
import { MediaInputError, MediaStorageError } from "./errors.js";
import { isMediaId } from "./storage.js";
import type {
  ListReadyMediaQuery,
  MediaListPage,
  MediaMetadata,
  MediaProfileMetadata,
  MediaSqlPool,
} from "./types.js";
import {
  MEDIA_DEFAULT_LIST_LIMIT,
  MEDIA_MAX_LIST_LIMIT,
} from "./types.js";

const COLUMNS = [
  "id::text as id",
  "display_name",
  "size_bytes::text as size_bytes",
  "sha256",
  "container",
  "video_codec",
  "width",
  "height",
  "frame_rate_numerator",
  "frame_rate_denominator",
  "audio_stream_count",
  "duration_seconds",
  "created_at",
  "status",
  "ready_at",
].join(", ");

export interface MediaDeletionRow {
  id: string;
  status: "staging" | "ready";
  deleted_at: Date | string | null;
}

export interface MediaRow {
  id: string;
  display_name: string;
  size_bytes: string | null;
  sha256: string | null;
  container: string | null;
  video_codec: string | null;
  width: number | null;
  height: number | null;
  frame_rate_numerator: number | null;
  frame_rate_denominator: number | null;
  audio_stream_count: number | null;
  duration_seconds: number | null;
  created_at: Date | string;
  status: "staging" | "ready";
  ready_at: Date | string | null;
}

interface CursorPosition {
  createdAt: Date;
  id: string;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function requireNumber(value: number | null, field: string): number {
  if (value === null || !Number.isFinite(value)) {
    throw new MediaStorageError(
      "invalid_row",
      "Gespeichertes Feld " + field + " ist unvollstaendig.",
    );
  }
  return value;
}

function requireText(value: string | null, field: string): string {
  if (value === null || value === "") {
    throw new MediaStorageError(
      "invalid_row",
      "Gespeichertes Feld " + field + " ist unvollstaendig.",
    );
  }
  return value;
}

/** Wandelt ausschliesslich vollstaendige ready-Zeilen in oeffentliche Daten. */
export function mapReadyRow(row: MediaRow): MediaMetadata {
  if (row.status !== "ready") {
    throw new MediaStorageError("invalid_row", "Zeile ist nicht bereitgestellt.");
  }
  if (row.size_bytes === null || row.sha256 === null) {
    throw new MediaStorageError("invalid_row", "Bytezahl oder Hash fehlt.");
  }

  const sizeBytes = Number(row.size_bytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
    throw new MediaStorageError("invalid_row", "Ungueltige Bytezahl.");
  }

  const profile: MediaProfileMetadata = {
    container: requireText(row.container, "container"),
    videoCodec: requireText(row.video_codec, "video_codec"),
    width: requireNumber(row.width, "width"),
    height: requireNumber(row.height, "height"),
    frameRateNumerator: requireNumber(
      row.frame_rate_numerator,
      "frame_rate_numerator",
    ),
    frameRateDenominator: requireNumber(
      row.frame_rate_denominator,
      "frame_rate_denominator",
    ),
    audioStreamCount: requireNumber(
      row.audio_stream_count,
      "audio_stream_count",
    ),
    durationSeconds: requireNumber(row.duration_seconds, "duration_seconds"),
  };

  return {
    id: row.id,
    displayName: row.display_name,
    sizeBytes,
    sha256: row.sha256,
    profile,
    createdAt: asDate(row.created_at),
    status: "ready",
  };
}

/** Obergrenze des opaken Cursors; beide Werte zusammen bleiben klein. */
const CURSOR_MAX_LENGTH = 512;
const CURSOR_FORMAT = /^[A-Za-z0-9_-]+$/;

function invalidCursor(): MediaInputError {
  return new MediaInputError(
    "invalid_cursor",
    "Der Listen-Cursor ist ungueltig.",
  );
}

function encodeCursor(item: MediaMetadata): string {
  return Buffer.from(
    JSON.stringify({ createdAt: item.createdAt.toISOString(), id: item.id }),
    "utf8",
  ).toString("base64url");
}

/**
 * Dekodiert ausschliesslich den eigenen, groessenbegrenzten Cursor. Geprueft
 * werden Traegerformat und beide Werte: created_at muss die kanonische
 * ISO-8601-Darstellung sein, die ID eine gueltige Medien-UUID. Zusaetzliche
 * Felder werden abgelehnt; der Cursor wird nie als SQL-Fragment verwendet.
 */
function decodeCursor(cursor: string): CursorPosition {
  if (
    typeof cursor !== "string" ||
    cursor.length < 1 ||
    cursor.length > CURSOR_MAX_LENGTH ||
    !CURSOR_FORMAT.test(cursor)
  ) {
    throw invalidCursor();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidCursor();
  }

  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 2 ||
    !keys.includes("createdAt") ||
    !keys.includes("id")
  ) {
    throw invalidCursor();
  }

  const createdAt = record.createdAt;
  const id = record.id;
  if (
    typeof createdAt !== "string" ||
    createdAt.length > 40 ||
    typeof id !== "string" ||
    !isMediaId(id)
  ) {
    throw invalidCursor();
  }

  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== createdAt) {
    throw invalidCursor();
  }

  return { createdAt: date, id };
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return MEDIA_DEFAULT_LIST_LIMIT;
  }
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MEDIA_MAX_LIST_LIMIT
  ) {
    throw new MediaInputError(
      "invalid_limit",
      "Die Seitengroesse muss zwischen 1 und " +
        MEDIA_MAX_LIST_LIMIT +
        " liegen.",
    );
  }
  return limit;
}

/** PostgreSQL-Repository des Medienspeichers. */
export class MediaRepository {
  private readonly pool: MediaSqlPool;

  constructor(pool: MediaSqlPool) {
    this.pool = pool;
  }

  async insertStaging(
    id: string,
    displayName: string,
    createdAt: Date,
  ): Promise<void> {
    await this.pool.query(
      [
        "insert into media_objects",
        "  (id, display_name, created_at, status)",
        "values ($1::uuid, $2, $3, 'staging')",
      ].join("\n"),
      [id, displayName, createdAt],
    );
  }

  async attachStagingMetadata(
    id: string,
    sizeBytes: number,
    sha256: string,
    profile: MediaProfileMetadata,
  ): Promise<boolean> {
    const result = await this.pool.query(
      [
        "update media_objects",
        "   set size_bytes = $2,",
        "       sha256 = $3,",
        "       container = $4,",
        "       video_codec = $5,",
        "       width = $6,",
        "       height = $7,",
        "       frame_rate_numerator = $8,",
        "       frame_rate_denominator = $9,",
        "       audio_stream_count = $10,",
        "       duration_seconds = $11",
        " where id = $1::uuid and status = 'staging'",
      ].join("\n"),
      [
        id,
        sizeBytes,
        sha256,
        profile.container,
        profile.videoCodec,
        profile.width,
        profile.height,
        profile.frameRateNumerator,
        profile.frameRateDenominator,
        profile.audioStreamCount,
        profile.durationSeconds,
      ],
    );
    return result.rowCount === 1;
  }

  async deleteStaging(id: string): Promise<boolean> {
    const result = await this.pool.query(
      "delete from media_objects where id = $1::uuid and status = 'staging'",
      [id],
    );
    return result.rowCount === 1;
  }

  async markReady(
    executor: SqlQueryable,
    id: string,
    readyAt: Date,
  ): Promise<MediaMetadata | null> {
    const result = await executor.query<MediaRow>(
      [
        "update media_objects",
        "   set status = 'ready', ready_at = $2",
        " where id = $1::uuid and status = 'staging'",
        " returning " + COLUMNS,
      ].join("\n"),
      [id, readyAt],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapReadyRow(row);
  }

  async findReady(id: string): Promise<MediaMetadata | null> {
    return this.findReadyWith(this.pool, id);
  }

  async findReadyWith(
    executor: SqlQueryable,
    id: string,
  ): Promise<MediaMetadata | null> {
    const result = await executor.query<MediaRow>(
      [
        "select " + COLUMNS,
        "  from media_objects",
        " where id = $1::uuid and status = 'ready'",
      ].join("\n"),
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapReadyRow(row);
  }

  /**
   * Sperrt die Zeile fuer die Loeschung exklusiv. Zuordnung und Aktivierung
   * halten dieselbe Zeile mit FOR SHARE; dadurch sind Markierung und
   * Referenzpruefung gemeinsam serialisiert.
   */
  async lockForDeletion(
    executor: SqlQueryable,
    id: string,
  ): Promise<MediaDeletionRow | null> {
    const result = await executor.query<MediaDeletionRow>(
      [
        "select id::text as id, status, deleted_at",
        "  from media_objects",
        " where id = $1::uuid",
        "   for update",
      ].join("\n"),
      [id],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Prueft eine aktive, nicht archivierte Kampagne. Das Kampagnenschema wird
   * vom Kampagnenmodul additiv angelegt; fehlt es, gibt es keine Referenz.
   */
  async hasActiveCampaign(
    executor: SqlQueryable,
    id: string,
  ): Promise<boolean> {
    const table = await executor.query<{ present: boolean }>(
      "select to_regclass('campaigns') is not null as present",
    );
    if (table.rows[0]?.present !== true) {
      return false;
    }
    const result = await executor.query<{ active: boolean }>(
      [
        "select exists (",
        "  select 1",
        "    from campaigns",
        "   where media_id = $1::uuid",
        "     and status = 'active'",
        "     and archived = false",
        ") as active",
      ].join("\n"),
      [id],
    );
    return result.rows[0]?.active === true;
  }

  /** Setzt deleted_at genau einmal und liefert den gespeicherten Zeitpunkt. */
  async markDeleted(
    executor: SqlQueryable,
    id: string,
    at: Date,
  ): Promise<Date | null> {
    const result = await executor.query<{ deleted_at: Date | string }>(
      [
        "update media_objects",
        "   set deleted_at = $2",
        " where id = $1::uuid",
        "   and status = 'ready'",
        "   and deleted_at is null",
        " returning deleted_at",
      ].join("\n"),
      [id, at],
    );
    const value = result.rows[0]?.deleted_at;
    return value === undefined ? null : asDate(value);
  }

  async listStaging(): Promise<MediaRow[]> {
    const result = await this.pool.query<MediaRow>(
      [
        "select " + COLUMNS,
        "  from media_objects",
        " where status = 'staging'",
        " order by created_at asc, id asc",
      ].join("\n"),
    );
    return result.rows;
  }

  async listReady(query: ListReadyMediaQuery = {}): Promise<MediaListPage> {
    const limit = normalizeLimit(query.limit);
    const cursor =
      query.cursor === undefined || query.cursor === null
        ? null
        : decodeCursor(query.cursor);

    const values: unknown[] = [];
    const where = ["status = 'ready'", "deleted_at is null"];
    if (cursor !== null) {
      const createdAtIndex = values.push(cursor.createdAt);
      const idIndex = values.push(cursor.id);
      where.push(
        "(created_at, id) > ($" +
          createdAtIndex +
          "::timestamptz, $" +
          idIndex +
          "::uuid)",
      );
    }
    values.push(limit + 1);

    const result = await this.pool.query<MediaRow>(
      [
        "select " + COLUMNS,
        "  from media_objects",
        " where " + where.join(" and "),
        " order by created_at asc, id asc",
        " limit $" + values.length,
      ].join("\n"),
      values,
    );

    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const items = rows.map(mapReadyRow);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
    };
  }
}
