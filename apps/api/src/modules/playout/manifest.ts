/**
 * CX-007 / GT-ADS-003 (F-B05, F-A07, C-02): Unveränderliche, signierte
 * Manifest-Artefakte.
 *
 * Der Dienst erzeugt aus einem bereits validierten Schleifenplan (CX-006) eine
 * reproduzierbare, inhaltsadressierte Manifest-Nutzlast und signiert sie mit
 * ECDSA P-256/SHA-256 (DER). Er prüft außerdem Signatur, Schlüsselkennung,
 * Taxi- und Umgebungsbindung, bevor er einen nutzbaren Plan zurückgibt.
 *
 * Bewusst NICHT enthalten: Speicherung, HTTP-Route, Schlüsselverteilung,
 * Installation von Schlüsseln, Geräteschlüssel, Zeitstempel oder kurzlebige
 * URLs in der Nutzlast.
 */

import { createHash, sign, verify, type KeyObject } from "node:crypto";
import { buildLoopPlan } from "./planner.js";
import {
  LoopPlanError,
  type LoopPlan,
  type LoopPlanCampaign,
  type LoopPlanPlacement,
} from "./types.js";

/** Einzige unterstützte Schemaversion von Nutzlast und Envelope. */
export const MANIFEST_SCHEMA_VERSION = 1;

/** Präfix der zu signierenden Nachricht. */
export const MANIFEST_SIGNATURE_PREFIX = "gt-ads-manifest-v1";

/** Obergrenze der dekodierten Nutzlast: 64 KiB. */
export const MANIFEST_MAX_PAYLOAD_BYTES = 64 * 1024;

/** Zulässige Umgebungen der Nutzlast. */
export const MANIFEST_ENVIRONMENTS = ["dev", "test"] as const;

export type ManifestEnvironment = (typeof MANIFEST_ENVIRONMENTS)[number];

const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const PAYLOAD_KEYS = [
  "schemaVersion",
  "environment",
  "taxiId",
  "slotCount",
  "entries",
] as const;

const ENTRY_KEYS = [
  "mediaId",
  "sha256",
  "sizeBytes",
  "durationMs",
  "campaignId",
  "startAt",
  "endAt",
] as const;

const ENVELOPE_KEYS = [
  "schemaVersion",
  "keyId",
  "version",
  "payloadBase64",
  "signatureBase64",
] as const;

/** Stabile Fehlercodes des Manifest-Dienstes. */
export type ManifestErrorCode =
  | "invalid_input"
  | "invalid_environment"
  | "invalid_taxi_id"
  | "invalid_key_id"
  | "invalid_signing_key"
  | "invalid_envelope"
  | "invalid_schema_version"
  | "invalid_version"
  | "invalid_payload_base64"
  | "invalid_signature_base64"
  | "payload_too_large"
  | "invalid_payload_json"
  | "invalid_payload"
  | "payload_version_mismatch"
  | "unknown_key_id"
  | "invalid_signature"
  | "taxi_mismatch"
  | "environment_mismatch"
  | "invalid_plan";

/** Zusätzliche, maschinenlesbare Fehlerdetails. */
export interface ManifestErrorDetails {
  field?: string;
  causeCode?: string;
  sizeBytes?: number;
}

/** Kontrollierter Fehler; niemals ein ungefangener Parser- oder Krypto-Fehler. */
export class ManifestError extends Error {
  readonly code: ManifestErrorCode;
  readonly details: ManifestErrorDetails;

  constructor(
    code: ManifestErrorCode,
    message: string,
    details: ManifestErrorDetails = {},
  ) {
    super(message);
    this.name = "ManifestError";
    this.code = code;
    this.details = details;
  }
}

/** Ein Eintrag der Manifest-Nutzlast in fester Feldreihenfolge. */
export interface ManifestEntry {
  mediaId: string;
  sha256: string;
  sizeBytes: number;
  durationMs: number;
  campaignId: string;
  startAt: string;
  endAt: string;
}

/** Signierte Nutzlast; ausschließlich dieses bekannte Schema wird serialisiert. */
export interface ManifestPayload {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  environment: ManifestEnvironment;
  taxiId: string;
  slotCount: number;
  entries: ManifestEntry[];
}

/** Signierter Envelope. */
export interface SignedManifestEnvelope {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  keyId: string;
  version: string;
  payloadBase64: string;
  signatureBase64: string;
}

