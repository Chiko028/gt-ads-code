/**
 * CX-122 / R-104 Teil 13: Integrationsnachweis der geschuetzten
 * Gruppen-Umbenennungsroute.
 *
 * Der Test laeuft gegen die tatsaechliche Serverfabrik (createServer), eine
 * echte PostgreSQL-Datenbank und gueltige Admin-Sitzungscookies. Die Route
 * delegiert Mutation und Audit unveraendert an den CX-117-Kern; es gibt keine
 * zweite Persistenz und keine zweite Auditfunktion. Alle Kennungen, Namen und
 * Mitgliedschaften sind synthetisch und je Fall isoliert.
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
import { CONFIG_DEFAULTS, type AppConfig } from "../../src/config.js";
import { hashPassword } from "../../src/crypto/password.js";
import { migrateUp } from "../../src/db/migrate.js";
import type { Principal } from "../../src/http/principal.js";
import { createServer } from "../../src/http/server.js";
import {
  TAXI_GROUP_RENAMED_ACTION,
  ensureTaxiGroupSchema,
} from "../../src/http/taxiGroupRoutes.js";
import { ADMIN_SESSION_COOKIE } from "../../src/modules/adminAuth/middleware.js";

const BASE_TIME = Date.parse("2026-11-14T15:00:00.000Z");
const ADMIN_PASSWORD = "SYN-CX122-Gruppen-Passwort";
const HOST = "127.0.0.1:8080";
const ADMIN_ID = "SYN-CX122-ADMIN";
const OPERATOR_ID = "SYN-CX122-OPERATOR";
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/db/migrations",
);
const JSON_HEADERS = { "content-type": "application/json" };
const RENAME_URL = (id: string): string =>
  "/v1/admin/taxi-groups/" + encodeURIComponent(id);

interface GroupRow {
  id: string;
  name: string;
  owner_id: string;
  revision: number;
}

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
    throw new Error("CX-122 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

/** Nur Testresolution: die Sitzungspruefung der Route bleibt aktiv. */
function resolveTestPrincipal(request: {
  headers: Record<string, unknown>;
}): Promise<Principal | null> {
  const who = request.headers["x-test-operator"];
  if (who === "admin") {
    return Promise.resolve({ id: ADMIN_ID, role: "Admin" });
  }
  if (who === "operator") {
    return Promise.resolve({ id: OPERATOR_ID, role: "Operator" });
  }
  return Promise.resolve(null);
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx122_rename_" +
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
  await pool.query(
    await readFile(
      join(MIGRATIONS_DIR, "0010_cx_041_manifest_refresh.up.sql"),
      "utf8",
    ),
  );
  await ensureTaxiGroupSchema(pool);

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX122-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };
}, 60_000);

beforeEach(async () => {
  await pool.query(
    "truncate table taxi_group_memberships, taxi_groups, audit_events," +
      " admin_sessions restart identity cascade",
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
  return (first as string)
    .split(";")[0]!
    .slice(ADMIN_SESSION_COOKIE.length + 1);
}

async function loginCookie(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/login",
    headers: { host: HOST, ...JSON_HEADERS },
    payload: { password: ADMIN_PASSWORD },
    remoteAddress: "192.0.2.248",
  });
  expect(response.statusCode).toBe(204);
  return sessionCookieOf(response);
}

function headers(
  who: "admin" | "operator" | null,
  cookie: string | null,
  extra: Record<string, string> = {},
): Record<string, string> {
  const result: Record<string, string> = {
    host: HOST,
    ...JSON_HEADERS,
    ...extra,
  };
  if (who !== null) {
    result["x-test-operator"] = who;
  }
  if (cookie !== null) {
    result.cookie = ADMIN_SESSION_COOKIE + "=" + cookie;
  }
  return result;
}

async function insertGroup(
  id: string,
  name: string,
  ownerId: string,
  revision: number,
): Promise<void> {
  await pool.query(
    [
      "insert into taxi_groups (id, name, owner_id, revision, created_at)",
      "values ($1::uuid, $2, $3, $4, $5)",
    ].join("\n"),
    [id, name, ownerId, revision, new Date(BASE_TIME)],
  );
}

