import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";

// Interop: ajv-formats ist CommonJS und liefert die Plugin-Funktion als module.exports.
type AddFormatsPlugin = (ajv: Ajv2020) => Ajv2020;
const addFormats = addFormatsModule.default as unknown as AddFormatsPlugin;

/**
 * Gemeinsame Basis der Contract-Tests (TESTPLAN Abschnitt 4): Schemas,
 * Beispiele und OpenAPI-Datei liegen unter contracts/gt-ads-001 und werden
 * relativ zu diesem Testverzeichnis aufgeloest.
 */
export const CONTRACT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../contracts/gt-ads-001",
);
export const SCHEMA_DIR = join(CONTRACT_DIR, "schemas");
export const EXAMPLE_DIR = join(CONTRACT_DIR, "examples");
export const OPENAPI_FILE = join(CONTRACT_DIR, "device-registration.openapi.yaml");

export function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function listSchemaFiles(): string[] {
  return readdirSync(SCHEMA_DIR)
    .filter((name) => name.endsWith(".schema.json"))
    .sort();
}

export function listExampleFiles(): string[] {
  return readdirSync(EXAMPLE_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

export function examplePath(name: string): string {
  return join(EXAMPLE_DIR, name);
}

/** Ajv 2020-12 mit Formatvalidierung (date-time, uuid). */
export function createContractAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv;
}

export function compileSchema(ajv: Ajv2020, schemaFile: string) {
  return ajv.compile(readJson(join(SCHEMA_DIR, schemaFile)));
}

export interface RequestExampleGroup {
  readonly schema: string;
  readonly valid: readonly string[];
  readonly invalid: readonly string[];
}

/** Zuordnung Request-Schema -> synthetische Beispiele (API-VERTRAG.md 9). */
export const REQUEST_EXAMPLE_GROUPS: readonly RequestExampleGroup[] = [
  {
    schema: "device-register.request.schema.json",
    valid: ["device-register.request.valid.json"],
    invalid: [
      "device-register.request.invalid-code-length.json",
      "device-register.request.invalid-unknown-field.json",
    ],
  },
  {
    schema: "device-auth-challenge.request.schema.json",
    valid: ["device-auth-challenge.request.valid.json"],
    invalid: ["device-auth-challenge.request.invalid.json"],
  },
  {
    schema: "device-auth-token.request.schema.json",
    valid: ["device-auth-token.request.valid.json"],
    invalid: ["device-auth-token.request.invalid.json"],
  },
  {
    schema: "device-heartbeat.request.schema.json",
    valid: ["device-heartbeat.request.valid.json"],
    invalid: ["device-heartbeat.request.invalid.json"],
  },
  {
    schema: "admin-login.request.schema.json",
    valid: ["admin-login.request.valid.json"],
    invalid: ["admin-login.request.invalid.json"],
  },
  {
    schema: "admin-registration-code-create.request.schema.json",
    valid: ["admin-registration-code-create.request.valid.json"],
    invalid: ["admin-registration-code-create.request.invalid.json"],
  },
  {
    schema: "admin-device-revoke.request.schema.json",
    valid: ["admin-device-revoke.request.valid.json"],
    invalid: ["admin-device-revoke.request.invalid.json"],
  },
];

export interface ResponseExampleGroup {
  readonly schema: string;
  readonly examples: readonly string[];
}

/** Zuordnung Response-Schema -> dokumentierte Beispielantwort. */
export const RESPONSE_EXAMPLE_GROUPS: readonly ResponseExampleGroup[] = [
  { schema: "device-register.response.schema.json", examples: ["device-register.response.201.json"] },
  { schema: "device-auth-challenge.response.schema.json", examples: ["device-auth-challenge.response.200.json"] },
  { schema: "device-auth-token.response.schema.json", examples: ["device-auth-token.response.200.json"] },
  { schema: "device-heartbeat.response.schema.json", examples: ["device-heartbeat.response.200.json"] },
  { schema: "admin-registration-code-create.response.schema.json", examples: ["admin-registration-code-create.response.201.json"] },
  { schema: "admin-registration-codes-list.response.schema.json", examples: ["admin-registration-codes-list.response.200.json"] },
  { schema: "admin-devices-list.response.schema.json", examples: ["admin-devices-list.response.200.json"] },
  { schema: "admin-device-detail.response.schema.json", examples: ["admin-device-detail.response.200.json"] },
  { schema: "health.response.schema.json", examples: ["health.response.200.json"] },
  { schema: "error.response.schema.json", examples: ["error.response.400.json"] },
];
