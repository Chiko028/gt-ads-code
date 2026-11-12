/**
 * CX-008 / WP-210 (F-B06, F-A05, S-02): Signierte Download-Freigaben und
 * bytegenauer, fortsetzbarer Medienabruf.
 *
 * Der Dienst stellt zwei transportneutrale Operationen bereit:
 *   1. Ausstellen eines kurzlebigen URL-Query-Tickets.
 *   2. Bearbeiten eines Download-Auftrags als Status/Header/Bytes.
 *
 * Bewusst NICHT enthalten: HTTP-Route, Upload, Speicherung, Dateisystemzugriff
 * oder Client-Dateipfade. Medien werden ausschließlich über die mediaId aus
 * dem injizierten CX-005-Zugriff gelesen. Der geheime Schlüssel wird separat
 * injiziert und ist ausdrücklich nicht der Registrierungsschlüssel.
 *
 * Das Ticket ist kanonisches JSON in fester Feldreihenfolge, Base64url ohne
 * Padding, gefolgt von einem HMAC-SHA256 über
 * "gt-ads-download-v1\n<kodierte Nutzlast>". Die Signatur wird zeitkonstant
 * verglichen.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { decodeBase64Url } from "../../crypto/tokens.js";
import { computeContentDigest } from "../media/contentDigest.js";
import type { VerifiedManifest } from "./manifest.js";

/** Einzige unterstützte Schemaversion der Ticket-Nutzlast. */
export const DOWNLOAD_TICKET_SCHEMA_VERSION = 1 as const;

/** Domainpräfix der HMAC-Nachricht. */
export const DOWNLOAD_TICKET_DOMAIN_PREFIX = "gt-ads-download-v1";

/** Standard-Gültigkeitsdauer in Sekunden. */
export const DOWNLOAD_TICKET_DEFAULT_TTL_SECONDS = 300;

/** Kleinste zulässige Gültigkeitsdauer in Sekunden. */
export const DOWNLOAD_TICKET_MIN_TTL_SECONDS = 1;

/** Größte zulässige Gültigkeitsdauer in Sekunden. */
export const DOWNLOAD_TICKET_MAX_TTL_SECONDS = 900;

/** Mindestlänge des separat injizierten HMAC-Schlüssels in Byte. */
export const DOWNLOAD_MIN_SECRET_BYTES = 32;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const PAYLOAD_KEYS = [
  "schemaVersion",
  "deviceId",
  "taxiId",
  "manifestVersion",
  "mediaId",
  "sha256",
  "expiresAt",
] as const;

/** Stabile Fehlercodes der Download-Freigabe. */
export type DownloadErrorCode =
  | "invalid_input"
  | "invalid_secret"
  | "invalid_clock"
  | "invalid_device_id"
  | "invalid_taxi_id"
  | "invalid_manifest"
  | "invalid_manifest_version"
  | "invalid_media_id"
  | "invalid_sha256"
  | "invalid_ttl"
  | "invalid_expires_at"
  | "device_binding_not_authorized"
  | "media_not_in_manifest"
  | "inconsistent_manifest_media"
  | "invalid_ticket"
  | "invalid_ticket_encoding"
  | "invalid_payload"
  | "invalid_mac"
  | "expired_ticket"
  | "device_mismatch"
  | "authorization_unavailable"
  | "authorization_denied"
  | "media_not_found"
  | "media_unavailable"
  | "media_metadata_mismatch"
  | "digest_mismatch"
  | "size_mismatch"
  | "invalid_range"
  | "multiple_ranges"
  | "unsatisfiable_range";

/** Zusätzliche, maschinenlesbare Fehlerdetails ohne Token-/Query-Werte. */
export interface DownloadErrorDetails {
  field?: string;
}

/** Kontrollierter Fehler; niemals ein ungefangener Parser- oder Krypto-Fehler. */
export class DownloadError extends Error {
  readonly code: DownloadErrorCode;
  readonly details: DownloadErrorDetails;

