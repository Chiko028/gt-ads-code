/**
 * CX-116 / R-104: Integrationsnachweis der geschuetzten Gruppenliste.
 *
 * Drei Faelle laufen gegen die tatsaechliche CX-033-Serverfabrik, eine echte
 * PostgreSQL-17-Datenbank und die vorhandene Admin-Sitzung. Es wird weder
 * Authentifizierung noch Persistenz gemockt; jede App wird geschlossen.
 */
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
import { migrateUp } from "../../src/db/migrate.js";
import type { Principal } from "../../src/http/principal.js";
import { createServer } from "../../src/http/server.js";
import {
  TAXI_GROUP_CREATE_PATH,
  ensureTaxiGroupSchema,
} from "../../src/http/taxiGroupRoutes.js";
import { ADMIN_SESSION_COOKIE } from "../../src/modules/adminAuth/middleware.js";

const BASE_TIME = Date.parse("2026-11-14T11:00:00.000Z");
const ADMIN_PASSWORD = "SYN-CX116-Gruppenliste-Passwort";
const HOST = "127.0.0.1:8080";
const PRINCIPAL_A = "SYN-CX116-BETREIBER-A";
const PRINCIPAL_B = "SYN-CX116-BETREIBER-B";
const GROUPS_URL = TAXI_GROUP_CREATE_PATH;
const JSON_HEADERS = { "content-type": "application/json" };

interface GroupItem {
  id: string;
  name: string;
  revision: number;
}

interface GroupPage {
  items: GroupItem[];
  next_after: string | null;
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
    throw new Error("CX-116 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function resolveTestPrincipal(request: {
  headers: Record<string, string | string[] | undefined>;
}): Promise<Principal | null> {
  const operator = request.headers["x-test-operator"];
  if (operator === "a") {
    return Promise.resolve({ id: PRINCIPAL_A, role: "Admin" });
  }
  if (operator === "b") {
    return Promise.resolve({ id: PRINCIPAL_B, role: "Admin" });
  }
  return Promise.resolve(null);
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx116_groups_" +
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

  pool = new Pool({ ...base, database: databaseName });
  await migrateUp(pool);
  await ensureTaxiGroupSchema(pool);

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX116-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };
}, 60_000);