/** Eingabe zum Signieren; Schlüssel werden injiziert. */
export interface CreateSignedManifestInput {
  plan: LoopPlan;
  environment: ManifestEnvironment;
  keyId: string;
  signingKey: KeyObject;
}

/** Vom Aufrufer erwartete Bindung und vertrauenswürdige öffentliche Schlüssel. */
export interface VerifySignedManifestExpectations {
  taxiId: string;
  environment: ManifestEnvironment;
  trustedKeys: ReadonlyMap<string, KeyObject>;
}

/** Ergebnis einer erfolgreichen Prüfung. */
export interface VerifiedManifest {
  plan: LoopPlan;
  version: string;
  keyId: string;
  environment: ManifestEnvironment;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isManifestEnvironment(value: unknown): value is ManifestEnvironment {
  return (
    typeof value === "string" &&
    (MANIFEST_ENVIRONMENTS as readonly string[]).includes(value)
  );
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function fail(
  code: ManifestErrorCode,
  message: string,
  details: ManifestErrorDetails = {},
): never {
  throw new ManifestError(code, message, details);
}

/**
 * Strikte Base64-Prüfung: Standardalphabet, korrektes Padding und
 * kanonische Rekodierung. Kein stilles Akzeptieren von URL-safe oder
 * abgeschnittenen Eingaben.
 */
function decodeBase64Strict(value: unknown): Buffer | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !BASE64_PATTERN.test(value)
  ) {
    return null;
  }

  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    return null;
  }

  return decoded;
}

/** SHA-256 über exakt die übergebenen Bytes, klein geschriebene Hex-Version. */
function hashPayload(payloadBytes: Buffer): string {
  return createHash("sha256").update(payloadBytes).digest("hex");
}

/**
 * Signaturnachricht exakt nach Entwurf:
 * "gt-ads-manifest-v1\n<keyId>\n<version>\n<payloadBase64>"
 * ohne abschließenden Zeilenumbruch.
 */
export function buildManifestSignatureMessage(
  keyId: string,
  version: string,
  payloadBase64: string,
): string {
  return [MANIFEST_SIGNATURE_PREFIX, keyId, version, payloadBase64].join("\n");
}

function assertValidSigningKey(value: unknown): KeyObject {
  if (typeof value !== "object" || value === null) {
    fail("invalid_signing_key", "Der Signierschlüssel muss ein KeyObject sein.");
  }

  const key = value as KeyObject;
  if (
    key.type !== "private" ||
    key.asymmetricKeyType !== "ec" ||
    key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    fail(
      "invalid_signing_key",
      "Der Signierschlüssel muss ein privater EC-Schlüssel der Kurve prime256v1 sein.",
    );
  }

  return key;
}

function assertValidPublicKey(key: KeyObject): boolean {
  return (
    key.type === "public" &&
    key.asymmetricKeyType === "ec" &&
    key.asymmetricKeyDetails?.namedCurve === "prime256v1"
  );
}

/**
 * Serialisiert ausschließlich das bekannte Schema mit fester Feldreihenfolge
 * als UTF-8-JSON ohne Leerraum. Es wird kein beliebiges Objekt kanonisiert.
 */
function serializePayload(payload: ManifestPayload): string {
  const entries = payload.entries
    .map(
      (entry) =>
        `{"mediaId":${JSON.stringify(entry.mediaId)},"sha256":${JSON.stringify(entry.sha256)},"sizeBytes":${entry.sizeBytes},"durationMs":${entry.durationMs},"campaignId":${JSON.stringify(entry.campaignId)},"startAt":${JSON.stringify(entry.startAt)},"endAt":${JSON.stringify(entry.endAt)}}`,
    )
    .join(",");

  return `{"schemaVersion":${payload.schemaVersion},"environment":${JSON.stringify(payload.environment)},"taxiId":${JSON.stringify(payload.taxiId)},"slotCount":${payload.slotCount},"entries":[${entries}]}`;
}

/**
 * Validiert einen CX-006-Plan erneut über die vorhandene Planvalidierung
 * (buildLoopPlan) und liefert die kanonische, nach Position sortierte Form.
 *
 * Die Kampagnen werden aus den Spots rekonstruiert; wiederholte Kampagnen
 * müssen dasselbe Laufzeitfenster tragen. Status und Zuordnung sind aus dem
 * bereits erzeugten Plan abgeleitet und werden nicht neu erfunden.
 */
