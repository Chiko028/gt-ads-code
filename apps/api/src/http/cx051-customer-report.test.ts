/**
 * CX-051 / R-406: gekennzeichneter CSV-Kundenbericht.
 *
 * Vier Integrationstests gegen die echte Serverfabrik, eine echte
 * PostgreSQL-17-Datenbank und echte Admin-Sitzungscookies. Alle Daten sind
 * synthetisch. Geprueft werden Kunden-/Zeitraumfilter, kampagnenweise Summen
 * in Uebereinstimmung mit CX-049, das Fehlen fremder Kundenkampagnen,
 * CSV-Escaping und Formelneutralisierung, Qualitaetskennzeichnung ohne
 * erfundene OTS, Authentifizierung, ungueltige Zeitraeume, abgelehnte
 * Ergebnisueberschreitungen und die reine Kopfzeile bei leerem Ergebnis.
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
import {
  CUSTOMER_REPORT_COLUMNS,
  CUSTOMER_REPORT_MEASUREMENT,
  serializeCustomerReportCsv,
  type CustomerReportRow,
} from "../modules/statistics/index.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../db/migrations");

const DAY_START = "2026-11-14T00:00:00.000Z";
const DAY_END = "2026-11-15T00:00:00.000Z";
const SECOND_DAY_END = "2026-11-16T00:00:00.000Z";
const BASE_TIME = Date.parse("2026-11-14T12:00:00.000Z");
const ADMIN_PASSWORD = "SYN-CX051-Bericht-Passwort";
const HOST = "127.0.0.1:8080";
const ADMIN_ID = "SYN-CX051-ADMIN";
const JSON_HEADERS = { "content-type": "application/json" };
const REPORT_URL = "/v1/admin/reports/customer.csv";
const STATISTICS_URL = "/v1/admin/statistics";
const HEADER_LINE =
  '"customer_id","campaign_id","campaign_name","from_utc","to_utc",' +
  '"plays_reported","measurement","is_estimate","estimate_method",' +
  '"completeness","data_as_of"\r\n';

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
    throw new Error("CX-051 benoetigt with-postgres <befehl>");
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
    return Promise.resolve({ id: "SYN-CX051-OPERATOR", role: "Operator" });
  }
  return Promise.resolve(null);
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx051_report_" +
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
    "0007_cx_030_media.up.sql",
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
    registrationCodePepper: "SYN-CX051-Pepper",
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
      " campaigns, media_objects, customers, taxis, admin_sessions, devices," +
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

async function insertCustomer(displayName: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "insert into customers (id, display_name, revision) values ($1::uuid, $2, 1)",
    [id, displayName],
  );
  return id;
}

async function insertMedia(displayName: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "insert into media_objects (id, display_name, created_at, status)" +
      " values ($1::uuid, $2, $3::timestamptz, 'staging')",
    [id, displayName, new Date(BASE_TIME - 86_400_000)],
  );
  return id;
}

async function insertTaxi(taxiId: string): Promise<void> {
  await pool.query(
    "insert into taxis (id, display_name, active, revision) values ($1, $2, false, 1)",
    [taxiId, "Taxi " + taxiId],
  );
}

async function insertCampaign(input: {
  customerId: string;
  mediaId: string;
  taxiId?: string;
  startAt?: string;
  endAt?: string;
  status?: string;
  archived?: boolean;
}): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "insert into campaigns (id, customer_id, media_id, owner_id, rule_type, status," +
      " archived, start_at, end_at, revision)" +
      " values ($1::uuid, $2::uuid, $3::uuid, $4, 'fixed_slot', $5, $6," +
      " $7::timestamptz, $8::timestamptz, 1)",
    [
      id,
      input.customerId,
      input.mediaId,
      ADMIN_ID,
      input.status ?? "active",
      input.archived ?? false,
      input.startAt ?? DAY_START,
      input.endAt ?? DAY_END,
    ],
  );
  if (input.taxiId !== undefined) {
    await pool.query(
      "insert into campaign_targets (campaign_id, kind, target_id) values ($1::uuid, 'taxi', $2)",
      [id, input.taxiId],
    );
  }
  return id;
}

async function insertDevice(label: string): Promise<string> {
  const registrationCodeId = randomUUID();
  const deviceId = randomUUID();
  await pool.query(
    "insert into registration_codes (id, code_hash, label, created_at, created_by, expires_at)" +
      " values ($1::uuid, $2, $3, $4, $5, $6)",
    [
      registrationCodeId,
      Buffer.from("SYN-CX051-Code-" + registrationCodeId),
      "SYN-CX051",
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
      Buffer.from("SYN-CX051-Key-" + deviceId),
      "SYN-CX051-FP-" + deviceId,
      registrationCodeId,
      randomUUID(),
      new Date(BASE_TIME - 86_400_000),
      new Date(BASE_TIME),
    ],
  );
  return deviceId;
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

async function insertPlay(
  deviceId: string,
  startAt: string,
  endAt: string,
): Promise<void> {
  await pool.query(
    "insert into telemetry_observations (device_id, event_id, occurred_at," +
      " vehicle_ready, paused, playback, technical_fault, received_at)" +
      " values ($1::uuid, $2::uuid, $3::timestamptz, true, false, 'playing', false," +
      " $3::timestamptz), ($1::uuid, $4::uuid, $5::timestamptz, true, false," +
      " 'stopped', false, $5::timestamptz)",
    [deviceId, randomUUID(), startAt, randomUUID(), endAt],
  );
}

/** Kleiner, strenger CSV-Leser fuer das geprueft Format. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\r" && text[index + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      index += 1;
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function toRecords(text: string): Array<Record<string, string>> {
  const rows = parseCsv(text);
  const header = rows[0]!;
  return rows.slice(1).map((row) => {
    const record: Record<string, string> = {};
    header.forEach((name, index) => {
      record[name] = row[index] ?? "";
    });
    return record;
  });
}

function reportUrl(params: Record<string, string>): string {
  return REPORT_URL + "?" + new URLSearchParams(params).toString();
}

function statisticsUrl(params: Record<string, string>): string {
  return STATISTICS_URL + "?" + new URLSearchParams(params).toString();
}

describe("CX-051 CSV-Kundenbericht", () => {
  it("filtert Kunde und Zeitraum, summiert je Kampagne wie CX-049 und laesst fremde Kundenkampagnen weg", async () => {
    const customerA = await insertCustomer("SYN-CX051-Kunde-A");
    const customerB = await insertCustomer("SYN-CX051-Kunde-B");
    await insertTaxi("SYN-CX051-TAXI-A1");
    await insertTaxi("SYN-CX051-TAXI-A2");
    await insertTaxi("SYN-CX051-TAXI-A3");
    await insertTaxi("SYN-CX051-TAXI-B1");

    const campaignA1 = await insertCampaign({
      customerId: customerA,
      mediaId: await insertMedia("Kampagne A1"),
      taxiId: "SYN-CX051-TAXI-A1",
    });
    // Dieselbe Kundenkampagne auf einem weiteren Taxi.
    await pool.query(
      "insert into campaign_targets (campaign_id, kind, target_id) values ($1::uuid, 'taxi', $2)",
      [campaignA1, "SYN-CX051-TAXI-A3"],
    );
    const campaignA2 = await insertCampaign({
      customerId: customerA,
      mediaId: await insertMedia("Archivierte Kampagne A2"),
      taxiId: "SYN-CX051-TAXI-A2",
      archived: true,
    });
    const campaignB1 = await insertCampaign({
      customerId: customerB,
      mediaId: await insertMedia("Kampagne B1"),
      taxiId: "SYN-CX051-TAXI-B1",
    });

    const deviceA1 = await insertDevice("Tablet A1");
    const deviceA1B = await insertDevice("Tablet A1b");
    const deviceA2 = await insertDevice("Tablet A2");
    const deviceA3 = await insertDevice("Tablet A3");
    const deviceB1 = await insertDevice("Tablet B1");
    await insertAssignment(deviceA1, "SYN-CX051-TAXI-A1", true, "2026-11-13T00:00:00.000Z");
    await insertAssignment(deviceA1B, "SYN-CX051-TAXI-A1", true, "2026-11-13T00:00:00.000Z");
    await insertAssignment(deviceA2, "SYN-CX051-TAXI-A2", true, "2026-11-13T00:00:00.000Z");
    await insertAssignment(deviceA3, "SYN-CX051-TAXI-A3", true, "2026-11-13T00:00:00.000Z");
    await insertAssignment(deviceB1, "SYN-CX051-TAXI-B1", true, "2026-11-13T00:00:00.000Z");

    await insertPlay(deviceA1, "2026-11-14T10:00:00.000Z", "2026-11-14T10:00:15.000Z");
    await insertPlay(deviceA1, "2026-11-14T13:00:00.000Z", "2026-11-14T13:00:15.000Z");
    await insertPlay(deviceA1, "2026-11-14T14:00:00.000Z", "2026-11-14T14:00:15.000Z");
    await insertPlay(deviceA1B, "2026-11-14T15:00:00.000Z", "2026-11-14T15:00:15.000Z");
    await insertPlay(deviceA2, "2026-11-14T13:30:00.000Z", "2026-11-14T13:30:15.000Z");
    await insertPlay(deviceA3, "2026-11-14T16:00:00.000Z", "2026-11-14T16:00:15.000Z");
    await insertPlay(deviceA3, "2026-11-14T17:00:00.000Z", "2026-11-14T17:00:15.000Z");
    await insertPlay(deviceB1, "2026-11-14T12:00:00.000Z", "2026-11-14T12:00:15.000Z");

    const app = await buildApp();
    const cookie = await loginCookie(app);
    const from = "2026-11-14T12:30:00.000Z";
    const response = await app.inject({
      method: "GET",
      url: reportUrl({ customer_id: customerA, from, to: DAY_END }),
      headers: headers(cookie),
    });
    expect(response.statusCode).toBe(200);

    const records = toRecords(response.body);
    expect(records).toHaveLength(2);
    expect(new Set(records.map((row) => row.campaign_id))).toEqual(
      new Set([campaignA1, campaignA2]),
    );
    expect(records.map((row) => row.campaign_id)).not.toContain(campaignB1);
    const expectedPlays = new Map<string, string>([
      [campaignA1, "5"],
      [campaignA2, "1"],
    ]);
    for (const record of records) {
      expect(record.customer_id).toBe(customerA);
      expect(record.from_utc).toBe(from);
      expect(record.to_utc).toBe(DAY_END);
      expect(record.plays_reported).toBe(expectedPlays.get(record.campaign_id));
    }
    expect(records.find((row) => row.campaign_id === campaignA1)!.campaign_name).toBe(
      "Kampagne A1",
    );
    expect(records.find((row) => row.campaign_id === campaignA2)!.campaign_name).toBe(
      "Archivierte Kampagne A2",
    );

    // Uebereinstimmung mit CX-049: gleiche Summen je Kunde-Kampagne.
    const statistics = await app.inject({
      method: "GET",
      url: statisticsUrl({ from, to: DAY_END }),
      headers: headers(cookie),
    });
    expect(statistics.statusCode).toBe(200);
    const statisticsBody = statistics.json() as {
      plays: Array<{
        campaign_id: string | null;
        taxi_id: string | null;
        play_count: number;
      }>;
    };
    const expected = new Map<string, number>();
    for (const play of statisticsBody.plays) {
      if (play.campaign_id !== campaignA1 && play.campaign_id !== campaignA2) continue;
      expected.set(play.campaign_id, (expected.get(play.campaign_id) ?? 0) + play.play_count);
    }
    for (const record of records) {
      expect(Number(record.plays_reported)).toBe(expected.get(record.campaign_id) ?? 0);
    }
    // Mehrere Geraete auf demselben Taxi plus ein weiteres Taxi derselben
    // Kampagne: drei Statistikzeilen, deren Summe ohne Taxi-Deduplizierung
    // vollstaendig in CSV und CX-049 erscheint.
    const a1Plays = statisticsBody.plays.filter((play) => play.campaign_id === campaignA1);
    expect(a1Plays).toHaveLength(3);
    expect(a1Plays.reduce((sum, play) => sum + play.play_count, 0)).toBe(5);
    expect(new Set(a1Plays.map((play) => play.taxi_id))).toEqual(
      new Set(["SYN-CX051-TAXI-A1", "SYN-CX051-TAXI-A3"]),
    );
    expect(expected.get(campaignA2)).toBe(1);

    // Kampagnenfilter: nur die gewaehlte Kunde-Kampagne.
    const filtered = await app.inject({
      method: "GET",
      url: reportUrl({
        customer_id: customerA,
        from,
        to: DAY_END,
        campaign_id: campaignA1,
      }),
      headers: headers(cookie),
    });
    expect(filtered.statusCode).toBe(200);
    const filteredRecords = toRecords(filtered.body);
    expect(filteredRecords).toHaveLength(1);
    expect(filteredRecords[0]!.campaign_id).toBe(campaignA1);

    // Fremde Kundenkampagne ist generisch nicht gefunden.
    const foreign = await app.inject({
      method: "GET",
      url: reportUrl({
        customer_id: customerA,
        from,
        to: DAY_END,
        campaign_id: campaignB1,
      }),
      headers: headers(cookie),
    });
    expect(foreign.statusCode).toBe(404);
    expect((foreign.json() as { error: { code: string } }).error.code).toBe("not_found");

    // Kundenfilter: Kunde B sieht ausschliesslich seine eigene Kampagne.
    const forB = await app.inject({
      method: "GET",
      url: reportUrl({ customer_id: customerB, from, to: DAY_END }),
      headers: headers(cookie),
    });
    expect(forB.statusCode).toBe(200);
    const recordsB = toRecords(forB.body);
    expect(recordsB.map((row) => row.campaign_id)).toEqual([campaignB1]);
  });

  it("begrenzt die Statistikquelle vor der Zeilenobergrenze auf die Kundenkampagnen", async () => {
    const customer = await insertCustomer("SYN-CX051-Kunde-Klein");
    const foreign = await insertCustomer("SYN-CX051-Kunde-Fremd");
    await insertTaxi("SYN-CX051-TAXI-KLEIN");
    await insertTaxi("SYN-CX051-TAXI-FREMD");
    const campaign = await insertCampaign({
      customerId: customer,
      mediaId: await insertMedia("Kleine Kundenkampagne"),
      taxiId: "SYN-CX051-TAXI-KLEIN",
    });
    await insertCampaign({
      customerId: foreign,
      mediaId: await insertMedia("Fremde Masse"),
      taxiId: "SYN-CX051-TAXI-FREMD",
    });
    const device = await insertDevice("Tablet klein");
    await insertAssignment(device, "SYN-CX051-TAXI-KLEIN", true, "2026-11-13T00:00:00.000Z");
    await insertPlay(device, "2026-11-14T10:00:00.000Z", "2026-11-14T10:00:15.000Z");

    // 10 001 fremde Geraete mit je einem abgeschlossenen Play auf demselben
    // fremden Taxi: zusammen mit ihren Qualitaetszeilen mehr als die harte
    // CX-049-Grenze von 10 000 Zeilen. Der kleine Kundenexport darf daran
    // nicht scheitern.
    await pool.query(
      "insert into registration_codes (id, code_hash, label, created_at, created_by, expires_at)" +
        " select md5('cx051-reg-' || i)::uuid, decode(md5('cx051-code-' || i), 'hex')," +
        " 'SYN-CX051', $1::timestamptz, $2, $3::timestamptz" +
        " from generate_series(1, 10001) as i",
      [new Date(BASE_TIME - 86_400_000), ADMIN_ID, new Date(BASE_TIME + 86_400_000)],
    );
    await pool.query(
      "insert into devices (id, label, public_key_spki, public_key_fingerprint, state," +
        " manufacturer, model, os_version, sdk_int, app_version, app_flavor," +
        " registration_code_id, registration_request_id, registered_at, last_seen_at)" +
        " select md5('cx051-dev-' || i)::uuid, 'Fremd ' || i," +
        " decode(md5('cx051-key-' || i), 'hex'), 'SYN-CX051-FP-' || i, 'active'," +
        " 'SYN', 'SYN', '15', 35, '1.0.0', 'dev', md5('cx051-reg-' || i)::uuid," +
        " gen_random_uuid(), $1::timestamptz, $1::timestamptz" +
        " from generate_series(1, 10001) as i",
      [new Date(BASE_TIME - 86_400_000)],
    );
    await pool.query(
      "insert into device_taxi_assignments (device_id, taxi_id, active, updated_at)" +
        " select md5('cx051-dev-' || i)::uuid, 'SYN-CX051-TAXI-FREMD', true, $1::timestamptz" +
        " from generate_series(1, 10001) as i",
      [new Date(BASE_TIME - 86_400_000)],
    );
    await pool.query(
      "insert into telemetry_observations (device_id, event_id, occurred_at," +
        " vehicle_ready, paused, playback, technical_fault, received_at)" +
        " select md5('cx051-dev-' || i)::uuid, gen_random_uuid(), $1::timestamptz," +
        " true, false, 'playing', false, $1::timestamptz" +
        " from generate_series(1, 10001) as i" +
        " union all" +
        " select md5('cx051-dev-' || i)::uuid, gen_random_uuid(), $2::timestamptz," +
        " true, false, 'stopped', false, $2::timestamptz" +
        " from generate_series(1, 10001) as i",
      ["2026-11-14T09:00:00.000Z", "2026-11-14T09:00:15.000Z"],
    );

    const app = await buildApp();
    const cookie = await loginCookie(app);
    const response = await app.inject({
      method: "GET",
      url: reportUrl({ customer_id: customer, from: DAY_START, to: DAY_END }),
      headers: headers(cookie),
    });
    expect(response.statusCode).toBe(200);
    const records = toRecords(response.body);
    expect(records).toHaveLength(1);
    expect(records[0]!.campaign_id).toBe(campaign);
    expect(records[0]!.plays_reported).toBe("1");

    // Die ungefilterte Statistik ueberschreitet weiterhin die Grenze; der
    // kleine Export ist nicht durch eine entfallene Grenze erfolgreich.
    const statistics = await app.inject({
      method: "GET",
      url: statisticsUrl({ from: DAY_START, to: DAY_END }),
      headers: headers(cookie),
    });
    expect(statistics.statusCode).toBe(400);
    expect((statistics.json() as { error: { code: string } }).error.code).toBe(
      "invalid_request",
    );
  });

  it("quotet Kommas, Anfuehrungszeichen und Zeilenumbrueche und neutralisiert Formelpraefixe", async () => {
    const customer = await insertCustomer("SYN-CX051-Kunde-CSV");
    const names: Array<{ raw: string; expected: string }> = [
      { raw: 'SYN, "Zitat"\nZeile', expected: 'SYN, "Zitat"\nZeile' },
      { raw: "  =SUM(A1:A2)", expected: "'  =SUM(A1:A2)" },
      { raw: "\t@cmd", expected: "'\t@cmd" },
      { raw: "-1+2", expected: "'-1+2" },
      { raw: "Normaler Name", expected: "Normaler Name" },
    ];
    const ids: string[] = [];
    for (const entry of names) {
      ids.push(
        await insertCampaign({
          customerId: customer,
          mediaId: await insertMedia(entry.raw),
        }),
      );
    }

    const app = await buildApp();
    const cookie = await loginCookie(app);
    const response = await app.inject({
      method: "GET",
      url: reportUrl({ customer_id: customer, from: DAY_START, to: DAY_END }),
      headers: headers(cookie),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="customer-report.csv"',
    );
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.startsWith(HEADER_LINE)).toBe(true);

    // Genau eine Kopfzeile plus fuenf Datensaetze trotz eingebetteter
    // Zeilenumbrueche: Datensaetze enden ausschliesslich mit CRLF.
    expect(parseCsv(response.body)).toHaveLength(6);
    expect(response.body.split("\r\n")).toHaveLength(7);

    const records = toRecords(response.body);
    expect(records).toHaveLength(5);
    for (const record of records) {
      expect(Object.keys(record)).toEqual([...CUSTOMER_REPORT_COLUMNS]);
    }
    const byId = new Map(records.map((row) => [row.campaign_id, row]));
    names.forEach((entry, index) => {
      const record = byId.get(ids[index]!)!;
      expect(record.campaign_name).toBe(entry.expected);
    });
    expect(response.body).toContain('"SYN, ""Zitat""\nZeile"');
    // Jede gefaehrliche Textzelle beginnt nach dem Quoting mit Apostroph.
    for (const record of records) {
      const name = record.campaign_name;
      if (name.trimStart().startsWith("=") || name.trimStart().startsWith("@") ||
          name.trimStart().startsWith("-")) {
        expect(name.startsWith("'")).toBe(true);
      }
    }
  });

  it("kennzeichnet unvollstaendige Daten und Schaetzwerte sichtbar, ohne OTS zu erfinden", async () => {
    const customer = await insertCustomer("SYN-CX051-Kunde-Q");
    await insertTaxi("SYN-CX051-TAXI-Q");
    const campaign = await insertCampaign({
      customerId: customer,
      mediaId: await insertMedia("Qualitaetskampagne"),
      taxiId: "SYN-CX051-TAXI-Q",
    });
    const device = await insertDevice("Tablet Q");
    await insertAssignment(device, "SYN-CX051-TAXI-Q", true, "2026-11-13T00:00:00.000Z");
    await insertPlay(device, "2026-11-14T10:00:00.000Z", "2026-11-14T10:00:15.000Z");
    await insertPlay(device, "2026-11-14T11:00:00.000Z", "2026-11-14T11:00:15.000Z");

    const app = await buildApp();
    const cookie = await loginCookie(app);

    // Zweiter Tag ohne Beleg: sichtbar unvollstaendig.
    const incomplete = await app.inject({
      method: "GET",
      url: reportUrl({ customer_id: customer, from: DAY_START, to: SECOND_DAY_END }),
      headers: headers(cookie),
    });
    expect(incomplete.statusCode).toBe(200);
    const incompleteRecord = toRecords(incomplete.body)[0]!;
    expect(incompleteRecord.campaign_id).toBe(campaign);
    expect(incompleteRecord.plays_reported).toBe("2");
    expect(incompleteRecord.measurement).toBe(CUSTOMER_REPORT_MEASUREMENT);
    expect(incompleteRecord.completeness).toBe("incomplete");
    expect(incompleteRecord.is_estimate).toBe("false");
    expect(incompleteRecord.estimate_method).toBe("");

    // Keinerlei Belege im Zeitraum: unknown statt einer erfundenen Null.
    const unknown = await app.inject({
      method: "GET",
      url: reportUrl({
        customer_id: customer,
        from: "2026-11-20T00:00:00.000Z",
        to: "2026-11-21T00:00:00.000Z",
      }),
      headers: headers(cookie),
    });
    expect(unknown.statusCode).toBe(200);
    const unknownRecord = toRecords(unknown.body)[0]!;
    expect(unknownRecord.completeness).toBe("unknown");
    expect(unknownRecord.plays_reported).toBe("0");
    expect(unknownRecord.data_as_of).toBe(incompleteRecord.data_as_of);

    // Keine OTS-/Reichweiten-/Verguetungs-/Rechnungsspalten.
    const header = incomplete.body.split("\r\n")[0]!.toLowerCase();
    expect(header).not.toMatch(/ots|reach|payout|invoice|verguetung/);

    // Schaetzwerte erscheinen nur ausdruecklich markiert; unmarkiert ist ein
    // Fehler und niemals eine Zeile.
    const base: CustomerReportRow = {
      customer_id: customer,
      campaign_id: campaign,
      campaign_name: "Qualitaetskampagne",
      from_utc: DAY_START,
      to_utc: SECOND_DAY_END,
      plays_reported: 2,
      measurement: CUSTOMER_REPORT_MEASUREMENT,
      is_estimate: false,
      estimate_method: "",
      completeness: "incomplete",
      data_as_of: new Date(BASE_TIME).toISOString(),
    };
    const estimated = serializeCustomerReportCsv([
      { ...base, plays_reported: 7, is_estimate: true, estimate_method: "synthetic_method_v1" },
    ]);
    const estimatedRecord = toRecords(estimated)[0]!;
    expect(estimatedRecord.plays_reported).toBe("7");
    expect(estimatedRecord.is_estimate).toBe("true");
    expect(estimatedRecord.estimate_method).toBe("synthetic_method_v1");
    expect(() =>
      serializeCustomerReportCsv([
        { ...base, is_estimate: true, estimate_method: "" },
      ]),
    ).toThrow();
  });

  it("lehnt anonymen Zugriff und Geraete-Bearer ab, meldet ungueltige Zeitraeume und Ueberschreitungen statt gekuerzter CSV", async () => {
    const customer = await insertCustomer("SYN-CX051-Kunde-Fehler");
    const emptyCustomer = await insertCustomer("SYN-CX051-Kunde-Leer");
    const app = await buildApp();

    const anonymous = await app.inject({
      method: "GET",
      url: reportUrl({ customer_id: customer, from: DAY_START, to: DAY_END }),
      headers: { host: HOST },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers["content-type"]).not.toContain("text/csv");

    const deviceBearer = await app.inject({
      method: "GET",
      url: reportUrl({ customer_id: customer, from: DAY_START, to: DAY_END }),
      headers: { host: HOST, authorization: "Bearer SYN-CX051-GERAETETOKEN" },
    });
    expect(deviceBearer.statusCode).toBe(401);
    expect(deviceBearer.headers["content-type"]).not.toContain("text/csv");

    const cookie = await loginCookie(app);
    const invalidUrls = [
      reportUrl({ from: DAY_START, to: DAY_END }),
      reportUrl({ customer_id: customer, to: DAY_END }),
      reportUrl({ customer_id: "keine-uuid", from: DAY_START, to: DAY_END }),
      reportUrl({ customer_id: customer, from: "2026-11-14", to: DAY_END }),
      reportUrl({ customer_id: customer, from: DAY_END, to: DAY_START }),
      reportUrl({
        customer_id: customer,
        from: "2026-10-01T00:00:00.000Z",
        to: "2026-11-15T00:00:00.000Z",
      }),
      reportUrl({
        customer_id: customer,
        from: DAY_START,
        to: DAY_END,
        campaign_id: "keine-uuid",
      }),
      reportUrl({ customer_id: customer, from: DAY_START, to: DAY_END, unbekannt: "1" }),
      REPORT_URL + "?customer_id=" + customer +
        "&from=" + encodeURIComponent(DAY_START) +
        "&to=" + encodeURIComponent(DAY_END) +
        "&from=" + encodeURIComponent(DAY_START),
    ];
    for (const url of invalidUrls) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: headers(cookie),
      });
      expect(response.statusCode, url).toBe(400);
      expect(response.headers["content-type"]).toContain("application/json");
    }

    // Ergebnisueberschreitung: 10 001 Kampagnen sind mehr als die harte
    // CX-049-Grenze und werden abgelehnt, nicht gekuerzt.
    await pool.query(
      "insert into campaigns (id, customer_id, media_id, owner_id, rule_type," +
        " status, archived, start_at, end_at, revision)" +
        " select gen_random_uuid(), $1::uuid, gen_random_uuid(), $2, 'fixed_slot'," +
        " 'draft', false, $3::timestamptz, $4::timestamptz, 1" +
        " from generate_series(1, 10001)",
      [customer, ADMIN_ID, DAY_START, DAY_END],
    );
    const overflow = await app.inject({
      method: "GET",
      url: reportUrl({ customer_id: customer, from: DAY_START, to: DAY_END }),
      headers: headers(cookie),
    });
    expect(overflow.statusCode).toBe(400);
    expect(overflow.headers["content-type"]).toContain("application/json");
    expect((overflow.json() as { error: { code: string } }).error.code).toBe(
      "invalid_request",
    );
    expect(overflow.body).not.toContain("customer_id,campaign_id");

    // Leeres Ergebnis: ausschliesslich die Kopfzeile.
    const empty = await app.inject({
      method: "GET",
      url: reportUrl({ customer_id: emptyCustomer, from: DAY_START, to: DAY_END }),
      headers: headers(cookie),
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(empty.body).toBe(HEADER_LINE);
  });
});
