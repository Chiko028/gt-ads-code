import { describe, expect, it } from "vitest";
import {
  assessRetentionDay,
  canonicalize,
  computeInputFingerprint,
  validateRetentionRule,
  type RetentionDayAssessmentInput,
  type SnapshotObservation,
} from "../../../src/modules/telemetryRollups/index.js";

const DAY_MS = 86_400_000;

function observation(
  eventId: string,
  occurredAtMs: number,
  receivedAtMs: number,
  overrides: Partial<SnapshotObservation> = {},
): SnapshotObservation {
  return {
    eventId,
    occurredAt: new Date(occurredAtMs).toISOString(),
    receivedAt: new Date(receivedAtMs).toISOString(),
    vehicleReady: true,
    paused: false,
    playback: "playing",
    technicalFault: false,
    priorToDay: false,
    ...overrides,
  };
}

function assessment(
  overrides: Partial<RetentionDayAssessmentInput> = {},
): RetentionDayAssessmentInput {
  const dayStartMs = Date.parse("2026-03-01T00:00:00.000Z");
  const dayEndMs = dayStartMs + DAY_MS;
  return {
    dayStartMs,
    dayEndMs,
    evaluationTimeMs: Date.parse("2026-07-01T12:00:00.000Z"),
    horizonStartMs: Date.parse("2026-04-02T00:00:00.000Z"),
    rollupEvaluationTimeMs: dayEndMs + 3_600_000,
    rollupDayStartMs: dayStartMs,
    rollupDayEndMs: dayEndMs,
    rawObservationCount: 2,
    latestRawOccurredAtMs: dayStartMs + 3_600_000,
    latestRawReceivedAtMs: dayStartMs + 7_200_000,
    fingerprintMatches: true,
    ...overrides,
  };
}

describe("CX-011 kanonischer Policy-Inhalt", () => {
  it("ist unabhaengig von der Schluesselreihenfolge", () => {
    const left = { b: 1, a: { d: true, c: "x" } };
    const right = { a: { c: "x", d: true }, b: 1 };
    expect(canonicalize(left)).toBe(canonicalize(right));
    expect(canonicalize(left)).toBe('{"a":{"c":"x","d":true},"b":1}');
  });

  it("weist nicht-endliche Zahlen ab", () => {
    expect(() => canonicalize({ a: Number.NaN })).toThrow(/Nicht-endliche/);
  });
});

describe("CX-011 Eingabe-Fingerprint", () => {
  const base = {
    deviceId: "11111111-1111-4111-8111-111111111111",
    localDate: "2026-03-01",
    timeZone: "Europe/Berlin",
    policyCanonical: '{"policyVersion":"p1"}',
    algorithmVersion: "cx-011-rollup-v1",
    dayStartMs: Date.parse("2026-02-28T23:00:00.000Z"),
    dayEndMs: Date.parse("2026-03-01T23:00:00.000Z"),
    priorObservation: null,
  };

  it("ist reihenfolgeunabhaengig und aendert sich mit fachlichem Inhalt", () => {
    const first = observation(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      base.dayStartMs + 3_600_000,
      base.dayStartMs + 7_200_000,
    );
    const second = observation(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      base.dayStartMs + 7_200_000,
      base.dayStartMs + 9_000_000,
      { playback: "stopped" },
    );
    const left = computeInputFingerprint({
      ...base,
      observations: [first, second],
    });
    const right = computeInputFingerprint({
      ...base,
      observations: [second, first],
    });
    expect(left).toBe(right);

    const changed = computeInputFingerprint({
      ...base,
      observations: [first, { ...second, playback: "playing" }],
    });
    expect(changed).not.toBe(left);
  });

  it("beruecksichtigt die letzte Beobachtung vor Tagesbeginn", () => {
    const prior = observation(
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      base.dayStartMs - 1_800_000,
      base.dayStartMs - 1_700_000,
      { priorToDay: true },
    );
    const without = computeInputFingerprint({ ...base, observations: [] });
    const withPrior = computeInputFingerprint({
      ...base,
      priorObservation: prior,
      observations: [],
    });
    expect(withPrior).not.toBe(without);
  });
});

