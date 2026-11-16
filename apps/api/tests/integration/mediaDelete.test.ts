/**
 * CX-079 / R-203: Integration der geschuetzten logischen Medienloeschung.
 *
 * Die Tests laufen gegen die echte Serverfabrik, eine echte PostgreSQL-
 * Datenbank und echte Admin-/Operator-Sitzungscookies. Authentifizierung,
 * Rechtepruefung und Origin-Schutz werden nicht gemockt. Nur im vierten Fall
 * wird die vorhandene deleteMedia-Servicegrenze kontrolliert ersetzt, um eine
 * unerwartete Ausnahme mit synthetischen SQL-, Pfad- und Stackdetails zu
 * erzeugen. Alle Kennungen und Texte sind synthetisch.
 */
import { randomUUID } from "node:crypto";
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
  vi,
} from "vitest";
import { CONFIG_DEFAULTS, type AppConfig } from "../../src/config.js";
import { hashPassword } from "../../src/crypto/password.js";
import { generateAccessToken, hashToken } from "../../src/crypto/tokens.js";
import { migrateUp } from "../../src/db/migrate.js";
import { LEGACY_ADMIN_PRINCIPAL_ID } from "../../src/http/principal.js";
import { createServer } from "../../src/http/server.js";
import { ADMIN_SESSION_COOKIE } from "../../src/modules/adminAuth/middleware.js";
import { OPERATOR_SCRYPT_PARAMS } from "../../src/modules/adminAuth/service.js";
import { ensureCampaignSchema } from "../../src/modules/campaigns/schema.js";

vi.mock("../../src/modules/media/index.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/modules/media/index.js")
  >();
  return { ...actual, deleteMedia: vi.fn(actual.deleteMedia) };
});

import {
  MEDIA_DELETED_ACTION,
  deleteMedia,
} from "../../src/modules/media/index.js";

const BASE_TIME = Date.parse("2026-11-16T09:00:00.000Z");
const ADMIN_PASSWORD = "SYN-CX079-Admin-Passwort";
const OPERATOR_USERNAME = "syn.cx079.operator";
const OPERATOR_PASSWORD = "SYN-CX079-Operator-Passwort";
const HOST = "127.0.0.1:8080";
const FOREIGN_ORIGIN = "http://fremde.example";
const JSON_HEADERS = { "content-type": "application/json" };
const TRUNCATE_SQL = [
  "truncate table media_objects, campaigns, campaign_targets, audit_events,",
  "  admin_sessions, device_access_tokens, device_auth_challenges,",
  "  registration_codes, devices restart identity cascade",
].join("\n");

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/db/migrations",
);

const deleteBoundary = vi.mocked(deleteMedia);

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let config: AppConfig;
let operatorActorId = "";
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
    throw new Error("CX-079 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

async function applyMigration(fileName: string): Promise<void> {
  await pool.query(await readFile(join(MIGRATIONS_DIR, fileName), "utf8"));
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx079_delete_" +
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
  await applyMigration("0007_cx_030_media.up.sql");
  await applyMigration("0009_campaign_customers.up.sql");
  await applyMigration("0011_cx_078_media_deletion.up.sql");
  await applyMigration("0015_cx_057_operators.up.sql");
  await ensureCampaignSchema(pool);

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX079-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };

  operatorActorId = randomUUID();
  await pool.query(
    [
      "insert into operators",
      "  (actor_id, username, password_hash, status, created_at, disabled_at)",
      "values ($1::uuid, $2, $3, 'active', $4, null)",
    ].join("\n"),
    [
      operatorActorId,
      OPERATOR_USERNAME,
      await hashPassword(OPERATOR_PASSWORD, {
        params: OPERATOR_SCRYPT_PARAMS,
      }),
      new Date(BASE_TIME - 86_400_000),
    ],
  );
}, 120_000);