async function insertMembership(
  groupId: string,
  taxiId: string,
): Promise<void> {
  await pool.query(
    "insert into taxi_group_memberships (group_id, taxi_id) values ($1, $2)",
    [groupId, taxiId],
  );
}

async function groupRow(id: string): Promise<GroupRow | null> {
  const result = await pool.query<GroupRow>(
    [
      "select id::text as id, name, owner_id, revision::int as revision",
      "  from taxi_groups where id = $1::uuid",
    ].join("\n"),
    [id],
  );
  return result.rows[0] ?? null;
}

async function membershipRows(groupId: string): Promise<string[]> {
  const result = await pool.query<{ taxi_id: string }>(
    [
      "select taxi_id from taxi_group_memberships",
      " where group_id = $1 order by taxi_id asc",
    ].join("\n"),
    [groupId],
  );
  return result.rows.map((row) => row.taxi_id);
}

async function groupCount(): Promise<number> {
  const result = await pool.query<{ count: number }>(
    "select count(*)::int as count from taxi_groups",
  );
  return result.rows[0]?.count ?? -1;
}

async function renamedAudits(): Promise<AuditRow[]> {
  const result = await pool.query<AuditRow>(
    [
      "select actor_type, actor_id, action, target_type, target_id, details",
      "  from audit_events where action = $1 order by id asc",
    ].join("\n"),
    [TAXI_GROUP_RENAMED_ACTION],
  );
  return result.rows;
}

async function patchGroup(
  app: FastifyInstance,
  requestHeaders: Record<string, string>,
  id: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: "PATCH",
    url: RENAME_URL(id),
    headers: requestHeaders,
    payload,
  });
}

