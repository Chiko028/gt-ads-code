import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TelemetryConflictError, TelemetryValidationError } from "../../../src/modules/telemetry/errors.js";
import {
  collapseDuplicateObservations,
  normalizeDeviceId,
  normalizeObservationBatch,
} from "../../../src/modules/telemetry/validation.js";

function rawEvent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    event_id: randomUUID(),
    occurred_at: "2026-01-01T12:00:00.000Z",
    vehicle_ready: true,
    paused: false,
    playback: "playing",
    technical_fault: false,
    ...overrides,
  };
}

describe("CX-009 Ereignisvalidierung", () => {
  it("akzeptiert kanonische UTC-Zeitpunkte mit Millisekunden", () => {
    const value = randomUUID().toUpperCase();
    const [parsed] = normalizeObservationBatch([
      rawEvent({ event_id: value, occurred_at: "2030-12-31T23:59:59.999Z" }),
    ]);
    expect(parsed?.eventId).toBe(value.toLowerCase());
    expect(parsed?.occurredAt).toBe("2030-12-31T23:59:59.999Z");
  });

  it("weist nicht kanonische oder unmoegliche Zeitpunkte ab", () => {
    const invalidTimestamps = [
      "2026-01-01T12:00:00Z",
      "2026-01-01T12:00:00.000+00:00",
      "2026-01-01T13:00:00.000+01:00",
      "2026-02-30T12:00:00.000Z",
      "2026-13-01T12:00:00.000Z",
      "2026-01-01 12:00:00.000Z",
      "2026-01-01T12:00:00.00Z",
    ];
    for (const occurredAt of invalidTimestamps) {
      expect(() =>
        normalizeObservationBatch([rawEvent({ occurred_at: occurredAt })]),
      ).toThrow(TelemetryValidationError);
    }
  });

  it("verbietet unbekannte Felder, GPS und freie Texte", () => {
    for (const extra of [
      { extra: true },
      { gps: "aus" },
      { gps_mode: "aus" },
      { latitude: 52.5 },
      { longitude: 13.4 },
      { location: "SYN-Ort" },
      { text: "SYN-Freitext" },
    ]) {
      expect(() =>
        normalizeObservationBatch([rawEvent(extra)]),
      ).toThrow(TelemetryValidationError);
    }
  });

  it("verlangt alle Felder, erlaubt aber null bei den drei Zustandsfeldern", () => {
    expect(() =>
      normalizeObservationBatch([
        {
          event_id: randomUUID(),
          occurred_at: "2026-01-01T12:00:00.000Z",
          vehicle_ready: true,
          paused: false,
          playback: "playing",
        },
      ]),
    ).toThrow(TelemetryValidationError);

    const [parsed] = normalizeObservationBatch([
      rawEvent({
        vehicle_ready: null,
        paused: null,
        technical_fault: null,
        playback: "unknown",
      }),
    ]);
    expect(parsed?.vehicleReady).toBeNull();
    expect(parsed?.paused).toBeNull();
    expect(parsed?.technicalFault).toBeNull();
    expect(parsed?.playback).toBe("unknown");
  });

  it("erzwingt Batchgroessen von 1 bis 100", () => {
    expect(normalizeObservationBatch([rawEvent()])).toHaveLength(1);
    expect(
      normalizeObservationBatch(Array.from({ length: 100 }, () => rawEvent())),
    ).toHaveLength(100);
    expect(() => normalizeObservationBatch([])).toThrow(
      TelemetryValidationError,
    );
    expect(() =>
      normalizeObservationBatch(Array.from({ length: 101 }, () => rawEvent())),
    ).toThrow(TelemetryValidationError);
  });

  it("validiert die Geraete-ID separat und normalisiert Schreibweise", () => {
    const id = randomUUID().toUpperCase();
    expect(normalizeDeviceId(id)).toBe(id.toLowerCase());
    expect(() => normalizeDeviceId("keine-uuid")).toThrow(
      TelemetryValidationError,
    );
  });

  it("fasst identische Wiederholungen zusammen und erkennt abweichende Wiederholungen", () => {
    const event = rawEvent();
    const batch = normalizeObservationBatch([event, event, event]);
    const collapsed = collapseDuplicateObservations(batch);
    expect(collapsed.observations).toHaveLength(1);
    expect(collapsed.duplicateEventIds).toHaveLength(2);

    const conflicting = normalizeObservationBatch([
      event,
      { ...event, paused: true },
    ]);
    expect(() => collapseDuplicateObservations(conflicting)).toThrow(
      TelemetryConflictError,
    );
  });
});
