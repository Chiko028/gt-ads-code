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
import { ADMIN_SESSION_COOKIE } from "../../src/modules/adminAuth/middleware.js";
import {
  createControlConfigService,
  type ControlConfigService,
  type TaxiControlConfigValues,
} from "../../src/modules/controlConfig/index.js";

const BASE_TIME = Date.parse("2026-11-14T10:00:00.000Z");
const ADMIN_PASSWORD = "SYN-CX053-Konfigurations-Passwort";
const HOST = "127.0.0.1:8080";
const FOREIGN_ORIGIN = "http://fremde.example";
const TAXI_A = "SYN-CX053-TAXI-A";
const TAXI_B = "SYN-CX053-TAXI-B";
const UNKNOWN_TAXI = "SYN-CX053-UNBEKANNT";
const ADMIN_ID = "SYN-CX053-ADMIN";
const OPERATOR_ID = "SYN-CX053-OPERATOR";
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/db/migrations",
);

const COMPLETE: TaxiControlConfigValues = {
  gps_mode: "aus",
  pause_max_duration_s: 1234,
  pause_end_on_vehicle_off: true,
  display_run_on_s: 45,
};

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
    throw new Error("CX-053 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

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
  return Promise.resolve(null);
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx053_http_" +
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
  for (const migration of [
    "0004_cx_012_remote_control.up.sql",
    "0005_cx_013_control_config.up.sql",
    "0010_cx_041_manifest_refresh.up.sql",
  ]) {
    await pool.query(await readFile(join(MIGRATIONS_DIR, migration), "utf8"));
  }

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX053-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };
}, 60_000);

beforeEach(async () => {
  await pool.query(
    [
      "truncate table control_config_changes, control_config_taxi,",
      "  remote_control_taxi_state, taxi_manifest_state,",
      "  taxi_group_memberships, audit_events, admin_sessions",
      " restart identity cascade",
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
  return ((first as string).split(";")[0] as string).slice(
    ADMIN_SESSION_COOKIE.length + 1,
  );
}

async function loginCookie(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/login",
    headers: { host: HOST, "content-type": "application/json" },
    payload: { password: ADMIN_PASSWORD },
    remoteAddress: "192.0.2.240",
  });
  expect(response.statusCode).toBe(204);
  return sessionCookieOf(response);
}

function headers(
  role: "Admin" | "Operator",
  cookie: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    host: HOST,
    "x-test-role": role,
    cookie: ADMIN_SESSION_COOKIE + "=" + cookie,
    ...extra,
  };
}

async function seedKnownTaxi(taxiId: string): Promise<void> {
  await pool.query(
    "insert into taxi_manifest_state (taxi_id, updated_at) values ($1, $2)",
    [taxiId, new Date(BASE_TIME)],
  );
}

function controlConfigService(): ControlConfigService {
  return createControlConfigService({
    pool,
    now: () => new Date(BASE_TIME),
  });
}

async function seedConfig(
  taxiId: string,
  values: TaxiControlConfigValues,
  expectedRevision = 0,
): Promise<void> {
  await controlConfigService().updateTaxiConfig({
    actor: { id: ADMIN_ID, type: "admin" },
    taxi_id: taxiId,
    change_id: randomUUID(),
    expected_revision: expectedRevision,
    config: values,
  });
}

interface Snapshot {
  config: unknown[];
  changes: unknown[];
  audit: unknown[];
}

async function snapshot(taxiId: string): Promise<Snapshot> {
  const configRows = await pool.query(
    [
      "select taxi_id, revision::int as revision, gps_mode,",
      "       pause_max_duration_s::text as pause_max_duration_s,",
      "       pause_end_on_vehicle_off,",
      "       display_run_on_s::text as display_run_on_s",
      "  from control_config_taxi where taxi_id = $1",
    ].join("\n"),
    [taxiId],
  );
  const changeRows = await pool.query(
    [
      "select change_id::text as change_id, taxi_id, revision::int as revision,",
      "       content_fingerprint, actor_id, gps_mode,",
      "       pause_max_duration_s::text as pause_max_duration_s,",
      "       pause_end_on_vehicle_off,",
      "       display_run_on_s::text as display_run_on_s",
      "  from control_config_changes where taxi_id = $1",
      " order by revision",
    ].join("\n"),
    [taxiId],
  );
  const auditRows = await pool.query(
    [
      "select actor_type, actor_id, action, target_type, target_id, details",
      "  from audit_events where target_id = $1",
      " order by id",
    ].join("\n"),
    [taxiId],
  );
  return {
    config: configRows.rows,
    changes: changeRows.rows,
    audit: auditRows.rows,
  };
}

