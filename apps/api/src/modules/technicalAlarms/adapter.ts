import { CLASSIFICATION_KEYS } from "../telemetryEvaluation/index.js";
import type { ClassificationKey } from "../telemetryEvaluation/index.js";
import { TechnicalAlarmInputError } from "./errors.js";
import type { TechnicalAlarmClassification } from "./types.js";

/**
 * Schmaler Adapter auf CX-010.
 *
 * CX-010 bleibt unveraendert. Der Adapter uebernimmt ausschliesslich dessen
 * stabile Klassifikationsschluessel und reicht die technische Evidenz
 * (Fehlercode und belegter Beginn) unveraendert weiter. Er erfindet weder
 * Fehlercodes noch Zeiten.
 */
export function isCx010ClassificationKey(
  value: unknown,
): value is ClassificationKey {
  return (
    typeof value === "string" &&
    (CLASSIFICATION_KEYS as readonly string[]).includes(value)
  );
}

export interface Cx010AlarmEvidence {
  errorCode?: unknown;
  faultStartedAt?: unknown;
}

export function alarmClassificationFromCx010(
  outcome: unknown,
  evidence: Cx010AlarmEvidence = {},
): TechnicalAlarmClassification {
  if (!isCx010ClassificationKey(outcome)) {
    throw new TechnicalAlarmInputError(
      "classification.outcome ist kein CX-010-Klassifikationsschluessel.",
    );
  }
  if (outcome !== "technical_fault") {
    return { outcome, errorCode: null, faultStartedAt: null };
  }
  return {
    outcome,
    errorCode:
      typeof evidence.errorCode === "string" ? evidence.errorCode : null,
    faultStartedAt:
      typeof evidence.faultStartedAt === "string" ||
      evidence.faultStartedAt instanceof Date
        ? evidence.faultStartedAt
        : null,
  };
}
