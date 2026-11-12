import { EvaluationInputError } from "./errors.js";
import type {
  ClassificationKey,
  DayClassification,
  EvaluationDimensions,
  EvaluationInput,
  EvaluationPolicy,
} from "./types.js";
import { CLASSIFICATION_KEYS } from "./types.js";
import type { NormalizedObservation, PlaybackState } from "../telemetry/types.js";
import { validatePolicy } from "./policy.js";
import {
  assertIanaTimeZone,
  formatLocalDate,
  parseLocalDate,
  zonedDayRange,
} from "./timeZone.js";

const PLAYBACK_STATES: ReadonlySet<string> = new Set([
  "playing",
  "stopped",
  "unknown",
]);

export const EXPECTED_PLAYBACK_REASON = "Kampagnen- und Zuordnungsevidenz fehlt";

interface Snapshot {
  vehicleReady: boolean | null;
  paused: boolean | null;
  playback: PlaybackState;
  technicalFault: boolean | null;
}

interface Point {
  atMs: number;
  conflict: boolean;
  snapshot: Snapshot | null;
  /** Ende des Beobachtungsfensters (Frische, naechste Beobachtung, Tagesende). */
  windowEndMs: number;
  /** Beginn der zusammenhaengenden Pausenfolge laut E36; null = keine. */
  pauseRunStartMs: number | null;
}

interface ParsedObservation {
  atMs: number;
  snapshot: Snapshot;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBooleanOrNull(
  value: unknown,
  field: string,
  index: number,
): boolean | null {
  if (value !== null && typeof value !== "boolean") {
    throw new EvaluationInputError(
      "observations[" + index + "]." + field + " muss boolean oder null sein.",
    );
  }
  return value;
}

function parseTimestamp(value: unknown, index: number): number {
  if (!(typeof value === "string" || value instanceof Date)) {
    throw new EvaluationInputError(
      "observations[" + index + "].occurredAt muss ein Zeitpunkt sein.",
    );
  }
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new EvaluationInputError(
      "observations[" + index + "].occurredAt ist kein gueltiger Zeitpunkt.",
    );
  }
  return ms;
}

function parseObservations(value: unknown): ParsedObservation[] {
  if (!Array.isArray(value)) {
    throw new EvaluationInputError("observations muss ein Array sein.");
  }
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new EvaluationInputError(
        "observations[" + index + "] muss ein Objekt sein.",
      );
    }
    const playback = entry.playback;
    if (typeof playback !== "string" || !PLAYBACK_STATES.has(playback)) {
      throw new EvaluationInputError(
        "observations[" + index + "].playback muss playing, stopped oder unknown sein.",
      );
    }
    return {
      atMs: parseTimestamp(entry.occurredAt, index),
      snapshot: {
        vehicleReady: parseBooleanOrNull(entry.vehicleReady, "vehicleReady", index),
        paused: parseBooleanOrNull(entry.paused, "paused", index),
        playback: playback as PlaybackState,
        technicalFault: parseBooleanOrNull(
          entry.technicalFault,
          "technicalFault",
          index,
        ),
      },
    };
  });
}

function contentKey(snapshot: Snapshot): string {
  return [
    snapshot.vehicleReady,
    snapshot.paused,
    snapshot.playback,
    snapshot.technicalFault,
  ].join("|");
}

function parseEvaluatedAt(value: unknown): number {
  if (!(typeof value === "string" || value instanceof Date)) {
    throw new EvaluationInputError("evaluatedAt muss ein Zeitpunkt sein.");
  }
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new EvaluationInputError("evaluatedAt ist kein gueltiger Zeitpunkt.");
  }
  return ms;
}

function isHealthy(snapshot: Snapshot): boolean {
  return (
    snapshot.vehicleReady === true &&
    snapshot.paused === false &&
    snapshot.playback === "playing" &&
    snapshot.technicalFault === false
  );
}

function pauseExpiredAt(
  point: Point,
  policy: EvaluationPolicy,
  atMs: number,
): boolean {
  if (policy.e36.pauseMaxSeconds === null || point.pauseRunStartMs === null) {
    return false;
  }
  return atMs >= point.pauseRunStartMs + policy.e36.pauseMaxSeconds * 1000;
}