function configUrl(taxiId: string): string {
  return "/v1/admin/taxis/" + taxiId + "/config";
}

const COMPLETE_BODY = {
  expected_revision: 0,
  change_id: randomUUID(),
  gps_mode: "aus",
  pause_max_duration_s: 1234,
  pause_end_on_vehicle_off: true,
  display_run_on_s: 45,
};

describe("CX-053 versionierte Taxi-Konfigurationsrouten", () => {
  it("GET liefert die gespeicherte Revision, GPS aus und fuer ein bekanntes unkonfiguriertes Taxi null-Werte; unbekanntes Taxi ergibt 404", async () => {
    await seedKnownTaxi(TAXI_A);
    await seedKnownTaxi(TAXI_B);
    await seedConfig(TAXI_A, COMPLETE);

    const app = await buildApp();
    const cookie = await loginCookie(app);

    const stored = await app.inject({
      method: "GET",
      url: configUrl(TAXI_A),
      headers: headers("Admin", cookie),
    });
    expect(stored.statusCode).toBe(200);
    expect(stored.json()).toEqual({
      taxi_id: TAXI_A,
      revision: 1,
      gps_mode: "aus",
      pause_max_duration_s: 1234,
      pause_end_on_vehicle_off: true,
      display_run_on_s: 45,
      policy_complete: true,
    });

    const unconfigured = await app.inject({
      method: "GET",
      url: configUrl(TAXI_B),
      headers: headers("Admin", cookie),
    });
    expect(unconfigured.statusCode).toBe(200);
    expect(unconfigured.json()).toEqual({
      taxi_id: TAXI_B,
      revision: 0,
      gps_mode: "aus",
      pause_max_duration_s: null,
      pause_end_on_vehicle_off: null,
      display_run_on_s: null,
      policy_complete: false,
    });

    const unknown = await app.inject({
      method: "GET",
      url: configUrl(UNKNOWN_TAXI),
      headers: headers("Admin", cookie),
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("not_found");
  });

  it("Admin aendert mit gueltiger erwarteter Revision; PostgreSQL enthaelt genau eine neue Version und das vorhandene Aenderungsaudit", async () => {
    await seedKnownTaxi(TAXI_A);
    const app = await buildApp();
    const cookie = await loginCookie(app);

    const changeId = randomUUID();
    const response = await app.inject({
      method: "PATCH",
      url: configUrl(TAXI_A),
      headers: headers("Admin", cookie, {
        "content-type": "application/json",
      }),
      payload: { ...COMPLETE_BODY, change_id: changeId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      taxi_id: TAXI_A,
      revision: 1,
      gps_mode: "aus",
      pause_max_duration_s: 1234,
      pause_end_on_vehicle_off: true,
      display_run_on_s: 45,
      policy_complete: true,
      change_id: changeId,
      idempotent: false,
    });

    const storedConfig = await pool.query(
      "select revision::int as revision from control_config_taxi where taxi_id = $1",
      [TAXI_A],
    );
    expect(storedConfig.rows).toEqual([{ revision: 1 }]);

    const changes = await pool.query(
      [
        "select change_id::text as change_id, revision::int as revision,",
        "       actor_id, gps_mode, pause_max_duration_s::text as pause_max_duration_s,",
        "       pause_end_on_vehicle_off, display_run_on_s::text as display_run_on_s",
        "  from control_config_changes where taxi_id = $1",
      ].join("\n"),
      [TAXI_A],
    );
    expect(changes.rows).toHaveLength(1);
    expect(changes.rows[0]).toMatchObject({
      change_id: changeId,
      revision: 1,
      actor_id: ADMIN_ID,
      gps_mode: "aus",
      pause_max_duration_s: "1234",
      pause_end_on_vehicle_off: true,
      display_run_on_s: "45",
    });

    const audit = await pool.query(
      [
        "select actor_type, actor_id, action, target_type, target_id, details",
        "  from audit_events where target_id = $1",
      ].join("\n"),
      [TAXI_A],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      actor_type: "admin",
      actor_id: ADMIN_ID,
      action: "control_config.taxi.update",
      target_type: "taxi",
      target_id: TAXI_A,
      details: {
        change_id: changeId,
        revision: 1,
        expected_revision: 0,
        next: {
          gps_mode: "aus",
          pause_max_duration_s: 1234,
          pause_end_on_vehicle_off: true,
          display_run_on_s: 45,
        },
      },
    });
  });

  it("veraltete Revision ergibt 409; GPS-Aktivierung und unbekannte Felder werden ohne Zustandsaenderung abgewiesen", async () => {
    await seedKnownTaxi(TAXI_A);
    await seedConfig(TAXI_A, COMPLETE);
    const before = await snapshot(TAXI_A);

    const app = await buildApp();
    const cookie = await loginCookie(app);
    const writeHeaders = headers("Admin", cookie, {
      "content-type": "application/json",
    });

    const stale = await app.inject({
      method: "PATCH",
      url: configUrl(TAXI_A),
      headers: writeHeaders,
      payload: {
        expected_revision: 0,
        gps_mode: "aus",
        pause_max_duration_s: 999,
        pause_end_on_vehicle_off: false,
        display_run_on_s: 10,
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(Object.keys(stale.json().error).sort()).toEqual([
      "code",
      "message",
      "request_id",
    ]);

    const gpsOn = await app.inject({
      method: "PATCH",
      url: configUrl(TAXI_A),
      headers: writeHeaders,
      payload: {
        expected_revision: 1,
        gps_mode: "an",
        pause_max_duration_s: 999,
        pause_end_on_vehicle_off: false,
        display_run_on_s: 10,
      },
    });
    expect(gpsOn.statusCode).toBe(400);
    expect(gpsOn.json().error.code).toBe("invalid_request");

    const unknownField = await app.inject({
      method: "PATCH",
      url: configUrl(TAXI_A),
      headers: writeHeaders,
      payload: {
        expected_revision: 1,
        gps_mode: "aus",
        pause_max_duration_s: 999,
        pause_end_on_vehicle_off: false,
        display_run_on_s: 10,
        gps_approval: { granted: true },
      },
    });
    expect(unknownField.statusCode).toBe(400);
    expect(unknownField.json().error.code).toBe("invalid_request");

    expect(await snapshot(TAXI_A)).toEqual(before);
  });

  it("anonym ergibt 401; Operator darf lesen, aber nicht aendern; Geraete-Bearer und fremder Origin erlauben keinen Schreibzugriff", async () => {
    await seedKnownTaxi(TAXI_A);
    await seedConfig(TAXI_A, COMPLETE);
    const before = await snapshot(TAXI_A);

    const app = await buildApp();
    const cookie = await loginCookie(app);

    const anonymous = await app.inject({
      method: "GET",
      url: configUrl(TAXI_A),
      headers: { host: HOST },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().error.code).toBe("unauthorized");

    const operatorRead = await app.inject({
      method: "GET",
      url: configUrl(TAXI_A),
      headers: headers("Operator", cookie),
    });
    expect(operatorRead.statusCode).toBe(200);
    expect(operatorRead.json()).toMatchObject({
      taxi_id: TAXI_A,
      revision: 1,
      gps_mode: "aus",
    });

    const operatorWrite = await app.inject({
      method: "PATCH",
      url: configUrl(TAXI_A),
      headers: headers("Operator", cookie, {
        "content-type": "application/json",
      }),
      payload: {
        expected_revision: 1,
        gps_mode: "aus",
        pause_max_duration_s: 999,
        pause_end_on_vehicle_off: false,
        display_run_on_s: 10,
      },
    });
    expect(operatorWrite.statusCode).toBe(403);
    expect(operatorWrite.json().error.code).toBe("forbidden");

    const deviceBearerWrite = await app.inject({
      method: "PATCH",
      url: configUrl(TAXI_A),
      headers: {
        host: HOST,
        "content-type": "application/json",
        authorization: "Bearer SYN-CX053-GERAETE-TOKEN",
      },
      payload: {
        expected_revision: 1,
        gps_mode: "aus",
        pause_max_duration_s: 999,
        pause_end_on_vehicle_off: false,
        display_run_on_s: 10,
      },
    });
    expect(deviceBearerWrite.statusCode).toBe(401);
    expect(deviceBearerWrite.json().error.code).toBe("unauthorized");

    const foreignOriginWrite = await app.inject({
      method: "PATCH",
      url: configUrl(TAXI_A),
      headers: headers("Admin", cookie, {
        "content-type": "application/json",
        origin: FOREIGN_ORIGIN,
      }),
      payload: {
        expected_revision: 1,
        gps_mode: "aus",
        pause_max_duration_s: 999,
        pause_end_on_vehicle_off: false,
        display_run_on_s: 10,
      },
    });
    expect(foreignOriginWrite.statusCode).toBe(403);
    expect(foreignOriginWrite.json().error.code).toBe("forbidden");

    expect(await snapshot(TAXI_A)).toEqual(before);
  });
});

