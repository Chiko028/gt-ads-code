/**
 * CX-133 / R-104 Teil 2: Integrationsnachweis Taxi anlegen/aendern (GET aus CX-132).
 *
 * Der Test laeuft gegen die tatsaechliche Serverfabrik (createServer), eine
 * echte PostgreSQL-Datenbank und gueltige Admin-Sitzungscookies. Alle
 * Kennungen, Namen und Gruppen sind synthetisch und je Fall isoliert.
 */
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
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
import { CONFIG_DEFAULTS, type AppConfig } from "../../src/config.js";
import { hashPassword } from "../../src/crypto/password.js";
import { migrateUp } from "../../src/db/migrate.js";
import type { Principal } from "../../src/http/principal.js";
import { createServer } from "../../src/http/server.js";
import { ensureTaxiGroupSchema } from "../../src/http/taxiGroupRoutes.js";
import { ADMIN_SESSION_COOKIE } from "../../src/modules/adminAuth/middleware.js";
import { ensureTaxiActivationSchema } from "../../src/modules/taxiActivation/service.js";
import { ensureTaxiGroupMembershipSchema } from "../../src/modules/taxiGroupMemberships/service.js";

const ADMIN_PASSWORD = "SYN-CX132-Stammdaten-Passwort";
const HOST = "127.0.0.1:8080";
const ADMIN_ID = "SYN-CX132-ADMIN";
const OPERATOR_ID = "SYN-CX132-OPERATOR";
const TAXIS_URL = "/v1/admin/taxis";
const TAXI_URL = (id: string): string => TAXIS_URL + "/" + encodeURIComponent(id);
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/db/migrations",
);
const JSON_HEADERS = { host: HOST, "content-type": "application/json" };

interface AuditRow {
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
}

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let config: AppConfig;
let loginCounter = 0;
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
    throw new Error("CX-132 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx132_taxis_" +
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
  for (const file of (await readdir(MIGRATIONS_DIR)).sort()) {
    if (!file.endsWith(".up.sql") || file === "0001_gt_ads_001.up.sql") {
      continue;
    }
    await pool.query(await readFile(join(MIGRATIONS_DIR, file), "utf8"));
  }
  await ensureTaxiGroupSchema(pool);
  await ensureTaxiActivationSchema(pool);
  await ensureTaxiGroupMembershipSchema(pool);

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
    [
      "truncate table audit_events, admin_sessions, taxi_group_memberships,",
      "  taxi_groups, taxis, device_taxi_assignments restart identity cascade",
    ].join("\n"),
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

async function buildApp(role: "Admin" | "Operator" | null): Promise<FastifyInstance> {
  const app = createServer({
    config,
    pool,
    now: () => new Date(),
    resolvePrincipal: async (request): Promise<Principal | null> => {
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
      return { id: role === "Admin" ? ADMIN_ID : OPERATOR_ID, role };
    },
  });
  await app.ready();
  openApps.push(app);
  return app;
}

function sessionCookieOf(response: {
  headers: Record<string, unknown>;
}): string {
  const raw = response.headers["set-cookie"];
  const first = Array.isArray(raw) ? (raw[0] as string) : (raw as string | undefined);
  expect(first, "Set-Cookie fehlt").toBeTruthy();
  const pair = (first as string).split(";")[0] as string;
  expect(pair.startsWith(ADMIN_SESSION_COOKIE + "=")).toBe(true);
  return pair.slice(ADMIN_SESSION_COOKIE.length + 1);
}

async function login(app: FastifyInstance): Promise<string> {
  loginCounter += 1;
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/login",
    headers: JSON_HEADERS,
    payload: { password: ADMIN_PASSWORD },
    remoteAddress: "192.0.2." + (60 + loginCounter),
  });
  expect(response.statusCode).toBe(204);
  return sessionCookieOf(response);
}

function headers(cookie?: string, extra: Record<string, string> = {}): Record<string, string> {
  const result: Record<string, string> = { ...JSON_HEADERS, ...extra };
  if (cookie !== undefined) {
    result.cookie = ADMIN_SESSION_COOKIE + "=" + cookie;
  }
  return result;
}

async function seedGroups(ownerId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = randomUUID();
    ids.push(id);
    await pool.query(
      [
        "insert into taxi_groups (id, name, owner_id, revision, created_at)",
        "values ($1::uuid, $2, $3, 1, $4)",
      ].join("\n"),
      [id, "SYN-CX132-Gruppe-" + index, ownerId, new Date()],
    );
  }
  return ids.sort();
}

function taxiBody(id: string, name: string, groupIds: readonly string[]): Record<string, unknown> {
  return {
    id,
    display_name: name,
    group_ids: [...groupIds],
  };
}

