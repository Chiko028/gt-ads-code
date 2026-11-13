import {
  generateKeyPairSync,
  randomUUID,
  sign as signWithKey,
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
import { hashPassword } from "../../src/crypto/password.js";
import { migrateUp } from "../../src/db/migrate.js";
import { createServer } from "../../src/http/server.js";
import { ADMIN_SESSION_COOKIE } from "../../src/modules/adminAuth/middleware.js";
import { RegistrationService } from "../../src/modules/registration/service.js";

const BASE_TIME = Date.parse("2026-01-01T12:00:00.000Z");
const ADMIN_PASSWORD = "SYN-CX015-Sitzung-Passwort";
const HOST = "127.0.0.1:8080";

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
const nowMs = BASE_TIME;
const clock = (): Date => new Date(nowMs);
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
    throw new Error("CX-015 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx015_session_" +
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

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX015-Sitzung-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };
  registrationService = new RegistrationService({ pool, config, now: clock });
}, 60_000);

beforeEach(async () => {
  await pool.query(
    [
      "truncate table audit_events, admin_sessions, device_access_tokens,",
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

function adminHeaders(
  cookie?: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = { host: HOST, ...extra };
  if (cookie !== undefined) {
    headers.cookie = ADMIN_SESSION_COOKIE + "=" + cookie;
  }
  return headers;
}

function sessionCookieOf(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const first = Array.isArray(raw) ? (raw[0] as string) : (raw as string | undefined);
  expect(first, "Set-Cookie fehlt").toBeTruthy();
  const pair = (first as string).split(";")[0] as string;
  expect(pair.startsWith(ADMIN_SESSION_COOKIE + "=")).toBe(true);
  return pair.slice(ADMIN_SESSION_COOKIE.length + 1);
}

async function loginCookie(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/login",
    headers: { host: HOST, "content-type": "application/json" },
    payload: { password: ADMIN_PASSWORD },
    remoteAddress: "192.0.2.200",
  });
  expect(response.statusCode).toBe(204);
  return sessionCookieOf(response);
}

interface TestDevice {
  deviceId: string;
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
}

async function registerDevice(app: FastifyInstance): Promise<TestDevice> {
  const created = await registrationService.createRegistrationCode({
    label: "SYN-CX015-Testhandy",
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
    remoteAddress: "192.0.2.201",
  });
  expect(response.statusCode).toBe(201);
  return {
    deviceId: response.json().device_id as string,
    privateKey: pair.privateKey,
  };
}

async function obtainAccessToken(
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
    remoteAddress: "192.0.2.202",
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
    payload: { device_id: device.deviceId, nonce, signature },
    remoteAddress: "192.0.2.202",
  });
  expect(tokenResponse.statusCode).toBe(200);
  return tokenResponse.json().access_token as string;
}

function revoke(
  app: FastifyInstance,
  deviceId: string,
  headers: Record<string, string>,
  payload: unknown = {},
) {
  return app.inject({
    method: "POST",
    url: "/v1/admin/devices/" + deviceId + "/revoke",
    headers: { "content-type": "application/json", ...headers },
    payload: payload as Record<string, unknown>,
    remoteAddress: "192.0.2.210",
  });
}

async function deviceState(deviceId: string): Promise<string> {
  const result = await pool.query(
    "select state from devices where id = $1",
    [deviceId],
  );
  expect(result.rowCount).toBe(1);
  return result.rows[0].state as string;
}

