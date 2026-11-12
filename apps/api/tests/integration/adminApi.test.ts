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
import { hashPassword } from "../../src/crypto/password.js";
import { hashToken } from "../../src/crypto/tokens.js";
import { cleanupExpiredAuthArtifacts } from "../../src/db/cleanup.js";
import { migrateUp } from "../../src/db/migrate.js";
import { API_ERROR_MESSAGES } from "../../src/http/errors.js";
import { isSensitiveFieldName } from "../../src/http/logging.js";
import { createServer } from "../../src/http/server.js";
import { ADMIN_SESSION_COOKIE } from "../../src/modules/adminAuth/middleware.js";
import { AUDIT_ACTIONS } from "../../src/modules/audit/repository.js";
import { RegistrationService } from "../../src/modules/registration/service.js";

const BASE_TIME = Date.parse("2026-01-01T12:00:00.000Z");
const THRESHOLD_SECONDS = 1800;
const ADMIN_PASSWORD = "SYN-U6-Admin-Passwort";
const HOST = "127.0.0.1:8080";
const ORIGIN = "http://" + HOST;

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
    throw new Error("GT-ADS-001 U6 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = ("gtads_u6_admin_" + process.pid + "_" + Date.now().toString(36))
    .toLowerCase()
    .slice(0, 63);
  await maintenancePool.query("create database " + quoteIdentifier(databaseName));

  pool = new Pool({ ...base, database: databaseName });
  await migrateUp(pool);

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-U6-Code-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
    onlineThresholdSeconds: THRESHOLD_SECONDS,
  };
  registrationService = new RegistrationService({ pool, config, now: clock });
}, 60_000);

