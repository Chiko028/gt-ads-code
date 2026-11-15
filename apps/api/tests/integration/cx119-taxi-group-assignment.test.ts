/**
 * CX-119 / R-104 Teil 10: Integrationsnachweis der geschuetzten
 * Gruppenzuordnungsroute.
 *
 * Der Test laeuft gegen die tatsaechliche Serverfabrik (createServer), eine
 * echte PostgreSQL-Datenbank und gueltige Admin-Sitzungscookies. Die Route
 * delegiert Mutation und Audit unveraendert an den CX-118-Kern; es gibt keine
 * zweite Persistenz, kein zweites Audit und keine automatische Wiederholung.
 * Alle Kennungen sind synthetisch und je Fall isoliert.
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
  vi,
} from "vitest";
import { CONFIG_DEFAULTS, type AppConfig } from "../../src/config.js";
import { hashPassword } from "../../src/crypto/password.js";
import { migrateUp } from "../../src/db/migrate.js";
import type { Principal } from "../../src/http/principal.js";
import { createServer } from "../../src/http/server.js";
import { ensureTaxiGroupSchema } from "../../src/http/taxiGroupRoutes.js";
import {
  TAXI_GROUP_MEMBERSHIPS_REPLACED_ACTION,
  TaxiGroupMembershipService,
  ensureTaxiGroupMembershipSchema,
} from "../../src/modules/taxiGroupMemberships/service.js";
import { ADMIN_SESSION_COOKIE } from "../../src/modules/adminAuth/middleware.js";

const BASE_TIME = Date.parse("2026-11-14T16:00:00.000Z");
const ADMIN_PASSWORD = "SYN-CX119-Gruppen-Passwort";
const HOST = "127.0.0.1:8080";
const ADMIN_ID = "SYN-CX119-ADMIN";
const OPERATOR_ID = "SYN-CX119-OPERATOR";
const OTHER_OWNER = "SYN-CX119-FREMD";
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/db/migrations",
);
const JSON_HEADERS = { "content-type": "application/json" };
const GROUPS_URL = (id: string): string =>
  "/v1/admin/taxis/" + encodeURIComponent(id) + "/groups";

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

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
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
    throw new Error("CX-119 benoetigt with-postgres <befehl>");
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
    "gtads_cx119_groups_" +
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
  await ensureTaxiGroupMembershipSchema(pool);

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX119-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };
}, 60_000);

beforeEach(async () => {
  await pool.query(
    "truncate table taxi_group_memberships, taxi_groups, taxis," +
      " audit_events, admin_sessions restart identity cascade",
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
    remoteAddress: "192.0.2.249",
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

async function insertTaxi(
  taxiId: string,
  ownerId: string,
  revision = 1,
): Promise<void> {
  await pool.query(
    [
      "insert into taxis (id, display_name, active, revision, owner_id)",
      "values ($1, $2, false, $3, $4)",
    ].join("\n"),
    [taxiId, "SYN " + taxiId, revision, ownerId],
  );
}

async function insertGroup(
  id: string,
  ownerId: string,
  name: string,
): Promise<string> {
  await pool.query(
    [
      "insert into taxi_groups (id, name, owner_id, revision, created_at)",
      "values ($1::uuid, $2, $3, 1, $4)",
    ].join("\n"),
    [id, name, ownerId, new Date(BASE_TIME)],
  );
  return id;
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

async function membershipIds(taxiId: string): Promise<string[]> {
  const result = await pool.query<{ group_id: string }>(
    [
      "select group_id from taxi_group_memberships",
      " where taxi_id = $1 order by group_id asc",
    ].join("\n"),
    [taxiId],
  );
  return result.rows.map((row) => row.group_id);
}

async function taxiRow(
  taxiId: string,
): Promise<{ revision: number; owner_id: string } | null> {
  const result = await pool.query<{ revision: number; owner_id: string }>(
    "select revision::int as revision, owner_id from taxis where id = $1",
    [taxiId],
  );
  return result.rows[0] ?? null;
}

async function membershipAudits(): Promise<AuditRow[]> {
  const result = await pool.query<AuditRow>(
    [
      "select actor_type, actor_id, action, target_type, target_id, details",
      "  from audit_events where action = $1 order by id asc",
    ].join("\n"),
    [TAXI_GROUP_MEMBERSHIPS_REPLACED_ACTION],
  );
  return result.rows;
}

async function totalAudits(): Promise<number> {
  const result = await pool.query<{ count: number }>(
    "select count(*)::int as count from audit_events",
  );
  return result.rows[0]?.count ?? -1;
}

async function putGroups(
  app: FastifyInstance,
  requestHeaders: Record<string, string>,
  taxiId: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: "PUT",
    url: GROUPS_URL(taxiId),
    headers: requestHeaders,
    payload,
  });
}

describe("CX-119 geschuetzte Gruppenzuordnungsroute", () => {
  it("ersetzt als berechtigter Admin die Gruppen, bestaetigt Menge und neuen Aenderungsstand und entfernt mit der leeren Menge alle Zuordnungen", async () => {
    const taxiId = "SYN-CX119-TAXI-1";
    const kept = await insertGroup(randomUUID(), ADMIN_ID, "SYN-CX119 A");
    const added = await insertGroup(randomUUID(), ADMIN_ID, "SYN-CX119 B");
    const previous = await insertGroup(randomUUID(), ADMIN_ID, "SYN-CX119 Alt");
    await insertTaxi(taxiId, ADMIN_ID, 1);
    await insertMembership(previous, taxiId);

    const app = await buildApp();
    const cookie = await loginCookie(app);
    const auth = headers("admin", cookie);

    const replaced = await putGroups(app, auth, taxiId, {
      group_ids: [added, kept],
      revision: 1,
    });

    expect(replaced.statusCode).toBe(200);
    expect(replaced.json()).toEqual({
      taxi_id: taxiId,
      group_ids: sorted([kept, added]),
      revision: 2,
    });
    expect(Object.keys(replaced.json()).sort()).toEqual([
      "group_ids",
      "revision",
      "taxi_id",
    ]);
    expect(replaced.headers["cache-control"]).toBe("no-store");
    expect(await membershipIds(taxiId)).toEqual(sorted([kept, added]));
    expect(await taxiRow(taxiId)).toEqual({
      revision: 2,
      owner_id: ADMIN_ID,
    });

    const afterReplace = await membershipAudits();
    expect(afterReplace).toHaveLength(1);
    expect(afterReplace[0]).toEqual({
      actor_type: "admin",
      actor_id: ADMIN_ID,
      action: TAXI_GROUP_MEMBERSHIPS_REPLACED_ACTION,
      target_type: "taxi",
      target_id: taxiId,
      details: {
        added: sorted([kept, added]),
        removed: [previous],
        revision: 2,
      },
    });

    const emptied = await putGroups(app, auth, taxiId, {
      group_ids: [],
      revision: 2,
    });

    expect(emptied.statusCode).toBe(200);
    expect(emptied.json()).toEqual({
      taxi_id: taxiId,
      group_ids: [],
      revision: 3,
    });
    expect(await membershipIds(taxiId)).toEqual([]);
    expect(await taxiRow(taxiId)).toEqual({
      revision: 3,
      owner_id: ADMIN_ID,
    });

    const afterEmpty = await membershipAudits();
    expect(afterEmpty).toHaveLength(2);
    expect(afterEmpty[1]?.details).toEqual({
      added: [],
      removed: sorted([kept, added]),
      revision: 3,
    });
  });

  it("weist fehlende Sitzung, fehlende Schreibrechte sowie fremde Taxi- und Gruppenressourcen ohne Daten- oder Audit-Aenderung ab", async () => {
    const taxiId = "SYN-CX119-TAXI-2";
    const ownGroup = await insertGroup(randomUUID(), ADMIN_ID, "SYN-CX119 Eigen");
    const foreignGroup = await insertGroup(
      randomUUID(),
      OTHER_OWNER,
      "SYN-CX119 Fremd",
    );
    const previous = await insertGroup(
      randomUUID(),
      ADMIN_ID,
      "SYN-CX119 Bestand",
    );
    await insertTaxi(taxiId, ADMIN_ID, 1);
    await insertMembership(previous, taxiId);
    await insertTaxi("SYN-CX119-TAXI-FREMD", OTHER_OWNER, 1);

    const app = await buildApp();
    const cookie = await loginCookie(app);
    const baselineAudits = await totalAudits();

    const cases: ReadonlyArray<{
      label: string;
      requestHeaders: Record<string, string>;
      taxiId: string;
      groupIds: string[];
      expectedStatus: number;
      expectedCode: string;
    }> = [
      {
        label: "fehlende Sitzung",
        requestHeaders: headers("admin", null),
        taxiId,
        groupIds: [ownGroup],
        expectedStatus: 401,
        expectedCode: "unauthorized",
      },
      {
        label: "nur lesende Rolle",
        requestHeaders: headers("operator", cookie),
        taxiId,
        groupIds: [ownGroup],
        expectedStatus: 403,
        expectedCode: "forbidden",
      },
      {
        label: "fremdes Taxi",
        requestHeaders: headers("admin", cookie),
        taxiId: "SYN-CX119-TAXI-FREMD",
        groupIds: [ownGroup],
        expectedStatus: 404,
        expectedCode: "not_found",
      },
      {
        label: "fremde Gruppe",
        requestHeaders: headers("admin", cookie),
        taxiId,
        groupIds: [foreignGroup],
        expectedStatus: 404,
        expectedCode: "not_found",
      },
      {
        label: "unbekannte Gruppe",
        requestHeaders: headers("admin", cookie),
        taxiId,
        groupIds: [randomUUID()],
        expectedStatus: 404,
        expectedCode: "not_found",
      },
    ];

    for (const item of cases) {
      const response = await putGroups(
        app,
        item.requestHeaders,
        item.taxiId,
        { group_ids: item.groupIds, revision: 1 },
      );
      expect(response.statusCode, item.label).toBe(item.expectedStatus);
      expect(response.json().error.code, item.label).toBe(item.expectedCode);
      expect(response.json().error.message, item.label).not.toContain(
        "SYN-CX119",
      );
    }

    expect(await membershipIds(taxiId)).toEqual([previous]);
    expect(await membershipIds("SYN-CX119-TAXI-FREMD")).toEqual([]);
    expect(await taxiRow(taxiId)).toEqual({ revision: 1, owner_id: ADMIN_ID });
    expect(
      await taxiRow("SYN-CX119-TAXI-FREMD"),
    ).toEqual({ revision: 1, owner_id: OTHER_OWNER });
    expect(await membershipAudits()).toHaveLength(0);
    expect(await totalAudits()).toBe(baselineAudits);
  });

  it("weist unbekannte Felder und mehr als 100 IDs ab und liefert bei veraltetem Aenderungsstand 409 ohne Wiederholung oder zusaetzliches Audit", async () => {
    const taxiId = "SYN-CX119-TAXI-3";
    const first = await insertGroup(randomUUID(), ADMIN_ID, "SYN-CX119 Eins");
    const second = await insertGroup(randomUUID(), ADMIN_ID, "SYN-CX119 Zwei");
    await insertTaxi(taxiId, ADMIN_ID, 1);
    await insertMembership(first, taxiId);

    const app = await buildApp();
    const cookie = await loginCookie(app);
    const auth = headers("admin", cookie);
    const baselineAudits = await totalAudits();

    const unknownField = await putGroups(app, auth, taxiId, {
      group_ids: [second],
      revision: 1,
      owner_id: OTHER_OWNER,
    });
    expect(unknownField.statusCode).toBe(400);
    expect(unknownField.json().error.code).toBe("invalid_request");

    const tooMany = await putGroups(app, auth, taxiId, {
      group_ids: Array.from({ length: 101 }, () => randomUUID()),
      revision: 1,
    });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().error.code).toBe("invalid_request");

    const invalidId = await putGroups(app, auth, taxiId, {
      group_ids: ["SYN-CX119-keine-uuid"],
      revision: 1,
    });
    expect(invalidId.statusCode).toBe(400);
    expect(invalidId.json().error.code).toBe("invalid_request");

    expect(await membershipIds(taxiId)).toEqual([first]);
    expect(await taxiRow(taxiId)).toEqual({ revision: 1, owner_id: ADMIN_ID });
    expect(await membershipAudits()).toHaveLength(0);
    expect(await totalAudits()).toBe(baselineAudits);

    const accepted = await putGroups(app, auth, taxiId, {
      group_ids: [second],
      revision: 1,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({
      taxi_id: taxiId,
      group_ids: [second],
      revision: 2,
    });
    expect(await membershipAudits()).toHaveLength(1);

    // Direkte Beobachtung der Dienstgrenze mit durchleitendem Spy: der
    // Konfliktfall muss den echten CX-118-Dienst genau einmal aufrufen. Eine
    // Wiederholung mit derselben veralteten Revision wuerde sonst ebenfalls
    // ohne Daten- und Audit-Aenderung scheitern und bliebe unbemerkt.
    const replaceCall = vi.spyOn(
      TaxiGroupMembershipService.prototype,
      "replaceTaxiGroupMemberships",
    );
    try {
      const stale = await putGroups(app, auth, taxiId, {
        group_ids: [first],
        revision: 1,
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.code).toBe("invalid_request");
      expect(Object.keys(stale.json().error).sort()).toEqual([
        "code",
        "message",
        "request_id",
      ]);

      expect(replaceCall).toHaveBeenCalledTimes(1);
      expect(replaceCall.mock.calls[0]?.[0]).toEqual({
        ownerId: ADMIN_ID,
        actorId: ADMIN_ID,
        taxiId,
        expectedRevision: 1,
        groupIds: [first],
      });
    } finally {
      replaceCall.mockRestore();
    }

    expect(await membershipIds(taxiId)).toEqual([second]);
    expect(await taxiRow(taxiId)).toEqual({ revision: 2, owner_id: ADMIN_ID });
    expect(await membershipAudits()).toHaveLength(1);
    expect(await totalAudits()).toBe(baselineAudits + 1);
  });
});
