import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabasePool } from "./client.js";

/** Minimale Schnittstelle, die pg.Client und pg.Pool erfuellen. */
export interface SqlExecutor {
  query(sql: string): Promise<unknown>;
}

const migrationsDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

const UP_MIGRATION = "0001_gt_ads_001.up.sql";
const DOWN_MIGRATION = "0001_gt_ads_001.down.sql";

const ALLOWED_DOWN_ENVIRONMENTS: ReadonlySet<string> = new Set([
  "dev",
  "test",
]);

/**
 * Der Rueckweg ist nur in dev/test erlaubt (AC-14/AC-18).
 * Fehlt GT_ADS_ENV oder ist es ein anderer Wert, wird verweigert.
 */
export function assertDownAllowed(
  env: string | undefined = process.env.GT_ADS_ENV,
): void {
  if (env === undefined || !ALLOWED_DOWN_ENVIRONMENTS.has(env)) {
    throw new Error(
      "Down-Migration ist nur in dev/test erlaubt " +
        "(GT_ADS_ENV=" + (env ?? "<nicht gesetzt>") + ")",
    );
  }
}

async function readMigration(fileName: string): Promise<string> {
  return readFile(join(migrationsDirectory, fileName), "utf8");
}

/** Fuehrt Migration 0001 vorwaerts aus. */
export async function migrateUp(executor: SqlExecutor): Promise<void> {
  const sql = await readMigration(UP_MIGRATION);
  await executor.query(sql);
}

/**
 * Fuehrt Migration 0001 rueckwaerts aus. Verweigert ausserhalb von dev/test,
 * bevor die Datenbank beruehrt wird.
 */
export async function migrateDown(
  executor: SqlExecutor,
  env: string | undefined = process.env.GT_ADS_ENV,
): Promise<void> {
  assertDownAllowed(env);
  const sql = await readMigration(DOWN_MIGRATION);
  await executor.query(sql);
}

/** Hilfsfunktion fuer CLI/Start: eigener Pool, garantiert geschlossen. */
export async function migrateUpWithNewPool(): Promise<void> {
  const pool = createDatabasePool();
  try {
    await migrateUp(pool);
  } finally {
    await pool.end();
  }
}

/** Hilfsfunktion fuer CLI/Start: eigener Pool, garantiert geschlossen. */
export async function migrateDownWithNewPool(): Promise<void> {
  const pool = createDatabasePool();
  try {
    await migrateDown(pool);
  } finally {
    await pool.end();
  }
}
