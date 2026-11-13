/**
 * CX-031 / R-202: schlanker Upload-HTTP-Adapter fuer POST /v1/admin/media.
 *
 * Der Adapter prueft ausschliesslich Sitzung, Upload-Berechtigung, Origin,
 * Content-Type, Query und Transportgrenze. Medienpruefung, Hash, Speicherung
 * und Erfolgsauditierung bleiben vollstaendig beim vorhandenen CX-030-Service:
 * pro Anfrage wird dessen oeffentliche createMedia-Schnittstelle genau einmal
 * aufgerufen. Der Adapter erfindet weder Profilmetadaten noch Speicherpfade.
 *
 * Der Content-Type-Parser und die 20-MB-Grenze sind auf den gekapselten
 * Plugin-Kontext dieser Route beschraenkt; globale Parser bleiben unveraendert.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  MediaInputError,
  MediaProfileRejectedError,
  type CreateMediaInput,
  type MediaServiceOptions,
  type ReadyMedia,
} from "../modules/media/index.js";
import { ApiError } from "./errors.js";

/** Einzige registrierte Upload-Route (siehe Rechtekern-Katalog). */
export const MEDIA_UPLOAD_PATH = "/v1/admin/media";

/** Dezimale 20 MB laut R-202 und CX-003-Profil. */
export const MEDIA_UPLOAD_MAX_BYTES = 20_000_000;

/** Obergrenze des optionalen Anzeigenamens. */
export const MEDIA_UPLOAD_MAX_NAME_LENGTH = 128;

const OCTET_STREAM = "application/octet-stream";

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

/** Die gepufferten Bytes werden unveraendert als ein Chunk weitergereicht. */
async function* bufferedContent(body: Buffer): AsyncGenerator<Uint8Array> {
  yield body;
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
  if (!Buffer.isBuffer(body)) {
    throw ApiError.invalidRequest();
  }

  let created: ReadyMedia;
  try {
    created = await deps.createMedia(deps.serviceOptions, {
      // Ohne optionalen Namen wird keine Bezeichnung erfunden; der bestehende
      // CX-030-Service entscheidet ueber die Gueltigkeit.
      displayName: name ?? "",
      content: bufferedContent(body),
      // Der HTTP-Adapter fuehrt keine Medienanalyse durch. Profilmetadaten
      // stammen aus dem vorhandenen serverseitigen Leser der Modulkomposition
      // (CX-033); bis dahin wird kein Metadatensatz vorgetaeuscht.
      metadata: undefined,
      actorType: "admin",
      actorId: principal.id,
    });
  } catch (error) {
    if (error instanceof MediaProfileRejectedError) {
      // Bestehender typisierter Profilfehler: bereinigt als 422.
      throw new ApiError("invalid_request", { statusCode: 422 });
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
    scope.addContentTypeParser(
      OCTET_STREAM,
      { parseAs: "buffer", bodyLimit: MEDIA_UPLOAD_MAX_BYTES },
      (_request, body, done) => {
        done(null, body);
      },
    );

    scope.post<{ Querystring: Record<string, unknown> }>(
      MEDIA_UPLOAD_PATH,
      { bodyLimit: MEDIA_UPLOAD_MAX_BYTES },
      async (request, reply) => {
        const response = await handleUpload(deps, request);
        reply.code(201).type("application/json; charset=utf-8").send(response);
      },
    );
  });
}

