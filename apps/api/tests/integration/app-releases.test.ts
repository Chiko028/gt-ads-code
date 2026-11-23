/**
 * CX-168: App-Updates gegen echtes PostgreSQL, echte Admin-Sitzung und echte
 * Geraeteauthentifizierung. Alle IDs, Versionen und Zeiten sind synthetisch.
 */
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS, type AppConfig } from "../../src/config.js";
import { hashPassword } from "../../src/crypto/password.js";
import { generateAccessToken, hashToken } from "../../src/crypto/tokens.js";
import { migrateLatest } from "../../src/db/migrate.js";
import { createServer } from "../../src/http/server.js";
import type { MediaUploadDeps } from "../../src/http/mediaUpload.js";
import { ADMIN_SESSION_COOKIE } from "../../src/modules/adminAuth/middleware.js";

const BASE_TIME = Date.parse("2026-11-20T10:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const ADMIN_PASSWORD = "SYN-CX168-Update-Passwort";
const SECRET = "S".repeat(48);
const HOST = "127.0.0.1:8080";
const API_HEADERS = {
  "content-type": "application/json",
  "x-gt-ads-api-version": "1",
};
const TAXI_ID = "SYN-CX168-TAXI";

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let config: AppConfig;
let app: FastifyInstance;
let storageRoot = "";
let clockTime = BASE_TIME;
let loginCounter = 0;

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
    throw new Error("CX-168 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function mediaDeps(): MediaUploadDeps {
  return {
    createMedia: async () => {
      throw new Error("CX-168 nutzt den Medienpfad nicht");
    },
    serviceOptions: { pool, storageRoot },
  };
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx168_app_releases_" +
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
  await migrateLatest(pool);
  storageRoot = await mkdtemp(join(tmpdir(), "cx168-app-releases-"));
  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX168-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
    downloadSecret: SECRET,
  };
  app = createServer({
    config,
    pool,
    now: () => new Date(clockTime),
    logger: { level: "silent" },
    mediaUpload: mediaDeps(),
  });
  await app.ready();
}, 90_000);

afterAll(async () => {
  if (app !== undefined) {
    await app.close();
  }
  if (pool !== undefined) {
    await pool.end();
  }
  if (maintenancePool !== undefined) {
    await maintenancePool.query(
      "drop database if exists " + quoteIdentifier(databaseName),
    );
    await maintenancePool.end();
  }
  if (storageRoot !== "") {
    await rm(storageRoot, { recursive: true, force: true });
  }
}, 60_000);

beforeEach(async () => {
  clockTime = BASE_TIME;
  await pool.query(
    [
      "truncate table app_release_device_reports, app_releases,",
      "  device_access_tokens, device_auth_challenges, admin_sessions,",
      "  device_taxi_assignments, taxis, devices, registration_codes",
      " restart identity cascade",
    ].join("\n"),
  );
  await pool.query(
    "insert into taxis (id, display_name, active, revision) values ($1, $2, true, 1)",
    [TAXI_ID, "SYN CX-168 Taxi"],
  );
}, 30_000);

async function insertDevice(
  label: string,
  channel: "stable" | "pilot",
): Promise<string> {
  const deviceId = randomUUID();
  const registrationCodeId = randomUUID();
  await pool.query(
    "insert into registration_codes (id, code_hash, label, created_at," +
      " created_by, expires_at) values ($1::uuid, $2, $3, $4, $5, $6)",
    [
      registrationCodeId,
      Buffer.from("SYN-CX168-Code-" + registrationCodeId),
      label,
      new Date(BASE_TIME - HOUR_MS),
      "SYN-CX168-Admin",
      new Date(BASE_TIME + 24 * HOUR_MS),
    ],
  );
  await pool.query(
    "insert into devices (id, label, public_key_spki, public_key_fingerprint," +
      " state, manufacturer, model, os_version, sdk_int, app_version," +
      " app_flavor, registration_code_id, registration_request_id," +
      " registered_at, last_seen_at, update_channel)" +
      " values ($1::uuid, $2, $3, $4, 'active', 'SYN', 'SYN', '15', 35," +
      " '1.0.0', 'dev', $5::uuid, $6::uuid, $7, $8, $9)",
    [
      deviceId,
      label,
      Buffer.from("SYN-CX168-Key-" + deviceId),
      "SYN-CX168-FP-" + deviceId,
      registrationCodeId,
      randomUUID(),
      new Date(BASE_TIME - HOUR_MS),
      new Date(BASE_TIME),
      channel,
    ],
  );
  return deviceId;
}

