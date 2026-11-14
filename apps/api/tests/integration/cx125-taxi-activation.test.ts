/**
 * CX-125 / R-104: Integrationsnachweis der geschuetzten
 * Taxi-Aktivierungsroute.
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
import { ensureTaxiActivationSchema } from "../../src/modules/taxiActivation/index.js";
import { ADMIN_SESSION_COOKIE } from "../../src/modules/adminAuth/middleware.js";

const BASE_TIME = Date.parse("2026-11-14T12:00:00.000Z");
const ADMIN_PASSWORD = "SYN-CX125-Aktivierungs-Passwort";
const HOST = "127.0.0.1:8080";
const ADMIN_ID = "SYN-CX125-ADMIN";
const OPERATOR_ID = "SYN-CX125-OPERATOR";
const READONLY_ID = "SYN-CX125-LESEND";
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
    throw new Error("CX-125 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

/**
 * Testresolver fuer die Rolle. Das Sitzungscookie bleibt echt und wird von
 * der vorhandenen Sitzungspruefung verifiziert; nur die Rolle des sonst
 * festen Pilot-Admins wird fuer Operator-/Lesefall variiert.
 */
function resolveTestPrincipal(request: {
  headers: Record<string, string | string[] | undefined>;
}): Promise<Principal | null> {
  const role = request.headers["x-test-role"];
  if (role === "Admin") {
    return Promise.resolve({ id: ADMIN_ID, role: "Admin" });
  }
  if (role === "Operator") {
    return Promise.resolve({ id: OPERATOR_ID, role: "Operator" });
  }
  if (role === "Lesend") {
    // Das bestehende Rollenmodell kennt nur Admin und Operator. Eine
    // ausdruecklich lesende, nicht schreibberechtigte Identitaet ist daher
    // eine ungueltige Rolle und wird vom Rechtekern vor dem Handler verweigert.
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
    "gtads_cx125_activation_" +
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

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX125-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };
}, 60_000);

