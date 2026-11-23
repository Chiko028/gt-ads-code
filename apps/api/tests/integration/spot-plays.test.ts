/**
 * CX-159: Spot-Abspielnachweise und Monatsauswertung gegen echte
 * PostgreSQL-Datenbank, echte Geraeteauthentifizierung und echte
 * Admin-Sitzung. Alle IDs, Namen und Zeiten sind synthetisch.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS, type AppConfig } from "../../src/config.js";
import { hashPassword } from "../../src/crypto/password.js";
import { generateAccessToken, hashToken } from "../../src/crypto/tokens.js";
import { migrateLatest } from "../../src/db/migrate.js";
import { ADMIN_SESSION_COOKIE } from "../../src/modules/adminAuth/middleware.js";
import { createServer } from "../../src/http/server.js";
import {
  SPOT_PLAY_SUMMARY_PATH,
  SPOT_PLAYS_PATH,
} from "../../src/http/spotPlayRoutes.js";

const BASE_TIME = Date.parse("2026-11-15T12:00:00.000Z");
const CYCLE_MS = 60 * 60 * 1000;
const ADMIN_PASSWORD = "SYN-CX159-Statistik-Passwort";
const HOST = "127.0.0.1:8080";
const ADMIN_ID = "SYN-CX159-ADMIN";
const JSON_HEADERS = { "content-type": "application/json" };
const API_HEADERS = {
  ...JSON_HEADERS,
  "x-gt-ads-api-version": "1",
};

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let config: AppConfig;
let app: FastifyInstance;

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
    throw new Error("CX-159 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx159_spot_plays_" +
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
  await migrateLatest(pool);
  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX159-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };
  app = createServer({
    config,
    pool,
    now: () => new Date(BASE_TIME),
    logger: { level: "silent" },
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  if (app !== undefined) {
    await app.close();
  }
  if (pool !== undefined) {
    await pool.end();
  }
  if (maintenancePool !== undefined) {
    await maintenancePool.query(
      "drop database if exists " + quoteIdentifier(databaseName),
    );
    await maintenancePool.end();
  }
}, 60_000);

beforeEach(async () => {
  await pool.query(
    "truncate table spot_plays, device_taxi_assignments, taxis," +
      " campaigns, customers, media_objects," +
      " admin_sessions, device_access_tokens, device_auth_challenges," +
      " devices, registration_codes restart identity cascade",
  );
});

async function insertDevice(label: string): Promise<string> {
  const registrationCodeId = randomUUID();
  const deviceId = randomUUID();
  await pool.query(
    "insert into registration_codes (id, code_hash, label, created_at," +
      " created_by, expires_at) values ($1::uuid, $2, $3, $4, $5, $6)",
    [
      registrationCodeId,
      Buffer.from("SYN-CX159-Code-" + registrationCodeId),
      label,
      new Date(BASE_TIME - CYCLE_MS),
      ADMIN_ID,
      new Date(BASE_TIME + 24 * CYCLE_MS),
    ],
  );
  await pool.query(
    "insert into devices (id, label, public_key_spki, public_key_fingerprint," +
      " state, manufacturer, model, os_version, sdk_int, app_version," +
      " app_flavor, registration_code_id, registration_request_id," +
      " registered_at, last_seen_at) values ($1::uuid, $2, $3, $4, 'active'," +
      " 'SYN', 'SYN', '15', 35, '1.0.0', 'dev', $5::uuid, $6::uuid, $7, $8)",
    [
      deviceId,
      label,
      Buffer.from("SYN-CX159-Key-" + deviceId),
      "SYN-CX159-FP-" + deviceId,
      registrationCodeId,
      randomUUID(),
      new Date(BASE_TIME - CYCLE_MS),
      new Date(BASE_TIME),
    ],
  );
  return deviceId;
}

async function deviceToken(deviceId: string): Promise<string> {
  const token = generateAccessToken();
  await pool.query(
    "insert into device_access_tokens (id, device_id, token_hash, created_at," +
      " expires_at) values ($1::uuid, $2::uuid, $3, $4, $5)",
    [
      randomUUID(),
      deviceId,
      hashToken(token),
      new Date(BASE_TIME - CYCLE_MS),
      new Date(BASE_TIME + CYCLE_MS),
    ],
  );
  return token;
}

async function insertTaxi(taxiId: string, displayName: string): Promise<void> {
  await pool.query(
    "insert into taxis (id, display_name, active, revision)" +
      " values ($1, $2, true, 1)",
    [taxiId, displayName],
  );
}

async function assign(deviceId: string, taxiId: string): Promise<void> {
  await pool.query(
    "insert into device_taxi_assignments (device_id, taxi_id, active," +
      " updated_at) values ($1::uuid, $2, true, $3)",
    [deviceId, taxiId, new Date(BASE_TIME - CYCLE_MS)],
  );
}

async function insertMedia(mediaId: string, displayName: string): Promise<void> {
  const createdAt = new Date(BASE_TIME - 24 * CYCLE_MS);
  await pool.query(
    "insert into media_objects (id, display_name, size_bytes, sha256," +
      " container, video_codec, width, height, frame_rate_numerator," +
      " frame_rate_denominator, audio_stream_count, duration_seconds," +
      " created_at, status, ready_at) values ($1::uuid, $2, 1000, $3," +
      " 'mp4', 'h264', 1920, 1080, 25, 1, 2, 30, $4, 'ready', $4)",
    [mediaId, displayName, "a".repeat(64), createdAt],
  );
}

async function insertCustomerCampaign(
  campaignId: string,
  customerName: string,
  mediaId: string,
): Promise<string> {
  const customerId = randomUUID();
  await pool.query(
    "insert into customers (id, display_name, revision)" +
      " values ($1::uuid, $2, 1)",
    [customerId, customerName],
  );
  await pool.query(
    "insert into campaigns (id, customer_id, media_id, owner_id, rule_type," +
      " status, archived, start_at, end_at, revision)" +
      " values ($1::uuid, $2::uuid, $3::uuid, $4, 'fixed_slot', 'active'," +
      " false, $5, $6, 1)",
    [
      campaignId,
      customerId,
      mediaId,
      ADMIN_ID,
      new Date(BASE_TIME - 30 * CYCLE_MS),
      new Date(BASE_TIME + 30 * CYCLE_MS),
    ],
  );
  return customerId;
}

interface SpotRowInput {
  deviceId: string;
  playId?: string;
  taxiId: string | null;
  campaignId: string;
  mediaId: string;
  startedAt: string;
  endedAt: string;
  playedMs: number;
  completed: boolean;
  receivedAt: string;
}

async function insertSpotRow(input: SpotRowInput): Promise<string> {
  const playId = input.playId ?? randomUUID();
  await pool.query(
    "insert into spot_plays (device_id, play_id, taxi_id, campaign_id," +
      " media_id, started_at, ended_at, played_ms, completed, received_at)" +
      " values ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6, $7, $8," +
      " $9, $10)",
    [
      input.deviceId,
      playId,
      input.taxiId,
      input.campaignId,
      input.mediaId,
      input.startedAt,
      input.endedAt,
      input.playedMs,
      input.completed,
      input.receivedAt,
    ],
  );
  return playId;
}

interface PlayPayload {
  play_id: string;
  campaign_id: string;
  media_id: string;
  started_at: string;
  ended_at: string;
  played_ms: number;
  completed: boolean;
}

function play(overrides: Partial<PlayPayload> = {}): PlayPayload {
  return {
    play_id: randomUUID(),
    campaign_id: randomUUID(),
    media_id: randomUUID(),
    started_at: "2026-11-10T10:00:00.000Z",
    ended_at: "2026-11-10T10:01:00.000Z",
    played_ms: 60_000,
    completed: true,
    ...overrides,
  };
}

function postSpotPlays(
  token: string | undefined,
  payload: unknown,
) {
  const headers: Record<string, string> = { ...API_HEADERS };
  if (token !== undefined) {
    headers.authorization = "Bearer " + token;
  }
  return app.inject({
    method: "POST",
    url: SPOT_PLAYS_PATH,
    headers,
    payload: payload as Record<string, unknown>,
    remoteAddress: "192.0.2.159",
  });
}

async function loginCookie(): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/login",
    headers: { host: HOST, ...JSON_HEADERS },
    payload: { password: ADMIN_PASSWORD },
    remoteAddress: "192.0.2.159",
  });
  expect(response.statusCode).toBe(204);
  const raw = response.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  expect(first, "Set-Cookie fehlt").toBeTruthy();
  return (first as string)
    .split(";")[0]!
    .slice(ADMIN_SESSION_COOKIE.length + 1);
}

function getSummary(url: string, cookie?: string) {
  const headers: Record<string, string> = { host: HOST };
  if (cookie !== undefined) {
    headers.cookie = ADMIN_SESSION_COOKIE + "=" + cookie;
  }
  return app.inject({ method: "GET", url, headers, remoteAddress: "192.0.2.159" });
}

describe("CX-159 POST /v1/device/spot-plays", () => {
  it("weist eine Meldung ohne Bearer mit 401 ab", async () => {
    const response = await postSpotPlays(undefined, { plays: [play()] });
    expect(response.statusCode).toBe(401);
  });

  it("behandelt eine identische Wiederholung als Duplikat", async () => {
    const deviceId = await insertDevice("SYN-CX159-Tablet-A");
    const token = await deviceToken(deviceId);
    await insertTaxi("SYN-TAXI-A", "SYN-Taxi-A");
    await assign(deviceId, "SYN-TAXI-A");
    const payload = play();

    const first = await postSpotPlays(token, { plays: [payload] });
    expect(first.statusCode).toBe(200);
    expect(first.json().accepted).toBe(1);
    expect(first.json().inserted).toBe(1);
    expect(first.json().duplicate_play_ids).toEqual([]);

    const second = await postSpotPlays(token, { plays: [payload] });
    expect(second.statusCode).toBe(200);
    expect(second.json().accepted).toBe(1);
    expect(second.json().inserted).toBe(0);
    expect(second.json().duplicate_play_ids).toEqual([payload.play_id]);

    const rows = await pool.query(
      "select play_id::text as play_id, taxi_id, played_ms, completed" +
        " from spot_plays where device_id = $1::uuid",
      [deviceId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      play_id: payload.play_id,
      taxi_id: "SYN-TAXI-A",
      played_ms: 60_000,
      completed: true,
    });
  });

  it("lehnt eine abweichende Wiederverwendung mit 409 ab, ohne zu ueberschreiben", async () => {
    const deviceId = await insertDevice("SYN-CX159-Tablet-A");
    const token = await deviceToken(deviceId);
    await insertTaxi("SYN-TAXI-A", "SYN-Taxi-A");
    await assign(deviceId, "SYN-TAXI-A");
    const original = play();
    const first = await postSpotPlays(token, { plays: [original] });
    expect(first.statusCode).toBe(200);

    const fresh = play();
    const changed = { ...original, played_ms: 59_000, completed: false };
    const conflict = await postSpotPlays(token, { plays: [fresh, changed] });
    expect(conflict.statusCode).toBe(409);

    const rows = await pool.query(
      "select play_id::text as play_id, played_ms, completed" +
        " from spot_plays where device_id = $1::uuid order by play_id",
      [deviceId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      play_id: original.play_id,
      played_ms: 60_000,
      completed: true,
    });
    expect(rows.rows[0]?.play_id).not.toBe(fresh.play_id);
  });

  it("weist eine ungueltige Meldung im Batch mit 400 ohne Teilspeicherung ab", async () => {
    const deviceId = await insertDevice("SYN-CX159-Tablet-A");
    const token = await deviceToken(deviceId);
    await insertTaxi("SYN-TAXI-A", "SYN-Taxi-A");
    await assign(deviceId, "SYN-TAXI-A");

    const valid = play();
    const invalid = play({
      started_at: "2026-11-10T12:00:00.000Z",
      ended_at: "2026-11-10T12:00:01.000Z",
      played_ms: 5_000,
    });
    const response = await postSpotPlays(token, { plays: [valid, invalid] });
    expect(response.statusCode).toBe(400);

    const count = await pool.query(
      "select count(*)::int as count from spot_plays where device_id = $1::uuid",
      [deviceId],
    );
    expect(count.rows[0]?.count).toBe(0);
  });

  it("weist unbekannte Felder mit 400 ab", async () => {
    const deviceId = await insertDevice("SYN-CX159-Tablet-A");
    const token = await deviceToken(deviceId);
    await insertTaxi("SYN-TAXI-A", "SYN-Taxi-A");
    await assign(deviceId, "SYN-TAXI-A");

    const withUnknown = {
      ...play(),
      taxi_id: "SYN-TAXI-A",
    };
    const response = await postSpotPlays(token, { plays: [withUnknown] });
    expect(response.statusCode).toBe(400);

    const count = await pool.query(
      "select count(*)::int as count from spot_plays",
    );
    expect(count.rows[0]?.count).toBe(0);
  });
});

describe("CX-159 GET /v1/admin/spot-plays/summary", () => {
  it("weist eine Auswertung ohne Sitzung mit 401 ab", async () => {
    const response = await getSummary(
      SPOT_PLAY_SUMMARY_PATH + "?month=2026-11",
    );
    expect(response.statusCode).toBe(401);
  });

  it("weist fehlenden, ungueltigen Monat oder Zusatzparameter mit 400 ab", async () => {
    const cookie = await loginCookie();

    const missing = await getSummary(SPOT_PLAY_SUMMARY_PATH, cookie);
    expect(missing.statusCode).toBe(400);

    const invalid = await getSummary(
      SPOT_PLAY_SUMMARY_PATH + "?month=2026-13",
      cookie,
    );
    expect(invalid.statusCode).toBe(400);

    const malformed = await getSummary(
      SPOT_PLAY_SUMMARY_PATH + "?month=2026-1",
      cookie,
    );
    expect(malformed.statusCode).toBe(400);

    const extra = await getSummary(
      SPOT_PLAY_SUMMARY_PATH + "?month=2026-11&taxi_id=SYN-TAXI-A",
      cookie,
    );
    expect(extra.statusCode).toBe(400);
  });

  it("wertet Wiener Monatsgrenzen, vollstaendige Spots, Minuten und Taxi/Video aus", async () => {
    const deviceA = await insertDevice("SYN-CX159-Tablet-A");
    const deviceB = await insertDevice("SYN-CX159-Tablet-B");
    await insertTaxi("SYN-TAXI-A", "SYN-Taxi-A");
    await insertTaxi("SYN-TAXI-B", "SYN-Taxi-B");
    await assign(deviceA, "SYN-TAXI-A");
    await assign(deviceB, "SYN-TAXI-B");

    const mediaA = randomUUID();
    const mediaB = randomUUID();
    const campaignA = randomUUID();
    const campaignB = randomUUID();
    await insertMedia(mediaA, "SYN-Spot-Alpha");
    await insertMedia(mediaB, "SYN-Spot-Beta");
    const customerA = await insertCustomerCampaign(
      campaignA,
      "SYN-Kunde-Alpha",
      mediaA,
    );
    const customerB = await insertCustomerCampaign(
      campaignB,
      "SYN-Kunde-Beta",
      mediaB,
    );
    expect(customerA).not.toBe(customerB);

    await insertSpotRow({
      deviceId: deviceA,
      taxiId: "SYN-TAXI-A",
      campaignId: campaignA,
      mediaId: mediaA,
      startedAt: "2026-11-10T10:00:00.000Z",
      endedAt: "2026-11-10T10:01:00.000Z",
      playedMs: 60_000,
      completed: true,
      receivedAt: "2026-11-10T10:02:00.000Z",
    });
    await insertSpotRow({
      deviceId: deviceA,
      taxiId: "SYN-TAXI-A",
      campaignId: campaignA,
      mediaId: mediaA,
      startedAt: "2026-11-10T11:00:00.000Z",
      endedAt: "2026-11-10T11:00:30.000Z",
      playedMs: 30_000,
      completed: false,
      receivedAt: "2026-11-10T11:01:00.000Z",
    });
    await insertSpotRow({
      deviceId: deviceB,
      taxiId: "SYN-TAXI-B",
      campaignId: campaignB,
      mediaId: mediaB,
      startedAt: "2026-11-11T10:00:00.000Z",
      endedAt: "2026-11-11T10:00:45.000Z",
      playedMs: 45_000,
      completed: true,
      receivedAt: "2026-11-11T10:01:00.000Z",
    });
    // 31.10. 23:30 UTC ist in Wien bereits der 1. November.
    await insertSpotRow({
      deviceId: deviceA,
      taxiId: "SYN-TAXI-A",
      campaignId: campaignA,
      mediaId: mediaA,
      startedAt: "2026-10-31T23:30:00.000Z",
      endedAt: "2026-10-31T23:30:15.000Z",
      playedMs: 15_000,
      completed: true,
      receivedAt: "2026-11-01T00:00:00.000Z",
    });
    // 30.11. 23:30 UTC ist in Wien bereits der 1. Dezember.
    await insertSpotRow({
      deviceId: deviceB,
      taxiId: "SYN-TAXI-B",
      campaignId: campaignB,
      mediaId: mediaB,
      startedAt: "2026-11-30T23:30:00.000Z",
      endedAt: "2026-11-30T23:30:20.000Z",
      playedMs: 20_000,
      completed: true,
      receivedAt: "2026-12-01T00:00:00.000Z",
    });

    const cookie = await loginCookie();
    const novemberResponse = await getSummary(
      SPOT_PLAY_SUMMARY_PATH + "?month=2026-11",
      cookie,
    );
    expect(novemberResponse.statusCode).toBe(200);
    expect(novemberResponse.headers["cache-control"]).toBe("no-store");
    const november = novemberResponse.json();
    expect(november.month).toBe("2026-11");
    expect(november.totals).toEqual({
      spots: 3,
      played_ms: 150_000,
      taxis: 2,
    });
    expect(november.last_received_at).toBe("2026-11-11T10:01:00.000Z");
    expect(november.per_taxi).toEqual([
      {
        taxi_id: "SYN-TAXI-A",
        display_name: "SYN-Taxi-A",
        spots: 2,
        played_ms: 105_000,
      },
      {
        taxi_id: "SYN-TAXI-B",
        display_name: "SYN-Taxi-B",
        spots: 1,
        played_ms: 45_000,
      },
    ]);

    const mediaByVideo = new Map<string, {
      display_name: string | null;
      customer_name: string | null;
      spots: number;
      played_ms: number;
    }>();
    for (const row of november.per_media) {
      mediaByVideo.set(row.media_id, row);
    }
    expect(mediaByVideo.get(mediaA)).toEqual({
      media_id: mediaA,
      display_name: "SYN-Spot-Alpha",
      customer_name: "SYN-Kunde-Alpha",
      spots: 2,
      played_ms: 105_000,
    });
    expect(mediaByVideo.get(mediaB)).toEqual({
      media_id: mediaB,
      display_name: "SYN-Spot-Beta",
      customer_name: "SYN-Kunde-Beta",
      spots: 1,
      played_ms: 45_000,
    });

    const decemberResponse = await getSummary(
      SPOT_PLAY_SUMMARY_PATH + "?month=2026-12",
      cookie,
    );
    expect(decemberResponse.statusCode).toBe(200);
    const december = decemberResponse.json();
    expect(december.totals).toEqual({
      spots: 1,
      played_ms: 20_000,
      taxis: 1,
    });
    expect(december.per_taxi).toEqual([
      {
        taxi_id: "SYN-TAXI-B",
        display_name: "SYN-Taxi-B",
        spots: 1,
        played_ms: 20_000,
      },
    ]);

    const octoberResponse = await getSummary(
      SPOT_PLAY_SUMMARY_PATH + "?month=2026-10",
      cookie,
    );
    expect(octoberResponse.statusCode).toBe(200);
    expect(octoberResponse.json().totals).toEqual({
      spots: 0,
      played_ms: 0,
      taxis: 0,
    });
  });

  it("liefert fuer einen leeren Monat Nullen und leere Listen", async () => {
    const cookie = await loginCookie();
    const response = await getSummary(
      SPOT_PLAY_SUMMARY_PATH + "?month=2025-01",
      cookie,
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      month: "2025-01",
      totals: { spots: 0, played_ms: 0, taxis: 0 },
      per_taxi: [],
      per_media: [],
      last_received_at: null,
    });
  });
});
