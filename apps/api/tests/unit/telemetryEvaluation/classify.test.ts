import { describe, expect, it } from "vitest";
import {
  CLASSIFICATION_KEYS,
  classifyDay,
  type ClassificationKey,
  type DayClassification,
  type EvaluationInput,
  type EvaluationPolicy,
  type NormalizedObservation,
} from "../../../src/modules/telemetryEvaluation/index.js";

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 24 * HOUR;

let eventSequence = 0;

function nextEventId(): string {
  eventSequence += 1;
  return (
    "00000000-0000-4000-8000-" +
    String(eventSequence).padStart(12, "0")
  );
}

function observation(
  occurredAt: string,
  changes: Partial<
    Pick<
      NormalizedObservation,
      "vehicleReady" | "paused" | "playback" | "technicalFault"
    >
  > = {},
): NormalizedObservation {
  return {
    eventId: nextEventId(),
    occurredAt,
    vehicleReady: true,
    paused: false,
    playback: "playing",
    technicalFault: false,
    ...changes,
  };
}

function duplicate(source: NormalizedObservation): NormalizedObservation {
  return { ...source, eventId: nextEventId() };
}

function basePolicy(
  changes: {
    maxObservationAgeSeconds?: number;
    e36?: Partial<EvaluationPolicy["e36"]>;
    e40?: Partial<EvaluationPolicy["e40"]>;
  } = {},
): EvaluationPolicy {
  return {
    policyVersion: "cx010-test-v1",
    maxObservationAgeSeconds: changes.maxObservationAgeSeconds ?? 3600,
    e36: {
      pauseResetOnVehicleOff: false,
      pauseMaxSeconds: null,
      ...changes.e36,
    },
    e40: {
      displayRunOnSeconds: 120,
      ...changes.e40,
    },
  };
}

function evaluationInput(
  changes: {
    observations?: readonly NormalizedObservation[];
    policy?: EvaluationPolicy;
    localDate?: string;
    timeZone?: string;
    evaluatedAt?: string;
  } = {},
): EvaluationInput {
  return {
    tabletId: "tablet-cx010-01",
    localDate: changes.localDate ?? "2026-09-01",
    timeZone: changes.timeZone ?? "UTC",
    evaluatedAt: changes.evaluatedAt ?? "2026-09-02T00:00:00.000Z",
    observations: changes.observations ?? [],
    policy: changes.policy ?? basePolicy(),
  };
}

function classSum(result: DayClassification): number {
  return CLASSIFICATION_KEYS.reduce(
    (sum: number, key: ClassificationKey) => sum + result.classes[key],
    0,
  );
}

describe("classifyDay: synthetischer Verlauf", () => {
  it("liefert exakt erwartete Millisekunden fuer alle fuenf Klassen", () => {
    const result = classifyDay(
      evaluationInput({
        observations: [
          observation("2026-09-01T00:00:00.000Z"),
          observation("2026-09-01T01:00:00.000Z", {
            vehicleReady: false,
            playback: "stopped",
          }),
          observation("2026-09-01T02:00:00.000Z", {
            technicalFault: true,
            playback: "stopped",
          }),
          observation("2026-09-01T03:00:00.000Z", { paused: true }),
          observation("2026-09-01T04:00:00.000Z", {
            vehicleReady: null,
            paused: null,
            playback: "unknown",
            technicalFault: null,
          }),
          observation("2026-09-01T05:00:00.000Z"),
        ],
      }),
    );

    expect(result.dayLengthMs).toBe(DAY);
    expect(result.classes).toEqual({
      healthy: 2 * HOUR,
      vehicle_off_expected: 1 * HOUR,
      paused_conscious: 1 * HOUR,
      technical_fault: 1 * HOUR,
      unknown: 19 * HOUR,
    });
    expect(classSum(result)).toBe(result.dayLengthMs);

    expect(result.dimensions.vehicleOffMs).toBe(1 * HOUR);
    expect(result.dimensions.vehicleReadyMs).toBe(4 * HOUR);
    expect(result.dimensions.vehicleUnknownMs).toBe(19 * HOUR);
    expect(result.dimensions.pausedMs).toBe(1 * HOUR);
    expect(result.dimensions.notPausedMs).toBe(4 * HOUR);
    expect(result.dimensions.pauseUnknownMs).toBe(19 * HOUR);
    expect(result.dimensions.technicalFaultMs).toBe(1 * HOUR);

    expect(result.expectedPlaybackMs).toBeNull();
    expect(result.expectedPlaybackReason).toBe(
      "Kampagnen- und Zuordnungsevidenz fehlt",
    );
    expect(result.policyVersion).toBe("cx010-test-v1");
  });
});

