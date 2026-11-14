/**
 * CX-054 / R-503: Integrationsnachweis des geraetegebundenen Pausenabrufs und
 * der Quittierung.
 *
 * Alle Faelle laufen ueber die echte Serverfabrik, echte U4-Geraetetokens,
 * echte Admin-Sitzungen und eine echte PostgreSQL-Datenbank. Es gibt keine
 * Repository-Mocks: Auftrag, Revision, Zustellungen und Quittungszeiten werden
 * nach jeder Anfrage direkt in PostgreSQL geprueft.
 *
 * Die Wiederverbindung wird durch eine neue App-Instanz auf derselben
 * Testdatenbank simuliert; der gespeicherte Auftrag und die gespeicherten
 * Tokens bleiben erhalten.
 */
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
import { hashPassword } from "../../src/crypto/password.js";
import { migrateUp } from "../../src/db/migrate.js";
import { getRoutePolicyInventory } from "../../src/http/authorization.js";
import { createServer } from "../../src/http/server.js";
import { ADMIN_SESSION_COOKIE } from "../../src/modules/adminAuth/middleware.js";
import { RegistrationService } from "../../src/modules/registration/service.js";
import { ensureTaxiActivationSchema } from "../../src/modules/taxiActivation/index.js";
import {
  DEVICE_COMMANDS_ACK_PATH,
  DEVICE_COMMANDS_PATH,
} from "../../src/http/deviceCommands.js";

const BASE_TIME = Date.parse("2026-11-14T12:00:00.000Z");
const OFFLINE_MS = 6 * 60 * 60 * 1000;
const ADMIN_PASSWORD = "SYN-CX054-Geraetebefehl-Passwort";
const HOST = "127.0.0.1:8080";
const JSON_HEADERS = { "content-type": "application/json" };
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
const openApps: FastifyInstance[] = [];

interface TestDevice {
  deviceId: string;
  privateKey: KeyObject;
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
    throw new Error("CX-054 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

async function readMigration(name: string): Promise<string> {
  return readFile(join(MIGRATIONS_DIR, name), "utf8");
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx054_commands_" +
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
    registrationCodePepper: "SYN-CX054-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
    // Die simulierte Offlinephase liegt innerhalb der Token-Lebensdauer.
    accessTokenTtlSeconds: 7 * 24 * 60 * 60,
  };
  registrationService = new RegistrationService({ pool, config, now: () => new Date(BASE_TIME) });
}, 60_000);

beforeEach(async () => {
  await pool.query(
    "truncate table audit_events, remote_control_deliveries," +
      " remote_control_commands, remote_control_taxi_state," +
      " device_taxi_assignments, taxis, device_access_tokens," +
      " device_auth_challenges, devices, registration_codes," +
      " admin_sessions restart identity cascade",
  );
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
}, 30_000);

async function buildApp(nowMs: number = BASE_TIME): Promise<FastifyInstance> {
  const app = createServer({
    config,
    pool,
    now: () => new Date(nowMs),
    logger: { level: "silent" },
  });
  await app.ready();
  openApps.push(app);
  return app;
}

async function closeApp(app: FastifyInstance): Promise<void> {
  const index = openApps.indexOf(app);
  if (index >= 0) {
    openApps.splice(index, 1);
  }
  await app.close();
}

async function registerDevice(app: FastifyInstance): Promise<TestDevice> {
  const created = await registrationService.createRegistrationCode({
    label: "SYN-CX054-Tablet",
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
    remoteAddress: "192.0.2.54",
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
    remoteAddress: "192.0.2.55",
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
    remoteAddress: "192.0.2.55",
  });
  expect(tokenResponse.statusCode).toBe(200);
  return tokenResponse.json().access_token as string;
}

async function loginCookie(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/login",
    headers: { host: HOST, ...JSON_HEADERS },
    payload: { password: ADMIN_PASSWORD },
    remoteAddress: "192.0.2.254",
  });
  expect(response.statusCode).toBe(204);
  const raw = response.headers["set-cookie"];
  const first = Array.isArray(raw)
    ? (raw[0] as string)
    : (raw as string | undefined);
  expect(first, "Set-Cookie fehlt").toBeTruthy();
  return (first as string).split(";")[0]!.slice(ADMIN_SESSION_COOKIE.length + 1);
}

function adminHeaders(cookie: string): Record<string, string> {
  return {
    host: HOST,
    ...JSON_HEADERS,
    cookie: ADMIN_SESSION_COOKIE + "=" + cookie,
  };
}

