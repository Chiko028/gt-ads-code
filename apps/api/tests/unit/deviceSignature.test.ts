import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  InvalidPublicKeyError,
  buildSignatureMessage,
  isValidDevicePublicKey,
  parsePublicKeySpki,
  publicKeyFingerprint,
  verifyDeviceSignature,
} from "../../src/crypto/deviceSignature.js";

const DEVICE_ID = "00000000-0000-4000-8000-0000000000d1";
const NONCE = "c3luLW5vbmNlLTAwMDAwMDAwMDAwMDAwMDA";

function spkiOf(publicKey: KeyObject): string {
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return der.toString("base64");
}

function makeP256(): { publicKey: KeyObject; privateKey: KeyObject; spki: string } {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { publicKey: pair.publicKey, privateKey: pair.privateKey, spki: spkiOf(pair.publicKey) };
}

function signMessage(
  privateKey: KeyObject,
  message: string,
  dsaEncoding: "der" | "ieee-p1363" = "der",
): string {
  return sign("sha256", Buffer.from(message, "utf8"), { key: privateKey, dsaEncoding }).toString(
    "base64",
  );
}

describe("U-05 Signaturnachricht", () => {
  it("baut exakt gt-ads-auth-v1, device_id und nonce mit Zeilenumbruechen", () => {
    const message = buildSignatureMessage(DEVICE_ID, NONCE);
    expect(message).toBe("gt-ads-auth-v1\n" + DEVICE_ID + "\n" + NONCE);
    expect(message.split("\n")).toHaveLength(3);
    expect(message.endsWith("\n")).toBe(false);
    expect(message.startsWith("gt-ads-auth-v1\n")).toBe(true);
  });
});

describe("U-04 Signaturpruefung", () => {
  it("akzeptiert eine gueltige ECDSA-P-256-Signatur", () => {
    const { privateKey, spki } = makeP256();
    const signature = signMessage(privateKey, buildSignatureMessage(DEVICE_ID, NONCE));
    expect(verifyDeviceSignature({ publicKeySpki: spki, deviceId: DEVICE_ID, nonce: NONCE, signature })).toBe(true);
  });

  it("lehnt eine Signatur ueber eine andere Nachricht ab", () => {
    const { privateKey, spki } = makeP256();
    const signature = signMessage(privateKey, buildSignatureMessage(DEVICE_ID, NONCE + "x"));
    expect(verifyDeviceSignature({ publicKeySpki: spki, deviceId: DEVICE_ID, nonce: NONCE, signature })).toBe(false);

    const otherId = "00000000-0000-4000-8000-0000000000d2";
    expect(verifyDeviceSignature({ publicKeySpki: spki, deviceId: otherId, nonce: NONCE, signature })).toBe(false);
  });

  it("lehnt eine Signatur eines anderen Schluessels ab", () => {
    const signing = makeP256();
    const other = makeP256();
    const signature = signMessage(signing.privateKey, buildSignatureMessage(DEVICE_ID, NONCE));
    expect(verifyDeviceSignature({ publicKeySpki: other.spki, deviceId: DEVICE_ID, nonce: NONCE, signature })).toBe(
      false,
    );
  });

  it("lehnt manipulierte Signaturen und falsche Formate ab", () => {
    const { privateKey, spki } = makeP256();
    const message = buildSignatureMessage(DEVICE_ID, NONCE);
    const valid = signMessage(privateKey, message);

    const tampered = Buffer.from(valid, "base64");
    tampered[tampered.length - 1] = tampered[tampered.length - 1] ^ 0xff;
    expect(
      verifyDeviceSignature({
        publicKeySpki: spki,
        deviceId: DEVICE_ID,
        nonce: NONCE,
        signature: tampered.toString("base64"),
      }),
    ).toBe(false);

    const p1363 = signMessage(privateKey, message, "ieee-p1363");
    expect(verifyDeviceSignature({ publicKeySpki: spki, deviceId: DEVICE_ID, nonce: NONCE, signature: p1363 })).toBe(
      false,
    );

    for (const signature of ["", "kein-base64!", "AAAA", "AAAA===="]) {
      expect(
        verifyDeviceSignature({ publicKeySpki: spki, deviceId: DEVICE_ID, nonce: NONCE, signature }),
        signature,
      ).toBe(false);
    }
  });

  it("lehnt Schluessel anderer Kurven und anderer Typen ab", () => {
    const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" });
    const p384Spki = spkiOf(p384.publicKey);
    expect(() => parsePublicKeySpki(p384Spki)).toThrow(InvalidPublicKeyError);
    expect(() => parsePublicKeySpki(p384Spki)).toThrow(/prime256v1/);

    const p384Signature = signMessage(p384.privateKey, buildSignatureMessage(DEVICE_ID, NONCE));
    expect(
      verifyDeviceSignature({ publicKeySpki: p384Spki, deviceId: DEVICE_ID, nonce: NONCE, signature: p384Signature }),
    ).toBe(false);

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaSpki = spkiOf(rsa.publicKey);
    expect(() => parsePublicKeySpki(rsaSpki)).toThrow(/EC-Schluessel/);
    expect(isValidDevicePublicKey(rsaSpki)).toBe(false);
  });

  it("lehnt ungueltiges Base64 und ungueltige SPKI-Daten ab", () => {
    for (const value of ["", "kein base64", "AAAA", "AAAA====", "-----BEGIN PUBLIC KEY-----"]) {
      expect(isValidDevicePublicKey(value), value).toBe(false);
      expect(() => parsePublicKeySpki(value), value).toThrow(InvalidPublicKeyError);
      expect(() => publicKeyFingerprint(value), value).toThrow(InvalidPublicKeyError);
    }
  });

  it("akzeptiert den eigenen SPKI-Schluessel", () => {
    const { spki } = makeP256();
    expect(isValidDevicePublicKey(spki)).toBe(true);
    expect(parsePublicKeySpki(spki).asymmetricKeyType).toBe("ec");
  });
});

describe("Schluessel-Fingerabdruck", () => {
  it("ist SHA-256 Hex, deterministisch und schluesselabhaengig", () => {
    const first = makeP256();
    const second = makeP256();
    const fingerprint = publicKeyFingerprint(first.spki);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(publicKeyFingerprint(first.spki)).toBe(fingerprint);
    expect(publicKeyFingerprint(second.spki)).not.toBe(fingerprint);
  });
});
