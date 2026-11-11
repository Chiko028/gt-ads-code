import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Alphabet nach ARCHITEKTUR.md Abschnitt 4 / API-VERTRAG.md Abschnitt 2:
 * Base32 ohne I, L, O, U (Verwechslungsgefahr), 32 Zeichen = 5 Bit je Zeichen.
 */
export const REGISTRATION_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Standardlaenge laut SPEZIFIKATION.md Abschnitt 7. */
export const DEFAULT_REGISTRATION_CODE_LENGTH = 12;

const ALPHABET_SET: ReadonlySet<string> = new Set(REGISTRATION_CODE_ALPHABET.split(""));

export class InvalidRegistrationCodeError extends Error {
  constructor(message = "Der Registrierungscode ist ungueltig.") {
    super(message);
    this.name = "InvalidRegistrationCodeError";
  }
}

/**
 * Erzeugt einen Registrierungscode aus einem CSPRNG.
 * 256 ist durch 32 teilbar, daher ist "byte & 31" ohne Modulo-Bias.
 */
export function generateRegistrationCode(
  length: number = DEFAULT_REGISTRATION_CODE_LENGTH,
  randomSource: (size: number) => Buffer = randomBytes,
): string {
  if (!Number.isInteger(length) || length < 1 || length > 128) {
    throw new RangeError("Code-Laenge muss eine ganze Zahl zwischen 1 und 128 sein");
  }
  const characters: string[] = [];
  while (characters.length < length) {
    const bytes = randomSource(length - characters.length);
    if (bytes.length === 0) {
      throw new Error("Die Zufallsquelle lieferte keine Bytes");
    }
    for (const byte of bytes) {
      characters.push(REGISTRATION_CODE_ALPHABET[byte & 31] as string);
      if (characters.length === length) {
        break;
      }
    }
  }
  return characters.join("");
}

/**
 * Normalisiert einen eingegebenen Code: Grossschreibung, Bindestriche und
 * Leerzeichen entfernen, O -> 0, I/L -> 1. Ungueltige Zeichen ergeben null.
 * Idempotent; die Ausgabe besteht ausschliesslich aus dem Alphabet.
 */
export function normalizeRegistrationCode(input: string): string | null {
  if (typeof input !== "string") {
    return null;
  }
  const compact = input.replace(/[\s-]/g, "").toUpperCase();
  const mapped = compact.replace(/O/g, "0").replace(/[IL]/g, "1");
  if (mapped.length === 0) {
    return null;
  }
  for (const character of mapped) {
    if (!ALPHABET_SET.has(character)) {
      return null;
    }
  }
  return mapped;
}

/** Prueft, ob ein Wert nach Normalisierung ein gueltiger Code ist. */
export function isRegistrationCode(input: string): boolean {
  return normalizeRegistrationCode(input) !== null;
}

/**
 * HMAC-SHA-256(pepper, normalisierter Code). Deterministisch je Pepper.
 * Der Klartext ist im Ergebnis nicht enthalten und wird nie gespeichert.
 */
export function hashRegistrationCode(code: string, pepper: string | Buffer): Buffer {
  const normalized = normalizeRegistrationCode(code);
  if (normalized === null) {
    throw new InvalidRegistrationCodeError();
  }
  const emptyPepper =
    (typeof pepper === "string" && pepper.length === 0) ||
    (Buffer.isBuffer(pepper) && pepper.length === 0);
  if (emptyPepper) {
    throw new Error("Der Code-Pepper darf nicht leer sein");
  }
  return createHmac("sha256", pepper).update(normalized, "utf8").digest();
}

/** Zeitkonstanter Vergleich zweier Code-Hashes. */
export function registrationCodeHashEquals(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Formatiert einen Code fuer die einmalige Anzeige: Gruppen zu vier Zeichen,
 * getrennt durch Bindestriche (Beispiel: ABCD-EFGH-JKMN).
 */
export function formatRegistrationCode(code: string): string {
  const normalized = normalizeRegistrationCode(code);
  if (normalized === null) {
    throw new InvalidRegistrationCodeError();
  }
  const groups: string[] = [];
  for (let index = 0; index < normalized.length; index += 4) {
    groups.push(normalized.slice(index, index + 4));
  }
  return groups.join("-");
}
