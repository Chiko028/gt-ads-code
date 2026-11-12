import {
  generateKeyPairSync,
  randomUUID,
  sign as signWithKey,
  type KeyObject,
} from "node:crypto";
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
import type { SqlQueryable } from "../../src/modules/audit/repository.js";
import { recordHeartbeat } from "../../src/modules/heartbeat/repository.js";

const BASE_TIME = Date.parse("2026-01-01T12:00:00.000Z");
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

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
    throw new Error("GT-ADS-001 U5 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = ("gtads_u5_" + process.pid + "_" + Date.now().toString(36))
    .toLowerCase()
    .slice(0, 63);
  await maintenancePool.query("create database " + quoteIdentifier(databaseName));

  pool = new Pool({ ...base, database: databaseName });
  await migrateUp(pool);

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-U5-Code-Pepper",
    adminPasswordHash:
      "scrypt$N=16384,r=8,p=1$c3ludGhldGlzY2hlLXNhbHQ$aGFzaC1oYXNoLWhhc2gtaGFzaC1oYXNo",
  };
  registrationService = new RegistrationService({ pool, config, now: clock });
}, 30_000);

beforeEach(() => {
  nowMs = BASE_TIME;
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
  const app = createServer({ config, pool, now: clock });
  await app.ready();
  openApps.push(app);
  return app;
}

interface TestDevice {
  deviceId: string;
  privateKey: KeyObject;
  spki: string;
}

async function registerDevice(app: FastifyInstance): Promise<TestDevice> {
  const created = await registrationService.createRegistrationCode({
    label: "SYN-U5-Testhandy",
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
    remoteAddress: "192.0.2.90",
  });
  expect(response.statusCode).toBe(201);
  return {
    deviceId: response.json().device_id as string,
    privateKey: pair.privateKey,
    spki,
  };
}

function signNonce(
  privateKey: KeyObject,
  deviceId: string,
  nonce: string,
): string {
  return signWithKey(
    "sha256",
    Buffer.from(buildSignatureMessage(deviceId, nonce), "utf8"),
    { key: privateKey, dsaEncoding: "der" },
  ).toString("base64");
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
    remoteAddress: "192.0.2.91",
  });
  expect(challengeResponse.statusCode).toBe(200);
  const nonce = challengeResponse.json().nonce as string;

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
      signature: signNonce(device.privateKey, device.deviceId, nonce),
    },
    remoteAddress: "192.0.2.91",
  });
  expect(tokenResponse.statusCode).toBe(200);
  return tokenResponse.json().access_token as string;
}

interface HeartbeatPayload {
  seq: number;
  device_time: string;
  app_version: string;
  os_version: string;
}

function heartbeat(
  app: FastifyInstance,
  token: string | undefined,
  payload: HeartbeatPayload | Record<string, unknown>,
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
    url: "/v1/device/heartbeat",
    headers,
    payload,
    remoteAddress: "192.0.2.92",
  });
}

