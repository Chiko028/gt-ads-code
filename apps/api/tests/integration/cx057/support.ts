/**
 * Gemeinsame, echte PostgreSQL-17-Sandbox fuer die CX-057-Integrationsgruppen.
 *
 * Es gibt keine Repository-Mocks und kein Skip bei fehlender Datenbank: ohne
 * with-postgres-Umgebung schlaegt der Aufbau sichtbar fehl. Jeder Kontext legt
 * eine eigene Datenbank an und wendet alle Migrationen in Reihenfolge an.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { CONFIG_DEFAULTS, type AppConfig } from "../../../src/config.js";
import { hashPassword } from "../../../src/crypto/password.js";
import { migrateUp } from "../../../src/db/migrate.js";
import { createServer } from "../../../src/http/server.js";

export const HOST = "127.0.0.1:8080";
export const BASE_TIME = Date.parse("2026-08-01T10:00:00.000Z");
export const ADMIN_PASSWORD = "SYN-CX057-Admin-Passwort";
export const OPERATOR_PASSWORD = "SYN-CX057-Operator-Passwort";

export interface OperatorTestContext {
  readonly pool: Pool;
  readonly config: AppConfig;
  /** Baut eine echte Serverinstanz ohne injizierten Principal-Resolver. */
  buildApp(): Promise<FastifyInstance>;
  closeApps(): Promise<void>;
  /** Setzt Fach- und Sitzungsdaten zwischen den Gruppen zurueck. */
  reset(): Promise<void>;
  close(): Promise<void>;
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
    throw new Error("CX-057 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

export function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

export async function createOperatorTestContext(): Promise<OperatorTestContext> {
  const base = baseConnection();
  const maintenancePool = new Pool(base);
  const databaseName = (
    "gtads_cx057_" +
    process.pid +
    "_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 8)
  )
    .toLowerCase()
    .slice(0, 63);

  await maintenancePool.query(
    "create database " + quoteIdentifier(databaseName),
  );

  const pool = new Pool({ ...base, database: databaseName });
  try {
    await migrateUp(pool);

    // Die uebrigen additiven Migrationen werden wie im Runner in Reihenfolge
    // angewendet; 0001 ist bereits durch migrateUp gelaufen.
    const migrationsDirectory = join(process.cwd(), "src/db/migrations");
    for (const file of (await readdir(migrationsDirectory)).sort()) {
      if (!file.endsWith(".up.sql") || file === "0001_gt_ads_001.up.sql") {
        continue;
      }
      await pool.query(await readFile(join(migrationsDirectory, file), "utf8"));
    }
  } catch (error) {
    await pool.end();
    await maintenancePool.query(
      "drop database if exists " + quoteIdentifier(databaseName),
    );
    await maintenancePool.end();
    throw error;
  }

  const config: AppConfig = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX057-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };

  const openApps: FastifyInstance[] = [];

  return {
    pool,
    config,
    async buildApp(): Promise<FastifyInstance> {
      const app = createServer({
        config,
        pool,
        now: () => new Date(BASE_TIME),
      });
      await app.ready();
      openApps.push(app);
      return app;
    },
    async closeApps(): Promise<void> {
      for (const app of openApps.splice(0)) {
        await app.close();
      }
    },
    async reset(): Promise<void> {
      await pool.query(
        "truncate table audit_events, admin_sessions, operators restart identity cascade",
      );
      await pool.query(
        "drop trigger if exists cx057_fail_audit on audit_events",
      );
      await pool.query("drop function if exists cx057_fail_audit()");
    },
    async close(): Promise<void> {
      for (const app of openApps.splice(0)) {
        await app.close();
      }
      await pool.end();
      await maintenancePool.query(
        "drop database if exists " + quoteIdentifier(databaseName),
      );
      await maintenancePool.end();
    },
  };
}
