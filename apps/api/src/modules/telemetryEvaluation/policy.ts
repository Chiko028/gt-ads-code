import { EvaluationConfigError } from "./errors.js";
import type { EvaluationPolicy } from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validiert die versionierte Policy vollstaendig.
 *
 * Es gibt bewusst keine Defaults: fehlende E36/E40-Werte verhindern die
 * Auswertung, statt stillschweigend Annahmen zu erfinden.
 */
export function validatePolicy(value: unknown): EvaluationPolicy {
  if (!isPlainObject(value)) {
    throw new EvaluationConfigError("policy fehlt oder ist kein Objekt.");
  }

  const version = value.policyVersion;
  if (typeof version !== "string" || version.trim() === "") {
    throw new EvaluationConfigError("policy.policyVersion ist eine verpflichtende Zeichenkette.");
  }

  const maxAge = value.maxObservationAgeSeconds;
  if (
    typeof maxAge !== "number" ||
    !Number.isFinite(maxAge) ||
    maxAge <= 0 ||
    !Number.isFinite(maxAge * 1000) ||
    maxAge * 1000 > Number.MAX_SAFE_INTEGER
  ) {
    throw new EvaluationConfigError(
      "policy.maxObservationAgeSeconds muss eine endliche Zahl groesser 0 sein.",
    );
  }

  const e36 = value.e36;
  if (!isPlainObject(e36)) {
    throw new EvaluationConfigError("policy.e36 ist eine verpflichtende Konfiguration.");
  }
  if (typeof e36.pauseResetOnVehicleOff !== "boolean") {
    throw new EvaluationConfigError(
      "policy.e36.pauseResetOnVehicleOff muss ein boolean sein.",
    );
  }
  const pauseMax = e36.pauseMaxSeconds;
  if (
    pauseMax !== null &&
    (typeof pauseMax !== "number" ||
      !Number.isInteger(pauseMax) ||
      pauseMax <= 0)
  ) {
    throw new EvaluationConfigError(
      "policy.e36.pauseMaxSeconds muss eine positive Ganzzahl oder null sein.",
    );
  }

  const e40 = value.e40;
  if (!isPlainObject(e40)) {
    throw new EvaluationConfigError("policy.e40 ist eine verpflichtende Konfiguration.");
  }
  const displayRun = e40.displayRunOnSeconds;
  if (
    typeof displayRun !== "number" ||
    !Number.isInteger(displayRun) ||
    displayRun < 0
  ) {
    throw new EvaluationConfigError(
      "policy.e40.displayRunOnSeconds muss eine nichtnegative Ganzzahl sein.",
    );
  }

  return {
    policyVersion: version,
    maxObservationAgeSeconds: maxAge,
    e36: {
      pauseResetOnVehicleOff: e36.pauseResetOnVehicleOff,
      pauseMaxSeconds: pauseMax,
    },
    e40: {
      displayRunOnSeconds: displayRun,
    },
  };
}
