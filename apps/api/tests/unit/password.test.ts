import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCRYPT_PARAMS,
  InvalidPasswordHashError,
  hashPassword,
  isValidPasswordHash,
  parsePasswordHash,
  verifyPassword,
} from "../../src/crypto/password.js";

const FORMAT = /^scrypt\$N=16384,r=8,p=1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/;

describe("U-08 Passwort-Hash (scrypt)", () => {
  it("akzeptiert das richtige Passwort und lehnt ein falsches ab", async () => {
    const hash = await hashPassword("SYN-korrektes-passwort");
    expect(hash).toMatch(FORMAT);
    expect(await verifyPassword("SYN-korrektes-passwort", hash)).toBe(true);
    expect(await verifyPassword("SYN-falsches-passwort", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("verwendet zufaelliges Salt: zwei Hashes unterscheiden sich, beide passen", async () => {
    const first = await hashPassword("SYN-gleiches-passwort");
    const second = await hashPassword("SYN-gleiches-passwort");
    expect(first).not.toBe(second);
    expect(await verifyPassword("SYN-gleiches-passwort", first)).toBe(true);
    expect(await verifyPassword("SYN-gleiches-passwort", second)).toBe(true);
  });

  it("parst Parameter, Salt und Hash", async () => {
    const hash = await hashPassword("SYN-parse-passwort");
    const parsed = parsePasswordHash(hash);
    expect(parsed.params).toEqual(DEFAULT_SCRYPT_PARAMS);
    expect(parsed.salt).toHaveLength(16);
    expect(parsed.hash).toHaveLength(32);
  });

  it("unterstuetzt Unicode und Sonderzeichen", async () => {
    const password = "SYN-\u00e4\u00f6\u00fc-\u00df-\ud83d\udd10-!\"$%&/()=?#+";
    const hash = await hashPassword(password);
    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword(password + "x", hash)).toBe(false);
  });

  it("verweigert ungueltige Hashformate ohne zu werfen", async () => {
    const salt = "A".repeat(22);
    const hash32 = "A".repeat(43);
    const invalid = [
      "",
      "klartext",
      "scrypt$N=16384,r=8$" + salt + "$" + hash32,
      "scrypt$N=16384,r=8,p=1$AAAA$" + hash32,
      "scrypt$N=16384,r=8,p=1$" + salt + "$AAAA",
      "scrypt$N=1000,r=8,p=1$" + salt + "$" + hash32,
      "scrypt$N=16384,r=0,p=1$" + salt + "$" + hash32,
      "scrypt$N=16384,r=8,p=0$" + salt + "$" + hash32,
      "scrypt$N=16384,r=8,p=1$" + salt + "=$" + hash32,
      "bcrypt$N=16384,r=8,p=1$" + salt + "$" + hash32,
    ];

    for (const stored of invalid) {
      expect(isValidPasswordHash(stored), stored).toBe(false);
      expect(() => parsePasswordHash(stored), stored).toThrow(InvalidPasswordHashError);
      expect(await verifyPassword("SYN-passwort", stored), stored).toBe(false);
    }
  });

  it("wertet eine andere keylen korrekt aus (kein Laengenfehler)", async () => {
    const hash = await hashPassword("SYN-kurz", { params: { keylen: 16 } });
    expect(parsePasswordHash(hash).hash).toHaveLength(16);
    expect(await verifyPassword("SYN-kurz", hash)).toBe(true);
    expect(await verifyPassword("SYN-lang", hash)).toBe(false);
  });
});
