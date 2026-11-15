import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileSchema, createContractAjv } from "../../contract/contractFiles.js";

const FIXTURE_PATH = fileURLToPath(
  new URL(
    "../../../../../apps/android/app/src/test/resources/registration/device-register.request.json",
    import.meta.url,
  ),
);

function readFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Record<string, unknown>;
}

describe("Android-Registrierungsfixture gegen den U7-Vertrag", () => {
  it("die vom Android-Erfolgstest gelesene Fixture besteht das Registrierungsschema", () => {
    const ajv = createContractAjv();
    const validate = compileSchema(ajv, "device-register.request.schema.json");
    const fixture = readFixture();

    expect(validate(fixture), ajv.errorsText(validate.errors ?? [])).toBe(true);
  });

  it("das Entfernen eines erforderlichen Feldes wird abgelehnt", () => {
    const ajv = createContractAjv();
    const validate = compileSchema(ajv, "device-register.request.schema.json");
    const fixture = readFixture();
    delete fixture.public_key;

    expect(validate(fixture), ajv.errorsText(validate.errors ?? [])).toBe(false);
  });
});
