import { describe, expect, it } from "vitest";
import {
  canonicalCommandContent,
  commandContentFingerprint,
} from "../../../src/modules/remoteControl/index.js";

describe("CX-012 kanonischer Befehlsinhalt", () => {
  it("bildet denselben Sollzustand stabil auf denselben Fingerprint ab", () => {
    const first = commandContentFingerprint({
      taxiId: "SYN-CX-012-TAXI-A",
      desiredPaused: true,
      origin: "admin",
    });
    const second = commandContentFingerprint({
      taxiId: "SYN-CX-012-TAXI-A",
      desiredPaused: true,
      origin: "admin",
    });

    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("unterscheidet Pause und Fortsetzen sowie verschiedene Taxis", () => {
    const pause = commandContentFingerprint({
      taxiId: "SYN-CX-012-TAXI-A",
      desiredPaused: true,
      origin: "admin",
    });
    const resume = commandContentFingerprint({
      taxiId: "SYN-CX-012-TAXI-A",
      desiredPaused: false,
      origin: "admin",
    });
    const otherTaxi = commandContentFingerprint({
      taxiId: "SYN-CX-012-TAXI-B",
      desiredPaused: true,
      origin: "admin",
    });

    expect(resume).not.toBe(pause);
    expect(otherTaxi).not.toBe(pause);
  });

  it("haelt den kanonischen Text unabhaengig von der erwarteten Revision", () => {
    expect(
      canonicalCommandContent({
        taxiId: "SYN-CX-012-TAXI-A",
        desiredPaused: false,
        origin: "admin",
      }),
    ).toBe('["cx-012","admin","SYN-CX-012-TAXI-A","resume"]');
  });
});
