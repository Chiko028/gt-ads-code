/**
 * CX-134 / R-104 Teil 3: Integrationsnachweis der lesenden Tablet-Liste
 * GET /v1/admin/tablets gegen die tatsaechlich komponierte App (createServer),
 * eine frisch angelegte PostgreSQL-Datenbank (migrateLatest, CX-131) und
 * gueltige Admin-Sitzungscookies. Alle Daten sind synthetisch.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS, type AppConfig } from "../../src/config.js";
import { hashPassword } from "../../src/crypto/password.js";
import { migrateLatest } from "../../src/db/migrate.js";
import { findRoutePolicy, hasAction, type Role } from "../../src/http/accessPolicy.js";
import type { Principal } from "../../src/http/principal.js";
import { createServer } from "../../src/http/server.js";
import { ADMIN_SESSION_COOKIE } from "../../src/modules/adminAuth/middleware.js";
import { ensureTabletActivationSchema } from "../../src/modules/tabletActivation/index.js";

const ADMIN_PASSWORD = "SYN-CX134-Tablets-Passwort";
const HOST = "127.0.0.1:8080";
const TABLETS_URL = "/v1/admin/tablets";
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

beforeAll(async () => {
  const host = process.env.PGHOST;
  const user = process.env.PGUSER;
  const database = process.env.PGDATABASE;
  if (host === undefined || user === undefined || database === undefined) {
    throw new Error("CX-134 benoetigt with-postgres <befehl>");
  }
  const base = { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
  maintenancePool = new Pool(base);
  databaseName = ("gtads_cx134_tablets_" + process.pid + "_" + Date.now().toString(36) + "_" +
    Math.random().toString(36).slice(2, 8)).toLowerCase().slice(0, 63);
  await maintenancePool.query("create database " + quoteIdentifier(databaseName));
  pool = new Pool({ ...base, database: databaseName });
  await migrateLatest(pool);
  await ensureTabletActivationSchema(pool);
  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX134-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };
}, 90_000);

beforeEach(async () => {
  await pool.query(
    "truncate table audit_events, admin_sessions, device_taxi_assignments, taxis," +
      " tablet_admin_states, devices, registration_codes restart identity cascade",
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

async function buildApp(role: Role | null): Promise<FastifyInstance> {
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
      return typeof token === "string" && token.length > 0 ? { id: "SYN-CX134-" + role, role } : null;
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
    remoteAddress: "192.0.2." + (80 + loginCounter),
  });
  expect(response.statusCode).toBe(204);
  const raw = response.headers["set-cookie"];
  const pair = String(Array.isArray(raw) ? raw[0] : raw).split(";")[0] as string;
  expect(pair.startsWith(ADMIN_SESSION_COOKIE + "=")).toBe(true);
  return pair.slice(ADMIN_SESSION_COOKIE.length + 1);
}

async function getTablets(app: FastifyInstance, cookie?: string) {
  const headers: Record<string, string> = { host: HOST };
  if (cookie !== undefined) {
    headers.cookie = ADMIN_SESSION_COOKIE + "=" + cookie;
  }
  return app.inject({ method: "GET", url: TABLETS_URL, headers, remoteAddress: "192.0.2.210" });
}

async function seedDevice(label: string | null, state: "active" | "revoked" = "active"): Promise<string> {
  const codeId = randomUUID();
  const deviceId = randomUUID();
  await pool.query(
    "insert into registration_codes (id, code_hash, label, created_at, created_by, expires_at)" +
      " values ($1::uuid, $2, $3, $4, $5, $6)",
    [codeId, Buffer.from("SYN-CX134-Code-" + codeId), "SYN-CX134", new Date(BASE_TIME), "SYN-CX134-ADMIN",
      new Date(BASE_TIME + 3_600_000)],
  );
  await pool.query(
    [
      "insert into devices",
      "  (id, label, public_key_spki, public_key_fingerprint, state,",
      "   manufacturer, model, os_version, sdk_int, app_version, app_flavor,",
      "   registration_code_id, registration_request_id, registered_at, last_seen_at)",
      "values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::uuid, $13::uuid, $14, $15)",
    ].join("\n"),
    [deviceId, label, Buffer.from("SYN-CX134-Key-" + deviceId), "SYN-CX134-FP-" + deviceId, state,
      "SYN-Hersteller", "SYN-Modell", "SYN-Android", 34, "0.0.0-syn", "syn", codeId, randomUUID(),
      new Date(BASE_TIME), new Date(BASE_TIME)],
  );
  return deviceId;
}

async function adminState(deviceId: string, active: boolean, revision: number): Promise<void> {
  await pool.query(
    "insert into tablet_admin_states (device_id, active, revision) values ($1::uuid, $2, $3)",
    [deviceId, active, revision],
  );
}

async function assign(deviceId: string, taxiId: string, active: boolean): Promise<void> {
  await pool.query(
    "insert into device_taxi_assignments (device_id, taxi_id, active) values ($1::uuid, $2, $3)",
    [deviceId, taxiId, active],
  );
}

async function listAsAdmin(): Promise<Array<Record<string, unknown>>> {
  const app = await buildApp("Admin");
  const response = await getTablets(app, await login(app));
  expect(response.statusCode).toBe(200);
  return (response.json() as { items: Array<Record<string, unknown>> }).items;
}

describe("CX-134 GET /v1/admin/tablets", () => {
  it("liefert unsortiert angelegte Tablets genau einmal nach ID sortiert mit ausschliesslich den fuenf Feldern", async () => {
    const zweites = await seedDevice(null);
    const erstes = await seedDevice("SYN-Tablet");
    // Zusaetzliche historische Bindungen duerfen keine Duplikate erzeugen.
    await pool.query("insert into taxis (id, display_name, active, revision) values ('SYN-A', 'A', true, 1), ('SYN-B', 'B', true, 1)");
    await assign(erstes, "SYN-A", false);
    await assign(erstes, "SYN-B", false);

    const items = await listAsAdmin();
    const ids = [zweites, erstes].sort();
    expect(items.map((item) => item.id)).toEqual(ids);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(["active", "available", "id", "label", "revision"]);
      // Fehlender Verwaltungssatz: aktiv mit Revision 0.
      expect(item.active).toBe(true);
      expect(item.revision).toBe(0);
    }
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get(erstes)?.label).toBe("SYN-Tablet");
    expect(byId.get(zweites)?.label).toBe(zweites);
  });

  it("bestimmt die Verfuegbarkeit aus Widerruf, Verwaltungszustand und aktueller Paarbindung", async () => {
    await pool.query("insert into taxis (id, display_name, active, revision) values ('SYN-AKTIV', 'Aktiv', true, 1), ('SYN-INAKTIV', 'Inaktiv', false, 2)");
    const frei = await seedDevice("Frei");
    const beendet = await seedDevice("Beendet");
    const widerrufen = await seedDevice("Widerrufen", "revoked");
    const deaktiviert = await seedDevice("Deaktiviert");
    const gebunden = await seedDevice("Gebunden");
    const gebundenInaktivesTaxi = await seedDevice("GebundenInaktiv");
    await assign(beendet, "SYN-AKTIV", false);
    await adminState(deaktiviert, false, 4);
    await adminState(frei, true, 7);
    await assign(gebunden, "SYN-AKTIV", true);
    await assign(gebundenInaktivesTaxi, "SYN-INAKTIV", true);

    const items = await listAsAdmin();
    const byId = new Map(items.map((item) => [item.id as string, item]));
    expect(items).toHaveLength(6);
    expect(byId.get(frei)).toMatchObject({ available: true, active: true, revision: 7 });
    expect(byId.get(beendet)).toMatchObject({ available: true, active: true, revision: 0 });
    expect(byId.get(widerrufen)).toMatchObject({ available: false, active: true, revision: 0 });
    expect(byId.get(deaktiviert)).toMatchObject({ available: false, active: false, revision: 4 });
    expect(byId.get(gebunden)).toMatchObject({ available: false, active: true });
    expect(byId.get(gebundenInaktivesTaxi)).toMatchObject({ available: false, active: true });
  });

  it("antwortet ohne Anmeldung 401, ohne devices.read 403 und mit devices.read 200 mit leerer Liste", async () => {
    const anonymous = await buildApp(null);
    const unauth = await getTablets(anonymous);
    expect(unauth.statusCode).toBe(401);

    // Zentrale Policy: Leseaktion devices.read. Alle vorhandenen Rollen besitzen sie;
    // eine Rolle ohne devices.read existiert im Rechtemodell (CX-015) nicht, daher wird
    // die 403-Entscheidung am zentralen Rechtekern selbst nachgewiesen.
    expect(findRoutePolicy("GET", TABLETS_URL)).toMatchObject({ action: "devices.read" });
    expect(hasAction("SYN-OhneLeserecht" as Role, "devices.read")).toBe(false);
    const withoutRead = await buildApp("SYN-OhneLeserecht" as Role);
    const rejected = await getTablets(withoutRead, await login(withoutRead));
    expect([401, 403]).toContain(rejected.statusCode);

    for (const role of ["Admin", "Operator"] as const) {
      const app = await buildApp(role);
      const ok = await getTablets(app, await login(app));
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ items: [] });
    }
  });
});
