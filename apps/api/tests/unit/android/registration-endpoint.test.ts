import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS, type AppConfig } from "../../../src/config.js";
import { migrateUp } from "../../../src/db/migrate.js";
import { createServer } from "../../../src/http/server.js";
import { RegistrationService } from "../../../src/modules/registration/service.js";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let config: AppConfig;
let app: FastifyInstance;

function baseConnection(): { host: string; port: number; user: string; database: string } {
  const host = process.env.PGHOST;
  const user = process.env.PGUSER;
  const database = process.env.PGDATABASE;
  if (host === undefined || user === undefined || database === undefined) {
    throw new Error("CX-071 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

function syntheticKey(): string {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = ("gtads_cx071_" + process.pid + "_" + Date.now().toString(36))
    .toLowerCase()
    .slice(0, 63);
  await maintenancePool.query("create database " + quoteIdentifier(databaseName));
  pool = new Pool({ ...base, database: databaseName });
  await migrateUp(pool);
  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX071-Code-Pepper",
    adminPasswordHash:
      "scrypt$N=16384,r=8,p=1$c3ludGhldGlzY2hlLXNhbHQ$aGFzaC1oYXNoLWhhc2gtaGFzaC1oYXNo",
  };
  app = createServer({ config, pool, now: () => new Date() });
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app.close();
  await pool.end();
  await maintenancePool.query(
    "drop database if exists " + quoteIdentifier(databaseName),
  );
  await maintenancePool.end();
}, 30_000);

describe("CX-071 Registrierungsroute", () => {
  it("bestaetigt die Erstregistrierung, wiederholt identisch und lehnt abweichende Wiederverwendung ab", async () => {
    const service = new RegistrationService({ pool, config });
    const created = await service.createRegistrationCode({ label: "SYN-CX071" });
    const body = {
      registration_code: created.code,
      client_request_id: randomUUID(),
      public_key: syntheticKey(),
      app_env: "test",
      device_info: {
        manufacturer: "SYN-Hersteller",
        model: "SYN-Modell",
        os_version: "14",
        sdk_int: 34,
        app_version: "0.1.0",
        app_flavor: "dev",
      },
    };
    const send = (payload: unknown) =>
      app.inject({
        method: "POST",
        url: "/v1/device/register",
        headers: {
          "content-type": "application/json",
          "x-gt-ads-api-version": "1",
        },
        payload: payload as Record<string, unknown>,
        remoteAddress: "198.51.100.71",
      });

    const first = await send(body);
    expect(first.statusCode).toBe(201);
    const firstBody = first.json();
    expect(firstBody.device_id).toMatch(UUID_V4);
    expect(firstBody.server_env).toBe("test");
    expect(firstBody.config).toEqual({
      heartbeat_interval_s: config.heartbeatIntervalSeconds,
      api_version: 1,
    });

    const repeat = await send(body);
    expect(repeat.statusCode).toBe(201);
    expect(repeat.json().device_id).toBe(firstBody.device_id);

    const different = await send({
      ...body,
      client_request_id: randomUUID(),
      public_key: syntheticKey(),
    });
    expect(different.statusCode).toBe(400);
    expect(different.json().error.code).toBe("invalid_registration_code");

    const devices = await pool.query<{ count: number }>(
      "select count(*)::int as count from devices where registration_code_id = $1",
      [created.id],
    );
    expect(devices.rows[0]?.count).toBe(1);
    const binding = await pool.query<{ id: string }>(
      "select id from devices where registration_code_id = $1",
      [created.id],
    );
    expect(binding.rows[0]?.id).toBe(firstBody.device_id);
  });
});
