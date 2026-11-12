import { RollupInputError } from "./errors.js";

function canonicalValue(value: unknown, path: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RollupInputError("Nicht-endliche Zahl im kanonischen Inhalt: " + path);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      canonicalValue(entry, path + "[" + index + "]"),
    );
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry === undefined) {
        throw new RollupInputError("Undefined im kanonischen Inhalt: " + path + "." + key);
      }
      result[key] = canonicalValue(entry, path + "." + key);
    }
    return result;
  }
  throw new RollupInputError("Nicht kanonisierbarer Wert: " + path);
}

/**
 * Deterministische JSON-Darstellung mit lexikografisch sortierten
 * Objektschluesseln. Zwei fachlich gleiche Policys ergeben denselben String.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(canonicalValue(value, "$"));
}
