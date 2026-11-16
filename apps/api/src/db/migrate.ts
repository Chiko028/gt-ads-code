import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
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

/** Optionen fuer migrateLatest; der Ordner ist im Test injizierbar. */
export interface MigrateLatestOptions {
  migrationsDirectory?: string;
}

/**
 * Nachverfolgungstabelle. Sie liegt bewusst in derselben Datenbank wie das
 * Schema, damit Migration und Eintrag gemeinsam committet oder gerollt
 * werden.
 */
const TRACKING_TABLE_SQL = `
create table if not exists schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
)`;

/**
 * Feste Schluesselnummer der Advisory-Sperre. Sie serialisiert sowohl das
 * Anlegen der Nachverfolgungstabelle als auch jede einzelne Migration, damit
 * zwei parallele migrateLatest-Aufrufe nichts doppelt anwenden.
 */
const MIGRATION_LOCK_KEY = 1310016;

interface QueryResult {
  rows: Array<Record<string, unknown>>;
}

/** Executor, der Transaktionen auf einer dedizierten Verbindung ausfuehrt. */
interface TransactionalExecutor {
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
}

async function transactionalExecutor(
  executor: SqlExecutor,
): Promise<{ client: TransactionalExecutor; release: () => void }> {
  if (executor instanceof Pool) {
    const client = await executor.connect();
    return {
      client: client as unknown as TransactionalExecutor,
      release: () => {
        (client as PoolClient).release();
      },
    };
  }
  return {
    client: executor as unknown as TransactionalExecutor,
    release: () => undefined,
  };
}

async function listUpMigrations(directory: string): Promise<string[]> {
  const entries = await readdir(directory);
  return entries.filter((name) => name.endsWith(".up.sql")).sort();
}

async function ensureTrackingTable(client: TransactionalExecutor): Promise<void> {
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock($1)", [
      MIGRATION_LOCK_KEY,
    ]);
    await client.query(TRACKING_TABLE_SQL);
    await client.query("commit");
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Ein Rollback-Fehler darf den urspruenglichen Fehler nicht verdecken.
    }
    throw error;
  }
}

/**
 * Wendet eine einzelne Migration in einer eigenen Transaktion an. Die
 * Advisory-Sperre wird erst innerhalb der Transaktion genommen und die
 * Nachverfolgung erneut geprueft: Ein paralleler Aufruf wartet, sieht danach
 * den Eintrag und ueberspringt die Migration.
 *
 * Liefert true, wenn diese Migration in diesem Aufruf angewandt wurde.
 */
async function applyMigration(
  client: TransactionalExecutor,
  directory: string,
  name: string,
): Promise<boolean> {
  const sql = await readFile(join(directory, name), "utf8");
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock($1)", [
      MIGRATION_LOCK_KEY,
    ]);
    const existing = await client.query(
      "select 1 from schema_migrations where name = $1",
      [name],
    );
    if (existing.rows.length > 0) {
      await client.query("commit");
      return false;
    }
    await client.query(sql);
    await client.query("insert into schema_migrations (name) values ($1)", [
      name,
    ]);
    await client.query("commit");
    return true;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Ein Rollback-Fehler darf den urspruenglichen Fehler nicht verdecken.
    }
    throw error;
  }
}

/**
 * Wendet alle noch nicht angewandten *.up.sql-Migrationen in Dateinamen-
 * reihenfolge an und liefert die in diesem Aufruf neu angewandten Dateinamen.
 *
 * Jede Migration laeuft in einer eigenen Transaktion: Migration, Eintrag in
 * schema_migrations und Commit gehoeren zusammen. Bei einem Fehler wird
 * zurueckgerollt, der Fehler unveraendert weitergereicht und keine spaetere
 * Migration mehr angewandt.
 *
 * Ein pg.Pool wird intern auf einen dedizierten PoolClient abgebildet
 * (connect/release), weil Transaktionen eine feste Verbindung brauchen.
 * Ein bereits dedizierter Client kann direkt uebergeben werden.
 */
export async function migrateLatest(
  executor: SqlExecutor,
  options: MigrateLatestOptions = {},
): Promise<string[]> {
  const directory = options.migrationsDirectory ?? migrationsDirectory;
  const names = await listUpMigrations(directory);
  const { client, release } = await transactionalExecutor(executor);
  try {
    await ensureTrackingTable(client);
    const applied: string[] = [];
    for (const name of names) {
      if (await applyMigration(client, directory, name)) {
        applied.push(name);
      }
    }
    return applied;
  } finally {
    release();
  }
}

/** Hilfsfunktion fuer CLI/Start: eigener Pool, garantiert geschlossen. */
export async function migrateLatestWithNewPool(
  options: MigrateLatestOptions = {},
): Promise<string[]> {
  const pool = createDatabasePool();
  try {
    return await migrateLatest(pool, options);
  } finally {
    await pool.end();
  }
}