function emptyDimensions(): EvaluationDimensions {
  return {
    vehicleOffMs: 0,
    vehicleReadyMs: 0,
    vehicleUnknownMs: 0,
    pausedMs: 0,
    notPausedMs: 0,
    pauseUnknownMs: 0,
    technicalFaultMs: 0,
  };
}

/**
 * Vorlaeufige serverseitige Tagesklassifikation (CX-010).
 *
 * Reine Funktion ohne Timer, Datenbank, Android-Logik oder Alarmierung.
 * Der Android-Zustandsautomat (ZUSTANDSMODELL.md) ist nicht Gegenstand dieser
 * Umsetzung; die Regeln hier sind ausdruecklich vorlaeufig.
 */
export function classifyDay(input: EvaluationInput): DayClassification {
  if (!isPlainObject(input)) {
    throw new EvaluationInputError("Eingabe der Tagesklassifikation fehlt.");
  }
  const tabletId = input.tabletId;
  if (typeof tabletId !== "string" || tabletId.trim() === "") {
    throw new EvaluationInputError("tabletId ist eine verpflichtende Zeichenkette.");
  }

  const policy = validatePolicy(input.policy);
  const timeZone = assertIanaTimeZone(input.timeZone);
  const localDateParts = parseLocalDate(input.localDate);
  const localDate = formatLocalDate(localDateParts);
  const { startMs, endMs, dayLengthMs } = zonedDayRange(localDateParts, timeZone);
  const evaluatedAtMs = parseEvaluatedAt(input.evaluatedAt);
  const evaluatedAt = new Date(evaluatedAtMs).toISOString();

  const maxAgeMs = policy.maxObservationAgeSeconds * 1000;

  const parsed = parseObservations(input.observations);
  // Beobachtungen nach dem Auswertungszeitpunkt werden ignoriert.
  const usable = parsed.filter((observation) => observation.atMs <= evaluatedAtMs);

  const byTime = new Map<number, Map<string, Snapshot>>();
  for (const observation of usable) {
    let snapshots = byTime.get(observation.atMs);
    if (snapshots === undefined) {
      snapshots = new Map<string, Snapshot>();
      byTime.set(observation.atMs, snapshots);
    }
    // Identische fachliche Wiederholungen werden zusammengefasst; ein
    // abweichender Inhalt zum selben Zeitpunkt ist ein Widerspruch.
    snapshots.set(contentKey(observation.snapshot), observation.snapshot);
  }

  const points: Point[] = [...byTime.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([atMs, snapshots]) => ({
      atMs,
      conflict: snapshots.size > 1,
      snapshot: snapshots.size === 1 ? [...snapshots.values()][0] : null,
      windowEndMs: 0,
      pauseRunStartMs: null,
    }));

  // Pausenfolge: Eine Wiederholung verlaengert die maximale Pausendauer nicht.
  // Nur eine eindeutige Nicht-Pause oder der E36-Reset beendet die Folge;
  // fehlende oder widerspruechliche Evidenz setzt sie konservativ fort.
  let pauseRunStart: number | null = null;
  for (const point of points) {
    if (!point.conflict && point.snapshot !== null) {
      const snapshot = point.snapshot;
      if (snapshot.paused === false) {
        pauseRunStart = null;
      } else if (snapshot.paused === true) {
        if (
          snapshot.vehicleReady === false &&
          policy.e36.pauseResetOnVehicleOff
        ) {
          pauseRunStart = null;
        } else if (pauseRunStart === null) {
          pauseRunStart = point.atMs;
        }
      }
    }
    point.pauseRunStartMs = pauseRunStart;
  }

  const effectiveEndMs = Math.max(startMs, Math.min(endMs, evaluatedAtMs));

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const nextAtMs =
      index + 1 < points.length ? points[index + 1].atMs : Number.POSITIVE_INFINITY;
    if (point.conflict) {
      point.windowEndMs = Math.min(nextAtMs, effectiveEndMs, endMs);
    } else {
      point.windowEndMs = Math.min(
        nextAtMs,
        point.atMs + maxAgeMs,
        effectiveEndMs,
        endMs,
      );
    }
  }

  const classes: Record<ClassificationKey, number> = {
    healthy: 0,
    vehicle_off_expected: 0,
    paused_conscious: 0,
    technical_fault: 0,
    unknown: 0,
  };
  const dimensions = emptyDimensions();
  let coveredMs = 0;
  let conflictedMs = 0;

  const boundaries = new Set<number>([startMs, endMs, effectiveEndMs]);
  const addBoundary = (value: number): void => {
    if (value > startMs && value < endMs) {
      boundaries.add(value);
    }
  };
  for (const point of points) {
    addBoundary(point.atMs);
    addBoundary(point.windowEndMs);
    if (
      point.snapshot !== null &&
      !point.conflict &&
      point.snapshot.paused === true &&
      point.pauseRunStartMs !== null &&
      policy.e36.pauseMaxSeconds !== null
    ) {
      addBoundary(point.pauseRunStartMs + policy.e36.pauseMaxSeconds * 1000);
    }
  }

  const ordered = [...boundaries].sort((left, right) => left - right);
  let pointIndex = -1;

  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const from = ordered[index];
    const to = ordered[index + 1];
    if (to <= from || from >= endMs || to <= startMs) {
      continue;
    }
    while (
      pointIndex + 1 < points.length &&
      points[pointIndex + 1].atMs <= from
    ) {
      pointIndex += 1;
    }
    const active = pointIndex >= 0 ? points[pointIndex] : null;
    const length = to - from;

    const hasEvidence =
      active !== null &&
      from >= active.atMs &&
      from < active.windowEndMs;
    if (!hasEvidence) {
      classes.unknown += length;
      dimensions.vehicleUnknownMs += length;
      dimensions.pauseUnknownMs += length;
      continue;
    }

    if (active.conflict) {
      classes.unknown += length;
      dimensions.vehicleUnknownMs += length;
      dimensions.pauseUnknownMs += length;
      coveredMs += length;
      conflictedMs += length;
      continue;
    }

    const snapshot = active.snapshot as Snapshot;
    coveredMs += length;

    if (snapshot.vehicleReady === false) {
      dimensions.vehicleOffMs += length;
    } else if (snapshot.vehicleReady === true) {
      dimensions.vehicleReadyMs += length;
    } else {
      dimensions.vehicleUnknownMs += length;
    }

    const pauseReset =
      snapshot.paused === true &&
      snapshot.vehicleReady === false &&
      policy.e36.pauseResetOnVehicleOff;
    const pauseEffective =
      snapshot.paused === true &&
      !pauseReset &&
      !pauseExpiredAt(active, policy, from);

    if (snapshot.paused === true && !pauseReset) {
      if (pauseEffective) {
        dimensions.pausedMs += length;
      } else {
        dimensions.pauseUnknownMs += length;
      }
    } else if (snapshot.paused === false || pauseReset) {
      dimensions.notPausedMs += length;
    } else {
      dimensions.pauseUnknownMs += length;
    }

    if (snapshot.technicalFault === true) {
      dimensions.technicalFaultMs += length;
    }

    let classification: ClassificationKey;
    if (snapshot.technicalFault === true) {
      classification = "technical_fault";
    } else if (snapshot.vehicleReady === false) {
      classification = "vehicle_off_expected";
    } else if (pauseEffective) {
      classification = "paused_conscious";
    } else if (isHealthy(snapshot)) {
      classification = "healthy";
    } else {
      classification = "unknown";
    }
    classes[classification] += length;
  }

  // Ohne jede Grenze innerhalb des Tages (z. B. Auswertung vor Tagesbeginn)
  // muss die Summe der Klassen trotzdem die Tageslaenge treffen.
  const classSum = CLASSIFICATION_KEYS.reduce(
    (sum, key) => sum + classes[key],
    0,
  );
  if (classSum !== dayLengthMs) {
    const missing = dayLengthMs - classSum;
    classes.unknown += missing;
    dimensions.vehicleUnknownMs += missing;
    dimensions.pauseUnknownMs += missing;
  }

  return {
    tabletId,
    localDate,
    timeZone,
    policyVersion: policy.policyVersion,
    evaluatedAt,
    dayStart: new Date(startMs).toISOString(),
    dayEnd: new Date(endMs).toISOString(),
    dayLengthMs,
    classes,
    dimensions,
    observationCoverage: {
      coveredMs,
      conflictedMs,
      dayLengthMs,
      ratio: dayLengthMs === 0 ? 0 : coveredMs / dayLengthMs,
    },
    expectedPlaybackMs: null,
    expectedPlaybackReason: EXPECTED_PLAYBACK_REASON,
  };
}
