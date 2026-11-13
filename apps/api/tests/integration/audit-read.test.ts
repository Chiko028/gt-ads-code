import { Writable } from "node:stream";
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
import { createServer } from "../../src/http/server.js";
import { ADMIN_SESSION_COOKIE } from "../../src/modules/adminAuth/middleware.js";

const BASE_TIME = Date.parse("2026-01-01T12:00:00.000Z");
const ADMIN_PASSWORD = "SYN-CX016-Audit-Passwort";
const HOST = "127.0.0.1:8080";

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let config: AppConfig;
const clock = (): Date => new Date(BASE_TIME);
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
    throw new Error("CX-016 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx016_audit_" +
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

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX016-Audit-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };
}, 60_000);

beforeEach(async () => {
  await pool.query(
    "truncate table audit_events, admin_sessions restart identity cascade",
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
  const app = createServer({ config, pool, now: clock });
  await app.ready();
  openApps.push(app);
  return app;
}

function adminHeaders(
  cookie?: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = { host: HOST, ...extra };
  if (cookie !== undefined) {
    headers.cookie = ADMIN_SESSION_COOKIE + "=" + cookie;
  }
  return headers;
}

function sessionCookieOf(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const first = Array.isArray(raw) ? (raw[0] as string) : (raw as string | undefined);
  expect(first, "Set-Cookie fehlt").toBeTruthy();
  const pair = (first as string).split(";")[0] as string;
  expect(pair.startsWith(ADMIN_SESSION_COOKIE + "=")).toBe(true);
  return pair.slice(ADMIN_SESSION_COOKIE.length + 1);
}

async function loginCookie(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/login",
    headers: { host: HOST, "content-type": "application/json" },
    payload: { password: ADMIN_PASSWORD },
    remoteAddress: "192.0.2.220",
  });
  expect(response.statusCode).toBe(204);
  return sessionCookieOf(response);
}

async function insertSyntheticEvents(count: number): Promise<void> {
  await pool.query(
    [
      "insert into audit_events",
      "  (at, actor_type, actor_id, action, target_type, target_id, details)",
      "select $1::timestamptz + (g || ' seconds')::interval,",
      "       'system', 'SYN-actor-' || g, 'synthetic.event.' || g,",
      "       'device', 'SYN-target-' || g, '{}'::jsonb",
      "  from generate_series(1, $2) as g",
    ].join("\n"),
    [new Date(BASE_TIME), count],
  );
}

async function getAllIds(): Promise<string[]> {
  const result = await pool.query<{ audit_id: string }>(
    "select id::text as audit_id from audit_events order by audit_events.id asc",
  );
  return result.rows.map((row) => row.audit_id);
}

function readAudit(
  app: FastifyInstance,
  query = "",
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "GET",
    url: "/v1/admin/audit" + query,
    headers: adminHeaders(undefined, headers),
  });
}

interface AuditItemShape {
  id: string;
  at: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
}

