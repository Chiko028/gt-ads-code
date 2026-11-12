import { describe, expect, it } from "vitest";
import {
  CLASSIFICATION_KEYS,
  EvaluationInputError,
  classifyDay,
  parseLocalDate,
  zonedDayRange,
  type EvaluationPolicy,
} from "../../../src/modules/telemetryEvaluation/index.js";

const HOUR = 3_600_000;

function policy(): EvaluationPolicy {
  return {
    policyVersion: "cx010-tz-v1",
    maxObservationAgeSeconds: 3600,
    e36: { pauseResetOnVehicleOff: false, pauseMaxSeconds: null },
    e40: { displayRunOnSeconds: 120 },
  };
}

describe("zonierte Tagesgrenzen", () => {
  it("ergibt fuer Europe/Vienna am 29.03.2026 eine Tageslaenge von 23 Stunden", () => {
    const range = zonedDayRange(parseLocalDate("2026-03-29"), "Europe/Vienna");

    expect(range.dayLengthMs).toBe(23 * HOUR);
    expect(new Date(range.startMs).toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(new Date(range.endMs).toISOString()).toBe("2026-03-29T22:00:00.000Z");
  });

  it("ergibt fuer Europe/Vienna am 25.10.2026 eine Tageslaenge von 25 Stunden", () => {
    const range = zonedDayRange(parseLocalDate("2026-10-25"), "Europe/Vienna");

    expect(range.dayLengthMs).toBe(25 * HOUR);
    expect(new Date(range.startMs).toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(new Date(range.endMs).toISOString()).toBe("2026-10-25T23:00:00.000Z");
  });

  it("summiert die Klassen zur tatsaechlichen Tageslaenge an beiden Umstellungstagen", () => {
    for (const localDate of ["2026-03-29", "2026-10-25"]) {
      const result = classifyDay({
        tabletId: "tablet-cx010-tz",
        localDate,
        timeZone: "Europe/Vienna",
        evaluatedAt: "2026-11-01T00:00:00.000Z",
        observations: [],
        policy: policy(),
      });

      const sum = CLASSIFICATION_KEYS.reduce(
        (total, key) => total + result.classes[key],
        0,
      );
      expect(sum).toBe(result.dayLengthMs);
      expect(result.classes.unknown).toBe(result.dayLengthMs);
    }
  });

  it("weist feste UTC-Offsets und unbekannte Zeitzonen zurueck", () => {
    for (const timeZone of ["+01:00", "UTC+2", "Not/AZone", ""]) {
      expect(() =>
        classifyDay({
          tabletId: "tablet-cx010-tz",
          localDate: "2026-09-01",
          timeZone,
          evaluatedAt: "2026-09-02T00:00:00.000Z",
          observations: [],
          policy: policy(),
        }),
      ).toThrow(EvaluationInputError);
    }
  });

  it("weist ungueltige lokale Kalenderdaten zurueck", () => {
    expect(() => parseLocalDate("2026-02-30")).toThrow(EvaluationInputError);
    expect(() => parseLocalDate("29.03.2026")).toThrow(EvaluationInputError);
  });
});
