import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { decodeBase64Url } from "./tokens.js";

/** scrypt-Parameter; N=16384/r=8/p=1 ist der Standard dieses Pakets. */
export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keylen: number;
}

export const DEFAULT_SCRYPT_PARAMS: Readonly<ScryptParams> = Object.freeze({
  N: 16384,
  r: 8,
  p: 1,
  keylen: 32,
});

export const PASSWORD_HASH_PREFIX = "scrypt";

const SALT_BYTES = 16;
const MIN_HASH_BYTES = 16;
const MAX_HASH_BYTES = 64;
const MIN_N = 1024;
const MAX_N = 1048576;

export class InvalidPasswordHashError extends Error {
  constructor(message = "Ungueltiges Passwort-Hashformat.") {
    super(message);
    this.name = "InvalidPasswordHashError";
  }
}

export interface ParsedPasswordHash {
  params: ScryptParams;
  salt: Buffer;
  hash: Buffer;
}

const HASH_PATTERN = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}

/**
 * Parst "scrypt$N=...,r=...,p=...$salt$hash" (Base64url ohne Padding).
 * Wirft bei jedem abweichenden Format, damit der Start-Guard es ablehnen kann.
 */
export function parsePasswordHash(stored: string): ParsedPasswordHash {
  if (typeof stored !== "string") {
    throw new InvalidPasswordHashError();
  }
  const match = HASH_PATTERN.exec(stored);
  if (match === null) {
    throw new InvalidPasswordHashError();
  }
  const nRaw = match[1] as string;
  const rRaw = match[2] as string;
  const pRaw = match[3] as string;
  const saltRaw = match[4] as string;
  const hashRaw = match[5] as string;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);

  if (!Number.isSafeInteger(N) || !isPowerOfTwo(N) || N < MIN_N || N > MAX_N) {
    throw new InvalidPasswordHashError("Ungueltiger scrypt-Parameter N.");
  }
  if (!Number.isSafeInteger(r) || r < 1 || r > 32) {
    throw new InvalidPasswordHashError("Ungueltiger scrypt-Parameter r.");
  }
  if (!Number.isSafeInteger(p) || p < 1 || p > 16) {
    throw new InvalidPasswordHashError("Ungueltiger scrypt-Parameter p.");
  }

  const salt = decodeBase64Url(saltRaw);
  const hash = decodeBase64Url(hashRaw);
  if (salt === null || hash === null) {
    throw new InvalidPasswordHashError();
  }
  if (salt.length < 8 || salt.length > 64) {
    throw new InvalidPasswordHashError("Ungueltige Salt-Laenge.");
  }
  if (hash.length < MIN_HASH_BYTES || hash.length > MAX_HASH_BYTES) {
    throw new InvalidPasswordHashError("Ungueltige Hash-Laenge.");
  }

  return { params: { N, r, p, keylen: hash.length }, salt, hash };
}

/** Prueft ein gespeichertes Hashformat ohne zu werfen. */
export function isValidPasswordHash(stored: string): boolean {
  try {
    parsePasswordHash(stored);
    return true;
  } catch {
    return false;
  }
}

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, derivedKey) => {
      if (error !== null) {
        reject(error);
      } else {
        resolve(derivedKey);
      }
    });
  });
}

async function deriveKey(
  password: string,
  salt: Buffer,
  params: ScryptParams,
): Promise<Buffer> {
  const maxmem = 128 * params.N * params.r * 2;
  return scryptAsync(password, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem,
  });
}

/**
 * Erzeugt einen scrypt-Hash. Das Passwort kommt nie in die Ausgabe und wird
 * nicht protokolliert.
 */
export async function hashPassword(
  password: string,
  options: { params?: Partial<ScryptParams>; salt?: Buffer } = {},
): Promise<string> {
  if (typeof password !== "string") {
    throw new TypeError("Das Passwort muss ein String sein");
  }
  const params: ScryptParams = { ...DEFAULT_SCRYPT_PARAMS, ...options.params };
  if (
    !Number.isInteger(params.keylen) ||
    params.keylen < MIN_HASH_BYTES ||
    params.keylen > MAX_HASH_BYTES
  ) {
    throw new RangeError("keylen muss zwischen 16 und 64 liegen");
  }
  const salt = options.salt ?? randomBytes(SALT_BYTES);
  if (salt.length < 8 || salt.length > 64) {
    throw new RangeError("Salt muss zwischen 8 und 64 Byte lang sein");
  }
  const derived = await deriveKey(password, salt, params);
  return [
    PASSWORD_HASH_PREFIX,
    "N=" + params.N + ",r=" + params.r + ",p=" + params.p,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

/**
 * Vergleicht ein Passwort mit einem gespeicherten Hash (zeitkonstant).
 * Ein ungueltiges Hashformat wird als "passt nicht" behandelt, nicht als Absturz.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof password !== "string") {
    return false;
  }
  let parsed: ParsedPasswordHash;
  try {
    parsed = parsePasswordHash(stored);
  } catch {
    return false;
  }
  let derived: Buffer;
  try {
    derived = await deriveKey(password, parsed.salt, parsed.params);
  } catch {
    return false;
  }
  if (derived.length !== parsed.hash.length) {
    return false;
  }
  return timingSafeEqual(derived, parsed.hash);
}
