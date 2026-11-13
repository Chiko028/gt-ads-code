import type { ClassificationKey } from "../telemetryEvaluation/index.js";
import { isCx010ClassificationKey } from "./adapter.js";
import { TechnicalAlarmInputError } from "./errors.js";
import type { TechnicalAlarmEvaluationInput } from "./types.js";

const MAX_TEXT_LENGTH = 128;
const ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export interface NormalizedTechnicalAlarmClassification {
  outcome: ClassificationKey;
  errorCode: string | null;
  faultStartedAtMs: number | null;
}

export interface NormalizedTechnicalAlarmInput {
  resourceId: string;
  evaluationId: string;
  evaluationVersion: number;
  classification: NormalizedTechnicalAlarmClassification;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new TechnicalAlarmInputError(field + " muss eine Zeichenkette sein.");
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_TEXT_LENGTH) {
    throw new TechnicalAlarmInputError(
      field + " muss nicht leer und hoechstens " + MAX_TEXT_LENGTH + " Zeichen lang sein.",
    );
  }
  if ([...trimmed].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new TechnicalAlarmInputError(
      field + " darf keine Steuerzeichen enthalten.",
    );
  }
  return trimmed;
}

export function parseTimestamp(value: unknown, field: string): number {
  if (!(typeof value === "string" || value instanceof Date)) {
    throw new TechnicalAlarmInputError(field + " muss ein Zeitpunkt sein.");
  }
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new TechnicalAlarmInputError(field + " ist kein gueltiger Zeitpunkt.");
  }
  return ms;
}

export function validateErrorCode(value: unknown): string {
  if (typeof value !== "string") {
    throw new TechnicalAlarmInputError(
      "classification.errorCode ist bei technical_fault verpflichtend.",
    );
  }
  const code = value.trim();
  if (!ERROR_CODE_PATTERN.test(code)) {
    throw new TechnicalAlarmInputError(
      "classification.errorCode ist kein gueltiger technischer Fehlercode.",
    );
  }
  return code;
}

export function validateMinDurationSeconds(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new TechnicalAlarmInputError(
      "minDurationSeconds muss eine positive sichere Ganzzahl sein.",
    );
  }
  return value;
}

/**
 * Validiert den gesamten Aufruf vor dem Oeffnen einer Transaktion.
 * Alarmfaehig ist ausschliesslich technical_fault mit Fehlercode und Beginn.
 */
export function normalizeTechnicalAlarmInput(
  value: unknown,
): NormalizedTechnicalAlarmInput {
  if (!isPlainObject(value)) {
    throw new TechnicalAlarmInputError("Auswertungseingabe fehlt oder ist kein Objekt.");
  }
  const resourceId = requiredText(value.resourceId, "resourceId");
  const evaluationId = requiredText(value.evaluationId, "evaluationId");
  const evaluationVersion = value.evaluationVersion;
  if (
    typeof evaluationVersion !== "number" ||
    !Number.isSafeInteger(evaluationVersion) ||
    evaluationVersion < 1
  ) {
    throw new TechnicalAlarmInputError(
      "evaluationVersion muss eine positive sichere Ganzzahl sein.",
    );
  }

  const classification = value.classification;
  if (!isPlainObject(classification)) {
    throw new TechnicalAlarmInputError("classification fehlt oder ist kein Objekt.");
  }
  const outcome = classification.outcome;
  if (!isCx010ClassificationKey(outcome)) {
    throw new TechnicalAlarmInputError(
      "classification.outcome ist kein CX-010-Klassifikationsschluessel.",
    );
  }

  if (outcome !== "technical_fault") {
    return {
      resourceId,
      evaluationId,
      evaluationVersion,
      classification: {
        outcome,
        errorCode: null,
        faultStartedAtMs: null,
      },
    };
  }

  return {
    resourceId,
    evaluationId,
    evaluationVersion,
    classification: {
      outcome,
      errorCode: validateErrorCode(classification.errorCode),
      faultStartedAtMs: parseTimestamp(
        classification.faultStartedAt,
        "classification.faultStartedAt",
      ),
    },
  };
}

export type NormalizedInput = NormalizedTechnicalAlarmInput;
export type TechnicalAlarmEvaluationInputValue = TechnicalAlarmEvaluationInput;