beforeEach(async () => {
  await pool.query(TRUNCATE_SQL);
  deleteBoundary.mockClear();
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
  const app = createServer({
    config,
    pool,
    now: () => new Date(BASE_TIME),
    logger: { level: "silent" },
  });
  await app.ready();
  openApps.push(app);
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
  return (first as string)
    .split(";")[0]!
    .slice(ADMIN_SESSION_COOKIE.length + 1);
}

async function loginCookie(
  app: FastifyInstance,
  options: { username?: string; password: string },
): Promise<string> {
  const payload: Record<string, string> = { password: options.password };
  if (options.username !== undefined) {
    payload.username = options.username;
  }
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/login",
    headers: { host: HOST, ...JSON_HEADERS },
    payload,
    remoteAddress: "192.0.2.79",
  });
  expect(response.statusCode, response.body).toBe(204);
  return sessionCookieOf(response);
}

function headers(
  cookie: string | null,
  extra: Record<string, string> = {},
): Record<string, string> {
  const result: Record<string, string> = { host: HOST, ...extra };
  if (cookie !== null) {
    result.cookie = ADMIN_SESSION_COOKIE + "=" + cookie;
  }
  return result;
}

function deleteUrl(id: string, query = ""): string {
  return "/v1/admin/media/" + encodeURIComponent(id) + query;
}

function deleteRequest(
  app: FastifyInstance,
  id: string,
  requestHeaders: Record<string, string>,
  options: { query?: string; payload?: unknown } = {},
) {
  const url = deleteUrl(id, options.query ?? "");
  if (options.payload !== undefined) {
    return app.inject({
      method: "DELETE",
      url,
      headers: requestHeaders,
      payload: options.payload as Record<string, unknown>,
      remoteAddress: "192.0.2.80",
    });
  }
  return app.inject({
    method: "DELETE",
    url,
    headers: requestHeaders,
    remoteAddress: "192.0.2.80",
  });
}

async function insertMedia(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    [
      "insert into media_objects",
      "  (id, display_name, size_bytes, sha256, container, video_codec,",
      "   width, height, frame_rate_numerator, frame_rate_denominator,",
      "   audio_stream_count, duration_seconds, created_at, status, ready_at,",
      "   deleted_at)",
      "values ($1::uuid, $2, 4096, $3, 'mp4', 'h264', 1920, 1080, 30, 1,",
      "        0, 15, $4, 'ready', $4, null)",
    ].join("\n"),
    [id, "SYN-CX079-Medium", "a".repeat(64), new Date(BASE_TIME)],
  );
  return id;
}

async function insertActiveCampaignReference(mediaId: string): Promise<void> {
  const customerId = randomUUID();
  await pool.query(
    "insert into customers (id, display_name) values ($1::uuid, $2)",
    [customerId, "SYN-CX079-Kunde"],
  );
  await pool.query(
    [
      "insert into campaigns",
      "  (id, customer_id, media_id, owner_id, rule_type, status, archived,",
      "   start_at, end_at, revision)",
      "values ($1::uuid, $2::uuid, $3::uuid, $4, 'fixed_slot', 'active',",
      "        false, $5, $6, 1)",
    ].join("\n"),
    [
      randomUUID(),
      customerId,
      mediaId,
      "SYN-CX079-Operator",
      new Date(BASE_TIME + 86_400_000),
      new Date(BASE_TIME + 30 * 86_400_000),
    ],
  );
}

