/**
 * CX-115 / R-104: Integrationsnachweis der geschuetzten Gruppen-Anlageroute.
 *
 * Die drei Faelle laufen gegen die tatsaechliche CX-033-Serverfabrik, eine
 * echte PostgreSQL-17-Datenbank und die vorhandene Sitzungsaufloesung. Es
 * wird weder Authentifizierung noch Persistenz gemockt: Admin und Operator
 * melden sich ueber die produktive Loginroute an, Rollen und Akteure stammen
 * ausschliesslich aus der serverseitig geprueften Sitzung. Jede App wird
 * geschlossen.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
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
import { LEGACY_ADMIN_PRINCIPAL_ID } from "../../src/http/principal.js";
import { createServer } from "../../src/http/server.js";
import { ensureTaxiGroupSchema } from "../../src/http/taxiGroupCreateService.js";
import { ADMIN_SESSION_COOKIE } from "../../src/modules/adminAuth/middleware.js";
import { AdminAuthService } from "../../src/modules/adminAuth/service.js";

const BASE_TIME = Date.parse("2026-11-14T10:00:00.000Z");
const ADMIN_PASSWORD = "SYN-CX115-Gruppen-Passwort";
const HOST = "127.0.0.1:8080";
const FOREIGN_ORIGIN = "http://fremde.example";
const OPERATOR_USERNAME = "syn-cx115-operator";
const OPERATOR_PASSWORD = "SYN-CX115-Operator-Passwort";
const GROUPS_URL = "/v1/admin/taxi-groups";
const JSON_HEADERS = { "content-type": "application/json" };

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let config: AppConfig;
let operatorId = "";
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
    throw new Error("CX-115 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx115_groups_" +
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
  // Die vorhandenen additiven Migrationen bereitstellen, damit die echte
  // Operator- und Sitzungskette (0015) wie im Integrationsstand verfuegbar
  // ist. Migration 0001 wurde bereits durch migrateUp ausgefuehrt.
  const migrationsDirectory = join(process.cwd(), "src/db/migrations");
  for (const file of (await readdir(migrationsDirectory)).sort()) {
    if (!file.endsWith(".up.sql") || file === "0001_gt_ads_001.up.sql") {
      continue;
    }
    await pool.query(await readFile(join(migrationsDirectory, file), "utf8"));
  }
  await ensureTaxiGroupSchema(pool);

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX115-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };

  // Echte Operatoridentitaet ueber den vorhandenen Dienst. Die Sitzung
  // entsteht spaeter ausschliesslich ueber die produktive Loginroute.
  const adminAuth = new AdminAuthService({
    pool,
    config,
    now: () => new Date(BASE_TIME),
  });
  const created = await adminAuth.createOperator({
    username: OPERATOR_USERNAME,
    password: OPERATOR_PASSWORD,
    actorId: LEGACY_ADMIN_PRINCIPAL_ID,
  });
  operatorId = created.operator_id;
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

async function loginCookie(
  app: FastifyInstance,
  username?: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/login",
    headers: { host: HOST, ...JSON_HEADERS },
    payload:
      username === undefined
        ? { password: ADMIN_PASSWORD }
        : { password: OPERATOR_PASSWORD, username },
    remoteAddress: username === undefined ? "192.0.2.240" : "192.0.2.241",
  });
  expect(response.statusCode).toBe(204);
  return sessionCookieOf(response);
}

function headers(
  cookie: string | null,
  extra: Record<string, string> = {},
): Record<string, string> {
  const result: Record<string, string> = {
    host: HOST,
    ...JSON_HEADERS,
    ...extra,
  };
  if (cookie !== null) {
    result.cookie = ADMIN_SESSION_COOKIE + "=" + cookie;
  }
  return result;
}

async function postGroup(
  app: FastifyInstance,
  requestHeaders: Record<string, string>,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; json: () => any }> {
  return app.inject({
    method: "POST",
    url: GROUPS_URL,
    headers: requestHeaders,
    payload,
  });
}

async function groupCount(): Promise<number> {
  const result = await pool.query<{ count: number }>(
    "select count(*)::int as count from taxi_groups",
  );
  return result.rows[0]?.count ?? -1;
}

async function createAuditCount(): Promise<number> {
  const result = await pool.query<{ count: number }>(
    "select count(*)::int as count from audit_events" +
      " where action = 'taxi_group.created'",
  );
  return result.rows[0]?.count ?? -1;
}

describe("CX-115 geschuetzte Gruppen-Anlageroute", () => {
  it("legt fuer einen berechtigten POST genau eine Gruppe mit id, name und revision sowie genau einen Audit-Eintrag dauerhaft an", async () => {
    const app = await buildApp();
    const cookie = await loginCookie(app);

    const response = await postGroup(app, headers(cookie), {
      name: "  SYN-CX115 Alpha  ",
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(["id", "name", "revision"]);
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBeGreaterThan(0);
    expect(body.name).toBe("SYN-CX115 Alpha");
    expect(body.revision).toBe(1);

    const rows = await pool.query(
      [
        "select id::text as id, name, revision::int as revision",
        "  from taxi_groups",
      ].join("\n"),
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]).toMatchObject({
      id: body.id,
      name: "SYN-CX115 Alpha",
      revision: 1,
    });

    const audit = await pool.query(
      [
        "select actor_type, actor_id, action, target_type, target_id, details",
        "  from audit_events where action = 'taxi_group.created'",
        " order by id",
      ].join("\n"),
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]).toMatchObject({
      actor_type: "admin",
      actor_id: LEGACY_ADMIN_PRINCIPAL_ID,
      action: "taxi_group.created",
      target_type: "taxi_group",
      target_id: body.id,
      details: { name: "SYN-CX115 Alpha" },
    });
  });

  it("verhindert die Anlage vollstaendig ohne Sitzung, ohne Schreibrecht und bei verletztem CSRF-Schutz", async () => {
    const app = await buildApp();
    const cookie = await loginCookie(app);
    const operatorCookie = await loginCookie(app, OPERATOR_USERNAME);

    // Die echte Operatorsitzung liefert die Rolle Operator; groups.read ist
    // erlaubt, groups.write nicht. Das belegt die unveraenderte
    // Authentifizierungskette vor der eigentlichen Verweigerung.
    const operatorRead = await app.inject({
      method: "GET",
      url: GROUPS_URL,
      headers: headers(operatorCookie),
    });
    expect(operatorRead.statusCode).toBe(200);

    const withoutSession = await postGroup(
      app,
      headers(null),
      { name: "SYN-CX115 Ohne Sitzung" },
    );
    expect(withoutSession.statusCode).toBe(401);
    expect(withoutSession.json().error.code).toBe("unauthorized");

    const withoutWrite = await postGroup(
      app,
      headers(operatorCookie),
      { name: "SYN-CX115 Ohne Schreibrecht" },
    );
    expect(withoutWrite.statusCode).toBe(403);
    expect(withoutWrite.json().error.code).toBe("forbidden");

    const foreignOrigin = await postGroup(
      app,
      headers(cookie, { origin: FOREIGN_ORIGIN }),
      { name: "SYN-CX115 Fremder Ursprung" },
    );
    expect(foreignOrigin.statusCode).toBe(403);
    expect(foreignOrigin.json().error.code).toBe("forbidden");

    expect(await groupCount()).toBe(0);
    expect(await createAuditCount()).toBe(0);
  });

  it("weist leeren und ueberlangen Namen, Zusatzfelder und doppelte Namen bereinigt ohne Folgedatensaetze ab", async () => {
    const app = await buildApp();
    const cookie = await loginCookie(app);
    const adminHeaders = headers(cookie);

    const invalid: ReadonlyArray<{
      label: string;
      payload: Record<string, unknown>;
    }> = [
      { label: "leer", payload: { name: "" } },
      { label: "nur Leerraum", payload: { name: "   " } },
      { label: "ueberlang", payload: { name: "x".repeat(121) } },
      {
        label: "Mitgliederfeld",
        payload: { name: "SYN-CX115 Mitglieder", members: ["SYN-TAXI-1"] },
      },
      {
        label: "Betreiberfeld",
        payload: { name: "SYN-CX115 Betreiber", operator_id: operatorId },
      },
    ];

    for (const item of invalid) {
      const response = await postGroup(app, adminHeaders, item.payload);
      expect(response.statusCode, item.label).toBe(400);
      const body = response.json();
      expect(body.error.code, item.label).toBe("invalid_request");
      expect(Object.keys(body.error).sort(), item.label).toEqual([
        "code",
        "message",
        "request_id",
      ]);
    }
    expect(await groupCount()).toBe(0);

    const first = await postGroup(app, adminHeaders, {
      name: "SYN-CX115 Doppelt",
    });
    expect(first.statusCode).toBe(201);

    const duplicate = await postGroup(app, adminHeaders, {
      name: "  SYN-CX115 Doppelt  ",
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("invalid_request");

    const groups = await pool.query<{ name: string }>(
      "select name from taxi_groups order by name",
    );
    expect(groups.rowCount).toBe(1);
    expect(groups.rows[0]?.name).toBe("SYN-CX115 Doppelt");
    expect(await createAuditCount()).toBe(1);
  });
});