function normalizePlanForSigning(plan: unknown): LoopPlan {
  if (!isRecord(plan)) {
    fail("invalid_plan", "Der Plan muss als Objekt vorliegen.", {
      field: "plan",
    });
  }

  if (!isNonEmptyText(plan.taxiId)) {
    fail("invalid_plan", "Der Plan benötigt eine nicht leere Taxi-ID.", {
      field: "plan.taxiId",
    });
  }

  if (!Array.isArray(plan.spots)) {
    fail("invalid_plan", "Der Plan benötigt eine Liste von Spots.", {
      field: "plan.spots",
    });
  }

  const campaigns = new Map<string, LoopPlanCampaign>();
  const placements: LoopPlanPlacement[] = [];

  for (const candidate of plan.spots) {
    if (!isRecord(candidate)) {
      fail("invalid_plan", "Jeder Spot muss als Objekt vorliegen.", {
        field: "plan.spots",
      });
    }

    if (!isNonEmptyText(candidate.campaignId)) {
      fail("invalid_plan", "Jeder Spot benötigt eine campaignId.", {
        field: "plan.spots.campaignId",
      });
    }

    const startAt = candidate.startAt;
    const endAt = candidate.endAt;
    const existing = campaigns.get(candidate.campaignId);

    if (existing !== undefined) {
      if (existing.startAt !== startAt || existing.endAt !== endAt) {
        fail(
          "invalid_plan",
          `Die Kampagne "${candidate.campaignId}" hat innerhalb des Plans unterschiedliche Laufzeitfenster.`,
          { field: "plan.spots", causeCode: "inconsistent_runtime_window" },
        );
      }
    } else {
      campaigns.set(candidate.campaignId, {
        campaignId: candidate.campaignId,
        status: "active",
        startAt: startAt as string,
        endAt: endAt as string,
        targetTaxiIds: [plan.taxiId],
        targetGroupIds: [],
      });
    }

    placements.push({
      position: candidate.position as number,
      campaignId: candidate.campaignId,
      media: {
        mediaId: candidate.mediaId as string,
        sha256: candidate.sha256 as string,
        sizeBytes: candidate.sizeBytes as number,
        durationMs: candidate.durationMs as number,
      },
    });
  }

  try {
    return buildLoopPlan({
      taxiId: plan.taxiId,
      groupIds: [],
      slotCount: plan.slotCount as number,
      campaigns: [...campaigns.values()],
      placements,
    });
  } catch (error) {
    if (error instanceof LoopPlanError) {
      fail("invalid_plan", error.message, { causeCode: error.code });
    }
    throw error;
  }
}

function toManifestPayload(
  plan: LoopPlan,
  environment: ManifestEnvironment,
): ManifestPayload {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    environment,
    taxiId: plan.taxiId,
    slotCount: plan.slotCount,
    entries: plan.spots.map((spot) => ({
      mediaId: spot.mediaId,
      sha256: spot.sha256,
      sizeBytes: spot.sizeBytes,
      durationMs: spot.durationMs,
      campaignId: spot.campaignId,
      startAt: spot.startAt,
      endAt: spot.endAt,
    })),
  };
}

