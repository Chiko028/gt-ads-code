/**
 * CX-042 / R-302: authentifizierter Manifest-Abruf.
 *
 * Der Dienst liest ausschliesslich das zuletzt vollstaendig veroeffentlichte
 * Artefakt. Er signiert nicht, erzeugt nichts und schreibt keine Bytes um:
 * die Antwort ist die kanonische Serialisierung der gespeicherten
 * Envelope-Felder. Der ETag ist der SHA-256 genau dieser Antwortbytes.
 *
 * Die Reihenfolge ist bindend: Authentifizierung (Middleware), aktuelle
 * Taxi-/Tabletzuordnung, Artefakt, erst danach der Cachevergleich. Dadurch
 * kann ein passendes If-None-Match weder eine fehlende Berechtigung noch ein
 * fehlendes Artefakt verdecken.
 */
import { createHash } from "node:crypto";
import { ApiError } from "../../http/errors.js";
import type { SignedManifestEnvelope } from "../playout/manifest.js";
import type { DeviceManifestReader } from "./reader.js";

/** Cache-Vorgabe fuer jedes 200- und 304-Ergebnis dieses Endpunkts. */
export const MANIFEST_CACHE_CONTROL = "private, no-cache";

/**
 * Serialisiert ausschliesslich die gespeicherten Envelope-Felder in fester
 * Reihenfolge. Dadurch sind die Antwortbytes fuer dasselbe Artefakt stabil
 * und entsprechen exakt den persistierten Werten (keine Neusignatur).
 */
export function serializeManifestEnvelope(
  envelope: SignedManifestEnvelope,
): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: envelope.schemaVersion,
      keyId: envelope.keyId,
      version: envelope.version,
      payloadBase64: envelope.payloadBase64,
      signatureBase64: envelope.signatureBase64,
    }),
    "utf8",
  );
}

/** Starkes, in Anfuehrungszeichen gesetztes Validierungsmerkmal. */
export function computeManifestEtag(bytes: Buffer): string {
  return '"' + createHash("sha256").update(bytes).digest("hex") + '"';
}

/**
 * Verarbeitet If-None-Match fuer GET nach RFC 9110:
 * - "*" trifft jede vorhandene Darstellung,
 * - Listen werden elementweise geprueft,
 * - schwache Marker (W/) werden fuer den schwachen Vergleich entfernt.
 * Unbekannte oder unquoted Marker treffen nicht.
 */
export function ifNoneMatchMatches(
  header: string | string[] | undefined,
  currentEtag: string,
): boolean {
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (typeof raw !== "string" || raw.trim() === "") {
    return false;
  }
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (token === "*") {
      return true;
    }
    const opaque = token.replace(/^W\//i, "");
    if (opaque === currentEtag) {
      return true;
    }
  }
  return false;
}

export interface DeviceManifestResult {
  statusCode: 200 | 304;
  etag: string;
  version: string;
  /** Nur bei 200 gesetzt; 304 hat niemals einen Body. */
  body: Buffer | null;
}

export interface DeviceManifestServiceOptions {
  reader: DeviceManifestReader;
}

export class DeviceManifestService {
  private readonly reader: DeviceManifestReader;

  constructor(options: DeviceManifestServiceOptions) {
    this.reader = options.reader;
  }

  async getManifest(
    deviceId: string,
    ifNoneMatch: string | string[] | undefined,
  ): Promise<DeviceManifestResult> {
    const assignment = await this.reader.findAssignment(deviceId);
    if (assignment === null || !assignment.active) {
      throw ApiError.forbidden();
    }

    const artifact = await this.reader.getCurrentArtifact(assignment.taxiId);
    if (artifact === null) {
      throw ApiError.manifestNotReady();
    }

    const bytes = serializeManifestEnvelope(artifact.envelope);
    const etag = computeManifestEtag(bytes);
    const version = artifact.envelope.version;

    if (ifNoneMatchMatches(ifNoneMatch, etag)) {
      return { statusCode: 304, etag, version, body: null };
    }
    return { statusCode: 200, etag, version, body: bytes };
  }
}

export function createDeviceManifestService(
  options: DeviceManifestServiceOptions,
): DeviceManifestService {
  return new DeviceManifestService(options);
}