async function deviceToken(deviceId: string): Promise<string> {
  const token = generateAccessToken();
  await pool.query(
    "insert into device_access_tokens (id, device_id, token_hash," +
      " created_at, expires_at) values ($1::uuid, $2::uuid, $3, $4, $5)",
    [
      randomUUID(),
      deviceId,
      hashToken(token),
      new Date(BASE_TIME - HOUR_MS),
      new Date(BASE_TIME + 24 * HOUR_MS),
    ],
  );
  return token;
}

async function loginCookie(): Promise<string> {
  loginCounter += 1;
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/login",
    headers: { host: HOST, "content-type": "application/json" },
    payload: { password: ADMIN_PASSWORD },
    remoteAddress: "192.0.2." + (100 + loginCounter),
  });
  expect(response.statusCode).toBe(204);
  const raw = response.headers["set-cookie"];
  const first = Array.isArray(raw) ? (raw[0] as string) : (raw as string);
  const pair = first.split(";")[0] as string;
  return pair.slice(ADMIN_SESSION_COOKIE.length + 1);
}

function apk(marker: string): Buffer {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(marker)]);
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

interface UploadOptions {
  readonly code: number;
  readonly name: string;
  readonly content?: Buffer;
  readonly sha?: string;
  readonly notes?: string;
  readonly extraQuery?: string;
}

async function upload(
  cookie: string | undefined,
  options: UploadOptions,
): Promise<ReturnType<FastifyInstance["inject"]>> {
  const content = options.content ?? apk("SYN-CX168-APK-" + options.name);
  let url =
    "/v1/admin/app-releases?version_code=" +
    String(options.code) +
    "&version_name=" +
    encodeURIComponent(options.name) +
    "&sha256=" +
    (options.sha ?? sha256(content));
  if (options.notes !== undefined) {
    url += "&notes=" + encodeURIComponent(options.notes);
  }
  if (options.extraQuery !== undefined) {
    url += "&" + options.extraQuery;
  }
  const headers: Record<string, string> = {
    host: HOST,
    "content-type": "application/octet-stream",
  };
  if (cookie !== undefined) {
    headers.cookie = ADMIN_SESSION_COOKIE + "=" + cookie;
  }
  return app.inject({
    method: "POST",
    url,
    headers,
    payload: content,
    remoteAddress: "192.0.2.150",
  });
}

async function createRelease(
  cookie: string,
  code: number,
  name: string,
): Promise<{ id: string; content: Buffer }> {
  const content = apk("SYN-CX168-RELEASE-" + name + "-" + String(code));
  const response = await upload(cookie, { code, name, content });
  expect(response.statusCode, response.body).toBe(201);
  return { id: (response.json() as { id: string }).id, content };
}

async function setRollout(
  cookie: string,
  id: string,
  rollout: "none" | "pilot" | "all",
): Promise<void> {
  const response = await app.inject({
    method: "PATCH",
    url: "/v1/admin/app-releases/" + id,
    headers: {
      host: HOST,
      "content-type": "application/json",
      cookie: ADMIN_SESSION_COOKIE + "=" + cookie,
    },
    payload: { rollout },
    remoteAddress: "192.0.2.151",
  });
  expect(response.statusCode, response.body).toBe(200);
  expect((response.json() as { rollout: string }).rollout).toBe(rollout);
}

