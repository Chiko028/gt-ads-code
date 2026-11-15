/**
 * CX-095 / R-203: geschuetzte, paginierte Medienliste.
 *
 * Vier Faelle mit echter App-Fabrik, echtem Rechtekern und isolierter
 * PostgreSQL-Datenbank: Zugriff, Sichtbarkeit/Projektion, Keyset-Pagination
 * sowie bereinigte Eingabefehler ohne schreibende Nebenwirkungen.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import { CONFIG_DEFAULTS, type AppConfig } from "../config.js";
import { hashPassword } from "../crypto/password.js";
import { migrateUp } from "../db/migrate.js";
import { ADMIN_SESSION_COOKIE } from "../modules/adminAuth/middleware.js";
import {
  MEDIA_DEFAULT_LIST_LIMIT,
  MEDIA_MAX_LIST_LIMIT,
  type MediaProfileMetadata,
} from "../modules/media/index.js";
import type { PrincipalResolver } from "./principal.js";
import { createServer } from "./server.js";

const BASE_TIME = Date.parse("2026-09-01T08:00:00.000Z");
const ADMIN_PASSWORD = "SYN-CX095-Listen-Passwort";
const HOST = "127.0.0.1:8080";
const LIST_URL = "/v1/admin/media";
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
let storageRoot = "";
let previousStorageRoot: string | undefined;
let config: AppConfig;
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
    throw new Error("CX-095 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx095_list_" +
    process.pid +
    "_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 8)
  )
    .toLowerCase()
    .slice(0, 63);
  await maintenancePool.query(
    "create database " + quoteIdentifier(databaseName),
  );

  pool = new Pool({ ...base, database: databaseName });
  await migrateUp(pool);
  // Medienbasis und logische Loeschmarkierung sind additive Migrationen.
  for (const name of [
    "0007_cx_030_media.up.sql",
    "0011_cx_078_media_deletion.up.sql",
  ]) {
    await pool.query(await readFile(join(MIGRATIONS_DIR, name), "utf8"));
  }

  storageRoot = await mkdtemp(join(tmpdir(), "cx095-media-"));
  previousStorageRoot = process.env.GT_ADS_MEDIA_STORAGE_ROOT;
  process.env.GT_ADS_MEDIA_STORAGE_ROOT = storageRoot;

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX095-Listen-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };
}, 60_000);

beforeEach(async () => {
  await pool.query(
    "truncate table audit_events, admin_sessions, media_objects restart identity cascade",
  );
});

afterEach(async () => {
  for (const app of openApps.splice(0)) {
    await app.close();
  }
});

afterAll(async () => {
  if (previousStorageRoot === undefined) {
    delete process.env.GT_ADS_MEDIA_STORAGE_ROOT;
  } else {
    process.env.GT_ADS_MEDIA_STORAGE_ROOT = previousStorageRoot;
  }
  await pool.end();
  await maintenancePool.query(
    "drop database if exists " + quoteIdentifier(databaseName),
  );
  await maintenancePool.end();
  await rm(storageRoot, { recursive: true, force: true });
}, 30_000);

async function buildApp(
  resolvePrincipal?: PrincipalResolver,
): Promise<FastifyInstance> {
  const app = createServer({
    config,
    pool,
    now: () => new Date(BASE_TIME),
    ...(resolvePrincipal === undefined ? {} : { resolvePrincipal }),
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
    remoteAddress: "192.0.2.210",
  });
  expect(response.statusCode).toBe(204);
  return sessionCookieOf(response);
}

function listHeaders(
  cookie?: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = { host: HOST, ...extra };
  if (cookie !== undefined) {
    headers.cookie = ADMIN_SESSION_COOKIE + "=" + cookie;
  }
  return headers;
}

async function insertReady(options: {
  displayName: string;
  createdAt?: Date;
  deletedAt?: Date | null;
}): Promise<string> {
  const id = randomUUID();
  await pool.query(
    [
      "insert into media_objects",
      "  (id, display_name, size_bytes, sha256, container, video_codec,",
      "   width, height, frame_rate_numerator, frame_rate_denominator,",
      "   audio_stream_count, duration_seconds, created_at, status, ready_at,",
      "   deleted_at)",
      "values ($1::uuid, $2, 4096, $3, $4, $5, $6, $7, $8, $9, $10, $11,",
      "        $12, 'ready', $12, $13)",
    ].join("\n"),
    [
      id,
      options.displayName,
      "b".repeat(64),
      PROFILE.container,
      PROFILE.videoCodec,
      PROFILE.width,
      PROFILE.height,
      PROFILE.frameRateNumerator,
      PROFILE.frameRateDenominator,
      PROFILE.audioStreamCount,
      PROFILE.durationSeconds,
      options.createdAt ?? new Date(BASE_TIME),
      options.deletedAt ?? null,
    ],
  );
  return id;
}

async function insertStaging(displayName: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    [
      "insert into media_objects (id, display_name, created_at, status)",
      "values ($1::uuid, $2, $3, 'staging')",
    ].join("\n"),
    [id, displayName, new Date(BASE_TIME)],
  );
  return id;
}

function rawCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

async function mediaSnapshot(): Promise<string> {
  const result = await pool.query(
    [
      "select id::text, display_name, size_bytes::text, sha256, container,",
      "       video_codec, width, height, frame_rate_numerator,",
      "       frame_rate_denominator, audio_stream_count, duration_seconds,",
      "       created_at, status, ready_at, deleted_at",
      "  from media_objects",
      " order by id",
    ].join("\n"),
  );
  return JSON.stringify(result.rows);
}

async function auditSnapshot(): Promise<string> {
  const result = await pool.query(
    [
      "select id::text, at, actor_type, actor_id, action, target_type,",
      "       target_id, details",
      "  from audit_events",
      " order by id",
    ].join("\n"),
  );
  return JSON.stringify(result.rows);
}

interface ListItem {
  id: string;
  name: string;
  size_bytes: number;
  sha256: string;
  profile: Record<string, unknown>;
  created_at: string;
}

interface ListBody {
  items: ListItem[];
  next_cursor: string | null;
}

describe("CX-095 / R-203 geschuetzte Medienliste", () => {
  it("verweigert anonyme und nur behauptete Rollen mit 401, erlaubt Admin und verifiziertem Operator 200", async () => {
    const app = await buildApp();
    const claimedHeaders = {
      "x-role": "Admin",
      "x-admin-role": "Admin",
      "x-gt-ads-role": "Admin",
      authorization: "Bearer SYN-CX095-Behauptung",
    };

    const anonymous = await app.inject({
      method: "GET",
      url: LIST_URL,
      headers: listHeaders(undefined, claimedHeaders),
      remoteAddress: "192.0.2.211",
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().error.code).toBe("unauthorized");

    const forgedSession = await app.inject({
      method: "GET",
      url: LIST_URL,
      headers: listHeaders("SYN-CX095-erfunden", claimedHeaders),
      remoteAddress: "192.0.2.212",
    });
    expect(forgedSession.statusCode).toBe(401);
    expect(forgedSession.json().error.code).toBe("unauthorized");

    const adminCookie = await loginCookie(app);
    const admin = await app.inject({
      method: "GET",
      url: LIST_URL,
      headers: listHeaders(adminCookie),
      remoteAddress: "192.0.2.213",
    });
    expect(admin.statusCode).toBe(200);
    expect(admin.json()).toEqual({ items: [], next_cursor: null });

    // Der vorhandene Rechtekern kennt Operator als verifizierte menschliche
    // Rolle. Die Testgrenze ersetzt ausschliesslich die Sitzungsaufloesung.
    const operatorApp = await buildApp(async (request) => {
      const token = request.cookies?.[ADMIN_SESSION_COOKIE];
      return token === "SYN-CX095-Operator"
        ? { id: "SYN-Operator", role: "Operator" }
        : null;
    });
    const operator = await operatorApp.inject({
      method: "GET",
      url: LIST_URL,
      headers: listHeaders("SYN-CX095-Operator"),
      remoteAddress: "192.0.2.214",
    });
    expect(operator.statusCode).toBe(200);
    expect(operator.json()).toEqual({ items: [], next_cursor: null });

    const operatorAnonymous = await operatorApp.inject({
      method: "GET",
      url: LIST_URL,
      headers: listHeaders(undefined, claimedHeaders),
      remoteAddress: "192.0.2.215",
    });
    expect(operatorAnonymous.statusCode).toBe(401);
  });

  it("zeigt nur ready-Medien ohne logische Loeschung mit freigegebenen Metadaten und ohne Speicherpfade oder interne Details", async () => {
    const visibleId = await insertReady({
      displayName: "SYN-CX095-Sichtbar.mp4",
    });
    await insertReady({
      displayName: "SYN-CX095-Geloescht.mp4",
      deletedAt: new Date(BASE_TIME + 1000),
    });
    await insertStaging("SYN-CX095-Staging.mp4");

    const app = await buildApp();
    const cookie = await loginCookie(app);
    const response = await app.inject({
      method: "GET",
      url: LIST_URL,
      headers: listHeaders(cookie),
      remoteAddress: "192.0.2.220",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as ListBody;
    expect(body.items).toHaveLength(1);
    expect(body.next_cursor).toBeNull();
    expect(Object.keys(body).sort()).toEqual(["items", "next_cursor"]);

    const item = body.items[0] as ListItem;
    expect(Object.keys(item).sort()).toEqual([
      "created_at",
      "id",
      "name",
      "profile",
      "sha256",
      "size_bytes",
    ]);
    expect(item.id).toBe(visibleId);
    expect(item.name).toBe("SYN-CX095-Sichtbar.mp4");
    expect(item.size_bytes).toBe(4096);
    expect(item.sha256).toBe("b".repeat(64));
    expect(item.created_at).toBe(new Date(BASE_TIME).toISOString());
    expect(item.profile).toEqual({
      container: PROFILE.container,
      video_codec: PROFILE.videoCodec,
      width: PROFILE.width,
      height: PROFILE.height,
      frame_rate_numerator: PROFILE.frameRateNumerator,
      frame_rate_denominator: PROFILE.frameRateDenominator,
      audio_stream_count: PROFILE.audioStreamCount,
      duration_seconds: PROFILE.durationSeconds,
    });

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("SYN-CX095-Geloescht");
    expect(serialized).not.toContain("SYN-CX095-Staging");
    expect(serialized).not.toContain(storageRoot);
    expect(serialized).not.toContain("staging");
    expect(serialized).not.toContain("deleted_at");
    expect(serialized).not.toContain("password");
    expect(item).not.toHaveProperty("read");
    expect(item).not.toHaveProperty("path");
    expect(item).not.toHaveProperty("content");
  });

  it("paginiert identische Erstellungszeiten ohne Dubletten, haelt Standard 50 und Maximum 100 ein und liefert eine leere Abschlussseite", async () => {
    const createdAt = new Date(BASE_TIME);
    const inserted: string[] = [];
    for (let index = 0; index < 101; index += 1) {
      inserted.push(
        await insertReady({
          displayName: "SYN-CX095-Seite-" + String(index).padStart(3, "0"),
          createdAt,
        }),
      );
    }

    const app = await buildApp();
    const cookie = await loginCookie(app);

    const defaultPage = await app.inject({
      method: "GET",
      url: LIST_URL,
      headers: listHeaders(cookie),
      remoteAddress: "192.0.2.230",
    });
    expect(defaultPage.statusCode).toBe(200);
    const defaultBody = defaultPage.json() as ListBody;
    expect(defaultBody.items).toHaveLength(MEDIA_DEFAULT_LIST_LIMIT);
    expect(defaultBody.next_cursor).not.toBeNull();

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string =
        cursor === null
          ? LIST_URL + "?limit=" + MEDIA_DEFAULT_LIST_LIMIT
          : LIST_URL +
            "?limit=" +
            MEDIA_DEFAULT_LIST_LIMIT +
            "&cursor=" +
            encodeURIComponent(cursor);
      const page = await app.inject({
        method: "GET",
        url,
        headers: listHeaders(cookie),
        remoteAddress: "192.0.2.231",
      });
      expect(page.statusCode).toBe(200);
      const pageBody = page.json() as ListBody;
      expect(pageBody.items.length).toBeLessThanOrEqual(
        MEDIA_DEFAULT_LIST_LIMIT,
      );
      seen.push(...pageBody.items.map((entry) => entry.id));
      cursor = pageBody.next_cursor;
      pages += 1;
      if (pages > 10) {
        throw new Error("Pagination terminiert nicht.");
      }
    } while (cursor !== null);

    expect(seen).toHaveLength(inserted.length);
    expect(new Set(seen).size).toBe(inserted.length);
    expect([...seen].sort()).toEqual([...inserted].sort());

    const maximumPage = await app.inject({
      method: "GET",
      url: LIST_URL + "?limit=" + MEDIA_MAX_LIST_LIMIT,
      headers: listHeaders(cookie),
      remoteAddress: "192.0.2.232",
    });
    expect(maximumPage.statusCode).toBe(200);
    const maximumBody = maximumPage.json() as ListBody;
    expect(maximumBody.items).toHaveLength(MEDIA_MAX_LIST_LIMIT);
    expect(maximumBody.next_cursor).not.toBeNull();

    const maximumNext = await app.inject({
      method: "GET",
      url:
        LIST_URL +
        "?limit=" +
        MEDIA_MAX_LIST_LIMIT +
        "&cursor=" +
        encodeURIComponent(maximumBody.next_cursor as string),
      headers: listHeaders(cookie),
      remoteAddress: "192.0.2.233",
    });
    expect(maximumNext.statusCode).toBe(200);
    const maximumNextBody = maximumNext.json() as ListBody;
    expect(maximumNextBody.items).toHaveLength(1);
    expect(maximumNextBody.next_cursor).toBeNull();

    const emptyPage = await app.inject({
      method: "GET",
      url:
        LIST_URL +
        "?limit=50&cursor=" +
        encodeURIComponent(
          rawCursor({
            createdAt: "2030-01-01T00:00:00.000Z",
            id: randomUUID(),
          }),
        ),
      headers: listHeaders(cookie),
      remoteAddress: "192.0.2.234",
    });
    expect(emptyPage.statusCode).toBe(200);
    expect(emptyPage.json()).toEqual({ items: [], next_cursor: null });
  });

  it("beantwortet ungueltige Cursor, unbekannte Queryfelder und ungueltige Limits bereinigt mit 400 und veraendert weder Medien noch Audit", async () => {
    await insertReady({ displayName: "SYN-CX095-Audit-A.mp4" });
    await insertReady({ displayName: "SYN-CX095-Audit-B.mp4" });

    const app = await buildApp();
    const cookie = await loginCookie(app);
    const beforeMedia = await mediaSnapshot();
    const beforeAudit = await auditSnapshot();

    const validId = randomUUID();
    const invalidQueries: string[] = [
      "?cursor=%21%21%21",
      "?cursor=",
      "?cursor=" + "a".repeat(600),
      "?cursor=" + encodeURIComponent(rawCursor({})),
      "?cursor=" + encodeURIComponent(rawCursor({ createdAt: "2026-09-01T08:00:00.000Z" })),
      "?cursor=" +
        encodeURIComponent(
          rawCursor({ createdAt: "2026-09-01T08:00:00Z", id: validId }),
        ),
      "?cursor=" +
        encodeURIComponent(
          rawCursor({ createdAt: "2026-09-01T08:00:00.000Z", id: "keine-uuid" }),
        ),
      "?cursor=" + encodeURIComponent(rawCursor({ createdAt: "2026-09-01T08:00:00.000Z", id: validId, extra: 1 })),
      "?cursor=abc&cursor=def",
      "?foo=1",
      "?limit=0",
      "?limit=101",
      "?limit=1.5",
      "?limit=abc",
      "?limit=",
      "?limit=-1",
      "?limit=1e2",
      "?limit=010",
      "?limit=1&limit=2",
    ];

    for (const query of invalidQueries) {
      const response = await app.inject({
        method: "GET",
        url: LIST_URL + query,
        headers: listHeaders(cookie),
        remoteAddress: "192.0.2.240",
      });
      expect(response.statusCode, query).toBe(400);
      const body = response.json() as {
        error: { code: string; message: string; request_id: string };
      };
      expect(Object.keys(body.error).sort(), query).toEqual([
        "code",
        "message",
        "request_id",
      ]);
      expect(body.error.code, query).toBe("invalid_request");
      expect(body.error.message, query).toBe("Die Anfrage ist ungueltig.");
      expect(typeof body.error.request_id, query).toBe("string");
      const serialized = JSON.stringify(body);
      expect(serialized, query).not.toContain(storageRoot);
      expect(serialized, query).not.toContain("select ");
      expect(serialized, query).not.toContain("invalid_cursor");
    }

    // Auch ein gueltiger Leseaufruf bleibt rein lesend.
    const valid = await app.inject({
      method: "GET",
      url: LIST_URL + "?limit=50",
      headers: listHeaders(cookie),
      remoteAddress: "192.0.2.241",
    });
    expect(valid.statusCode).toBe(200);
    expect((valid.json() as ListBody).items).toHaveLength(2);

    expect(await mediaSnapshot()).toBe(beforeMedia);
    expect(await auditSnapshot()).toBe(beforeAudit);
  });
});
