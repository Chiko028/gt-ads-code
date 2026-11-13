import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
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
import { CONFIG_DEFAULTS, type AppConfig } from "../../config.js";
import { hashPassword } from "../../crypto/password.js";
import { registerErrorHandler } from "../../http/errors.js";
import {
  ADMIN_SESSION_COOKIE,
} from "../adminAuth/middleware.js";
import {
  ADMIN_ACTOR_ID,
  AdminAuthService,
} from "../adminAuth/service.js";
import {
  CUSTOMER_CREATED_ACTION,
  CustomerService,
} from "./customers.js";
import { registerCustomerRoutes } from "./routes.js";

const BASE_TIME = Date.parse("2026-11-13T12:00:00.000Z");
const ADMIN_PASSWORD = "SYN-CX032-Kunden-Passwort";
const HOST = "127.0.0.1:8080";
const ORIGIN = "http://" + HOST;
const FOREIGN_ORIGIN = "http://fremde.example";
const CUSTOMERS_URL = "/v1/admin/customers";
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);
const CUSTOMER_UP = "0009_campaign_customers.up.sql";
const CUSTOMER_DOWN = "0009_campaign_customers.down.sql";

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let config: AppConfig;
const clock = (): Date => new Date(BASE_TIME);
const openApps: FastifyInstance[] = [];

interface AuditRow {
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: { fields?: string[] };
}

interface BuiltApp {
  app: FastifyInstance;
  adminAuth: AdminAuthService;
}

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
    throw new Error("CX-032 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

async function customerCount(): Promise<number> {
  const result = await pool.query<{ count: number }>(
    "select count(*)::int as count from customers",
  );
  return result.rows[0]?.count ?? 0;
}

async function customerAuditCount(): Promise<number> {
  const result = await pool.query<{ count: number }>(
    "select count(*)::int as count from audit_events where action = $1",
    [CUSTOMER_CREATED_ACTION],
  );
  return result.rows[0]?.count ?? 0;
}

function captureStream(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}

async function buildApp(
  logger?: FastifyServerOptions["logger"],
): Promise<BuiltApp> {
  const app = Fastify({
    logger: logger ?? false,
    disableRequestLogging: true,
    bodyLimit: 64 * 1024,
  });
  await app.register(cookie);
  registerErrorHandler(app);

  const adminAuth = new AdminAuthService({ pool, config, now: clock });
  const service = new CustomerService({ pool });
  registerCustomerRoutes(app, { service, adminAuth });
  await app.ready();
  openApps.push(app);
  return { app, adminAuth };
}

async function closeApp(app: FastifyInstance): Promise<void> {
  const index = openApps.indexOf(app);
  if (index >= 0) {
    openApps.splice(index, 1);
  }
  await app.close();
}

async function login(adminAuth: AdminAuthService): Promise<string> {
  const result = await adminAuth.login(ADMIN_PASSWORD);
  return result.token;
}

function adminHeaders(
  sessionToken?: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = { host: HOST, ...extra };
  if (sessionToken !== undefined) {
    headers.cookie = ADMIN_SESSION_COOKIE + "=" + sessionToken;
  }
  return headers;
}

function jsonHeaders(
  sessionToken?: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return adminHeaders(sessionToken, {
    "content-type": "application/json",
    ...extra,
  });
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx032_customers_" +
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
  const migrationFiles = (await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".up.sql"))
    .sort();
  for (const name of migrationFiles) {
    await pool.query(await readFile(join(MIGRATIONS_DIR, name), "utf8"));
  }

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX032-Kunden-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };
}, 60_000);

