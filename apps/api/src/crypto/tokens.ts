import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Laenge der opaken Tokens/Nonces in Byte (Vertrag: 32 Byte). */
export const DEFAULT_TOKEN_BYTES = 32;

/**
 * Erzeugt ein opakes Token als Base64url ohne Padding.
 * Die Byte-Laenge ist begrenzt, damit kein Riesenwert in die DB wandert.
 */
export function generateOpaqueToken(byteLength: number = DEFAULT_TOKEN_BYTES): string {
  if (!Number.isInteger(byteLength) || byteLength < 16 || byteLength > 64) {
    throw new RangeError("Token-Laenge muss eine ganze Zahl zwischen 16 und 64 sein");
  }
  return randomBytes(byteLength).toString("base64url");
}

/** Access-Token fuer Geraete (32 Byte, Base64url). */
export function generateAccessToken(): string {
  return generateOpaqueToken(DEFAULT_TOKEN_BYTES);
}

/** Nonce fuer die Challenge-Response-Authentifizierung (32 Byte, Base64url). */
export function generateNonce(): string {
  return generateOpaqueToken(DEFAULT_TOKEN_BYTES);
}

/** Sitzungstoken fuer das Admin-Dashboard (32 Byte, Base64url). */
export function generateAdminSessionToken(): string {
  return generateOpaqueToken(DEFAULT_TOKEN_BYTES);
}

/**
 * Hash eines Tokens/Nonces fuer die Speicherung (SHA-256).
 * In der Datenbank liegt nur dieser Hash, nie das Token selbst.
 */
export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** Alias fuer Nonces: gleiche Hashfunktion wie bei Tokens. */
export function hashNonce(nonce: string): Buffer {
  return hashToken(nonce);
}

/**
 * Dekodiert Base64url ohne Padding streng und kanonisch.
 * Liefert null bei ungueltigen Zeichen, Padding oder nicht-kanonischer Kodierung.
 */
export function decodeBase64Url(value: string): Buffer | null {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    return null;
  }
  return decoded;
}

/** Prueft ein kanonisches Base64url-Token der erwarteten Byte-Laenge. */
export function isValidOpaqueToken(value: string, byteLength: number = DEFAULT_TOKEN_BYTES): boolean {
  const decoded = decodeBase64Url(value);
  return decoded !== null && decoded.length === byteLength;
}

/** Zeitkonstanter Vergleich zweier Bytefolgen gleicher Laenge. */
export function constantTimeEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}