async function insertDeviceAccessToken(): Promise<string> {
  const registrationCodeId = randomUUID();
  const deviceId = randomUUID();
  const token = generateAccessToken();
  await pool.query(
    [
      "insert into registration_codes",
      "  (id, code_hash, label, created_at, created_by, expires_at)",
      "values ($1::uuid, $2, $3, $4, $5, $6)",
    ].join("\n"),
    [
      registrationCodeId,
      Buffer.from("SYN-CX079-Code-" + registrationCodeId),
      "SYN-CX079",
      new Date(BASE_TIME),
      "SYN-CX079-Admin",
      new Date(BASE_TIME + 3_600_000),
    ],
  );
  await pool.query(
    [
      "insert into devices",
      "  (id, label, public_key_spki, public_key_fingerprint, state,",
      "   manufacturer, model, os_version, sdk_int, app_version, app_flavor,",
      "   registration_code_id, registration_request_id, registered_at,",
      "   last_seen_at)",
      "values ($1::uuid, $2, $3, $4, 'active', $5, $6, $7, 34, $8, 'syn',",
      "        $9::uuid, $10::uuid, $11, $11)",
    ].join("\n"),
    [
      deviceId,
      "SYN-CX079-Tablet",
      Buffer.from("SYN-CX079-Key-" + deviceId),
      "SYN-CX079-FP-" + deviceId,
      "SYN-Hersteller",
      "SYN-Modell",
      "SYN-Android",
      "0.0.0-syn",
      registrationCodeId,
      randomUUID(),
      new Date(BASE_TIME),
    ],
  );
  await pool.query(
    [
      "insert into device_access_tokens",
      "  (id, device_id, token_hash, created_at, expires_at)",
      "values ($1::uuid, $2::uuid, $3, $4, $5)",
    ].join("\n"),
    [
      randomUUID(),
      deviceId,
      hashToken(token),
      new Date(BASE_TIME),
      new Date(BASE_TIME + 3_600_000),
    ],
  );
  return token;
}

async function mediaDeletedAt(mediaId: string): Promise<Date | null> {
  const result = await pool.query<{ deleted_at: Date | null }>(
    "select deleted_at from media_objects where id = $1::uuid",
    [mediaId],
  );
  return result.rows[0]?.deleted_at ?? null;
}

interface DeletionAuditRow {
  actor_type: string;
  actor_id: string | null;
  target_type: string | null;
  target_id: string | null;
}

async function deletionAudits(mediaId: string): Promise<DeletionAuditRow[]> {
  const result = await pool.query<DeletionAuditRow>(
    [
      "select actor_type, actor_id, target_type, target_id",
      "  from audit_events",
      " where action = $1 and target_id = $2",
      " order by id asc",
    ].join("\n"),
    [MEDIA_DELETED_ACTION, mediaId],
  );
  return result.rows;
}

async function countDeletionAudits(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "select count(*)::text as count from audit_events where action = $1",
    [MEDIA_DELETED_ACTION],
  );
  return Number(result.rows[0]?.count ?? "0");
}

function expectApiError(
  response: { statusCode: number; json: () => any },
  statusCode: number,
  code: string,
): void {
  expect(response.statusCode).toBe(statusCode);
  expect(response.json().error.code).toBe(code);
}