function parsePayload(payloadBytes: Buffer): ManifestPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    fail("invalid_payload_json", "Die Nutzlast ist kein gültiges JSON.");
  }

  if (!isRecord(parsed) || !hasExactKeys(parsed, PAYLOAD_KEYS)) {
    fail("invalid_payload", "Die Nutzlast entspricht nicht dem bekannten Schema.", {
      field: "payload",
    });
  }

  if (parsed.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    fail(
      "invalid_schema_version",
      `Die Nutzlast verwendet eine unbekannte Schemaversion (erwartet ${MANIFEST_SCHEMA_VERSION}).`,
      { field: "payload.schemaVersion" },
    );
  }

  if (!isManifestEnvironment(parsed.environment)) {
    fail("invalid_payload", 'environment muss "dev" oder "test" sein.', {
      field: "payload.environment",
    });
  }

  if (!isNonEmptyText(parsed.taxiId)) {
    fail("invalid_payload", "Die Nutzlast benötigt eine nicht leere Taxi-ID.", {
      field: "payload.taxiId",
    });
  }

  if (
    typeof parsed.slotCount !== "number" ||
    !Number.isSafeInteger(parsed.slotCount)
  ) {
    fail("invalid_payload", "slotCount muss eine ganze Zahl sein.", {
      field: "payload.slotCount",
    });
  }

  if (!Array.isArray(parsed.entries)) {
    fail("invalid_payload", "entries muss eine Liste sein.", {
      field: "payload.entries",
    });
  }

  const entries: ManifestEntry[] = parsed.entries.map((candidate, index) => {
    if (!isRecord(candidate) || !hasExactKeys(candidate, ENTRY_KEYS)) {
      fail(
        "invalid_payload",
        `Der Eintrag an Index ${index} entspricht nicht dem bekannten Schema.`,
        { field: `payload.entries[${index}]` },
      );
    }

    if (!isNonEmptyText(candidate.mediaId)) {
      fail("invalid_payload", `Eintrag ${index} benötigt eine mediaId.`, {
        field: `payload.entries[${index}].mediaId`,
      });
    }

    if (typeof candidate.sha256 !== "string") {
      fail("invalid_payload", `Eintrag ${index} benötigt ein sha256.`, {
        field: `payload.entries[${index}].sha256`,
      });
    }

    if (typeof candidate.sizeBytes !== "number") {
      fail("invalid_payload", `Eintrag ${index} benötigt sizeBytes.`, {
        field: `payload.entries[${index}].sizeBytes`,
      });
    }

    if (typeof candidate.durationMs !== "number") {
      fail("invalid_payload", `Eintrag ${index} benötigt durationMs.`, {
        field: `payload.entries[${index}].durationMs`,
      });
    }

    if (!isNonEmptyText(candidate.campaignId)) {
      fail("invalid_payload", `Eintrag ${index} benötigt eine campaignId.`, {
        field: `payload.entries[${index}].campaignId`,
      });
    }

    if (typeof candidate.startAt !== "string") {
      fail("invalid_payload", `Eintrag ${index} benötigt startAt.`, {
        field: `payload.entries[${index}].startAt`,
      });
    }

    if (typeof candidate.endAt !== "string") {
      fail("invalid_payload", `Eintrag ${index} benötigt endAt.`, {
        field: `payload.entries[${index}].endAt`,
      });
    }

    return {
      mediaId: candidate.mediaId,
      sha256: candidate.sha256,
      sizeBytes: candidate.sizeBytes,
      durationMs: candidate.durationMs,
      campaignId: candidate.campaignId,
      startAt: candidate.startAt,
      endAt: candidate.endAt,
    };
  });

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    environment: parsed.environment,
    taxiId: parsed.taxiId,
    slotCount: parsed.slotCount,
    entries,
  };
}

/**
 * Rekonstruiert aus der geprüften Nutzlast die Plan-Eingabe und validiert sie
 * erneut über CX-006. Die Position ergibt sich ausschließlich aus der
 * Reihenfolge der Einträge.
 */
function buildPlanFromPayload(payload: ManifestPayload): LoopPlan {
  if (payload.entries.length !== payload.slotCount) {
    throw new LoopPlanError(
      "invalid_position",
      "Die Anzahl der Einträge muss slotCount entsprechen.",
    );
  }

  const campaigns = new Map<string, LoopPlanCampaign>();
  const placements: LoopPlanPlacement[] = [];

  payload.entries.forEach((entry, index) => {
    const existing = campaigns.get(entry.campaignId);
    if (existing !== undefined) {
      if (existing.startAt !== entry.startAt || existing.endAt !== entry.endAt) {
        throw new LoopPlanError(
          "invalid_campaign",
          `Die Kampagne "${entry.campaignId}" hat innerhalb der Nutzlast unterschiedliche Laufzeitfenster.`,
          { campaignId: entry.campaignId },
        );
      }
    } else {
      campaigns.set(entry.campaignId, {
        campaignId: entry.campaignId,
        status: "active",
        startAt: entry.startAt,
        endAt: entry.endAt,
        targetTaxiIds: [payload.taxiId],
        targetGroupIds: [],
      });
    }

    placements.push({
      position: index + 1,
      campaignId: entry.campaignId,
      media: {
        mediaId: entry.mediaId,
        sha256: entry.sha256,
        sizeBytes: entry.sizeBytes,
        durationMs: entry.durationMs,
      },
    });
  });

  return buildLoopPlan({
    taxiId: payload.taxiId,
    groupIds: [],
    slotCount: payload.slotCount,
    campaigns: [...campaigns.values()],
    placements,
  });
}

