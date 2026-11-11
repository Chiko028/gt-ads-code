import { normalizeRegistrationCode } from "../crypto/registrationCode.js";

/** Platzhalter fuer redigierte Werte. */
export const REDACTED = "[REDACTED]";

/**
 * Feld- und Header-Namen, deren Werte niemals in Logs erscheinen
 * (ARCHITEKTUR.md Abschnitt 4, API-VERTRAG.md Abschnitt 7, AC-05).
 */
export const SENSITIVE_FIELD_NAMES: ReadonlySet<string> = new Set([
  "registration_code",
  "registrationcode",
  "code_hash",
  "code_pepper",
  "pepper",
  "password",
  "admin_password_hash",
  "adminpasswordhash",
  "public_key",
  "publickey",
  "signature",
  "nonce",
  "access_token",
  "accesstoken",
  "token",
  "session_token",
  "authorization",
  "cookie",
  "set_cookie",
  "set-cookie",
  "gt_ads_code_pepper",
  "gt_ads_admin_password_hash",
  "gt_ads_db_url",
]);

const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
]);

const SENSITIVE_QUERY_NAMES: ReadonlySet<string> = new Set([
  "registration_code",
  "code",
  "token",
  "access_token",
  "password",
]);

export interface RedactOptions {
  /** Maximale Tiefe; tiefere Objekte werden durch einen Platzhalter ersetzt. */
  maxDepth?: number;
}

function normalizeFieldName(name: string): string {
  return name.trim().toLowerCase().replace(/-/g, "_");
}

/** Prueft, ob ein Feldname als geheim gilt (fuer Tests und Aufrufer). */
export function isSensitiveFieldName(name: string): boolean {
  const normalized = normalizeFieldName(name);
  return (
    SENSITIVE_FIELD_NAMES.has(normalized) ||
    SENSITIVE_FIELD_NAMES.has(normalized.replace(/_/g, ""))
  );
}

/**
 * Ein Feld "code" kann einen Registrierungscode (geheim) oder einen
 * Fehlercode wie "invalid_registration_code" (unkritisch) enthalten.
 * Nur gueltige Codes werden redigiert.
 */
function isSecretCodeValue(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = normalizeRegistrationCode(value);
  return normalized !== null && normalized.length >= 8;
}

function redactValue(value: unknown, key: string | undefined, depth: number, maxDepth: number, seen: WeakSet<object>): unknown {
  if (key !== undefined) {
    if (isSensitiveFieldName(key)) {
      return REDACTED;
    }
    if (normalizeFieldName(key) === "code" && isSecretCodeValue(value)) {
      return REDACTED;
    }
  }

  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth >= maxDepth) {
    return "[MaxDepth]";
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, undefined, depth + 1, maxDepth, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    result[entryKey] = redactValue(entryValue, entryKey, depth + 1, maxDepth, seen);
  }
  return result;
}

/**
 * Kopiert einen Wert fuer die Protokollierung und ersetzt Geheimnisse.
 * Zyklen werden abgebrochen, Fehlerobjekte auf Name/Meldung reduziert.
 */
export function redactForLog(value: unknown, options: RedactOptions = {}): unknown {
  const maxDepth = options.maxDepth ?? 8;
  return redactValue(value, undefined, 0, maxDepth, new WeakSet<object>());
}

/** Redigiert Header unabhängig von Gross-/Kleinschreibung. */
export function redactHeaders(headers: Record<string, unknown> | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (headers === undefined) {
    return result;
  }
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.trim().toLowerCase();
    if (SENSITIVE_HEADER_NAMES.has(normalized) || isSensitiveFieldName(normalized)) {
      result[normalized] = REDACTED;
    } else {
      result[normalized] = redactForLog(value);
    }
  }
  return result;
}

function decodeQueryPart(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

/** Entfernt Geheimnisse aus Query-Parametern einer URL. */
export function redactUrl(rawUrl: string): string {
  const questionMark = rawUrl.indexOf("?");
  if (questionMark === -1) {
    return rawUrl;
  }
  const base = rawUrl.slice(0, questionMark);
  const query = rawUrl.slice(questionMark + 1);
  const redacted = query.split("&").map((pair) => {
    if (pair === "") {
      return pair;
    }
    const equals = pair.indexOf("=");
    const rawKey = equals === -1 ? pair : pair.slice(0, equals);
    const key = decodeQueryPart(rawKey).toLowerCase();
    if (SENSITIVE_QUERY_NAMES.has(key) || isSensitiveFieldName(key)) {
      return rawKey + "=" + REDACTED;
    }
    return pair;
  });
  return base + "?" + redacted.join("&");
}

/** Serialisiert einen Wert als JSON-Logstring mit Redaktion. */
export function serializeForLog(value: unknown): string {
  const redacted = redactForLog(value);
  const json = JSON.stringify(redacted);
  return json ?? "null";
}

export interface RequestLogInput {
  method: string;
  url: string;
  headers?: Record<string, unknown>;
  body?: unknown;
}

/** Baut einen sicheren Log-Eintrag fuer eine Anfrage (ohne Rohdaten). */
export function createRequestLogEntry(input: RequestLogInput): Record<string, unknown> {
  return {
    method: input.method,
    url: redactUrl(input.url),
    headers: redactHeaders(input.headers),
    body: redactForLog(input.body),
  };
}
