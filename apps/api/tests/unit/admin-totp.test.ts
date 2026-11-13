import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  generateTotpSecret,
  matchTotpStep,
} from "../../src/modules/adminAuth/totp.js";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});

/** RFC-4648-Base32, unabhaengig von der Implementierung (Referenz im Test). */
const REFERENCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function referenceEncodeBase32(bytes: Uint8Array): string {
  const characters: string[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = ((accumulator << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      characters.push(REFERENCE_ALPHABET[(accumulator >>> bits) & 0x1f]);
    }
  }
  if (bits > 0) {
    characters.push(REFERENCE_ALPHABET[(accumulator << (5 - bits)) & 0x1f]);
  }
  return characters.join("");
}

function referenceDecodeBase32(secret: string): Buffer {
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const character of secret) {
    const index = REFERENCE_ALPHABET.indexOf(character);
    if (index < 0) {
      throw new Error("ungueltiges Base32-Zeichen");
    }
    accumulator = ((accumulator << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** Unabhaengige Referenzimplementierung des TOTP-Codes fuer einen Schritt. */
function referenceTotpStep(secretBase32: string, step: number): string {
  const key = referenceDecodeBase32(secretBase32);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[19] & 0x0f;
  const truncated = digest.readUInt32BE(offset) & 0x7fffffff;
  return (truncated % 1_000_000).toString(10).padStart(6, "0");
}

const RFC_SECRET_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("U-TOTP-01 RFC-6238-Vektoren (SHA-1, sechs Stellen)", () => {
  it("akzeptiert die sechs veroeffentlichten Zeitpunkte mit fuehrenden Nullen", () => {
    const vectors: ReadonlyArray<readonly [number, string, number]> = [
      [59_000, "287082", 1],
      [1_111_111_109_000, "081804", 37_037_036],
      [1_111_111_111_000, "050471", 37_037_037],
      [1_234_567_890_000, "005924", 41_152_263],
      [2_000_000_000_000, "279037", 66_666_666],
      [20_000_000_000_000, "353130", 666_666_666],
    ];

    for (const [nowMs, expectedCode, expectedStep] of vectors) {
      expect(expectedCode).toHaveLength(6);
      expect(matchTotpStep(RFC_SECRET_BASE32, expectedCode, nowMs, null)).toBe(
        expectedStep,
      );
      expect(Math.floor(nowMs / 30_000)).toBe(expectedStep);
    }
  });

  it("lehnt einen fast passenden Code am selben Zeitpunkt ab", () => {
    expect(matchTotpStep(RFC_SECRET_BASE32, "287083", 59_000, null)).toBeNull();
    expect(matchTotpStep(RFC_SECRET_BASE32, "353131", 20_000_000_000_000, null)).toBeNull();
  });
});

describe("U-TOTP-02 Fenster an der 30-Sekunden-Grenze", () => {
  const boundaryMs = 1_234_567_890_000;
  const currentStep = 41_152_263;

  it("akzeptiert vorherigen, aktuellen und folgenden Schritt", () => {
    expect(boundaryMs % 30_000).toBe(0);
    expect(Math.floor(boundaryMs / 30_000)).toBe(currentStep);

    const previous = referenceTotpStep(RFC_SECRET_BASE32, currentStep - 1);
    const current = referenceTotpStep(RFC_SECRET_BASE32, currentStep);
    const next = referenceTotpStep(RFC_SECRET_BASE32, currentStep + 1);

    expect(matchTotpStep(RFC_SECRET_BASE32, previous, boundaryMs, null)).toBe(
      currentStep - 1,
    );
    expect(matchTotpStep(RFC_SECRET_BASE32, current, boundaryMs, null)).toBe(
      currentStep,
    );
    expect(matchTotpStep(RFC_SECRET_BASE32, next, boundaryMs, null)).toBe(
      currentStep + 1,
    );
  });

  it("lehnt Codes ausserhalb des Fensters ab", () => {
    const tooOld = referenceTotpStep(RFC_SECRET_BASE32, currentStep - 2);
    const tooNew = referenceTotpStep(RFC_SECRET_BASE32, currentStep + 2);

    expect(matchTotpStep(RFC_SECRET_BASE32, tooOld, boundaryMs, null)).toBeNull();
    expect(matchTotpStep(RFC_SECRET_BASE32, tooNew, boundaryMs, null)).toBeNull();
  });

  it("lehnt ungueltige Codeformate ohne Trimmen oder Zahlenumwandlung ab", () => {
    const current = referenceTotpStep(RFC_SECRET_BASE32, currentStep);

    expect(matchTotpStep(RFC_SECRET_BASE32, ` ${current}`, boundaryMs, null)).toBeNull();
    expect(matchTotpStep(RFC_SECRET_BASE32, `${current} `, boundaryMs, null)).toBeNull();
    expect(matchTotpStep(RFC_SECRET_BASE32, current.slice(0, 5), boundaryMs, null)).toBeNull();
    expect(matchTotpStep(RFC_SECRET_BASE32, `${current}0`, boundaryMs, null)).toBeNull();
    expect(
      matchTotpStep(RFC_SECRET_BASE32, "\uFF10\uFF11\uFF12\uFF13\uFF14\uFF15", boundaryMs, null),
    ).toBeNull();
    expect(matchTotpStep(RFC_SECRET_BASE32, "", boundaryMs, null)).toBeNull();
    expect(
      matchTotpStep(RFC_SECRET_BASE32, 123456 as unknown as string, boundaryMs, null),
    ).toBeNull();
    expect(
      matchTotpStep(RFC_SECRET_BASE32, null as unknown as string, boundaryMs, null),
    ).toBeNull();
  });
});

describe("U-TOTP-03 Schrittgrenze und Replay-Fenster", () => {
  const secret = RFC_SECRET_BASE32;
  const nowMs = 3_000_000;
  const currentStep = 100;

  it("lehnt Treffer gleich oder kleiner lastAcceptedStep ab", () => {
    expect(Math.floor(nowMs / 30_000)).toBe(currentStep);
    const previous = referenceTotpStep(secret, currentStep - 1);
    const current = referenceTotpStep(secret, currentStep);

    expect(matchTotpStep(secret, current, nowMs, currentStep)).toBeNull();
    expect(matchTotpStep(secret, previous, nowMs, currentStep)).toBeNull();
    expect(matchTotpStep(secret, previous, nowMs, currentStep + 5)).toBeNull();
  });

  it("liefert fuer einen neuen Treffer ausschliesslich dessen Schritt", () => {
    const current = referenceTotpStep(secret, currentStep);
    const next = referenceTotpStep(secret, currentStep + 1);

    expect(matchTotpStep(secret, current, nowMs, currentStep - 1)).toBe(currentStep);
    expect(matchTotpStep(secret, next, nowMs, currentStep - 1)).toBe(currentStep + 1);
    expect(matchTotpStep(secret, next, nowMs, currentStep)).toBe(currentStep + 1);
    expect(matchTotpStep(secret, current, nowMs, null)).toBe(currentStep);
  });

  it("weist ungueltige Zeit- und Schrittwerte ohne Fehlerdetails zurueck", () => {
    const code = referenceTotpStep(secret, currentStep);
    const invalidTimes: unknown[] = [
      -1,
      -30_000,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 2,
      "3000000",
      null,
      undefined,
    ];

    for (const invalidTime of invalidTimes) {
      let result: number | null = -1;
      expect(() => {
        result = matchTotpStep(secret, code, invalidTime as number, null);
      }).not.toThrow();
      expect(result).toBeNull();
    }

    const invalidSteps: unknown[] = [
      -1,
      -100,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 60,
      "100",
      true,
    ];

    for (const invalidStep of invalidSteps) {
      let result: number | null = -1;
      expect(() => {
        result = matchTotpStep(secret, code, nowMs, invalidStep as number);
      }).not.toThrow();
      expect(result).toBeNull();
    }
  });
});

describe("U-TOTP-04 Secret-Erzeugung und Base32-Verarbeitung", () => {
  it("erzeugt 32 kanonische Base32-Zeichen aus 20 Zufallsbytes", () => {
    const secret = generateTotpSecret();

    expect(secret).toHaveLength(32);
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);

    const decoded = referenceDecodeBase32(secret);
    expect(decoded).toHaveLength(20);
    expect(referenceEncodeBase32(decoded)).toBe(secret);

    const second = generateTotpSecret();
    expect(second).not.toBe(secret);
  });

  it("dekodiert das RFC-Secret unabhaengig zur ASCII-Folge 12345678901234567890", () => {
    const decoded = referenceDecodeBase32(RFC_SECRET_BASE32);

    expect(decoded.toString("ascii")).toBe("12345678901234567890");
    expect(referenceEncodeBase32(decoded)).toBe(RFC_SECRET_BASE32);
    expect(RFC_SECRET_BASE32).toMatch(/^[A-Z2-7]{32}$/);
  });

  it("lehnt falsche Laenge und ungueltige Zeichen ab", () => {
    expect(matchTotpStep(RFC_SECRET_BASE32.slice(0, 31), "287082", 59_000, null)).toBeNull();
    expect(matchTotpStep(`${RFC_SECRET_BASE32}A`, "287082", 59_000, null)).toBeNull();
    expect(matchTotpStep(RFC_SECRET_BASE32.toLowerCase(), "287082", 59_000, null)).toBeNull();
    expect(matchTotpStep(`${RFC_SECRET_BASE32.slice(0, 31)}=`, "287082", 59_000, null)).toBeNull();
    expect(matchTotpStep(`${RFC_SECRET_BASE32.slice(0, 31)}0`, "287082", 59_000, null)).toBeNull();
    expect(matchTotpStep(`${RFC_SECRET_BASE32.slice(0, 31)}1`, "287082", 59_000, null)).toBeNull();
    expect(matchTotpStep(`${RFC_SECRET_BASE32.slice(0, 31)}9`, "287082", 59_000, null)).toBeNull();
    expect(matchTotpStep("", "287082", 59_000, null)).toBeNull();
    expect(
      matchTotpStep(null as unknown as string, "287082", 59_000, null),
    ).toBeNull();
  });

  it("bildet gemockte Zufallsbytes deterministisch ab und nutzt danach die echte Quelle", async () => {
    const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
    const randomBytesMock = randomBytes as unknown as {
      mockImplementation: (impl: (size: number) => Buffer) => void;
      mockImplementationOnce: (impl: (size: number) => Buffer) => void;
    };

    const fixedBytes = Buffer.from(Array.from({ length: 20 }, (_unused, index) => index * 8 + 3));

    randomBytesMock.mockImplementationOnce((size: number) => {
      expect(size).toBe(20);
      return Buffer.from(fixedBytes);
    });

    const secret = generateTotpSecret();
    expect(secret).toBe(referenceEncodeBase32(fixedBytes));
    expect(referenceDecodeBase32(secret)).toEqual(fixedBytes);

    randomBytesMock.mockImplementation(
      actual.randomBytes as unknown as (size: number) => Buffer,
    );

    const afterReset = generateTotpSecret();
    expect(afterReset).toHaveLength(32);
    expect(afterReset).not.toBe(secret);
    expect(referenceDecodeBase32(afterReset)).toHaveLength(20);
    expect(referenceEncodeBase32(referenceDecodeBase32(afterReset))).toBe(afterReset);
  });
});