interface ParsedEnvelope {
  keyId: string;
  version: string;
  payloadBytes: Buffer;
  payloadBase64: string;
  signatureBytes: Buffer;
}

function parseEnvelope(envelope: unknown): ParsedEnvelope {
  if (!isRecord(envelope) || !hasExactKeys(envelope, ENVELOPE_KEYS)) {
    fail(
      "invalid_envelope",
      "Der Envelope entspricht nicht dem bekannten Schema.",
    );
  }

  if (envelope.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    fail(
      "invalid_schema_version",
      `Der Envelope verwendet eine unbekannte Schemaversion (erwartet ${MANIFEST_SCHEMA_VERSION}).`,
      { field: "envelope.schemaVersion" },
    );
  }

  if (
    typeof envelope.keyId !== "string" ||
    !KEY_ID_PATTERN.test(envelope.keyId)
  ) {
    fail(
      "invalid_key_id",
      "keyId muss 1 bis 64 ASCII-Zeichen aus Buchstaben, Ziffern, Bindestrich und Unterstrich enthalten.",
      { field: "envelope.keyId" },
    );
  }

  if (
    typeof envelope.version !== "string" ||
    !SHA256_PATTERN.test(envelope.version)
  ) {
    fail(
      "invalid_version",
      "version muss ein SHA-256 in 64 kleingeschriebenen Hexzeichen sein.",
      { field: "envelope.version" },
    );
  }

  const payloadBase64 = envelope.payloadBase64;
  const payloadBytes = decodeBase64Strict(payloadBase64);
  if (payloadBytes === null || typeof payloadBase64 !== "string") {
    fail(
      "invalid_payload_base64",
      "payloadBase64 ist kein gültiges kanonisches Base64.",
      { field: "envelope.payloadBase64" },
    );
  }

  const signatureBytes = decodeBase64Strict(envelope.signatureBase64);
  if (signatureBytes === null) {
    fail(
      "invalid_signature_base64",
      "signatureBase64 ist kein gültiges kanonisches Base64.",
      { field: "envelope.signatureBase64" },
    );
  }

  return {
    keyId: envelope.keyId,
    version: envelope.version,
    payloadBytes,
    payloadBase64,
    signatureBytes,
  };
}

function validateExpectations(value: unknown): {
  taxiId: string;
  environment: ManifestEnvironment;
  trustedKeys: ReadonlyMap<string, KeyObject>;
} {
  if (!isRecord(value)) {
    fail("invalid_input", "Die Erwartungen müssen als Objekt vorliegen.");
  }

  if (!isNonEmptyText(value.taxiId)) {
    fail("invalid_taxi_id", "Die erwartete Taxi-ID muss ein nicht leerer Text sein.", {
      field: "expectations.taxiId",
    });
  }

  if (!isManifestEnvironment(value.environment)) {
    fail(
      "invalid_environment",
      'Die erwartete Umgebung muss "dev" oder "test" sein.',
      { field: "expectations.environment" },
    );
  }

  if (!(value.trustedKeys instanceof Map)) {
    fail(
      "invalid_input",
      "trustedKeys muss eine Map von keyId zu öffentlichem Schlüssel sein.",
      { field: "expectations.trustedKeys" },
    );
  }

  return {
    taxiId: value.taxiId,
    environment: value.environment,
    trustedKeys: value.trustedKeys as ReadonlyMap<string, KeyObject>,
  };
}

function verifyManifestSignature(
  publicKey: KeyObject,
  keyId: string,
  version: string,
  payloadBase64: string,
  signatureBytes: Buffer,
): boolean {
  try {
    if (!assertValidPublicKey(publicKey)) {
      return false;
    }

    const message = buildManifestSignatureMessage(
      keyId,
      version,
      payloadBase64,
    );

    return verify(
      "sha256",
      Buffer.from(message, "utf8"),
      { key: publicKey, dsaEncoding: "der" },
      signatureBytes,
    );
  } catch {
    return false;
  }
}

/**
 * Erzeugt ein signiertes Manifest-Artefakt.
 *
 * Der Plan wird über die vorhandene CX-006-Validierung normalisiert. Die
 * Nutzlast enthält weder Erstellzeit noch URL. Die Inhaltsversion ist der
 * SHA-256 der exakten Nutzlastbytes.
 */
