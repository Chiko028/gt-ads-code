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
import { generateRegistrationCode } from "../../src/crypto/registrationCode.js";
import { migrateUp } from "../../src/db/migrate.js";
import { createServer } from "../../src/http/server.js";
import { ADMIN_SESSION_COOKIE } from "../../src/modules/adminAuth/middleware.js";
import { RegistrationService } from "../../src/modules/registration/service.js";
import { compileSchema, createContractAjv } from "./contractFiles.js";

const BASE_TIME = Date.parse("2026-01-01T12:00:00.000Z");
const ADMIN_PASSWORD = "SYN-U7-Admin-Passwort";
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
let nowMs = BASE_TIME;
const clock = (): Date => new Date(nowMs);
const openApps: FastifyInstance[] = [];

const ajv = createContractAjv();
const validators = new Map<string, ReturnType<typeof compileSchema>>();

function validator(schemaFile: string): ReturnType<typeof compileSchema> {
  const cached = validators.get(schemaFile);
  if (cached !== undefined) {
    return cached;
  }
  const compiled = compileSchema(ajv, schemaFile);
  validators.set(schemaFile, compiled);
  return compiled;
}

/** Prueft einen echten Antwortkoerper gegen das Vertragsschema. */
function expectValid(schemaFile: string, body: unknown): void {
  const validate = validator(schemaFile);
  const ok = validate(body);
  expect(ok, schemaFile + "\n" + ajv.errorsText(validate.errors ?? [])).toBe(true);
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
    throw new Error("GT-ADS-001 U7 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = ("gtads_u7_contract_" + process.pid + "_" + Date.now().toString(36))
    .toLowerCase()
    .slice(0, 63);
  await maintenancePool.query("create database " + quoteIdentifier(databaseName));

  pool = new Pool({ ...base, database: databaseName });
  await migrateUp(pool);

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-U7-Code-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
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

function login(app: FastifyInstance, password: string = ADMIN_PASSWORD) {
  return app.inject({
    method: "POST",
    url: "/v1/admin/login",
    headers: { host: HOST, "content-type": "application/json" },
    payload: { password },
    remoteAddress: "192.0.2.210",
  });
}

async function loginCookie(app: FastifyInstance): Promise<string> {
  const response = await login(app);
  expect(response.statusCode).toBe(204);
  return sessionCookieOf(response);
}

interface TestDeviceKey {
  privateKey: KeyObject;
  spki: string;
}

function makeDeviceKey(): TestDeviceKey {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privateKey: pair.privateKey,
    spki: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

function deviceHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-gt-ads-api-version": "1",
  };
}

function register(
  app: FastifyInstance,
  code: string,
  publicKey: string,
  remoteAddress: string,
) {
  return app.inject({
    method: "POST",
    url: "/v1/device/register",
    headers: deviceHeaders(),
    payload: {
      registration_code: code,
      client_request_id: randomUUID(),
      public_key: publicKey,
      app_env: "test",
      device_info: { ...DEVICE_INFO },
    },
    remoteAddress,
  });
}

function challengeDevice(app: FastifyInstance, deviceId: string) {
  return app.inject({
    method: "POST",
    url: "/v1/device/auth/challenge",
    headers: deviceHeaders(),
    payload: { device_id: deviceId },
    remoteAddress: "192.0.2.211",
  });
}

describe("T3 Contract: reale Serverantworten", () => {
  it("Erfolgsantworten des Gesamtlaufs entsprechen den Response-Schemas", async () => {
    const app = await buildApp();

    const health = await app.inject({
      method: "GET",
      url: "/health",
      remoteAddress: "192.0.2.220",
    });
    expect(health.statusCode).toBe(200);
    expect(health.headers["content-type"]).toContain("application/json");
    expectValid("health.response.schema.json", health.json());

    const loginResponse = await login(app);
    expect(loginResponse.statusCode).toBe(204);
    expect(loginResponse.body).toBe("");
    const cookie = sessionCookieOf(loginResponse);

    const created = await app.inject({
      method: "POST",
      url: "/v1/admin/registration-codes",
      headers: jsonWriteHeaders(cookie),
      payload: { label: "SYN-Vertrag" },
      remoteAddress: "192.0.2.221",
    });
    expect(created.statusCode).toBe(201);
    expectValid("admin-registration-code-create.response.schema.json", created.json());
    const codeId = created.json().id as string;
    const code = created.json().code as string;

    const codes = await app.inject({
      method: "GET",
      url: "/v1/admin/registration-codes",
      headers: adminHeaders(cookie),
      remoteAddress: "192.0.2.222",
    });
    expect(codes.statusCode).toBe(200);
    expectValid("admin-registration-codes-list.response.schema.json", codes.json());
    expect(
      (codes.json().items as Array<{ id: string }>).some((item) => item.id === codeId),
    ).toBe(true);

    const key = makeDeviceKey();
    const registered = await register(app, code, key.spki, "192.0.2.223");
    expect(registered.statusCode).toBe(201);
    expectValid("device-register.response.schema.json", registered.json());
    const deviceId = registered.json().device_id as string;

    const challenge = await challengeDevice(app, deviceId);
    expect(challenge.statusCode).toBe(200);
    expectValid("device-auth-challenge.response.schema.json", challenge.json());
    const nonce = challenge.json().nonce as string;

    const signature = signWithKey(
      "sha256",
      Buffer.from(buildSignatureMessage(deviceId, nonce), "utf8"),
      { key: key.privateKey, dsaEncoding: "der" },
    ).toString("base64");

    const token = await app.inject({
      method: "POST",
      url: "/v1/device/auth/token",
      headers: deviceHeaders(),
      payload: { device_id: deviceId, nonce, signature },
      remoteAddress: "192.0.2.224",
    });
    expect(token.statusCode).toBe(200);
    expectValid("device-auth-token.response.schema.json", token.json());
    const accessToken = token.json().access_token as string;

    const heartbeat = await app.inject({
      method: "POST",
      url: "/v1/device/heartbeat",
      headers: { ...deviceHeaders(), authorization: "Bearer " + accessToken },
      payload: {
        seq: 1,
        device_time: new Date(nowMs).toISOString(),
        app_version: "0.1.0",
        os_version: "14",
      },
      remoteAddress: "192.0.2.225",
    });
    expect(heartbeat.statusCode).toBe(200);
    expectValid("device-heartbeat.response.schema.json", heartbeat.json());

    const list = await app.inject({
      method: "GET",
      url: "/v1/admin/devices",
      headers: adminHeaders(cookie),
      remoteAddress: "192.0.2.226",
    });
    expect(list.statusCode).toBe(200);
    expectValid("admin-devices-list.response.schema.json", list.json());
    expect(list.json().items).toHaveLength(1);

    const detail = await app.inject({
      method: "GET",
      url: "/v1/admin/devices/" + deviceId,
      headers: adminHeaders(cookie),
      remoteAddress: "192.0.2.227",
    });
    expect(detail.statusCode).toBe(200);
    expectValid("admin-device-detail.response.schema.json", detail.json());
    expect(detail.json().registration_code_id).toBe(codeId);

    const revoke = await app.inject({
      method: "POST",
      url: "/v1/admin/devices/" + deviceId + "/revoke",
      headers: jsonWriteHeaders(cookie),
      payload: {},
      remoteAddress: "192.0.2.228",
    });
    expect(revoke.statusCode).toBe(204);
    expect(revoke.body).toBe("");

    const logout = await app.inject({
      method: "POST",
      url: "/v1/admin/logout",
      headers: jsonWriteHeaders(cookie),
      remoteAddress: "192.0.2.229",
    });
    expect(logout.statusCode).toBe(204);
    expect(logout.body).toBe("");
  });

  it("Fehlerantworten entsprechen dem Fehlerschema", async () => {
    const app = await buildApp();

    const badRegister = await register(
      app,
      generateRegistrationCode(12),
      makeDeviceKey().spki,
      "192.0.2.230",
    );
    expect(badRegister.statusCode).toBe(400);
    expect(badRegister.json().error.code).toBe("invalid_registration_code");
    expectValid("error.response.schema.json", badRegister.json());

    const noVersion = await app.inject({
      method: "POST",
      url: "/v1/device/register",
      headers: { "content-type": "application/json" },
      payload: {
        registration_code: generateRegistrationCode(12),
        client_request_id: randomUUID(),
        public_key: makeDeviceKey().spki,
        app_env: "test",
        device_info: { ...DEVICE_INFO },
      },
      remoteAddress: "192.0.2.231",
    });
    expect(noVersion.statusCode).toBe(400);
    expect(noVersion.json().error.code).toBe("invalid_request");
    expectValid("error.response.schema.json", noVersion.json());

    const unknownChallenge = await challengeDevice(app, randomUUID());
    expect(unknownChallenge.statusCode).toBe(401);
    expect(unknownChallenge.json().error.code).toBe("unauthorized");
    expectValid("error.response.schema.json", unknownChallenge.json());

    const noSession = await app.inject({
      method: "GET",
      url: "/v1/admin/devices",
      headers: { host: HOST },
      remoteAddress: "192.0.2.232",
    });
    expect(noSession.statusCode).toBe(401);
    expectValid("error.response.schema.json", noSession.json());

    const notFound = await app.inject({
      method: "GET",
      url: "/v1/gibt-es-nicht",
      remoteAddress: "192.0.2.233",
    });
    expect(notFound.statusCode).toBe(404);
    expectValid("error.response.schema.json", notFound.json());

    const badLogin = await login(app, "SYN-falsches-Passwort");
    expect(badLogin.statusCode).toBe(401);
    expectValid("error.response.schema.json", badLogin.json());

    const cookie = await loginCookie(app);
    const created = await app.inject({
      method: "POST",
      url: "/v1/admin/registration-codes",
      headers: jsonWriteHeaders(cookie),
      payload: { label: "SYN-Sperre" },
      remoteAddress: "192.0.2.234",
    });
    expect(created.statusCode).toBe(201);

    const key = makeDeviceKey();
    const registered = await register(
      app,
      created.json().code as string,
      key.spki,
      "192.0.2.235",
    );
    expect(registered.statusCode).toBe(201);
    const deviceId = registered.json().device_id as string;

    const revoke = await app.inject({
      method: "POST",
      url: "/v1/admin/devices/" + deviceId + "/revoke",
      headers: jsonWriteHeaders(cookie),
      payload: {},
      remoteAddress: "192.0.2.236",
    });
    expect(revoke.statusCode).toBe(204);

    const blocked = await challengeDevice(app, deviceId);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe("device_revoked");
    expectValid("error.response.schema.json", blocked.json());
  });
});
