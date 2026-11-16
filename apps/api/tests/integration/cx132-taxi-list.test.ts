/**
 * CX-132 / R-104 Teil 1: Integrationsnachweis der lesenden Taxi-Liste
 * GET /v1/admin/taxis gegen die tatsaechlich komponierte App (createServer),
 * eine echte, je Lauf frisch angelegte PostgreSQL-Datenbank (migrateLatest,
 * CX-131) und gueltige Admin-Sitzungscookies. Alle Daten sind synthetisch.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { CONFIG_DEFAULTS, type AppConfig } from "../../src/config.js";
import { hashPassword } from "../../src/crypto/password.js";
import { migrateLatest } from "../../src/db/migrate.js";
import { findRoutePolicy, hasAction } from "../../src/http/accessPolicy.js";
import type { Principal } from "../../src/http/principal.js";
import { createServer } from "../../src/http/server.js";
import { ADMIN_SESSION_COOKIE } from "../../src/modules/adminAuth/middleware.js";

const ADMIN_PASSWORD = "SYN-CX132-Liste-Passwort";
const HOST = "127.0.0.1:8080";
const TAXIS_URL = "/v1/admin/taxis";
const BASE_TIME = Date.parse("2026-01-01T00:00:00.000Z");

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let config: AppConfig;
let loginCounter = 0;
const openApps: FastifyInstance[] = [];

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

function baseConnection(): { host: string; port: number; user: string; database: string } {
  const host = process.env.PGHOST;
  const user = process.env.PGUSER;
  const database = process.env.PGDATABASE;
  if (host === undefined || user === undefined || database === undefined) {
    throw new Error("CX-132 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx132_list_" +
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
  await migrateLatest(pool);

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX132-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };
}, 90_000);

beforeEach(async () => {
  await pool.query(
    "truncate table audit_events, admin_sessions, taxi_group_memberships," +
      " device_taxi_assignments, taxis, devices, registration_codes restart identity cascade",
  );
});

afterEach(async () => {
  for (const app of openApps.splice(0)) {
    await app.close();
  }
});

afterAll(async () => {
  await pool.end();
  await maintenancePool.query("drop database if exists " + quoteIdentifier(databaseName));
  await maintenancePool.end();
}, 30_000);

async function buildApp(role: Principal["role"] | null): Promise<FastifyInstance> {
  const app = createServer({
    config,
    pool,
    now: () => new Date(),
    resolvePrincipal: async (request): Promise<Principal | null> => {
      if (role === null) {
        return null;
      }
      const cookies = request.cookies as Record<string, string | undefined> | undefined;
      const token = cookies?.[ADMIN_SESSION_COOKIE];
      if (typeof token !== "string" || token.length === 0) {
        return null;
      }
      return { id: "SYN-CX132-" + role, role };
    },
  });
  await app.ready();
  openApps.push(app);
  return app;
}

async function login(app: FastifyInstance): Promise<string> {
  loginCounter += 1;
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/login",
    headers: { host: HOST, "content-type": "application/json" },
    payload: { password: ADMIN_PASSWORD },
    remoteAddress: "192.0.2." + (60 + loginCounter),
  });
  expect(response.statusCode).toBe(204);
  const raw = response.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  expect(first, "Set-Cookie fehlt").toBeTruthy();
  const pair = String(first).split(";")[0] as string;
  expect(pair.startsWith(ADMIN_SESSION_COOKIE + "=")).toBe(true);
  return pair.slice(ADMIN_SESSION_COOKIE.length + 1);
}

async function getTaxis(app: FastifyInstance, cookie?: string) {
  const headers: Record<string, string> = { host: HOST };
  if (cookie !== undefined) {
    headers.cookie = ADMIN_SESSION_COOKIE + "=" + cookie;
  }
  return app.inject({ method: "GET", url: TAXIS_URL, headers, remoteAddress: "192.0.2.200" });
}

async function seedTaxi(id: string, name: string, active: boolean, revision: number): Promise<void> {
  await pool.query(
    "insert into taxis (id, display_name, active, revision) values ($1, $2, $3, $4)",
    [id, name, active, revision],
  );
}

async function seedDevice(): Promise<string> {
  const registrationCodeId = randomUUID();
  const deviceId = randomUUID();
  await pool.query(
    [
      "insert into registration_codes",
      "  (id, code_hash, label, created_at, created_by, expires_at)",
      "values ($1::uuid, $2, $3, $4, $5, $6)",
    ].join("\n"),
    [
      registrationCodeId,
      Buffer.from("SYN-CX132-Code-" + registrationCodeId),
      "SYN-CX132",
      new Date(BASE_TIME),
      "SYN-CX132-ADMIN",
      new Date(BASE_TIME + 3_600_000),
    ],
  );
  await pool.query(
    [
      "insert into devices",
      "  (id, label, public_key_spki, public_key_fingerprint, state,",
      "   manufacturer, model, os_version, sdk_int, app_version, app_flavor,",
      "   registration_code_id, registration_request_id, registered_at, last_seen_at)",
      "values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,",
      "        $12::uuid, $13::uuid, $14, $15)",
    ].join("\n"),
    [
      deviceId,
      "SYN-CX132-Tablet",
      Buffer.from("SYN-CX132-Key-" + deviceId),
      "SYN-CX132-FP-" + deviceId,
      "active",
      "SYN-Hersteller",
      "SYN-Modell",
      "SYN-Android",
      34,
      "0.0.0-syn",
      "syn",
      registrationCodeId,
      randomUUID(),
      new Date(BASE_TIME),
      new Date(BASE_TIME),
    ],
  );
  return deviceId;
}

async function assign(deviceId: string, taxiId: string, active: boolean): Promise<void> {
  await pool.query(
    "insert into device_taxi_assignments (device_id, taxi_id, active) values ($1::uuid, $2, $3)",
    [deviceId, taxiId, active],
  );
}

async function addGroup(groupId: string, taxiId: string): Promise<void> {
  await pool.query(
    "insert into taxi_group_memberships (group_id, taxi_id) values ($1, $2)",
    [groupId, taxiId],
  );
}

async function snapshot(): Promise<string> {
  const parts: unknown[] = [];
  for (const sql of [
    "select id, display_name, active, revision::text from taxis order by id",
    "select device_id::text, taxi_id, active, updated_at from device_taxi_assignments order by device_id, taxi_id",
    "select group_id, taxi_id from taxi_group_memberships order by group_id, taxi_id",
    "select count(*)::text as n from audit_events",
  ]) {
    parts.push((await pool.query(sql)).rows);
  }
  return JSON.stringify(parts);
}

describe("CX-132 GET /v1/admin/taxis", () => {
  it("liefert aktive und inaktive Taxis nach id sortiert mit Gruppen und nur aktiven Tablets im Dashboard-Format", async () => {
    await seedTaxi("SYN-TAXI-C", "Taxi C", true, 3);
    await seedTaxi("SYN-TAXI-A", "Taxi A", false, 1);
    await seedTaxi("SYN-TAXI-B", "Taxi B", true, 7);
    const devices = [await seedDevice(), await seedDevice(), await seedDevice(), await seedDevice()];
    const [d1, d2] = [devices[0] as string, devices[1] as string].sort();
    await assign(d2, "SYN-TAXI-C", true);
    await assign(d1, "SYN-TAXI-C", true);
    await assign(devices[2] as string, "SYN-TAXI-C", false); // historische Zuordnung
    await addGroup("gruppe-c", "SYN-TAXI-C");
    await addGroup("gruppe-a", "SYN-TAXI-C");
    await addGroup("gruppe-b", "SYN-TAXI-C");
    await addGroup("gruppe-a", "SYN-TAXI-B");
    await assign(devices[3] as string, "SYN-FREMD", true); // fremde Zuordnung

    const app = await buildApp("Admin");
    const response = await getTaxis(app, await login(app));
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      items: [
        { id: "SYN-TAXI-A", display_name: "Taxi A", active: false, revision: 1, tablet_ids: [null, null], group_ids: [] },
        { id: "SYN-TAXI-B", display_name: "Taxi B", active: true, revision: 7, tablet_ids: [null, null], group_ids: ["gruppe-a"] },
        { id: "SYN-TAXI-C", display_name: "Taxi C", active: true, revision: 3, tablet_ids: [d1, d2],
          group_ids: ["gruppe-a", "gruppe-b", "gruppe-c"] },
      ],
    });
  });

  it("fuellt fehlende Tablets mit null auf, liefert ohne Taxis {items:[]} und veraendert keine Daten", async () => {
    const app = await buildApp("Admin");
    const cookie = await login(app);
    await seedTaxi("SYN-TAXI-X", "Taxi X", true, 2);
    const device = await seedDevice();
    await assign(device, "SYN-TAXI-X", true);
    await addGroup("gruppe-x", "SYN-TAXI-X");
    const before = await snapshot();
    const filled = await getTaxis(app, cookie);
    expect(filled.statusCode).toBe(200);
    expect((filled.json() as { items: Array<Record<string, unknown>> }).items[0]).toMatchObject({
      tablet_ids: [device, null], group_ids: ["gruppe-x"],
    });
    expect(await snapshot()).toBe(before);

    await pool.query("truncate table taxi_group_memberships, device_taxi_assignments, taxis restart identity cascade");
    const empty = await getTaxis(app, cookie);
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ items: [] });
  });

  it("verlangt Anmeldung und devices.read ueber den zentralen Rechtekern der komponierten App", async () => {
    await seedTaxi("SYN-TAXI-R", "Taxi R", true, 1);
    // Ohne Prinzipal bzw. ohne Sitzung: 401, ohne Taxidaten in der Antwort.
    for (const [role, withCookie] of [[null, false], ["Admin", false]] as const) {
      const app = await buildApp(role);
      const response = await getTaxis(app, withCookie ? await login(app) : undefined);
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain("SYN-TAXI-R");
    }
    // Beide vorhandenen Rollen besitzen devices.read und erhalten 200.
    for (const role of ["Operator", "Admin"] as const) {
      const app = await buildApp(role);
      const response = await getTaxis(app, await login(app));
      expect(response.statusCode).toBe(200);
      expect((response.json() as { items: unknown[] }).items).toHaveLength(1);
    }
    // Eine Rolle ohne devices.read existiert derzeit nicht; der Rechtekern bildet fehlende
    // Rechte auf 403 ab (enforceHumanPolicy). Hier wird die Policy der Route belegt.
    expect(findRoutePolicy("GET", TAXIS_URL)).toEqual({ category: "human", action: "devices.read" });
    expect(hasAction("Operator", "taxi.activation")).toBe(false);
  });
});