describe("CX-015 Rechtekern: menschliche Sitzung", () => {
  it("laesst eine bestehende Admin-Anmeldung eine Verwaltungsaktion ausfuehren und weist fehlende, abgelaufene, ausgeloggte, Geraete- und Rollenfeld-Nachweise mit 401 ohne Fachmutation ab", async () => {
    const app = await buildApp();

    const allowed = await registerDevice(app);
    const cookie = await loginCookie(app);
    const applied = await revoke(app, allowed.deviceId, adminHeaders(cookie));
    expect(applied.statusCode).toBe(204);
    expect(await deviceState(allowed.deviceId)).toBe("revoked");

    // Fehlende Sitzung: 401 und keine Mutation. Die Pruefung greift vor der
    // Bodyverarbeitung; ungueltiges JSON darf kein 400 erzeugen.
    const missing = await registerDevice(app);
    const noSession = await revoke(app, missing.deviceId, { host: HOST });
    expect(noSession.statusCode).toBe(401);
    expect(noSession.json().error.code).toBe("unauthorized");
    expect(await deviceState(missing.deviceId)).toBe("active");

    const brokenBody = await app.inject({
      method: "POST",
      url: "/v1/admin/devices/" + missing.deviceId + "/revoke",
      headers: { host: HOST, "content-type": "application/json" },
      payload: "{",
      remoteAddress: "192.0.2.211",
    });
    expect(brokenBody.statusCode).toBe(401);
    expect(await deviceState(missing.deviceId)).toBe("active");

    // Abgelaufene Sitzung: der vorhandene Sitzungsresolver bleibt massgeblich.
    const expired = await registerDevice(app);
    const expiredCookie = await loginCookie(app);
    await pool.query("update admin_sessions set expires_at = $1", [
      new Date(BASE_TIME - 1_000),
    ]);
    const expiredResponse = await revoke(
      app,
      expired.deviceId,
      adminHeaders(expiredCookie),
    );
    expect(expiredResponse.statusCode).toBe(401);
    expect(await deviceState(expired.deviceId)).toBe("active");

    // Ausgeloggte Sitzung: Logout entfernt die Sitzung serverseitig.
    const loggedOut = await registerDevice(app);
    const logoutCookie = await loginCookie(app);
    const logout = await app.inject({
      method: "POST",
      url: "/v1/admin/logout",
      headers: adminHeaders(logoutCookie, { "content-type": "application/json" }),
      payload: {},
      remoteAddress: "192.0.2.212",
    });
    expect(logout.statusCode).toBe(204);
    const afterLogout = await revoke(
      app,
      loggedOut.deviceId,
      adminHeaders(logoutCookie),
    );
    expect(afterLogout.statusCode).toBe(401);
    expect(await deviceState(loggedOut.deviceId)).toBe("active");

    // Gueltiger Geraete-Bearer ist kein menschlicher Nachweis.
    const device = await registerDevice(app);
    const accessToken = await obtainAccessToken(app, device);
    const bearerOnly = await revoke(app, device.deviceId, {
      host: HOST,
      authorization: "Bearer " + accessToken,
    });
    expect(bearerOnly.statusCode).toBe(401);
    expect(await deviceState(device.deviceId)).toBe("active");

    // Manipulierte Rollenfelder (Header, Query, Body, Cookie) werden nicht
    // als menschliche Rolle uebernommen.
    const forged = await registerDevice(app);
    const manipulated = await revoke(
      app,
      forged.deviceId,
      {
        host: HOST,
        "x-gt-ads-role": "Admin",
        "x-role": "Admin",
        "x-forwarded-role": "Admin",
      },
      { role: "Admin" },
    );
    expect(manipulated.statusCode).toBe(401);
    expect(await deviceState(forged.deviceId)).toBe("active");

    const forgedHeader = await app.inject({
      method: "POST",
      url: "/v1/admin/devices/" + forged.deviceId + "/revoke?role=Admin",
      headers: { host: HOST, "content-type": "application/json" },
      payload: {},
      remoteAddress: "192.0.2.213",
    });
    expect(forgedHeader.statusCode).toBe(401);

    const forgedCookie = await app.inject({
      method: "POST",
      url: "/v1/admin/devices/" + forged.deviceId + "/revoke",
      headers: {
        host: HOST,
        "content-type": "application/json",
        cookie: ADMIN_SESSION_COOKIE + "=Admin",
      },
      payload: {},
      remoteAddress: "192.0.2.214",
    });
    expect(forgedCookie.statusCode).toBe(401);
    expect(await deviceState(forged.deviceId)).toBe("active");
  });
});