async function appUpdate(
  token: string,
): Promise<ReturnType<FastifyInstance["inject"]>> {
  return app.inject({
    method: "GET",
    url: "/v1/device/app-update",
    headers: {
      host: HOST,
      "x-gt-ads-api-version": "1",
      authorization: "Bearer " + token,
    },
    remoteAddress: "192.0.2.152",
  });
}

async function download(
  token: string,
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<ReturnType<FastifyInstance["inject"]>> {
  return app.inject({
    method: "GET",
    url: path,
    headers: {
      host: HOST,
      "x-gt-ads-api-version": "1",
      authorization: "Bearer " + token,
      ...extraHeaders,
    },
    remoteAddress: "192.0.2.153",
  });
}

describe("CX-168 App-Updates", () => {
  it("laedt eine gueltige APK mit Hash, Datei und Audit", async () => {
    const cookie = await loginCookie();
    const content = apk("SYN-CX168-VALID");
    const response = await upload(cookie, {
      code: 10,
      name: "1.2.3",
      content,
      notes: "Pilotstart",
    });
    expect(response.statusCode, response.body).toBe(201);
    const body = response.json() as {
      id: string;
      version_code: number;
      version_name: string;
      sha256: string;
      size_bytes: number;
      rollout: string;
    };
    expect(body.version_code).toBe(10);
    expect(body.version_name).toBe("1.2.3");
    expect(body.sha256).toBe(sha256(content));
    expect(body.size_bytes).toBe(content.length);
    expect(body.rollout).toBe("none");

    const audit = await pool.query<{ action: string; target_id: string }>(
      "select action, target_id from audit_events where action = $1",
      ["app_release.created"],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.target_id).toBe(body.id);
  });

  it("lehnt gleichen oder kleineren Versionscode und vergebenen Namen mit 409 ab", async () => {
    const cookie = await loginCookie();
    await createRelease(cookie, 10, "1.0.0");
    const sameCode = await upload(cookie, { code: 10, name: "1.0.1" });
    expect(sameCode.statusCode, sameCode.body).toBe(409);
    const smallerCode = await upload(cookie, { code: 9, name: "0.9.0" });
    expect(smallerCode.statusCode, smallerCode.body).toBe(409);
    const sameName = await upload(cookie, { code: 11, name: "1.0.0" });
    expect(sameName.statusCode, sameName.body).toBe(409);
    const rows = await pool.query<{ count: number }>(
      "select count(*)::int as count from app_releases",
    );
    expect(rows.rows[0]?.count).toBe(1);
  });

  it("lehnt Nicht-ZIP, fehlende oder ungueltige Angaben und Zusatzparameter mit 400 ohne Speicherung ab", async () => {
    const cookie = await loginCookie();
    const notZip = Buffer.from("SYN-CX168-KEIN-ZIP");
    const cases = [
      { code: 20, name: "2.0.0", content: notZip },
      { code: 20, name: "2.0.0", sha: "f".repeat(64) },
    ];
    for (const item of cases) {
      const response = await upload(cookie, item);
      expect(response.statusCode, response.body).toBe(400);
    }
    const missingSha = await app.inject({
      method: "POST",
      url:
        "/v1/admin/app-releases?version_code=20&version_name=" +
        encodeURIComponent("2.0.0"),
      headers: {
        host: HOST,
        "content-type": "application/octet-stream",
        cookie: ADMIN_SESSION_COOKIE + "=" + cookie,
      },
      payload: apk("SYN-CX168-OHNE-HASH"),
      remoteAddress: "192.0.2.154",
    });
    expect(missingSha.statusCode, missingSha.body).toBe(400);
    const invalidSha = await upload(cookie, {
      code: 20,
      name: "2.0.0",
      sha: "xyz",
    });
    expect(invalidSha.statusCode, invalidSha.body).toBe(400);
    const extra = await upload(cookie, {
      code: 20,
      name: "2.0.0",
      extraQuery: "foo=bar",
    });
    expect(extra.statusCode, extra.body).toBe(400);
    const rows = await pool.query<{ count: number }>(
      "select count(*)::int as count from app_releases",
    );
    expect(rows.rows[0]?.count).toBe(0);
  });

  it("verweigert den Upload ohne Sitzung mit 401", async () => {
    const response = await upload(undefined, { code: 30, name: "3.0.0" });
    expect(response.statusCode).toBe(401);
    const rows = await pool.query<{ count: number }>(
      "select count(*)::int as count from app_releases",
    );
    expect(rows.rows[0]?.count).toBe(0);
  });

  it("liefert das Ziel je Kanal und faellt beim Zurueckziehen zurueck", async () => {
    const cookie = await loginCookie();
    const stable = await insertDevice("SYN-CX168-Stable", "stable");
    const pilot = await insertDevice("SYN-CX168-Pilot", "pilot");
    const stableToken = await deviceToken(stable);
    const pilotToken = await deviceToken(pilot);

    const first = await createRelease(cookie, 100, "1.0.0");
    const second = await createRelease(cookie, 101, "1.1.0");
    await setRollout(cookie, first.id, "all");
    await setRollout(cookie, second.id, "pilot");

    const stableUpdate = await appUpdate(stableToken);
    expect(stableUpdate.statusCode).toBe(200);
    expect((stableUpdate.json() as { update: { version_code: number } }).update.version_code).toBe(100);
    const pilotUpdate = await appUpdate(pilotToken);
    expect((pilotUpdate.json() as { update: { version_code: number } }).update.version_code).toBe(101);

    await setRollout(cookie, second.id, "none");
    const afterWithdraw = await appUpdate(pilotToken);
    expect((afterWithdraw.json() as { update: { version_code: number } }).update.version_code).toBe(100);
  });

  it("liefert ohne Download-Geheimnis kein Ziel", async () => {
    const device = await insertDevice("SYN-CX168-Ohne-Geheimnis", "pilot");
    const token = await deviceToken(device);
    const withoutSecret = createServer({
      config: { ...config, downloadSecret: null },
      pool,
      now: () => new Date(clockTime),
      logger: { level: "silent" },
      mediaUpload: mediaDeps(),
    });
    await withoutSecret.ready();
    try {
      const response = await withoutSecret.inject({
        method: "GET",
        url: "/v1/device/app-update",
        headers: {
          host: HOST,
          "x-gt-ads-api-version": "1",
          authorization: "Bearer " + token,
        },
        remoteAddress: "192.0.2.155",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ update: null });
    } finally {
      await withoutSecret.close();
    }
  });

  it("liefert den Download voll, per Range und 416; If-Range-Abweichung liefert 200", async () => {
    const cookie = await loginCookie();
    const device = await insertDevice("SYN-CX168-Download", "stable");
    const token = await deviceToken(device);
    const release = await createRelease(cookie, 200, "2.0.0");
    await setRollout(cookie, release.id, "all");

    const update = await appUpdate(token);
    const path = (update.json() as { update: { download_path: string } }).update.download_path;

    const full = await download(token, path);
    expect(full.statusCode, full.body).toBe(200);
    expect(Buffer.from(full.rawPayload).equals(release.content)).toBe(true);
    expect(full.headers["accept-ranges"]).toBe("bytes");

    const ranged = await download(token, path, { range: "bytes=4-9" });
    expect(ranged.statusCode).toBe(206);
    expect(Buffer.from(ranged.rawPayload).equals(release.content.subarray(4, 10))).toBe(true);
    expect(ranged.headers["content-range"]).toBe(
      "bytes 4-9/" + String(release.content.length),
    );

    const unsatisfiable = await download(token, path, { range: "bytes=999999-" });
    expect(unsatisfiable.statusCode).toBe(416);
    expect(unsatisfiable.headers["content-range"]).toBe(
      "bytes */" + String(release.content.length),
    );

    const ifRangeMismatch = await download(token, path, {
      range: "bytes=0-3",
      "if-range": '"' + "0".repeat(64) + '"',
    });
    expect(ifRangeMismatch.statusCode).toBe(200);
    expect(Buffer.from(ifRangeMismatch.rawPayload).equals(release.content)).toBe(true);
  });

  it("verweigert fremde Version, fehlendes oder abgelaufenes Ticket 403 und liefert zurueckgezogen oder gesperrt 404", async () => {
    const cookie = await loginCookie();
    const device = await insertDevice("SYN-CX168-Grenzen", "stable");
    const token = await deviceToken(device);
    const first = await createRelease(cookie, 300, "3.0.0");
    const second = await createRelease(cookie, 301, "3.1.0");
    await setRollout(cookie, first.id, "all");
    await setRollout(cookie, second.id, "all");

    const update = await appUpdate(token);
    const firstPath = (update.json() as { update: { download_path: string } }).update.download_path;
    const ticketQuery = firstPath.slice(firstPath.indexOf("?ticket="));

    const foreign = await download(token, "/v1/device/app-downloads/" + first.id + ticketQuery);
    expect(foreign.statusCode).toBe(403);

    const withoutTicket = await download(token, "/v1/device/app-downloads/" + first.id);
    expect(withoutTicket.statusCode).toBe(403);

    clockTime = BASE_TIME + 2 * HOUR_MS;
    const expired = await download(token, firstPath);
    expect(expired.statusCode).toBe(403);
    clockTime = BASE_TIME;

    const updateAgain = await appUpdate(token);
    const currentPath = (updateAgain.json() as { update: { download_path: string } }).update.download_path;
    await setRollout(cookie, second.id, "none");
    const withdrawn = await download(token, currentPath);
    expect(withdrawn.statusCode).toBe(404);

    // Wieder freigeben, neues Ticket holen und das Tablet sperren.
    await setRollout(cookie, second.id, "all");
    const freshUpdate = await appUpdate(token);
    const freshPath = (freshUpdate.json() as { update: { download_path: string } }).update.download_path;
    await pool.query("update devices set state = 'revoked' where id = $1::uuid", [device]);
    const blocked = await download(token, freshPath);
    expect(blocked.statusCode).toBe(404);
  });

  it("bindet das Ticket an das Tablet", async () => {
    const cookie = await loginCookie();
    const deviceA = await insertDevice("SYN-CX168-Tablet-A", "stable");
    const deviceB = await insertDevice("SYN-CX168-Tablet-B", "stable");
    const tokenA = await deviceToken(deviceA);
    const tokenB = await deviceToken(deviceB);
    const release = await createRelease(cookie, 400, "4.0.0");
    await setRollout(cookie, release.id, "all");

    const update = await appUpdate(tokenA);
    const pathA = (update.json() as { update: { download_path: string } }).update.download_path;
    const wrongTablet = await download(tokenB, pathA);
    expect(wrongTablet.statusCode).toBe(403);
    const rightTablet = await download(tokenA, pathA);
    expect(rightTablet.statusCode).toBe(200);
  });

  it("nimmt die Rueckmeldung mit 204 an und lehnt 400, 401 und 404 ab", async () => {
    const cookie = await loginCookie();
    const device = await insertDevice("SYN-CX168-Meldung", "stable");
    const token = await deviceToken(device);
    const release = await createRelease(cookie, 500, "5.0.0");

    const ok = await app.inject({
      method: "POST",
      url: "/v1/device/app-update/report",
      headers: { host: HOST, ...API_HEADERS, authorization: "Bearer " + token },
      payload: { release_id: release.id, status: "installed" },
      remoteAddress: "192.0.2.156",
    });
    expect(ok.statusCode).toBe(204);

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/device/app-update/report",
      headers: { host: HOST, ...API_HEADERS, authorization: "Bearer " + token },
      payload: { release_id: release.id, status: "kaputt" },
      remoteAddress: "192.0.2.156",
    });
    expect(invalid.statusCode).toBe(400);

    const unauthorized = await app.inject({
      method: "POST",
      url: "/v1/device/app-update/report",
      headers: { host: HOST, ...API_HEADERS },
      payload: { release_id: release.id, status: "downloaded" },
      remoteAddress: "192.0.2.156",
    });
    expect(unauthorized.statusCode).toBe(401);

    const unknown = await app.inject({
      method: "POST",
      url: "/v1/device/app-update/report",
      headers: { host: HOST, ...API_HEADERS, authorization: "Bearer " + token },
      payload: { release_id: randomUUID(), status: "failed", detail: "download_error" },
      remoteAddress: "192.0.2.156",
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("zeigt Zaehler, Taxi, Kanal und Heartbeat-Version; aelterer Heartbeat dreht nicht zurueck", async () => {
    const cookie = await loginCookie();
    const device = await insertDevice("SYN-CX168-Uebersicht", "pilot");
    const token = await deviceToken(device);
    await pool.query(
      "insert into device_taxi_assignments (device_id, taxi_id, active, updated_at)" +
        " values ($1::uuid, $2, true, $3)",
      [device, TAXI_ID, new Date(BASE_TIME)],
    );
    const release = await createRelease(cookie, 600, "6.0.0");
    await setRollout(cookie, release.id, "pilot");

    const installedReport = await app.inject({
      method: "POST",
      url: "/v1/device/app-update/report",
      headers: { host: HOST, ...API_HEADERS, authorization: "Bearer " + token },
      payload: { release_id: release.id, status: "installed" },
      remoteAddress: "192.0.2.157",
    });
    expect(installedReport.statusCode).toBe(204);

    const secondDevice = await insertDevice("SYN-CX168-Uebersicht-2", "pilot");
    const secondToken = await deviceToken(secondDevice);
    const downloadedReport = await app.inject({
      method: "POST",
      url: "/v1/device/app-update/report",
      headers: {
        host: HOST,
        ...API_HEADERS,
        authorization: "Bearer " + secondToken,
      },
      payload: { release_id: release.id, status: "downloaded" },
      remoteAddress: "192.0.2.157",
    });
    expect(downloadedReport.statusCode).toBe(204);

    for (const [seq, version] of [
      [5, "2.0.0"],
      [4, "1.0.0"],
    ] as const) {
      const heartbeat = await app.inject({
        method: "POST",
        url: "/v1/device/heartbeat",
        headers: { host: HOST, ...API_HEADERS, authorization: "Bearer " + token },
        payload: {
          seq,
          device_time: new Date(BASE_TIME).toISOString(),
          app_version: version,
          os_version: "15",
        },
        remoteAddress: "192.0.2.157",
      });
      expect(heartbeat.statusCode, heartbeat.body).toBe(200);
    }

    const stored = await pool.query<{ app_version: string }>(
      "select app_version from devices where id = $1::uuid",
      [device],
    );
    expect(stored.rows[0]?.app_version).toBe("2.0.0");

    const overview = await app.inject({
      method: "GET",
      url: "/v1/admin/app-releases",
      headers: {
        host: HOST,
        cookie: ADMIN_SESSION_COOKIE + "=" + cookie,
      },
      remoteAddress: "192.0.2.158",
    });
    expect(overview.statusCode, overview.body).toBe(200);
    const body = overview.json() as {
      releases: Array<{ id: string; downloaded: number; installed: number; failed: number }>;
      devices: Array<{
        device_id: string;
        taxi_name: string | null;
        update_channel: string;
        app_version: string;
        last_report: { status: string; release_id: string } | null;
      }>;
    };
    const listed = body.releases.find((entry) => entry.id === release.id);
    expect(listed?.downloaded).toBe(1);
    expect(listed?.installed).toBe(1);
    expect(listed?.failed).toBe(0);
    const tablet = body.devices.find((entry) => entry.device_id === device);
    expect(tablet?.taxi_name).toBe("SYN CX-168 Taxi");
    expect(tablet?.update_channel).toBe("pilot");
    expect(tablet?.app_version).toBe("2.0.0");
    expect(tablet?.last_report?.status).toBe("installed");
    expect(tablet?.last_report?.release_id).toBe(release.id);
  });
});