describe("CX-122 geschuetzte Gruppen-Umbenennungsroute", () => {
  it("benennt als berechtigter Admin um, erhoeht die Revision genau einmal, schreibt genau einen Audit-Eintrag und laesst Mitgliedschaften unveraendert", async () => {
    const groupId = randomUUID();
    await insertGroup(groupId, "SYN-CX122 Alt", ADMIN_ID, 1);
    await insertMembership(groupId, "SYN-CX122-TAXI-1");
    await insertMembership(groupId, "SYN-CX122-TAXI-2");

    const app = await buildApp();
    const cookie = await loginCookie(app);

    const response = await patchGroup(app, headers("admin", cookie), groupId, {
      name: "  SYN-CX122 Neuer Name  ",
      revision: 1,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: groupId,
      name: "SYN-CX122 Neuer Name",
      revision: 2,
    });
    expect(Object.keys(response.json()).sort()).toEqual([
      "id",
      "name",
      "revision",
    ]);
    expect(response.headers["cache-control"]).toBe("no-store");

    expect(await groupRow(groupId)).toEqual({
      id: groupId,
      name: "SYN-CX122 Neuer Name",
      owner_id: ADMIN_ID,
      revision: 2,
    });
    expect(await membershipRows(groupId)).toEqual([
      "SYN-CX122-TAXI-1",
      "SYN-CX122-TAXI-2",
    ]);

    const audits = await renamedAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual({
      actor_type: "admin",
      actor_id: ADMIN_ID,
      action: TAXI_GROUP_RENAMED_ACTION,
      target_type: "taxi_group",
      target_id: groupId,
      details: {
        previous_name: "SYN-CX122 Alt",
        name: "SYN-CX122 Neuer Name",
        revision: 2,
      },
    });
  });

  const rejectionCases: ReadonlyArray<{
    label: string;
    who: "admin" | "operator";
    withCookie: boolean;
    payload: Record<string, unknown>;
    expectedStatus: number;
    expectedCode: string;
  }> = [
    {
      label: "fehlende Sitzung",
      who: "admin",
      withCookie: false,
      payload: { name: "SYN-CX122 Ohne Sitzung", revision: 1 },
      expectedStatus: 401,
      expectedCode: "unauthorized",
    },
    {
      label: "nur lesende Rolle",
      who: "operator",
      withCookie: true,
      payload: { name: "SYN-CX122 Nur Lesen", revision: 1 },
      expectedStatus: 403,
      expectedCode: "forbidden",
    },
    {
      label: "leerer Name",
      who: "admin",
      withCookie: true,
      payload: { name: "", revision: 1 },
      expectedStatus: 400,
      expectedCode: "invalid_request",
    },
    {
      label: "Name nur aus Leerraum",
      who: "admin",
      withCookie: true,
      payload: { name: "   ", revision: 1 },
      expectedStatus: 400,
      expectedCode: "invalid_request",
    },
    {
      label: "ueberlanger Name",
      who: "admin",
      withCookie: true,
      payload: { name: "x".repeat(121), revision: 1 },
      expectedStatus: 400,
      expectedCode: "invalid_request",
    },
    {
      label: "unbekanntes Betreiberfeld",
      who: "admin",
      withCookie: true,
      payload: {
        name: "SYN-CX122 Betreiber",
        revision: 1,
        owner_id: "SYN-CX122-FREMD",
      },
      expectedStatus: 400,
      expectedCode: "invalid_request",
    },
    {
      label: "unbekanntes Mitgliederfeld",
      who: "admin",
      withCookie: true,
      payload: {
        name: "SYN-CX122 Mitglieder",
        revision: 1,
        members: ["SYN-CX122-TAXI-9"],
      },
      expectedStatus: 400,
      expectedCode: "invalid_request",
    },
  ];

  it.each(rejectionCases)(
    "weist $label ohne Mutation und ohne Audit-Eintrag ab",
    async (item) => {
      const groupId = randomUUID();
      await insertGroup(groupId, "SYN-CX122 Bestand", ADMIN_ID, 1);
      await insertMembership(groupId, "SYN-CX122-TAXI-1");

      const app = await buildApp();
      const cookie = await loginCookie(app);
      const requestHeaders = headers(
        item.who,
        item.withCookie ? cookie : null,
      );

      const response = await patchGroup(
        app,
        requestHeaders,
        groupId,
        item.payload,
      );

      expect(response.statusCode, item.label).toBe(item.expectedStatus);
      expect(response.json().error.code, item.label).toBe(item.expectedCode);

      expect(await groupRow(groupId)).toEqual({
        id: groupId,
        name: "SYN-CX122 Bestand",
        owner_id: ADMIN_ID,
        revision: 1,
      });
      expect(await membershipRows(groupId)).toEqual(["SYN-CX122-TAXI-1"]);
      expect(await renamedAudits()).toHaveLength(0);
    },
  );

  it("liefert bei veralteter Revision 409 und bei unbekannter Gruppe 404, jeweils ohne Aenderung und ohne zusaetzlichen Audit-Eintrag", async () => {
    const groupId = randomUUID();
    await insertGroup(groupId, "SYN-CX122 Start", ADMIN_ID, 1);
    await insertMembership(groupId, "SYN-CX122-TAXI-1");

    const app = await buildApp();
    const cookie = await loginCookie(app);
    const auth = headers("admin", cookie);

    const renamed = await patchGroup(app, auth, groupId, {
      name: "SYN-CX122 Aktuell",
      revision: 1,
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toEqual({
      id: groupId,
      name: "SYN-CX122 Aktuell",
      revision: 2,
    });
    expect(await renamedAudits()).toHaveLength(1);

    const stale = await patchGroup(app, auth, groupId, {
      name: "SYN-CX122 Veraltet",
      revision: 1,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("invalid_request");
    expect(await groupRow(groupId)).toEqual({
      id: groupId,
      name: "SYN-CX122 Aktuell",
      owner_id: ADMIN_ID,
      revision: 2,
    });
    expect(await membershipRows(groupId)).toEqual(["SYN-CX122-TAXI-1"]);
    expect(await renamedAudits()).toHaveLength(1);

    const unknown = await patchGroup(app, auth, randomUUID(), {
      name: "SYN-CX122 Unbekannt",
      revision: 2,
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("not_found");
    expect(await groupCount()).toBe(1);
    expect(await groupRow(groupId)).toEqual({
      id: groupId,
      name: "SYN-CX122 Aktuell",
      owner_id: ADMIN_ID,
      revision: 2,
    });
    expect(await renamedAudits()).toHaveLength(1);
  });
});