  constructor(
    code: DownloadErrorCode,
    message: string,
    details: DownloadErrorDetails = {},
  ) {
    super(message);
    this.name = "DownloadError";
    this.code = code;
    this.details = details;
  }
}

function fail(
  code: DownloadErrorCode,
  message: string,
  details: DownloadErrorDetails = {},
): never {
  throw new DownloadError(code, message, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Injizierte Uhr. Zahlen werden als Unix-Sekunden oder -Millisekunden gelesen. */
export type DownloadClock = () => Date | number;

/** Vom Aufrufer explizit bestätigte Geräte-Taxi-Bindung. */
export interface DeviceTaxiBinding {
  deviceId: string;
  taxiId: string;
  authorized: boolean;
}

/** Kanonische Ticket-Nutzlast in fester Feldreihenfolge. */
export interface DownloadTicketPayload {
  schemaVersion: typeof DOWNLOAD_TICKET_SCHEMA_VERSION;
  deviceId: string;
  taxiId: string;
  manifestVersion: string;
  mediaId: string;
  sha256: string;
  expiresAt: number;
}

/** Ausgestelltes URL-Query-Ticket. */
export interface IssuedDownloadTicket {
  /** Token aus Nutzlast und MAC, getrennt durch einen Punkt. */
  ticket: string;
  /** Fertiger Query-Anteil "ticket=<token>" (URL-kodiert). */
  query: string;
  encodedPayload: string;
  mac: string;
  payload: DownloadTicketPayload;
}

/** Eingabe zum Ausstellen eines Tickets. */
export interface IssueDownloadTicketInput {
  deviceId: string;
  deviceTaxiBinding: DeviceTaxiBinding;
  /** Nur ein Ergebnis von verifySignedManifest (CX-007) ist zulässig. */
  manifest: VerifiedManifest;
  mediaId: string;
  /** Standard 300, zulässig 1 bis 900 Sekunden. */
  ttlSeconds?: number;
  /** Separat injizierter HMAC-Schlüssel, mindestens 32 Byte. */
  secret: Uint8Array | string;
  clock: DownloadClock;
}

/** Aktueller Zustand, den der Autorisierungsadapter bestätigen muss. */
export interface DownloadAuthorizationRequest {
  deviceId: string;
  taxiId: string;
  manifestVersion: string;
  mediaId: string;
  sha256: string;
}

/**
 * Injizierter Autorisierungsadapter. Er bestätigt bei jedem Abruf den
 * aktuellen Gerätezustand, die Taxi-Bindung und die Medienberechtigung für
 * das Manifest. Fehlt der Adapter, wird abgelehnt.
 */
export interface DownloadAuthorizationAdapter {
  authorize(
    request: DownloadAuthorizationRequest,
  ): boolean | Promise<boolean>;
}

/** Medieninhalt aus dem vorhandenen CX-005-Zugriff. */
export type DownloadMediaContent = Uint8Array | AsyncIterable<Uint8Array>;

/**
 * Vom CX-005-Zugriff gelieferter Medieneintrag. Nur die mediaId ist der
 * Zugriffsschlüssel; Pfade oder Client-Angaben werden nicht akzeptiert.
 */
export interface DownloadMediaRecord {
  sha256: string;
  sizeBytes: number;
  content: DownloadMediaContent;
}

/** Injizierter Medienzugriff (Port auf den vorhandenen CX-005-Zugriff). */
export interface DownloadMediaSource {
  read(mediaId: string): Promise<DownloadMediaRecord | null>;
}

/** Transportneutrales Ergebnis eines Download-Auftrags. */
export interface DownloadResult {
  status: number;
  headers: Record<string, string>;
  bytes: Uint8Array;
  /** Nur bei Fehlern gesetzt; enthält niemals Ticket- oder Query-Werte. */
  error?: DownloadErrorCode;
}

/** Eingabe zum Bearbeiten eines Download-Auftrags. */
export interface ProcessDownloadRequestInput {
  /** Token aus dem Query-Parameter, nicht der gesamte Query-String. */
  ticket: string;
  /** Bereits authentifiziertes Gerät des aktuellen Abrufs. */
  deviceId: string;
  secret: Uint8Array | string;
  clock: DownloadClock;
  authorization?: DownloadAuthorizationAdapter;
  mediaSource?: DownloadMediaSource;
  /** Wert des Range-Headers oder null/undefined. */
  rangeHeader?: string | null;
  /** Wert des If-Range-Headers oder null/undefined. */
  ifRangeHeader?: string | null;
}

/** Eingabe zum Prüfen eines Tickets. */
export interface VerifyDownloadTicketInput {
  ticket: string;
  secret: Uint8Array | string;
  clock: DownloadClock;
}

interface ClockReading {
  seconds: number;
}

function normalizeSecret(secret: unknown): Buffer {
  let bytes: Buffer;

  if (typeof secret === "string") {
    bytes = Buffer.from(secret, "utf8");
  } else if (secret instanceof Uint8Array) {
    bytes = Buffer.from(secret);
  } else {
    fail("invalid_secret", "Der HMAC-Schlüssel muss als Bytefolge vorliegen.");
  }

  if (bytes.byteLength < DOWNLOAD_MIN_SECRET_BYTES) {
    fail(
      "invalid_secret",
      `Der HMAC-Schlüssel muss mindestens ${DOWNLOAD_MIN_SECRET_BYTES} Byte besitzen.`,
    );
  }

  return bytes;
}

function readClock(clock: DownloadClock): ClockReading {
  if (typeof clock !== "function") {
    fail("invalid_clock", "Die Uhr muss als Funktion injiziert werden.");
  }

  const value = clock();
  let milliseconds: number;

  if (value instanceof Date) {
    milliseconds = value.getTime();
  } else if (typeof value === "number" && Number.isFinite(value)) {
    // Date.now() liefert Millisekunden; kleine Werte werden als Sekunden
    // interpretiert, damit beide üblichen injizierten Uhren funktionieren.
    milliseconds =
      value < 1_000_000_000_000 ? value * 1_000 : value;
  } else {
    fail("invalid_clock", "Die Uhr muss ein gültiges Datum liefern.");
  }

  if (!Number.isFinite(milliseconds) || Number.isNaN(milliseconds)) {
    fail("invalid_clock", "Die Uhr muss ein gültiges Datum liefern.");
  }

  const seconds = Math.floor(milliseconds / 1_000);
  if (!Number.isSafeInteger(seconds)) {
    fail("invalid_clock", "Die Uhr liefert keinen sicheren Unix-Zeitpunkt.");
  }

  return { seconds };
}

/**
 * Serialisiert ausschließlich das bekannte Schema in fester Feldreihenfolge
 * als UTF-8-JSON ohne Leerraum.
 */
export function serializeDownloadTicketPayload(
  payload: DownloadTicketPayload,
): string {
  return `{"schemaVersion":${payload.schemaVersion},"deviceId":${JSON.stringify(payload.deviceId)},"taxiId":${JSON.stringify(payload.taxiId)},"manifestVersion":${JSON.stringify(payload.manifestVersion)},"mediaId":${JSON.stringify(payload.mediaId)},"sha256":${JSON.stringify(payload.sha256)},"expiresAt":${payload.expiresAt}}`;
}

/** HMAC-Nachricht: Domainpräfix, Zeilenumbruch, kodierte Nutzlast. */
export function buildDownloadTicketMacMessage(encodedPayload: string): string {
  return `${DOWNLOAD_TICKET_DOMAIN_PREFIX}\n${encodedPayload}`;
}

function computeMac(encodedPayload: string, secret: Buffer): Buffer {
  return createHmac("sha256", secret)
    .update(buildDownloadTicketMacMessage(encodedPayload), "utf8")
    .digest();
}

function resolveTtl(value: unknown): number {
  if (value === undefined) {
    return DOWNLOAD_TICKET_DEFAULT_TTL_SECONDS;
  }

  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < DOWNLOAD_TICKET_MIN_TTL_SECONDS ||
    value > DOWNLOAD_TICKET_MAX_TTL_SECONDS
  ) {
    fail(
      "invalid_ttl",
      `ttlSeconds muss eine ganze Zahl zwischen ${DOWNLOAD_TICKET_MIN_TTL_SECONDS} und ${DOWNLOAD_TICKET_MAX_TTL_SECONDS} sein.`,
      { field: "ttlSeconds" },
    );
  }

  return value;
}

interface ManifestMedia {
  sha256: string;
  sizeBytes: number;
}

function findManifestMedia(
  manifest: VerifiedManifest,
  mediaId: string,
): ManifestMedia {
  if (!isRecord(manifest) || !isRecord(manifest.plan)) {
    fail("invalid_manifest", "Es muss ein geprüftes Manifest übergeben werden.", {
      field: "manifest",
    });
  }

  if (
    typeof manifest.version !== "string" ||
    !SHA256_PATTERN.test(manifest.version)
  ) {
    fail(
      "invalid_manifest_version",
      "Die Manifestversion muss ein SHA-256 in Kleinschreibung sein.",
      { field: "manifest.version" },
    );
  }

  const plan = manifest.plan as unknown as Record<string, unknown>;
  if (!isNonEmptyText(plan.taxiId)) {
    fail("invalid_taxi_id", "Der Manifestplan benötigt eine gültige Taxi-ID.", {
      field: "manifest.plan.taxiId",
    });
  }

  if (!Array.isArray(plan.spots)) {
    fail("invalid_manifest", "Der Manifestplan benötigt eine Spotliste.", {
      field: "manifest.plan.spots",
    });
  }

  let found: ManifestMedia | null = null;

  for (const spot of plan.spots) {
    if (!isRecord(spot) || spot.mediaId !== mediaId) {
      continue;
    }

    if (typeof spot.sha256 !== "string" || !SHA256_PATTERN.test(spot.sha256)) {
      fail(
        "invalid_manifest",
        "Der Manifesteintrag enthält keinen gültigen SHA-256.",
        { field: "manifest.plan.spots.sha256" },
      );
    }

    if (
      typeof spot.sizeBytes !== "number" ||
      !Number.isSafeInteger(spot.sizeBytes) ||
      spot.sizeBytes <= 0
    ) {
      fail(
        "invalid_manifest",
        "Der Manifesteintrag enthält keine positive Byteanzahl.",
        { field: "manifest.plan.spots.sizeBytes" },
      );
    }

    const candidate: ManifestMedia = {
      sha256: spot.sha256,
      sizeBytes: spot.sizeBytes,
    };

    if (
      found !== null &&
      (found.sha256 !== candidate.sha256 ||
        found.sizeBytes !== candidate.sizeBytes)
    ) {
      fail(
        "inconsistent_manifest_media",
        "Dasselbe Medium ist im Manifest mit widersprüchlichen Metadaten enthalten.",
        { field: "manifest.plan.spots" },
      );
    }

    found = candidate;
  }

  if (found === null) {
    fail(
      "media_not_in_manifest",
      "Die mediaId ist nicht Teil des autorisierten Manifests.",
      { field: "mediaId" },
    );
  }

  return found;
}

/**
 * Stellt ein kurzlebiges Download-Ticket aus.
 *
 * Voraussetzungen sind ein bereits über CX-007 geprüftes Manifest und eine
 * ausdrücklich autorisierte Geräte-Taxi-Bindung. Das Medium muss im Manifest
 * enthalten sein; sein SHA-256 wird ausschließlich von dort übernommen.
 */
export function issueDownloadTicket(
  input: IssueDownloadTicketInput,
): IssuedDownloadTicket {
  if (!isRecord(input)) {
    fail("invalid_input", "Die Eingabe muss als Objekt vorliegen.");
  }

  const secret = normalizeSecret(input.secret);
  const clock = readClock(input.clock);

  if (!isNonEmptyText(input.deviceId)) {
    fail("invalid_device_id", "Die Geräte-ID muss ein nicht leerer Text sein.", {
      field: "deviceId",
    });
  }

  if (!isNonEmptyText(input.mediaId)) {
    fail("invalid_media_id", "Die Medien-ID muss ein nicht leerer Text sein.", {
      field: "mediaId",
    });
  }

  const manifestMedia = findManifestMedia(input.manifest, input.mediaId);
  const manifestTaxiId = input.manifest.plan.taxiId;

  const binding = input.deviceTaxiBinding;
  if (
    !isRecord(binding) ||
    binding.authorized !== true ||
    binding.deviceId !== input.deviceId ||
    binding.taxiId !== manifestTaxiId
  ) {
    fail(
      "device_binding_not_authorized",
      "Die Geräte-Taxi-Bindung ist nicht ausdrücklich autorisiert.",
      { field: "deviceTaxiBinding" },
    );
  }

  const ttlSeconds = resolveTtl(input.ttlSeconds);
  const expiresAt = clock.seconds + ttlSeconds;

  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    fail("invalid_expires_at", "Der Ablaufzeitpunkt ist nicht darstellbar.", {
      field: "expiresAt",
    });
  }

  const payload: DownloadTicketPayload = {
    schemaVersion: DOWNLOAD_TICKET_SCHEMA_VERSION,
    deviceId: input.deviceId,
    taxiId: manifestTaxiId,
    manifestVersion: input.manifest.version,
    mediaId: input.mediaId,
    sha256: manifestMedia.sha256,
    expiresAt,
  };

  const encodedPayload = Buffer.from(
    serializeDownloadTicketPayload(payload),
    "utf8",
  ).toString("base64url");
  const mac = computeMac(encodedPayload, secret).toString("base64url");
  const ticket = `${encodedPayload}.${mac}`;

  return {
    ticket,
    query: `ticket=${encodeURIComponent(ticket)}`,
    encodedPayload,
    mac,
    payload,
  };
}