describe("CX-016 geschuetzter Audit-Lesezugriff", () => {
  it("verweigert anonym 401 und Operator 403, erlaubt Admin 200 und ersetzt keine Sitzung durch behauptete Rollenheader", async () => {
    const app = await buildApp();

    // Anonymer Zugriff: auch behauptete Rollen- und Auth-Header ersetzen die
    // serverseitig verifizierte Sitzung nicht.
    const anonymous = await readAudit(app, "?limit=10", {
      "x-role": "Admin",
      "x-admin-role": "Admin",
      "x-gt-ads-role": "Admin",
      authorization: "Bearer SYN-CX016-Behauptung",
      "content-type": "application/json",
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().error.code).toBe("unauthorized");

    // Operator: der Rechtekern kennt audit.read ausschliesslich fuer Admin.
    const operatorApp = createServer({
      config,
      pool,
      now: clock,
      resolvePrincipal: async () => ({ id: "SYN-operator", role: "Operator" }),
    });
    await operatorApp.ready();
    openApps.push(operatorApp);
    const operator = await readAudit(operatorApp, "", {
      "x-role": "Admin",
      "x-admin-role": "Admin",
    });
    expect(operator.statusCode).toBe(403);
    expect(operator.json().error.code).toBe("forbidden");

    // Admin mit echter Sitzung liest die (leere) Liste.
    const adminApp = await buildApp();
    const cookie = await loginCookie(adminApp);
    await pool.query("delete from audit_events");
    const admin = await adminApp.inject({
      method: "GET",
      url: "/v1/admin/audit",
      headers: adminHeaders(cookie),
    });
    expect(admin.statusCode).toBe(200);
    expect(admin.headers["cache-control"]).toBe("no-store");
    expect(admin.json()).toEqual({ items: [], next_cursor: null });
  });

  it("liest 105 Eintraege nach ID aufsteigend mit Standardlimit 50, explizitem Limit 100 und duplikat- sowie lueckenfreien Folgeseiten bis next_cursor=null", async () => {
    await insertSyntheticEvents(105);
    const expectedIds = await getAllIds();
    expect(expectedIds).toHaveLength(105);

    const app = await buildApp();
    const cookie = await loginCookie(app);
    await pool.query("delete from audit_events where action = $1", [
      "admin.login.succeeded",
    ]);

    const defaultPage = await app.inject({
      method: "GET",
      url: "/v1/admin/audit",
      headers: adminHeaders(cookie),
    });
    expect(defaultPage.statusCode).toBe(200);
    const defaultBody = defaultPage.json() as {
      items: AuditItemShape[];
      next_cursor: string | null;
    };
    expect(defaultBody.items).toHaveLength(50);
    expect(defaultBody.items.map((item) => item.id)).toEqual(expectedIds.slice(0, 50));
    expect(defaultBody.next_cursor).toBe(expectedIds[49]);

    const explicit = await app.inject({
      method: "GET",
      url: "/v1/admin/audit?limit=100",
      headers: adminHeaders(cookie),
    });
    expect(explicit.statusCode).toBe(200);
    const explicitBody = explicit.json() as {
      items: AuditItemShape[];
      next_cursor: string | null;
    };
    expect(explicitBody.items).toHaveLength(100);
    expect(explicitBody.items.map((item) => item.id)).toEqual(expectedIds.slice(0, 100));
    expect(explicitBody.next_cursor).toBe(expectedIds[99]);

    // Folgeseiten ohne Duplikate und ohne Auslassungen.
    const collected: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string =
        cursor === null
          ? "/v1/admin/audit"
          : "/v1/admin/audit?cursor=" + encodeURIComponent(cursor);
      const page = await app.inject({
        method: "GET",
        url,
        headers: adminHeaders(cookie),
      });
      expect(page.statusCode).toBe(200);
      const body = page.json() as {
        items: AuditItemShape[];
        next_cursor: string | null;
      };
      collected.push(...body.items.map((item) => item.id));
      cursor = body.next_cursor;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(4);
    } while (cursor !== null);

    expect(pages).toBe(3);
    expect(collected).toEqual(expectedIds);
    expect(new Set(collected).size).toBe(105);
  });

  it("beantwortet ungueltige Limits, Bruchzahlen, ungueltige Cursor und unbekannte Queryparameter bereinigt mit 400 und liefert hinter dem letzten Datensatz eine leere Seite", async () => {
    await insertSyntheticEvents(3);
    const app = await buildApp();
    const cookie = await loginCookie(app);

    const invalidQueries = [
      "?limit=0",
      "?limit=101",
      "?limit=1.5",
      "?limit=-1",
      "?limit=abc",
      "?limit=",
      "?limit=1&limit=2",
      "?cursor=abc",
      "?cursor=-1",
      "?cursor=1.5",
      "?cursor=",
      "?cursor=9223372036854775808",
      "?foo=1",
      "?limit=1&unknown=2",
    ];

    for (const query of invalidQueries) {
      const response = await app.inject({
        method: "GET",
        url: "/v1/admin/audit" + query,
        headers: adminHeaders(cookie),
      });
      expect(response.statusCode, query).toBe(400);
      const body = response.json() as {
        error: { code: string; message: string; request_id: string };
      };
      expect(body.error.code).toBe("invalid_request");
      expect(body.error.message).toBe("Die Anfrage ist ungueltig.");
      expect(typeof body.error.request_id).toBe("string");
      expect(Object.keys(body)).toEqual(["error"]);
    }

    // Ein syntaktisch gueltiger Cursor hinter dem letzten Datensatz ist
    // erlaubt und liefert eine leere Seite.
    const beyond = await app.inject({
      method: "GET",
      url: "/v1/admin/audit?cursor=9223372036854775807",
      headers: adminHeaders(cookie),
    });
    expect(beyond.statusCode).toBe(200);
    expect(beyond.json()).toEqual({ items: [], next_cursor: null });

    // Verlustfreie bigint-IDs: eine ID oberhalb der sicheren Number-Grenze
    // bleibt als exakte Zeichenkette erhalten und dient als Cursor.
    await pool.query(
      [
        "insert into audit_events",
        "  (id, at, actor_type, action, details)",
        "overriding system value",
        "values ($1::bigint, $2::timestamptz, 'system', 'synthetic.large', '{}'::jsonb)",
      ].join("\n"),
      ["9007199254740993", new Date(BASE_TIME)],
    );
    const large = await app.inject({
      method: "GET",
      url: "/v1/admin/audit?cursor=9007199254740992",
      headers: adminHeaders(cookie),
    });
    expect(large.statusCode).toBe(200);
    const largeBody = large.json() as {
      items: AuditItemShape[];
      next_cursor: string | null;
    };
    expect(largeBody.items).toHaveLength(1);
    expect(largeBody.items[0]?.id).toBe("9007199254740993");
    expect(largeBody.next_cursor).toBeNull();
  });

  it("laesst verschachtelte Geheimnisse aus Audit-Details aus Antwort und Logs weg und beantwortet einen Lesefehler bereinigt mit 500", async () => {
    const nestedSecrets = {
      nested: {
        registration_code: "SYN-CX016-GEHEIM-CODE",
        token: "SYN-CX016-GEHEIM-TOKEN",
        deeper: { password: "SYN-CX016-GEHEIM-PASSWORT" },
      },
      note: "SYN-CX016-GEHEIM-NOTIZ",
    };
    await pool.query(
      [
        "insert into audit_events",
        "  (at, actor_type, actor_id, action, target_type, target_id, details)",
        "values ($1::timestamptz, 'system', 'SYN-actor-details',",
        "        'synthetic.secret.payload', 'device', 'SYN-target-details',",
        "        $2::jsonb)",
      ].join("\n"),
      [new Date(BASE_TIME), JSON.stringify(nestedSecrets)],
    );

    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const app = createServer({
      config,
      pool,
      now: clock,
      logger: { level: "info", stream },
    });
    await app.ready();
    openApps.push(app);
    const cookie = await loginCookie(app);
    await pool.query("delete from audit_events where action = $1", [
      "admin.login.succeeded",
    ]);

    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/audit",
      headers: adminHeaders(cookie),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      items: Array<Record<string, unknown>>;
      next_cursor: string | null;
    };
    expect(body.items).toHaveLength(1);
    const item = body.items[0] as Record<string, unknown>;
    expect(item).not.toHaveProperty("details");
    expect(Object.keys(item).sort()).toEqual(
      [
        "action",
        "actor_id",
        "actor_type",
        "at",
        "id",
        "target_id",
        "target_type",
      ].sort(),
    );

    const responseText = response.body;
    const logText = chunks.join("");
    for (const secret of [
      "SYN-CX016-GEHEIM-CODE",
      "SYN-CX016-GEHEIM-TOKEN",
      "SYN-CX016-GEHEIM-PASSWORT",
      "SYN-CX016-GEHEIM-NOTIZ",
    ]) {
      expect(responseText).not.toContain(secret);
      expect(logText).not.toContain(secret);
    }
    expect(responseText).not.toContain('"details"');
    expect(logText).toContain("request completed");

    // Provozierter Lesefehler: die echte Abfrage wird durch einen Fehler mit
    // SQL- und Bindewertanteilen ersetzt. Nach aussen und in den Logs bleibt
    // nur der bereinigte Fehler.
    const failingPool = new Proxy(pool, {
      get(target, property) {
        if (property === "query") {
          return (text: unknown, values?: unknown[]) => {
            if (typeof text === "string" && text.includes("from audit_events")) {
              return Promise.reject(
                new Error(
                  "select id, details from audit_events where token = 'SYN-CX016-SQL-GEHEIM'",
                ),
              );
            }
            return target.query(text as string, values);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as Pool;

    const failureChunks: string[] = [];
    const failureStream = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        failureChunks.push(chunk.toString());
        callback();
      },
    });
    const failingApp = createServer({
      config,
      pool: failingPool,
      now: clock,
      logger: { level: "info", stream: failureStream },
    });
    await failingApp.ready();
    openApps.push(failingApp);
    const failureCookie = await loginCookie(failingApp);

    const failure = await failingApp.inject({
      method: "GET",
      url: "/v1/admin/audit",
      headers: adminHeaders(failureCookie),
    });
    expect(failure.statusCode).toBe(500);
    const failureBody = failure.json() as {
      error: { code: string; message: string; request_id: string };
    };
    expect(failureBody.error.code).toBe("internal_error");
    expect(failureBody.error.message).toBe("Interner Fehler.");
    expect(failure.body).not.toContain("SYN-CX016-SQL-GEHEIM");
    expect(failure.body).not.toContain("select");
    expect(failure.body).not.toContain("audit_events");
    expect(failure.body).not.toContain("SQL");

    const failureLogs = failureChunks.join("");
    expect(failureLogs).not.toContain("SYN-CX016-SQL-GEHEIM");
    expect(failureLogs).not.toContain("from audit_events");
    expect(failureLogs).not.toContain("select id");
    expect(failureLogs).not.toContain("bind");
    expect(failureLogs).toContain("Unbehandelter Fehler");
  });
});

