import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP-Pruefkern nach RFC 6238 (SHA-1, 6 Stellen, 30-Sekunden-Schritt).
 *
 * Bewusst zustandslos: Die Funktionen erzeugen bzw. pruefen nur Werte. Es gibt
 * keine Sitzung, keinen MFA-Nachweis, keine Replay-Sperre und keine
 * Protokollierung. Die atomare Verbrauchspruefung eines akzeptierten Schritts
 * muss ein spaeteres Persistenzpaket unter Transaktionssperre nachholen.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const SECRET_BYTE_LENGTH = 20;
const SECRET_CHAR_LENGTH = 32;
const STEP_MS = 30_000;
const CODE_LENGTH = 6;
const CODE_MODULUS = 1_000_000;
const SECRET_PATTERN = /^[A-Z2-7]{32}$/;
const CODE_PATTERN = /^[0-9]{6}$/;

/** Erzeugt ein neues TOTP-Secret: 20 Zufallsbytes als kanonisches Base32 ohne Padding. */
export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(SECRET_BYTE_LENGTH));
}

/**
 * Prueft einen sechsstelligen Code gegen die Schritte current-1, current und
 * current+1. Liefert den groessten passenden Schritt oberhalb von
 * lastAcceptedStep oder null.
 */
export function matchTotpStep(
  secretBase32: string,
  code: string,
  nowMs: number,
  lastAcceptedStep: number | null,
): number | null {
  if (typeof secretBase32 !== "string" || !SECRET_PATTERN.test(secretBase32)) {
    return null;
  }
  if (typeof code !== "string" || !CODE_PATTERN.test(code)) {
    return null;
  }
  if (!isNonNegativeSafeInteger(nowMs)) {
    return null;
  }
  if (lastAcceptedStep !== null && !isNonNegativeSafeInteger(lastAcceptedStep)) {
    return null;
  }

  const key = decodeBase32(secretBase32);
  if (key === null) {
    return null;
  }

  const currentStep = Math.floor(nowMs / STEP_MS);
  const expected = Buffer.from(code, "ascii");
  const candidates = [currentStep - 1, currentStep, currentStep + 1].filter(
    (step) => step >= 0,
  );

  let matchedStep: number | null = null;
  // Alle Kandidaten werden geprueft, kein frueher Abbruch nach dem ersten Treffer.
  for (const step of candidates) {
    const candidate = computeTotp(key, step);
    const isMatch = timingSafeEqual(Buffer.from(candidate, "ascii"), expected);
    if (!isMatch) {
      continue;
    }
    if (lastAcceptedStep !== null && step <= lastAcceptedStep) {
      continue;
    }
    if (matchedStep === null || step > matchedStep) {
      matchedStep = step;
    }
  }

  return matchedStep;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function computeTotp(key: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", key).update(counter).digest();

  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];

  const truncated = (binary >>> 0) % CODE_MODULUS;
  return truncated.toString(10).padStart(CODE_LENGTH, "0");
}

function encodeBase32(bytes: Uint8Array): string {
  let result = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += BASE32_ALPHABET[(buffer >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    result += BASE32_ALPHABET[(buffer << (5 - bits)) & 0x1f];
  }
  return result;
}

function decodeBase32(secret: string): Buffer | null {
  if (!SECRET_PATTERN.test(secret)) {
    return null;
  }
  const bytes = Buffer.alloc(SECRET_BYTE_LENGTH);
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const character of secret) {
    buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset] = (buffer >>> bits) & 0xff;
      offset += 1;
    }
  }
  if (offset !== SECRET_BYTE_LENGTH || secret.length !== SECRET_CHAR_LENGTH) {
    return null;
  }
  return bytes;
}
