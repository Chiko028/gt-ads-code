/**
 * CX-044 / R-304: lesende Ausspielungs-Vorschau je Taxi.
 *
 * Der Adapter liest ausschliesslich das bereits veroeffentlichte
 * Manifest-Artefakt ueber den vorhandenen CX-041/042-Lesezugriff
 * (taxi_manifest_state.current_version -> taxi_manifest_artifacts). Er
 * erzeugt, signiert, speichert oder veraendert nichts und imitiert keine
 * Geraeteidentitaet.
 *
 * Die Antwort enthaelt nur Taxi-ID, Manifest-Version und die geordneten
 * Eintraege mit Medienkennung, Dauer und Laufzeitfenster. Download-Freigaben,
 * Tokens, Signaturen und Speicherpfade werden nie ausgegeben.
 *
 * Ein bekanntes Taxi ohne veroeffentlichtes Manifest liefert einen expliziten
 * Leerzustand (manifest_version null, entries leer); ein unbekanntes Taxi
 * ergibt 404.
 */
import type { FastifyInstance } from "fastify";
import { ApiError } from "./errors.js";
import type { StoredManifestArtifact } from "../modules/deviceManifest/index.js";
import type { TaxiExists } from "./taxiConfigRoutes.js";

/** Einzige registrierte Vorschau-Route (siehe Rechtekern-Katalog). */
export const PLAYOUT_PREVIEW_PATH =
  "/v1/admin/taxis/:taxiId/playout-preview";

/** Oeffentliche Projektion eines Manifest-Eintrags. */
export interface PlayoutPreviewEntry {
  readonly media_id: string;
  readonly duration_ms: number;
  readonly start_at: string;
  readonly end_at: string;
}

/** Oeffentliche Vorschauantwort; keine internen Felder oder Bytes. */
export interface PlayoutPreviewResponse {
  readonly taxi_id: string;
  readonly manifest_version: string | null;
  readonly entries: readonly PlayoutPreviewEntry[];
}

/**
 * Schmale Lesegrenze. Die Produktionsverdrahtung bindet den vorhandenen
 * CX-042-Leser an getCurrentArtifact; die Existenzpruefung ist der bereits
 * verwendete Verwaltungsadapter (CX-053).
 */
export interface PlayoutPreviewDeps {
  getCurrentArtifact(taxiId: string): Promise<StoredManifestArtifact | null>;
  taxiExists: TaxiExists;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Dekodiert ausschliesslich die bereits gespeicherte Manifest-Nutzlast in
 * ihrer persistierten Reihenfolge. Es wird weder neu geplant noch neu
 * serialisiert.
 */
export function decodePublishedEntries(
  artifact: StoredManifestArtifact,
): PlayoutPreviewEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(artifact.payloadBase64, "base64").toString("utf8"),
    );
  } catch {
    throw new Error("Das veroeffentlichte Manifest ist nicht lesbar.");
  }

  if (!isRecord(parsed)) {
    throw new Error("Das veroeffentlichte Manifest ist nicht lesbar.");
  }
  if (typeof parsed.taxiId === "string" && parsed.taxiId !== artifact.taxiId) {
    throw new Error("Das veroeffentlichte Manifest ist nicht lesbar.");
  }
  if (!Array.isArray(parsed.entries)) {
    throw new Error("Das veroeffentlichte Manifest ist nicht lesbar.");
  }

  return parsed.entries.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error("Das veroeffentlichte Manifest ist nicht lesbar.");
    }
    const mediaId = entry.mediaId;
    const durationMs = entry.durationMs;
    const startAt = entry.startAt;
    const endAt = entry.endAt;
    if (
      typeof mediaId !== "string" ||
      mediaId.trim() === "" ||
      typeof durationMs !== "number" ||
      !Number.isFinite(durationMs) ||
      typeof startAt !== "string" ||
      typeof endAt !== "string"
    ) {
      throw new Error("Das veroeffentlichte Manifest ist nicht lesbar.");
    }
    return {
      media_id: mediaId,
      duration_ms: durationMs,
      start_at: startAt,
      end_at: endAt,
    };
  });
}

function taxiIdOf(params: unknown): string {
  if (!isRecord(params)) {
    throw ApiError.notFound();
  }
  const taxiId = params.taxiId;
  if (typeof taxiId !== "string" || taxiId.trim() === "") {
    throw ApiError.notFound();
  }
  return taxiId;
}

/**
 * Registriert GET /v1/admin/taxis/:taxiId/playout-preview genau einmal.
 * Authentifizierung und Autorisierung (config.read fuer Admin und Operator)
 * erzwingt der vorhandene Rechtekern vor dem Handler. Lesen erzeugt kein
 * Audit und veraendert keinen Zustand.
 */
export function registerPlayoutPreviewRoute(
  app: FastifyInstance,
  deps: PlayoutPreviewDeps,
): void {
  app.get<{ Params: { taxiId: string } }>(
    PLAYOUT_PREVIEW_PATH,
    async (request, reply) => {
      if (request.accessPrincipal === undefined) {
        throw ApiError.unauthorized();
      }

      const taxiId = taxiIdOf(request.params);
      if (!(await deps.taxiExists(taxiId))) {
        throw ApiError.notFound();
      }

      const artifact = await deps.getCurrentArtifact(taxiId);

      // Eine Vorschau ist ein fluechtiger Lesezustand und darf nie aus einem
      // Zwischenspeicher eine andere Taxi-Auswahl anzeigen.
      reply.header("Cache-Control", "no-store");

      if (artifact === null) {
        return {
          taxi_id: taxiId,
          manifest_version: null,
          entries: [],
        } satisfies PlayoutPreviewResponse;
      }

      return {
        taxi_id: taxiId,
        manifest_version: artifact.version,
        entries: decodePublishedEntries(artifact),
      } satisfies PlayoutPreviewResponse;
    },
  );
}

