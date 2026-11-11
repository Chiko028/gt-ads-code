import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDown, migrateUp } from "../../src/db/migrate.js";

const EXPECTED_TABLES = [
  "admin_sessions",
  "audit_events",
  "device_access_tokens",
  "device_auth_challenges",
  "devices",
  "registration_codes",
].sort();

let pool: Pool;

beforeAll(() => {
  pool = new Pool({ connectionString: process.env.GT_ADS_DB_URL });
});

afterAll(async () => {
  await pool.end();
});

async function listTables(): Promise<string[]> {
  const sql = [
    "select table_name",
    "  from information_schema.tables",
    " where table_schema = 'public'",
    "   and table_type = 'BASE TABLE'",
    " order by table_name",
  ].join("\n");
  const result = await pool.query<{ table_name: string }>(sql);
  return result.rows.map((row) => row.table_name);
}

describe("I-01 Migration 0001", () => {
  it("legt das Schema an, entfernt es beim Down und legt es erneut an", async () => {
    process.env.GT_ADS_ENV = "test";

    // Sauberer Ausgangszustand (Down ist idempotent via IF EXISTS).
    await migrateDown(pool);
    expect(await listTables()).toEqual([]);

    await migrateUp(pool);
    expect(await listTables()).toEqual(EXPECTED_TABLES);

    await migrateDown(pool);
    expect(await listTables()).toEqual([]);

    await migrateUp(pool);
    expect(await listTables()).toEqual(EXPECTED_TABLES);

    await migrateDown(pool);
  });
});

describe("I-02 Down-Guard", () => {
  it("verweigert Down mit GT_ADS_ENV=prod und laesst das Schema unveraendert", async () => {
    process.env.GT_ADS_ENV = "test";
    await migrateDown(pool);
    await migrateUp(pool);

    await expect(migrateDown(pool, "prod")).rejects.toThrow(/dev\/test/);
    expect(await listTables()).toEqual(EXPECTED_TABLES);

    await migrateDown(pool);
  });

  it("verweigert Down ohne GT_ADS_ENV", async () => {
    process.env.GT_ADS_ENV = "test";
    await migrateUp(pool);

    delete process.env.GT_ADS_ENV;
    await expect(migrateDown(pool)).rejects.toThrow(/dev\/test/);

    process.env.GT_ADS_ENV = "test";
    expect(await listTables()).toEqual(EXPECTED_TABLES);
    await migrateDown(pool);
  });
});
