import {
  generateKeyPairSync,
  randomUUID,
} from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS, type AppConfig } from "../../src/config.js";
import { hashPassword } from "../../src/crypto/password.js";
import { migrateUp } from "../../src/db/migrate.js";
import { registerErrorHandler } from "../../src/http/errors.js";
import { installAccessControl } from "../../src/http/authorization.js";
import { createServer } from "../../src/http/server.js";
import { ADMIN_SESSION_COOKIE } from "../../src/modules/adminAuth/middleware.js";
import { RegistrationService } from "../../src/modules/registration/service.js";

const BASE_TIME = Date.parse("2026-01-01T12:00:00.000Z");
const ADMIN_PASSWORD = "SYN-CX015-CSRF-Passwort";
const HOST = "127.0.0.1:8080";
const ORIGIN = "http://" + HOST;
const FOREIGN_ORIGIN = "http://fremde.example";

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
const clock = (): Date => new Date(BASE_TIME);
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
    "gtads_cx015_csrf_" +
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
    registrationCodePepper: "SYN-CX015-CSRF-Pepper",
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

function sessionCookieOf(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const first = Array.isArray(raw) ? (raw[0] as string) : (raw as string | undefined);
  expect(first, "Set-Cookie fehlt").toBeTruthy();
  return ((first as string).split(";")[0] as string).slice(
    ADMIN_SESSION_COOKIE.length + 1,
  );
}

async function loginCookie(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/login",
    headers: { host: HOST, "content-type": "application/json" },
    payload: { password: ADMIN_PASSWORD },
    remoteAddress: "192.0.2.220",
  });
  expect(response.statusCode).toBe(204);
  return sessionCookieOf(response);
}

async function registerDevice(app: FastifyInstance): Promise<string> {
  const created = await registrationService.createRegistrationCode({
    label: "SYN-CX015-CSRF-Handy",
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
    remoteAddress: "192.0.2.221",
  });
  expect(response.statusCode).toBe(201);
  return response.json().device_id as string;
}

async function deviceState(deviceId: string): Promise<string> {
  const result = await pool.query("select state from devices where id = $1", [
    deviceId,
  ]);
  expect(result.rowCount).toBe(1);
  return result.rows[0].state as string;
}

