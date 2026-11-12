import { describe, expect, it } from "vitest";
import {
  deriveConnectivity,
  isReachable,
} from "../../src/modules/devices/status.js";

const THRESHOLD_SECONDS = 1800;
const BASE_TIME = Date.parse("2026-01-01T12:00:00.000Z");

function at(ms: number): Date {
  return new Date(ms);
}

describe("U-06 Statusableitung connectivity (AC-10)", () => {
  it("Grenzwerte: Schwelle-1 s, Schwelle, Schwelle+1 s", () => {
    const lastSeenAt = at(BASE_TIME);

    expect(
      deriveConnectivity({
        lastSeenAt,
        serverTime: at(BASE_TIME + (THRESHOLD_SECONDS - 1) * 1000),
        onlineThresholdSeconds: THRESHOLD_SECONDS,
      }),
    ).toBe("reachable");

    // Grenzfall: genau die Schwelle gilt als erreichbar (API-VERTRAG 5).
    expect(
      deriveConnectivity({
        lastSeenAt,
        serverTime: at(BASE_TIME + THRESHOLD_SECONDS * 1000),
        onlineThresholdSeconds: THRESHOLD_SECONDS,
      }),
    ).toBe("reachable");

    expect(
      deriveConnectivity({
        lastSeenAt,
        serverTime: at(BASE_TIME + (THRESHOLD_SECONDS + 1) * 1000),
        onlineThresholdSeconds: THRESHOLD_SECONDS,
      }),
    ).toBe("last_seen");

    expect(
      isReachable({
        lastSeenAt,
        serverTime: at(BASE_TIME + THRESHOLD_SECONDS * 1000),
        onlineThresholdSeconds: THRESHOLD_SECONDS,
      }),
    ).toBe(true);
  });

  it("Sommerzeitwechsel in Europe/Vienna veraendert die absolute Differenz nicht", () => {
    // 2026-03-29 02:00 CET -> 03:00 CEST (01:00 UTC).
    const springSwitch = Date.parse("2026-03-29T01:00:00.000Z");
    const springLastSeen = at(springSwitch - 30 * 60 * 1000);
    expect(
      deriveConnectivity({
        lastSeenAt: springLastSeen,
        serverTime: at(springSwitch),
        onlineThresholdSeconds: THRESHOLD_SECONDS,
      }),
    ).toBe("reachable");
    expect(
      deriveConnectivity({
        lastSeenAt: springLastSeen,
        serverTime: at(springSwitch + 1),
        onlineThresholdSeconds: THRESHOLD_SECONDS,
      }),
    ).toBe("last_seen");

    // 2026-10-25 03:00 CEST -> 02:00 CET (01:00 UTC).
    const autumnSwitch = Date.parse("2026-10-25T01:00:00.000Z");
    const autumnLastSeen = at(autumnSwitch - 30 * 60 * 1000);
    expect(
      deriveConnectivity({
        lastSeenAt: autumnLastSeen,
        serverTime: at(autumnSwitch),
        onlineThresholdSeconds: THRESHOLD_SECONDS,
      }),
    ).toBe("reachable");
    expect(
      deriveConnectivity({
        lastSeenAt: autumnLastSeen,
        serverTime: at(autumnSwitch + 1),
        onlineThresholdSeconds: THRESHOLD_SECONDS,
      }),
    ).toBe("last_seen");
  });

  it("Serverzeit vor last_seen_at (Uhrabweichung) gilt als erreichbar", () => {
    expect(
      deriveConnectivity({
        lastSeenAt: at(BASE_TIME),
        serverTime: at(BASE_TIME - 5000),
        onlineThresholdSeconds: THRESHOLD_SECONDS,
      }),
    ).toBe("reachable");
  });

  it("ungueltige Schwelle wird abgelehnt, statt einen Status zu erfinden", () => {
    expect(() =>
      deriveConnectivity({
        lastSeenAt: at(BASE_TIME),
        serverTime: at(BASE_TIME),
        onlineThresholdSeconds: -1,
      }),
    ).toThrow(RangeError);
    expect(() =>
      deriveConnectivity({
        lastSeenAt: at(BASE_TIME),
        serverTime: at(BASE_TIME),
        onlineThresholdSeconds: Number.NaN,
      }),
    ).toThrow(RangeError);
  });
});
