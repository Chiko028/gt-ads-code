/**
 * CX-131 / R-001: migrateLatest gegen echtes PostgreSQL.
 *
 * Jeder Fall legt eine eigene, frische Testdatenbank an (wie CX-124) und
 * raeumt sie wieder ab. Es gibt keinen Netzwerkzugriff und keine
 * Produktivdaten; alle Namen sind synthetisch.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateLatest } from "../../src/db/migrate.js";

const EXPECTED_MIGRATIONS = [
  "0001_gt_ads_001.up.sql",
  "0002_gt_ads_004_telemetry.up.sql",
  "0003_cx_011_telemetry_rollups.up.sql",
  "0004_cx_012_remote_control.up.sql",
  "0005_cx_013_control_config.up.sql",
  "0006_cx_028_technical_alarms.up.sql",
  "0007_cx_030_media.up.sql",
  "0008_cx_065_admin_mfa_recovery_codes.up.sql",
  "0009_campaign_customers.up.sql",
  "0010_cx_041_manifest_refresh.up.sql",
  "0011_cx_078_media_deletion.up.sql",
  "0012_cx_101_campaign_drafts.up.sql",
  "0013_cx_106_pending_totp_enrollment.up.sql",
  "0014_cx_128_device_inventory.up.sql",
  "0015_cx_057_operators.up.sql",
  "0016_taxi_structures.up.sql",
  "0017_spot_plays.up.sql",
  "0018_app_releases.up.sql",
];

let maintenancePool: Pool;
let sequence = 0;
const createdDatabases: string[] = [];

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

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
    throw new Error("CX-131 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

async function createTestDatabase(): Promise<{ name: string; pool: Pool }> {
  sequence += 1;
  const name = (
    "gtads_cx131_migrations_" +
    process.pid +
    "_" +
    sequence +
    "_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 8)
  )
    .toLowerCase()
    .slice(0, 63);
  await maintenancePool.query("create database " + quoteIdentifier(name));
  createdDatabases.push(name);
  const pool = new Pool({ ...baseConnection(), database: name, max: 4 });
  return { name, pool };
}

async function tableExists(pool: Pool, tableName: string): Promise<boolean> {
  const result = await pool.query<{ present: boolean }>(
    "select to_regclass($1) is not null as present",
    [tableName],
  );
  return result.rows[0]?.present === true;
}

async function trackedNames(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ name: string }>(
    "select name from schema_migrations order by name",
  );
  return result.rows.map((row) => row.name);
}

beforeAll(() => {
  maintenancePool = new Pool(baseConnection());
});

afterAll(async () => {
  for (const name of createdDatabases) {
    await maintenancePool.query(
      "drop database if exists " + quoteIdentifier(name) + " with (force)",
    );
  }
  await maintenancePool.end();
}, 60_000);

describe("CX-131 migrateLatest", () => {
  it("wendet auf leerer Datenbank alle Migrationen 0001 bis 0018 in Reihenfolge an", async () => {
    const { pool } = await createTestDatabase();
    try {
      const applied = await migrateLatest(pool);
      expect(applied).toEqual(EXPECTED_MIGRATIONS);
      expect(await trackedNames(pool)).toEqual(EXPECTED_MIGRATIONS);
      for (const table of [
        "taxis",
        "device_taxi_assignments",
        "media_objects",
        "operators",
        "spot_plays",
        "app_releases",
        "app_release_device_reports",
      ]) {
        expect(await tableExists(pool, table)).toBe(true);
      }
    } finally {
      await pool.end();
    }
  }, 60_000);

  it("wendet beim zweiten Aufruf nichts an und liefert eine leere Liste", async () => {
    const { pool } = await createTestDatabase();
    try {
      const first = await migrateLatest(pool);
      expect(first).toEqual(EXPECTED_MIGRATIONS);
      const second = await migrateLatest(pool);
      expect(second).toEqual([]);
      expect(await trackedNames(pool)).toEqual(EXPECTED_MIGRATIONS);
    } finally {
      await pool.end();
    }
  }, 60_000);

  it("wendet bei zwei gleichzeitigen Aufrufen jede Migration genau einmal an", async () => {
    const { name, pool } = await createTestDatabase();
    const concurrentPool = new Pool({
      ...baseConnection(),
      database: name,
      max: 2,
    });
    try {
      const [first, second] = await Promise.all([
        migrateLatest(pool),
        migrateLatest(concurrentPool),
      ]);
      const combined = [...first, ...second].sort();
      expect(combined).toEqual(EXPECTED_MIGRATIONS);
      expect(new Set(combined).size).toBe(EXPECTED_MIGRATIONS.length);
      const count = await pool.query<{ count: number }>(
        "select count(*)::int as count from schema_migrations",
      );
      expect(count.rows[0]?.count).toBe(EXPECTED_MIGRATIONS.length);
      expect(await trackedNames(pool)).toEqual(EXPECTED_MIGRATIONS);
    } finally {
      await concurrentPool.end();
      await pool.end();
    }
  }, 60_000);

  it("rollt eine fehlschlagende Migration zurueck, reicht den Fehler weiter und stoppt danach", async () => {
    const { pool } = await createTestDatabase();
    const directory = await mkdtemp(join(tmpdir(), "cx131-migrations-"));
    try {
      await writeFile(
        join(directory, "0001_first.up.sql"),
        "create table cx131_first (id integer primary key);\n",
        "utf8",
      );
      await writeFile(
        join(directory, "0002_fails.up.sql"),
        [
          "create table cx131_rolled_back (id integer primary key);",
          "insert into cx131_missing_table values (1);",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        join(directory, "0003_later.up.sql"),
        "create table cx131_later (id integer primary key);\n",
        "utf8",
      );

      const error = await migrateLatest(pool, {
        migrationsDirectory: directory,
      }).then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/cx131_missing_table/);

      expect(await tableExists(pool, "cx131_first")).toBe(true);
      expect(await tableExists(pool, "cx131_rolled_back")).toBe(false);
      expect(await tableExists(pool, "cx131_later")).toBe(false);
      expect(await trackedNames(pool)).toEqual(["0001_first.up.sql"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await pool.end();
    }
  }, 60_000);
});
