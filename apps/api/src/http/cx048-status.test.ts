/**
 * CX-048 / R-403: Statusabruf je Taxi und Tablet.
 *
 * Die Tests laufen gegen die echte Serverfabrik, eine echte
 * PostgreSQL-Datenbank und echte Admin-Sitzungscookies. Geprueft werden der
 * authentifizierte inject-Abruf, die getrennten Tablet-Eintraege, die reine
 * Anzeigeaggregation und die Trennung von technischer Erreichbarkeit und
 * Fachzustand.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS, type AppConfig } from "../config.js";
import { hashPassword } from "../crypto/password.js";
import { migrateUp } from "../db/migrate.js";
import type { Principal } from "./principal.js";
import { createServer } from "./server.js";
import { ADMIN_SESSION_COOKIE } from "../modules/adminAuth/middleware.js";
import { ensureTaxiActivationSchema } from "../modules/taxiActivation/index.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../db/migrations");

const BASE_TIME = Date.parse("2026-11-15T10:00:00.000Z");
const LOCAL_DATE = "2026-11-14";
const ADMIN_PASSWORD = "SYN-CX048-Status-Passwort";
const HOST = "127.0.0.1:8080";
const ADMIN_ID = "SYN-CX048-ADMIN";
const JSON_HEADERS = { "content-type": "application/json" };

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let config: AppConfig;
const openApps: FastifyInstance[] = [];

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

function baseConnection(): { host: string; port: number; user: string; database: string } {
  const host = process.env.PGHOST;
  const user = process.env.PGUSER;
  const database = process.env.PGDATABASE;
  if (host === undefined || user === undefined || database === undefined) {
    throw new Error("CX-048 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

/** Das Sitzungscookie bleibt echt; die Rolle kommt aus dem Testkopf. */
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
    return Promise.resolve({ id: "SYN-CX048-OPERATOR", role: "Operator" });
  }
  return Promise.resolve(null);
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx048_status_" +
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
  for (const name of [
    "0002_gt_ads_004_telemetry.up.sql",
    "0003_cx_011_telemetry_rollups.up.sql",
  ]) {
    await pool.query(await readFile(join(MIGRATIONS_DIR, name), "utf8"));
  }
  await ensureTaxiActivationSchema(pool);
  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX048-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };
}, 60_000);

afterAll(async () => {
  for (const app of openApps.splice(0)) {
    await app.close();
  }
  await pool.end();
  await maintenancePool.query("drop database if exists " + quoteIdentifier(databaseName));
  await maintenancePool.end();
}, 30_000);

beforeEach(async () => {
  await pool.query(
    "truncate table telemetry_daily_rollups, telemetry_observations," +
      " device_taxi_assignments, taxis, admin_sessions," +
      " devices, registration_codes restart identity cascade",
  );
});

afterEach(async () => {
  for (const app of openApps.splice(0)) {
    await app.close();
  }
});

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
    remoteAddress: "192.0.2.240",
  });
  expect(response.statusCode).toBe(204);
  const raw = response.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  expect(first, "Set-Cookie fehlt").toBeTruthy();
  return (first as string).split(";")[0]!.slice(ADMIN_SESSION_COOKIE.length + 1);
}

function headers(cookie: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    host: HOST,
    ...JSON_HEADERS,
    ...extra,
    "x-test-role": "Admin",
    cookie: ADMIN_SESSION_COOKIE + "=" + cookie,
  };
}

async function insertDevice(label: string, lastSeenAt: Date): Promise<string> {
  const registrationCodeId = randomUUID();
  const deviceId = randomUUID();
  await pool.query(
    "insert into registration_codes (id, code_hash, label, created_at, created_by, expires_at)" +
      " values ($1::uuid, $2, $3, $4, $5, $6)",
    [
      registrationCodeId,
      Buffer.from("SYN-CX048-Code-" + registrationCodeId),
      "SYN-CX048",
      new Date(BASE_TIME - 86_400_000),
      ADMIN_ID,
      new Date(BASE_TIME + 86_400_000),
    ],
  );
  await pool.query(
    "insert into devices (id, label, public_key_spki, public_key_fingerprint, state," +
      " manufacturer, model, os_version, sdk_int, app_version, app_flavor," +
      " registration_code_id, registration_request_id, registered_at, last_seen_at)" +
      " values ($1::uuid, $2, $3, $4, 'active', 'SYN', 'SYN', '15', 35, '1.0.0', 'dev'," +
      " $5::uuid, $6::uuid, $7, $8)",
    [
      deviceId,
      label,
      Buffer.from("SYN-CX048-Key-" + deviceId),
      "SYN-CX048-FP-" + deviceId,
      registrationCodeId,
      randomUUID(),
      new Date(BASE_TIME - 86_400_000),
      lastSeenAt,
    ],
  );
  return deviceId;
}