describe("classifyDay: Beobachtungen und Evidenz", () => {
  it("meldet fehlende Beobachtungen als Unbekannt statt als technischen Fehler", () => {
    const result = classifyDay(
      evaluationInput({
        evaluatedAt: "2026-09-01T12:00:00.000Z",
        observations: [],
      }),
    );

    expect(result.classes.unknown).toBe(DAY);
    expect(result.classes.technical_fault).toBe(0);
    expect(result.observationCoverage.coveredMs).toBe(0);
    expect(result.observationCoverage.ratio).toBe(0);
  });

  it("behandelt veraltete Beobachtungen als Unbekannt statt als technischen Fehler", () => {
    const result = classifyDay(
      evaluationInput({
        evaluatedAt: "2026-09-01T12:00:00.000Z",
        policy: basePolicy({ maxObservationAgeSeconds: 600 }),
        observations: [observation("2026-09-01T00:00:00.000Z")],
      }),
    );

    expect(result.classes.healthy).toBe(10 * MINUTE);
    expect(result.classes.technical_fault).toBe(0);
    expect(result.classes.unknown).toBe(DAY - 10 * MINUTE);
  });

  it("laesst eine frische Beobachtung vor Tagesbeginn hoechstens bis zum Frischeablauf gelten", () => {
    const fresh = classifyDay(
      evaluationInput({
        evaluatedAt: "2026-09-01T12:00:00.000Z",
        observations: [observation("2026-08-31T23:50:00.000Z")],
      }),
    );
    expect(fresh.classes.healthy).toBe(50 * MINUTE);
    expect(fresh.classes.unknown).toBe(DAY - 50 * MINUTE);

    const stale = classifyDay(
      evaluationInput({
        evaluatedAt: "2026-09-01T12:00:00.000Z",
        observations: [observation("2026-08-31T22:00:00.000Z")],
      }),
    );
    expect(stale.classes.healthy).toBe(0);
    expect(stale.classes.unknown).toBe(DAY);
  });

  it("ignoriert Beobachtungen nach dem Auswertungszeitpunkt und laesst zukuenftige Tagesabschnitte unbekannt", () => {
    const result = classifyDay(
      evaluationInput({
        evaluatedAt: "2026-09-01T00:30:00.000Z",
        observations: [
          observation("2026-09-01T00:00:00.000Z"),
          observation("2026-09-01T23:00:00.000Z"),
        ],
      }),
    );

    expect(result.classes.healthy).toBe(30 * MINUTE);
    expect(result.classes.unknown).toBe(DAY - 30 * MINUTE);
    expect(result.observationCoverage.coveredMs).toBe(30 * MINUTE);

    const beforeDay = classifyDay(
      evaluationInput({
        evaluatedAt: "2026-08-31T23:00:00.000Z",
        observations: [observation("2026-09-01T23:00:00.000Z")],
      }),
    );
    expect(beforeDay.classes.unknown).toBe(DAY);
  });

  it("korrigiert die erneute Berechnung durch einen verspaeteten Datensatz", () => {
    const before = classifyDay(
      evaluationInput({
        evaluatedAt: "2026-09-01T12:00:00.000Z",
        observations: [observation("2026-09-01T00:00:00.000Z")],
      }),
    );
    const after = classifyDay(
      evaluationInput({
        evaluatedAt: "2026-09-01T12:00:00.000Z",
        observations: [
          observation("2026-09-01T00:00:00.000Z"),
          observation("2026-09-01T06:00:00.000Z", {
            technicalFault: true,
            playback: "stopped",
          }),
        ],
      }),
    );

    expect(before.classes.technical_fault).toBe(0);
    expect(before.classes.unknown).toBe(23 * HOUR);
    expect(after.classes.technical_fault).toBe(1 * HOUR);
    expect(after.classes.unknown).toBe(22 * HOUR);
    expect(after.classes).not.toEqual(before.classes);
  });

  it("erzeugt bei Duplikaten und permutierter Eingabe dasselbe Ergebnis", () => {
    const healthy = observation("2026-09-01T00:00:00.000Z");
    const vehicleOff = observation("2026-09-01T01:00:00.000Z", {
      vehicleReady: false,
      playback: "stopped",
    });
    const paused = observation("2026-09-01T02:00:00.000Z", { paused: true });

    const ordered = classifyDay(
      evaluationInput({
        evaluatedAt: "2026-09-01T04:00:00.000Z",
        observations: [healthy, vehicleOff, paused],
      }),
    );
    const permuted = classifyDay(
      evaluationInput({
        evaluatedAt: "2026-09-01T04:00:00.000Z",
        observations: [
          duplicate(paused),
          duplicate(vehicleOff),
          healthy,
          duplicate(healthy),
          paused,
          vehicleOff,
        ],
      }),
    );

    expect(permuted).toEqual(ordered);
  });

  it("behandelt widerspruechliche Beobachtungen desselben Zeitpunkts bis zur naechsten eindeutigen Beobachtung als Unbekannt", () => {
    const result = classifyDay(
      evaluationInput({
        evaluatedAt: "2026-09-01T03:00:00.000Z",
        observations: [
          observation("2026-09-01T00:00:00.000Z"),
          observation("2026-09-01T01:00:00.000Z"),
          observation("2026-09-01T01:00:00.000Z", {
            technicalFault: true,
            playback: "stopped",
          }),
          observation("2026-09-01T02:00:00.000Z"),
        ],
      }),
    );

    expect(result.classes.healthy).toBe(2 * HOUR);
    expect(result.classes.technical_fault).toBe(0);
    expect(result.classes.unknown).toBe(22 * HOUR);
    expect(result.observationCoverage.coveredMs).toBe(3 * HOUR);
    expect(result.observationCoverage.conflictedMs).toBe(1 * HOUR);
  });

  it("meldet vollstaendige Abdeckung, wenn eine frische Beobachtung den ganzen Tag traegt", () => {
    const result = classifyDay(
      evaluationInput({
        policy: basePolicy({ maxObservationAgeSeconds: 90_000 }),
        observations: [observation("2026-09-01T00:00:00.000Z")],
      }),
    );

    expect(result.classes.healthy).toBe(DAY);
    expect(result.observationCoverage.coveredMs).toBe(DAY);
    expect(result.observationCoverage.ratio).toBe(1);
  });
});

