/**
 * CX-117 / R-104 Teil 8: Integrationsnachweis der revisionssicheren
 * Gruppenumbenennung.
 *
 * Drei Faelle laufen gegen die tatsaechliche Serverfabrik, eine echte
 * PostgreSQL-17-Datenbank und gueltige Admin-Sitzungscookies. Authentifizierung,
 * Rechte, Persistenz und Audit werden nicht gemockt; der Auditfehler wird
 * gezielt ueber einen Datenbanktrigger injiziert. Alle Kennungen und Texte
 * sind synthetisch.
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
import { migrateUp } from "../../src/db/migrate.js";
import type { Principal } from "../../src/http/principal.js";
import { createServer } from "../../src/http/server.js";
import {
  TAXI_GROUP_RENAME_PATH,
  TAXI_GROUP_RENAMED_ACTION,
  ensureTaxiGroupSchema,
} from "../../src/http/taxiGroupRoutes.js";
import { ADMIN_SESSION_COOKIE } from "../../src/modules/adminAuth/middleware.js";

const BASE_TIME = Date.parse("2026-11-14T13:00:00.000Z");
const ADMIN_PASSWORD = "SYN-CX117-Gruppen-Passwort";
const HOST = "127.0.0.1:8080";
const ADMIN_ID = "SYN-CX117-ADMIN";
const OPERATOR_ID = "SYN-CX117-OPERATOR";
const FOREIGN_ID = "SYN-CX117-FREMD";
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
    throw new Error("CX-117 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

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
  if (who === "foreign") {
    return Promise.resolve({ id: FOREIGN_ID, role: "Admin" });
  }
  return Promise.resolve(null);
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx117_groups_" +
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
    registrationCodePepper: "SYN-CX117-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };
}, 60_000);

beforeEach(async () => {
  await pool.query("drop trigger if exists cx117_fail_audit on audit_events");
  await pool.query("drop function if exists cx117_fail_audit() cascade");
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
    remoteAddress: "192.0.2.247",
  });
  expect(response.statusCode).toBe(204);
  return sessionCookieOf(response);
}

function headers(
  who: "admin" | "operator" | "foreign" | null,
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
): Promise<{
    statusCode: number;
    json: () => any;
    body: string;
    headers: Record<string, unknown>;
  }> {
  return app.inject({
    method: "PATCH",
    url: RENAME_URL(id),
    headers: requestHeaders,
    payload,
  });
}

describe("CX-117 revisionssichere Gruppenumbenennung", () => {
  it("aktualisiert bei aktuellem Aenderungsstand genau den Namen und schreibt genau einen bereinigten Audit-Eintrag; gleicher Name bleibt ein No-op", async () => {
    const groupId = randomUUID();
    await insertGroup(groupId, "SYN-CX117 Alt", ADMIN_ID, 1);
    const app = await buildApp();
    const cookie = await loginCookie(app);
    const auth = headers("admin", cookie);

    const renamed = await patchGroup(app, auth, groupId, {
      name: "  SYN-CX117 Neu  ",
      revision: 1,
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toEqual({
      id: groupId,
      name: "SYN-CX117 Neu",
      revision: 2,
    });
    expect(Object.keys(renamed.json()).sort()).toEqual([
      "id",
      "name",
      "revision",
    ]);
    expect(renamed.headers?.["cache-control"]).toBe("no-store");

    expect(await groupRow(groupId)).toEqual({
      id: groupId,
      name: "SYN-CX117 Neu",
      owner_id: ADMIN_ID,
      revision: 2,
    });

    const audits = await renamedAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual({
      actor_type: "admin",
      actor_id: ADMIN_ID,
      action: TAXI_GROUP_RENAMED_ACTION,
      target_type: "taxi_group",
      target_id: groupId,
      details: {
        previous_name: "SYN-CX117 Alt",
        name: "SYN-CX117 Neu",
        revision: 2,
      },
    });

    const noop = await patchGroup(app, auth, groupId, {
      name: "  SYN-CX117 Neu  ",
      revision: 2,
    });
    expect(noop.statusCode).toBe(200);
    expect(noop.json()).toEqual({
      id: groupId,
      name: "SYN-CX117 Neu",
      revision: 2,
    });
    expect(await groupRow(groupId)).toMatchObject({
      name: "SYN-CX117 Neu",
      revision: 2,
    });
    expect(await renamedAudits()).toHaveLength(1);

    const stale = await patchGroup(app, auth, groupId, {
      name: "SYN-CX117 Veraltet",
      revision: 1,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("invalid_request");
    expect(await groupRow(groupId)).toMatchObject({
      name: "SYN-CX117 Neu",
      revision: 2,
    });
    expect(await renamedAudits()).toHaveLength(1);
  });

  it("erzeugt bei zwei konkurrierenden Aenderungen genau einen Erfolg und einen Versionskonflikt; ein Auditfehler rollt Name und Aenderungsstand zurueck", async () => {
    const groupId = randomUUID();
    await insertGroup(groupId, "SYN-CX117 Start", ADMIN_ID, 1);
    const app = await buildApp();
    const cookie = await loginCookie(app);
    const auth = headers("admin", cookie);

    const [first, second] = await Promise.all([
      patchGroup(app, auth, groupId, {
        name: "SYN-CX117 Konkurrent A",
        revision: 1,
      }),
      patchGroup(app, auth, groupId, {
        name: "SYN-CX117 Konkurrent B",
        revision: 1,
      }),
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    const success = first.statusCode === 200 ? first : second;
    const conflict = first.statusCode === 409 ? first : second;
    expect(success.json().revision).toBe(2);
    expect(conflict.json().error.code).toBe("invalid_request");
    expect(conflict.json().error.message).toBe("Die Anfrage ist ungueltig.");

    const afterConflict = await groupRow(groupId);
    expect(afterConflict).toEqual({
      id: groupId,
      name: success.json().name,
      owner_id: ADMIN_ID,
      revision: 2,
    });
    expect(await renamedAudits()).toHaveLength(1);

    await pool.query(
      [
        "create or replace function cx117_fail_audit() returns trigger",
        "language plpgsql as $$ begin",
        "  raise exception 'SYN-CX117 Auditfehler';",
        "end $$",
      ].join("\n"),
    );
    await pool.query(
      "create trigger cx117_fail_audit before insert on audit_events" +
        " for each row execute function cx117_fail_audit()",
    );

    try {
      const failed = await patchGroup(app, auth, groupId, {
        name: "SYN-CX117 Rollback",
        revision: 2,
      });
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toMatchObject({
        error: { code: "internal_error", message: "Interner Fehler." },
      });
      expect(typeof failed.json().error.request_id).toBe("string");
      expect(failed.body).not.toContain("SYN-");
      expect(failed.body).not.toContain("audit_events");
    } finally {
      await pool.query("drop trigger if exists cx117_fail_audit on audit_events");
      await pool.query("drop function if exists cx117_fail_audit() cascade");
    }

    expect(await groupRow(groupId)).toEqual(afterConflict);
    expect(await renamedAudits()).toHaveLength(1);
  });

  it("weist fehlende Schreibrechte, fremde und unbekannte Gruppen, ungueltige Namen und unbekannte Felder ohne Mutation und ohne Erfolgs-Audit ab", async () => {
    const ownId = randomUUID();
    const foreignId = randomUUID();
    await insertGroup(ownId, "SYN-CX117 Eigene", ADMIN_ID, 1);
    await insertGroup(foreignId, "SYN-CX117 Fremde", FOREIGN_ID, 3);
    const app = await buildApp();
    const cookie = await loginCookie(app);
    const adminAuth = headers("admin", cookie);

    const withoutSession = await patchGroup(
      app,
      headers("admin", null),
      ownId,
      { name: "SYN-CX117 Ohne Sitzung", revision: 1 },
    );
    expect(withoutSession.statusCode).toBe(401);
    expect(withoutSession.json().error.code).toBe("unauthorized");

    const withoutWrite = await patchGroup(
      app,
      headers("operator", cookie),
      ownId,
      { name: "SYN-CX117 Ohne Schreibrecht", revision: 1 },
    );
    expect(withoutWrite.statusCode).toBe(403);
    expect(withoutWrite.json().error.code).toBe("forbidden");

    const foreign = await patchGroup(app, adminAuth, foreignId,
      { name: "SYN-CX117 Uebernommen", revision: 3 },
    );
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe("not_found");

    const unknownId = randomUUID();
    const unknown = await patchGroup(app, adminAuth, unknownId, {
      name: "SYN-CX117 Unbekannt",
      revision: 0,
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("not_found");
    expect(unknown.json().error.message).toBe(foreign.json().error.message);

    const malformed = await patchGroup(app, adminAuth, "nicht-uuid", {
      name: "SYN-CX117 Ungueltige ID",
      revision: 1,
    });
    expect(malformed.statusCode).toBe(404);
    expect(malformed.json().error.code).toBe("not_found");

    const invalidBodies: ReadonlyArray<{
      label: string;
      payload: Record<string, unknown>;
    }> = [
      { label: "leer", payload: { name: "", revision: 1 } },
      { label: "nur Leerraum", payload: { name: "   ", revision: 1 } },
      {
        label: "ueberlang",
        payload: { name: "x".repeat(121), revision: 1 },
      },
      {
        label: "negative Revision",
        payload: { name: "SYN-CX117 Negativ", revision: -1 },
      },
      {
        label: "Betreiberfeld",
        payload: {
          name: "SYN-CX117 Betreiber",
          revision: 1,
          owner_id: FOREIGN_ID,
        },
      },
      {
        label: "Mitgliederfeld",
        payload: {
          name: "SYN-CX117 Mitglieder",
          revision: 1,
          members: ["SYN-TAXI-1"],
        },
      },
    ];
    for (const item of invalidBodies) {
      const response = await patchGroup(app, adminAuth, ownId, item.payload);
      expect(response.statusCode, item.label).toBe(400);
      expect(response.json().error.code, item.label).toBe("invalid_request");
    }

    expect(await groupRow(ownId)).toEqual({
      id: ownId,
      name: "SYN-CX117 Eigene",
      owner_id: ADMIN_ID,
      revision: 1,
    });
    expect(await groupRow(foreignId)).toEqual({
      id: foreignId,
      name: "SYN-CX117 Fremde",
      owner_id: FOREIGN_ID,
      revision: 3,
    });
    expect(await renamedAudits()).toHaveLength(0);
  });
});
