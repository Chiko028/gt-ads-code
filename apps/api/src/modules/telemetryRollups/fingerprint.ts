import { createHash } from "node:crypto";
import type { SnapshotObservation } from "./types.js";

export interface InputFingerprintInput {
  deviceId: string;
  localDate: string;
  timeZone: string;
  policyCanonical: string;
  algorithmVersion: string;
  dayStartMs: number;
  dayEndMs: number;
  priorObservation: SnapshotObservation | null;
  observations: readonly SnapshotObservation[];
}

function observationTuple(observation: SnapshotObservation): unknown[] {
  return [
    observation.eventId.toLowerCase(),
    observation.occurredAt,
    observation.receivedAt,
    observation.vehicleReady,
    observation.paused,
    observation.playback,
    observation.technicalFault,
  ];
}

function ordered(observations: readonly SnapshotObservation[]): SnapshotObservation[] {
  return [...observations].sort((left, right) => {
    const byTime = Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
    return byTime !== 0
      ? byTime
      : left.eventId.toLowerCase().localeCompare(right.eventId.toLowerCase());
  });
}

/**
 * Fingerprint des tatsaechlich wirksamen fachlichen Eingangs.
 * Die Reihenfolge der Uebergabe ist ohne Bedeutung; der Auswertungszeitpunkt
 * ist bewusst nicht Teil des Fingerprints (er wird separat verglichen).
 */
export function computeInputFingerprint(input: InputFingerprintInput): string {
  const payload = {
    schema: "cx-011-input-v1",
    deviceId: input.deviceId.toLowerCase(),
    localDate: input.localDate,
    timeZone: input.timeZone,
    policyCanonical: input.policyCanonical,
    algorithmVersion: input.algorithmVersion,
    dayStartMs: input.dayStartMs,
    dayEndMs: input.dayEndMs,
    prior:
      input.priorObservation === null
        ? null
        : observationTuple(input.priorObservation),
    observations: ordered(input.observations).map(observationTuple),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