describe("classifyDay: E36 Pausenregeln", () => {
  it("verlaengert eine maximale Pausendauer nicht durch Wiederholungsmeldungen", () => {
    const result = classifyDay(
      evaluationInput({
        evaluatedAt: "2026-09-01T01:00:00.000Z",
        policy: basePolicy({
          e36: { pauseMaxSeconds: 1800 },
        }),
        observations: [
          observation("2026-09-01T00:00:00.000Z", { paused: true }),
          observation("2026-09-01T00:10:00.000Z", { paused: true }),
          observation("2026-09-01T00:20:00.000Z", { paused: true }),
          observation("2026-09-01T00:25:00.000Z", { paused: true }),
        ],
      }),
    );

    expect(result.classes.paused_conscious).toBe(30 * MINUTE);
    expect(result.dimensions.pausedMs).toBe(30 * MINUTE);
    expect(result.dimensions.pauseUnknownMs).toBe(DAY - 30 * MINUTE);
    expect(result.classes.unknown).toBe(DAY - 30 * MINUTE);
    expect(result.classes.healthy).toBe(0);
  });

  it("setzt eine beobachtete Pause bei Fahrzeug-aus nur mit E36-Reset zurueck", () => {
    const observations = [
      observation("2026-09-01T00:00:00.000Z"),
      observation("2026-09-01T01:00:00.000Z", {
        vehicleReady: false,
        paused: true,
        playback: "stopped",
      }),
      observation("2026-09-01T02:00:00.000Z"),
    ];
    const evaluatedAt = "2026-09-01T03:00:00.000Z";

    const withoutReset = classifyDay(
      evaluationInput({
        evaluatedAt,
        observations,
        policy: basePolicy({ e36: { pauseResetOnVehicleOff: false } }),
      }),
    );
    const withReset = classifyDay(
      evaluationInput({
        evaluatedAt,
        observations,
        policy: basePolicy({ e36: { pauseResetOnVehicleOff: true } }),
      }),
    );

    expect(withoutReset.classes.vehicle_off_expected).toBe(HOUR);
    expect(withoutReset.dimensions.pausedMs).toBe(HOUR);
    expect(withoutReset.dimensions.notPausedMs).toBe(2 * HOUR);

    expect(withReset.classes.vehicle_off_expected).toBe(HOUR);
    expect(withReset.dimensions.pausedMs).toBe(0);
    expect(withReset.dimensions.notPausedMs).toBe(3 * HOUR);
  });
});

