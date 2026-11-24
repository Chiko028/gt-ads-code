/**
 * CX-031 / R-202: schlanker Upload-HTTP-Adapter fuer POST /v1/admin/media.
 *
 * Der Adapter prueft ausschliesslich Sitzung, Upload-Berechtigung, Origin,
 * Content-Type, Query und Transportgrenze. Medienpruefung, Hash, Speicherung
 * und Erfolgsauditierung bleiben vollstaendig beim vorhandenen CX-030-Service:
 * pro Anfrage wird dessen oeffentliche createMedia-Schnittstelle genau einmal
 * aufgerufen. Der Adapter erfindet weder Profilmetadaten noch Speicherpfade.
 *
 * Der Content-Type-Parser und die Groessengrenze sind auf den gekapselten
 * Plugin-Kontext dieser Route beschraenkt; globale Parser bleiben unveraendert.
 *
 * L-01 (1000 MB): Der Body wird nicht mehr gepuffert, sondern als Strom an
 * createMedia weitergereicht, das ihn direkt in die temporaere Datei
 * schreibt. Die Grenze prueft der Adapter selbst: ein zu grosses
 * Content-Length wird vor dem Lesen, ein zu langer Strom beim Ueberschreiten
 * mit 413 abgewiesen.
 */
import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  MediaInUseError,
  MediaInputError,
  MediaNotFoundError,
  MediaProfileRejectedError,
  MediaStorageError,
  isMediaId,
  type CreateMediaInput,
  type DeleteMediaOptions,
  type MediaDeletionResult,
  type MediaServiceOptions,
  type ReadyMedia,
} from "../modules/media/index.js";
import { MEDIA_MAX_SIZE_BYTES } from "../modules/media/profile.js";
import { hasAction } from "./accessPolicy.js";
import { assertSameOriginForWrite } from "./authorization.js";
import { ApiError } from "./errors.js";
import { isValidPrincipal, type PrincipalResolver } from "./principal.js";

/** Einzige registrierte Upload-Route (siehe Rechtekern-Katalog). */
export const MEDIA_UPLOAD_PATH = "/v1/admin/media";

/** Einzige registrierte Loeschroute (siehe Rechtekern-Katalog). */
export const MEDIA_DELETE_PATH = "/v1/admin/media/:id";

/** Obergrenze des Uploads: exakt die Medienprofilgrenze (dezimale 1.000 MB). */
export const MEDIA_UPLOAD_MAX_BYTES = MEDIA_MAX_SIZE_BYTES;

/**
 * Antwort-Header eines 422 mit den stabilen Profilfehler-Codes
 * (kommagetrennt), damit das Dashboard den Grund nennen kann. Der Fehlerkoerper
 * bleibt unveraendert der API-Vertrag.
 */
export const MEDIA_PROFILE_ERRORS_HEADER = "X-Media-Profile-Errors";

/** Obergrenze des optionalen Anzeigenamens. */
export const MEDIA_UPLOAD_MAX_NAME_LENGTH = 128;

const OCTET_STREAM = "application/octet-stream";

/**
 * Der produktive Groessenpruefer hat die Medienprofilgrenze ueberschritten.
 * Der Adapter bildet diesen internen Fehler auf den vorhandenen 413-Fehler ab
 * und gibt keine Meldung, Pfade oder Bytezahlen nach aussen.
 */
export class MediaUploadTooLargeError extends Error {
  constructor() {
    super("Upload ueberschreitet die Medienprofilgrenze.");
    this.name = "MediaUploadTooLargeError";
  }
}

/**
 * Produktiver Groessenpruefer des Upload-Adapters.
 *
 * Er zaehlt ausschliesslich die tatsaechlich gelieferten Bytes und nicht die
 * behauptete Content-Length. Beim ersten Byte oberhalb der Grenze bricht er
 * ab. Chunks werden unveraendert weitergereicht; es entsteht kein zusaetzlicher
 * Gesamtpuffer. Die Vorgabe ist die Medienprofilgrenze aus CX-155.
 */
