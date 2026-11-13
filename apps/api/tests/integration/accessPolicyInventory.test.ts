import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS, type AppConfig } from "../../src/config.js";
import { hashPassword } from "../../src/crypto/password.js";
import { migrateUp } from "../../src/db/migrate.js";
import { getRoutePolicyInventory } from "../../src/http/authorization.js";
import { createServer } from "../../src/http/server.js";

const BASE_TIME = Date.parse("2026-01-01T12:00:00.000Z");
const ADMIN_PASSWORD = "SYN-CX015-Inventar-Passwort";

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let config: AppConfig;

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
    throw new Error("CX-015 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx015_inventory_" +
    process.pid +
    "_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 8)
  )
    .toLowerCase()
    .slice(0, 63);
  await maintenancePool.query("create database " + quoteIdentifier(databaseName));

  pool = new Pool({ ...base, database: databaseName });
  await migrateUp(pool);

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX015-Inventar-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };
}, 60_000);

afterAll(async () => {
  await pool.end();
  await maintenancePool.query(
    "drop database if exists " + quoteIdentifier(databaseName),
  );
  await maintenancePool.end();
}, 30_000);

async function closeQuietly(app: FastifyInstance): Promise<void> {
  try {
    await app.close();
  } catch {
    // Ein App-Start, der absichtlich verweigert wurde, hinterlaesst nichts.
  }
}

describe("CX-015 Rechtekern: Routeninventar", () => {
  it("erfasst jede Methode und jedes Routentemplate mit Policy und verweigert den Start bei unklassifizierten Routen", async () => {
    const app = createServer({ config, pool, now: () => new Date(BASE_TIME) });
    await app.ready();

    try {
      const inventory = getRoutePolicyInventory(app);
      expect(inventory.length).toBeGreaterThan(20);

      const keys = new Set(
        inventory.map((record) => record.method + " " + record.url),
      );

      // Vorhandene Routen aller Module, inklusive der in einem
      // gekapselten Kontext registrierten Betriebsrouten.
      for (const expected of [
        "GET /health",
        "POST /v1/device/register",
        "POST /v1/device/auth/challenge",
        "POST /v1/device/auth/token",
        "POST /v1/device/heartbeat",
        "POST /v1/admin/login",
        "POST /v1/admin/logout",
        "GET /v1/admin/devices",
        "GET /v1/admin/devices/:id",
        "POST /v1/admin/devices/:id/revoke",
        "GET /v1/admin/registration-codes",
        "POST /v1/admin/registration-codes",
        "DELETE /v1/admin/registration-codes/:id",
        "GET /internal/ready",
        "GET /internal/metrics",
      ]) {
        expect(keys.has(expected), "Route fehlt im Inventar: " + expected).toBe(
          true,
        );
      }

      // Automatisch erzeugte HEAD-Routen werden mit erfasst und erben die
      // Policy der GET-Route.
      expect(keys.has("HEAD /health")).toBe(true);
      const headRecord = inventory.find(
        (record) => record.method === "HEAD" && record.url === "/health",
      );
      expect(headRecord?.policy?.category).toBe("public");

      // Jede erfasste Route besitzt eine explizite Policy.
      for (const record of inventory) {
        expect(
          record.policy,
          "ohne Policy: " + record.method + " " + record.url,
        ).not.toBeNull();
      }

      // Die automatisch erzeugte HEAD-Route ist tatsaechlich erreichbar.
      const head = await app.inject({ method: "HEAD", url: "/health" });
      expect(head.statusCode).toBe(200);
    } finally {
      await closeQuietly(app);
    }

    // Eine zusaetzlich registrierte, unklassifizierte Route verhindert den
    // Start: sowohl auf der Wurzel als auch in einem gekapselten Kontext.
    const broken = createServer({ config, pool, now: () => new Date(BASE_TIME) });
    broken.get("/v1/admin/unklassifizierte-probe", async () => ({ ok: true }));
    broken.register(async (scope) => {
      scope.get("/v1/admin/verschachtelte-probe", async () => ({ ok: true }));
    });

    await expect(broken.ready()).rejects.toThrow(/unklassifiziert/i);
    await closeQuietly(broken);
  });
});
