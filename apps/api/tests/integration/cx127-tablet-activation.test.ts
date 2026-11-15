/**
 * CX-127 / R-104 Teil 18: Integrationsnachweis der geschuetzten
 * Tablet-Aktivierungsroute.
 *
 * Die drei Faelle laufen gegen die echte Serverfabrik, eine echte
 * PostgreSQL-Datenbank und echte Admin-Sitzungscookies. Es gibt keinen
 * Listener und keinen externen Dienst; Authentifizierung, Rechtepruefung,
 * Persistenz und Audit werden nicht gemockt. Alle Kennungen sind synthetisch.
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
  ensureTabletActivationSchema,
  TABLET_ACTIVATION_AUDIT_ACTION,
} from "../../src/modules/tabletActivation/index.js";
import { ensureTaxiActivationSchema } from "../../src/modules/taxiActivation/index.js";
import { ADMIN_SESSION_COOKIE } from "../../src/modules/adminAuth/middleware.js";

const BASE_TIME = Date.parse("2026-11-14T12:00:00.000Z");
const ADMIN_PASSWORD = "SYN-CX127-Aktivierungs-Passwort";
const HOST = "127.0.0.1:8080";
const ADMIN_ID = "SYN-CX127-ADMIN";
const OPERATOR_ID = "SYN-CX127-OPERATOR";
const READONLY_ID = "SYN-CX127-LESEND";
const JSON_HEADERS = { "content-type": "application/json" };

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
    throw new Error("CX-127 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

/**
 * Testresolver fuer die Rolle. Das Sitzungscookie bleibt echt und wird von
 * der vorhandenen Sitzungspruefung verifiziert. Ein Bearer-Nachweis wird nie
 * zu einer menschlichen Identitaet; eine ausdruecklich lesende Rolle ist
 * keine gueltige Rolle des Rechtekerns.
 */
function resolveTestPrincipal(request: {
  headers: Record<string, string | string[] | undefined>;
}): Promise<Principal | null> {
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    return Promise.resolve(null);
  }
  const role = request.headers["x-test-role"];
  if (role === "Admin") {
    return Promise.resolve({ id: ADMIN_ID, role: "Admin" });
  }
  if (role === "Operator") {
    return Promise.resolve({ id: OPERATOR_ID, role: "Operator" });
  }
  if (role === "Lesend") {
    return Promise.resolve({
      id: READONLY_ID,
      role: "Lesend" as unknown as Principal["role"],
    });
  }
  return Promise.resolve(null);
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx127_activation_" +
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
  await ensureTaxiActivationSchema(pool);
  await ensureTabletActivationSchema(pool);

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX127-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };
}, 60_000);

