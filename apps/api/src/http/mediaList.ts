/**
 * CX-095 / R-203: geschuetzte, begrenzte Medienliste.
 *
 * Der Adapter liest ausschliesslich ready-Medien ohne logische Loeschung ueber
 * die vorhandene CX-030-Servicegrenze. Authentifizierung und Autorisierung
 * (media.read fuer Admin und Operator) erzwingt der Rechtekern CX-015 vor dem
 * Handler; Header oder Geraeteidentitaeten werden hier nicht ausgewertet.
 *
 * Es gibt nur die Queryparameter limit und cursor. Die Projektion enthaelt
 * weder Speicherpfade noch Download-Freigaben oder Medienbytes. Lesen erzeugt
 * kein Erfolgsaudit.
 */
import type { FastifyInstance } from "fastify";
import {
  MEDIA_DEFAULT_LIST_LIMIT,
  MEDIA_MAX_LIST_LIMIT,
  MediaInputError,
  type ListReadyMediaQuery,
  type MediaListPage,
  type MediaMetadata,
  type MediaServiceOptions,
} from "../modules/media/index.js";
import { ApiError } from "./errors.js";

/** Einzige registrierte Listenroute (siehe Rechtekern-Katalog). */
export const MEDIA_LIST_PATH = "/v1/admin/media";

/** Standard- und Hoechstlimit laut Arbeitspaket CX-095. */
export const MEDIA_LIST_DEFAULT_LIMIT = MEDIA_DEFAULT_LIST_LIMIT;
export const MEDIA_LIST_MAX_LIMIT = MEDIA_MAX_LIST_LIMIT;

/** Obergrenze des opaken Cursors; die Repository-Pruefung bleibt verbindlich. */
const CURSOR_MAX_LENGTH = 512;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Schmale, typisierte Servicegrenze. Die Produktionsverdrahtung bindet die
 * vorhandene CX-030-Funktion listReadyMedia(options, query) an diese Signatur.
 */
export interface MediaListDeps {
  listReadyMedia: (
    options: MediaServiceOptions,
    query: ListReadyMediaQuery,
  ) => Promise<MediaListPage>;
  serviceOptions: MediaServiceOptions;
}

/** Explizite oeffentliche Projektion; keine internen Felder. */
export interface MediaListItem {
  id: string;
  name: string;
  size_bytes: number;
  sha256: string;
  profile: {
    container: string;
    video_codec: string;
    width: number;
    height: number;
    frame_rate_numerator: number;
    frame_rate_denominator: number;
    audio_stream_count: number;
    duration_seconds: number;
  };
  created_at: string;
}

export interface MediaListResponse {
  items: MediaListItem[];
  next_cursor: string | null;
}

/**
 * Parst limit streng: ganze Zahl 1..100, Standard 50. Arrays (mehrfach
 * gesetzter Parameter), Vorzeichen, Bruchzahlen und Exponentialschreibweise
 * werden abgelehnt.
 */
function parseLimit(raw: unknown): number {
  if (raw === undefined) {
    return MEDIA_LIST_DEFAULT_LIMIT;
  }
  if (
    typeof raw !== "string" ||
    raw.length > 3 ||
    !/^(?:0|[1-9][0-9]*)$/.test(raw)
  ) {
    throw ApiError.invalidRequest();
  }
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MEDIA_LIST_MAX_LIMIT
  ) {
    throw ApiError.invalidRequest();
  }
  return value;
}

/**
 * Parst den opaken Cursor ausschliesslich als groessenbegrenzten
 * base64url-Traeger. Die inhaltliche Pruefung beider Werte erfolgt erneut im
 * Repository; hier wird kein Cursor in SQL eingesetzt.
 */
function parseCursor(raw: unknown): string | null {
  if (raw === undefined) {
    return null;
  }
  if (
    typeof raw !== "string" ||
    raw.length < 1 ||
    raw.length > CURSOR_MAX_LENGTH ||
    !BASE64URL.test(raw)
  ) {
    throw ApiError.invalidRequest();
  }
  return raw;
}

/** Liest und validiert ausschliesslich cursor und limit. */
function parseQuery(query: unknown): {
  cursor: string | null;
  limit: number;
} {
  if (typeof query !== "object" || query === null || Array.isArray(query)) {
    throw ApiError.invalidRequest();
  }
  const record = query as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "limit" && key !== "cursor") {
      throw ApiError.invalidRequest();
    }
  }
  return {
    cursor: parseCursor(record.cursor),
    limit: parseLimit(record.limit),
  };
}

function toItem(item: MediaMetadata): MediaListItem {
  return {
    id: item.id,
    name: item.displayName,
    size_bytes: item.sizeBytes,
    sha256: item.sha256,
    profile: {
      container: item.profile.container,
      video_codec: item.profile.videoCodec,
      width: item.profile.width,
      height: item.profile.height,
      frame_rate_numerator: item.profile.frameRateNumerator,
      frame_rate_denominator: item.profile.frameRateDenominator,
      audio_stream_count: item.profile.audioStreamCount,
      duration_seconds: item.profile.durationSeconds,
    },
    created_at: item.createdAt.toISOString(),
  };
}

async function handleList(
  deps: MediaListDeps,
  query: unknown,
): Promise<MediaListResponse> {
  const parsed = parseQuery(query);

  let page: MediaListPage;
  try {
    page = await deps.listReadyMedia(deps.serviceOptions, parsed);
  } catch (error) {
    // Bereits validierte Eingaben behalten 400; unerwartete Speicherfehler
    // werden nie mit Meldung, SQL oder Pfaden weitergereicht.
    if (error instanceof MediaInputError) {
      throw ApiError.invalidRequest();
    }
    throw new Error("Medienliste konnte nicht gelesen werden.");
  }

  return {
    items: page.items.map(toItem),
    next_cursor: page.nextCursor,
  };
}

/**
 * Registriert GET /v1/admin/media genau einmal. Die Route wird vom Rechtekern
 * als menschliche Aktion media.read klassifiziert.
 */
export function registerMediaListRoute(
  app: FastifyInstance,
  deps: MediaListDeps,
): void {
  app.get<{ Querystring: Record<string, unknown> }>(
    MEDIA_LIST_PATH,
    async (request, reply) => {
      if (request.accessPrincipal === undefined) {
        throw ApiError.unauthorized();
      }
      const body = await handleList(deps, request.query);
      reply.header("Cache-Control", "no-store");
      return body;
    },
  );
}