describe("CX-079 geschuetzte logische Medienloeschung", () => {
  it("Admin loescht ein ungenutztes Medium, Operator wiederholt idempotent: beide 204 ohne Body, ein Erfolgsaudit mit dem urspruenglichen Akteur", async () => {
    const app = await buildApp();
    const mediaId = await insertMedia();
    const adminCookie = await loginCookie(app, { password: ADMIN_PASSWORD });
    const operatorCookie = await loginCookie(app, {
      username: OPERATOR_USERNAME,
      password: OPERATOR_PASSWORD,
    });

    const first = await deleteRequest(app, mediaId, headers(adminCookie));
    expect(first.statusCode, first.body).toBe(204);
    expect(first.body).toBe("");

    const second = await deleteRequest(app, mediaId, headers(operatorCookie));
    expect(second.statusCode, second.body).toBe(204);
    expect(second.body).toBe("");

    expect(await mediaDeletedAt(mediaId)).not.toBeNull();
    const audits = await deletionAudits(mediaId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_type: "admin",
      actor_id: LEGACY_ADMIN_PRINCIPAL_ID,
      target_type: "media",
      target_id: mediaId,
    });
    expect(deleteBoundary).toHaveBeenCalledTimes(2);
  }, 30_000);

  it("weist anonyme, ausschliesslich geraeteauthentifizierte und fremd-originierte Verwaltungssitzungen ohne Body ab und laesst Medium und Audit unveraendert", async () => {
    const app = await buildApp();
    const mediaId = await insertMedia();
    const adminCookie = await loginCookie(app, { password: ADMIN_PASSWORD });
    const deviceToken = await insertDeviceAccessToken();

    const anonymous = await deleteRequest(app, mediaId, headers(null));
    expectApiError(anonymous, 401, "unauthorized");

    const deviceOnly = await deleteRequest(app, mediaId, {
      host: HOST,
      authorization: "Bearer " + deviceToken,
    });
    expectApiError(deviceOnly, 401, "unauthorized");

    const foreignOrigin = await deleteRequest(
      app,
      mediaId,
      headers(adminCookie, { origin: FOREIGN_ORIGIN }),
    );
    expectApiError(foreignOrigin, 403, "forbidden");

    expect(await mediaDeletedAt(mediaId)).toBeNull();
    expect(await deletionAudits(mediaId)).toHaveLength(0);
    expect(deleteBoundary).not.toHaveBeenCalled();
  }, 30_000);

  it("meldet aktive Kampagnenreferenz als 409, unbekannte gueltige ID als 404 und Validierungsfehler als 400, ohne Medium oder Audit zu veraendern", async () => {
    const app = await buildApp();
    const adminCookie = await loginCookie(app, { password: ADMIN_PASSWORD });
    const inUseMediaId = await insertMedia();
    await insertActiveCampaignReference(inUseMediaId);
    const unknownMediaId = randomUUID();
    const queryMediaId = await insertMedia();
    const bodyMediaId = await insertMedia();

    const inUse = await deleteRequest(app, inUseMediaId, headers(adminCookie));
    expectApiError(inUse, 409, "invalid_request");

    const unknown = await deleteRequest(
      app,
      unknownMediaId,
      headers(adminCookie),
    );
    expectApiError(unknown, 404, "not_found");

    const invalidId = await deleteRequest(
      app,
      "SYN-CX079-kein-schluessel",
      headers(adminCookie),
    );
    expectApiError(invalidId, 400, "invalid_request");

    const unknownQuery = await deleteRequest(
      app,
      queryMediaId,
      headers(adminCookie),
      { query: "?force=1" },
    );
    expectApiError(unknownQuery, 400, "invalid_request");

    const unexpectedBody = await deleteRequest(
      app,
      bodyMediaId,
      headers(adminCookie, JSON_HEADERS),
      { payload: { unexpected: true } },
    );
    expectApiError(unexpectedBody, 400, "invalid_request");

    expect(await mediaDeletedAt(inUseMediaId)).toBeNull();
    expect(await mediaDeletedAt(queryMediaId)).toBeNull();
    expect(await mediaDeletedAt(bodyMediaId)).toBeNull();
    expect(await countDeletionAudits()).toBe(0);
  }, 30_000);

  it("bereinigt eine unerwartete Serviceausnahme mit synthetischen SQL-, Pfad- und Stackdetails zu 500 ohne Erfolgsaudit", async () => {
    const app = await buildApp();
    const mediaId = await insertMedia();
    const adminCookie = await loginCookie(app, { password: ADMIN_PASSWORD });
    const leakyError = new Error(
      "select * from media_objects where id = '" +
        mediaId +
        "'; datei /srv/geheim/media/objekt.bin; " +
        "at Object.<anonymous> (/srv/geheim/app/modul.js:42:7)",
    );
    leakyError.stack =
      "Error: " +
      leakyError.message +
      "\n    at deleteMedia (/srv/geheim/app/modul.js:42:7)";
    deleteBoundary.mockRejectedValueOnce(leakyError);

    const response = await deleteRequest(app, mediaId, headers(adminCookie));
    expect(response.statusCode).toBe(500);
    const body = response.body;
    expect(response.json().error.code).toBe("internal_error");
    expect(body).not.toContain("select * from media_objects");
    expect(body).not.toContain("media_objects");
    expect(body).not.toContain("/srv/geheim");
    expect(body).not.toContain("objekt.bin");
    expect(body).not.toContain("modul.js:42");
    expect(body).not.toContain("at deleteMedia");

    expect(await mediaDeletedAt(mediaId)).toBeNull();
    expect(await deletionAudits(mediaId)).toHaveLength(0);
    expect(deleteBoundary).toHaveBeenCalledTimes(1);
  }, 30_000);
});