async function deviceRow(deviceId: string): Promise<{
  last_seen_at: Date;
  last_seq: string;
  last_clock_offset_ms: string | null;
}> {
  const result = await pool.query<{
    last_seen_at: Date;
    last_seq: string;
    last_clock_offset_ms: string | null;
  }>(
    "select last_seen_at, last_seq::text as last_seq, last_clock_offset_ms::text as last_clock_offset_ms from devices where id = $1",
    [deviceId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Gerät fehlt in der Datenbank");
  }
  return row;
}

function errorCode(response: { json: () => any }): string {
  return response.json().error.code;
}

describe("U5 Heartbeat (I-16, I-17)", () => {
  it("I-16 last_seen_at ist Serverzeit, unabhaengig von der Geraetezeit; clock_offset wird gesetzt (AC-09)", async () => {
    const app = await buildApp();
    const device = await registerDevice(app);
    const token = await accessToken(app, device);

    const serverTimeA = nowMs;
    // Geraeteuhr laeuft ein Jahr vor.
    const futureDeviceTime = new Date(nowMs + YEAR_MS).toISOString();
    const responseA = await heartbeat(app, token, {
      seq: 1,
      device_time: futureDeviceTime,
      app_version: "0.1.0",
      os_version: "14",
    });
    expect(responseA.statusCode).toBe(200);
    const bodyA = responseA.json();
    expect(bodyA.server_time).toBe(new Date(serverTimeA).toISOString());
    expect(bodyA.device_state).toBe("active");
    expect(bodyA.config.heartbeat_interval_s).toBe(
      config.heartbeatIntervalSeconds,
    );

    const rowA = await deviceRow(device.deviceId);
    expect(new Date(rowA.last_seen_at).getTime()).toBe(serverTimeA);
    expect(rowA.last_clock_offset_ms).toBe(String(-YEAR_MS));

    // Geraeteuhr laeuft ein Jahr nach; last_seen_at bleibt Serverzeit.
    nowMs += 60_000;
    const serverTimeB = nowMs;
    const pastDeviceTime = new Date(nowMs - YEAR_MS).toISOString();
    const responseB = await heartbeat(app, token, {
      seq: 2,
      device_time: pastDeviceTime,
      app_version: "0.1.0",
      os_version: "14",
    });
    expect(responseB.statusCode).toBe(200);
    expect(responseB.json().server_time).toBe(
      new Date(serverTimeB).toISOString(),
    );

    const rowB = await deviceRow(device.deviceId);
    expect(new Date(rowB.last_seen_at).getTime()).toBe(serverTimeB);
    expect(rowB.last_clock_offset_ms).toBe(String(YEAR_MS));
  });

  it("I-17 seq kleiner oder gleich setzt last_seq nicht zurueck, last_seen_at wird trotzdem gesetzt (AC-09)", async () => {
    const app = await buildApp();
    const device = await registerDevice(app);
    const token = await accessToken(app, device);

    const send = async (seq: number, deviceTimeMs: number) => {
      const response = await heartbeat(app, token, {
        seq,
        device_time: new Date(deviceTimeMs).toISOString(),
        app_version: "0.1.0",
        os_version: "14",
      });
      expect(response.statusCode).toBe(200);
    };

    await send(5, nowMs);
    expect((await deviceRow(device.deviceId)).last_seq).toBe("5");

    nowMs += 1000;
    await send(5, nowMs);
    let row = await deviceRow(device.deviceId);
    expect(row.last_seq).toBe("5");
    expect(new Date(row.last_seen_at).getTime()).toBe(nowMs);

    nowMs += 1000;
    await send(3, nowMs);
    row = await deviceRow(device.deviceId);
    expect(row.last_seq).toBe("5");
    expect(new Date(row.last_seen_at).getTime()).toBe(nowMs);

    nowMs += 1000;
    await send(7, nowMs);
    row = await deviceRow(device.deviceId);
    expect(row.last_seq).toBe("7");
    expect(new Date(row.last_seen_at).getTime()).toBe(nowMs);
  });

  it("Nebenlaeufigkeit: ein frueher gestarteter Heartbeat setzt last_seen_at nicht zurueck", async () => {
    const app = await buildApp();
    const device = await registerDevice(app);

    const olderSeenAt = new Date(BASE_TIME + 1_000);
    const newerSeenAt = new Date(BASE_TIME + 2_000);

    // Der aeltere Aufruf startet zuerst, wird aber vor dem Datenbankzugriff
    // angehalten. Der neuere Aufruf laeuft zuerst durch; erst danach wird der
    // aeltere freigegeben. Damit ist die Ausfuehrungsreihenfolge der UPDATEs
    // umgekehrt zur Startreihenfolge.
    let releaseOlder!: () => void;
    const olderMayRun = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    let queryCount = 0;
    const delayedExecutor = {
      query: async (text: string, values?: unknown[]) => {
        queryCount += 1;
        if (queryCount === 1) {
          await olderMayRun;
        }
        return pool.query(text, values as unknown[]);
      },
    } as unknown as SqlQueryable;

    const olderUpdate = recordHeartbeat(delayedExecutor, {
      deviceId: device.deviceId,
      seenAt: olderSeenAt,
      seq: 1,
      clockOffsetMs: 0n,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(queryCount).toBe(1);

    const newerUpdate = await recordHeartbeat(pool, {
      deviceId: device.deviceId,
      seenAt: newerSeenAt,
      seq: 2,
      clockOffsetMs: 0n,
    });
    expect(newerUpdate).not.toBeNull();
    expect(new Date((await deviceRow(device.deviceId)).last_seen_at).getTime()).toBe(
      newerSeenAt.getTime(),
    );

    releaseOlder();
    expect(await olderUpdate).not.toBeNull();

    const row = await deviceRow(device.deviceId);
    expect(new Date(row.last_seen_at).getTime()).toBe(newerSeenAt.getTime());
    expect(row.last_seq).toBe("2");
  });

  it("ungueltiges oder gesperrtes Token wird abgewiesen (AC-08)", async () => {
    const app = await buildApp();
    const device = await registerDevice(app);
    const token = await accessToken(app, device);

    const withoutToken = await heartbeat(app, undefined, {
      seq: 1,
      device_time: new Date(nowMs).toISOString(),
      app_version: "0.1.0",
      os_version: "14",
    });
    expect(withoutToken.statusCode).toBe(401);
    expect(errorCode(withoutToken)).toBe("unauthorized");

    await pool.query("update devices set state = 'revoked' where id = $1", [
      device.deviceId,
    ]);
    const revoked = await heartbeat(app, token, {
      seq: 1,
      device_time: new Date(nowMs).toISOString(),
      app_version: "0.1.0",
      os_version: "14",
    });
    expect(revoked.statusCode).toBe(403);
    expect(errorCode(revoked)).toBe("device_revoked");
  });

  it("Formatfehler ergeben invalid_request, ohne den Status zu veraendern", async () => {
    const app = await buildApp();
    const device = await registerDevice(app);
    const token = await accessToken(app, device);
    const before = await deviceRow(device.deviceId);
    const valid = {
      seq: 1,
      device_time: new Date(nowMs).toISOString(),
      app_version: "0.1.0",
      os_version: "14",
    };

    const cases: Array<Record<string, unknown>> = [
      { ...valid, seq: -1 },
      { ...valid, seq: 1.5 },
      { ...valid, seq: "1" },
      { ...valid, device_time: "2026-01-01T12:00:00Z" },
      { ...valid, device_time: "keine-zeit" },
      { ...valid, app_version: "" },
      { ...valid, extra: true },
      { seq: 1, device_time: new Date(nowMs).toISOString(), app_version: "0.1.0" },
    ];

    for (const payload of cases) {
      const response = await heartbeat(app, token, payload);
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe("invalid_request");
    }

    const noApiVersion = await app.inject({
      method: "POST",
      url: "/v1/device/heartbeat",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + token,
      },
      payload: valid,
      remoteAddress: "192.0.2.93",
    });
    expect(noApiVersion.statusCode).toBe(400);
    expect(errorCode(noApiVersion)).toBe("invalid_request");

    const after = await deviceRow(device.deviceId);
    expect(new Date(after.last_seen_at).getTime()).toBe(
      new Date(before.last_seen_at).getTime(),
    );
    expect(after.last_seq).toBe(before.last_seq);
  });
});