async function insertTaxi(taxiId: string): Promise<void> {
  await pool.query(
    "insert into taxis (id, display_name, active, revision) values ($1, $2, false, 1)",
    [taxiId, "SYN " + taxiId],
  );
}

async function assign(taxiId: string, deviceId: string): Promise<void> {
  await pool.query(
    "insert into device_taxi_assignments (device_id, taxi_id, active, updated_at)" +
      " values ($1::uuid, $2, true, $3)",
    [deviceId, taxiId, new Date(BASE_TIME)],
  );
}

async function postPause(
  app: FastifyInstance,
  cookie: string,
  taxiId: string,
  action: "pause" | "resume",
  payload: { command_id: string; expected_revision: number },
): Promise<{ statusCode: number; json: () => any }> {
  return app.inject({
    method: "POST",
    url: "/v1/admin/taxis/" + encodeURIComponent(taxiId) + "/" + action,
    headers: adminHeaders(cookie),
    payload,
  });
}

function deviceHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "x-gt-ads-api-version": "1",
  };
  if (token !== undefined) {
    headers.authorization = "Bearer " + token;
  }
  return headers;
}

async function getCommands(
  app: FastifyInstance,
  token: string | undefined,
): Promise<{ statusCode: number; json: () => any }> {
  return app.inject({
    method: "GET",
    url: DEVICE_COMMANDS_PATH,
    headers: deviceHeaders(token),
  });
}

async function ackCommand(
  app: FastifyInstance,
  token: string | undefined,
  payload: unknown,
): Promise<{ statusCode: number; json: () => any }> {
  return app.inject({
    method: "POST",
    url: DEVICE_COMMANDS_ACK_PATH,
    headers: token === undefined
      ? { ...JSON_HEADERS, "x-gt-ads-api-version": "1" }
      : { ...JSON_HEADERS, ...deviceHeaders(token) },
    payload: payload as Record<string, unknown>,
  });
}

interface PauseStateRow {
  revision: number;
  desired_paused: boolean;
}

async function pauseState(taxiId: string): Promise<PauseStateRow | undefined> {
  const result = await pool.query<PauseStateRow>(
    "select revision::int as revision, desired_paused" +
      " from remote_control_taxi_state where taxi_id = $1",
    [taxiId],
  );
  return result.rows[0];
}

interface DeliveryRow {
  device_id: string;
  command_id: string;
  revision: number;
  status: string;
  acknowledged_at: Date | null;
}

async function deliveries(taxiId: string): Promise<DeliveryRow[]> {
  const result = await pool.query<DeliveryRow>(
    "select device_id::text as device_id, command_id::text as command_id," +
      " revision::int as revision, status, acknowledged_at" +
      " from remote_control_deliveries where taxi_id = $1" +
      " order by revision asc, device_id asc",
    [taxiId],
  );
  return result.rows;
}

async function snapshot(): Promise<string> {
  const result = await pool.query<Record<string, unknown>>(
    [
      "select",
      "  (select coalesce(json_agg(c order by c.revision, c.command_id), '[]'::json)",
      "     from (select command_id, taxi_id, revision, desired_paused, origin,",
      "                  actor_id, content_fingerprint from remote_control_commands) c) as commands,",
      "  (select coalesce(json_agg(d order by d.revision, d.device_id), '[]'::json)",
      "     from (select command_id, taxi_id, device_id, revision, status,",
      "                  acknowledged_at, superseded_at from remote_control_deliveries) d) as deliveries,",
      "  (select coalesce(json_agg(s order by s.taxi_id), '[]'::json)",
      "     from (select taxi_id, revision, desired_paused from remote_control_taxi_state) s) as state,",
      "  (select count(*)::int from audit_events) as audit_count",
    ].join("\n"),
  );
  return JSON.stringify(result.rows[0]);
}

function deliveryFor(
  rows: DeliveryRow[],
  deviceId: string,
  revision: number,
): DeliveryRow {
  const row = rows.find(
    (candidate) =>
      candidate.device_id === deviceId && candidate.revision === revision,
  );
  if (row === undefined) {
    throw new Error("Zustellung fehlt im Test");
  }
  return row;
}

async function setupTaxiWithTablets(
  app: FastifyInstance,
  taxiId: string,
): Promise<{ taxiId: string; first: TestDevice; second: TestDevice }> {
  await insertTaxi(taxiId);
  const first = await registerDevice(app);
  const second = await registerDevice(app);
  await assign(taxiId, first.deviceId);
  await assign(taxiId, second.deviceId);
  return { taxiId, first, second };
}

