/**
 * Gemeinsame, echte PostgreSQL-17-Sandbox fuer die CX-058-Tests.
 *
 * Es gibt keine Repository-Mocks und kein Skip bei fehlender Datenbank: ohne
 * with-postgres-Umgebung schlaegt der Aufbau sichtbar fehl.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Pool } from "pg";
import { CONFIG_DEFAULTS, type AppConfig } from "../../../src/config.js";
import { hashPassword } from "../../../src/crypto/password.js";
import { migrateUp } from "../../../src/db/migrate.js";
import { createServer } from "../../../src/http/server.js";
import { ADMIN_SESSION_COOKIE } from "../../../src/modules/adminAuth/middleware.js";

export const BASE_TIME = Date.parse("2026-05-01T10:00:00.000Z");
export const ADMIN_PASSWORD = "SYN-CX058-Audit-Passwort";
export const ADMIN_ACTOR_ID = "SYN-CX058-Admin";
export const OPERATOR_ACTOR_ID = "SYN-CX058-Operator";

export type AuditTestRole = "Admin" | "Operator" | null;

export interface AuditTestContext {
  readonly pool: Pool;
  readonly config: AppConfig;
  buildApp(role: AuditTestRole): Promise<FastifyInstance>;
  loginCookie(app: FastifyInstance): Promise<string>;
  close(): Promise<void>;
}

export function quoteIdentifier(value: string): string {
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
    throw new Error("CX-058 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

export function adminHeaders(
  cookie?: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = { host: "127.0.0.1:8080", ...extra };
  if (cookie !== undefined) {
    headers.cookie = ADMIN_SESSION_COOKIE + "=" + cookie;
  }
  return headers;
}

export function sessionCookieOf(response: {
  headers: Record<string, unknown>;
}): string {
  const raw = response.headers["set-cookie"];
  const first = Array.isArray(raw)
    ? (raw[0] as string)
    : (raw as string | undefined);
  if (first === undefined) {
    throw new Error("Set-Cookie fehlt");
  }
  const pair = first.split(";")[0] as string;
  const prefix = ADMIN_SESSION_COOKIE + "=";
  if (!pair.startsWith(prefix)) {
    throw new Error("Unerwartetes Sitzungscookie");
  }
  return pair.slice(prefix.length);
}

export async function createAuditTestContext(): Promise<AuditTestContext> {
  const base = baseConnection();
  const maintenancePool = new Pool(base);
  const databaseName = (
    "gtads_cx058_audit_" +
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

  const config: AppConfig = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX058-Audit-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };

  const openApps: FastifyInstance[] = [];

  const context: AuditTestContext = {
    pool,
    config,
    async buildApp(role: AuditTestRole): Promise<FastifyInstance> {
      const app = createServer({
        config,
        pool,
        now: () => new Date(BASE_TIME),
        resolvePrincipal: async (request: FastifyRequest) => {
          if (role === null) {
            return null;
          }
          const cookies = request.cookies as
            | Record<string, string | undefined>
            | undefined;
          const token = cookies?.[ADMIN_SESSION_COOKIE];
          if (typeof token !== "string" || token.length === 0) {
            return null;
          }
          return {
            id: role === "Admin" ? ADMIN_ACTOR_ID : OPERATOR_ACTOR_ID,
            role,
          };
        },
      });
      await app.ready();
      openApps.push(app);
      return app;
    },
    async loginCookie(app: FastifyInstance): Promise<string> {
      const response = await app.inject({
        method: "POST",
        url: "/v1/admin/login",
        headers: { host: "127.0.0.1:8080", "content-type": "application/json" },
        payload: { password: ADMIN_PASSWORD },
        remoteAddress: "192.0.2.230",
      });
      if (response.statusCode !== 204) {
        throw new Error(
          "Admin-Anmeldung fehlgeschlagen: " + String(response.statusCode),
        );
      }
      return sessionCookieOf(response);
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

  return context;
}
