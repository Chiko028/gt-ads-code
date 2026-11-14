import {
  generateKeyPairSync,
  randomUUID,
  sign as signWithKey,
  type KeyObject,
} from "node:crypto";
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
import { buildSignatureMessage } from "../../src/crypto/deviceSignature.js";
import { migrateUp } from "../../src/db/migrate.js";
import { createServer } from "../../src/http/server.js";
import { RegistrationService } from "../../src/modules/registration/service.js";
import {
  DEVICE_EVENTS_BODY_LIMIT_BYTES,
  DEVICE_EVENTS_PATH,
} from "../../src/http/deviceEvents.js";

const BASE_TIME = Date.parse("2026-01-01T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/db/migrations",
);

const DEVICE_INFO = {
  manufacturer: "SYN-Hersteller",
  model: "SYN-Modell",
  os_version: "14",
  sdk_int: 34,
  app_version: "0.1.0",
  app_flavor: "dev",
};

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let config: AppConfig;
let registrationService: RegistrationService;
let nowMs = BASE_TIME;
const clock = (): Date => new Date(nowMs);
const openApps: FastifyInstance[] = [];

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
    throw new Error("CX-046 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = ("gtads_cx046_" + process.pid + "_" + Date.now().toString(36))
    .toLowerCase()
    .slice(0, 63);
  await maintenancePool.query("create database " + quoteIdentifier(databaseName));

  pool = new Pool({ ...base, database: databaseName });
  await migrateUp(pool);
  // CX-009-Ereignisspeicher (Migration 0002) gehoert nicht zu 0001.
  await pool.query(
    await readFile(
      join(MIGRATIONS_DIR, "0002_gt_ads_004_telemetry.up.sql"),
      "utf8",
    ),
  );

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX046-Code-Pepper",
    adminPasswordHash:
      "scrypt$N=16384,r=8,p=1$c3ludGhldGlzY2hlLXNhbHQ$aGFzaC1oYXNoLWhhc2gtaGFzaC1oYXNo",
  };
  registrationService = new RegistrationService({ pool, config, now: clock });
}, 60_000);

beforeEach(async () => {
  nowMs = BASE_TIME;
  if (pool !== undefined) {
    await pool.query("delete from telemetry_observations");
  }
});

afterEach(async () => {
  for (const app of openApps.splice(0)) {
    await app.close();
  }
});

