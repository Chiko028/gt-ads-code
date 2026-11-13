/**
 * CX-033: minimale HTTP-Komposition fuer die vorhandenen CX-031- und
 * CX-032-Routen.
 *
 * Die Matrix enthaelt ausschliesslich die tatsaechlich integrierten Routen:
 * POST /v1/admin/media (CX-031), GET/POST /v1/admin/customers sowie
 * GET /v1/admin/customers/:id (CX-032). Sie behauptet keine vollstaendige
 * Geraete- oder Fachroutenabdeckung.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
  type RouteHandlerMethod,
} from "fastify";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { CONFIG_DEFAULTS, type AppConfig } from "../config.js";
import { hashPassword } from "../crypto/password.js";
import { migrateUp } from "../db/migrate.js";
import { ApiError } from "./errors.js";
import { getRoutePolicyInventory } from "./authorization.js";
import {
  installContractErrorHandling,
  registerJsonRoute,
} from "./jsonContract.js";
import type { MediaUploadDeps } from "./mediaUpload.js";
import {
  ADMIN_SESSION_COOKIE,
} from "../modules/adminAuth/middleware.js";
import type {
  CreateMediaInput,
  MediaProfileMetadata,
  MediaServiceOptions,
  ReadyMedia,
} from "../modules/media/index.js";
import { LEGACY_ADMIN_PRINCIPAL_ID } from "./principal.js";
import { createServer } from "./server.js";

// Backup-, Restore- und Alarmadapter duerfen durch die Komposition nicht
// aufgerufen werden. Die Doubles machen einen versehentlichen Aufruf sichtbar.
vi.mock("../modules/backup/createDump.js", () => ({ createDump: vi.fn() }));
vi.mock("../modules/backup/verifyRestore.js", () => ({ verifyRestore: vi.fn() }));
vi.mock("../modules/technicalAlarms/dispatch.js", () => ({
  dispatchPending: vi.fn(),
}));
import { createDump } from "../modules/backup/createDump.js";
import { verifyRestore } from "../modules/backup/verifyRestore.js";
import { dispatchPending } from "../modules/technicalAlarms/dispatch.js";

const BASE_TIME = Date.parse("2026-11-13T12:00:00.000Z");
const ADMIN_PASSWORD = "SYN-CX033-Komposition-Passwort";
const HOST = "127.0.0.1:8080";
const ORIGIN = "http://" + HOST;
const CUSTOMERS_URL = "/v1/admin/customers";
const UPLOAD_URL = "/v1/admin/media";
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../db/migrations",
);

const PROFILE: MediaProfileMetadata = {
  container: "mp4",
  videoCodec: "h264",
  width: 1920,
  height: 1080,
  frameRateNumerator: 30,
  frameRateDenominator: 1,
  audioStreamCount: 0,
  durationSeconds: 15,
};

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let config: AppConfig;
const clock = (): Date => new Date(BASE_TIME);
const openApps = new Set<FastifyInstance>();

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
    throw new Error("CX-033 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx033_http_" +
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
  // Die Kundenmigration aus CX-032 gehoert nicht zum 0001-Basisschema.
  await pool.query(
    await readFile(
      join(MIGRATIONS_DIR, "0009_campaign_customers.up.sql"),
      "utf8",
    ),
  );

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX033-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };
}, 60_000);

beforeEach(async () => {
  await pool.query(
    "truncate table customers, audit_events, admin_sessions restart identity cascade",
  );
});

afterEach(async () => {
  for (const app of [...openApps]) {
    openApps.delete(app);
    await app.close();
  }
  vi.clearAllMocks();
});

afterAll(async () => {
  await pool.end();
  await maintenancePool.query(
    "drop database if exists " + quoteIdentifier(databaseName),
  );
  await maintenancePool.end();
}, 30_000);

function readyMedia(displayName: string): ReadyMedia {
  return {
    id: "0f8fad5b-d9cb-469f-a165-70867728950e",
    displayName,
    sizeBytes: 4096,
    sha256: "a".repeat(64),
    profile: { ...PROFILE },
    createdAt: new Date(BASE_TIME),
    status: "ready",
    read: async () => Buffer.alloc(0),
  };
}

function uploadDouble(created: ReadyMedia): {
  deps: MediaUploadDeps;
  spy: ReturnType<typeof vi.fn>;
  calls: CreateMediaInput[];
} {
  const calls: CreateMediaInput[] = [];
  const spy = vi.fn(
    async (
      _options: MediaServiceOptions,
      input: CreateMediaInput,
    ): Promise<ReadyMedia> => {
      calls.push(input);
      for await (const _chunk of input.content) {
        // Bytes werden gelesen, aber nicht veraendert.
      }
      return created;
    },
  );
  return {
    deps: {
      createMedia: spy,
      serviceOptions: {
        pool,
        storageRoot: "/tmp/cx033-media-nicht-verwendet",
      },
    },
    spy,
    calls,
  };
}

async function buildApp(
  options: {
    mediaUpload?: MediaUploadDeps;
    logger?: FastifyServerOptions["logger"];
  } = {},
): Promise<FastifyInstance> {
  const app = createServer({
    config,
    pool,
    now: clock,
    mediaUpload:
      options.mediaUpload ?? uploadDouble(readyMedia("SYN-CX033-Standard")).deps,
    logger: options.logger ?? { level: "silent" },
  });
  await app.ready();
  openApps.add(app);
  return app;
}

function sessionCookieOf(response: {
  headers: Record<string, unknown>;
}): string {
  const raw = response.headers["set-cookie"];
  const first = Array.isArray(raw)
    ? (raw[0] as string)
    : (raw as string | undefined);
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
    remoteAddress: "192.0.2.250",
  });
  expect(response.statusCode).toBe(204);
  return sessionCookieOf(response);
}

function requestHeaders(
  cookie?: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = { host: HOST, ...extra };
  if (cookie !== undefined) {
    headers.cookie = ADMIN_SESSION_COOKIE + "=" + cookie;
  }
  return headers;
}

function expectInvalidRequest(response: {
  statusCode: number;
  headers: Record<string, unknown>;
  json: () => Record<string, unknown>;
}): void {
  expect(response.statusCode).toBe(400);
  const body = response.json() as {
    error?: { code?: string; message?: string; request_id?: string };
  };
  expect(Object.keys(body)).toEqual(["error"]);
  expect(Object.keys(body.error ?? {}).sort()).toEqual([
    "code",
    "message",
    "request_id",
  ]);
  expect(body.error?.code).toBe("invalid_request");
  expect(body.error?.message).toBe("Die Anfrage ist ungueltig.");
  // Die produktive App setzt zusaetzlich X-Request-Id; das Testplugin nicht.
  expect(typeof body.error?.request_id).toBe("string");
  expect((body.error?.request_id as string).length).toBeGreaterThan(0);
  const header = response.headers["x-request-id"];
  if (header !== undefined) {
    expect(body.error?.request_id).toBe(header);
  }
}

describe("CX-033 minimale HTTP-Komposition", () => {
  it("Routenmatrix: authentifizierte CX-031/CX-032-Requests erreichen den Handler, ohne Sitzung verweigert der bestehende Schutz", async () => {
    const upload = uploadDouble(readyMedia("SYN-CX033-Spot.mp4"));
    const app = await buildApp({ mediaUpload: upload.deps });
    const detailId = randomUUID();

    const anonymousCases = [
      {
        method: "GET" as const,
        url: CUSTOMERS_URL,
        contentType: undefined,
        payload: undefined,
      },
      {
        method: "GET" as const,
        url: CUSTOMERS_URL + "/" + detailId,
        contentType: undefined,
        payload: undefined,
      },
      {
        method: "POST" as const,
        url: CUSTOMERS_URL,
        contentType: "application/json",
        payload: { display_name: "SYN-CX033-Anonym" },
      },
      {
        method: "POST" as const,
        url: UPLOAD_URL,
        contentType: "application/octet-stream",
        payload: Buffer.from("SYN-CX033-Anonym"),
      },
    ];

    let remote = 192;
    for (const testCase of anonymousCases) {
      const headers = requestHeaders(undefined, {
        ...(testCase.contentType === undefined
          ? {}
          : { "content-type": testCase.contentType }),
      });
      const response = await app.inject({
        method: testCase.method,
        url: testCase.url,
        headers,
        ...(testCase.payload === undefined
          ? {}
          : { payload: testCase.payload }),
        remoteAddress: "192.0.2." + remote++,
      });
      expect(response.statusCode, testCase.method + " " + testCase.url).toBe(
        401,
      );
      expect(response.json().error.code).toBe("unauthorized");
    }
    expect(upload.spy).not.toHaveBeenCalled();

    const cookie = await loginCookie(app);
    const createdCustomer = await app.inject({
      method: "POST",
      url: CUSTOMERS_URL,
      headers: requestHeaders(cookie, {
        origin: ORIGIN,
        "content-type": "application/json",
      }),
      payload: { display_name: "SYN-CX033-Kunde" },
      remoteAddress: "192.0.2.210",
    });
    expect(createdCustomer.statusCode).toBe(201);
    const created = createdCustomer.json() as {
      id: string;
      display_name: string;
    };
    expect(created.display_name).toBe("SYN-CX033-Kunde");

    const list = await app.inject({
      method: "GET",
      url: CUSTOMERS_URL,
      headers: requestHeaders(cookie),
      remoteAddress: "192.0.2.211",
    });
    expect(list.statusCode).toBe(200);
    const items = (list.json() as { items: Array<{ id: string }> }).items;
    expect(items.map((item) => item.id)).toEqual([created.id]);

    const detail = await app.inject({
      method: "GET",
      url: CUSTOMERS_URL + "/" + created.id,
      headers: requestHeaders(cookie),
      remoteAddress: "192.0.2.212",
    });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { id: string }).id).toBe(created.id);

    const bytes = Buffer.from([0, 1, 2, 3, 254, 255]);
    const uploaded = await app.inject({
      method: "POST",
      url: UPLOAD_URL + "?name=SYN-CX033-Spot.mp4",
      headers: requestHeaders(cookie, {
        origin: ORIGIN,
        "content-type": "application/octet-stream",
      }),
      payload: bytes,
      remoteAddress: "192.0.2.213",
    });
    expect(uploaded.statusCode).toBe(201);
    expect(upload.spy).toHaveBeenCalledTimes(1);
    const input = upload.calls[0] as CreateMediaInput;
    expect(input.displayName).toBe("SYN-CX033-Spot.mp4");
    expect(input.actorType).toBe("admin");
    expect(input.actorId).toBe(LEGACY_ADMIN_PRINCIPAL_ID);
    expect(Object.keys(uploaded.json()).sort()).toEqual([
      "id",
      "name",
      "profile",
      "sha256",
      "size_bytes",
    ]);
  });

  it("JSON-Baustein: unbekanntes Feld, falscher Typ und ungueltige UUID ergeben bereinigt 400, ohne Bereinigung, Konvertierung oder Handleraufruf", async () => {
    const app = Fastify({ logger: false });
    installContractErrorHandling(app);

    let seenBody: unknown;
    const handler = vi.fn(
      async (request: FastifyRequest, reply: FastifyReply) => {
        seenBody = request.body;
        reply.code(200).type("application/json; charset=utf-8").send({ ok: true });
      },
    );
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["id", "name", "count"],
      properties: {
        id: { type: "string", format: "uuid" },
        name: { type: "string" },
        count: { type: "number" },
      },
    };
    registerJsonRoute(app, {
      method: "POST",
      url: "/test/cx033/validated",
      bodySchema: schema,
      handler: handler as unknown as RouteHandlerMethod,
    });
    await app.ready();
    openApps.add(app);

    const validId = randomUUID();
    const invalidCases = [
      {
        name: "unbekanntes Feld",
        payload: {
          id: validId,
          name: "SYN-CX033",
          count: 1,
          unerlaubt: "darf-nicht-bereinigt-werden",
        },
      },
      {
        name: "falscher Typ ohne Konvertierung",
        payload: { id: validId, name: "SYN-CX033", count: "1" },
      },
      {
        name: "ungueltige UUID",
        payload: { id: "keine-uuid", name: "SYN-CX033", count: 1 },
      },
    ];

    for (const testCase of invalidCases) {
      const response = await app.inject({
        method: "POST",
        url: "/test/cx033/validated",
        headers: { host: HOST, "content-type": "application/json" },
        payload: testCase.payload,
        remoteAddress: "192.0.2.220",
      });
      expectInvalidRequest(response);
      expect(response.body, testCase.name).not.toContain(
        "darf-nicht-bereinigt-werden",
      );
    }
    expect(handler).not.toHaveBeenCalled();

    const validBody = { id: validId, name: "SYN-CX033", count: 2 };
    const valid = await app.inject({
      method: "POST",
      url: "/test/cx033/validated",
      headers: { host: HOST, "content-type": "application/json" },
      payload: validBody,
      remoteAddress: "192.0.2.221",
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(seenBody).toEqual(validBody);
  });

  it("Fehlerbaustein: bekannter Konflikt bleibt 409, unbekannte Ausnahme wird bereinigt 500, bestehende U7-Antwort bleibt unveraendert", async () => {
    const app = Fastify({ logger: false });
    installContractErrorHandling(app);

    registerJsonRoute(app, {
      method: "GET",
      url: "/test/cx033/conflict",
      handler: async () => {
        throw new ApiError("environment_mismatch");
      },
    });

    const leaked = "select * from secrets where key = 'SYN-CX033-KEY'";
    const unexpected = Object.assign(
      new Error("cookie=gt_ads_session=SYN-CX033-COOKIE; " + leaked),
      {
        statusCode: 409,
        sql: leaked,
        stack: "SYN-CX033-STACK\n    at handler",
      },
    );
    registerJsonRoute(app, {
      method: "GET",
      url: "/test/cx033/unexpected",
      handler: async () => {
        throw unexpected;
      },
    });
    await app.ready();
    openApps.add(app);

    const conflict = await app.inject({
      method: "GET",
      url: "/test/cx033/conflict",
      headers: { host: HOST },
      remoteAddress: "192.0.2.230",
    });
    expect(conflict.statusCode).toBe(409);
    const conflictBody = conflict.json() as {
      error: { code: string; message: string; request_id: string };
    };
    expect(Object.keys(conflictBody.error).sort()).toEqual([
      "code",
      "message",
      "request_id",
    ]);
    expect(conflictBody.error.code).toBe("environment_mismatch");
    expect(conflictBody.error.message).toBe(
      "Die App-Umgebung passt nicht zur Server-Umgebung.",
    );
    expect(typeof conflictBody.error.request_id).toBe("string");

    const failure = await app.inject({
      method: "GET",
      url: "/test/cx033/unexpected",
      headers: { host: HOST },
      remoteAddress: "192.0.2.231",
    });
    expect(failure.statusCode).toBe(500);
    const failureBody = failure.json() as {
      error: { code: string; message: string; request_id: string };
    };
    expect(Object.keys(failureBody.error).sort()).toEqual([
      "code",
      "message",
      "request_id",
    ]);
    expect(failureBody.error.code).toBe("internal_error");
    expect(failureBody.error.message).toBe("Interner Fehler.");
    expect(typeof failureBody.error.request_id).toBe("string");
    expect(failure.body).not.toContain("SYN-CX033");
    expect(failure.body).not.toContain("select * from secrets");
    expect(failure.body).not.toContain("gt_ads_session");
    expect(failure.body).not.toContain("at handler");

    // Repraesentative bestehende U7-Antwort: unveraendert 401 unauthorized.
    const realApp = await buildApp();
    const u7 = await realApp.inject({
      method: "GET",
      url: "/v1/admin/devices",
      headers: { host: HOST },
      remoteAddress: "192.0.2.232",
    });
    expect(u7.statusCode).toBe(401);
    expect(u7.headers["content-type"]).toContain("application/json");
    const u7Body = u7.json() as {
      error: { code: string; message: string; request_id: string };
    };
    expect(Object.keys(u7Body.error).sort()).toEqual([
      "code",
      "message",
      "request_id",
    ]);
    expect(u7Body.error.code).toBe("unauthorized");
    expect(u7Body.error.message).toBe("Nicht autorisiert.");
    expect(typeof u7Body.error.request_id).toBe("string");
    if (u7.headers["x-request-id"] !== undefined) {
      expect(u7Body.error.request_id).toBe(u7.headers["x-request-id"]);
    }
  });

  it("zwei echte App-Instanzen: keine Doppelregistrierung, kein geteilter Zustand, keine Backup-/Restore-/Alarmaufrufe, Health bleibt oeffentlich", async () => {
    const app1 = await buildApp();
    const keys1 = getRoutePolicyInventory(app1).map(
      (record) => record.method + " " + record.url,
    );
    const snapshot1 = [...keys1];

    const matrixRoutes = [
      "POST /v1/admin/media",
      "GET /v1/admin/customers",
      "POST /v1/admin/customers",
      "GET /v1/admin/customers/:id",
    ];
    for (const route of matrixRoutes) {
      expect(keys1.filter((key) => key === route), route).toHaveLength(1);
    }

    const health1 = await app1.inject({
      method: "GET",
      url: "/health",
      remoteAddress: "192.0.2.240",
    });
    expect(health1.statusCode).toBe(200);
    expect(health1.json()).toEqual({
      status: "ok",
      env: "test",
      version: "0.1.0",
    });

    const app2 = await buildApp();
    const keys2 = getRoutePolicyInventory(app2).map(
      (record) => record.method + " " + record.url,
    );

    expect(keys2.length).toBe(snapshot1.length);
    expect(new Set(keys2).size).toBe(keys2.length);
    expect(keys1).toEqual(snapshot1);
    for (const route of matrixRoutes) {
      expect(keys2.filter((key) => key === route), route).toHaveLength(1);
    }
    for (const key of keys2) {
      expect(key).not.toMatch(/backup|restore|alarm|campaign/i);
    }

    const health2 = await app2.inject({
      method: "GET",
      url: "/health",
      remoteAddress: "192.0.2.241",
    });
    expect(health2.statusCode).toBe(200);

    expect(vi.mocked(createDump)).not.toHaveBeenCalled();
    expect(vi.mocked(verifyRestore)).not.toHaveBeenCalled();
    expect(vi.mocked(dispatchPending)).not.toHaveBeenCalled();

    await app2.close();
    openApps.delete(app2);

    // app1 ist nach dem Schliessen von app2 weiterhin eigenstaendig nutzbar.
    const healthAfter = await app1.inject({
      method: "GET",
      url: "/health",
      remoteAddress: "192.0.2.242",
    });
    expect(healthAfter.statusCode).toBe(200);
    expect(keys1).toEqual(snapshot1);

    await app1.close();
    openApps.delete(app1);
  });
});