export async function* enforceMediaUploadLimit(
  source: AsyncIterable<Uint8Array>,
  limit: number = MEDIA_UPLOAD_MAX_BYTES,
): AsyncGenerator<Uint8Array> {
  let total = 0;
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array)) {
      throw ApiError.invalidRequest();
    }
    total += chunk.byteLength;
    if (total > limit) {
      throw new MediaUploadTooLargeError();
    }
    yield chunk;
  }
}

/**
 * Erkennt den Groessenfehler sowohl direkt als auch in der vorhandenen
 * Speichergrenze eingekapselt (CX-030 bewahrt die Ursache auf).
 */
function isMediaUploadTooLarge(error: unknown): boolean {
  if (error instanceof MediaUploadTooLargeError) {
    return true;
  }
  return (
    error instanceof MediaStorageError &&
    error.cause instanceof MediaUploadTooLargeError
  );
}

/**
 * Schmale, typisierte Servicegrenze. Die Produktionsverdrahtung bindet die
 * vorhandene CX-030-Funktion createMedia(options, input) an diese Signatur.
 * Tests duerfen ausschliesslich diese Grenze ersetzen; ein Testschalter im
 * normalen Laufzeitpfad existiert nicht.
 */
export interface MediaUploadDeps {
  /** Die vorhandene CX-030-Funktion in ihrer tatsaechlichen Signatur. */
  createMedia: (
    options: MediaServiceOptions,
    input: CreateMediaInput,
  ) => Promise<ReadyMedia>;
  /** Produktionsoptionen des vorhandenen Speichers (Pool und Ablageort). */
  serviceOptions: MediaServiceOptions;
  /**
   * Obergrenze in Byte; Standard MEDIA_UPLOAD_MAX_BYTES. Nur Tests setzen
   * einen kleineren Wert, damit keine Gigabyte erzeugt werden muessen.
   */
  maxBytes?: number;
}

/** Explizite oeffentliche Projektion; enthaelt keine internen Felder. */
export interface MediaUploadResponse {
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
}

interface UploadQuery {
  name: string | undefined;
}

/**
 * Erlaubt ausschliesslich den optionalen Stringparameter name mit maximal 128
 * Zeichen. Unbekannte oder mehrfach gesetzte Parameter werden abgelehnt und
 * nicht still entfernt.
 */
function parseQuery(query: unknown): UploadQuery {
  if (typeof query !== "object" || query === null || Array.isArray(query)) {
    throw ApiError.invalidRequest();
  }
  const record = query as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "name") {
      throw ApiError.invalidRequest();
    }
  }
  const raw = record.name;
  if (raw === undefined) {
    return { name: undefined };
  }
  if (typeof raw !== "string" || raw.length > MEDIA_UPLOAD_MAX_NAME_LENGTH) {
    throw ApiError.invalidRequest();
  }
  return { name: raw };
}

/** Media-Type ohne Parameter, exakt application/octet-stream. */
function isOctetStream(contentType: string | undefined): boolean {
  if (typeof contentType !== "string") {
    return false;
  }
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  return mediaType === OCTET_STREAM;
}

function isReadable(value: unknown): value is Readable {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] ===
      "function" &&
    typeof (value as { pipe?: unknown }).pipe === "function"
  );
}

function tooLarge(): ApiError {
  return new ApiError("invalid_request", { statusCode: 413, headers: { Connection: "close" } });
}

/** Content-Length als ganze Zahl oder null, falls nicht (eindeutig) gesetzt. */
function declaredLength(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
    return null;
  }
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function toResponse(created: ReadyMedia): MediaUploadResponse {
  return {
    id: created.id,
    name: created.displayName,
    size_bytes: created.sizeBytes,
    sha256: created.sha256,
    profile: {
      container: created.profile.container,
      video_codec: created.profile.videoCodec,
      width: created.profile.width,
      height: created.profile.height,
      frame_rate_numerator: created.profile.frameRateNumerator,
      frame_rate_denominator: created.profile.frameRateDenominator,
      audio_stream_count: created.profile.audioStreamCount,
      duration_seconds: created.profile.durationSeconds,
    },
  };
}