describe("CX-015 Rechtekern: Cookie-Schreibzugriffe und Sonderrouten", () => {
  it("weist Cookie-Schreibzugriffe mit fremdem Origin fuer POST, PUT, PATCH und DELETE vor dem Handler ab und laesst Geraete-, Registrierungs- und Download-Nachweise unveraendert", async () => {
    const app = await buildApp();
    const cookie = await loginCookie(app);

    // POST mit fremdem Origin: 403 und keine Sperre.
    const deviceId = await registerDevice(app);
    const blockedPost = await app.inject({
      method: "POST",
      url: "/v1/admin/devices/" + deviceId + "/revoke",
      headers: {
        host: HOST,
        "content-type": "application/json",
        origin: FOREIGN_ORIGIN,
        cookie: ADMIN_SESSION_COOKIE + "=" + cookie,
      },
      payload: {},
      remoteAddress: "192.0.2.222",
    });
    expect(blockedPost.statusCode).toBe(403);
    expect(blockedPost.json().error.code).toBe("forbidden");
    expect(await deviceState(deviceId)).toBe("active");

    // DELETE mit fremdem Origin: 403, Code bleibt unbenutzt.
    const createdResponse = await app.inject({
      method: "POST",
      url: "/v1/admin/registration-codes",
      headers: {
        host: HOST,
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: ADMIN_SESSION_COOKIE + "=" + cookie,
      },
      payload: { label: "SYN-CX015-CSRF-Code" },
      remoteAddress: "192.0.2.223",
    });
    expect(createdResponse.statusCode).toBe(201);
    const codeId = createdResponse.json().id as string;

    const blockedDelete = await app.inject({
      method: "DELETE",
      url: "/v1/admin/registration-codes/" + codeId,
      headers: {
        host: HOST,
        origin: FOREIGN_ORIGIN,
        cookie: ADMIN_SESSION_COOKIE + "=" + cookie,
      },
      remoteAddress: "192.0.2.224",
    });
    expect(blockedDelete.statusCode).toBe(403);
    const listAfterDelete = await app.inject({
      method: "GET",
      url: "/v1/admin/registration-codes",
      headers: {
        host: HOST,
        cookie: ADMIN_SESSION_COOKIE + "=" + cookie,
      },
      remoteAddress: "192.0.2.225",
    });
    expect(listAfterDelete.statusCode).toBe(200);
    const listed = listAfterDelete
      .json()
      .items.find((item: { id: string }) => item.id === codeId);
    expect(listed?.status).toBe("pending");

    // Gleicher Origin bleibt erlaubt: der bestehende Origin-Schutz blockiert
    // nicht pauschal, sondern nur fremde Ursprunge.
    const sameOrigin = await app.inject({
      method: "POST",
      url: "/v1/admin/devices/" + deviceId + "/revoke",
      headers: {
        host: HOST,
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: ADMIN_SESSION_COOKIE + "=" + cookie,
      },
      payload: {},
      remoteAddress: "192.0.2.226",
    });
    expect(sameOrigin.statusCode).toBe(204);
    expect(await deviceState(deviceId)).toBe("revoked");

    // Geraeteauthentifizierung bleibt allein massgeblich: kein Bearer -> 401,
    // ein Admin-Cookie ersetzt keinen Geraetenachweis.
    const heartbeat = await app.inject({
      method: "POST",
      url: "/v1/device/heartbeat",
      headers: {
        "content-type": "application/json",
        "x-gt-ads-api-version": "1",
      },
      payload: {
        seq: 1,
        device_time: new Date(BASE_TIME).toISOString(),
        app_version: "0.1.0",
        os_version: "14",
      },
      remoteAddress: "192.0.2.227",
    });
    expect(heartbeat.statusCode).toBe(401);
    expect(heartbeat.json().error.code).toBe("unauthorized");

    const heartbeatWithCookie = await app.inject({
      method: "POST",
      url: "/v1/device/heartbeat",
      headers: {
        "content-type": "application/json",
        "x-gt-ads-api-version": "1",
        cookie: ADMIN_SESSION_COOKIE + "=" + cookie,
      },
      payload: {
        seq: 2,
        device_time: new Date(BASE_TIME).toISOString(),
        app_version: "0.1.0",
        os_version: "14",
      },
      remoteAddress: "192.0.2.228",
    });
    expect(heartbeatWithCookie.statusCode).toBe(401);

    // Registrierung behaelt ihre vorhandene Validierung: fremder Origin
    // erzeugt kein CSRF-403, sondern die bestehende Formatabweisung.
    const registration = await app.inject({
      method: "POST",
      url: "/v1/device/register",
      headers: {
        "content-type": "application/json",
        origin: FOREIGN_ORIGIN,
      },
      payload: {},
      remoteAddress: "192.0.2.229",
    });
    expect(registration.statusCode).toBe(400);
    expect(registration.json().error.code).toBe("invalid_request");

    // PUT/PATCH: der Rechtekern greift auch dort vor dem Handler.
    interface Writes {
      app: FastifyInstance;
      hits: string[];
    }
    async function buildWriteApp(): Promise<Writes> {
      const writeApp = Fastify({ logger: false });
      registerErrorHandler(writeApp);
      const hits: string[] = [];
      installAccessControl(writeApp, {
        resolvePrincipal: async () => ({ id: "SYN-admin", role: "Admin" }),
      });
      for (const route of [
        { method: "PUT" as const, url: "/v1/admin/taxis/:id/config" },
        { method: "PATCH" as const, url: "/v1/admin/campaigns/:id" },
      ]) {
        writeApp.route({
          method: route.method,
          url: route.url,
          handler: async (_request, reply) => {
            hits.push(route.method + " " + route.url);
            reply.code(200).send({ ok: true });
          },
        });
      }
      await writeApp.ready();
      openApps.push(writeApp);
      return { app: writeApp, hits };
    }

    const writes = await buildWriteApp();
    const writeLabels: Record<string, string> = {
      PUT: "PUT /v1/admin/taxis/:id/config",
      PATCH: "PATCH /v1/admin/campaigns/:id",
    };
    for (const method of ["PUT", "PATCH"] as const) {
      const url =
        method === "PUT"
          ? "/v1/admin/taxis/t1/config"
          : "/v1/admin/campaigns/c1";
      const blocked = await writes.app.inject({
        method,
        url,
        headers: {
          host: HOST,
          "content-type": "application/json",
          origin: FOREIGN_ORIGIN,
          cookie: ADMIN_SESSION_COOKIE + "=" + cookie,
        },
        payload: {},
        remoteAddress: "192.0.2.230",
      });
      expect(blocked.statusCode, method + " mit fremdem Origin").toBe(403);
      expect(blocked.json().error.code).toBe("forbidden");
      expect(writes.hits).not.toContain(writeLabels[method]);

      const allowedWrite = await writes.app.inject({
        method,
        url,
        headers: {
          host: HOST,
          "content-type": "application/json",
          origin: ORIGIN,
          cookie: ADMIN_SESSION_COOKIE + "=" + cookie,
        },
        payload: {},
        remoteAddress: "192.0.2.231",
      });
      expect(allowedWrite.statusCode, method + " mit eigenem Origin").toBe(200);
      expect(writes.hits).toContain(writeLabels[method]);
    }

    // Signierter Download: der Rechtekern verlangt keine menschliche Sitzung
    // und ersetzt nicht den vorhandenen Nachweis der Route.
    const downloadApp = Fastify({ logger: false });
    const downloadHits: string[] = [];
    installAccessControl(downloadApp, {
      resolvePrincipal: async () => null,
    });
    downloadApp.get("/v1/device/downloads/:id", async (request, reply) => {
      downloadHits.push(request.url);
      if (request.query === undefined || (request.query as { sig?: string }).sig !== "SYN-download-signatur") {
        reply.code(401).send({ error: "signatur fehlt" });
        return;
      }
      reply.code(200).send({ ok: true });
    });
    await downloadApp.ready();
    openApps.push(downloadApp);

    const unsigned = await downloadApp.inject({
      method: "GET",
      url: "/v1/device/downloads/d1",
      headers: { host: HOST },
    });
    expect(unsigned.statusCode).toBe(401);
    expect(downloadHits).toHaveLength(1);

    const signed = await downloadApp.inject({
      method: "GET",
      url: "/v1/device/downloads/d1?sig=SYN-download-signatur",
      headers: { host: HOST },
    });
    expect(signed.statusCode).toBe(200);
    expect(downloadHits).toHaveLength(2);
  });
});