async function createTaxi(
  app: FastifyInstance,
  cookie: string,
  id: string,
  name: string,
  groupIds: readonly string[],
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const response = await app.inject({
    method: "POST",
    url: TAXIS_URL,
    headers: headers(cookie),
    payload: taxiBody(id, name, groupIds),
    remoteAddress: "192.0.2.100",
  });
  return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
}

async function auditRows(action: string, targetId: string): Promise<AuditRow[]> {
  const result = await pool.query<AuditRow>(
    [
      "select actor_type, actor_id, action, target_type, target_id, details",
      "  from audit_events",
      " where action = $1 and target_id = $2",
      " order by id asc",
    ].join("\n"),
    [action, targetId],
  );
  return result.rows;
}

async function listTaxis(
  app: FastifyInstance,
  cookie: string,
): Promise<{ statusCode: number; items: Array<Record<string, unknown>> }> {
  const response = await app.inject({
    method: "GET",
    url: TAXIS_URL,
    headers: headers(cookie),
    remoteAddress: "192.0.2.101",
  });
  const body = response.json() as { items?: Array<Record<string, unknown>> };
  return { statusCode: response.statusCode, items: body.items ?? [] };
}

describe("CX-133 Taxi anlegen und aendern", () => {
  it("legt ein inaktives Taxi mit zwei Gruppen an (Revision 1), listet es und schreibt taxi.created", async () => {
    const app = await buildApp("Admin");
    const cookie = await login(app);
    const groups = await seedGroups(ADMIN_ID, 2);
    const id = "SYN-CX132-TAXI-ANLAGE";

    const created = await createTaxi(
      app,
      cookie,
      id,
      "SYN CX-132 Taxi",
      groups,
    );
    expect(created.statusCode).toBe(201);
    expect(created.body).toEqual({
      id,
      display_name: "SYN CX-132 Taxi",
      active: false,
      revision: 1,
      tablet_ids: [null, null],
      group_ids: groups,
    });

    const listed = await listTaxis(app, cookie);
    expect(listed.statusCode).toBe(200);
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toEqual(created.body);

    const audit = await auditRows("taxi.created", id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_type).toBe("admin");
    expect(audit[0]?.actor_id).toBe(ADMIN_ID);
    expect(audit[0]?.target_type).toBe("taxi");
    expect(audit[0]?.details.revision).toBe(1);
  });

  it("aendert Namen und Gruppen mit passender Revision (Revision 2) und schreibt taxi.updated", async () => {
    const app = await buildApp("Admin");
    const cookie = await login(app);
    const [firstGroup, secondGroup] = await seedGroups(ADMIN_ID, 2);
    const id = "SYN-CX132-TAXI-AENDERUNG";
    await createTaxi(app, cookie, id, "SYN CX-132 Alt", [firstGroup]);

    const response = await app.inject({
      method: "PATCH",
      url: TAXI_URL(id),
      headers: headers(cookie),
      payload: {
        display_name: "SYN CX-132 Neu",
        group_ids: [secondGroup],
        revision: 1,
      },
      remoteAddress: "192.0.2.102",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id,
      display_name: "SYN CX-132 Neu",
      active: false,
      revision: 2,
      tablet_ids: [null, null],
      group_ids: [secondGroup],
    });

    const audit = await auditRows("taxi.updated", id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.details.previous_display_name).toBe("SYN CX-132 Alt");
    expect(audit[0]?.details.display_name).toBe("SYN CX-132 Neu");
    expect(audit[0]?.details.revision).toBe(2);
  });

  it("lehnt eine veraltete Revision mit 409 ab, ohne etwas zu aendern", async () => {
    const app = await buildApp("Admin");
    const cookie = await login(app);
    const [group] = await seedGroups(ADMIN_ID, 1);
    const id = "SYN-CX132-TAXI-KONFLIKT";
    await createTaxi(app, cookie, id, "SYN CX-132 Unveraendert", [group]);

    const response = await app.inject({
      method: "PATCH",
      url: TAXI_URL(id),
      headers: headers(cookie),
      payload: {
        display_name: "SYN CX-132 Darf nicht",
        group_ids: [],
        revision: 0,
      },
      remoteAddress: "192.0.2.103",
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("invalid_request");

    const listed = await listTaxis(app, cookie);
    expect(listed.items[0]?.display_name).toBe("SYN CX-132 Unveraendert");
    expect(listed.items[0]?.revision).toBe(1);
    expect(listed.items[0]?.group_ids).toEqual([group]);
    expect(await auditRows("taxi.updated", id)).toHaveLength(0);
  });

  it("liefert fuer eine unbekannte id 404", async () => {
    const app = await buildApp("Admin");
    const cookie = await login(app);

    const response = await app.inject({
      method: "PATCH",
      url: TAXI_URL("SYN-CX132-UNBEKANNT"),
      headers: headers(cookie),
      payload: {
        display_name: "SYN CX 132",
        group_ids: [],
        revision: 1,
      },
      remoteAddress: "192.0.2.104",
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("not_found");
  });

  it("lehnt eine doppelte id bei POST mit 409 ab", async () => {
    const app = await buildApp("Admin");
    const cookie = await login(app);
    const groups = await seedGroups(ADMIN_ID, 1);
    const id = "SYN-CX132-TAXI-DOPPELT";

    const first = await createTaxi(app, cookie, id, "SYN CX 132", groups);
    expect(first.statusCode).toBe(201);
    const second = await createTaxi(app, cookie, id, "SYN CX 132 Zweit", groups);
    expect(second.statusCode).toBe(409);
    expect(second.body.error).toMatchObject({ code: "invalid_request" });

    const listed = await listTaxis(app, cookie);
    expect(listed.items).toHaveLength(1);
    expect(await auditRows("taxi.created", id)).toHaveLength(1);
  });

  it("lehnt unbekannte Felder mit 400 ab", async () => {
    const app = await buildApp("Admin");
    const cookie = await login(app);
    const [group] = await seedGroups(ADMIN_ID, 1);
    const id = "SYN-CX132-TAXI-FELD";

    const create = await app.inject({
      method: "POST",
      url: TAXIS_URL,
      headers: headers(cookie),
      payload: { ...taxiBody(id, "SYN CX 132", [group]), zusatz: true },
      remoteAddress: "192.0.2.105",
    });
    expect(create.statusCode).toBe(400);
    expect(create.json().error.code).toBe("invalid_request");

    await createTaxi(app, cookie, id, "SYN CX 132", [group]);
    const update = await app.inject({
      method: "PATCH",
      url: TAXI_URL(id),
      headers: headers(cookie),
      payload: {
        display_name: "SYN CX 132 Neu",
        group_ids: [group],
        revision: 1,
        zusatz: true,
      },
      remoteAddress: "192.0.2.106",
    });
    expect(update.statusCode).toBe(400);
    expect(update.json().error.code).toBe("invalid_request");
  });

  it("verweigert ohne Anmeldung 401 fuer GET, POST und PATCH", async () => {
    const app = await buildApp(null);

    for (const request of [
      { method: "GET" as const, url: TAXIS_URL, payload: undefined },
      {
        method: "POST" as const,
        url: TAXIS_URL,
        payload: taxiBody("SYN-CX132-OHNE-SITZUNG", "SYN CX 132", []),
      },
      {
        method: "PATCH" as const,
        url: TAXI_URL("SYN-CX132-OHNE-SITZUNG"),
        payload: { display_name: "SYN CX 132", group_ids: [], revision: 1 },
      },
    ]) {
      const response = await app.inject({
        method: request.method,
        url: request.url,
        headers: JSON_HEADERS,
        ...(request.payload === undefined ? {} : { payload: request.payload }),
        remoteAddress: "192.0.2.107",
      });
      expect(response.statusCode, request.method + " " + request.url).toBe(401);
      expect(response.json().error.code).toBe("unauthorized");
    }

    expect(await pool.query("select count(*)::int as count from taxis")).toMatchObject({
      rows: [{ count: 0 }],
    });
    expect(
      await pool.query("select count(*)::int as count from audit_events"),
    ).toMatchObject({ rows: [{ count: 0 }] });
  });

  it("verweigert einem Operator ohne taxi.activation POST/PATCH mit 403 und erlaubt GET mit devices.read", async () => {
    const app = await buildApp("Operator");
    const cookie = await login(app);
    const groups = await seedGroups(OPERATOR_ID, 1);
    const id = "SYN-CX132-TAXI-OPERATOR";
    await pool.query(
      [
        "insert into taxis (id, display_name, active, revision, owner_id)",
        "values ($1, $2, false, 1, $3)",
      ].join("\n"),
      [id, "SYN CX 132 Operator-Taxi", OPERATOR_ID],
    );

    const created = await createTaxi(app, cookie, "SYN-CX132-TAXI-NEU", "SYN CX 132", groups);
    expect(created.statusCode).toBe(403);
    expect(created.body.error).toMatchObject({ code: "forbidden" });

    const updated = await app.inject({
      method: "PATCH",
      url: TAXI_URL(id),
      headers: headers(cookie),
      payload: { display_name: "SYN CX 132 Neu", group_ids: groups, revision: 1 },
      remoteAddress: "192.0.2.108",
    });
    expect(updated.statusCode).toBe(403);
    expect(updated.json().error.code).toBe("forbidden");

    const listed = await listTaxis(app, cookie);
    expect(listed.statusCode).toBe(200);
    expect(listed.items.map((item) => item.id)).toContain(id);
    expect(await auditRows("taxi.created", "SYN-CX132-TAXI-NEU")).toHaveLength(0);
    expect(await auditRows("taxi.updated", id)).toHaveLength(0);
  });
});