export function createSignedManifest(
  input: CreateSignedManifestInput,
): SignedManifestEnvelope {
  if (!isRecord(input)) {
    fail("invalid_input", "Die Eingabe muss als Objekt vorliegen.");
  }

  if (!isManifestEnvironment(input.environment)) {
    fail("invalid_environment", 'environment muss "dev" oder "test" sein.', {
      field: "environment",
    });
  }

  if (typeof input.keyId !== "string" || !KEY_ID_PATTERN.test(input.keyId)) {
    fail(
      "invalid_key_id",
      "keyId muss 1 bis 64 ASCII-Zeichen aus Buchstaben, Ziffern, Bindestrich und Unterstrich enthalten.",
      { field: "keyId" },
    );
  }

  const signingKey = assertValidSigningKey(input.signingKey);
  const plan = normalizePlanForSigning(input.plan);
  const payload = toManifestPayload(plan, input.environment);
  const payloadJson = serializePayload(payload);
  const payloadBytes = Buffer.from(payloadJson, "utf8");

  if (payloadBytes.length > MANIFEST_MAX_PAYLOAD_BYTES) {
    fail(
      "payload_too_large",
      `Die Nutzlast überschreitet ${MANIFEST_MAX_PAYLOAD_BYTES} Byte.`,
      { sizeBytes: payloadBytes.length },
    );
  }

  const version = hashPayload(payloadBytes);
  const payloadBase64 = payloadBytes.toString("base64");
  const message = buildManifestSignatureMessage(
    input.keyId,
    version,
    payloadBase64,
  );
  const signatureBase64 = sign(
    "sha256",
    Buffer.from(message, "utf8"),
    { key: signingKey, dsaEncoding: "der" },
  ).toString("base64");

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    keyId: input.keyId,
    version,
    payloadBase64,
    signatureBase64,
  };
}

/**
 * Prüft ein Manifest-Artefakt und gibt erst nach erfolgreicher Prüfung von
 * Schema, Inhaltsversion, Signatur sowie Taxi- und Umgebungsbindung einen
 * nutzbaren Plan zurück.
 */
export function verifySignedManifest(
  envelope: unknown,
  expectations: VerifySignedManifestExpectations,
): VerifiedManifest {
  const expected = validateExpectations(expectations);
  const parsed = parseEnvelope(envelope);

  if (parsed.payloadBytes.length > MANIFEST_MAX_PAYLOAD_BYTES) {
    fail(
      "payload_too_large",
      `Die Nutzlast überschreitet ${MANIFEST_MAX_PAYLOAD_BYTES} Byte.`,
      { sizeBytes: parsed.payloadBytes.length },
    );
  }

  const payload = parsePayload(parsed.payloadBytes);
  const computedVersion = hashPayload(parsed.payloadBytes);

  if (computedVersion !== parsed.version) {
    fail(
      "payload_version_mismatch",
      "Die angegebene Version entspricht nicht dem SHA-256 der Nutzlast.",
      { field: "envelope.version" },
    );
  }

  const publicKey = expected.trustedKeys.get(parsed.keyId);
  if (publicKey === undefined) {
    fail(
      "unknown_key_id",
      `Die Schlüsselkennung "${parsed.keyId}" ist nicht vertrauenswürdig.`,
      { field: "envelope.keyId" },
    );
  }

  if (
    !verifyManifestSignature(
      publicKey,
      parsed.keyId,
      parsed.version,
      parsed.payloadBase64,
      parsed.signatureBytes,
    )
  ) {
    fail("invalid_signature", "Die Signatur des Manifests ist ungültig.", {
      field: "envelope.signatureBase64",
    });
  }

  if (payload.environment !== expected.environment) {
    fail(
      "environment_mismatch",
      `Die Nutzlast ist an die Umgebung "${payload.environment}" gebunden, erwartet wurde "${expected.environment}".`,
      { field: "payload.environment" },
    );
  }

  if (payload.taxiId !== expected.taxiId) {
    fail(
      "taxi_mismatch",
      `Die Nutzlast ist an das Taxi "${payload.taxiId}" gebunden, erwartet wurde "${expected.taxiId}".`,
      { field: "payload.taxiId" },
    );
  }

  let plan: LoopPlan;
  try {
    plan = buildPlanFromPayload(payload);
  } catch (error) {
    if (error instanceof LoopPlanError) {
      fail("invalid_payload", error.message, { causeCode: error.code });
    }
    throw error;
  }

  return {
    plan,
    version: parsed.version,
    keyId: parsed.keyId,
    environment: payload.environment,
  };
}
