import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOKEN_BYTES,
  constantTimeEqual,
  decodeBase64Url,
  generateAccessToken,
  generateAdminSessionToken,
  generateNonce,
  generateOpaqueToken,
  hashNonce,
  hashToken,
  isValidOpaqueToken,
} from "../../src/crypto/tokens.js";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe("U2 Tokens und Nonces", () => {
  it("erzeugt 32-Byte-Tokens als Base64url ohne Padding", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const token = generateOpaqueToken();
      expect(token).toHaveLength(43);
      expect(token).toMatch(BASE64URL);
      expect(token).not.toContain("=");
      const decoded = decodeBase64Url(token);
      expect(decoded).not.toBeNull();
      expect(decoded).toHaveLength(DEFAULT_TOKEN_BYTES);
      seen.add(token);
    }
    expect(seen.size).toBe(200);
  });

  it("erzeugt Access-Token, Nonce und Admin-Session-Token in derselben Form", () => {
    for (const token of [generateAccessToken(), generateNonce(), generateAdminSessionToken()]) {
      expect(decodeBase64Url(token)).toHaveLength(DEFAULT_TOKEN_BYTES);
      expect(isValidOpaqueToken(token)).toBe(true);
    }
  });

  it("begrenzt die Byte-Laenge", () => {
    expect(decodeBase64Url(generateOpaqueToken(16))).toHaveLength(16);
    expect(decodeBase64Url(generateOpaqueToken(64))).toHaveLength(64);
    for (const length of [0, -1, 15, 65, 16.5]) {
      expect(() => generateOpaqueToken(length), String(length)).toThrow(RangeError);
    }
  });

  it("hasht Tokens und Nonces deterministisch mit SHA-256", () => {
    const token = generateAccessToken();
    const hash = hashToken(token);
    expect(hash).toHaveLength(32);
    expect(hashToken(token).equals(hash)).toBe(true);
    expect(hashToken(generateAccessToken()).equals(hash)).toBe(false);
    expect(hashNonce(token).equals(hash)).toBe(true);
    expect(hash.includes(Buffer.from(token, "utf8"))).toBe(false);
  });

  it("dekodiert nur kanonisches Base64url", () => {
    expect(decodeBase64Url("")).toBeNull();
    expect(decodeBase64Url("AA")).toEqual(Buffer.from([0]));
    expect(decodeBase64Url("AB")).toBeNull();
    expect(decodeBase64Url("AAB")).toBeNull();
    expect(decodeBase64Url("A")).toBeNull();
    expect(decodeBase64Url("AAAA=")).toBeNull();
    expect(decodeBase64Url("AA==")).toBeNull();
    expect(decodeBase64Url("a+b/")).toBeNull();
    expect(decodeBase64Url("a b")).toBeNull();
  });

  it("prueft Tokens auf kanonische Form und erwartete Laenge", () => {
    const token = generateOpaqueToken(32);
    expect(isValidOpaqueToken(token, 32)).toBe(true);
    expect(isValidOpaqueToken(token, 31)).toBe(false);
    expect(isValidOpaqueToken("AA", 1)).toBe(true);
    expect(isValidOpaqueToken("AB", 1)).toBe(false);
    expect(isValidOpaqueToken("AA==", 1)).toBe(false);
  });

  it("vergleicht Bytefolgen zeitkonstant und laengenabhaengig", () => {
    expect(constantTimeEqual(Buffer.from("abcd", "utf8"), Buffer.from("abcd", "utf8"))).toBe(true);
    expect(constantTimeEqual(Buffer.from("abcd", "utf8"), Buffer.from("abce", "utf8"))).toBe(false);
    expect(constantTimeEqual(Buffer.from("abcd", "utf8"), Buffer.from("abc", "utf8"))).toBe(false);
  });
});