beforeEach(async () => {
  nowMs = BASE_TIME;
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

function jsonWriteHeaders(cookie: string): Record<string, string> {
  return adminHeaders(cookie, { "content-type": "application/json" });
}

function sessionCookieOf(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const first = Array.isArray(raw) ? (raw[0] as string) : (raw as string | undefined);
  expect(first, "Set-Cookie fehlt").toBeTruthy();
  const pair = (first as string).split(";")[0] as string;
  expect(pair.startsWith(ADMIN_SESSION_COOKIE + "=")).toBe(true);
  return pair.slice(ADMIN_SESSION_COOKIE.length + 1);
}

async function login(
  app: FastifyInstance,
  password: string = ADMIN_PASSWORD,
) {
  return app.inject({
    method: "POST",
    url: "/v1/admin/login",
    headers: { host: HOST, "content-type": "application/json" },
    payload: { password },
    remoteAddress: "192.0.2.200",
  });
}

async function loginCookie(app: FastifyInstance): Promise<string> {
  const response = await login(app);
  expect(response.statusCode).toBe(204);
  return sessionCookieOf(response);
}

interface TestDevice {
  deviceId: string;
  privateKey: KeyObject;
  spki: string;
}

async function registerDevice(
  app: FastifyInstance,
  label: string = "SYN-U6-Testhandy",
): Promise<TestDevice> {
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
    remoteAddress: "192.0.2.201",
  });
  expect(response.statusCode).toBe(201);
  return {
    deviceId: response.json().device_id as string,
    privateKey: pair.privateKey,
    spki,
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

function heartbeat(app: FastifyInstance, accessToken: string, seq: number) {
  return app.inject({
    method: "POST",
    url: "/v1/device/heartbeat",
    headers: {
      "content-type": "application/json",
      "x-gt-ads-api-version": "1",
      authorization: "Bearer " + accessToken,
    },
    payload: {
      seq,
      device_time: new Date(nowMs).toISOString(),
      app_version: "0.1.0",
      os_version: "14",
    },
    remoteAddress: "192.0.2.203",
  });
}

function errorBody(response: { json: () => any }): {
  code: string;
  message: string;
  request_id: string;
} {
  return response.json().error;
}

async function createCodeViaAdmin(
  app: FastifyInstance,
  cookie: string,
  label?: string,
) {
  return app.inject({
    method: "POST",
    url: "/v1/admin/registration-codes",
    headers: jsonWriteHeaders(cookie),
    payload: label === undefined ? {} : { label },
    remoteAddress: "192.0.2.204",
  });
}

async function listDevices(app: FastifyInstance, cookie: string) {
  return app.inject({
    method: "GET",
    url: "/v1/admin/devices",
    headers: adminHeaders(cookie),
    remoteAddress: "192.0.2.205",
  });
}

describe("U6 Admin-API (I-18 bis I-23)", () => {
  it("I-18 Sperre wirkt sofort: Token 403, Challenge 403, Liste zeigt revoked", async () => {
    const app = await buildApp();
    const device = await registerDevice(app);
    const accessToken = await obtainAccessToken(app, device);
    expect((await heartbeat(app, accessToken, 1)).statusCode).toBe(200);

    const cookie = await loginCookie(app);
    const revoked = await app.inject({
      method: "POST",
      url: "/v1/admin/devices/" + device.deviceId + "/revoke",
      headers: jsonWriteHeaders(cookie),
      payload: {},
      remoteAddress: "192.0.2.206",
    });
    expect(revoked.statusCode).toBe(204);

    const blockedHeartbeat = await heartbeat(app, accessToken, 2);
    expect(blockedHeartbeat.statusCode).toBe(403);
    expect(errorBody(blockedHeartbeat).code).toBe("device_revoked");

    const blockedChallenge = await app.inject({
      method: "POST",
      url: "/v1/device/auth/challenge",
      headers: {
        "content-type": "application/json",
        "x-gt-ads-api-version": "1",
      },
      payload: { device_id: device.deviceId },
      remoteAddress: "192.0.2.207",
    });
    expect(blockedChallenge.statusCode).toBe(403);
    expect(errorBody(blockedChallenge).code).toBe("device_revoked");

    const list = await listDevices(app, cookie);
    expect(list.statusCode).toBe(200);
    const items = list.json().items as Array<{ state: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]?.state).toBe("revoked");

    const detail = await app.inject({
      method: "GET",
      url: "/v1/admin/devices/" + device.deviceId,
      headers: adminHeaders(cookie),
      remoteAddress: "192.0.2.208",
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().state).toBe("revoked");

    const again = await app.inject({
      method: "POST",
      url: "/v1/admin/devices/" + device.deviceId + "/revoke",
      headers: jsonWriteHeaders(cookie),
      payload: {},
      remoteAddress: "192.0.2.209",
    });
    expect(again.statusCode).toBe(204);

    const unknown = await app.inject({
      method: "POST",
      url: "/v1/admin/devices/" + randomUUID() + "/revoke",
      headers: jsonWriteHeaders(cookie),
      payload: {},
      remoteAddress: "192.0.2.210",
    });
    expect(unknown.statusCode).toBe(404);
    expect(errorBody(unknown).code).toBe("not_found");
  });

  it("I-19 Admin-Endpunkte brauchen eine Sitzung; Logout und Ablauf invalidieren", async () => {
    const app = await buildApp();

    const withoutSession = await listDevices(app, "kein-gueltiges-token");
    expect(withoutSession.statusCode).toBe(401);
    expect(errorBody(withoutSession).code).toBe("unauthorized");

    const codesWithoutSession = await app.inject({
      method: "GET",
      url: "/v1/admin/registration-codes",
      headers: { host: HOST },
      remoteAddress: "192.0.2.211",
    });
    expect(codesWithoutSession.statusCode).toBe(401);

    const revokeWithoutSession = await app.inject({
      method: "POST",
      url: "/v1/admin/devices/" + randomUUID() + "/revoke",
      headers: { host: HOST, "content-type": "application/json" },
      payload: {},
      remoteAddress: "192.0.2.212",
    });
    expect(revokeWithoutSession.statusCode).toBe(401);

    const cookie = await loginCookie(app);
    expect((await listDevices(app, cookie)).statusCode).toBe(200);
    expect((await createCodeViaAdmin(app, cookie)).statusCode).toBe(201);

    const logout = await app.inject({
      method: "POST",
      url: "/v1/admin/logout",
      headers: jsonWriteHeaders(cookie),
      payload: {},
      remoteAddress: "192.0.2.213",
    });
    expect(logout.statusCode).toBe(204);
    expect((await listDevices(app, cookie)).statusCode).toBe(401);

    const secondCookie = await loginCookie(app);
    nowMs = BASE_TIME + (config.adminSessionTtlSeconds + 1) * 1000;
    const expired = await listDevices(app, secondCookie);
    expect(expired.statusCode).toBe(401);
    expect(errorBody(expired).code).toBe("unauthorized");
  });

  it("I-20 CSRF: fremder Origin und falscher Content-Type ergeben 403", async () => {
    const app = await buildApp();
    const cookie = await loginCookie(app);

    const foreignOrigin = await app.inject({
      method: "POST",
      url: "/v1/admin/registration-codes",
      headers: jsonWriteHeaders(cookie),
      payload: { label: "SYN-CSRF" },
      remoteAddress: "192.0.2.214",
    });
    // Kontrolle: ohne Origin ist der Request erlaubt.
    expect(foreignOrigin.statusCode).toBe(201);
    const codeId = foreignOrigin.json().id as string;

    const badOrigin = await app.inject({
      method: "POST",
      url: "/v1/admin/registration-codes",
      headers: adminHeaders(cookie, {
        "content-type": "application/json",
        origin: "https://fremd.example",
      }),
      payload: { label: "SYN-CSRF" },
      remoteAddress: "192.0.2.215",
    });
    expect(badOrigin.statusCode).toBe(403);
    expect(errorBody(badOrigin).code).toBe("forbidden");

    const badOriginDelete = await app.inject({
      method: "DELETE",
      url: "/v1/admin/registration-codes/" + codeId,
      headers: adminHeaders(cookie, {
        "content-type": "application/json",
        origin: "https://fremd.example",
      }),
      remoteAddress: "192.0.2.216",
    });
    expect(badOriginDelete.statusCode).toBe(403);

    const wrongContentType = await app.inject({
      method: "POST",
      url: "/v1/admin/registration-codes",
      headers: adminHeaders(cookie, { "content-type": "text/plain" }),
      payload: "SYN-CSRF",
      remoteAddress: "192.0.2.217",
    });
    expect(wrongContentType.statusCode).toBe(403);
    expect(errorBody(wrongContentType).code).toBe("forbidden");

    const sameOrigin = await app.inject({
      method: "POST",
      url: "/v1/admin/registration-codes",
      headers: adminHeaders(cookie, {
        "content-type": "application/json",
        origin: ORIGIN,
      }),
      payload: { label: "SYN-Same-Origin" },
      remoteAddress: "192.0.2.218",
    });
    expect(sameOrigin.statusCode).toBe(201);

    const allowedDelete = await app.inject({
      method: "DELETE",
      url: "/v1/admin/registration-codes/" + codeId,
      headers: adminHeaders(cookie, {
        "content-type": "application/json",
        origin: ORIGIN,
      }),
      remoteAddress: "192.0.2.219",
    });
    expect(allowedDelete.statusCode).toBe(204);
  });

  it("I-21 Login: falsches Passwort generisch 401, sechster Fehlversuch 429", async () => {
    const app = await buildApp();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await login(app, "SYN-Falsches-Passwort-" + attempt);
      expect(response.statusCode).toBe(401);
      const body = errorBody(response);
      expect(body.code).toBe("unauthorized");
      expect(body.message).toBe(API_ERROR_MESSAGES.unauthorized);
      expect(JSON.stringify(body)).not.toContain("Falsches-Passwort");
    }

    const blocked = await login(app, "SYN-Falsches-Passwort-6");
    expect(blocked.statusCode).toBe(429);
    expect(errorBody(blocked).code).toBe("rate_limited");
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("I-22 Audit enthaelt alle Admin-/Geraeteaktionen ohne Geheimnisse", async () => {
    const app = await buildApp();
    const cookie = await loginCookie(app);

    const created = await createCodeViaAdmin(app, cookie, "SYN-Audit");
    expect(created.statusCode).toBe(201);
    const createdBody = created.json();
    const codeId = createdBody.id as string;
    const cleartextCode = createdBody.code as string;

    const revokedCode = await app.inject({
      method: "DELETE",
      url: "/v1/admin/registration-codes/" + codeId,
      headers: jsonWriteHeaders(cookie),
      remoteAddress: "192.0.2.220",
    });
    expect(revokedCode.statusCode).toBe(204);

    const device = await registerDevice(app, "SYN-Audit-Geraet");
    const accessToken = await obtainAccessToken(app, device);
    expect((await heartbeat(app, accessToken, 1)).statusCode).toBe(200);

    const revokedDevice = await app.inject({
      method: "POST",
      url: "/v1/admin/devices/" + device.deviceId + "/revoke",
      headers: jsonWriteHeaders(cookie),
      payload: {},
      remoteAddress: "192.0.2.221",
    });
    expect(revokedDevice.statusCode).toBe(204);

    const failedLogin = await login(app, "SYN-Audit-Falsch");
    expect(failedLogin.statusCode).toBe(401);

    const audit = await pool.query<{
      action: string;
      details: Record<string, unknown>;
    }>("select action, details from audit_events order by id");

    const actions = audit.rows.map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        AUDIT_ACTIONS.registrationCodeCreated,
        AUDIT_ACTIONS.registrationCodeRevoked,
        AUDIT_ACTIONS.registrationCodeUsed,
        AUDIT_ACTIONS.deviceRegistered,
        AUDIT_ACTIONS.deviceRevoked,
        AUDIT_ACTIONS.adminLoginSucceeded,
        AUDIT_ACTIONS.adminLoginFailed,
      ]),
    );

    const serialized = JSON.stringify(audit.rows);
    expect(serialized).not.toContain(cleartextCode);
    expect(serialized).not.toContain(ADMIN_PASSWORD);
    expect(serialized).not.toContain("SYN-Audit-Falsch");
    expect(serialized).not.toContain(device.spki);
    expect(serialized).not.toContain(accessToken);
    expect(serialized).not.toContain("SYN-Nonce");
    expect(serialized).not.toContain("SYN-Signatur");

    for (const row of audit.rows) {
      for (const field of Object.keys(row.details)) {
        expect(isSensitiveFieldName(field), field).toBe(false);
      }
    }
  });

  it("I-23 Geraeteliste: leer, ein Eintrag, Statusgrenze und Sortierung", async () => {
    const app = await buildApp();
    const cookie = await loginCookie(app);

    const empty = await listDevices(app, cookie);
    expect(empty.statusCode).toBe(200);
    const emptyBody = empty.json();
    expect(emptyBody.items).toEqual([]);
    expect(emptyBody.online_threshold_s).toBe(THRESHOLD_SECONDS);
    expect(new Date(emptyBody.server_time).getTime()).toBe(BASE_TIME);

    const device = await registerDevice(app, "SYN-Liste");
    const list = await listDevices(app, cookie);
    const body = list.json();
    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    expect(item.id).toBe(device.deviceId);
    expect(item.label).toBe("SYN-Liste");
    expect(item.manufacturer).toBe("SYN-Hersteller");
    expect(item.model).toBe("SYN-Modell");
    expect(item.os_version).toBe("14");
    expect(item.sdk_int).toBe(34);
    expect(item.app_version).toBe("0.1.0");
    expect(item.app_flavor).toBe("dev");
    expect(item.state).toBe("active");
    expect(item.connectivity).toBe("reachable");
    expect(item.registered_at).toBe(new Date(BASE_TIME).toISOString());
    expect(item.last_seen_at).toBe(new Date(BASE_TIME).toISOString());

    nowMs = BASE_TIME + THRESHOLD_SECONDS * 1000;
    expect((await listDevices(app, cookie)).json().items[0].connectivity).toBe("reachable");
    nowMs += 1;
    const stale = (await listDevices(app, cookie)).json().items[0];
    expect(stale.connectivity).toBe("last_seen");
    expect(stale.last_seen_at).toBe(new Date(BASE_TIME).toISOString());

    nowMs = BASE_TIME + 10_000;
    const second = await registerDevice(app, "SYN-Zweites");
    const sorted = (await listDevices(app, cookie)).json().items as Array<{
      id: string;
    }>;
    expect(sorted.map((entry) => entry.id)).toEqual([second.deviceId, device.deviceId]);
  });

  it("I-25 Server lauscht nur auf 127.0.0.1 (Socket-Pruefung)", async () => {
    expect(CONFIG_DEFAULTS.bindHost).toBe("127.0.0.1");
    expect(config.bindHost).toBe("127.0.0.1");

    const app = createServer({ config, pool, now: clock });
    await app.listen({ host: config.bindHost, port: 0 });
    try {
      const address = app.server.address();
      expect(address).not.toBeNull();
      if (address === null || typeof address === "string") {
        throw new Error("Keine Socket-Adresse");
      }
      expect(address.address).toBe("127.0.0.1");
      expect(address.family).toBe("IPv4");

      const response = await fetch("http://127.0.0.1:" + address.port + "/health");
      expect(response.status).toBe(200);
      const health = (await response.json()) as { status: string; env: string };
      expect(health.status).toBe("ok");
      expect(health.env).toBe("test");
    } finally {
      await app.close();
    }
  });

  it("I-26 Bereinigung loescht nur lange abgelaufene Auth-Artefakte", async () => {
    const device = await registerDevice(await buildApp(), "SYN-Cleanup");
    const hourMs = 60 * 60 * 1000;
    const expiredLongAgo = new Date(BASE_TIME - 25 * hourMs);
    const expiredRecently = new Date(BASE_TIME - 1 * hourMs);
    const future = new Date(BASE_TIME + 5 * hourMs);

    const insertChallenge = async (expiresAt: Date) => {
      await pool.query(
        "insert into device_auth_challenges (id, device_id, nonce_hash, created_at, expires_at) values ($1, $2, $3, $4, $5)",
        [randomUUID(), device.deviceId, Buffer.from(randomUUID()), new Date(BASE_TIME), expiresAt],
      );
    };
    const insertToken = async (expiresAt: Date) => {
      await pool.query(
        "insert into device_access_tokens (id, device_id, token_hash, created_at, expires_at) values ($1, $2, $3, $4, $5)",
        [randomUUID(), device.deviceId, hashToken(randomUUID()), new Date(BASE_TIME), expiresAt],
      );
    };
    const insertSession = async (expiresAt: Date) => {
      await pool.query(
        "insert into admin_sessions (id, token_hash, created_at, expires_at) values ($1, $2, $3, $4)",
        [randomUUID(), hashToken(randomUUID()), new Date(BASE_TIME), expiresAt],
      );
    };

    await insertChallenge(expiredLongAgo);
    await insertChallenge(expiredRecently);
    await insertChallenge(future);
    await insertToken(expiredLongAgo);
    await insertToken(expiredRecently);
    await insertToken(future);
    await insertSession(expiredLongAgo);
    await insertSession(expiredRecently);
    await insertSession(future);

    const countsBefore = await countRows();
    const result = await cleanupExpiredAuthArtifacts(pool, clock());

    expect(result).toEqual({ challenges: 1, tokens: 1, sessions: 1 });
    const countsAfter = await countRows();
    expect(countsAfter.challenges).toBe(2);
    expect(countsAfter.tokens).toBe(2);
    expect(countsAfter.sessions).toBe(2);
    expect(countsAfter.registration_codes).toBe(countsBefore.registration_codes);
    expect(countsAfter.devices).toBe(countsBefore.devices);
    expect(countsAfter.audit_events).toBe(countsBefore.audit_events);
    expect(countsAfter.registration_codes).toBe(1);
    expect(countsAfter.devices).toBe(1);
    expect(countsAfter.audit_events).toBeGreaterThan(0);
  });
});

async function countRows(): Promise<{
  challenges: number;
  tokens: number;
  sessions: number;
  registration_codes: number;
  devices: number;
  audit_events: number;
}> {
  const tables: Array<[string, string]> = [
    ["challenges", "device_auth_challenges"],
    ["tokens", "device_access_tokens"],
    ["sessions", "admin_sessions"],
    ["registration_codes", "registration_codes"],
    ["devices", "devices"],
    ["audit_events", "audit_events"],
  ];
  const result: Record<string, number> = {};
  for (const [key, table] of tables) {
    const row = await pool.query<{ count: string }>(
      "select count(*)::text as count from " + table,
    );
    result[key] = Number(row.rows[0]?.count ?? "0");
  }
  return result as {
    challenges: number;
    tokens: number;
    sessions: number;
    registration_codes: number;
    devices: number;
    audit_events: number;
  };
}
