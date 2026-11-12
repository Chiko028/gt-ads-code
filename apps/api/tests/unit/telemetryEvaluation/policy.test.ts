import { describe, expect, it } from "vitest";
import {
  EvaluationConfigError,
  classifyDay,
  type EvaluationInput,
  type EvaluationPolicy,
} from "../../../src/modules/telemetryEvaluation/index.js";

function inputWith(policy: unknown): EvaluationInput {
  return {
    tabletId: "tablet-cx010-policy",
    localDate: "2026-09-01",
    timeZone: "UTC",
    evaluatedAt: "2026-09-02T00:00:00.000Z",
    observations: [],
    policy: policy as EvaluationPolicy,
  };
}

function validPolicy(): EvaluationPolicy {
  return {
    policyVersion: "cx010-policy-v1",
    maxObservationAgeSeconds: 3600,
    e36: { pauseResetOnVehicleOff: false, pauseMaxSeconds: null },
    e40: { displayRunOnSeconds: 120 },
  };
}

describe("Policy-Validierung", () => {
  it("verhindert die Auswertung ohne E36-Konfiguration", () => {
    const policy = validPolicy() as unknown as Record<string, unknown>;
    delete policy.e36;

    expect(() => classifyDay(inputWith(policy))).toThrow(EvaluationConfigError);
    expect(() => classifyDay(inputWith(policy))).toThrow(/e36/);
  });

  it("verhindert die Auswertung ohne E40-Konfiguration", () => {
    const policy = validPolicy() as unknown as Record<string, unknown>;
    delete policy.e40;

    expect(() => classifyDay(inputWith(policy))).toThrow(EvaluationConfigError);
    expect(() => classifyDay(inputWith(policy))).toThrow(/e40/);
  });

  it("verhindert die Auswertung bei unvollstaendigen E36-Werten", () => {
    const missingPauseMax = {
      ...validPolicy(),
      e36: { pauseResetOnVehicleOff: true },
    };
    const missingReset = {
      ...validPolicy(),
      e36: { pauseMaxSeconds: null },
    };

    expect(() => classifyDay(inputWith(missingPauseMax))).toThrow(
      EvaluationConfigError,
    );
    expect(() => classifyDay(inputWith(missingReset))).toThrow(
      EvaluationConfigError,
    );
  });

  it("verhindert die Auswertung bei ungueltigen Policy-Werten", () => {
    const cases: unknown[] = [
      { ...validPolicy(), maxObservationAgeSeconds: 0 },
      { ...validPolicy(), maxObservationAgeSeconds: -1 },
      { ...validPolicy(), maxObservationAgeSeconds: Number.NaN },
      {
        ...validPolicy(),
        e36: { pauseResetOnVehicleOff: false, pauseMaxSeconds: 0 },
      },
      {
        ...validPolicy(),
        e36: { pauseResetOnVehicleOff: false, pauseMaxSeconds: 1.5 },
      },
      { ...validPolicy(), e40: { displayRunOnSeconds: -1 } },
      { ...validPolicy(), e40: { displayRunOnSeconds: 1.5 } },
      { ...validPolicy(), policyVersion: "" },
      { ...validPolicy(), policyVersion: undefined },
    ];

    for (const policy of cases) {
      expect(() => classifyDay(inputWith(policy))).toThrow(
        EvaluationConfigError,
      );
    }
  });

  it("akzeptiert die expliziten Grenzwerte null und 0", () => {
    const policy = validPolicy();
    policy.e36.pauseMaxSeconds = null;
    policy.e40.displayRunOnSeconds = 0;

    const result = classifyDay(inputWith(policy));
    expect(result.policyVersion).toBe("cx010-policy-v1");
    expect(result.classes.unknown).toBe(result.dayLengthMs);
  });
});
