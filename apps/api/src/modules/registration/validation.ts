import type { AppEnv } from "../../config.js";
import { parsePublicKeySpki } from "../../crypto/deviceSignature.js";
import { normalizeRegistrationCode } from "../../crypto/registrationCode.js";
import { ApiError } from "../../http/errors.js";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const REGISTER_FIELDS: ReadonlySet<string> = new Set([
  "registration_code",
  "client_request_id",
  "public_key",
  "app_env",
  "device_info",
]);

const DEVICE_INFO_FIELDS: ReadonlySet<string> = new Set([
  "manufacturer",
  "model",
  "os_version",
  "sdk_int",
  "app_version",
  "app_flavor",
]);

export interface DeviceInfo {
  manufacturer: string;
  model: string;
  osVersion: string;
  sdkInt: number;
  appVersion: string;
  appFlavor: string;
}

export interface ParsedRegistrationRequest {
  registrationCode: string;
  clientRequestId: string;
  publicKeySpki: string;
  appEnv: AppEnv;
  deviceInfo: DeviceInfo;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw ApiError.invalidRequest();
    }
  }
}

/** UUID v4 in Kleinschreibung; Grossschreibung wird akzeptiert. */
export function isUuidV4(value: string): boolean {
  return UUID_V4_PATTERN.test(value.toLowerCase());
}

function readBoundedString(value: unknown): string {
  if (typeof value !== "string") {
    throw ApiError.invalidRequest();
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 64) {
    throw ApiError.invalidRequest();
  }
  return trimmed;
}

function readSdkInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw ApiError.invalidRequest();
  }
  if (value < 1 || value > 99) {
    throw ApiError.invalidRequest();
  }
  return value;
}

function parseDeviceInfo(value: unknown): DeviceInfo {
  if (!isPlainObject(value)) {
    throw ApiError.invalidRequest();
  }
  rejectUnknownFields(value, DEVICE_INFO_FIELDS);
  return {
    manufacturer: readBoundedString(value.manufacturer),
    model: readBoundedString(value.model),
    osVersion: readBoundedString(value.os_version),
    sdkInt: readSdkInt(value.sdk_int),
    appVersion: readBoundedString(value.app_version),
    appFlavor: readBoundedString(value.app_flavor),
  };
}

function parseRegistrationCode(value: unknown, expectedLength: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw ApiError.invalidRequest();
  }
  const normalized = normalizeRegistrationCode(value);
  // Syntaktisch unbrauchbare Codes erhalten dieselbe Meldung wie unbekannte
  // Codes (AC-03), damit nach aussen kein Unterschied erkennbar ist.
  if (normalized === null || normalized.length !== expectedLength) {
    throw ApiError.invalidRegistrationCode();
  }
  return normalized;
}

function parseClientRequestId(value: unknown): string {
  if (typeof value !== "string" || !isUuidV4(value)) {
    throw ApiError.invalidRequest();
  }
  return value.toLowerCase();
}

function parseAppEnv(value: unknown): AppEnv {
  if (value !== "dev" && value !== "test") {
    throw ApiError.invalidRequest();
  }
  return value;
}

function parsePublicKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    throw ApiError.invalidRequest();
  }
  try {
    parsePublicKeySpki(value);
  } catch {
    throw ApiError.invalidRequest();
  }
  return value;
}

/**
 * Strenge Validierung des Registrierungs-Requests nach API-VERTRAG.md
 * Abschnitt 2. Unbekannte Felder und Formatfehler ergeben invalid_request;
 * ein formal gueltiger, aber unbekannter Code ergibt invalid_registration_code.
 */
export function parseRegistrationRequest(
  body: unknown,
  expectedCodeLength: number,
): ParsedRegistrationRequest {
  if (!isPlainObject(body)) {
    throw ApiError.invalidRequest();
  }
  rejectUnknownFields(body, REGISTER_FIELDS);
  return {
    registrationCode: parseRegistrationCode(
      body.registration_code,
      expectedCodeLength,
    ),
    clientRequestId: parseClientRequestId(body.client_request_id),
    publicKeySpki: parsePublicKey(body.public_key),
    appEnv: parseAppEnv(body.app_env),
    deviceInfo: parseDeviceInfo(body.device_info),
  };
}