async function insertTaxi(taxiId: string): Promise<void> {
  await pool.query(
    "insert into taxis (id, display_name, active, revision) values ($1, $2, false, 1)",
    [taxiId, "Taxi " + taxiId],
  );
}

async function assign(deviceId: string, taxiId: string): Promise<void> {
  await pool.query(
    "insert into device_taxi_assignments (device_id, taxi_id, active, updated_at)" +
      " values ($1::uuid, $2, true, $3)",
    [deviceId, taxiId, new Date(BASE_TIME)],
  );
}

async function insertObservation(
  deviceId: string,
  paused: boolean,
  technicalFault: boolean,
): Promise<void> {
  await pool.query(
    "insert into telemetry_observations (device_id, event_id, occurred_at," +
      " vehicle_ready, paused, playback, technical_fault, received_at)" +
      " values ($1::uuid, $2::uuid, $3, true, $4, 'playing', $5, $3)",
    [
      deviceId,
      randomUUID(),
      new Date("2026-11-14T10:00:00.000Z"),
      paused,
      technicalFault,
    ],
  );
}

async function insertRollup(deviceId: string, className: string): Promise<void> {
  const classes = {
    healthy: 0,
    vehicle_off_expected: 0,
    paused_conscious: 0,
    technical_fault: 0,
    unknown: 0,
    [className]: 86_400_000,
  };
  await pool.query(
    "insert into telemetry_daily_rollups (device_id, local_date, time_zone," +
      " policy_version, algorithm_version, revision, evaluation_time," +
      " day_start, day_end, day_length_ms, classes, coverage," +
      " expected_playback_ms, expected_playback_reason, policy_canonical," +
      " input_fingerprint, created_at, updated_at)" +
      " values ($1::uuid, $2::date, $3, 'syn-v1', 'syn-alg-v1', 1, $4," +
      " $5, $6, 86400000, $7::jsonb, '{}'::jsonb, null, null, '{}'::jsonb," +
      " 'syn-fingerprint', $4, $4)",
    [
      deviceId,
      LOCAL_DATE,
      "Europe/Vienna",
      new Date("2026-11-14T23:00:00.000Z"),
      new Date("2026-11-13T23:00:00.000Z"),
      new Date("2026-11-14T23:00:00.000Z"),
      JSON.stringify(classes),
    ],
  );
}

type StatusBody = {
  date: string;
  time_zone: string;
  taxi_id: string | null;
  taxis: Array<{
    taxi_id: string;
    status: string;
    tablets: Array<{
      device_id: string;
      last_seen_at: string | null;
      connectivity: string | null;
      reported_state: { paused: boolean | null } | null;
      day_classification: { key: string; evaluation_time: string } | null;
    }>;
  }>;
};