beforeEach(async () => {
  await pool.query(
    "truncate table audit_events, device_taxi_assignments, taxis," +
      " devices, registration_codes, admin_sessions restart identity cascade",
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
    remoteAddress: "192.0.2.250",
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
  role: "Admin" | "Operator" | "Lesend",
  cookie: string | null,
  extra: Record<string, string> = {},
): Record<string, string> {
  const result: Record<string, string> = {
    host: HOST,
    "x-test-role": role,
    ...JSON_HEADERS,
    ...extra,
  };
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
      Buffer.from("SYN-CX125-Code-" + registrationCodeId),
      "SYN-CX125",
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
      "SYN-CX125-Tablet",
      Buffer.from("SYN-CX125-Key-" + deviceId),
      "SYN-CX125-FP-" + deviceId,
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

async function validPair(taxiId: string): Promise<void> {
  const first = await insertDevice();
  const second = await insertDevice();
  await assign(taxiId, first);
  await assign(taxiId, second);
}

function activationUrl(taxiId: string): string {
  return "/v1/admin/taxis/" + encodeURIComponent(taxiId) + "/activation";
}

async function postActivation(
  app: FastifyInstance,
  requestHeaders: Record<string, string>,
  taxiId: string,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; json: () => any }> {
  return app.inject({
    method: "POST",
    url: activationUrl(taxiId),
    headers: requestHeaders,
    payload,
  });
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

async function assignments(
  taxiId: string,
): Promise<Array<{ device_id: string; active: boolean }>> {
  const result = await pool.query<{ device_id: string; active: boolean }>(
    [
      "select device_id::text as device_id, active",
      "  from device_taxi_assignments where taxi_id = $1",
      " order by device_id asc",
    ].join("\n"),
    [taxiId],
  );
  return result.rows;
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
      "  from audit_events where action = 'taxi.activation.changed'",
      " order by id asc",
    ].join("\n"),
  );
  return result.rows;
}

describe("CX-125 geschuetzte Taxi-Aktivierungsroute", () => {
  it("aktiviert und deaktiviert ueber die echte Serverfabrik mit bestaetigtem Zustand und Revision; Audit entsteht nur durch CX-124", async () => {
    const taxiId = "SYN-CX125-ACTIVE";
    await insertTaxi(taxiId);
    await validPair(taxiId);
    const assignmentsBefore = await assignments(taxiId);
    const app = await buildApp();
    const cookie = await loginCookie(app);

    const activated = await postActivation(
      app,
      headers("Admin", cookie),
      taxiId,
      { active: true, revision: 1 },
    );
    expect(activated.statusCode).toBe(200);
    expect(activated.json()).toEqual({ active: true, revision: 2 });
    expect(await taxiRow(taxiId)).toEqual({ active: true, revision: 2 });
    expect(await assignments(taxiId)).toEqual(assignmentsBefore);

    const firstAudits = await activationAudits();
    expect(firstAudits).toHaveLength(1);
    expect(firstAudits[0]).toMatchObject({
      actor_id: ADMIN_ID,
      target_id: taxiId,
      details: { previous_active: false, active: true, revision: 2 },
    });

    const deactivated = await postActivation(
      app,
      headers("Operator", cookie),
      taxiId,
      { active: false, revision: 2 },
    );
    expect(deactivated.statusCode).toBe(200);
    expect(deactivated.json()).toEqual({ active: false, revision: 3 });
    expect(await taxiRow(taxiId)).toEqual({ active: false, revision: 3 });
    expect(await assignments(taxiId)).toEqual(assignmentsBefore);

    const allAudits = await activationAudits();
    expect(allAudits).toHaveLength(2);
    expect(allAudits[1]).toMatchObject({
      actor_id: OPERATOR_ID,
      target_id: taxiId,
      details: { previous_active: true, active: false, revision: 3 },
    });
  });

  const REJECTED_CASES = [
    {
      name: "fehlende Sitzung",
      role: "Admin" as const,
      session: false,
      payload: { active: true, revision: 1 },
      status: 401,
      code: "unauthorized",
    },
    {
      name: "lesende Rolle",
      role: "Lesend" as const,
      session: true,
      payload: { active: true, revision: 1 },
      status: 401,
      code: "unauthorized",
    },
    {
      name: "nichtboolescher Sollzustand als Zeichenkette",
      role: "Admin" as const,
      session: true,
      payload: { active: "true", revision: 1 },
      status: 400,
      code: "invalid_request",
    },
    {
      name: "nichtboolescher Sollzustand als Zahl",
      role: "Admin" as const,
      session: true,
      payload: { active: 1, revision: 1 },
      status: 400,
      code: "invalid_request",
    },
    {
      name: "unbekannte Felder",
      role: "Admin" as const,
      session: true,
      payload: {
        active: true,
        revision: 1,
        actor_id: "SYN-CX125-FREMD",
        taxi_id: "SYN-CX125-FREMD",
      },
      status: 400,
      code: "invalid_request",
    },
  ];

  it.each(REJECTED_CASES)(
    "verhindert jede Mutation bei $name",
    async ({ role, session, payload, status, code }) => {
      const taxiId = "SYN-CX125-REJECT";
      await insertTaxi(taxiId);
      await validPair(taxiId);
      const assignmentsBefore = await assignments(taxiId);
      const app = await buildApp();
      const cookie = session ? await loginCookie(app) : null;

      const response = await postActivation(
        app,
        headers(role, cookie),
        taxiId,
        payload,
      );
      expect(response.statusCode).toBe(status);
      expect(response.json().error.code).toBe(code);
      expect(await taxiRow(taxiId)).toEqual({ active: false, revision: 1 });
      expect(await assignments(taxiId)).toEqual(assignmentsBefore);
      expect(await activationAudits()).toHaveLength(0);
    },
  );

  it("liefert 409 ohne zulaessiges Paar und bei veralteter Revision, 404 bei unbekanntem Taxi und keinen weiteren Audit-Eintrag bei Wiederholung des Sollzustands", async () => {
    const app = await buildApp();
    const cookie = await loginCookie(app);
    const adminHeaders = headers("Admin", cookie);

    const singleId = "SYN-CX125-SINGLE";
    await insertTaxi(singleId);
    await assign(singleId, await insertDevice());
    const single = await postActivation(app, adminHeaders, singleId, {
      active: true,
      revision: 1,
    });
    expect(single.statusCode).toBe(409);
    expect(single.json().error.code).toBe("invalid_request");
    expect(await taxiRow(singleId)).toEqual({ active: false, revision: 1 });

    const staleId = "SYN-CX125-STALE";
    await insertTaxi(staleId);
    await validPair(staleId);
    const stale = await postActivation(app, adminHeaders, staleId, {
      active: true,
      revision: 0,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("invalid_request");
    expect(await taxiRow(staleId)).toEqual({ active: false, revision: 1 });

    const unknown = await postActivation(
      app,
      adminHeaders,
      "SYN-CX125-UNBEKANNT",
      { active: true, revision: 1 },
    );
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("not_found");
    expect(await activationAudits()).toHaveLength(0);

    const repeatId = "SYN-CX125-REPEAT";
    await insertTaxi(repeatId);
    await validPair(repeatId);
    const first = await postActivation(app, adminHeaders, repeatId, {
      active: true,
      revision: 1,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ active: true, revision: 2 });
    expect(await activationAudits()).toHaveLength(1);

    const repeated = await postActivation(app, adminHeaders, repeatId, {
      active: true,
      revision: 2,
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toEqual({ active: true, revision: 2 });
    expect(await taxiRow(repeatId)).toEqual({ active: true, revision: 2 });
    expect(await activationAudits()).toHaveLength(1);
  });
});
