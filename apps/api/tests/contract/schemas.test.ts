import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  EXAMPLE_DIR,
  OPENAPI_FILE,
  REQUEST_EXAMPLE_GROUPS,
  RESPONSE_EXAMPLE_GROUPS,
  SCHEMA_DIR,
  compileSchema,
  createContractAjv,
  examplePath,
  listExampleFiles,
  listSchemaFiles,
  readJson,
} from "./contractFiles.js";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

describe("T3 Contract: Schemas und Beispiele", () => {
  it("alle Schemas sind JSON Schema Draft 2020-12 und kompilieren", () => {
    const files = listSchemaFiles();
    expect(files.length).toBeGreaterThanOrEqual(17);
    const ajv = createContractAjv();
    for (const file of files) {
      const schema = readJson(join(SCHEMA_DIR, file));
      expect(schema.$schema, file).toBe(DRAFT_2020_12);
      expect(() => ajv.compile(schema), file).not.toThrow();
    }
  });

  it("jede Request-Klasse hat gueltige und ungueltige Beispiele", () => {
    const requestSchemas = listSchemaFiles().filter((name) =>
      name.endsWith(".request.schema.json"),
    );
    const documented = REQUEST_EXAMPLE_GROUPS.map((group) => group.schema).sort();
    expect(documented).toEqual(requestSchemas);

    const known = listExampleFiles();
    for (const group of REQUEST_EXAMPLE_GROUPS) {
      expect(group.valid.length, group.schema).toBeGreaterThan(0);
      expect(group.invalid.length, group.schema).toBeGreaterThan(0);
      for (const file of [...group.valid, ...group.invalid]) {
        expect(known, file).toContain(file);
      }
    }
  });

  it("gueltige Beispiele bestehen ihre Request-Schemas", () => {
    const ajv = createContractAjv();
    for (const group of REQUEST_EXAMPLE_GROUPS) {
      const validate = compileSchema(ajv, group.schema);
      for (const file of group.valid) {
        const body = readJson(examplePath(file));
        expect(validate(body), file + "\n" + ajv.errorsText(validate.errors ?? [])).toBe(true);
      }
    }
  });

  it("ungueltige Beispiele scheitern an ihren Request-Schemas", () => {
    const ajv = createContractAjv();
    for (const group of REQUEST_EXAMPLE_GROUPS) {
      const validate = compileSchema(ajv, group.schema);
      for (const file of group.invalid) {
        const body = readJson(examplePath(file));
        expect(validate(body), file).toBe(false);
      }
    }
  });

  it("Antwort-Beispiele bestehen die Response-Schemas", () => {
    const ajv = createContractAjv();
    for (const group of RESPONSE_EXAMPLE_GROUPS) {
      const validate = compileSchema(ajv, group.schema);
      for (const file of group.examples) {
        const body = readJson(examplePath(file));
        expect(validate(body), file + "\n" + ajv.errorsText(validate.errors ?? [])).toBe(true);
      }
    }
  });

  it("das Fehlerschema lehnt unbekannte Codes und Zusatzfelder ab", () => {
    const ajv = createContractAjv();
    const validate = compileSchema(ajv, "error.response.schema.json");
    expect(
      validate({ error: { code: "unbekannt", message: "x", request_id: "y" } }),
    ).toBe(false);
    expect(
      validate({
        error: { code: "not_found", message: "x", request_id: "y", detail: "stack" },
      }),
    ).toBe(false);
    expect(validate({ error: { code: "not_found", message: "x", request_id: "y" } })).toBe(true);
  });

  it("es gibt keine nicht zugeordneten Beispieldateien", () => {
    const expected = new Set<string>();
    for (const group of REQUEST_EXAMPLE_GROUPS) {
      for (const file of group.valid) expected.add(file);
      for (const file of group.invalid) expected.add(file);
    }
    for (const group of RESPONSE_EXAMPLE_GROUPS) {
      for (const file of group.examples) expected.add(file);
    }
    expect(listExampleFiles()).toEqual([...expected].sort());
  });

  it("die Beispieldateien selbst enthalten keine Geheimnisse oder echten Kennungen", () => {
    const files = listExampleFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(join(EXAMPLE_DIR, file), "utf8");
      expect(text, file).not.toMatch(/-----BEGIN/);
      expect(text, file).not.toMatch(/password\s*:\s*"(?!SYN-)[^"]+/);
    }
  });
});

describe("T3 Contract: OpenAPI-Datei", () => {
  const document = parseYaml(readFileSync(OPENAPI_FILE, "utf8")) as any;

  it("ist syntaktisch gueltiges OpenAPI 3.0.3 mit Vertragsversion 0.1.0", () => {
    expect(document.openapi).toBe("3.0.3");
    expect(document.info?.title).toBeTruthy();
    expect(document.info?.version).toBe("0.1.0");
    expect(document.paths).toBeTruthy();
    expect(document.components?.securitySchemes?.adminSession?.in).toBe("cookie");
    expect(document.components?.securitySchemes?.deviceBearer?.scheme).toBe("bearer");
  });

  it("dokumentiert alle Pfade und Methoden des API-Vertrags", () => {
    const required: ReadonlyArray<readonly [string, string]> = [
      ["/health", "get"],
      ["/v1/device/register", "post"],
      ["/v1/device/auth/challenge", "post"],
      ["/v1/device/auth/token", "post"],
      ["/v1/device/heartbeat", "post"],
      ["/v1/admin/login", "post"],
      ["/v1/admin/logout", "post"],
      ["/v1/admin/registration-codes", "post"],
      ["/v1/admin/registration-codes", "get"],
      ["/v1/admin/registration-codes/{id}", "delete"],
      ["/v1/admin/devices", "get"],
      ["/v1/admin/devices/{id}", "get"],
      ["/v1/admin/devices/{id}/revoke", "post"],
    ];
    for (const [path, method] of required) {
      expect(document.paths[path], path).toBeDefined();
      expect(document.paths[path][method], path + " " + method).toBeDefined();
    }
  });

  it("referenziert nur vorhandene Vertragsdateien", () => {
    const refs: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          if (key === "$ref" && typeof child === "string" && child.startsWith("./")) {
            refs.push(child);
          } else {
            walk(child);
          }
        }
      }
    };
    walk(document);
    expect(refs.length).toBeGreaterThan(0);
    const base = dirname(OPENAPI_FILE);
    for (const ref of refs) {
      expect(existsSync(resolve(base, ref)), ref).toBe(true);
    }
    expect(refs).toContain("./schemas/error.response.schema.json");
  });
});