async function handleUpload(
  deps: MediaUploadDeps,
  request: FastifyRequest,
): Promise<MediaUploadResponse> {
  // Der Rechtekern hat Identitaet und media.write bereits vor der
  // Bodyverarbeitung geprueft; hier wird nur noch der verifizierte Akteur
  // uebernommen. Ein fehlender Principal ist kein Erfolgsfall.
  const principal = request.accessPrincipal;
  if (principal === undefined) {
    throw ApiError.unauthorized();
  }

  if (!isOctetStream(request.headers["content-type"])) {
    throw new ApiError("invalid_request", { statusCode: 415 });
  }

  const { name } = parseQuery(request.query);
  const body = request.body;
  if (!isReadable(body)) {
    throw ApiError.invalidRequest();
  }

  const maxBytes = deps.maxBytes ?? MEDIA_UPLOAD_MAX_BYTES;
  const declared = declaredLength(request.headers["content-length"]);
  if (declared !== null && declared > maxBytes) {
    throw tooLarge();
  }

  let created: ReadyMedia;
  try {
    created = await deps.createMedia(deps.serviceOptions, {
      // Ohne optionalen Namen wird keine Bezeichnung erfunden; der bestehende
      // CX-030-Service entscheidet ueber die Gueltigkeit.
      displayName: name ?? "",
      content: enforceMediaUploadLimit(
        // Ein Abbruch beendet nur das Lesen; die Verbindung bleibt fuer die
        // 413-Antwort offen und wird danach geschlossen.
        body.iterator({ destroyOnReturn: false }) as AsyncIterable<Uint8Array>,
        maxBytes,
      ),
      // Der HTTP-Adapter fuehrt keine Medienanalyse durch. Profilmetadaten
      // liest der Service mit dem serverseitigen MP4-Leser aus der
      // gespeicherten Datei (L-01); hier wird nichts vorgetaeuscht.
      metadata: undefined,
      actorType: "admin",
      actorId: principal.id,
    });
  } catch (error) {
    if (isMediaUploadTooLarge(error)) {
      throw tooLarge();
    }
    if (error instanceof MediaProfileRejectedError) {
      // Bestehender typisierter Profilfehler: bereinigt als 422. Nur die
      // stabilen Codes gehen als Header mit, nie Meldungstexte.
      const codes = [...new Set(error.errors.map((entry) => entry.code))];
      throw new ApiError("invalid_request", {
        statusCode: 422,
        headers: { [MEDIA_PROFILE_ERRORS_HEADER]: codes.join(",") },
      });
    }
    if (error instanceof MediaInputError) {
      throw ApiError.invalidRequest();
    }
    // Unerwartete Serviceausnahmen werden nie mit Meldung, SQL oder Pfaden
    // weitergereicht oder protokolliert; der zentrale Handler liefert 500.
    throw new Error("Medien-Upload fehlgeschlagen.");
  }

  return toResponse(created);
}

/**
 * Registriert POST /v1/admin/media genau einmal. Parser und bodyLimit gelten
 * nur im gekapselten Kontext dieser Route.
 */
export function registerMediaUploadRoute(
  app: FastifyInstance,
  deps: MediaUploadDeps,
): void {
  void app.register(async (scope) => {
    // Kein Puffern: der Rohstrom wird als Body weitergereicht; die Grenze
    // prueft handleUpload (Content-Length vorab, Strom beim Lesen).
    scope.addContentTypeParser(OCTET_STREAM, (_request, payload, done) => {
      done(null, payload);
    });

    scope.post<{ Querystring: Record<string, unknown> }>(
      MEDIA_UPLOAD_PATH,
      { bodyLimit: deps.maxBytes ?? MEDIA_UPLOAD_MAX_BYTES },
      async (request, reply) => {
        const response = await handleUpload(deps, request);
        reply.code(201).type("application/json; charset=utf-8").send(response);
      },
    );
  });
}



/**
 * CX-079 / R-203: geschuetzte logische Loeschung eines Mediums.
 *
 * Der Handler prueft ausschliesslich die vorhandenen Sitzungs-, Rollen- und
 * Originregeln und delegiert genau einmal an die vorhandene CX-078-Grenze
 * deleteMedia(options, id, deleteOptions). Loeschzustand und Erfolgsaudit
 * entstehen ausschliesslich dort in einer Transaktion; der Adapter schreibt
 * kein zweites Audit und fuehrt keine Referenz- oder Dateipruefung durch.
 */
