import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildSignatureMessage,
  isValidDevicePublicKey,
  verifyDeviceSignature,
} from "../../../src/crypto/deviceSignature.js";

/**
 * Belegt die Formatkompatibilitaet des vorhandenen U2/U4-Pruefkerns mit dem
 * eingecheckten synthetischen Vektor. Er fuehrt den Android-Adapter nicht aus.
 */
interface InteropVector {
  provenance: string;
  device_id: string;
  nonce: string;
  input_bytes_utf8: string;
  public_key_spki: string;
  signature: string;
  other_public_key_spki: string;
}

function readJson<T>(relativePath: string): T {
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

const vector = readJson<InteropVector>("./identity-interop.vector.json");
const registerExample = readJson<{ public_key: string }>(
  "../../../../../contracts/gt-ads-001/examples/device-register.request.valid.json",
);
const tokenExample = readJson<{ device_id: string; nonce: string; signature: string }>(
  "../../../../../contracts/gt-ads-001/examples/device-auth-token.request.valid.json",
);

describe("CX-069 Identitaetsvektor gegen den U2/U4-Pruefkern", () => {
  it("ist ein oeffentlicher U7-Vektor ohne privaten Schluessel", () => {
    expect(vector.provenance).toContain("Kein privater Schluessel");
    expect(vector.public_key_spki).toBe(registerExample.public_key);
    expect(vector.device_id).toBe(tokenExample.device_id);
    expect(vector.nonce).toBe(tokenExample.nonce);
    expect(vector.signature).toBe(tokenExample.signature);
    expect(buildSignatureMessage(vector.device_id, vector.nonce)).toBe(vector.input_bytes_utf8);
    expect(isValidDevicePublicKey(vector.public_key_spki)).toBe(true);
    expect(isValidDevicePublicKey(vector.other_public_key_spki)).toBe(true);
    expect(vector.other_public_key_spki).not.toBe(vector.public_key_spki);
  });

  it("akzeptiert unveraenderte Eingabebytes mit passendem oeffentlichen Schluessel", () => {
    expect(
      verifyDeviceSignature({
        publicKeySpki: vector.public_key_spki,
        deviceId: vector.device_id,
        nonce: vector.nonce,
        signature: vector.signature,
      }),
    ).toBe(true);
  });

  it("weist manipulierte Eingabebytes ab", () => {
    const tamperedNonce = vector.nonce + "A";
    expect(buildSignatureMessage(vector.device_id, tamperedNonce)).not.toBe(vector.input_bytes_utf8);
    expect(
      verifyDeviceSignature({
        publicKeySpki: vector.public_key_spki,
        deviceId: vector.device_id,
        nonce: tamperedNonce,
        signature: vector.signature,
      }),
    ).toBe(false);
  });

  it("weist einen anderen oeffentlichen Schluessel ab", () => {
    expect(isValidDevicePublicKey(vector.other_public_key_spki)).toBe(true);
    expect(
      verifyDeviceSignature({
        publicKeySpki: vector.other_public_key_spki,
        deviceId: vector.device_id,
        nonce: vector.nonce,
        signature: vector.signature,
      }),
    ).toBe(false);
  });
});