function parseTicketPayload(payloadText: string): DownloadTicketPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    fail("invalid_payload", "Die Ticket-Nutzlast ist kein gültiges JSON.");
  }

  if (!isRecord(parsed)) {
    fail("invalid_payload", "Die Ticket-Nutzlast muss ein Objekt sein.");
  }

  const actualKeys = Object.keys(parsed);
  if (
    actualKeys.length !== PAYLOAD_KEYS.length ||
    PAYLOAD_KEYS.some(
      (key, index) =>
        actualKeys[index] !== key ||
        !Object.prototype.hasOwnProperty.call(parsed, key),
    )
  ) {
    fail(
      "invalid_payload",
      "Die Ticket-Nutzlast entspricht nicht dem festen Schema.",
    );
  }

  if (parsed.schemaVersion !== DOWNLOAD_TICKET_SCHEMA_VERSION) {
    fail(
      "invalid_payload",
      `Die Ticket-Schemaversion muss ${DOWNLOAD_TICKET_SCHEMA_VERSION} sein.`,
      { field: "schemaVersion" },
    );
  }

  if (!isNonEmptyText(parsed.deviceId)) {
    fail("invalid_payload", "Die Ticket-Nutzlast benötigt eine Geräte-ID.", {
      field: "deviceId",
    });
  }

  if (!isNonEmptyText(parsed.taxiId)) {
    fail("invalid_payload", "Die Ticket-Nutzlast benötigt eine Taxi-ID.", {
      field: "taxiId",
    });
  }

  if (
    typeof parsed.manifestVersion !== "string" ||
    !SHA256_PATTERN.test(parsed.manifestVersion)
  ) {
    fail(
      "invalid_payload",
      "Die Manifestversion muss ein SHA-256 in Kleinschreibung sein.",
      { field: "manifestVersion" },
    );
  }

  if (!isNonEmptyText(parsed.mediaId)) {
    fail("invalid_payload", "Die Ticket-Nutzlast benötigt eine Medien-ID.", {
      field: "mediaId",
    });
  }

  if (typeof parsed.sha256 !== "string" || !SHA256_PATTERN.test(parsed.sha256)) {
    fail(
      "invalid_payload",
      "Der Medienhash muss ein SHA-256 in Kleinschreibung sein.",
      { field: "sha256" },
    );
  }

  if (
    typeof parsed.expiresAt !== "number" ||
    !Number.isSafeInteger(parsed.expiresAt) ||
    parsed.expiresAt <= 0
  ) {
    fail(
      "invalid_payload",
      "expiresAt muss eine positive ganze Unixsekunde sein.",
      { field: "expiresAt" },
    );
  }

  return {
    schemaVersion: DOWNLOAD_TICKET_SCHEMA_VERSION,
    deviceId: parsed.deviceId,
    taxiId: parsed.taxiId,
    manifestVersion: parsed.manifestVersion,
    mediaId: parsed.mediaId,
    sha256: parsed.sha256,
    expiresAt: parsed.expiresAt,
  };
}

