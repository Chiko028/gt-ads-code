import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPostgresReadinessProbe,
  queryWithDeadline,
  READINESS_TIMEOUT_MS,
} from "../../../src/modules/operations/readiness.js";

let pool: Pool;

function baseConnection(): {
  host: string;
  port: number;
  user: string;
  database: string;
} {
  const host = process.env.PGHOST;
  const user = process.env.PGUSER;
  const database = process.env.PGDATABASE;
  if (host === undefined || user === undefined || database === undefined) {
    throw new Error("CX-018 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

beforeAll(() => {
  pool = new Pool({ ...baseConnection(), max: 2 });
}, 10_000);

afterAll(async () => {
  await pool.end();
}, 10_000);

describe("Readiness-SQL-Frist am vorhandenen Datenbankzugang", () => {
  it("SELECT 1 ueber den vorhandenen Pool ist erfolgreich", async () => {
    const probe = createPostgresReadinessProbe(pool);
    await expect(probe.check()).resolves.toBeUndefined();
  });

  it("beendet eine laufende SQL-Anfrage nach 1000 ms wirksam", async () => {
    expect(READINESS_TIMEOUT_MS).toBe(1000);

    const started = Date.now();
    let failure: unknown;
    try {
      await queryWithDeadline(pool, "select pg_sleep(2)");
    } catch (error: unknown) {
      failure = error;
    }
    const elapsed = Date.now() - started;

    expect(failure).toBeInstanceOf(Error);
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(2500);

    const afterTimeout = await pool.query("select 1 as ok");
    expect(afterTimeout.rows[0].ok).toBe(1);
  }, 10_000);
});
