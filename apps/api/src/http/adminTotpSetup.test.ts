/**
 * CX-107 / R-605: Beginn einer TOTP-Einrichtung.
 *
 * Drei colocated Integrationstests gegen eine echte PostgreSQL-17-Datenbank,
 * echte Fastify-Instanzen/Fastify-inject, echte Admin-Sitzungen, den echten
 * CX-106-Einrichtungsspeicher und die echte Audit-Tabelle. Alle Daten sind
 * synthetisch.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { Pool, type PoolClient } from "pg";
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
import { migrateUp } from "../db/migrate.js";
import { ADMIN_SESSION_COOKIE } from "../modules/adminAuth/middleware.js";
import { PendingTotpEnrollmentStore } from "../modules/adminAuth/pendingTotpEnrollment.js";
import { LEGACY_ADMIN_ACTOR_ID } from "../modules/adminAuth/service.js";
import {
  ADMIN_MFA_TOTP_SETUP_ACTION,
  ADMIN_MFA_TOTP_SETUP_TARGET_TYPE,
  ADMIN_MFA_TOTP_SETUP_URL,
  TOTP_ISSUER,
} from "./adminTotpSetup.js";
import { getRoutePolicyInventory } from "./authorization.js";
import { createServer } from "./server.js";

const BASE_TIME = Date.parse("2026-11-15T09:00:00.000Z");
const ADMIN_PASSWORD = "SYN-CX107-Admin-Passwort";
const OPERATOR_PASSWORD = "SYN-CX107-Operator-Passwort";
const HOST = "127.0.0.1:8080";
const JSON_HEADERS = { "content-type": "application/json" };
const KEY = randomBytes(32);
const FOREIGN_ACTOR = "SYN-CX107-FREMDER-ADMIN";
const FOREIGN_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../db/migrations",
);

interface PendingRow {
  enrollment_id: string;
  expires_at: Date;
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

interface AuditRow {
  actor_type: string;
  actor_id: string | null;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
}

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let config: AppConfig;
let operatorPasswordHash = "";
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
    throw new Error("CX-107 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx107_" +
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

  operatorPasswordHash = await hashPassword(OPERATOR_PASSWORD);
  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX107-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };
}, 120_000);

beforeEach(async () => {
  await pool.query(
    "drop trigger if exists cx107_fail_setup_audit on audit_events",
  );
  await pool.query(
    "drop function if exists cx107_fail_setup_audit() cascade",
  );
  await pool.query(
    [
      "truncate table admin_mfa_pending_totp_enrollments,",
      "  admin_mfa_recovery_codes, admin_mfa_recovery_code_sets,",
      "  admin_sessions, audit_events, operators",
      "restart identity cascade",
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
}, 60_000);

async function buildApp(): Promise<FastifyInstance> {
  const app = createServer({
    config,
    pool,
    now: () => new Date(BASE_TIME),
    mfaTotpEncryptionKey: KEY,
    logger: { level: "silent" },
  });
  await app.ready();
  openApps.push(app);
  return app;
}

async function loginCookie(
  app: FastifyInstance,
  password: string,
  username?: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/login",
    headers: { host: HOST, ...JSON_HEADERS },
    payload: username === undefined ? { password } : { username, password },
    remoteAddress: "192.0.2.107",
  });
  expect(response.statusCode).toBe(204);
  const raw = response.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  expect(first, "Set-Cookie fehlt").toBeTruthy();
  return (first as string)
    .split(";")[0]!
    .slice(ADMIN_SESSION_COOKIE.length + 1);
}

function headers(
  cookie: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    host: HOST,
    ...JSON_HEADERS,
    ...extra,
    cookie: ADMIN_SESSION_COOKIE + "=" + cookie,
  };
}

function setupRequest(
  app: FastifyInstance,
  requestHeaders: Record<string, string>,
  payload: Record<string, unknown> = { password: ADMIN_PASSWORD },
): Promise<{ statusCode: number; json: () => unknown }> {
  return app.inject({
    method: "POST",
    url: ADMIN_MFA_TOTP_SETUP_URL,
    headers: requestHeaders,
    payload,
    remoteAddress: "192.0.2.107",
  }) as unknown as Promise<{ statusCode: number; json: () => unknown }>;
}

async function insertForeignPending(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await new PendingTotpEnrollmentStore({
      client,
      key: KEY,
      now: () => new Date(BASE_TIME),
    }).replace(FOREIGN_ACTOR, FOREIGN_SECRET);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function pendingOf(actorId: string): Promise<PendingRow | undefined> {
  const result = await pool.query<PendingRow>(
    [
      "select enrollment_id::text as enrollment_id, expires_at, nonce,",
      "       ciphertext, tag",
      "  from admin_mfa_pending_totp_enrollments",
      " where actor_id = $1",
    ].join("\n"),
    [actorId],
  );
  return result.rows[0];
}

async function readOwnPending(
  enrollmentId: string,
): Promise<{ secret: string } | null> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("begin");
    const value = await new PendingTotpEnrollmentStore({
      client,
      key: KEY,
      now: () => new Date(BASE_TIME),
    }).read(LEGACY_ADMIN_ACTOR_ID, enrollmentId);
    await client.query("commit");
    return value === null ? null : { secret: value.secret };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function setupAuditRows(): Promise<AuditRow[]> {
  const result = await pool.query<AuditRow>(
    [
      "select actor_type, actor_id, target_type, target_id, details",
      "  from audit_events",
      " where action = $1",
      " order by id asc",
    ].join("\n"),
    [ADMIN_MFA_TOTP_SETUP_ACTION],
  );
  return result.rows;
}

describe("CX-107 TOTP-Einrichtung beginnen", () => {
  it("registriert die Route und erzwingt Sitzung, Adminrolle, JSON-Schreibschutz und Passwort fuer die eigene Einrichtung", async () => {
    const app = await buildApp();

    const registered = getRoutePolicyInventory(app).some(
      (record) =>
        record.method === "POST" &&
        record.url === ADMIN_MFA_TOTP_SETUP_URL &&
        record.policy?.category === "public",
    );
    expect(
      registered,
      "POST /v1/admin/mfa/totp/setup ist nicht in der Anwendung registriert",
    ).toBe(true);

    const operatorId = randomUUID();
    await pool.query(
      [
        "insert into operators",
        "  (actor_id, username, password_hash, status, created_at)",
        "values ($1::uuid, $2, $3, 'active', $4)",
      ].join("\n"),
      [operatorId, "syn-cx107-operator", operatorPasswordHash, new Date(BASE_TIME)],
    );
    const operatorCookie = await loginCookie(
      app,
      OPERATOR_PASSWORD,
      "syn-cx107-operator",
    );
    const adminCookie = await loginCookie(app, ADMIN_PASSWORD);

    await insertForeignPending();
    const foreignBefore = await pendingOf(FOREIGN_ACTOR);
    expect(foreignBefore, "Fremde Einrichtung fehlt").toBeDefined();

    const withoutSession = await setupRequest(app, {
      host: HOST,
      ...JSON_HEADERS,
    });
    expect(withoutSession.statusCode).toBe(401);

    const operatorAttempt = await setupRequest(
      app,
      headers(operatorCookie),
    );
    expect(operatorAttempt.statusCode).toBe(403);

    const foreignOrigin = await setupRequest(
      app,
      headers(adminCookie, { origin: "http://evil.example" }),
    );
    expect(foreignOrigin.statusCode).toBe(403);

    const wrongContentType = await setupRequest(
      app,
      { host: HOST, ...headers(adminCookie), "content-type": "text/plain" },
    );
    expect(wrongContentType.statusCode).toBe(403);

    const wrongPassword = await setupRequest(
      app,
      headers(adminCookie),
      { password: ADMIN_PASSWORD + "-falsch" },
    );
    expect(wrongPassword.statusCode).toBe(401);
    expect(await pendingOf(LEGACY_ADMIN_ACTOR_ID)).toBeUndefined();
    expect(await setupAuditRows()).toHaveLength(0);

    const started = await setupRequest(app, headers(adminCookie));
    expect(started.statusCode).toBe(201);

    const body = started.json() as {
      enrollment_id: string;
      expires_at: string;
      secret: string;
      otpauth_uri: string;
    };
    expect(body.enrollment_id).toMatch(UUID_PATTERN);
    expect(body.expires_at).toBe(
      new Date(BASE_TIME + 10 * 60 * 1000).toISOString(),
    );
    expect(body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(
      body.otpauth_uri.startsWith(
        "otpauth://totp/" + TOTP_ISSUER + ":" + LEGACY_ADMIN_ACTOR_ID + "?",
      ),
    ).toBe(true);
    expect(body.otpauth_uri).toContain("secret=" + body.secret);

    const own = await pendingOf(LEGACY_ADMIN_ACTOR_ID);
    expect(own?.enrollment_id).toBe(body.enrollment_id);
    expect(own?.ciphertext.toString("utf8")).not.toContain(body.secret);
    expect(await readOwnPending(body.enrollment_id)).toEqual({
      secret: body.secret,
    });

    const foreignAfter = await pendingOf(FOREIGN_ACTOR);
    expect(foreignAfter).toEqual(foreignBefore);

    const audit = await setupAuditRows();
    expect(audit).toHaveLength(1);
    const row = audit[0] as AuditRow;
    expect(row.actor_type).toBe("admin");
    expect(row.actor_id).toBe(LEGACY_ADMIN_ACTOR_ID);
    expect(row.target_type).toBe(ADMIN_MFA_TOTP_SETUP_TARGET_TYPE);
    expect(row.target_id).toBe(body.enrollment_id);
    expect(row.details).toEqual({ enrollment_id: body.enrollment_id });
    expect(JSON.stringify(row)).not.toContain(body.secret);
    expect(JSON.stringify(row)).not.toContain(ADMIN_PASSWORD);
  }, 120_000);

  it("verweigert bei bereits aktiver MFA ohne Einrichtung oder Audit-Aenderung", async () => {
    const app = await buildApp();
    const adminCookie = await loginCookie(app, ADMIN_PASSWORD);

    await pool.query(
      [
        "insert into admin_mfa_recovery_code_sets",
        "  (id, actor_id, created_at)",
        "values ($1::uuid, $2, $3)",
      ].join("\n"),
      [randomUUID(), LEGACY_ADMIN_ACTOR_ID, new Date(BASE_TIME)],
    );

    const response = await setupRequest(app, headers(adminCookie));
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      "invalid_request",
    );

    expect(await pendingOf(LEGACY_ADMIN_ACTOR_ID)).toBeUndefined();
    expect(await setupAuditRows()).toHaveLength(0);

    const sets = await pool.query<{ count: string }>(
      "select count(*)::text as count from admin_mfa_recovery_code_sets",
    );
    expect(sets.rows[0]?.count).toBe("1");
  }, 120_000);

  it("schreibt Einrichtung und Audit atomar: ein Audit-Fehler laesst keine Einrichtung zurueck", async () => {
    const app = await buildApp();
    const adminCookie = await loginCookie(app, ADMIN_PASSWORD);

    await pool.query(
      [
        "create or replace function cx107_fail_setup_audit()",
        "returns trigger language plpgsql as $$",
        "begin",
        "  if new.action = '" + ADMIN_MFA_TOTP_SETUP_ACTION + "' then",
        "    raise exception 'CX-107 audit failure';",
        "  end if;",
        "  return new;",
        "end;",
        "$$",
      ].join("\n"),
    );
    await pool.query(
      [
        "create trigger cx107_fail_setup_audit",
        "before insert on audit_events",
        "for each row execute function cx107_fail_setup_audit()",
      ].join("\n"),
    );

    const response = await setupRequest(app, headers(adminCookie));
    expect(response.statusCode).toBe(500);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      "internal_error",
    );

    expect(await pendingOf(LEGACY_ADMIN_ACTOR_ID)).toBeUndefined();
    expect(await setupAuditRows()).toHaveLength(0);
  }, 120_000);
});