afterAll(async () => {
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

async function buildApp(): Promise<FastifyInstance> {
  const app = createServer({ config, pool, now: clock });
  await app.ready();
  openApps.push(app);
  return app;
}

interface TestDevice {
  deviceId: string;
  privateKey: KeyObject;
}

async function registerDevice(app: FastifyInstance): Promise<TestDevice> {
  const created = await registrationService.createRegistrationCode({
    label: "SYN-CX046-Testtablet",
  });
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = pair.publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");

  const response = await app.inject({
    method: "POST",
    url: "/v1/device/register",
    headers: {
      "content-type": "application/json",
      "x-gt-ads-api-version": "1",
    },
    payload: {
      registration_code: created.code,
      client_request_id: randomUUID(),
      public_key: spki,
      app_env: "test",
      device_info: { ...DEVICE_INFO },
    },
    remoteAddress: "192.0.2.140",
  });
  expect(response.statusCode).toBe(201);
  return {
    deviceId: response.json().device_id as string,
    privateKey: pair.privateKey,
  };
}

async function accessToken(
  app: FastifyInstance,
  device: TestDevice,
): Promise<string> {
  const challengeResponse = await app.inject({
    method: "POST",
    url: "/v1/device/auth/challenge",
    headers: {
      "content-type": "application/json",
      "x-gt-ads-api-version": "1",
    },
    payload: { device_id: device.deviceId },
    remoteAddress: "192.0.2.141",
  });
  expect(challengeResponse.statusCode).toBe(200);
  const nonce = challengeResponse.json().nonce as string;
  const signature = signWithKey(
    "sha256",
    Buffer.from(buildSignatureMessage(device.deviceId, nonce), "utf8"),
    { key: device.privateKey, dsaEncoding: "der" },
  ).toString("base64");

  const tokenResponse = await app.inject({
    method: "POST",
    url: "/v1/device/auth/token",
    headers: {
      "content-type": "application/json",
      "x-gt-ads-api-version": "1",
    },
    payload: {
      device_id: device.deviceId,
      nonce,
      signature,
    },
    remoteAddress: "192.0.2.141",
  });
  expect(tokenResponse.statusCode).toBe(200);
  return tokenResponse.json().access_token as string;
}

interface EventPayload {
  event_id: string;
  occurred_at: string;
  vehicle_ready: boolean | null;
  paused: boolean | null;
  playback: "playing" | "stopped" | "unknown";
  technical_fault: boolean | null;
}

function event(overrides: Partial<EventPayload> = {}): EventPayload {
  return {
    event_id: randomUUID(),
    occurred_at: "2026-01-01T12:00:00.000Z",
    vehicle_ready: true,
    paused: false,
    playback: "playing",
    technical_fault: false,
    ...overrides,
  };
}

function postEvents(
  app: FastifyInstance,
  token: string | undefined,
  payload: unknown,
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-gt-ads-api-version": "1",
  };
  if (token !== undefined) {
    headers.authorization = "Bearer " + token;
  }
  return app.inject({
    method: "POST",
    url: DEVICE_EVENTS_PATH,
    headers,
    payload: payload as Record<string, unknown>,
    remoteAddress: "192.0.2.142",
  });
}

async function countRows(deviceId?: string): Promise<number> {
  const result =
    deviceId === undefined
      ? await pool.query<{ count: string }>(
          "select count(*)::text as count from telemetry_observations",
        )
      : await pool.query<{ count: string }>(
          "select count(*)::text as count from telemetry_observations where device_id = $1",
          [deviceId],
        );
  return Number(result.rows[0]?.count ?? "0");
}

interface StoredRow {
  event_id: string;
  occurred_at: Date;
  vehicle_ready: boolean | null;
  paused: boolean | null;
  playback: string;
  technical_fault: boolean | null;
  received_at: Date;
}

async function fetchRow(
  deviceId: string,
  eventId: string,
): Promise<StoredRow | null> {
  const result = await pool.query<StoredRow>(
    [
      "select event_id::text as event_id, occurred_at, vehicle_ready, paused,",
      "       playback, technical_fault, received_at",
      "  from telemetry_observations",
      " where device_id = $1 and event_id = $2",
    ].join(" "),
    [deviceId, eventId],
  );
  return result.rows[0] ?? null;
}

function errorCode(response: { json: () => any }): string {
  return response.json().error.code as string;
}

describe("CX-046 / R-401 idempotenter Tablet-Ereigniseingang", () => {
  it("speichert einen gueltigen Batch und erzeugt bei identischer und paralleler Wiederholung je Ereignis genau einen Datensatz", async () => {
    const app = await buildApp();
    const device = await registerDevice(app);
    const token = await accessToken(app, device);

    const events = [event(), event(), event()];
    const first = await postEvents(app, token, { events });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.accepted_event_ids).toHaveLength(3);
    expect(firstBody.inserted_event_ids).toHaveLength(3);
    expect(firstBody.duplicate_event_ids).toHaveLength(0);
    expect(new Set(firstBody.accepted_event_ids).size).toBe(3);
    expect([...firstBody.accepted_event_ids].sort()).toEqual(
      events.map((item) => item.event_id).sort(),
    );
    expect(await countRows(device.deviceId)).toBe(3);

    nowMs += 1000;
    const second = await postEvents(app, token, { events });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json();
    expect([...secondBody.accepted_event_ids].sort()).toEqual(
      [...firstBody.accepted_event_ids].sort(),
    );
    expect(secondBody.inserted_event_ids).toHaveLength(0);
    expect(secondBody.duplicate_event_ids).toHaveLength(3);
    expect(await countRows(device.deviceId)).toBe(3);

    nowMs += 1000;
    const parallel = await Promise.all(
      Array.from({ length: 5 }, () => postEvents(app, token, { events })),
    );
    for (const response of parallel) {
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect([...body.accepted_event_ids].sort()).toEqual(
        [...firstBody.accepted_event_ids].sort(),
      );
      expect(body.inserted_event_ids).toHaveLength(0);
      expect(body.duplicate_event_ids).toHaveLength(3);
    }
    expect(await countRows(device.deviceId)).toBe(3);

    const rows = await pool.query<{ event_id: string; count: string }>(
      [
        "select event_id::text as event_id, count(*)::text as count",
        "  from telemetry_observations",
        " where device_id = $1",
        " group by event_id",
      ].join(" "),
      [device.deviceId],
    );
    expect(rows.rows).toHaveLength(3);
    for (const row of rows.rows) {
      expect(row.count).toBe("1");
    }
  });

  it("weist fehlende und widerrufene Geraeteauthentifizierung sowie fremde Geraetekennungen ohne neue Rohereignisse ab", async () => {
    const app = await buildApp();
    const device = await registerDevice(app);
    const token = await accessToken(app, device);
    const events = [event(), event()];

    const missing = await postEvents(app, undefined, { events });
    expect(missing.statusCode).toBe(401);
    expect(errorCode(missing)).toBe("unauthorized");
    expect(await countRows()).toBe(0);

    const unknown = await postEvents(app, "SYN-CX046-unbekanntes-token", {
      events,
    });
    expect(unknown.statusCode).toBe(401);
    expect(await countRows()).toBe(0);

    const other = await registerDevice(app);
    const foreignEvents = [
      event(),
      { ...event(), device_id: other.deviceId },
    ];
    const foreign = await postEvents(app, token, { events: foreignEvents });
    expect(foreign.statusCode).toBe(400);
    expect(errorCode(foreign)).toBe("invalid_request");
    expect(await countRows()).toBe(0);

    await pool.query("update devices set state = 'revoked' where id = $1", [
      device.deviceId,
    ]);
    const revoked = await postEvents(app, token, { events });
    expect(revoked.statusCode).toBe(403);
    expect(errorCode(revoked)).toBe("device_revoked");
    expect(await countRows()).toBe(0);
  });

  it("validiert parametrisiert leeren Batch, mehr als 100 Ereignisse, Bodylimit, unbekannte Felder und ungueltige Zeitwerte ohne Teilwrite", async () => {
    const app = await buildApp();
    const device = await registerDevice(app);
    const token = await accessToken(app, device);
    const valid = event();

    const tooMany = Array.from({ length: 101 }, () => event());
    const oversizedPayload = {
      events: [valid],
      padding: "x".repeat(DEVICE_EVENTS_BODY_LIMIT_BYTES + 1024),
    };

    const scenarios: Array<{
      name: string;
      payload: unknown;
      status: number;
      code: string;
    }> = [
      { name: "leerer Batch", payload: { events: [] }, status: 400, code: "invalid_request" },
      { name: "mehr als 100 Ereignisse", payload: { events: tooMany }, status: 400, code: "invalid_request" },
      { name: "Bodylimit ueberschritten", payload: oversizedPayload, status: 413, code: "invalid_request" },
      {
        name: "unbekanntes Feld im Ereignis",
        payload: { events: [valid, { ...event(), zusatz: true }] },
        status: 400,
        code: "invalid_request",
      },
      {
        name: "unbekanntes Feld im Body",
        payload: { events: [valid], debug: true },
        status: 400,
        code: "invalid_request",
      },
      {
        name: "Zeitwert ohne Millisekunden",
        payload: { events: [event({ occurred_at: "2026-01-01T12:00:00Z" })] },
        status: 400,
        code: "invalid_request",
      },
      {
        name: "nicht existierender Kalendertag",
        payload: { events: [event({ occurred_at: "2026-02-30T12:00:00.000Z" })] },
        status: 400,
        code: "invalid_request",
      },
      {
        name: "Zeitwert mit Zeitzonenoffset",
        payload: { events: [event({ occurred_at: "2026-01-01T13:00:00.000+01:00" })] },
        status: 400,
        code: "invalid_request",
      },
    ];

    for (const scenario of scenarios) {
      const response = await postEvents(app, token, scenario.payload);
      expect(response.statusCode, scenario.name).toBe(scenario.status);
      expect(errorCode(response), scenario.name).toBe(scenario.code);
      expect(await countRows(), scenario.name).toBe(0);
    }

    // Gegenprobe: derselbe gueltige Batch wird nach den Fehlversuchen
    // vollstaendig gespeichert und nicht teilweise als Rest uebernommen.
    const accepted = await postEvents(app, token, { events: [valid] });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().inserted_event_ids).toEqual([valid.event_id]);
    expect(await countRows(device.deviceId)).toBe(1);
  });

  it("behaelt bei verspaeteten Ereignissen Ereignis- und Empfangszeit und ueberschreibt bei Konflikt nie das Original", async () => {
    const app = await buildApp();
    const device = await registerDevice(app);
    const token = await accessToken(app, device);

    const late = event({ occurred_at: new Date(BASE_TIME - 6 * HOUR_MS).toISOString() });
    nowMs = BASE_TIME + 60 * 1000;
    const receivedAt = nowMs;

    const response = await postEvents(app, token, { events: [late] });
    expect(response.statusCode).toBe(200);
    expect(response.json().inserted_event_ids).toEqual([late.event_id]);

    const stored = await fetchRow(device.deviceId, late.event_id);
    expect(stored).not.toBeNull();
    expect(stored?.occurred_at.toISOString()).toBe(late.occurred_at);
    expect(stored?.received_at.getTime()).toBe(receivedAt);
    expect(stored?.playback).toBe("playing");

    // Identische Wiederholung bestaetigt nur das vorhandene Ereignis und
    // veraendert die Empfangszeit nicht.
    nowMs += 60 * 1000;
    const repeat = await postEvents(app, token, { events: [late] });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().inserted_event_ids).toHaveLength(0);
    expect(repeat.json().duplicate_event_ids).toEqual([late.event_id]);
    expect((await fetchRow(device.deviceId, late.event_id))?.received_at.getTime()).toBe(
      receivedAt,
    );

    // Dieselbe Ereignis-ID mit anderem Inhalt: CX-009-Konflikt, ganzer Batch
    // zurueck, Original bleibt unveraendert.
    const conflicting = { ...late, playback: "stopped" as const };
    const fresh = event();
    const conflict = await postEvents(app, token, {
      events: [conflicting, fresh],
    });
    expect(conflict.statusCode).toBe(409);
    expect(errorCode(conflict)).toBe("invalid_request");

    const unchanged = await fetchRow(device.deviceId, late.event_id);
    expect(unchanged?.playback).toBe("playing");
    expect(unchanged?.occurred_at.toISOString()).toBe(late.occurred_at);
    expect(unchanged?.received_at.getTime()).toBe(receivedAt);
    expect(await countRows(device.deviceId)).toBe(1);
    expect(await fetchRow(device.deviceId, fresh.event_id)).toBeNull();
  });
});