beforeEach(async () => {
  await pool.query(
    "truncate table taxi_groups, audit_events, admin_sessions" +
      " restart identity cascade",
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
  operator: "a" | "b",
  cookie: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    host: HOST,
    "x-test-operator": operator,
    cookie: ADMIN_SESSION_COOKIE + "=" + cookie,
    ...JSON_HEADERS,
    ...extra,
  };
}

async function createGroup(
  app: FastifyInstance,
  operator: "a" | "b",
  cookie: string,
  name: string,
): Promise<GroupItem> {
  const response = await app.inject({
    method: "POST",
    url: GROUPS_URL,
    headers: headers(operator, cookie),
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as GroupItem;
}

async function getGroups(
  app: FastifyInstance,
  operator: "a" | "b",
  cookie: string,
  query: string = "",
): Promise<GroupPage> {
  const response = await app.inject({
    method: "GET",
    url: GROUPS_URL + query,
    headers: headers(operator, cookie),
  });
  expect(response.statusCode).toBe(200);
  return response.json() as GroupPage;
}

async function collectAll(
  app: FastifyInstance,
  operator: "a" | "b",
  cookie: string,
  limit: number,
): Promise<string[]> {
  const ids: string[] = [];
  let after: string | null = null;
  for (let page = 0; page < 200; page += 1) {
    const query =
      "?limit=" + String(limit) +
      (after === null ? "" : "&after=" + encodeURIComponent(after));
    const body = await getGroups(app, operator, cookie, query);
    expect(body.items.length).toBeLessThanOrEqual(limit);
    for (const item of body.items) {
      ids.push(item.id);
    }
    if (body.next_after === null) {
      return ids;
    }
    expect(body.next_after).not.toBe(after);
    after = body.next_after;
  }
  throw new Error("Fortsetzung endet nicht");
}

function expectErrorFormat(response: {
  statusCode: number;
  json: () => unknown;
}, statusCode: number, code: string): void {
  expect(response.statusCode).toBe(statusCode);
  const body = response.json() as ErrorBody;
  expect(body.error.code).toBe(code);
  expect(Object.keys(body.error).sort()).toEqual([
    "code",
    "message",
    "request_id",
  ]);
}

describe("CX-116 geschuetzte Gruppenliste", () => {
  it("liefert Gruppen deterministisch nach ID sortiert mit Kennung, Name und Aenderungsstand; ein leerer Betreiberbereich liefert eine leere Liste", async () => {
    const app = await buildApp();
    const cookie = await loginCookie(app);

    const created = [
      await createGroup(app, "a", cookie, "SYN-CX116 Gamma"),
      await createGroup(app, "a", cookie, "SYN-CX116 Alpha"),
      await createGroup(app, "a", cookie, "SYN-CX116 Beta"),
    ];

    const page = await getGroups(app, "a", cookie);
    expect(Object.keys(page).sort()).toEqual(["items", "next_after"]);
    expect(page.next_after).toBeNull();
    expect(page.items.length).toBe(3);

    const ids = page.items.map((item) => item.id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids)).toEqual(new Set(created.map((item) => item.id)));

    const stored = await pool.query<{ id: string }>(
      "select id::text as id from taxi_groups where owner_id = $1 order by id asc",
      [PRINCIPAL_A],
    );
    expect(ids).toEqual(stored.rows.map((row) => row.id));

    for (const item of page.items) {
      expect(Object.keys(item).sort()).toEqual(["id", "name", "revision"]);
      expect(item.revision).toBe(1);
      expect(item.name.startsWith("SYN-CX116 ")).toBe(true);
    }

    const empty = await getGroups(app, "b", cookie);
    expect(empty).toEqual({ items: [], next_after: null });
  });

  it("begrenzt die Seitengroesse, setzt die Fortsetzung ohne Ueberschneidung fort und weist ungueltige Parameter im gemeinsamen Fehlerformat ab", async () => {
    const app = await buildApp();
    const cookie = await loginCookie(app);

    await pool.query(
      [
        "insert into taxi_groups (id, name, owner_id, revision, created_at)",
        "select gen_random_uuid(), 'SYN-CX116 Seite ' || g, $1, 1, $2",
        "  from generate_series(1, 55) as g",
      ].join(" "),
      [PRINCIPAL_A, new Date(BASE_TIME)],
    );

    const defaultPage = await getGroups(app, "a", cookie);
    expect(defaultPage.items.length).toBe(50);
    expect(defaultPage.next_after).not.toBeNull();

    const first = await getGroups(app, "a", cookie, "?limit=2");
    expect(first.items.length).toBe(2);
    expect(first.next_after).toBe(first.items[1]?.id ?? null);
    const second = await getGroups(
      app,
      "a",
      cookie,
      "?limit=2&after=" + encodeURIComponent(first.next_after as string),
    );
    expect(second.items.length).toBe(2);
    const firstIds = first.items.map((item) => item.id);
    const secondIds = second.items.map((item) => item.id);
    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);

    const all = await collectAll(app, "a", cookie, 20);
    expect(all.length).toBe(55);
    expect(new Set(all).size).toBe(55);
    expect(all).toEqual([...all].sort());

    const invalidQueries = [
      "?limit=0",
      "?limit=101",
      "?limit=abc",
      "?limit=1.5",
      "?limit=2&limit=3",
      "?after=keine-uuid",
      "?cursor=abc",
      "?limit=2&unbekannt=1",
    ];
    for (const query of invalidQueries) {
      const response = await app.inject({
        method: "GET",
        url: GROUPS_URL + query,
        headers: headers("a", cookie),
      });
      expectErrorFormat(response, 400, "invalid_request");
    }
  });

  it("weist fehlende Sitzung ab; Gruppen eines zweiten Betreiberbereichs erscheinen weder in Ergebnissen noch in der Fortsetzung", async () => {
    const app = await buildApp();
    const cookie = await loginCookie(app);

    const ownA = [
      await createGroup(app, "a", cookie, "SYN-CX116 A Eins"),
      await createGroup(app, "a", cookie, "SYN-CX116 A Zwei"),
      await createGroup(app, "a", cookie, "SYN-CX116 A Drei"),
    ];
    const ownB = [
      await createGroup(app, "b", cookie, "SYN-CX116 B Eins"),
      await createGroup(app, "b", cookie, "SYN-CX116 B Zwei"),
    ];

    const withoutSession = await app.inject({
      method: "GET",
      url: GROUPS_URL,
      headers: { host: HOST, "x-test-operator": "a" },
    });
    expectErrorFormat(withoutSession, 401, "unauthorized");

    const idsA = await collectAll(app, "a", cookie, 1);
    const idsB = await collectAll(app, "b", cookie, 1);
    expect(idsA).toEqual(ownA.map((item) => item.id).sort());
    expect(idsB).toEqual(ownB.map((item) => item.id).sort());

    const setB = new Set(ownB.map((item) => item.id));
    const setA = new Set(ownA.map((item) => item.id));
    expect(idsA.some((id) => setB.has(id))).toBe(false);
    expect(idsB.some((id) => setA.has(id))).toBe(false);

    const pageA = await getGroups(app, "a", cookie, "?limit=2");
    expect(pageA.items.every((item) => setA.has(item.id))).toBe(true);
    if (pageA.next_after !== null) {
      expect(setA.has(pageA.next_after)).toBe(true);
    }

    const cross = await getGroups(
      app,
      "a",
      cookie,
      "?after=" + encodeURIComponent(ownB[0]?.id as string),
    );
    expect(cross.items.every((item) => setA.has(item.id))).toBe(true);
  });
});