describe("CX-054 geraetegebundener Befehlsabruf und Quittierung", () => {
  it("liefert nach Offlinephase und neuer App-Instanz den gespeicherten Pausenauftrag; Abrufen allein quittiert nichts", async () => {
    const app1 = await buildApp();
    const taxi = await setupTaxiWithTablets(app1, "SYN-CX054-TAXI-A");
    const token = await accessToken(app1, taxi.first);
    const cookie = await loginCookie(app1);
    const commandId = randomUUID();

    const paused = await postPause(app1, cookie, taxi.taxiId, "pause", {
      command_id: commandId,
      expected_revision: 0,
    });
    expect(paused.statusCode).toBe(202);
    expect(paused.json()).toMatchObject({
      command_id: commandId,
      revision: 1,
      desired_paused: true,
      acknowledgements_pending: true,
    });

    const beforeOffline = await snapshot();
    expect(await deliveries(taxi.taxiId)).toHaveLength(2);
    expect(
      (await deliveries(taxi.taxiId)).every(
        (row) => row.status === "pending" && row.acknowledged_at === null,
      ),
    ).toBe(true);

    // Offlinephase: keine Anfrage; anschliessend neue App-Instanz auf
    // derselben Datenbank und mit derselben gespeicherten Geraeteidentitaet.
    await closeApp(app1);
    const app2 = await buildApp(BASE_TIME + OFFLINE_MS);

    const firstRead = await getCommands(app2, token);
    expect(firstRead.statusCode).toBe(200);
    expect(firstRead.json()).toEqual({
      commands: [
        {
          command_id: commandId,
          revision: 1,
          desired_paused: true,
        },
      ],
      taxi_fully_applied: false,
    });

    const repeatedRead = await getCommands(app2, token);
    expect(repeatedRead.statusCode).toBe(200);
    expect(repeatedRead.json()).toEqual(firstRead.json());

    // Reines Abrufen veraendert weder Auftrag, Zustellung noch Sollzustand.
    expect(await snapshot()).toBe(beforeOffline);
    const rows = await deliveries(taxi.taxiId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "pending")).toBe(true);
    expect(rows.every((row) => row.acknowledged_at === null)).toBe(true);
    expect(await pauseState(taxi.taxiId)).toEqual({
      revision: 1,
      desired_paused: true,
    });
  }, 60_000);

  it("laesst nach Quittierung durch Tablet A Tablet B ausstehend; erst beide Bestaetigungen der aktuellen Revision ergeben taxiweit ausgefuehrt", async () => {
    const app = await buildApp();
    const taxi = await setupTaxiWithTablets(app, "SYN-CX054-TAXI-B");
    const tokenFirst = await accessToken(app, taxi.first);
    const tokenSecond = await accessToken(app, taxi.second);
    const cookie = await loginCookie(app);
    const commandId = randomUUID();

    const paused = await postPause(app, cookie, taxi.taxiId, "pause", {
      command_id: commandId,
      expected_revision: 0,
    });
    expect(paused.statusCode).toBe(202);

    const firstAck = await ackCommand(app, tokenFirst, {
      command_id: commandId,
      revision: 1,
    });
    expect(firstAck.statusCode).toBe(200);
    expect(firstAck.json()).toEqual({
      status: "acknowledged",
      command_id: commandId,
      revision: 1,
      duplicate: false,
      taxi_fully_applied: false,
    });

    const afterFirst = await deliveries(taxi.taxiId);
    expect(deliveryFor(afterFirst, taxi.first.deviceId, 1).status).toBe(
      "applied",
    );
    expect(deliveryFor(afterFirst, taxi.second.deviceId, 1).status).toBe(
      "pending",
    );

    const secondStillPending = await getCommands(app, tokenSecond);
    expect(secondStillPending.statusCode).toBe(200);
    expect(secondStillPending.json()).toEqual({
      commands: [
        {
          command_id: commandId,
          revision: 1,
          desired_paused: true,
        },
      ],
      taxi_fully_applied: false,
    });

    const firstHasNothingPending = await getCommands(app, tokenFirst);
    expect(firstHasNothingPending.json()).toEqual({
      commands: [],
      taxi_fully_applied: false,
    });

    const secondAck = await ackCommand(app, tokenSecond, {
      command_id: commandId,
      revision: 1,
    });
    expect(secondAck.statusCode).toBe(200);
    expect(secondAck.json()).toEqual({
      status: "acknowledged",
      command_id: commandId,
      revision: 1,
      duplicate: false,
      taxi_fully_applied: true,
    });

    const afterBoth = await deliveries(taxi.taxiId);
    expect(afterBoth.every((row) => row.status === "applied")).toBe(true);
    expect(afterBoth.every((row) => row.acknowledged_at !== null)).toBe(true);
    expect(await pauseState(taxi.taxiId)).toEqual({
      revision: 1,
      desired_paused: true,
    });
    expect((await getCommands(app, tokenFirst)).json()).toEqual({
      commands: [],
      taxi_fully_applied: true,
    });
    expect((await getCommands(app, tokenSecond)).json()).toEqual({
      commands: [],
      taxi_fully_applied: true,
    });
  }, 60_000);

  it("macht doppelte Quittierungen wirkungslos, setzt keinen Stand zurueck, bestaetigt keinen neueren Auftrag und weist zukuenftige Revisionen ab", async () => {
    const app = await buildApp();
    const taxi = await setupTaxiWithTablets(app, "SYN-CX054-TAXI-C");
    const tokenFirst = await accessToken(app, taxi.first);
    const tokenSecond = await accessToken(app, taxi.second);
    const cookie = await loginCookie(app);
    const pauseCommand = randomUUID();

    expect(
      (
        await postPause(app, cookie, taxi.taxiId, "pause", {
          command_id: pauseCommand,
          expected_revision: 0,
        })
      ).statusCode,
    ).toBe(202);
    expect(
      (
        await ackCommand(app, tokenFirst, {
          command_id: pauseCommand,
          revision: 1,
        })
      ).statusCode,
    ).toBe(200);
    const beforeDuplicate = await snapshot();
    const duplicate = await ackCommand(app, tokenFirst, {
      command_id: pauseCommand,
      revision: 1,
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({
      command_id: pauseCommand,
      revision: 1,
      duplicate: true,
      // Tablet B hat Revision 1 noch nicht bestaetigt.
      taxi_fully_applied: false,
    });
    expect(await snapshot()).toBe(beforeDuplicate);

    // Neuerer Auftrag: Fortsetzen als Revision 2.
    const resumeCommand = randomUUID();
    const resumed = await postPause(app, cookie, taxi.taxiId, "resume", {
      command_id: resumeCommand,
      expected_revision: 1,
    });
    expect(resumed.statusCode).toBe(202);
    expect(resumed.json()).toMatchObject({
      command_id: resumeCommand,
      revision: 2,
      desired_paused: false,
    });

    const beforeLate = await snapshot();
    const lateApplied = await ackCommand(app, tokenFirst, {
      command_id: pauseCommand,
      revision: 1,
    });
    expect(lateApplied.statusCode).toBe(200);
    expect(lateApplied.json()).toMatchObject({
      command_id: pauseCommand,
      revision: 1,
      duplicate: true,
      // Revision 2 ist weiterhin ausstehend.
      taxi_fully_applied: false,
    });
    expect(await snapshot()).toBe(beforeLate);

    // Tablet B hat Revision 1 nie bestaetigt; sie wurde beim neuen Auftrag
    // ueberholt und darf nicht nachtraeglich als ausgefuehrt gelten.
    const lateSuperseded = await ackCommand(app, tokenSecond, {
      command_id: pauseCommand,
      revision: 1,
    });
    expect(lateSuperseded.statusCode).toBe(409);
    expect(lateSuperseded.json().error.code).toBe("invalid_request");
    expect(await snapshot()).toBe(beforeLate);

    // Zukuenftige Revision und falsche Auftragsbindung werden abgewiesen.
    const futureRevision = await ackCommand(app, tokenFirst, {
      command_id: resumeCommand,
      revision: 3,
    });
    expect(futureRevision.statusCode).toBe(409);
    expect(futureRevision.json().error.code).toBe("invalid_request");
    expect(await snapshot()).toBe(beforeLate);

    const wrongBinding = await ackCommand(app, tokenFirst, {
      command_id: resumeCommand,
      revision: 1,
    });
    expect(wrongBinding.statusCode).toBe(409);
    expect(wrongBinding.json().error.code).toBe("invalid_request");
    expect(await snapshot()).toBe(beforeLate);

    const rows = await deliveries(taxi.taxiId);
    expect(deliveryFor(rows, taxi.first.deviceId, 2).status).toBe("pending");
    expect(deliveryFor(rows, taxi.second.deviceId, 2).status).toBe("pending");
    expect(await pauseState(taxi.taxiId)).toEqual({
      revision: 2,
      desired_paused: false,
    });

    // Erst die beiden Bestaetigungen der aktuellen Revision 2 ergeben
    // taxiweit ausgefuehrt; die spaete Revision 1 hat nichts vorgezogen.
    const firstRev2 = await ackCommand(app, tokenFirst, {
      command_id: resumeCommand,
      revision: 2,
    });
    expect(firstRev2.statusCode).toBe(200);
    expect(firstRev2.json()).toMatchObject({
      command_id: resumeCommand,
      revision: 2,
      duplicate: false,
      taxi_fully_applied: false,
    });
    const secondRev2 = await ackCommand(app, tokenSecond, {
      command_id: resumeCommand,
      revision: 2,
    });
    expect(secondRev2.statusCode).toBe(200);
    expect(secondRev2.json()).toMatchObject({
      command_id: resumeCommand,
      revision: 2,
      duplicate: false,
      taxi_fully_applied: true,
    });
  }, 60_000);

  it("weist anonyme, widerrufene und fremde Geraete/Taxis ohne Datenaenderung ab und katalogisiert beide Routen als Geraetezugriff", async () => {
    const app = await buildApp();
    const taxiA = await setupTaxiWithTablets(app, "SYN-CX054-TAXI-D");
    const taxiB = await setupTaxiWithTablets(app, "SYN-CX054-TAXI-E");
    const tokenA = await accessToken(app, taxiA.first);
    const tokenB = await accessToken(app, taxiB.first);
    const cookie = await loginCookie(app);

    const commandA = randomUUID();
    const commandB = randomUUID();
    expect(
      (
        await postPause(app, cookie, taxiA.taxiId, "pause", {
          command_id: commandA,
          expected_revision: 0,
        })
      ).statusCode,
    ).toBe(202);
    expect(
      (
        await postPause(app, cookie, taxiB.taxiId, "pause", {
          command_id: commandB,
          expected_revision: 0,
        })
      ).statusCode,
    ).toBe(202);

    const before = await snapshot();

    // Anonym: weder Abruf noch Quittung.
    const anonymousGet = await getCommands(app, undefined);
    expect(anonymousGet.statusCode).toBe(401);
    expect(anonymousGet.json().error.code).toBe("unauthorized");

    const anonymousAck = await ackCommand(app, undefined, {
      command_id: commandA,
      revision: 1,
    });
    expect(anonymousAck.statusCode).toBe(401);
    expect(anonymousAck.json().error.code).toBe("unauthorized");

    // Admin-Cookie ist keine Geraeteauthentifizierung.
    const cookieOnly = await app.inject({
      method: "GET",
      url: DEVICE_COMMANDS_PATH,
      headers: adminHeaders(cookie),
    });
    expect(cookieOnly.statusCode).toBe(401);
    expect(cookieOnly.json().error.code).toBe("unauthorized");

    // Fremdes Taxi/fremdes Tablet: Auftrag aus Taxi B mit Token von Tablet A1.
    const foreignTaxi = await ackCommand(app, tokenA, {
      command_id: commandB,
      revision: 1,
    });
    expect(foreignTaxi.statusCode).toBe(409);
    expect(foreignTaxi.json().error.code).toBe("invalid_request");

    const foreignTablet = await ackCommand(app, tokenB, {
      command_id: commandA,
      revision: 1,
    });
    expect(foreignTablet.statusCode).toBe(409);
    expect(foreignTablet.json().error.code).toBe("invalid_request");

    expect(await snapshot()).toBe(before);

    // Widerruf wirkt vor dem Fachhandler und ohne Datenbezug.
    await pool.query("update devices set state = 'revoked' where id = $1", [
      taxiA.first.deviceId,
    ]);
    const revokedGet = await getCommands(app, tokenA);
    expect(revokedGet.statusCode).toBe(403);
    expect(revokedGet.json().error.code).toBe("device_revoked");

    const revokedAck = await ackCommand(app, tokenA, {
      command_id: commandA,
      revision: 1,
    });
    expect(revokedAck.statusCode).toBe(403);
    expect(revokedAck.json().error.code).toBe("device_revoked");

    expect(await snapshot()).toBe(before);
    const rows = await deliveries(taxiA.taxiId);
    expect(rows.every((row) => row.status === "pending")).toBe(true);
    expect(rows.every((row) => row.acknowledged_at === null)).toBe(true);

    // Explizite Geraetepolitik, keine menschliche/admin-Cookie-Policy.
    const inventory = getRoutePolicyInventory(app);
    for (const key of [
      "GET " + DEVICE_COMMANDS_PATH,
      "POST " + DEVICE_COMMANDS_ACK_PATH,
    ]) {
      const record = inventory.find(
        (candidate) => candidate.method + " " + candidate.url === key,
      );
      expect(record, "Route fehlt im Inventar: " + key).toBeTruthy();
      expect(record?.policy?.category).toBe("device");
    }
  }, 60_000);
});