/**
 * Prüft Ticket-Syntax, kanonische Serialisierung, MAC und Ablauf.
 * Gültig ist ein Ticket ausschließlich bei now < expiresAt.
 */
export function verifyDownloadTicket(
  input: VerifyDownloadTicketInput,
): DownloadTicketPayload {
  if (!isRecord(input)) {
    fail("invalid_input", "Die Eingabe muss als Objekt vorliegen.");
  }

  const secret = normalizeSecret(input.secret);
  const clock = readClock(input.clock);

  if (typeof input.ticket !== "string" || input.ticket.length === 0) {
    fail("invalid_ticket", "Das Ticket muss ein nicht leerer Text sein.");
  }

  const parts = input.ticket.split(".");
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    fail("invalid_ticket", "Das Ticket hat nicht das Format Nutzlast.MAC.");
  }

  const encodedPayload = parts[0];
  const encodedMac = parts[1];
  const payloadBytes = decodeBase64Url(encodedPayload);
  if (payloadBytes === null) {
    fail(
      "invalid_ticket_encoding",
      "Die kodierte Nutzlast ist kein kanonisches Base64url.",
    );
  }

  const providedMac = decodeBase64Url(encodedMac);
  if (providedMac === null) {
    fail(
      "invalid_ticket_encoding",
      "Der MAC ist kein kanonisches Base64url.",
    );
  }

  const expectedMac = computeMac(encodedPayload, secret);
  if (
    providedMac.length !== expectedMac.length ||
    !timingSafeEqual(providedMac, expectedMac)
  ) {
    fail("invalid_mac", "Der MAC des Tickets ist ungültig.");
  }

  let payloadText: string;
  try {
    payloadText = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
  } catch {
    fail("invalid_payload", "Die Ticket-Nutzlast ist kein gültiges UTF-8.");
  }

  const payload = parseTicketPayload(payloadText);

  // Erzwingt exakt die ausgestellte Feldreihenfolge und Schreibweise.
  if (serializeDownloadTicketPayload(payload) !== payloadText) {
    fail(
      "invalid_payload",
      "Die Ticket-Nutzlast ist nicht kanonisch serialisiert.",
    );
  }

  if (clock.seconds >= payload.expiresAt) {
    fail("expired_ticket", "Das Ticket ist abgelaufen.", {
      field: "expiresAt",
    });
  }

  return payload;
}