describe("classifyDay: Fahrzeug-aus und Display-Nachlauf", () => {
  it("stoppt die fachliche Wiedergabebereitschaft unabhaengig vom Display-Nachlauf", () => {
    const observations = [
      observation("2026-09-01T00:00:00.000Z"),
      observation("2026-09-01T01:00:00.000Z", {
        vehicleReady: false,
        playback: "playing",
      }),
      observation("2026-09-01T02:00:00.000Z"),
    ];
    const evaluatedAt = "2026-09-01T03:00:00.000Z";

    const withoutRunOn = classifyDay(
      evaluationInput({
        evaluatedAt,
        observations,
        policy: basePolicy({ e40: { displayRunOnSeconds: 0 } }),
      }),
    );
    const withLongRunOn = classifyDay(
      evaluationInput({
        evaluatedAt,
        observations,
        policy: basePolicy({ e40: { displayRunOnSeconds: 7200 } }),
      }),
    );

    expect(withoutRunOn.classes.vehicle_off_expected).toBe(HOUR);
    expect(withLongRunOn.classes).toEqual(withoutRunOn.classes);
    expect(withLongRunOn.dimensions).toEqual(withoutRunOn.dimensions);
    expect(withLongRunOn.expectedPlaybackMs).toBeNull();
  });
});

describe("classifyDay: getrennte Zeitdimensionen", () => {
  it("verdeckt Fahrzeug-aus und Pause nicht durch einen technischen Fehler", () => {
    const result = classifyDay(
      evaluationInput({
        evaluatedAt: "2026-09-01T03:00:00.000Z",
        observations: [
          observation("2026-09-01T00:00:00.000Z"),
          observation("2026-09-01T01:00:00.000Z", {
            vehicleReady: false,
            paused: true,
            technicalFault: true,
            playback: "stopped",
          }),
          observation("2026-09-01T02:00:00.000Z"),
        ],
      }),
    );

    expect(result.classes.technical_fault).toBe(HOUR);
    expect(result.classes.vehicle_off_expected).toBe(0);
    expect(result.classes.paused_conscious).toBe(0);
    expect(result.dimensions.technicalFaultMs).toBe(HOUR);
    expect(result.dimensions.vehicleOffMs).toBe(HOUR);
    expect(result.dimensions.pausedMs).toBe(HOUR);
  });
});
