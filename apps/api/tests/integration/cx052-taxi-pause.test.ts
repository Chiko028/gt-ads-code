/**
 * CX-052 / R-501: Integrationsnachweis der geschuetzten taxiweiten
 * Pause-/Fortsetzen-Routen.
 *
 * Alle Faelle laufen ueber die echte Serverfabrik, echte Admin-Sitzungscookies
 * und eine echte PostgreSQL-Datenbank. Es gibt keine Repository-Mocks: Auftrag,
 * Zustellungen, Revision, Sollzustand und Audit werden nach jeder Anfrage in
 * PostgreSQL geprueft. Kennungen und Zeitpunkte sind synthetisch.
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
import { LEGACY_ADMIN_PRINCIPAL_ID } from "../../src/http/principal.js";
import { createServer } from "../../src/http/server.js";
import { ADMIN_SESSION_COOKIE } from "../../src/modules/adminAuth/middleware.js";
import { ensureTaxiActivationSchema } from "../../src/modules/taxiActivation/index.js";
import { REMOTE_CONTROL_AUDIT_ACTION } from "../../src/modules/remoteControl/index.js";

const BASE_TIME = Date.parse("2026-11-14T12:00:00.000Z");
const ADMIN_PASSWORD = "SYN-CX052-Pause-Passwort";
const HOST = "127.0.0.1:8080";
const JSON_HEADERS = { "content-type": "application/json" };
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/db/migrations",
);

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let config: AppConfig;
const openApps: FastifyInstance[] = [];

async function readMigration(name: string): Promise<string> {
  return readFile(join(MIGRATIONS_DIR, name), "utf8");
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
    throw new Error("CX-052 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx052_pause_" +
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
  await pool.query(await readMigration("0004_cx_012_remote_control.up.sql"));
  await ensureTaxiActivationSchema(pool);

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX052-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };
}, 60_000);

beforeEach(async () => {
  await pool.query(
    "truncate table audit_events, remote_control_deliveries," +
      " remote_control_commands, remote_control_taxi_state," +
      " device_taxi_assignments, taxis, devices, registration_codes," +
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

function adminHeaders(
  cookie: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    host: HOST,
    ...JSON_HEADERS,
    cookie: ADMIN_SESSION_COOKIE + "=" + cookie,
    ...extra,
  };
}

async function insertDevice(
  state: "active" | "revoked" = "active",
  lastSeenAt: number = BASE_TIME,
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
      Buffer.from("SYN-CX052-Code-" + registrationCodeId),
      "SYN-CX052",
      new Date(BASE_TIME),
      LEGACY_ADMIN_PRINCIPAL_ID,
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
      "SYN-CX052-Tablet",
      Buffer.from("SYN-CX052-Key-" + deviceId),
      "SYN-CX052-FP-" + deviceId,
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
      new Date(lastSeenAt),
    ],
  );
  return deviceId;
}

async function insertTaxi(taxiId: string): Promise<void> {
  await pool.query(
    [
      "insert into taxis (id, display_name, active, revision)",
      "values ($1, $2, false, 1)",
    ].join("\n"),
    [taxiId, "SYN " + taxiId],
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

async function validPair(taxiId: string): Promise<{ first: string; second: string }> {
  const first = await insertDevice();
  const second = await insertDevice();
  await assign(taxiId, first);
  await assign(taxiId, second);
  return { first, second };
}

function actionUrl(taxiId: string, action: "pause" | "resume"): string {
  return (
    "/v1/admin/taxis/" + encodeURIComponent(taxiId) + "/" + action
  );
}

function postAction(
  app: FastifyInstance,
  requestHeaders: Record<string, string>,
  taxiId: string,
  action: "pause" | "resume",
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; headers: Record<string, unknown>; json: () => any }> {
  return app.inject({
    method: "POST",
    url: actionUrl(taxiId, action),
    headers: requestHeaders,
    payload,
  });
}

interface Counts {
  commands: number;
  deliveries: number;
  pending: number;
  audit: number;
  state: number;
}

async function counts(): Promise<Counts> {
  const result = await pool.query<Counts>(
    [
      "select",
      "  (select count(*) from remote_control_commands)::int as commands,",
      "  (select count(*) from remote_control_deliveries)::int as deliveries,",
      "  (select count(*) from remote_control_deliveries where status = 'pending')::int as pending,",
      "  (select count(*) from audit_events where action = $1)::int as audit,",
      "  (select count(*) from remote_control_taxi_state)::int as state",
    ].join("\n"),
    [REMOTE_CONTROL_AUDIT_ACTION],
  );
  return result.rows[0]!;
}

interface StateRow {
  revision: number;
  desired_paused: boolean;
}

async function stateRow(taxiId: string): Promise<StateRow | undefined> {
  const result = await pool.query<StateRow>(
    "select revision::int as revision, desired_paused" +
      " from remote_control_taxi_state where taxi_id = $1",
    [taxiId],
  );
  return result.rows[0];
}

interface DeliveryRow {
  device_id: string;
  revision: number;
  status: string;
  acknowledged_at: Date | null;
}

async function deliveryRows(): Promise<DeliveryRow[]> {
  const result = await pool.query<DeliveryRow>(
    [
      "select device_id::text as device_id, revision::int as revision,",
      "       status, acknowledged_at",
      "  from remote_control_deliveries",
      " order by revision asc, device_id asc",
    ].join("\n"),
  );
  return result.rows;
}

interface AuditRow {
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
}

async function auditRows(): Promise<AuditRow[]> {
  const result = await pool.query<AuditRow>(
    [
      "select actor_type, actor_id, action, target_type, target_id, details",
      "  from audit_events where action = $1 order by id asc",
    ].join("\n"),
    [REMOTE_CONTROL_AUDIT_ACTION],
  );
  return result.rows;
}

async function snapshot(): Promise<string> {
  const result = await pool.query<Record<string, unknown>>(
    [
      "select",
      "  (select coalesce(json_agg(c order by c.revision), '[]'::json)",
      "     from (select command_id, taxi_id, revision, desired_paused, origin,",
      "                  actor_id, content_fingerprint from remote_control_commands) c) as commands,",
      "  (select coalesce(json_agg(d order by d.revision, d.device_id), '[]'::json)",
      "     from (select command_id, taxi_id, device_id, revision, status,",
      "                  acknowledged_at, superseded_at from remote_control_deliveries) d) as deliveries,",
      "  (select coalesce(json_agg(s order by s.taxi_id), '[]'::json)",
      "     from (select taxi_id, revision, desired_paused from remote_control_taxi_state) s) as state,",
      "  (select coalesce(json_agg(a order by a.id), '[]'::json)",
      "     from (select id, actor_type, actor_id, action, target_type,",
      "                  target_id, details from audit_events) a) as audit",
    ].join("\n"),
  );
  return JSON.stringify(result.rows[0]);
}

describe("CX-052 taxiweite Pause-/Fortsetzen-Routen", () => {
  it("setzt fuer beide zugeordneten Tablets genau einen Sollzustand, nimmt auch ein Offline-Tablet auf und laesst Quittierungen ausstehend", async () => {
    const taxiId = "SYN-CX052-TAXI-A";
    await insertTaxi(taxiId);
    const offline = await insertDevice("active", BASE_TIME - 7 * 86_400_000);
    const online = await insertDevice();
    await assign(taxiId, offline);
    await assign(taxiId, online);
    const expectedDevices = [offline, online].sort();

    const app = await buildApp();
    const cookie = await loginCookie(app);
    const headers = adminHeaders(cookie);

    const pausedCommand = randomUUID();
    const paused = await postAction(app, headers, taxiId, "pause", {
      command_id: pausedCommand,
      expected_revision: 0,
    });
    expect(paused.statusCode).toBe(202);
    const pausedBody = paused.json();
    expect(pausedBody).toMatchObject({
      status: "accepted",
      taxi_id: taxiId,
      command_id: pausedCommand,
      revision: 1,
      desired_paused: true,
      acknowledgements_pending: true,
      idempotent: false,
    });
    expect(pausedBody.target_device_ids).toEqual(expectedDevices);

    expect(await counts()).toEqual({
      commands: 1,
      deliveries: 2,
      pending: 2,
      audit: 1,
      state: 1,
    });
    expect(await stateRow(taxiId)).toEqual({
      revision: 1,
      desired_paused: true,
    });
    const firstDeliveries = await deliveryRows();
    expect(firstDeliveries.map((row) => row.device_id)).toEqual(expectedDevices);
    expect(
      firstDeliveries.every(
        (row) =>
          row.revision === 1 &&
          row.status === "pending" &&
          row.acknowledged_at === null,
      ),
    ).toBe(true);

    const requestId = String(paused.headers["x-request-id"]);
    expect(requestId.length).toBeGreaterThan(0);
    const firstAudit = await auditRows();
    expect(firstAudit).toHaveLength(1);
    expect(firstAudit[0]).toMatchObject({
      actor_type: "admin",
      actor_id: LEGACY_ADMIN_PRINCIPAL_ID,
      action: REMOTE_CONTROL_AUDIT_ACTION,
      target_type: "taxi",
      target_id: taxiId,
      details: {
        command_id: pausedCommand,
        revision: 1,
        expected_revision: 0,
        desired_paused: true,
        request_id: requestId,
        target_device_ids: expectedDevices,
      },
    });

    const resumedCommand = randomUUID();
    const resumed = await postAction(app, headers, taxiId, "resume", {
      command_id: resumedCommand,
      expected_revision: 1,
    });
    expect(resumed.statusCode).toBe(202);
    expect(resumed.json()).toMatchObject({
      status: "accepted",
      command_id: resumedCommand,
      revision: 2,
      desired_paused: false,
      acknowledgements_pending: true,
      target_device_ids: expectedDevices,
    });

    expect(await counts()).toEqual({
      commands: 2,
      deliveries: 4,
      pending: 2,
      audit: 2,
      state: 1,
    });
    expect(await stateRow(taxiId)).toEqual({
      revision: 2,
      desired_paused: false,
    });
    const allDeliveries = await deliveryRows();
    expect(
      allDeliveries
        .filter((row) => row.revision === 1)
        .every((row) => row.status === "superseded"),
    ).toBe(true);
    expect(
      allDeliveries
        .filter((row) => row.revision === 2)
        .every((row) => row.status === "pending"),
    ).toBe(true);
  });

  it("erzeugt bei parallelen identischen Wiederholungen genau eine Revision und einen Audit-Eintrag; abweichender Inhalt ergibt 409 ohne Mutation", async () => {
    const taxiId = "SYN-CX052-TAXI-B";
    await insertTaxi(taxiId);
    await validPair(taxiId);

    const app = await buildApp();
    const cookie = await loginCookie(app);
    const headers = adminHeaders(cookie);
    const commandId = randomUUID();
    const payload = { command_id: commandId, expected_revision: 0 };

    const [first, second] = await Promise.all([
      postAction(app, headers, taxiId, "pause", payload),
      postAction(app, headers, taxiId, "pause", payload),
    ]);

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(first.json()).toMatchObject({
      command_id: commandId,
      revision: 1,
      desired_paused: true,
    });
    expect(second.json()).toMatchObject({
      command_id: commandId,
      revision: 1,
      desired_paused: true,
    });
    expect([first.json().idempotent, second.json().idempotent].sort()).toEqual([
      false,
      true,
    ]);
    expect(await counts()).toEqual({
      commands: 1,
      deliveries: 2,
      pending: 2,
      audit: 1,
      state: 1,
    });

    const beforeConflict = await snapshot();
    const conflict = await postAction(app, headers, taxiId, "resume", {
      command_id: commandId,
      expected_revision: 1,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("invalid_request");
    expect(await snapshot()).toBe(beforeConflict);
    expect(await counts()).toEqual({
      commands: 1,
      deliveries: 2,
      pending: 2,
      audit: 1,
      state: 1,
    });
  });

  it("rollt bei einem Audit-Speicherfehler Auftrag und Sollzustand zurueck und weist eine veraltete Revision ohne Mutation ab", async () => {
    const taxiId = "SYN-CX052-TAXI-C";
    await insertTaxi(taxiId);
    await validPair(taxiId);

    const app = await buildApp();
    const cookie = await loginCookie(app);
    const headers = adminHeaders(cookie);

    await pool.query(
      "create or replace function syn_cx052_fail_audit() returns trigger" +
        " language plpgsql as $$ begin" +
        " raise exception 'SYN-CX052 Audit-Speicherfehler'; end $$",
    );
    await pool.query(
      "create trigger syn_cx052_fail_audit before insert on audit_events" +
        " for each row execute function syn_cx052_fail_audit()",
    );

    try {
      const failed = await postAction(app, headers, taxiId, "pause", {
        command_id: randomUUID(),
        expected_revision: 0,
      });
      expect(failed.statusCode).toBe(500);
      expect(failed.json().error.code).toBe("internal_error");
      expect(await counts()).toEqual({
        commands: 0,
        deliveries: 0,
        pending: 0,
        audit: 0,
        state: 0,
      });
      expect(await stateRow(taxiId)).toBeUndefined();
    } finally {
      await pool.query(
        "drop trigger if exists syn_cx052_fail_audit on audit_events",
      );
      await pool.query("drop function if exists syn_cx052_fail_audit()");
    }

    const acceptedCommand = randomUUID();
    const accepted = await postAction(app, headers, taxiId, "pause", {
      command_id: acceptedCommand,
      expected_revision: 0,
    });
    expect(accepted.statusCode).toBe(202);
    const beforeStale = await snapshot();

    const stale = await postAction(app, headers, taxiId, "pause", {
      command_id: randomUUID(),
      expected_revision: 0,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("invalid_request");
    expect(await snapshot()).toBe(beforeStale);
    expect(await counts()).toEqual({
      commands: 1,
      deliveries: 2,
      pending: 2,
      audit: 1,
      state: 1,
    });
  });

  it("lehnt fehlende Sitzung, Geraete-Bearer, fremden Origin und eine reine Tablet-ID als Taxiziel ab", async () => {
    const taxiId = "SYN-CX052-TAXI-D";
    await insertTaxi(taxiId);
    const pair = await validPair(taxiId);
    const app = await buildApp();
    const cookie = await loginCookie(app);
    const payload = { command_id: randomUUID(), expected_revision: 0 };

    const withoutSession = await postAction(
      app,
      { host: HOST, ...JSON_HEADERS },
      taxiId,
      "pause",
      payload,
    );
    expect(withoutSession.statusCode).toBe(401);
    expect(withoutSession.json().error.code).toBe("unauthorized");

    const deviceBearer = await postAction(
      app,
      {
        host: HOST,
        ...JSON_HEADERS,
        authorization: "Bearer SYN-CX052-Geraetetoken",
      },
      taxiId,
      "pause",
      payload,
    );
    expect(deviceBearer.statusCode).toBe(401);
    expect(deviceBearer.json().error.code).toBe("unauthorized");

    const foreignOrigin = await postAction(
      app,
      adminHeaders(cookie, { origin: "https://fremd.example" }),
      taxiId,
      "pause",
      payload,
    );
    expect(foreignOrigin.statusCode).toBe(403);
    expect(foreignOrigin.json().error.code).toBe("forbidden");

    const tabletAsTaxi = await postAction(
      app,
      adminHeaders(cookie),
      pair.first,
      "pause",
      payload,
    );
    expect(tabletAsTaxi.statusCode).toBe(404);
    expect(tabletAsTaxi.json().error.code).toBe("not_found");

    expect(await counts()).toEqual({
      commands: 0,
      deliveries: 0,
      pending: 0,
      audit: 0,
      state: 0,
    });
  });
});