export interface MediaDeleteDeps {
  /** Vorhandene CX-078-Funktion in ihrer tatsaechlichen Signatur. */
  deleteMedia: (
    options: MediaServiceOptions,
    id: string,
    deleteOptions?: DeleteMediaOptions,
  ) => Promise<MediaDeletionResult>;
  /** Produktionsoptionen des vorhandenen Medienspeichers. */
  serviceOptions: MediaServiceOptions;
  /** Vorhandene serverseitige Sitzungspruefung, kein Ersatz durch Header. */
  resolvePrincipal: PrincipalResolver;
}

/** DELETE /v1/admin/media/:id nimmt keine Queryparameter an. */
function assertNoDeleteQuery(query: unknown): void {
  if (typeof query !== "object" || query === null || Array.isArray(query)) {
    throw ApiError.invalidRequest();
  }
  if (Object.keys(query as Record<string, unknown>).length > 0) {
    throw ApiError.invalidRequest();
  }
}

/**
 * Eine Loeschanfrage hat keinen Nutzdatenteil. Ein leerer Buffer bzw. ein
 * leerer Text bleibt zulaessig; jedes geparste JSON-Objekt, Array oder nicht
 * leere Nutzdatum wird abgelehnt statt still verworfen.
 */
function assertNoDeleteBody(body: unknown): void {
  if (body === undefined || body === null) {
    return;
  }
  if (Buffer.isBuffer(body)) {
    if (body.length === 0) {
      return;
    }
    throw ApiError.invalidRequest();
  }
  if (typeof body === "string" && body.length === 0) {
    return;
  }
  throw ApiError.invalidRequest();
}

/** Bildet ausschliesslich die typisierten CX-078-Fehler auf den Vertrag ab. */
function toDeleteApiError(error: unknown): never {
  if (error instanceof MediaNotFoundError) {
    throw ApiError.notFound();
  }
  if (error instanceof MediaInUseError) {
    throw new ApiError("invalid_request", { statusCode: 409 });
  }
  if (error instanceof MediaInputError) {
    throw ApiError.invalidRequest();
  }
  // Unerwartete Serviceausnahmen werden nie mit Meldung, SQL, Pfad oder
  // Stacktrace weitergereicht; der gekapselte Fehlerbaustein liefert 500.
  throw new Error("Medien-Loeschung fehlgeschlagen.");
}

async function handleDelete(
  deps: MediaDeleteDeps,
  request: FastifyRequest<{
    Params: { id: string };
    Querystring: Record<string, unknown>;
  }>,
): Promise<void> {
  // Vor Authentifizierung: derselbe Origin-Schreibschutz wie im Rechtekern.
  // Er gilt auch ohne Requestbody.
  assertSameOriginForWrite(request);

  const principal = await deps.resolvePrincipal(request);
  if (!isValidPrincipal(principal)) {
    throw ApiError.unauthorized();
  }
  if (!hasAction(principal.role, "media.write")) {
    throw ApiError.forbidden();
  }

  const id = request.params.id;
  if (!isMediaId(id)) {
    throw ApiError.invalidRequest();
  }
  assertNoDeleteQuery(request.query);
  assertNoDeleteBody(request.body);

  try {
    // Der Akteur stammt ausschliesslich aus der serverseitigen Sitzung.
    await deps.deleteMedia(deps.serviceOptions, id, {
      actorType: "admin",
      actorId: principal.id,
    });
  } catch (error) {
    toDeleteApiError(error);
  }
}

/**
 * Registriert DELETE /v1/admin/media/:id genau einmal. Der Handler nutzt die
 * vorhandene CX-078-Servicegrenze; es entsteht keine eigene Persistenz.
 */
export function registerMediaDeleteRoute(
  app: FastifyInstance,
  deps: MediaDeleteDeps,
): void {
  app.delete<{
    Params: { id: string };
    Querystring: Record<string, unknown>;
  }>(MEDIA_DELETE_PATH, async (request, reply) => {
    await handleDelete(deps, request);
    reply.code(204).send();
  });
}