describe("CX-011 reine Retention-Bewertung", () => {
  it("schlaegt einen vollstaendig auswertbaren alten Tag vor", () => {
    expect(assessRetentionDay(assessment())).toEqual({
      eligible: true,
      reasons: [],
    });
  });

  it("haelt nicht abgeschlossene Tage mit Grund zurueck", () => {
    const result = assessRetentionDay(
      assessment({ evaluationTimeMs: Date.parse("2026-03-01T12:00:00.000Z") }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("day_not_completed");
  });

  it("haelt Tage innerhalb des Horizonts zurueck", () => {
    const result = assessRetentionDay(
      assessment({ horizonStartMs: Date.parse("2026-02-01T00:00:00.000Z") }),
    );
    expect(result.reasons).toContain("inside_retention_horizon");
  });

  it("verlangt Ereignis- und Empfangszeit ausserhalb des Horizonts", () => {
    const eventInside = assessRetentionDay(
      assessment({
        latestRawOccurredAtMs: Date.parse("2026-04-02T00:00:00.000Z"),
      }),
    );
    expect(eventInside.reasons).toContain("raw_event_inside_horizon");

    const receivedInside = assessRetentionDay(
      assessment({
        latestRawReceivedAtMs: Date.parse("2026-04-02T00:00:00.000Z"),
      }),
    );
    expect(receivedInside.reasons).toContain("raw_received_inside_horizon");
  });

  it("haelt Tage mit veraltetem Rollup oder fehlenden Rohdaten zurueck", () => {
    const beforeDayEnd = assessRetentionDay(
      assessment({ rollupEvaluationTimeMs: Date.parse("2026-03-01T12:00:00.000Z") }),
    );
    expect(beforeDayEnd.reasons).toContain("rollup_before_day_end");

    const mismatch = assessRetentionDay(
      assessment({ fingerprintMatches: false }),
    );
    expect(mismatch.reasons).toContain("raw_fingerprint_mismatch");

    const empty = assessRetentionDay(
      assessment({
        rawObservationCount: 0,
        latestRawOccurredAtMs: null,
        latestRawReceivedAtMs: null,
      }),
    );
    expect(empty.reasons).toContain("no_raw_data");

    const wrongDay = assessRetentionDay(
      assessment({ rollupDayStartMs: 0 }),
    );
    expect(wrongDay.reasons).toContain("rollup_day_mismatch");
  });

  it("gibt Gruende in stabiler Reihenfolge aus", () => {
    const result = assessRetentionDay(
      assessment({
        evaluationTimeMs: Date.parse("2026-03-01T12:00:00.000Z"),
        horizonStartMs: Date.parse("2026-02-01T00:00:00.000Z"),
        fingerprintMatches: false,
      }),
    );
    expect(result.reasons).toEqual([
      "day_not_completed",
      "inside_retention_horizon",
      "raw_event_inside_horizon",
      "raw_received_inside_horizon",
      "raw_fingerprint_mismatch",
    ]);
  });
});

describe("CX-011 Retention-Regel", () => {
  it("verlangt eine explizite Regelversion und positive ganze Tage", () => {
    expect(
      validateRetentionRule({ ruleVersion: "draft-90", rawRetentionDays: 90 }),
    ).toEqual({ ruleVersion: "draft-90", rawRetentionDays: 90 });
    expect(() =>
      validateRetentionRule({ ruleVersion: "", rawRetentionDays: 90 }),
    ).toThrow(/ruleVersion/);
    for (const days of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        validateRetentionRule({ ruleVersion: "r", rawRetentionDays: days }),
      ).toThrow(/positive Ganzzahl/);
    }
  });
});
