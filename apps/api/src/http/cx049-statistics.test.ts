/**
 * CX-049 / R-404: lesende Wiedergabe-Statistik.
 *
 * Vier Integrationstests gegen die echte Serverfabrik, eine echte
 * PostgreSQL-17-Datenbank und echte Admin-Sitzungscookies. Alle Daten sind
 * synthetisch. Geprueft werden vollstaendige/abgebrochene Plays, getrennte
 * Tablets, Grenzfilter, historische Taxi-Zuordnung, verspaetete Ereignisse,
 * korrigierte Tagesrollups, Retention-Luecken, Authentifizierung, ungueltige
 * Filter und die getrennten Qualitaetsfelder.
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
import { ensureCampaignSchema } from "../modules/campaigns/index.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../db/migrations");

const DAY_START = "2026-11-14T00:00:00.000Z";
const DAY_END = "2026-11-15T00:00:00.000Z";
const BASE_TIME = Date.parse("2026-11-14T12:00:00.000Z");
const ADMIN_PASSWORD = "SYN-CX049-Statistik-Passwort";
const HOST = "127.0.0.1:8080";
const ADMIN_ID = "SYN-CX049-ADMIN";
const JSON_HEADERS = { "content-type": "application/json" };
const STATISTICS_URL = "/v1/admin/statistics";

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
    throw new Error("CX-049 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

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
    return Promise.resolve({ id: "SYN-CX049-OPERATOR", role: "Operator" });
  }
  return Promise.resolve(null);
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx049_statistics_" +
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
    "0006_cx_028_technical_alarms.up.sql",
    "0009_campaign_customers.up.sql",
  ]) {
    await pool.query(await readFile(join(MIGRATIONS_DIR, name), "utf8"));
  }
  await ensureTaxiActivationSchema(pool);
  await ensureCampaignSchema(pool);
  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX049-Pepper",
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
    "truncate table technical_alarm_episodes, telemetry_daily_rollups," +
      " telemetry_observations, device_taxi_assignments, campaign_targets," +
      " campaigns, customers, taxis, admin_sessions, devices," +
      " registration_codes restart identity cascade",
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
    remoteAddress: "192.0.2.249",
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

async function insertDevice(label: string): Promise<string> {
  const registrationCodeId = randomUUID();
  const deviceId = randomUUID();
  await pool.query(
    "insert into registration_codes (id, code_hash, label, created_at, created_by, expires_at)" +
      " values ($1::uuid, $2, $3, $4, $5, $6)",
    [
      registrationCodeId,
      Buffer.from("SYN-CX049-Code-" + registrationCodeId),
      "SYN-CX049",
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
      Buffer.from("SYN-CX049-Key-" + deviceId),
      "SYN-CX049-FP-" + deviceId,
      registrationCodeId,
      randomUUID(),
      new Date(BASE_TIME - 86_400_000),
      new Date(BASE_TIME),
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

async function insertAssignment(
  deviceId: string,
  taxiId: string,
  active: boolean,
  updatedAt: string,
): Promise<void> {
  await pool.query(
    "insert into device_taxi_assignments (device_id, taxi_id, active, updated_at)" +
      " values ($1::uuid, $2, $3, $4::timestamptz)",
    [deviceId, taxiId, active, updatedAt],
  );
}

async function insertCustomerAndCampaign(
  campaignId: string,
  taxiId: string,
  startAt: string,
  endAt: string,
): Promise<void> {
  const customerId = randomUUID();
  await pool.query(
    "insert into customers (id, display_name, revision) values ($1::uuid, $2, 1)",
    [customerId, "SYN-CX049-Kunde"],
  );
  await pool.query(
    "insert into campaigns (id, customer_id, media_id, owner_id, rule_type, status," +
      " archived, start_at, end_at, revision)" +
      " values ($1::uuid, $2::uuid, $3::uuid, $4, 'fixed_slot', 'active', false," +
      " $5::timestamptz, $6::timestamptz, 1)",
    [campaignId, customerId, randomUUID(), ADMIN_ID, startAt, endAt],
  );
  await pool.query(
    "insert into campaign_targets (campaign_id, kind, target_id) values ($1::uuid, 'taxi', $2)",
    [campaignId, taxiId],
  );
}

async function insertObservation(input: {
  deviceId: string;
  eventId?: string;
  occurredAt: string;
  playback: "playing" | "stopped" | "unknown";
  receivedAt?: string;
  paused?: boolean | null;
  vehicleReady?: boolean | null;
  technicalFault?: boolean | null;
  onConflict?: boolean;
}): Promise<string> {
  const eventId = input.eventId ?? randomUUID();
  await pool.query(
    "insert into telemetry_observations (device_id, event_id, occurred_at," +
      " vehicle_ready, paused, playback, technical_fault, received_at)" +
      " values ($1::uuid, $2::uuid, $3::timestamptz, $4, $5, $6, $7, $8::timestamptz)" +
      (input.onConflict === true ? " on conflict (device_id, event_id) do nothing" : ""),
    [
      input.deviceId,
      eventId,
      input.occurredAt,
      input.vehicleReady ?? true,
      input.paused ?? false,
      input.playback,
      input.technicalFault ?? false,
      input.receivedAt ?? input.occurredAt,
    ],
  );
  return eventId;
}

async function insertRollup(input: {
  deviceId: string;
  localDate: string;
  dayStart: string;
  dayEnd: string;
  revision: number;
  evaluationTime: string;
  technicalFaultMs: number;
  coveredMs: number;
  ratio?: number;
}): Promise<void> {
  const classes = {
    healthy: Math.max(0, input.coveredMs - input.technicalFaultMs),
    vehicle_off_expected: 0,
    paused_conscious: 0,
    technical_fault: input.technicalFaultMs,
    unknown: 0,
  };
  const coverage = {
    coveredMs: input.coveredMs,
    conflictedMs: 0,
    dayLengthMs: Date.parse(input.dayEnd) - Date.parse(input.dayStart),
    ratio: input.ratio ?? (input.coveredMs > 0 ? 1 : 0),
  };
  await pool.query(
    "insert into telemetry_daily_rollups (device_id, local_date, time_zone," +
      " policy_version, algorithm_version, revision, evaluation_time," +
      " day_start, day_end, day_length_ms, classes, coverage," +
      " expected_playback_ms, expected_playback_reason, policy_canonical," +
      " input_fingerprint, created_at, updated_at)" +
      " values ($1::uuid, $2::date, 'UTC', 'syn-v1', 'syn-alg-v1', $3, $4::timestamptz," +
      " $5::timestamptz, $6::timestamptz, $7, $8::jsonb, $9::jsonb," +
      " null, null, '{}'::jsonb, $10, $4::timestamptz, $4::timestamptz)",
    [
      input.deviceId,
      input.localDate,
      input.revision,
      input.evaluationTime,
      input.dayStart,
      input.dayEnd,
      Date.parse(input.dayEnd) - Date.parse(input.dayStart),
      JSON.stringify(classes),
      JSON.stringify(coverage),
      "syn-fingerprint-" + input.revision,
    ],
  );
}

async function insertSyncEpisode(
  resourceId: string,
  faultStartedAt: string,
): Promise<void> {
  await pool.query(
    "insert into technical_alarm_episodes (resource_id, status, error_code," +
      " fault_started_at, detected_at, opened_evaluation_id," +
      " opened_evaluation_version)" +
      " values ($1, 'open', 'sync_failed', $2::timestamptz, $2::timestamptz," +
      " 'syn-eval', 1)",
    [resourceId, faultStartedAt],
  );
}

function statisticsUrl(params: Record<string, string>): string {
  const search = new URLSearchParams(params);
  return STATISTICS_URL + "?" + search.toString();
}

type StatisticsBody = {
  from: string;
  to: string;
  row_count: number;
  quality_scope: string;
  filters: { campaign_id: string | null; device_id: string | null; taxi_id: string | null };
  definition: { interval: string; excludes: string[] };
  completeness: {
    status: string;
    reasons: string[];
    data_as_of: string;
    missing_days: Array<{ day: string; reason: string }>;
  };
  plays: Array<{
    campaign_id: string | null;
    device_id: string;
    taxi_id: string | null;
    play_count: number;
    first_played_at: string;
    last_played_at: string;
  }>;
  device_quality: Array<{
    device_id: string;
    taxi_id: string | null;
    availability_ratio: number | null;
    availability_reason: string | null;
    observed_ms: number | null;
    technical_fault_ms: number | null;
    sync_errors: number;
    sync_error_scope: string;
  }>;
};

describe("CX-049 Wiedergabe-Statistik", () => {
  it("zaehlt nur vollstaendige Plays, ignoriert Start/Abbruch und wiederholte Ereignisse; zwei Tablets bleiben getrennt", async () => {
    const taxiId = "SYN-CX049-TAXI-A";
    const campaignId = randomUUID();
    await insertTaxi(taxiId);
    await insertCustomerAndCampaign(campaignId, taxiId, DAY_START, DAY_END);
    const deviceA = await insertDevice("Tablet A");
    const deviceB = await insertDevice("Tablet B");
    await insertAssignment(deviceA, taxiId, true, "2026-11-13T00:00:00.000Z");
    await insertAssignment(deviceB, taxiId, true, "2026-11-13T00:00:00.000Z");

    const stoppedA1 = randomUUID();
    await insertObservation({ deviceId: deviceA, occurredAt: "2026-11-14T10:00:00.000Z", playback: "playing" });
    await insertObservation({
      deviceId: deviceA,
      eventId: stoppedA1,
      occurredAt: "2026-11-14T10:00:15.000Z",
      playback: "stopped",
    });
    // Identische Wiederholung derselben fachlichen Ereignis-ID.
    await insertObservation({
      deviceId: deviceA,
      eventId: stoppedA1,
      occurredAt: "2026-11-14T10:00:15.000Z",
      playback: "stopped",
      onConflict: true,
    });
    await insertObservation({ deviceId: deviceA, occurredAt: "2026-11-14T11:00:00.000Z", playback: "playing" });
    await insertObservation({ deviceId: deviceA, occurredAt: "2026-11-14T11:00:15.000Z", playback: "stopped" });
    // Abbruch und reiner Start zaehlen nicht.
    await insertObservation({ deviceId: deviceA, occurredAt: "2026-11-14T12:00:00.000Z", playback: "playing" });
    await insertObservation({ deviceId: deviceA, occurredAt: "2026-11-14T12:00:10.000Z", playback: "unknown" });
    await insertObservation({ deviceId: deviceA, occurredAt: "2026-11-14T13:00:00.000Z", playback: "playing" });

    await insertObservation({ deviceId: deviceB, occurredAt: "2026-11-14T10:00:00.000Z", playback: "playing" });
    await insertObservation({ deviceId: deviceB, occurredAt: "2026-11-14T10:00:15.000Z", playback: "stopped" });

    const app = await buildApp();
    const cookie = await loginCookie(app);
    const response = await app.inject({
      method: "GET",
      url: statisticsUrl({ from: DAY_START, to: DAY_END }),
      headers: headers(cookie),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as StatisticsBody;
    expect(body.row_count).toBe(4);
    expect(body.plays).toHaveLength(2);

    const byDevice = new Map(body.plays.map((row) => [row.device_id, row]));
    expect(byDevice.get(deviceA)!.play_count).toBe(2);
    expect(byDevice.get(deviceB)!.play_count).toBe(1);
    for (const row of body.plays) {
      expect(row.campaign_id).toBe(campaignId);
      expect(row.taxi_id).toBe(taxiId);
    }
    expect(body.definition.interval).toBe("[from,to)");
    expect(body.definition.excludes).toContain("Abbrueche und unknown-Zustaende");
  });

  it("filtert Kampagne, Geraet, Taxi und Zeit exakt auf den Grenzen des halb offenen Intervalls", async () => {
    const taxiOne = "SYN-CX049-TAXI-1";
    const taxiTwo = "SYN-CX049-TAXI-2";
    const campaignOne = randomUUID();
    const campaignTwo = randomUUID();
    await insertTaxi(taxiOne);
    await insertTaxi(taxiTwo);
    await insertCustomerAndCampaign(campaignOne, taxiOne, "2026-11-13T00:00:00.000Z", DAY_END);
    await insertCustomerAndCampaign(campaignTwo, taxiTwo, "2026-11-13T00:00:00.000Z", DAY_END);
    const deviceA = await insertDevice("Tablet A");
    const deviceB = await insertDevice("Tablet B");
    await insertAssignment(deviceA, taxiOne, true, "2026-11-13T00:00:00.000Z");
    await insertAssignment(deviceB, taxiTwo, true, "2026-11-13T00:00:00.000Z");

    // Ende exakt auf from: zaehlt.
    await insertObservation({ deviceId: deviceA, occurredAt: "2026-11-13T23:59:20.000Z", playback: "playing" });
    await insertObservation({ deviceId: deviceA, occurredAt: DAY_START, playback: "stopped" });
    // Ende eine Millisekunde vor from: zaehlt nicht.
    await insertObservation({ deviceId: deviceA, occurredAt: "2026-11-13T23:59:00.000Z", playback: "playing" });
    await insertObservation({ deviceId: deviceA, occurredAt: "2026-11-13T23:59:15.000Z", playback: "stopped" });
    // Ende exakt auf to: zaehlt nicht (halb offen).
    await insertObservation({ deviceId: deviceA, occurredAt: "2026-11-14T23:59:20.000Z", playback: "playing" });
    await insertObservation({ deviceId: deviceA, occurredAt: DAY_END, playback: "stopped" });
    // Letzte Millisekunde im Intervall: zaehlt.
    await insertObservation({ deviceId: deviceA, occurredAt: "2026-11-14T23:59:00.000Z", playback: "playing" });
    await insertObservation({ deviceId: deviceA, occurredAt: "2026-11-14T23:59:15.000Z", playback: "stopped" });
    // Zweites Tablet, andere Kampagne/Taxi.
    await insertObservation({ deviceId: deviceB, occurredAt: "2026-11-14T12:00:00.000Z", playback: "playing" });
    await insertObservation({ deviceId: deviceB, occurredAt: "2026-11-14T12:00:15.000Z", playback: "stopped" });

    const app = await buildApp();
    const cookie = await loginCookie(app);

    const byCampaign = await app.inject({
      method: "GET",
      url: statisticsUrl({ from: DAY_START, to: DAY_END, campaign_id: campaignOne }),
      headers: headers(cookie),
    });
    expect(byCampaign.statusCode).toBe(200);
    const campaignBody = byCampaign.json() as StatisticsBody;
    expect(campaignBody.plays).toHaveLength(1);
    expect(campaignBody.plays[0]!.device_id).toBe(deviceA);
    expect(campaignBody.plays[0]!.play_count).toBe(2);

    const byDevice = await app.inject({
      method: "GET",
      url: statisticsUrl({ from: DAY_START, to: DAY_END, device_id: deviceB }),
      headers: headers(cookie),
    });
    expect(byDevice.statusCode).toBe(200);
    expect((byDevice.json() as StatisticsBody).plays).toEqual([
      expect.objectContaining({ device_id: deviceB, play_count: 1, campaign_id: campaignTwo }),
    ]);

    const byTaxi = await app.inject({
      method: "GET",
      url: statisticsUrl({ from: DAY_START, to: DAY_END, taxi_id: taxiOne }),
      headers: headers(cookie),
    });
    expect(byTaxi.statusCode).toBe(200);
    expect((byTaxi.json() as StatisticsBody).plays).toHaveLength(1);
    expect((byTaxi.json() as StatisticsBody).plays[0]!.play_count).toBe(2);

    const byTime = await app.inject({
      method: "GET",
      url: statisticsUrl({
        from: "2026-11-14T23:00:00.000Z",
        to: DAY_END,
      }),
      headers: headers(cookie),
    });
    expect(byTime.statusCode).toBe(200);
    const timeBody = byTime.json() as StatisticsBody;
    expect(timeBody.plays).toHaveLength(1);
    expect(timeBody.plays[0]!.device_id).toBe(deviceA);
    expect(timeBody.plays[0]!.play_count).toBe(1);
  });

  it("verschiebt historische Wiedergaben bei spaeterer Umzuordnung nicht und zaehlt verspaetete Ereignisse sowie korrigierte Rollups ohne Doppelzaehlung", async () => {
    const taxiOld = "SYN-CX049-TAXI-ALT";
    const taxiNew = "SYN-CX049-TAXI-NEU";
    const campaignOld = randomUUID();
    const campaignNew = randomUUID();
    await insertTaxi(taxiOld);
    await insertTaxi(taxiNew);
    await insertCustomerAndCampaign(campaignOld, taxiOld, DAY_START, "2026-11-14T12:00:00.000Z");
    await insertCustomerAndCampaign(campaignNew, taxiNew, "2026-11-14T12:00:00.000Z", DAY_END);
    const device = await insertDevice("Tablet Wechsel");
    await insertAssignment(device, taxiOld, false, "2026-11-14T12:00:00.000Z");
    await insertAssignment(device, taxiNew, true, "2026-11-14T12:00:00.000Z");

    await insertObservation({ deviceId: device, occurredAt: "2026-11-14T10:00:00.000Z", playback: "playing" });
    await insertObservation({ deviceId: device, occurredAt: "2026-11-14T10:00:15.000Z", playback: "stopped" });
    await insertObservation({ deviceId: device, occurredAt: "2026-11-14T13:00:00.000Z", playback: "playing" });
    await insertObservation({ deviceId: device, occurredAt: "2026-11-14T13:00:15.000Z", playback: "stopped" });

    // Korrigierte Tagesrollups: nur die juengste Revision zaehlt.
    await insertRollup({
      deviceId: device,
      localDate: "2026-11-14",
      dayStart: DAY_START,
      dayEnd: DAY_END,
      revision: 1,
      evaluationTime: "2026-11-14T12:00:00.000Z",
      technicalFaultMs: 3_600_000,
      coveredMs: 86_400_000,
    });
    // Korrektur derselben Zeile: Revision 2 ersetzt Revision 1, es entsteht
    // keine zweite Zeile und damit keine Doppelzaehlung.
    await pool.query(
      "update telemetry_daily_rollups" +
        "   set revision = 2, evaluation_time = $2::timestamptz," +
        "       classes = $3::jsonb, coverage = $4::jsonb, updated_at = $2::timestamptz" +
        " where device_id = $1::uuid and local_date = '2026-11-14'::date",
      [
        device,
        "2026-11-14T13:00:00.000Z",
        JSON.stringify({
          healthy: 86_400_000,
          vehicle_off_expected: 0,
          paused_conscious: 0,
          technical_fault: 0,
          unknown: 0,
        }),
        JSON.stringify({
          coveredMs: 86_400_000,
          conflictedMs: 0,
          dayLengthMs: 86_400_000,
          ratio: 1,
        }),
      ],
    );

    const app = await buildApp();
    const cookie = await loginCookie(app);
    const first = await app.inject({
      method: "GET",
      url: statisticsUrl({ from: DAY_START, to: DAY_END }),
      headers: headers(cookie),
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as StatisticsBody;
    expect(firstBody.plays).toHaveLength(2);
    const oldRow = firstBody.plays.find((row) => row.taxi_id === taxiOld)!;
    const newRow = firstBody.plays.find((row) => row.taxi_id === taxiNew)!;
    expect(oldRow).toMatchObject({ campaign_id: campaignOld, play_count: 1 });
    expect(newRow).toMatchObject({ campaign_id: campaignNew, play_count: 1 });
    expect(firstBody.device_quality[0]!.availability_ratio).toBe(1);
    expect(firstBody.device_quality[0]!.observed_ms).toBe(86_400_000);
    expect(firstBody.device_quality[0]!.technical_fault_ms).toBe(0);

    // Verspaetetes Ereignis: occurred_at im Zeitraum, received_at spaeter.
    await insertObservation({
      deviceId: device,
      occurredAt: "2026-11-14T11:00:00.000Z",
      playback: "playing",
      receivedAt: "2026-11-18T08:00:00.000Z",
    });
    await insertObservation({
      deviceId: device,
      occurredAt: "2026-11-14T11:00:15.000Z",
      playback: "stopped",
      receivedAt: "2026-11-18T08:00:00.000Z",
    });

    const second = await app.inject({
      method: "GET",
      url: statisticsUrl({ from: DAY_START, to: DAY_END }),
      headers: headers(cookie),
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as StatisticsBody;
    const oldAfterLate = secondBody.plays.find((row) => row.taxi_id === taxiOld)!;
    expect(oldAfterLate.play_count).toBe(2);
    expect(secondBody.plays.find((row) => row.taxi_id === taxiNew)!.play_count).toBe(1);
    expect(secondBody.device_quality[0]!.availability_ratio).toBe(1);
    expect(secondBody.device_quality[0]!.observed_ms).toBe(86_400_000);
    expect(secondBody.completeness.data_as_of).toBe("2026-11-18T08:00:00.000Z");
  });

  it("prueft Authentifizierung, ungueltige Filter und getrennte Qualitaetsfelder ohne Vervielfachung je Kampagne", async () => {
    const taxiId = "SYN-CX049-TAXI-Q";
    const campaignOne = randomUUID();
    const campaignTwo = randomUUID();
    await insertTaxi(taxiId);
    // Zwei gleichzeitig aktive Kampagnen auf demselben Taxi: Attribution ist
    // absichtlich nicht eindeutig, die Geraeteverfuegbarkeit bleibt getrennt.
    await insertCustomerAndCampaign(campaignOne, taxiId, DAY_START, DAY_END);
    await insertCustomerAndCampaign(campaignTwo, taxiId, DAY_START, DAY_END);
    const device = await insertDevice("Tablet Qualitaet");
    await insertAssignment(device, taxiId, true, "2026-11-13T00:00:00.000Z");
    await insertObservation({ deviceId: device, occurredAt: "2026-11-14T10:00:00.000Z", playback: "playing" });
    await insertObservation({ deviceId: device, occurredAt: "2026-11-14T10:00:15.000Z", playback: "stopped" });
    await insertRollup({
      deviceId: device,
      localDate: "2026-11-14",
      dayStart: DAY_START,
      dayEnd: DAY_END,
      revision: 1,
      evaluationTime: "2026-11-14T12:00:00.000Z",
      technicalFaultMs: 0,
      coveredMs: 0,
      ratio: 0,
    });
    await insertSyncEpisode(device, "2026-11-14T10:30:00.000Z");

    const app = await buildApp();
    const unauthorized = await app.inject({
      method: "GET",
      url: statisticsUrl({ from: DAY_START, to: DAY_END }),
      headers: { host: HOST },
    });
    expect(unauthorized.statusCode).toBe(401);

    const cookie = await loginCookie(app);
    for (const invalid of [
      statisticsUrl({ to: DAY_END }),
      statisticsUrl({ from: "2026-11-14", to: DAY_END }),
      statisticsUrl({ from: "2026-11-14T00:00:00", to: DAY_END }),
      statisticsUrl({ from: DAY_END, to: DAY_START }),
      statisticsUrl({ from: "2026-10-01T00:00:00.000Z", to: "2026-11-15T00:00:00.000Z" }),
      statisticsUrl({ from: DAY_START, to: DAY_END, campaign_id: "keine-uuid" }),
      statisticsUrl({ from: DAY_START, to: DAY_END, unbekannt: "1" }),
      STATISTICS_URL + "?from=" + encodeURIComponent(DAY_START) +
        "&to=" + encodeURIComponent(DAY_END) +
        "&from=" + encodeURIComponent(DAY_START),
    ]) {
      const response = await app.inject({
        method: "GET",
        url: invalid,
        headers: headers(cookie),
      });
      expect(response.statusCode, invalid).toBe(400);
    }

    const response = await app.inject({
      method: "GET",
      url: statisticsUrl({ from: DAY_START, to: DAY_END, campaign_id: campaignOne }),
      headers: headers(cookie),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as StatisticsBody;
    expect(body.quality_scope).toBe("device_taxi_time");
    // Kampagnenfilter macht die Play-Attribution leer, nicht die Qualitaet.
    expect(body.plays).toHaveLength(0);
    expect(body.device_quality).toHaveLength(1);
    const quality = body.device_quality[0]!;
    expect(quality.device_id).toBe(device);
    expect(quality.taxi_id).toBe(taxiId);
    expect(quality.availability_ratio).toBeNull();
    expect(quality.availability_reason).toBe("no_reliable_denominator");
    expect(quality.observed_ms).toBe(0);
    expect(quality.sync_errors).toBe(1);
    expect(quality.sync_error_scope).toBe("device_or_taxi_time");
    expect(body.completeness.status).toBe("incomplete");
    expect(body.completeness.reasons).toContain("observation_coverage_incomplete");
  });
});