beforeEach(async () => {
  await pool.query(
    "truncate table audit_events, admin_sessions, customers restart identity cascade",
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

describe("CX-032 Kundenkern", () => {
  it("fuehrt die neue Migration im isolierten Schema vorwaerts, rueckwaerts und erneut vorwaerts aus und sichert UUID, Namensgrenzen, Revision und Zeitstempel", async () => {
    const schema = "cx032_migration_" + process.pid + "_" + randomUUID().slice(0, 8);
    const quotedSchema = quoteIdentifier(schema);
    const client = await pool.connect();
    const upSql = await readFile(join(MIGRATIONS_DIR, CUSTOMER_UP), "utf8");
    const downSql = await readFile(join(MIGRATIONS_DIR, CUSTOMER_DOWN), "utf8");

    async function relationExists(name: string): Promise<boolean> {
      const result = await client.query<{ name: string | null }>(
        "select to_regclass($1)::text as name",
        [name],
      );
      return result.rows[0]?.name !== null;
    }

    try {
      await client.query("create schema " + quotedSchema);
      await client.query("set search_path to " + quotedSchema);
      await client.query("create table keep_me (id integer primary key)");
      await client.query(upSql);

      expect(await relationExists(schema + ".customers")).toBe(true);
      expect(await relationExists("public.audit_events")).toBe(true);

      const id = randomUUID();
      const longName = "N".repeat(128);
      const inserted = await client.query<{
        id: string;
        revision: number;
        created_at: Date;
        updated_at: Date;
      }>(
        [
          "insert into customers (id, display_name)",
          "values ($1::uuid, $2)",
          "returning id::text as id, revision, created_at, updated_at",
        ].join("\n"),
        [id, longName],
      );
      const row = inserted.rows[0];
      expect(row?.id).toBe(id);
      expect(row?.revision).toBe(1);
      expect(row?.created_at).toBeInstanceOf(Date);
      expect(row?.updated_at).toBeInstanceOf(Date);
      expect(Math.abs((row?.created_at as Date).getTime() - Date.now())).toBeLessThan(
        60_000,
      );
      expect((row?.updated_at as Date).getTime()).toBe(
        (row?.created_at as Date).getTime(),
      );

      await expect(
        client.query(
          "insert into customers (id, display_name) values ($1, $2)",
          ["keine-uuid", "X"],
        ),
      ).rejects.toThrow();
      await expect(
        client.query(
          "insert into customers (id, display_name) values ($1::uuid, $2)",
          [randomUUID(), ""],
        ),
      ).rejects.toThrow();
      await expect(
        client.query(
          "insert into customers (id, display_name) values ($1::uuid, $2)",
          [randomUUID(), "N".repeat(129)],
        ),
      ).rejects.toThrow();
      await expect(
        client.query(
          "insert into customers (id, display_name, revision) values ($1::uuid, $2, 0)",
          [randomUUID(), "X"],
        ),
      ).rejects.toThrow();
      await expect(
        client.query(
          "insert into customers (id, display_name, created_at) values ($1::uuid, $2, null)",
          [randomUUID(), "X"],
        ),
      ).rejects.toThrow();

      await client.query(downSql);
      expect(await relationExists(schema + ".customers")).toBe(false);
      expect(await relationExists(schema + ".keep_me")).toBe(true);
      expect(await relationExists("public.audit_events")).toBe(true);

      await client.query(upSql);
      expect(await relationExists(schema + ".customers")).toBe(true);
      expect(await relationExists("public.audit_events")).toBe(true);
    } finally {
      await client.query("set search_path to public");
      await client.query("drop schema if exists " + quotedSchema + " cascade");
      client.release();
    }
  });

  it("legt authentifiziert einen Kunden mit Revision 1 und genau einem bereinigten Audit-Ereignis an und liefert ihn nach neuer Instanz per ID und Liste", async () => {
    const first = await buildApp();
    const sessionToken = await login(first.adminAuth);

    const createdResponse = await first.app.inject({
      method: "POST",
      url: CUSTOMERS_URL,
      headers: jsonHeaders(sessionToken, { origin: ORIGIN }),
      payload: { display_name: "  SYN-CX032-Kunde  " },
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json() as {
      id: string;
      display_name: string;
      revision: number;
      created_at: string;
      updated_at: string;
    };
    expect(created.display_name).toBe("SYN-CX032-Kunde");
    expect(created.revision).toBe(1);
    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(created.updated_at).toBe(created.created_at);

    const stored = await pool.query<{ id: string; revision: number }>(
      "select id::text as id, revision from customers where id = $1::uuid",
      [created.id],
    );
    expect(stored.rows[0]).toEqual({ id: created.id, revision: 1 });

    const audit = await pool.query<AuditRow>(
      [
        "select actor_type, actor_id, action, target_type, target_id, details",
        "  from audit_events",
        " where action = $1",
      ].join("\n"),
      [CUSTOMER_CREATED_ACTION],
    );
    expect(audit.rows).toHaveLength(1);
    const event = audit.rows[0] as AuditRow;
    expect(event.actor_type).toBe("admin");
    expect(event.actor_id).toBe(ADMIN_ACTOR_ID);
    expect(event.target_type).toBe("customer");
    expect(event.target_id).toBe(created.id);
    expect(Object.keys(event.details).sort()).toEqual(["fields"]);
    expect(event.details.fields).toEqual(["display_name"]);
    expect(JSON.stringify(event.details)).not.toContain("SYN-CX032-Kunde");

    await closeApp(first.app);
    const second = await buildApp();

    const byId = await second.app.inject({
      method: "GET",
      url: CUSTOMERS_URL + "/" + created.id,
      headers: adminHeaders(sessionToken),
    });
    expect(byId.statusCode).toBe(200);
    expect(byId.json()).toEqual(created);

    const list = await second.app.inject({
      method: "GET",
      url: CUSTOMERS_URL,
      headers: adminHeaders(sessionToken),
    });
    expect(list.statusCode).toBe(200);
    const listBody = list.json() as { items: Array<{ id: string }> };
    expect(listBody.items.map((item) => item.id)).toContain(created.id);

    await pool.query(
      [
        "insert into customers (id, display_name)",
        "select ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,",
        "       'Bulk ' || g",
        "  from generate_series(1, 105) g",
      ].join("\n"),
    );

    const limited = await second.app.inject({
      method: "GET",
      url: CUSTOMERS_URL,
      headers: adminHeaders(sessionToken),
    });
    expect(limited.statusCode).toBe(200);
    const limitedBody = limited.json() as { items: Array<{ id: string }> };
    expect(limitedBody.items).toHaveLength(100);
    const ids = limitedBody.items.map((item) => item.id);
    expect(ids).toEqual([...ids].sort());

    const one = await second.app.inject({
      method: "GET",
      url: CUSTOMERS_URL + "?limit=1",
      headers: adminHeaders(sessionToken),
    });
    expect(one.statusCode).toBe(200);
    expect((one.json() as { items: unknown[] }).items).toHaveLength(1);

    expect(await customerAuditCount()).toBe(1);
    expect(await customerCount()).toBe(106);
  });

  it("weist fehlende Sitzung, fehlendes Schreibrecht, unbekannte Felder, ungueltige Namen, UUIDs, Limits und unbekannte Kunden ohne Datenbankaenderung ab", async () => {
    const { app, adminAuth } = await buildApp();
    const sessionToken = await login(adminAuth);
    const beforeCustomers = await customerCount();
    const beforeAudit = await customerAuditCount();

    const noSession = await app.inject({
      method: "POST",
      url: CUSTOMERS_URL,
      headers: jsonHeaders(undefined),
      payload: { display_name: "SYN-CX032-OhneSitzung" },
    });
    expect(noSession.statusCode).toBe(401);
    expect((noSession.json() as { error: { code: string } }).error.code).toBe(
      "unauthorized",
    );

    const noWrite = await app.inject({
      method: "POST",
      url: CUSTOMERS_URL,
      headers: jsonHeaders(sessionToken, { origin: FOREIGN_ORIGIN }),
      payload: { display_name: "SYN-CX032-OhneRecht" },
    });
    expect(noWrite.statusCode).toBe(403);
    expect((noWrite.json() as { error: { code: string } }).error.code).toBe(
      "forbidden",
    );

    const invalidBodies: Array<Record<string, unknown>> = [
      { display_name: "SYN-CX032-Zusatz", extra: true },
      { display_name: "   " },
      { display_name: "N".repeat(129) },
      {},
    ];
    for (const payload of invalidBodies) {
      const response = await app.inject({
        method: "POST",
        url: CUSTOMERS_URL,
        headers: jsonHeaders(sessionToken),
        payload,
      });
      expect(response.statusCode).toBe(400);
      const body = response.json() as {
        error: { code: string; message: string; request_id: string };
      };
      expect(Object.keys(body)).toEqual(["error"]);
      expect(body.error.code).toBe("invalid_request");
    }

    const invalidId = await app.inject({
      method: "GET",
      url: CUSTOMERS_URL + "/keine-uuid",
      headers: adminHeaders(sessionToken),
    });
    expect(invalidId.statusCode).toBe(400);
    expect(
      (invalidId.json() as { error: { code: string } }).error.code,
    ).toBe("invalid_request");

    const unknownId = await app.inject({
      method: "GET",
      url: CUSTOMERS_URL + "/" + randomUUID(),
      headers: adminHeaders(sessionToken),
    });
    expect(unknownId.statusCode).toBe(404);
    expect((unknownId.json() as { error: { code: string } }).error.code).toBe(
      "not_found",
    );

    for (const query of ["limit=0", "limit=101", "limit=abc", "limit=1.5", "limit=01", "unbekannt=1"]) {
      const response = await app.inject({
        method: "GET",
        url: CUSTOMERS_URL + "?" + query,
        headers: adminHeaders(sessionToken),
      });
      expect(response.statusCode).toBe(400);
      expect(
        (response.json() as { error: { code: string } }).error.code,
      ).toBe("invalid_request");
    }

    expect(await customerCount()).toBe(beforeCustomers);
    expect(await customerAuditCount()).toBe(beforeAudit);
  });

  it("rollt das Anlegen bei einem gezielt provozierten Auditfehler vollstaendig zurueck und antwortet samt Logs ohne SQL, Stacktrace, Sitzung oder Kundennamen", async () => {
    const logs = captureStream();
    const { app, adminAuth } = await buildApp({
      level: "info",
      stream: logs.stream,
    });
    const sessionToken = await login(adminAuth);
    await pool.query("delete from audit_events where action = 'admin.login.succeeded'");

    const customerName = "SYN-CX032-KUNDENNAME";
    const sqlMarker = "SYN-CX032-SQL-GEHEIM";
    try {
      await pool.query(
        [
          "create or replace function cx032_fail_customer_audit()",
          "returns trigger language plpgsql as $$",
          "begin",
          "  if new.action = 'customer.created' then",
          "    raise exception '" + sqlMarker + " insert into audit_events for " + customerName + "';",
          "  end if;",
          "  return new;",
          "end",
          "$$",
        ].join("\n"),
      );
      await pool.query(
        [
          "create trigger cx032_fail_customer_audit",
          "before insert on audit_events",
          "for each row execute function cx032_fail_customer_audit()",
        ].join("\n"),
      );

      const response = await app.inject({
        method: "POST",
        url: CUSTOMERS_URL,
        headers: jsonHeaders(sessionToken, { origin: ORIGIN }),
        payload: { display_name: customerName },
      });
      expect(response.statusCode).toBe(500);
      const body = response.json() as {
        error: { code: string; message: string; request_id: string };
      };
      expect(body.error.code).toBe("internal_error");
      expect(body.error.message).toBe("Interner Fehler.");

      const customers = await pool.query<{ count: number }>(
        "select count(*)::int as count from customers where display_name = $1",
        [customerName],
      );
      expect(customers.rows[0]?.count).toBe(0);
      expect(await customerAuditCount()).toBe(0);

      const logText = logs.text();
      for (const marker of [
        sqlMarker,
        customerName,
        "insert into",
        "audit_events",
        "select ",
        "customers.ts",
        " at ",
        sessionToken,
      ]) {
        expect(response.body).not.toContain(marker);
        expect(logText).not.toContain(marker);
      }
      expect(logText).toContain("Unbehandelter Fehler");
    } finally {
      await pool.query(
        "drop trigger if exists cx032_fail_customer_audit on audit_events",
      );
      await pool.query("drop function if exists cx032_fail_customer_audit()");
    }
  });
});
