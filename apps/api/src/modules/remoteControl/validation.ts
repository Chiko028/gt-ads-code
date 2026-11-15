import { RemoteControlValidationError } from "./errors.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface NormalizedSetDesiredPauseInput {
  actorId: string;
  taxiId: string;
  commandId: string;
  expectedRevision: number;
  desiredPaused: boolean;
}

export interface NormalizedAcknowledgeAppliedInput {
  deviceId: string;
  taxiId: string;
  revision: number;
}

export function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new RemoteControlValidationError(
      field + " muss eine UUID sein.",
    );
  }
  return value.toLowerCase();
}

export function requireNonEmptyText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RemoteControlValidationError(
      field + " muss ein nicht leerer Text sein.",
    );
  }
  return value.trim();
}

export function requireRevision(
  value: unknown,
  field: string,
  minimum: number,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new RemoteControlValidationError(
      field + " muss eine ganze Zahl >= " + minimum + " sein.",
    );
  }
  return value;
}

export function normalizeSetDesiredPauseInput(input: {
  actor: { id: string; type?: "admin" };
  taxiId: string;
  commandId: string;
  expectedRevision: number;
  desiredPaused: boolean;
}): NormalizedSetDesiredPauseInput {
  if (input === null || typeof input !== "object") {
    throw new RemoteControlValidationError("Eingabe fehlt.");
  }
  if (input.actor === null || typeof input.actor !== "object") {
    throw new RemoteControlValidationError("Authentifizierter Akteur fehlt.");
  }
  if (input.actor.type !== undefined && input.actor.type !== "admin") {
    throw new RemoteControlValidationError(
      "Ursprung ist in CX-012 ausschliesslich 'admin'.",
    );
  }
  if (typeof input.desiredPaused !== "boolean") {
    throw new RemoteControlValidationError(
      "desiredPaused muss ein Boolean sein.",
    );
  }
  return {
    actorId: requireNonEmptyText(input.actor.id, "actor.id"),
    taxiId: requireNonEmptyText(input.taxiId, "taxiId"),
    commandId: requireUuid(input.commandId, "commandId"),
    expectedRevision: requireRevision(
      input.expectedRevision,
      "expectedRevision",
      0,
    ),
    desiredPaused: input.desiredPaused,
  };
}

export function normalizeAcknowledgeAppliedInput(input: {
  deviceId: string;
  taxiId: string;
  revision: number;
}): NormalizedAcknowledgeAppliedInput {
  if (input === null || typeof input !== "object") {
    throw new RemoteControlValidationError("Eingabe fehlt.");
  }
  return {
    deviceId: requireUuid(input.deviceId, "deviceId"),
    taxiId: requireNonEmptyText(input.taxiId, "taxiId"),
    revision: requireRevision(input.revision, "revision", 1),
  };
}
