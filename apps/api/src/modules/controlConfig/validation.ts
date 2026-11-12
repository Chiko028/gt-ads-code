import { ControlConfigValidationError } from "./errors.js";
import type {
  AdminActor,
  ReadTaxiConfigInput,
  TaxiControlConfigValues,
  UpdateTaxiConfigInput,
} from "./types.js";


const READ_INPUT_KEYS = ["actor", "taxi_id"] as const;
const UPDATE_INPUT_KEYS = [
  "actor",
  "taxi_id",
  "change_id",
  "expected_revision",
  "config",
] as const;
const ACTOR_KEYS = ["id", "type"] as const;
const CONFIG_KEYS = [
  "gps_mode",
  "pause_max_duration_s",
  "pause_end_on_vehicle_off",
  "display_run_on_s",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requirePlainObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ControlConfigValidationError(field + " muss ein Objekt sein.");
  }
  return value;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const permitted = new Set<string>(allowed);
  for (const key of Object.keys(value)) {
    if (!permitted.has(key)) {
      throw new ControlConfigValidationError(
        field + " enthaelt unbekanntes Feld " + key + ".",
      );
    }
  }
}

function requirePresentKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  field: string,
): void {
  for (const key of required) {
    if (!(key in value)) {
      throw new ControlConfigValidationError(
        field + " benoetigt das Feld " + key + ".",
      );
    }
  }
}

function requireNonEmptyText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ControlConfigValidationError(
      field + " muss ein nicht leerer Text sein.",
    );
  }
  return value.trim();
}

function requireRevision(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new ControlConfigValidationError(
      field + " muss eine sichere Ganzzahl >= 0 sein.",
    );
  }
  return value;
}

function requirePositiveSeconds(value: unknown, field: string): number | null {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new ControlConfigValidationError(
      field + " muss eine positive sichere Ganzzahl oder null sein.",
    );
  }
  return value;
}

function requireNonNegativeSeconds(
  value: unknown,
  field: string,
): number | null {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new ControlConfigValidationError(
      field + " muss eine nichtnegative sichere Ganzzahl oder null sein.",
    );
  }
  return value;
}

function requireBooleanOrNull(value: unknown, field: string): boolean | null {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  throw new ControlConfigValidationError(
    field + " muss ein Boolean oder null sein.",
  );
}

function normalizeActor(value: unknown): AdminActor {
  const actor = requirePlainObject(value, "actor");
  rejectUnknownKeys(actor, ACTOR_KEYS, "actor");
  if (actor.type !== undefined && actor.type !== "admin") {
    throw new ControlConfigValidationError(
      "actor.type ist in CX-013 ausschliesslich 'admin'.",
    );
  }
  return {
    id: requireNonEmptyText(actor.id, "actor.id"),
    type: "admin",
  };
}

/**
 * Validiert die vier Konfigurationsfelder strikt.
 *
 * Es gibt keine Defaults und keine Teilmutation: alle vier Felder muessen
 * vorhanden sein, unbekannte Felder werden abgelehnt. GPS ist ausschliesslich
 * "aus"; ein Freigabefeld ist kein gueltiger Ersatz fuer die Nutzungssperre.
 */
export function normalizeConfigValues(
  value: unknown,
): TaxiControlConfigValues {
  const config = requirePlainObject(value, "config");
  rejectUnknownKeys(config, CONFIG_KEYS, "config");
  requirePresentKeys(config, CONFIG_KEYS, "config");

  const gpsMode = config.gps_mode;
  if (gpsMode !== "aus") {
    throw new ControlConfigValidationError(
      "config.gps_mode ist ausschliesslich 'aus'.",
    );
  }

  return {
    gps_mode: "aus",
    pause_max_duration_s: requirePositiveSeconds(
      config.pause_max_duration_s,
      "config.pause_max_duration_s",
    ),
    pause_end_on_vehicle_off: requireBooleanOrNull(
      config.pause_end_on_vehicle_off,
      "config.pause_end_on_vehicle_off",
    ),
    display_run_on_s: requireNonNegativeSeconds(
      config.display_run_on_s,
      "config.display_run_on_s",
    ),
  };
}

/** Alle drei offenen E36/E40-Parameter sind explizit gesetzt. */
export function isPolicyComplete(config: TaxiControlConfigValues): boolean {
  return (
    config.pause_max_duration_s !== null &&
    config.pause_end_on_vehicle_off !== null &&
    config.display_run_on_s !== null
  );
}

export function normalizeReadTaxiConfigInput(
  value: unknown,
): ReadTaxiConfigInput {
  const input = requirePlainObject(value, "Eingabe");
  rejectUnknownKeys(input, READ_INPUT_KEYS, "Eingabe");
  requirePresentKeys(input, READ_INPUT_KEYS, "Eingabe");
  return {
    actor: normalizeActor(input.actor),
    taxi_id: requireNonEmptyText(input.taxi_id, "taxi_id"),
  };
}

export function normalizeUpdateTaxiConfigInput(
  value: unknown,
): UpdateTaxiConfigInput {
  const input = requirePlainObject(value, "Eingabe");
  rejectUnknownKeys(input, UPDATE_INPUT_KEYS, "Eingabe");
  requirePresentKeys(input, UPDATE_INPUT_KEYS, "Eingabe");
  return {
    actor: normalizeActor(input.actor),
    taxi_id: requireNonEmptyText(input.taxi_id, "taxi_id"),
    change_id: requireNonEmptyText(input.change_id, "change_id"),
    expected_revision: requireRevision(
      input.expected_revision,
      "expected_revision",
    ),
    config: normalizeConfigValues(input.config),
  };
}