beforeEach(async () => {
  await pool.query("drop trigger if exists cx127_fail_audit on audit_events");
  await pool.query("drop function if exists cx127_fail_audit() cascade");
  await pool.query(
    "truncate table audit_events, device_taxi_assignments," +
      " tablet_admin_states, taxis, devices, registration_codes," +
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

async function loginCookie(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/login",
    headers: { host: HOST, ...JSON_HEADERS },
    payload: { password: ADMIN_PASSWORD },
    remoteAddress: "192.0.2.251",
  });
  expect(response.statusCode).toBe(204);
  const raw = response.headers["set-cookie"];
  const first = Array.isArray(raw)
    ? (raw[0] as string)
    : (raw as string | undefined);
  expect(first, "Set-Cookie fehlt").toBeTruthy();
  return (first as string)
    .split(";")[0]!
    .slice(ADMIN_SESSION_COOKIE.length + 1);
}

function headers(
  role: "Admin" | "Operator" | "Lesend" | null,
  cookie: string | null,
  extra: Record<string, string> = {},
): Record<string, string> {
  const result: Record<string, string> = {
    host: HOST,
    ...JSON_HEADERS,
    ...extra,
  };
  if (role !== null) {
    result["x-test-role"] = role;
  }
  if (cookie !== null) {
    result.cookie = ADMIN_SESSION_COOKIE + "=" + cookie;
  }
  return result;
}

async function insertDevice(
  state: "active" | "revoked" = "active",
): Promise<string> {
  const registrationCodeId = randomUUID();
  const deviceId = randomUUID();
  await pool.query(
    [
      "insert into registration_codes",
      "  (id, code_hash, label, created_at, created_by, expires_at)",
      "values ($1::uuid, $2, $3, $4, $5, $6)",
    ].join("\n"),
    [
      registrationCodeId,
      Buffer.from("SYN-CX127-Code-" + registrationCodeId),
      "SYN-CX127",
      new Date(BASE_TIME),
      ADMIN_ID,
      new Date(BASE_TIME + 3_600_000),
    ],
  );
  await pool.query(
    [
      "insert into devices",
      "  (id, label, public_key_spki, public_key_fingerprint, state,",
      "   manufacturer, model, os_version, sdk_int, app_version, app_flavor,",
      "   registration_code_id, registration_request_id, registered_at, last_seen_at)",
      "values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,",
      "        $12::uuid, $13::uuid, $14, $15)",
    ].join("\n"),
    [
      deviceId,
      "SYN-CX127-Tablet",
      Buffer.from("SYN-CX127-Key-" + deviceId),
      "SYN-CX127-FP-" + deviceId,
      state,
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
  return deviceId;
}

async function insertTaxi(
  taxiId: string,
  active = false,
  revision = 1,
): Promise<void> {
  await pool.query(
    [
      "insert into taxis (id, display_name, active, revision)",
      "values ($1, $2, $3, $4)",
    ].join("\n"),
    [taxiId, "SYN " + taxiId, active, revision],
  );
}

async function assign(
  taxiId: string,
  deviceId: string,
  active = true,
): Promise<void> {
  await pool.query(
    [
      "insert into device_taxi_assignments (device_id, taxi_id, active, updated_at)",
      "values ($1::uuid, $2, $3, $4)",
    ].join("\n"),
    [deviceId, taxiId, active, new Date(BASE_TIME)],
  );
}

function activationUrl(deviceId: string): string {
  return "/v1/admin/tablets/" + encodeURIComponent(deviceId) + "/activation";
}

async function patchActivation(
  app: FastifyInstance,
  requestHeaders: Record<string, string>,
  deviceId: string,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; json: () => any }> {
  return app.inject({
    method: "PATCH",
    url: activationUrl(deviceId),
    headers: requestHeaders,
    payload,
  });
}

async function tabletRow(
  deviceId: string,
): Promise<{ active: boolean; revision: number } | null> {
  const result = await pool.query<{ active: boolean; revision: number }>(
    [
      "select active, revision::int as revision",
      "  from tablet_admin_states where device_id = $1::uuid",
    ].join("\n"),
    [deviceId],
  );
  return result.rows[0] ?? null;
}

async function taxiRow(
  taxiId: string,
): Promise<{ active: boolean; revision: number } | null> {
  const result = await pool.query<{ active: boolean; revision: number }>(
    "select active, revision::int as revision from taxis where id = $1",
    [taxiId],
  );
  return result.rows[0] ?? null;
}

async function assignmentActive(
  taxiId: string,
  deviceId: string,
): Promise<boolean> {
  const result = await pool.query<{ active: boolean }>(
    [
      "select active from device_taxi_assignments",
      " where device_id = $1::uuid and taxi_id = $2",
    ].join("\n"),
    [deviceId, taxiId],
  );
  return result.rows[0]!.active;
}

async function activationAudits(): Promise<
  Array<{
    actor_id: string | null;
    target_id: string | null;
    details: Record<string, unknown>;
  }>
> {
  const result = await pool.query<{
    actor_id: string | null;
    target_id: string | null;
    details: Record<string, unknown>;
  }>(
    [
      "select actor_id, target_id, details",
      "  from audit_events where action = $1",
      " order by id asc",
    ].join("\n"),
    [TABLET_ACTIVATION_AUDIT_ACTION],
  );
  return result.rows;
}

describe("CX-127 geschuetzte Tablet-Aktivierungsroute", () => {
  it("deaktiviert Tablet und zugeordnetes Taxi mit bestaetigten Zustaenden und Revisionen und verweigert Operator ohne Mutation; Audit entsteht nur durch CX-126", async () => {
    const deviceId = await insertDevice();
    const taxiId = "SYN-CX127-PAIR";
    await insertTaxi(taxiId, true, 1);
    await assign(taxiId, deviceId, true);
    const app = await buildApp();
    const cookie = await loginCookie(app);

    const deactivated = await patchActivation(
      app,
      headers("Admin", cookie),
      deviceId,
      { active: false, expectedRevision: 0 },
    );
    expect(deactivated.statusCode).toBe(200);
    expect(deactivated.json()).toEqual({
      active: false,
      revision: 1,
      taxi: { taxiId, active: false, revision: 2 },
    });
    expect(await tabletRow(deviceId)).toEqual({ active: false, revision: 1 });
    expect(await taxiRow(taxiId)).toEqual({ active: false, revision: 2 });
    expect(await assignmentActive(taxiId, deviceId)).toBe(false);

    const firstAudits = await activationAudits();
    expect(firstAudits).toHaveLength(1);
    expect(firstAudits[0]).toMatchObject({
      actor_id: ADMIN_ID,
      target_id: deviceId,
      details: {
        previous_active: true,
        active: false,
        revision: 1,
        taxi_id: taxiId,
        taxi_previous_active: true,
        taxi_active: false,
        taxi_revision: 2,
        assignment_active: false,
      },
    });

    // CX-056: Tabletaktivierung bleibt Admin vorbehalten. Der Rechtekern
    // verweigert die Operatorrolle vor dem Handler; Zustand und Audit bleiben.
    const reactivated = await patchActivation(
      app,
      headers("Operator", cookie),
      deviceId,
      { active: true, expectedRevision: 1 },
    );
    expect(reactivated.statusCode).toBe(403);
    expect(reactivated.json().error.code).toBe("forbidden");
    expect(await tabletRow(deviceId)).toEqual({ active: false, revision: 1 });
    expect(await taxiRow(taxiId)).toEqual({ active: false, revision: 2 });
    expect(await assignmentActive(taxiId, deviceId)).toBe(false);

    const allAudits = await activationAudits();
    expect(allAudits).toHaveLength(1);
    expect(allAudits[0]).toMatchObject({
      actor_id: ADMIN_ID,
      target_id: deviceId,
      details: {
        previous_active: true,
        active: false,
        revision: 1,
        taxi_id: taxiId,
        taxi_previous_active: true,
        taxi_active: false,
        taxi_revision: 2,
        assignment_active: false,
      },
    });
  });

  it("verweigert ohne Sitzung, mit Geraeteauthentifizierung und mit lesender Rolle vor dem Dienstaufruf", async () => {
    const cases: Array<{
      name: string;
      role: "Admin" | "Lesend" | null;
      cookie: boolean;
      extra: Record<string, string>;
    }> = [
      {
        name: "ohne Sitzung",
        role: "Admin" as const,
        cookie: false,
        extra: {},
      },
      {
        name: "Geraeteauthentifizierung",
        role: null,
        cookie: false,
        extra: { authorization: "Bearer SYN-CX127-GERAET" },
      },
      {
        name: "lesende Rolle",
        role: "Lesend" as const,
        cookie: true,
        extra: {},
      },
    ];

    for (const testCase of cases) {
      const deviceId = await insertDevice();
      const taxiId = "SYN-CX127-DENY-" + randomUUID().slice(0, 8);
      await insertTaxi(taxiId, true, 1);
      await assign(taxiId, deviceId, true);
      const app = await buildApp();
      const cookie = testCase.cookie ? await loginCookie(app) : null;

      const response = await patchActivation(
        app,
        headers(testCase.role, cookie, testCase.extra),
        deviceId,
        { active: false, expectedRevision: 0 },
      );
      expect(response.statusCode, testCase.name).toBe(401);
      expect(response.json().error.code, testCase.name).toBe("unauthorized");

      expect(await tabletRow(deviceId), testCase.name).toBeNull();
      expect(await taxiRow(taxiId), testCase.name).toEqual({
        active: true,
        revision: 1,
      });
      expect(
        await assignmentActive(taxiId, deviceId),
        testCase.name,
      ).toBe(true);
      expect(await activationAudits(), testCase.name).toHaveLength(0);
    }
  });

  it("lehnt ungueltige Felder und IDs ab, liefert 409 bei veralteter Revision, 404 bei unbekannter Tablet-ID und 500 ohne Teiländerung bei einem Dienstfehler", async () => {
    const deviceId = await insertDevice();
    const taxiId = "SYN-CX127-ERRORS";
    await insertTaxi(taxiId, true, 1);
    await assign(taxiId, deviceId, true);
    const app = await buildApp();
    const cookie = await loginCookie(app);
    const authHeaders = headers("Admin", cookie);

    const unknownField = await patchActivation(
      app,
      authHeaders,
      deviceId,
      {
        active: false,
        expectedRevision: 0,
        actor_id: "SYN-CX127-FREMD",
        device_id: "SYN-CX127-FREMD",
      },
    );
    expect(unknownField.statusCode).toBe(400);
    expect(unknownField.json().error.code).toBe("invalid_request");

    const wrongType = await patchActivation(app, authHeaders, deviceId, {
      active: "false",
      expectedRevision: 0,
    });
    expect(wrongType.statusCode).toBe(400);
    expect(wrongType.json().error.code).toBe("invalid_request");

    const missingRevision = await patchActivation(app, authHeaders, deviceId, {
      active: false,
    });
    expect(missingRevision.statusCode).toBe(400);
    expect(missingRevision.json().error.code).toBe("invalid_request");

    const invalidId = await app.inject({
      method: "PATCH",
      url: activationUrl("nicht-uuid"),
      headers: authHeaders,
      payload: { active: false, expectedRevision: 0 },
    });
    expect(invalidId.statusCode).toBe(400);
    expect(invalidId.json().error.code).toBe("invalid_request");

    const stale = await patchActivation(app, authHeaders, deviceId, {
      active: false,
      expectedRevision: 1,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("invalid_request");

    const unknown = await patchActivation(
      app,
      authHeaders,
      randomUUID(),
      { active: false, expectedRevision: 0 },
    );
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("not_found");

    expect(await tabletRow(deviceId)).toBeNull();
    expect(await taxiRow(taxiId)).toEqual({ active: true, revision: 1 });
    expect(await assignmentActive(taxiId, deviceId)).toBe(true);
    expect(await activationAudits()).toHaveLength(0);

    const failingDevice = await insertDevice();
    const failingTaxi = "SYN-CX127-FAIL-" + randomUUID().slice(0, 8);
    await insertTaxi(failingTaxi, true, 1);
    await assign(failingTaxi, failingDevice, true);
    await pool.query(
      [
        "create or replace function cx127_fail_audit() returns trigger",
        "language plpgsql as $$ begin",
        "  raise exception 'SYN-CX127 Auditfehler';",
        "end $$",
      ].join("\n"),
    );
    await pool.query(
      "create trigger cx127_fail_audit before insert on audit_events" +
        " for each row execute function cx127_fail_audit()",
    );

    try {
      const failed = await patchActivation(
        app,
        authHeaders,
        failingDevice,
        { active: false, expectedRevision: 0 },
      );
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toMatchObject({
        error: { code: "internal_error", message: "Interner Fehler." },
      });
      expect(typeof failed.json().error.request_id).toBe("string");
      const serialized = JSON.stringify(failed.json());
      expect(serialized).not.toContain("SYN-CX127");
      expect(serialized).not.toContain("audit_events");
    } finally {
      await pool.query("drop trigger if exists cx127_fail_audit on audit_events");
      await pool.query("drop function if exists cx127_fail_audit() cascade");
    }

    expect(await tabletRow(failingDevice)).toBeNull();
    expect(await taxiRow(failingTaxi)).toEqual({ active: true, revision: 1 });
    expect(await assignmentActive(failingTaxi, failingDevice)).toBe(true);
    expect(await activationAudits()).toHaveLength(0);
  });
});
