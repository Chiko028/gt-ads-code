import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";

/** Praefix der zu signierenden Nachricht laut API-VERTRAG.md Abschnitt 3. */
export const SIGNATURE_MESSAGE_PREFIX = "gt-ads-auth-v1";

/** Erwartete Kurve fuer Geraeteschluessel. */
export const DEVICE_KEY_CURVE = "prime256v1";

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class InvalidPublicKeyError extends Error {
  constructor(message = "Der oeffentliche Schluessel ist ungueltig.") {
    super(message);
    this.name = "InvalidPublicKeyError";
  }
}

/**
 * Signaturnachricht exakt nach Vertrag:
 * "gt-ads-auth-v1\n<device_id>\n<nonce>" ohne abschliessenden Zeilenumbruch.
 */
export function buildSignatureMessage(deviceId: string, nonce: string): string {
  return SIGNATURE_MESSAGE_PREFIX + "\n" + deviceId + "\n" + nonce;
}

function decodeBase64Strict(value: string): Buffer | null {
  if (typeof value !== "string" || value.length === 0 || !BASE64_PATTERN.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    return null;
  }
  return decoded;
}

/**
 * Parst einen Base64-kodierten SPKI-DER-Schluessel und verlangt EC P-256.
 * Andere Schluesseltypen oder Kurven werden abgelehnt.
 */
export function parsePublicKeySpki(publicKeySpki: string): KeyObject {
  const der = decodeBase64Strict(publicKeySpki);
  if (der === null) {
    throw new InvalidPublicKeyError("public_key ist kein gueltiges Base64 (Standard, mit Padding).");
  }
  let key: KeyObject;
  try {
    key = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    throw new InvalidPublicKeyError("public_key ist kein gueltiger SPKI-Schluessel.");
  }
  if (key.asymmetricKeyType !== "ec") {
    throw new InvalidPublicKeyError("public_key ist kein EC-Schluessel.");
  }
  if (key.asymmetricKeyDetails?.namedCurve !== DEVICE_KEY_CURVE) {
    throw new InvalidPublicKeyError("public_key verwendet nicht die Kurve prime256v1.");
  }
  return key;
}

/** Prueft einen SPKI-Schluessel ohne zu werfen. */
export function isValidDevicePublicKey(publicKeySpki: string): boolean {
  try {
    parsePublicKeySpki(publicKeySpki);
    return true;
  } catch {
    return false;
  }
}

export interface DeviceSignatureInput {
  publicKeySpki: string;
  deviceId: string;
  nonce: string;
  signature: string;
}

/**
 * Verifiziert eine ECDSA-P-256/SHA-256-Signatur im ASN.1-DER-Format.
 * Jeder Fehler (Schluessel, Format, Signatur) fuehrt zu false, nie zu einem Wurf.
 */
export function verifyDeviceSignature(input: DeviceSignatureInput): boolean {
  try {
    const key = parsePublicKeySpki(input.publicKeySpki);
    const signature = decodeBase64Strict(input.signature);
    if (signature === null) {
      return false;
    }
    const message = buildSignatureMessage(input.deviceId, input.nonce);
    return verify(
      "sha256",
      Buffer.from(message, "utf8"),
      { key, dsaEncoding: "der" },
      signature,
    );
  } catch {
    return false;
  }
}

/** SHA-256-Fingerabdruck des SPKI-DER (Hex, klein geschrieben) fuer die DB. */
export function publicKeyFingerprint(publicKeySpki: string): string {
  const key = parsePublicKeySpki(publicKeySpki);
  const der = key.export({ format: "der", type: "spki" }) as Buffer;
  return createHash("sha256").update(der).digest("hex");
}