function reject(
  status: number,
  code: DownloadErrorCode,
  headers: Record<string, string> = {},
): DownloadResult {
  return { status, headers, bytes: new Uint8Array(0), error: code };
}

async function collectContent(
  content: DownloadMediaContent,
): Promise<Uint8Array> {
  if (content instanceof Uint8Array) {
    return Uint8Array.from(content);
  }

  if (
    typeof content === "object" &&
    content !== null &&
    typeof (content as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] ===
      "function"
  ) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of content as AsyncIterable<Uint8Array>) {
      if (!(chunk instanceof Uint8Array)) {
        fail("media_unavailable", "Der Medienstream lieferte ungültige Bytes.");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  fail("media_unavailable", "Der Medienzugriff lieferte keinen gültigen Inhalt.");
}

async function computeDigestOf(
  bytes: Uint8Array,
): Promise<{ sha256: string; sizeBytes: number }> {
  const source = (async function* (): AsyncIterable<Uint8Array> {
    yield bytes;
  })();
  return computeContentDigest(source);
}

interface ByteRange {
  start: number;
  end: number;
}

type RangeParseResult =
  | { kind: "none" }
  | { kind: "range"; range: ByteRange }
  | { kind: "invalid"; code: "invalid_range" | "multiple_ranges" }
  | { kind: "unsatisfiable" };

function parseRangeHeader(
  header: string | null | undefined,
  sizeBytes: number,
): RangeParseResult {
  if (header === null || header === undefined) {
    return { kind: "none" };
  }

  const trimmed = header.trim();
  if (trimmed.length === 0) {
    return { kind: "invalid", code: "invalid_range" };
  }

  const match = /^bytes=(.*)$/i.exec(trimmed);
  if (match === null) {
    return { kind: "invalid", code: "invalid_range" };
  }

  const spec = match[1].trim();
  if (spec.includes(",")) {
    return { kind: "invalid", code: "multiple_ranges" };
  }

  if (!/^\d*-\d*$/.test(spec)) {
    return { kind: "invalid", code: "invalid_range" };
  }

  const dash = spec.indexOf("-");
  const left = spec.slice(0, dash);
  const right = spec.slice(dash + 1);

  if (left.length === 0 && right.length === 0) {
    return { kind: "invalid", code: "invalid_range" };
  }

  if (left.length === 0) {
    const suffix = Number(right);
    if (!Number.isSafeInteger(suffix)) {
      return { kind: "invalid", code: "invalid_range" };
    }
    if (suffix <= 0 || sizeBytes === 0) {
      return { kind: "unsatisfiable" };
    }
    return {
      kind: "range",
      range: {
        start: Math.max(sizeBytes - suffix, 0),
        end: sizeBytes - 1,
      },
    };
  }

  const start = Number(left);
  if (!Number.isSafeInteger(start)) {
    return { kind: "invalid", code: "invalid_range" };
  }

  if (right.length === 0) {
    if (start >= sizeBytes) {
      return { kind: "unsatisfiable" };
    }
    return { kind: "range", range: { start, end: sizeBytes - 1 } };
  }

  const end = Number(right);
  if (!Number.isSafeInteger(end) || end < start) {
    return { kind: "invalid", code: "invalid_range" };
  }

  if (start >= sizeBytes) {
    return { kind: "unsatisfiable" };
  }

  return {
    kind: "range",
    range: { start, end: Math.min(end, sizeBytes - 1) },
  };
}

function etagFor(sha256: string): string {
  return `"${sha256}"`;
}

/**
 * Bearbeitet einen Download-Auftrag.
 *
 * Fehler führen immer zu einem Ergebnis ohne Bytes. Erfolgreiche Antworten
 * tragen ETag, Accept-Ranges und Content-Length; 206 zusätzlich Content-Range.
 * Range-Syntaxfehler und Mehrfachbereiche ergeben 400, nicht erfüllbare
 * Bereiche 416 mit "bytes *​/N". If-Range wird nur als exakter starker
 * ETag-Vergleich ausgewertet; jeder andere Wert liefert die ganze Datei.
 */
export async function processDownloadRequest(
  input: ProcessDownloadRequestInput,
): Promise<DownloadResult> {
  if (!isRecord(input)) {
    return reject(400, "invalid_input");
  }

  let payload: DownloadTicketPayload;
  try {
    payload = verifyDownloadTicket({
      ticket: input.ticket,
      secret: input.secret,
      clock: input.clock,
    });
  } catch (error) {
    if (error instanceof DownloadError) {
      return reject(403, error.code);
    }
    return reject(500, "invalid_input");
  }

  if (input.deviceId !== payload.deviceId) {
    return reject(403, "device_mismatch");
  }

  const authorization = input.authorization;
  if (
    authorization === undefined ||
    typeof authorization.authorize !== "function"
  ) {
    return reject(403, "authorization_unavailable");
  }

  try {
    const allowed = await authorization.authorize({
      deviceId: payload.deviceId,
      taxiId: payload.taxiId,
      manifestVersion: payload.manifestVersion,
      mediaId: payload.mediaId,
      sha256: payload.sha256,
    });
    if (allowed !== true) {
      return reject(403, "authorization_denied");
    }
  } catch {
    return reject(403, "authorization_denied");
  }

  const mediaSource = input.mediaSource;
  if (mediaSource === undefined || typeof mediaSource.read !== "function") {
    return reject(404, "media_unavailable");
  }

  let record: DownloadMediaRecord | null;
  try {
    record = await mediaSource.read(payload.mediaId);
  } catch {
    return reject(500, "media_unavailable");
  }

  if (record === null || record === undefined) {
    return reject(404, "media_not_found");
  }

  if (
    !isRecord(record) ||
    typeof record.sha256 !== "string" ||
    !SHA256_PATTERN.test(record.sha256) ||
    typeof record.sizeBytes !== "number" ||
    !Number.isSafeInteger(record.sizeBytes) ||
    record.sizeBytes < 0
  ) {
    return reject(500, "media_unavailable");
  }

  if (record.sha256 !== payload.sha256) {
    return reject(409, "media_metadata_mismatch");
  }

  let bytes: Uint8Array;
  try {
    bytes = await collectContent(record.content);
  } catch (error) {
    if (error instanceof DownloadError) {
      return reject(500, error.code);
    }
    return reject(500, "media_unavailable");
  }

  let digest: { sha256: string; sizeBytes: number };
  try {
    digest = await computeDigestOf(bytes);
  } catch {
    return reject(500, "media_unavailable");
  }

  if (digest.sizeBytes !== record.sizeBytes) {
    return reject(409, "size_mismatch");
  }

  if (digest.sha256 !== record.sha256 || digest.sha256 !== payload.sha256) {
    return reject(409, "digest_mismatch");
  }

  const sizeBytes = digest.sizeBytes;
  const etag = etagFor(digest.sha256);
  const rangeHeader = input.rangeHeader;
  const ifRangeHeader = input.ifRangeHeader;

  let range: ByteRange | null = null;
  if (rangeHeader !== null && rangeHeader !== undefined) {
    const ifRange = ifRangeHeader?.trim();
    const rangeIsAllowed =
      ifRange === undefined || ifRange === etag;

    if (rangeIsAllowed) {
      const parsed = parseRangeHeader(rangeHeader, sizeBytes);

      if (parsed.kind === "invalid") {
        return reject(400, parsed.code);
      }

      if (parsed.kind === "unsatisfiable") {
        return reject(416, "unsatisfiable_range", {
          "Content-Range": `bytes */${sizeBytes}`,
          "Content-Length": "0",
        });
      }

      if (parsed.kind === "range") {
        range = parsed.range;
      }
    }
  }

  if (range === null) {
    return {
      status: 200,
      headers: {
        ETag: etag,
        "Accept-Ranges": "bytes",
        "Content-Length": String(sizeBytes),
      },
      bytes: Uint8Array.from(bytes),
    };
  }

  const length = range.end - range.start + 1;
  return {
    status: 206,
    headers: {
      ETag: etag,
      "Accept-Ranges": "bytes",
      "Content-Length": String(length),
      "Content-Range": `bytes ${range.start}-${range.end}/${sizeBytes}`,
    },
    bytes: Uint8Array.from(bytes.subarray(range.start, range.end + 1)),
  };
}

