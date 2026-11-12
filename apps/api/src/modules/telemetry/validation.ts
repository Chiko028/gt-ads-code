import { TelemetryConflictError, TelemetryValidationError } from "./errors.js";
import type { NormalizedObservation, PlaybackState } from "./types.js";

/** Erlaubte Felder des internen Ereignisschemas. Alles andere ist verboten. */
const OBSERVATION_FIELDS: ReadonlySet<string> = new Set([
  "event_id",
  "occurred_at",
  "vehicle_ready",
  "paused",
  "playback",
  "technical_fault",
]);

const PLAYBACK_STATES: ReadonlySet<string> = new Set([
  "playing",
  "stopped",
  "unknown",
]);

/** UUID mit RFC-4122-Variante und Version 1 bis 8. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Kanonisch: UTC, millisekundengenau, mit Z. */
const UTC_MILLISECOND_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 100;

function invalid(
  field: string,
  message: string,
  eventIndex?: number,
): never {
  throw new TelemetryValidationError(message, field, eventIndex);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireField(
  value: Record<string, unknown>,
  field: string,
  eventIndex: number,
): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, field)) {
    invalid(field, "Pflichtfeld " + field + " fehlt.", eventIndex);
  }
  return value[field];
}

function parseUuid(
  value: unknown,
  field: string,
  eventIndex?: number,
): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    invalid(field, field + " muss eine gueltige UUID sein.", eventIndex);
  }
  return value.toLowerCase();
}

/**
 * Akzeptiert ausschliesslich kanonische UTC-Zeitpunkte mit Millisekunden.
 * Der Rueckvergleich ueber toISOString weist nicht existierende Kalenderdaten
 * (z. B. 30. Februar) und stillschweigende Normalisierungen zurueck.
 */
function parseOccurredAt(value: unknown, eventIndex: number): string {
  if (typeof value !== "string" || !UTC_MILLISECOND_PATTERN.test(value)) {
    invalid(
      "occurred_at",
      "occurred_at muss ein kanonisches UTC-ISO-Datum mit Millisekunden sein.",
      eventIndex,
    );
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    invalid("occurred_at", "occurred_at ist kein gueltiger Zeitpunkt.", eventIndex);
  }

  let canonical: string;
  try {
    canonical = new Date(timestamp).toISOString();
  } catch {
    invalid("occurred_at", "occurred_at ist kein gueltiger Zeitpunkt.", eventIndex);
  }
  if (canonical !== value) {
    invalid("occurred_at", "occurred_at ist kein kanonischer UTC-Zeitpunkt.", eventIndex);
  }
  return value;
}

function parseBooleanOrNull(
  value: Record<string, unknown>,
  field: string,
  eventIndex: number,
): boolean | null {
  const candidate = requireField(value, field, eventIndex);
  if (candidate !== null && typeof candidate !== "boolean") {
    invalid(field, field + " muss boolean oder null sein.", eventIndex);
  }
  return candidate;
}

function parsePlayback(
  value: Record<string, unknown>,
  eventIndex: number,
): PlaybackState {
  const candidate = requireField(value, "playback", eventIndex);
  if (typeof candidate !== "string" || !PLAYBACK_STATES.has(candidate)) {
    invalid(
      "playback",
      "playback muss playing, stopped oder unknown sein.",
      eventIndex,
    );
  }
  return candidate as PlaybackState;
}

function normalizeObservation(
  input: unknown,
  eventIndex: number,
): NormalizedObservation {
  if (!isPlainObject(input)) {
    invalid("events", "Jedes Ereignis muss ein Objekt sein.", eventIndex);
  }

  for (const key of Object.keys(input)) {
    if (!OBSERVATION_FIELDS.has(key)) {
      invalid(key, "Unbekanntes Feld im Ereignis: " + key, eventIndex);
    }
  }

  return {
    eventId: parseUuid(
      requireField(input, "event_id", eventIndex),
      "event_id",
      eventIndex,
    ),
    occurredAt: parseOccurredAt(
      requireField(input, "occurred_at", eventIndex),
      eventIndex,
    ),
    vehicleReady: parseBooleanOrNull(input, "vehicle_ready", eventIndex),
    paused: parseBooleanOrNull(input, "paused", eventIndex),
    playback: parsePlayback(input, eventIndex),
    technicalFault: parseBooleanOrNull(input, "technical_fault", eventIndex),
  };
}

/** Geraete-ID kommt aus dem authentifizierten Kontext, nie aus dem Ereignis. */
export function normalizeDeviceId(deviceId: unknown): string {
  return parseUuid(deviceId, "device_id");
}

/** Validiert 1 bis 100 Ereignisse strikt gegen das interne Schema. */
export function normalizeObservationBatch(
  events: unknown,
): NormalizedObservation[] {
  if (!Array.isArray(events)) {
    invalid("events", "events muss ein Array sein.");
  }
  if (events.length < MIN_BATCH_SIZE || events.length > MAX_BATCH_SIZE) {
    invalid(
      "events",
      "Batchgroesse muss zwischen " +
        MIN_BATCH_SIZE +
        " und " +
        MAX_BATCH_SIZE +
        " liegen.",
    );
  }
  return events.map((event, index) => normalizeObservation(event, index));
}

/** Vergleicht ausschliesslich normalisierte fachliche Felder. */
export function observationsHaveSameContent(
  left: NormalizedObservation,
  right: NormalizedObservation,
): boolean {
  return (
    left.eventId === right.eventId &&
    left.occurredAt === right.occurredAt &&
    left.vehicleReady === right.vehicleReady &&
    left.paused === right.paused &&
    left.playback === right.playback &&
    left.technicalFault === right.technicalFault
  );
}

export interface CollapsedObservations {
  /** Eindeutige Ereignisse in Reihenfolge des ersten Auftretens. */
  observations: NormalizedObservation[];
  /** IDs, die innerhalb des Batches wiederholt identisch vorkamen. */
  duplicateEventIds: string[];
}

/**
 * Fasst identische Wiederholungen innerhalb eines Batches zusammen. Eine
 * abweichende Wiederverwendung derselben event_id ist ein typisierter Konflikt.
 */
export function collapseDuplicateObservations(
  observations: NormalizedObservation[],
): CollapsedObservations {
  const byEventId = new Map<string, NormalizedObservation>();
  const unique: NormalizedObservation[] = [];
  const duplicateEventIds: string[] = [];

  for (const observation of observations) {
    const existing = byEventId.get(observation.eventId);
    if (existing === undefined) {
      byEventId.set(observation.eventId, observation);
      unique.push(observation);
      continue;
    }
    if (!observationsHaveSameContent(existing, observation)) {
      throw new TelemetryConflictError(observation.eventId);
    }
    duplicateEventIds.push(observation.eventId);
  }

  return { observations: unique, duplicateEventIds };
}
