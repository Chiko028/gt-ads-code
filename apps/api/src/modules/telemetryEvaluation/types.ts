import type {
  NormalizedObservation,
  PlaybackState,
} from "../telemetry/types.js";

export type { NormalizedObservation, PlaybackState };

/** Ergebnisklassen der vorlaeufigen serverseitigen Tagesklassifikation. */
export type ClassificationKey =
  | "healthy"
  | "vehicle_off_expected"
  | "paused_conscious"
  | "technical_fault"
  | "unknown";

export const CLASSIFICATION_KEYS: readonly ClassificationKey[] = [
  "healthy",
  "vehicle_off_expected",
  "paused_conscious",
  "technical_fault",
  "unknown",
] as const;

/** E36: Pausenverhalten. Beide Werte sind Pflicht, es gibt keine Defaults. */
export interface EvaluationPolicyE36 {
  /** Beobachtete Pause wird bei Fahrzeug-aus zurueckgesetzt. */
  pauseResetOnVehicleOff: boolean;
  /** Maximale Pausendauer in Sekunden oder null fuer keine Obergrenze. */
  pauseMaxSeconds: number | null;
}

/** E40: Display-Nachlauf. Beeinflusst die Klassifikation nicht. */
export interface EvaluationPolicyE40 {
  /** Nachlauf des Displays in Sekunden; nur Konfigurationspflicht. */
  displayRunOnSeconds: number;
}

/** Versionierte Auswertungspolicy. */
export interface EvaluationPolicy {
  policyVersion: string;
  /** Frischefrist einer Beobachtung in Sekunden; muss > 0 sein. */
  maxObservationAgeSeconds: number;
  e36: EvaluationPolicyE36;
  e40: EvaluationPolicyE40;
}

/**
 * Eingabe der reinen Auswertung.
 *
 * tabletId und localDate sind fachliche Kennungen; timeZone ist eine
 * verpflichtende gueltige IANA-Zeitzone. evaluatedAt ist der Zeitpunkt, bis zu
 * dem Beobachtungen beruecksichtigt werden.
 */
export interface EvaluationInput {
  tabletId: string;
  /** Lokales Kalenderdatum YYYY-MM-DD in timeZone. */
  localDate: string;
  timeZone: string;
  evaluatedAt: string | Date;
  /** Normalisierte Beobachtungen aus CX-009. */
  observations: readonly NormalizedObservation[];
  policy: EvaluationPolicy;
}

/**
 * Getrennte Zeitdimensionen. Fahrzeug-aus und Pause bleiben auch dann
 * sichtbar, wenn die Klassenprioritaet einen technischen Fehler meldet.
 */
export interface EvaluationDimensions {
  vehicleOffMs: number;
  vehicleReadyMs: number;
  vehicleUnknownMs: number;
  pausedMs: number;
  notPausedMs: number;
  pauseUnknownMs: number;
  technicalFaultMs: number;
}

/**
 * Abdeckung durch Beobachtungen. coveredMs zaehlt Zeitfenster mit mindestens
 * einer Beobachtung (auch widerspruechliche); conflictedMs ist darin enthalten.
 */
export interface ObservationCoverage {
  coveredMs: number;
  conflictedMs: number;
  dayLengthMs: number;
  ratio: number;
}

export interface DayClassification {
  tabletId: string;
  localDate: string;
  timeZone: string;
  policyVersion: string;
  evaluatedAt: string;
  /** Erster Zeitpunkt des lokalen Tages als UTC-Instant. */
  dayStart: string;
  /** Erster Zeitpunkt des Folgetages als UTC-Instant. */
  dayEnd: string;
  dayLengthMs: number;
  classes: Record<ClassificationKey, number>;
  dimensions: EvaluationDimensions;
  observationCoverage: ObservationCoverage;
  /** Serverseitig nicht bestimmbar; siehe expectedPlaybackReason. */
  expectedPlaybackMs: null;
  expectedPlaybackReason: string;
}
