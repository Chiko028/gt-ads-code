/**
 * CX-129 / R-106 Teil 2: Integrationsnachweis der geschuetzten Inventarliste.
 *
 * Drei Faelle laufen gegen die tatsaechliche Serverfabrik, den zentralen
 * Rechtekern und eine echte PostgreSQL-Datenbank; es gibt keinen
 * Netzwerklistener. Jede App wird geschlossen.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { CONFIG_DEFAULTS, type AppConfig } from "../config.js";
import { hashPassword } from "../crypto/password.js";
import { generateAccessToken, hashToken } from "../crypto/tokens.js";
import { migrateUp } from "../db/migrate.js";
import { ADMIN_SESSION_COOKIE } from "../modules/adminAuth/middleware.js";
import { DeviceAuthService } from "../modules/deviceAuth/service.js";
import { ensureTabletActivationSchema } from "../modules/tabletActivation/index.js";
import { getRoutePolicyInventory } from "./authorization.js";
import { INVENTORY_LIST_PATH } from "./inventoryList.js";
import type { Principal } from "./principal.js";
import { createServer } from "./server.js";

const BASE_TIME = Date.parse("2026-11-14T11:00:00.000Z");
const ADMIN_PASSWORD = "SYN-CX129-Inventar-Passwort";
const HOST = "127.0.0.1:8080";
const PRINCIPAL_ADMIN = "SYN-CX129-Admin";
const PRINCIPAL_OPERATOR = "SYN-CX129-Operator";
const JSON_HEADERS = { "content-type": "application/json" };

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../db/migrations",
);

async function applyInventoryUp(): Promise<void> {
  await pool.query(
    await readFile(
      join(MIGRATIONS_DIR, "0014_cx_128_device_inventory.up.sql"),
      "utf8",
    ),
  );
}

interface InventoryItem {
  id: string;
  serial_number: string | null;
  device_type: string | null;
  replacement_note: string | null;
  admin_active: boolean;
  revision: number;
}

interface InventoryPage {
  items: InventoryItem[];
  nextCursor?: string;
}

interface ErrorBody {
  error: { code: string; message: string; request_id: string };
}

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let config: AppConfig;
const openApps: FastifyInstance[] = [];

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
    throw new Error("CX-129 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function resolveTestPrincipal(request: {
  headers: Record<string, string | string[] | undefined>;
}): Promise<Principal | null> {
  const operator = request.headers["x-test-operator"];
  if (operator === "admin") {
    return Promise.resolve({ id: PRINCIPAL_ADMIN, role: "Admin" });
  }
  if (operator === "operator") {
    return Promise.resolve({ id: PRINCIPAL_OPERATOR, role: "Operator" });
  }
  return Promise.resolve(null);
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx129_inventory_" +
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
  await applyInventoryUp();
  await ensureTabletActivationSchema(pool);

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX129-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };
}, 60_000);

beforeEach(async () => {
  await pool.query(
    "truncate table device_inventory, tablet_admin_states," +
      " device_access_tokens, devices, registration_codes," +
      " admin_sessions, audit_events restart identity cascade",
  );
});

afterEach(async () => {
  for (const app of openApps.splice(0)) {
    await app.close();
  }
});

afterAll(async () => {
  await pool.end();
  await maintenancePool.query(
    "drop database if exists " + quoteIdentifier(databaseName),
  );
  await maintenancePool.end();
}, 30_000);

async function buildApp(): Promise<FastifyInstance> {
  const app = createServer({
    config,
    pool,
    now: () => new Date(BASE_TIME),
    resolvePrincipal: resolveTestPrincipal,
    logger: { level: "silent" },
  });
  await app.ready();
  openApps.push(app);
  return app;
}

function sessionCookieOf(response: {
  headers: Record<string, unknown>;
}): string {
  const raw = response.headers["set-cookie"];
  const first = Array.isArray(raw)
    ? (raw[0] as string)
    : (raw as string | undefined);
  expect(first, "Set-Cookie fehlt").toBeTruthy();
  return ((first as string).split(";")[0] as string).slice(
    ADMIN_SESSION_COOKIE.length + 1,
  );
}

async function loginCookie(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/login",
    headers: { host: HOST, ...JSON_HEADERS },
    payload: { password: ADMIN_PASSWORD },
    remoteAddress: "192.0.2.241",
  });
  expect(response.statusCode).toBe(204);
  return sessionCookieOf(response);
}

function headers(
  operator: "admin" | "operator",
  cookie: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    host: HOST,
    "x-test-operator": operator,
    cookie: ADMIN_SESSION_COOKIE + "=" + cookie,
    ...extra,
  };
}

async function insertRegistrationCode(): Promise<{
  id: string;
  secret: string;
}> {
  const id = randomUUID();
  const secret = "SYN-CX129-CODE-SECRET-" + id;
  await pool.query(
    [
      "insert into registration_codes",
      "  (id, code_hash, label, created_at, created_by, expires_at)",
      "values ($1::uuid, $2, $3, $4, $5, $6)",
    ].join("\n"),
    [
      id,
      Buffer.from(secret),
      "SYN-CX129",
      new Date(BASE_TIME),
      PRINCIPAL_ADMIN,
      new Date(BASE_TIME + 3_600_000),
    ],
  );
  return { id, secret };
}

async function insertDevice(
  registrationCodeId: string,
  label: string,
): Promise<{ id: string; secrets: string[] }> {
  const id = randomUUID();
  const keySecret = "SYN-CX129-KEY-SECRET-" + id;
  const fingerprint = "SYN-CX129-FP-SECRET-" + id;
  await pool.query(
    [
      "insert into devices",
      "  (id, label, public_key_spki, public_key_fingerprint, state,",
      "   manufacturer, model, os_version, sdk_int, app_version, app_flavor,",
      "   registration_code_id, registration_request_id, registered_at, last_seen_at)",
      "values ($1::uuid, $2, $3, $4, 'active', $5, $6, $7, $8, $9, $10,",
      "        $11::uuid, $12::uuid, $13, $14)",
    ].join("\n"),
    [
      id,
      label,
      Buffer.from(keySecret),
      fingerprint,
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
  return { id, secrets: [keySecret, fingerprint] };
}

async function insertInventory(
  deviceId: string,
  fields: {
    serialNumber: string | null;
    deviceType: string | null;
    replacementNote: string | null;
  },
  revision: number,
): Promise<void> {
  await pool.query(
    [
      "insert into device_inventory",
      "  (device_id, serial_number, device_type, replacement_note, revision)",
      "values ($1::uuid, $2, $3, $4, $5)",
    ].join("\n"),
    [
      deviceId,
      fields.serialNumber,
      fields.deviceType,
      fields.replacementNote,
      revision,
    ],
  );
}

async function insertTabletState(
  deviceId: string,
  active: boolean,
  revision: number,
): Promise<void> {
  await pool.query(
    [
      "insert into tablet_admin_states (device_id, active, revision)",
      "values ($1::uuid, $2, $3)",
    ].join("\n"),
    [deviceId, active, revision],
  );
}

async function getInventory(
  app: FastifyInstance,
  operator: "admin" | "operator",
  cookie: string,
  query: string = "",
): Promise<InventoryPage> {
  const response = await app.inject({
    method: "GET",
    url: INVENTORY_LIST_PATH + query,
    headers: headers(operator, cookie),
  });
  expect(response.statusCode).toBe(200);
  return response.json() as InventoryPage;
}

function expectErrorFormat(
  response: { statusCode: number; json: () => unknown },
  statusCode: number,
  code: string,
): void {
  expect(response.statusCode).toBe(statusCode);
  const body = response.json() as ErrorBody;
  expect(body.error.code).toBe(code);
  expect(Object.keys(body.error).sort()).toEqual([
    "code",
    "message",
    "request_id",
  ]);
}

describe("CX-129 geschuetzte Inventarliste", () => {
  it("liefert Tablets mit und ohne Inventarsatz mit null-Feldern, Revision 0, getrenntem Verwaltungszustand und ohne Geheimnisse", async () => {
    const app = await buildApp();
    const cookie = await loginCookie(app);
    const code = await insertRegistrationCode();

    const withoutInventory = await insertDevice(code.id, "SYN-CX129 ohne Inventar");
    const withInventory = await insertDevice(code.id, "SYN-CX129 mit Inventar");
    const inactive = await insertDevice(code.id, "SYN-CX129 inaktiv");

    await insertInventory(
      withInventory.id,
      {
        serialNumber: "SYN-SER-001",
        deviceType: "SYN-Tablet",
        replacementNote: "SYN-Austausch",
      },
      1,
    );
    await insertInventory(
      inactive.id,
      {
        serialNumber: "SYN-SER-002",
        deviceType: null,
        replacementNote: null,
      },
      4,
    );
    await insertTabletState(inactive.id, false, 3);

    const auditsBefore = await pool.query<{ count: number }>(
      "select count(*)::int as count from audit_events",
    );

    const response = await app.inject({
      method: "GET",
      url: INVENTORY_LIST_PATH,
      headers: headers("admin", cookie),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json() as InventoryPage;
    expect(Object.keys(body).sort()).toEqual(["items"]);

    const expectedIds = [withoutInventory.id, withInventory.id, inactive.id].sort();
    expect(body.items.map((item) => item.id)).toEqual(expectedIds);

    const byId = new Map(body.items.map((item) => [item.id, item]));
    expect(byId.get(withoutInventory.id)).toEqual({
      id: withoutInventory.id,
      serial_number: null,
      device_type: null,
      replacement_note: null,
      admin_active: true,
      revision: 0,
    });
    expect(byId.get(withInventory.id)).toEqual({
      id: withInventory.id,
      serial_number: "SYN-SER-001",
      device_type: "SYN-Tablet",
      replacement_note: "SYN-Austausch",
      admin_active: true,
      revision: 1,
    });
    expect(byId.get(inactive.id)).toEqual({
      id: inactive.id,
      serial_number: "SYN-SER-002",
      device_type: null,
      replacement_note: null,
      admin_active: false,
      revision: 4,
    });

    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual([
        "admin_active",
        "device_type",
        "id",
        "replacement_note",
        "revision",
        "serial_number",
      ]);
    }

    const allSecrets = [
      code.secret,
      ...withoutInventory.secrets,
      ...withInventory.secrets,
      ...inactive.secrets,
    ];
    for (const secret of allSecrets) {
      expect(response.body).not.toContain(secret);
    }
    expect(response.body).not.toContain("public_key");
    expect(response.body).not.toContain("registration_code");
    expect(response.body).not.toContain("token");
    expect(response.body).not.toContain("path");

    const auditsAfter = await pool.query<{ count: number }>(
      "select count(*)::int as count from audit_events",
    );
    expect(auditsAfter.rows[0]?.count).toBe(auditsBefore.rows[0]?.count);
  });

  it("paginiert stabil und ueberschneidungsfrei nach Geraete-ID und weist ungueltigen Cursor sowie ueberschrittenes Limit ab", async () => {
    const app = await buildApp();
    const cookie = await loginCookie(app);
    const code = await insertRegistrationCode();

    for (let index = 1; index <= 55; index += 1) {
      await insertDevice(code.id, "SYN-CX129 Seite " + index);
    }
    const stored = await pool.query<{ id: string }>(
      "select id::text as id from devices order by id asc",
    );
    const storedIds = stored.rows.map((row) => row.id);
    expect(storedIds).toHaveLength(55);

    const defaultPage = await getInventory(app, "admin", cookie);
    expect(defaultPage.items).toHaveLength(50);
    expect(defaultPage.nextCursor).toBe(storedIds[49]);

    const repeated = await getInventory(app, "admin", cookie);
    expect(repeated).toEqual(defaultPage);

    const first = await getInventory(app, "admin", cookie, "?limit=2");
    expect(first.items.map((item) => item.id)).toEqual(storedIds.slice(0, 2));
    expect(first.nextCursor).toBe(storedIds[1]);

    const second = await getInventory(
      app,
      "admin",
      cookie,
      "?limit=2&after=" + encodeURIComponent(storedIds[1] as string),
    );
    expect(second.items.map((item) => item.id)).toEqual(storedIds.slice(2, 4));
    const firstIds = first.items.map((item) => item.id);
    const secondIds = second.items.map((item) => item.id);
    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
    expect([...firstIds, ...secondIds]).toEqual(storedIds.slice(0, 4));

    const collected: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const query =
        "?limit=7" +
        (after === null ? "" : "&after=" + encodeURIComponent(after));
      const body = await getInventory(app, "admin", cookie, query);
      expect(body.items.length).toBeLessThanOrEqual(7);
      const ids = body.items.map((item) => item.id);
      expect(ids).toEqual([...ids].sort());
      collected.push(...ids);
      if (body.nextCursor === undefined) {
        expect(body).not.toHaveProperty("nextCursor");
        break;
      }
      expect(body.nextCursor).not.toBe(after);
      after = body.nextCursor;
    }
    expect(collected).toEqual(storedIds);

    const lastPage = await getInventory(app, "admin", cookie, "?limit=100");
    expect(lastPage.items).toHaveLength(55);
    expect(lastPage).not.toHaveProperty("nextCursor");

    const invalidQueries = [
      "?limit=0",
      "?limit=101",
      "?limit=abc",
      "?limit=1.5",
      "?limit=01",
      "?limit=2&limit=3",
      "?after=keine-uuid",
      "?limit=2&after=" + encodeURIComponent("nicht-uuid"),
      "?cursor=" + encodeURIComponent(storedIds[0] as string),
      "?limit=2&unbekannt=1",
    ];
    for (const query of invalidQueries) {
      const response = await app.inject({
        method: "GET",
        url: INVENTORY_LIST_PATH + query,
        headers: headers("admin", cookie),
      });
      expectErrorFormat(response, 400, "invalid_request");
    }
  });

  it("gibt ohne Verwaltungssitzung oder nur mit gueltiger Geraeteauthentifizierung kein Inventar aus und erlaubt berechtigten Lesern ausschliesslich GET", async () => {
    const app = await buildApp();
    const cookie = await loginCookie(app);
    const code = await insertRegistrationCode();
    const device = await insertDevice(code.id, "SYN-CX129 Auth");
    await insertInventory(
      device.id,
      {
        serialNumber: "SYN-CX129-SER-AUTH",
        deviceType: "SYN-CX129-Typ",
        replacementNote: "SYN-CX129-Vermerk",
      },
      2,
    );

    const withoutSession = await app.inject({
      method: "GET",
      url: INVENTORY_LIST_PATH,
      headers: { host: HOST },
    });
    expectErrorFormat(withoutSession, 401, "unauthorized");
    expect(withoutSession.body).not.toContain("SYN-CX129-SER-AUTH");

    const operatorWithoutSession = await app.inject({
      method: "GET",
      url: INVENTORY_LIST_PATH,
      headers: { host: HOST, "x-test-operator": "operator" },
    });
    expectErrorFormat(operatorWithoutSession, 401, "unauthorized");
    expect(operatorWithoutSession.body).not.toContain("SYN-CX129-SER-AUTH");

    const deviceToken = generateAccessToken();
    await pool.query(
      [
        "insert into device_access_tokens",
        "  (id, device_id, token_hash, created_at, expires_at)",
        "values ($1::uuid, $2::uuid, $3, $4, $5)",
      ].join("\n"),
      [
        randomUUID(),
        device.id,
        hashToken(deviceToken),
        new Date(BASE_TIME),
        new Date(BASE_TIME + 3_600_000),
      ],
    );
    const deviceAuth = new DeviceAuthService({
      pool,
      config,
      now: () => new Date(BASE_TIME),
    });
    expect((await deviceAuth.authenticateToken(deviceToken)).deviceId).toBe(
      device.id,
    );

    const withDeviceAuth = await app.inject({
      method: "GET",
      url: INVENTORY_LIST_PATH,
      headers: {
        host: HOST,
        authorization: "Bearer " + deviceToken,
      },
    });
    expectErrorFormat(withDeviceAuth, 401, "unauthorized");
    expect(withDeviceAuth.body).not.toContain("SYN-CX129-SER-AUTH");

    const adminPage = await getInventory(app, "admin", cookie);
    const operatorPage = await getInventory(app, "operator", cookie);
    expect(adminPage).toEqual(operatorPage);
    expect(adminPage.items).toHaveLength(1);
    expect(adminPage.items[0]).toMatchObject({
      id: device.id,
      serial_number: "SYN-CX129-SER-AUTH",
      revision: 2,
    });

    const inventoryRoutes = getRoutePolicyInventory(app).filter(
      (record) =>
        record.url === INVENTORY_LIST_PATH && record.method === "GET",
    );
    expect(inventoryRoutes).toEqual([
      {
        method: "GET",
        url: INVENTORY_LIST_PATH,
        policy: { category: "human", action: "devices.read" },
      },
    ]);

    for (const method of ["POST", "PATCH", "DELETE"] as const) {
      const response = await app.inject({
        method,
        url: INVENTORY_LIST_PATH,
        headers: headers("admin", cookie, JSON_HEADERS),
        payload: {},
      });
      expect(response.statusCode).toBe(404);
    }
    const detail = await app.inject({
      method: "GET",
      url: INVENTORY_LIST_PATH + "/" + device.id,
      headers: headers("admin", cookie),
    });
    expect(detail.statusCode).toBe(404);
  });
});
