import { describe, expect, it } from "vitest";
import {
  DEFAULT_REGISTRATION_CODE_LENGTH,
  InvalidRegistrationCodeError,
  REGISTRATION_CODE_ALPHABET,
  formatRegistrationCode,
  generateRegistrationCode,
  hashRegistrationCode,
  isRegistrationCode,
  normalizeRegistrationCode,
  registrationCodeHashEquals,
} from "../../src/crypto/registrationCode.js";

const ALPHABET_PATTERN = /^[0-9A-HJKMNP-TV-Z]+$/;

describe("U-01 Code-Generator", () => {
  it("erzeugt 1.000 Codes der Laenge 12 ohne Kollision und nur aus dem Alphabet", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 1000; index += 1) {
      const code = generateRegistrationCode();
      expect(code).toHaveLength(DEFAULT_REGISTRATION_CODE_LENGTH);
      expect(code).toMatch(ALPHABET_PATTERN);
      for (const character of code) {
        expect(REGISTRATION_CODE_ALPHABET).toContain(character);
      }
      seen.add(code);
    }
    expect(seen.size).toBe(1000);
  });

  it("unterstuetzt konfigurierbare Laengen", () => {
    expect(generateRegistrationCode(1)).toHaveLength(1);
    expect(generateRegistrationCode(8)).toHaveLength(8);
    expect(generateRegistrationCode(32)).toHaveLength(32);
    expect(() => generateRegistrationCode(0)).toThrow(RangeError);
    expect(() => generateRegistrationCode(2.5)).toThrow(RangeError);
  });

  it("nutzt die übergebene Zufallsquelle deterministisch", () => {
    expect(generateRegistrationCode(4, (size) => Buffer.alloc(size, 0))).toBe("0000");
    expect(generateRegistrationCode(4, (size) => Buffer.alloc(size, 31))).toBe("ZZZZ");
    expect(generateRegistrationCode(4, () => Buffer.from([0, 1, 2, 31]))).toBe("012Z");
  });
});

describe("U-02 Normalisierung", () => {
  it("entfernt Bindestriche und Leerzeichen und schreibt gross", () => {
    expect(normalizeRegistrationCode("abcd-efgh-jkmn")).toBe("ABCDEFGHJKMN");
    expect(normalizeRegistrationCode("abcd efgh jkmn")).toBe("ABCDEFGHJKMN");
    expect(normalizeRegistrationCode(" ABCD-EFGH-JKMN ")).toBe("ABCDEFGHJKMN");
    expect(normalizeRegistrationCode("ab\tcd\nefgh-jkmn")).toBe("ABCDEFGHJKMN");
  });

  it("ersetzt O durch 0 und I/L durch 1", () => {
    expect(normalizeRegistrationCode("o")).toBe("0");
    expect(normalizeRegistrationCode("i")).toBe("1");
    expect(normalizeRegistrationCode("l")).toBe("1");
    expect(normalizeRegistrationCode("OIL")).toBe("011");
    expect(normalizeRegistrationCode("O0-I1-L")).toBe("00111");
  });

  it("lehnt ungueltige Zeichen, U und leere Eingaben ab", () => {
    expect(normalizeRegistrationCode("")).toBeNull();
    expect(normalizeRegistrationCode("   ")).toBeNull();
    expect(normalizeRegistrationCode("ABCU")).toBeNull();
    expect(normalizeRegistrationCode("ABC!")).toBeNull();
    expect(normalizeRegistrationCode("ABC_D")).toBeNull();
    expect(normalizeRegistrationCode("\u00c4BC")).toBeNull();
    expect(normalizeRegistrationCode("invalid_registration_code")).toBeNull();
    expect(normalizeRegistrationCode(123 as unknown as string)).toBeNull();
  });

  it("ist idempotent und erkennt gueltige Codes", () => {
    const code = "ABCD-EFGH-JKMN";
    const normalized = normalizeRegistrationCode(code);
    expect(normalized).toBe("ABCDEFGHJKMN");
    expect(normalizeRegistrationCode(normalized as string)).toBe(normalized);
    expect(isRegistrationCode(code)).toBe(true);
    expect(isRegistrationCode("ABCU")).toBe(false);
  });

  it("formatiert Codes in Vierergruppen", () => {
    expect(formatRegistrationCode("abcdefghjkmn")).toBe("ABCD-EFGH-JKMN");
    expect(formatRegistrationCode("ABCD-EFGH-JKMN")).toBe("ABCD-EFGH-JKMN");
    expect(formatRegistrationCode("ABCDEFGH")).toBe("ABCD-EFGH");
    expect(formatRegistrationCode("ABCDE")).toBe("ABCD-E");
    expect(() => formatRegistrationCode("ABCU")).toThrow(InvalidRegistrationCodeError);
  });
});

describe("U-03 HMAC-Speicherung", () => {
  const pepper = "SYN-pepper-a";
  const otherPepper = "SYN-pepper-b";

  it("ist deterministisch je Pepper und unabhaengig von der Schreibweise", () => {
    const first = hashRegistrationCode("ABCD-EFGH-JKMN", pepper);
    const second = hashRegistrationCode("abcdefghjkmn", pepper);
    expect(first).toHaveLength(32);
    expect(registrationCodeHashEquals(first, second)).toBe(true);
  });

  it("liefert mit anderem Pepper einen anderen Hash", () => {
    const first = hashRegistrationCode("ABCD-EFGH-JKMN", pepper);
    const second = hashRegistrationCode("ABCD-EFGH-JKMN", otherPepper);
    expect(registrationCodeHashEquals(first, second)).toBe(false);
  });

  it("behandelt O/0 und I/L/1 als denselben Code", () => {
    const withLetters = hashRegistrationCode("OOOOOOOOOOOO", pepper);
    const withDigits = hashRegistrationCode("000000000000", pepper);
    expect(registrationCodeHashEquals(withLetters, withDigits)).toBe(true);

    const withI = hashRegistrationCode("IIIIIIIIIIII", pepper);
    const withOne = hashRegistrationCode("111111111111", pepper);
    expect(registrationCodeHashEquals(withI, withOne)).toBe(true);
  });

  it("enthaelt den Klartext nicht im Ergebnis", () => {
    const code = "ABCDEFGHJKMN";
    const hash = hashRegistrationCode(code, pepper);
    expect(hash.includes(Buffer.from(code, "utf8"))).toBe(false);
    expect(hash.toString("hex")).not.toContain(code.toLowerCase());
  });

  it("lehnt ungueltige Codes und leeren Pepper ab", () => {
    expect(() => hashRegistrationCode("ABCU", pepper)).toThrow(InvalidRegistrationCodeError);
    expect(() => hashRegistrationCode("ABCDEFGHJKMN", "")).toThrow(/Pepper/);
    expect(() => hashRegistrationCode("ABCDEFGHJKMN", Buffer.alloc(0))).toThrow(/Pepper/);
  });
});