describe("CX-048 Statusabruf", () => {
  it("verweigert ohne Sitzung 401 und liefert zwei getrennte Tablet-Eintraege", async () => {
    const deviceA = await insertDevice("Tablet A", new Date(BASE_TIME));
    const deviceB = await insertDevice(
      "Tablet B",
      new Date(BASE_TIME - 2 * 3_600_000),
    );
    await insertTaxi("SYN-TAXI-A");
    await assign(deviceA, "SYN-TAXI-A");
    await assign(deviceB, "SYN-TAXI-A");
    await insertRollup(deviceA, "healthy");
    await insertRollup(deviceB, "healthy");

    const app = await buildApp();
    const cookie = await loginCookie(app);

    const unauthorized = await app.inject({
      method: "GET",
      url: "/v1/admin/status?date=" + LOCAL_DATE,
      headers: { host: HOST },
    });
    expect(unauthorized.statusCode).toBe(401);

    const invalidDate = await app.inject({
      method: "GET",
      url: "/v1/admin/status?date=2026-02-30",
      headers: headers(cookie),
    });
    expect(invalidDate.statusCode).toBe(400);

    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/status?date=" + LOCAL_DATE + "&taxi_id=SYN-TAXI-A",
      headers: headers(cookie),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as StatusBody;
    expect(body.date).toBe(LOCAL_DATE);
    expect(body.time_zone).toBe("Europe/Vienna");
    expect(body.taxis).toHaveLength(1);

    const taxi = body.taxis[0]!;
    expect(taxi.tablets).toHaveLength(2);
    const byDevice = new Map(taxi.tablets.map((tablet) => [tablet.device_id, tablet]));
    expect(byDevice.get(deviceA)!.connectivity).toBe("reachable");
    expect(byDevice.get(deviceB)!.connectivity).toBe("last_seen");
    expect(byDevice.get(deviceA)!.last_seen_at).not.toBeNull();
    expect(byDevice.get(deviceB)!.last_seen_at).not.toBeNull();
    expect(taxi.status).toBe("healthy");
  });

  it("aggregiert gemischt, unvollstaendig und unbekannt; Offline ist kein technischer Fehler", async () => {
    const pausedTablet = await insertDevice(
      "Tablet pausiert",
      new Date(BASE_TIME - 3 * 3_600_000),
    );
    const unknownTablet = await insertDevice("Tablet unbekannt", new Date(BASE_TIME));
    const incompleteTablet = await insertDevice("Tablet Einzel", new Date(BASE_TIME));
    const missingOne = await insertDevice("Tablet ohne Auswertung 1", new Date(BASE_TIME));
    const missingTwo = await insertDevice("Tablet ohne Auswertung 2", new Date(BASE_TIME));

    await insertTaxi("SYN-TAXI-B");
    await assign(pausedTablet, "SYN-TAXI-B");
    await assign(unknownTablet, "SYN-TAXI-B");
    await insertRollup(pausedTablet, "paused_conscious");
    await insertRollup(unknownTablet, "unknown");
    // Offline allein: gemeldeter Zustand pausiert, kein technischer Fehler.
    await insertObservation(pausedTablet, true, false);

    await insertTaxi("SYN-TAXI-C");
    await assign(incompleteTablet, "SYN-TAXI-C");
    await insertRollup(incompleteTablet, "healthy");

    await insertTaxi("SYN-TAXI-D");
    await assign(missingOne, "SYN-TAXI-D");
    await assign(missingTwo, "SYN-TAXI-D");

    const app = await buildApp();
    const cookie = await loginCookie(app);

    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/status",
      headers: headers(cookie),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as StatusBody;
    // Ohne Tagesangabe gilt der letzte abgeschlossene Tag (Europe/Vienna).
    expect(body.date).toBe(LOCAL_DATE);

    const byTaxi = new Map(body.taxis.map((taxi) => [taxi.taxi_id, taxi]));
    expect(byTaxi.get("SYN-TAXI-B")!.status).toBe("mixed");
    expect(byTaxi.get("SYN-TAXI-C")!.status).toBe("incomplete");
    expect(byTaxi.get("SYN-TAXI-D")!.status).toBe("unknown");

    const pausedEntry = byTaxi
      .get("SYN-TAXI-B")!
      .tablets.find((tablet) => tablet.device_id === pausedTablet)!;
    expect(pausedEntry.connectivity).toBe("last_seen");
    expect(pausedEntry.day_classification!.key).toBe("paused_conscious");
    expect(pausedEntry.reported_state!.paused).toBe(true);
    expect(pausedEntry.day_classification!.evaluation_time).toBe(
      "2026-11-14T23:00:00.000Z",
    );
    expect(
      byTaxi.get("SYN-TAXI-B")!.tablets.some(
        (tablet) =>
          tablet.day_classification?.key === "technical_fault" ||
          tablet.day_classification?.key === "vehicle_off_expected",
      ),
    ).toBe(false);

    expect(byTaxi.get("SYN-TAXI-D")!.tablets).toHaveLength(2);
    for (const tablet of byTaxi.get("SYN-TAXI-D")!.tablets) {
      expect(tablet.day_classification).toBeNull();
    }
  });
});

