import {
  generateKeyPairSync,
  randomUUID,
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
import { migrateUp } from "../../src/db/migrate.js";
import { createServer } from "../../src/http/server.js";
import { DevicesService } from "../../src/modules/devices/service.js";
import { RegistrationService } from "../../src/modules/registration/service.js";

const BASE_TIME = Date.parse("2026-01-01T12:00:00.000Z");
const THRESHOLD_SECONDS = 1800;

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
let devicesService: DevicesService;
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
  databaseName = ("gtads_u5_list_" + process.pid + "_" + Date.now().toString(36))
    .toLowerCase()
    .slice(0, 63);
  await maintenancePool.query("create database " + quoteIdentifier(databaseName));

  pool = new Pool({ ...base, database: databaseName });
  await migrateUp(pool);

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-U5-List-Pepper",
    adminPasswordHash:
      "scrypt$N=16384,r=8,p=1$c3ludGhldGlzY2hlLXNhbHQ$aGFzaC1oYXNoLWhhc2gtaGFzaC1oYXNo",
    onlineThresholdSeconds: THRESHOLD_SECONDS,
  };
  registrationService = new RegistrationService({ pool, config, now: clock });
  devicesService = new DevicesService({ pool, config, now: clock });
}, 30_000);

beforeEach(async () => {
  nowMs = BASE_TIME;
  await pool.query(
    [
      "truncate table audit_events, device_access_tokens,",
      "  device_auth_challenges, registration_codes, devices",
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
  const app = createServer({ config, pool, now: clock });
  await app.ready();
  openApps.push(app);
  return app;
}

async function registerDevice(
  app: FastifyInstance,
  label: string,
): Promise<string> {
  const created = await registrationService.createRegistrationCode({ label });
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
    remoteAddress: "192.0.2.94",
  });
  expect(response.statusCode).toBe(201);
  return response.json().device_id as string;
}

describe("U5 Geraeteliste und Status (I-23, AC-10)", () => {
  it("leere Datenbank ergibt items: []", async () => {
    const result = await devicesService.listDevices();
    expect(result.items).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.serverTime.getTime()).toBe(BASE_TIME);
    expect(result.onlineThresholdSeconds).toBe(THRESHOLD_SECONDS);
  });

  it("nach Registrierung genau ein Eintrag mit Vertragsfeldern", async () => {
    const app = await buildApp();
    const deviceId = await registerDevice(app, "SYN-Testhandy");

    const result = await devicesService.listDevices();
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item?.id).toBe(deviceId);
    expect(item?.label).toBe("SYN-Testhandy");
    expect(item?.manufacturer).toBe("SYN-Hersteller");
    expect(item?.model).toBe("SYN-Modell");
    expect(item?.osVersion).toBe("14");
    expect(item?.sdkInt).toBe(34);
    expect(item?.appVersion).toBe("0.1.0");
    expect(item?.appFlavor).toBe("dev");
    expect(item?.state).toBe("active");
    expect(item?.registeredAt.getTime()).toBe(BASE_TIME);
    expect(item?.lastSeenAt.getTime()).toBe(BASE_TIME);
    expect(item?.connectivity).toBe("reachable");
  });

  it("connectivity an der Schwelle: gleich = reachable, +1 ms = last_seen", async () => {
    const app = await buildApp();
    await registerDevice(app, "SYN-Grenzfall");

    nowMs = BASE_TIME + THRESHOLD_SECONDS * 1000;
    let result = await devicesService.listDevices();
    expect(result.items[0]?.connectivity).toBe("reachable");

    nowMs += 1;
    result = await devicesService.listDevices();
    expect(result.items[0]?.connectivity).toBe("last_seen");
    // last_seen_at bleibt der gespeicherte Kontaktzeitpunkt.
    expect(result.items[0]?.lastSeenAt.getTime()).toBe(BASE_TIME);
  });

  it("Sortierung nach last_seen_at absteigend", async () => {
    const app = await buildApp();
    const firstId = await registerDevice(app, "SYN-Erstes");

    nowMs = BASE_TIME + 10_000;
    const secondId = await registerDevice(app, "SYN-Zweites");

    const result = await devicesService.listDevices();
    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.id)).toEqual([secondId, firstId]);
    expect(result.items[0]?.lastSeenAt.getTime()).toBe(BASE_TIME + 10_000);
    expect(result.items[1]?.lastSeenAt.getTime()).toBe(BASE_TIME);
  });

  it("gesperrtes Geraet bleibt in der Liste und traegt state revoked", async () => {
    const app = await buildApp();
    const deviceId = await registerDevice(app, "SYN-Gesperrt");
    await pool.query(
      "update devices set state = 'revoked', revoked_at = $2, revoked_by = 'SYN-Admin' where id = $1",
      [deviceId, clock()],
    );

    const result = await devicesService.listDevices();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.state).toBe("revoked");
    expect(result.items[0]?.connectivity).toBe("reachable");
  });
});
