import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
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
import { migrateLatest } from "../../src/db/migrate.js";
import { createServer } from "../../src/http/server.js";
import {
  MEDIA_PROFILE_ERRORS_HEADER,
  MEDIA_UPLOAD_MAX_BYTES,
  type MediaUploadDeps,
} from "../../src/http/mediaUpload.js";
import { ADMIN_SESSION_COOKIE } from "../../src/modules/adminAuth/middleware.js";
import {
  MediaProfileRejectedError,
  createMedia,
  type CreateMediaInput,
  type MediaProfileMetadata,
  type MediaServiceOptions,
  type ReadyMedia,
} from "../../src/modules/media/index.js";
import { LEGACY_ADMIN_PRINCIPAL_ID } from "../../src/http/principal.js";

const BASE_TIME = Date.parse("2026-01-01T12:00:00.000Z");
const ADMIN_PASSWORD = "SYN-CX031-Upload-Passwort";
const HOST = "127.0.0.1:8080";
const ORIGIN = "http://" + HOST;
const FOREIGN_ORIGIN = "http://fremde.example";
const UPLOAD_URL = "/v1/admin/media";
/** Produktionsoptionen des Doubles; es findet kein Dateizugriff statt. */
function serviceOptions(): MediaServiceOptions {
  return { pool, storageRoot: "/tmp/cx031-media-nicht-verwendet" };
}

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
    throw new Error("CX-031 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx031_upload_" +
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

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX031-Upload-Pepper",
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
  vi.restoreAllMocks();
});

afterAll(async () => {
  await pool.end();
  await maintenancePool.query(
    "drop database if exists " + quoteIdentifier(databaseName),
  );
  await maintenancePool.end();
}, 30_000);

interface BuildOptions {
  mediaUpload?: MediaUploadDeps;
  logger?: FastifyServerOptions["logger"];
}

async function buildApp(options: BuildOptions = {}): Promise<FastifyInstance> {
  const app = createServer({
    config,
    pool,
    now: clock,
    mediaUpload: options.mediaUpload,
    logger: options.logger,
  });
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
    remoteAddress: "192.0.2.240",
  });
  expect(response.statusCode).toBe(204);
  return sessionCookieOf(response);
}

function uploadHeaders(
  cookie?: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    host: HOST,
    "content-type": "application/octet-stream",
    ...extra,
  };
  if (cookie !== undefined) {
    headers.cookie = ADMIN_SESSION_COOKIE + "=" + cookie;
  }
  return headers;
}

interface UploadDouble {
  deps: MediaUploadDeps;
  spy: ReturnType<typeof vi.fn>;
  calls: CreateMediaInput[];
  received: Buffer;
}

/**
 * Typkompatibles Double ausschliesslich der vorhandenen createMedia-Grenze.
 * Es liest die gelieferten Bytes tatsaechlich und sammelt sie unveraendert.
 */
function uploadDouble(created: ReadyMedia): UploadDouble {
  const calls: CreateMediaInput[] = [];
  const chunks: Buffer[] = [];
  const spy = vi.fn(
    async (
      _options: MediaServiceOptions,
      input: CreateMediaInput,
    ): Promise<ReadyMedia> => {
      calls.push(input);
      for await (const chunk of input.content) {
        chunks.push(Buffer.from(chunk));
      }
      return created;
    },
  );
  return {
    deps: { createMedia: spy, serviceOptions: serviceOptions() },
    spy,
    calls,
    get received() {
      return Buffer.concat(chunks);
    },
  };
}

function mediaId(): string {
  return "0f8fad5b-d9cb-469f-a165-70867728950e";
}

function readyMedia(displayName: string): ReadyMedia {
  return {
    id: mediaId(),
    displayName,
    sizeBytes: 4096,
    sha256: "a".repeat(64),
    profile: { ...PROFILE },
    createdAt: new Date(BASE_TIME),
    status: "ready",
    read: async () => Buffer.alloc(0),
  };
}

function profileJson(): Record<string, unknown> {
  return {
    container: PROFILE.container,
    video_codec: PROFILE.videoCodec,
    width: PROFILE.width,
    height: PROFILE.height,
    frame_rate_numerator: PROFILE.frameRateNumerator,
    frame_rate_denominator: PROFILE.frameRateDenominator,
    audio_stream_count: PROFILE.audioStreamCount,
    duration_seconds: PROFILE.durationSeconds,
  };
}

function captureStream(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}


/** Liefert synthetische Chunks, ohne einen grossen Gesamtpuffer anzulegen. */
function* syntheticChunks(
  totalBytes: number,
  chunkBytes = 1024 * 1024,
): Generator<Buffer> {
  const chunk = Buffer.alloc(chunkBytes, 0x5a);
  let remaining = totalBytes;
  while (remaining > 0) {
    const size = Math.min(chunkBytes, remaining);
    remaining -= size;
    yield size === chunkBytes ? chunk : chunk.subarray(0, size);
  }
}
describe("CX-031 Upload-HTTP-Adapter", () => {
  it("verweigert ohne Sitzung trotz behaupteter Admin-Rollenheader 401 und mit gueltiger Sitzung plus fremdem Origin 403, jeweils vor Bodyparser und createMedia", async () => {
    const upload = uploadDouble(readyMedia("SYN-CX031-Spot.mp4"));
    const app = await buildApp({ mediaUpload: upload.deps });
    const claimedHeaders = {
      "x-role": "Admin",
      "x-admin-role": "Admin",
      "x-gt-ads-role": "Admin",
      authorization: "Bearer SYN-CX031-Behauptung",
    };

    // Malformed JSON: waere der Bodyparser gelaufen, ergaebe das 400 statt 401.
    const anonymous = await app.inject({
      method: "POST",
      url: UPLOAD_URL,
      headers: {
        host: HOST,
        "content-type": "application/json",
        ...claimedHeaders,
      },
      payload: "{",
      remoteAddress: "192.0.2.241",
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().error.code).toBe("unauthorized");

    // Auch ein erfundenes Sitzungscookie wird serverseitig geprueft und
    // verleiht keine Rechte.
    const forged = await app.inject({
      method: "POST",
      url: UPLOAD_URL,
      headers: {
        ...uploadHeaders("SYN-CX031-ERFUNDEN", claimedHeaders),
      },
      payload: Buffer.from("SYN-CX031-Bytes"),
      remoteAddress: "192.0.2.242",
    });
    expect(forged.statusCode).toBe(401);
    expect(forged.json().error.code).toBe("unauthorized");
    expect(upload.spy).not.toHaveBeenCalled();

    // Echte Sitzung ueber die vorhandene Anmeldung; fremder Origin wird nach
    // der bestehenden CSRF-Regel abgewiesen.
    const cookie = await loginCookie(app);
    const foreign = await app.inject({
      method: "POST",
      url: UPLOAD_URL,
      headers: uploadHeaders(cookie, {
        origin: FOREIGN_ORIGIN,
        "content-type": "application/json",
      }),
      payload: "{",
      remoteAddress: "192.0.2.243",
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error.code).toBe("forbidden");
    expect(upload.spy).not.toHaveBeenCalled();
  });

  it("liefert fuer einen erlaubten Upload 201 und ruft createMedia genau einmal mit unveraenderten Bytes, Namen und serverseitigem Akteur; die Antwort enthaelt nur oeffentliche Metadaten", async () => {
    const created = readyMedia("SYN-CX031-Spot.mp4");
    const withInternals = {
      ...created,
      storagePath: "SYN-CX031-INTERN-PFAD/objects/" + created.id,
    } as unknown as ReadyMedia;
    const upload = uploadDouble(withInternals);
    const app = await buildApp({ mediaUpload: upload.deps });
    const cookie = await loginCookie(app);
    const bytes = Buffer.from([0, 1, 2, 3, 254, 255, 65, 66, 67]);

    const response = await app.inject({
      method: "POST",
      url: UPLOAD_URL + "?name=SYN-CX031-Spot.mp4",
      headers: uploadHeaders(cookie, { origin: ORIGIN }),
      payload: bytes,
      remoteAddress: "192.0.2.244",
    });

    expect(response.statusCode).toBe(201);
    expect(upload.spy).toHaveBeenCalledTimes(1);
    const input = upload.calls[0] as CreateMediaInput;
    expect(input.displayName).toBe("SYN-CX031-Spot.mp4");
    expect(input.actorType).toBe("admin");
    expect(input.actorId).toBe(LEGACY_ADMIN_PRINCIPAL_ID);
    expect(upload.received.equals(bytes)).toBe(true);

    const body = response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "id",
      "name",
      "profile",
      "sha256",
      "size_bytes",
    ]);
    expect(body).toEqual({
      id: created.id,
      name: created.displayName,
      size_bytes: created.sizeBytes,
      sha256: created.sha256,
      profile: profileJson(),
    });
    expect(body).not.toHaveProperty("read");
    expect(body).not.toHaveProperty("createdAt");
    expect(body).not.toHaveProperty("status");
    expect(body).not.toHaveProperty("storagePath");
    expect(response.body).not.toContain("SYN-CX031-INTERN-PFAD");
    expect(response.body).not.toContain("/objects/");
  });

  it("beantwortet falschen Content-Type mit 415, unbekannte Queryparameter und einen 129-Zeichen-Namen mit 400, jeweils ohne createMedia", async () => {
    const upload = uploadDouble(readyMedia("SYN-CX031-Grenze.mp4"));
    const app = await buildApp({ mediaUpload: upload.deps });
    const cookie = await loginCookie(app);

    const rejected = [
      {
        label: "falscher Content-Type",
        url: UPLOAD_URL,
        headers: uploadHeaders(cookie, { origin: ORIGIN, "content-type": "text/plain" }),
        payload: Buffer.from("SYN-CX031"),
        status: 415,
      },
      {
        label: "unbekannter Queryparameter",
        url: UPLOAD_URL + "?foo=1",
        headers: uploadHeaders(cookie, { origin: ORIGIN }),
        payload: Buffer.from("SYN-CX031"),
        status: 400,
      },
      {
        label: "Name mit 129 Zeichen",
        url: UPLOAD_URL + "?name=" + "a".repeat(129),
        headers: uploadHeaders(cookie, { origin: ORIGIN }),
        payload: Buffer.from("SYN-CX031"),
        status: 400,
      },
    ] as const;

    for (const entry of rejected) {
      const response = await app.inject({
        method: "POST",
        url: entry.url,
        headers: entry.headers,
        payload: entry.payload,
        remoteAddress: "192.0.2.245",
      });
      expect(response.statusCode, entry.label).toBe(entry.status);
      const body = response.json() as {
        error: { code: string; message: string; request_id: string };
      };
      expect(body.error.code).toBe("invalid_request");
      expect(typeof body.error.request_id).toBe("string");
      expect(upload.spy).not.toHaveBeenCalled();
    }
  });

  it("laesst einen synthetischen gueltigen Upload oberhalb der frueheren 20-MB-Grenze bis zur bestehenden Formatpruefung und Medienspeicherung durch", async () => {
    const created = readyMedia("SYN-CX157-Grenze.mp4");
    const upload = uploadDouble(created);
    const app = await buildApp({ mediaUpload: upload.deps });
    const cookie = await loginCookie(app);
    const bytes = 20_000_001;

    const response = await app.inject({
      method: "POST",
      url: UPLOAD_URL + "?name=SYN-CX157-Grenze.mp4",
      headers: uploadHeaders(cookie, { origin: ORIGIN }),
      payload: Readable.from(syntheticChunks(bytes)),
      remoteAddress: "192.0.2.246",
    });

    expect(response.statusCode).toBe(201);
    // Die vorhandene createMedia-Grenze ist die Formatpruefung und
    // Medienspeicherung; ihr wurden die Bytes oberhalb der frueheren Grenze
    // tatsaechlich und unveraendert geliefert.
    expect(upload.spy).toHaveBeenCalledTimes(1);
    expect(upload.received.byteLength).toBe(bytes);
    expect(upload.received.byteLength).toBeGreaterThan(20_000_000);
    const input = upload.calls[0] as CreateMediaInput;
    expect(input.metadata).toBeUndefined();
  }, 30_000);

  it("weist eine waehrend des Einlesens ueberschrittene Grenze ohne Content-Length mit 413 ab und hinterlaesst weder temporaere Dateien noch einen Mediendatensatz", async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), "cx157-upload-"));
    try {
      let serviceCalls = 0;
      const deps: MediaUploadDeps = {
        serviceOptions: { pool, storageRoot },
        maxBytes: 20_000_000,
        createMedia: async (options, input) => {
          serviceCalls += 1;
          return createMedia(options, input);
        },
      };
      const app = await buildApp({ mediaUpload: deps });
      const cookie = await loginCookie(app);

      // Ohne Content-Length: die Grenze wird erst beim Einlesen der
      // synthetischen Chunks tatsaechlich ueberschritten.
      const response = await app.inject({
        method: "POST",
        url: UPLOAD_URL + "?name=SYN-Abbruch.mp4",
        headers: uploadHeaders(cookie, { origin: ORIGIN }),
        payload: Readable.from(syntheticChunks(20_000_001)),
        remoteAddress: "192.0.2.247",
      });

      expect(response.statusCode).toBe(413);
      const body = response.json() as {
        error: { code: string; message: string; request_id: string };
      };
      expect(body.error.code).toBe("invalid_request");
      expect(typeof body.error.request_id).toBe("string");
      // Der Strom laeuft an; der Abbruch raeumt die temporaere Datei auf.
      expect(serviceCalls).toBe(1);

      const rows = await pool.query(
        "select count(*)::int as count from media_objects",
      );
      expect(rows.rows[0].count).toBe(0);
      const left = await readdir(storageRoot, { recursive: true, withFileTypes: true });
      expect(left.filter((entry) => entry.isFile())).toEqual([]);
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it("weist ein zu grosses Content-Length vor jedem Lesen mit 413 ab", async () => {
    const upload = uploadDouble(readyMedia("SYN-Laenge.mp4"));
    upload.deps.maxBytes = 1_000;
    const app = await buildApp({ mediaUpload: upload.deps });
    const cookie = await loginCookie(app);
    const response = await app.inject({
      method: "POST",
      url: UPLOAD_URL,
      headers: uploadHeaders(cookie, { origin: ORIGIN }),
      payload: Buffer.alloc(1_001, 0x43),
      remoteAddress: "192.0.2.250",
    });
    expect(response.statusCode).toBe(413);
    expect(upload.spy).not.toHaveBeenCalled();
  });

  it("reicht den Body als Strom in Teilstuecken weiter, statt ihn vorab zu puffern", async () => {
    const upload = uploadDouble(readyMedia("SYN-Strom.mp4"));
    const chunkSizes: number[] = [];
    const inner = upload.deps.createMedia;
    upload.deps.createMedia = async (options, input) => {
      const original = input.content;
      return inner(options, {
        ...input,
        content: (async function* () {
          for await (const chunk of original) {
            chunkSizes.push(chunk.byteLength);
            yield chunk;
          }
        })(),
      });
    };
    const app = await buildApp({ mediaUpload: upload.deps });
    const cookie = await loginCookie(app);
    const parts = Array.from({ length: 8 }, (_, index) => Buffer.alloc(64 * 1024, index));
    const response = await app.inject({
      method: "POST",
      url: UPLOAD_URL + "?name=SYN-Strom.mp4",
      headers: uploadHeaders(cookie, { origin: ORIGIN }),
      payload: Readable.from(parts),
      remoteAddress: "192.0.2.251",
    });
    expect(response.statusCode).toBe(201);
    expect(chunkSizes.length).toBeGreaterThan(1);
    expect(upload.received.equals(Buffer.concat(parts))).toBe(true);
  });

  it("beantwortet einen typisierten Profilfehler mit 422 und einen unerwarteten Fehler bereinigt mit 500, ohne SQL- oder Pfadmarker in Antwort und Logs", async () => {
    const profileError = new MediaProfileRejectedError([
      {
        code: "unsupported_container",
        field: "container",
        message: "SYN-CX031-PROFIL-GEHEIM",
      },
    ]);
    const profileDeps: MediaUploadDeps = {
      createMedia: async () => {
        throw profileError;
      },
      serviceOptions: serviceOptions(),
    };
    const app = await buildApp({ mediaUpload: profileDeps });
    const cookie = await loginCookie(app);

    const rejected = await app.inject({
      method: "POST",
      url: UPLOAD_URL,
      headers: uploadHeaders(cookie, { origin: ORIGIN }),
      payload: Buffer.from("SYN-CX031-Profil"),
      remoteAddress: "192.0.2.248",
    });
    expect(rejected.statusCode).toBe(422);
    // L-01: nur die stabilen Codes als Header, nie die Meldungstexte.
    expect(rejected.headers[MEDIA_PROFILE_ERRORS_HEADER.toLowerCase()]).toBe(
      "unsupported_container",
    );
    const rejectedBody = rejected.json() as {
      error: { code: string; message: string; request_id: string };
    };
    expect(Object.keys(rejectedBody)).toEqual(["error"]);
    expect(rejectedBody.error.code).toBe("invalid_request");
    expect(rejectedBody.error.message).toBe("Die Anfrage ist ungueltig.");
    expect(typeof rejectedBody.error.request_id).toBe("string");
    expect(rejected.body).not.toContain("SYN-CX031-PROFIL-GEHEIM");

    const logs = captureStream();
    const sqlMarker = "SYN-CX031-SQL-GEHEIM";
    const pathMarker = "SYN-CX031-PFAD-GEHEIM";
    const failingDeps: MediaUploadDeps = {
      serviceOptions: serviceOptions(),
      createMedia: async () => {
        throw new Error(
          "select id, display_name from media_assets where sha256 = '" +
            sqlMarker +
            "' and root = '/srv/" +
            pathMarker +
            "/objects'",
        );
      },
    };
    const failing = await buildApp({
      mediaUpload: failingDeps,
      logger: { level: "info", stream: logs.stream },
    });
    const failingCookie = await loginCookie(failing);

    const failure = await failing.inject({
      method: "POST",
      url: UPLOAD_URL,
      headers: uploadHeaders(failingCookie, { origin: ORIGIN }),
      payload: Buffer.from("SYN-CX031-Fehler"),
      remoteAddress: "192.0.2.249",
    });
    expect(failure.statusCode).toBe(500);
    const failureBody = failure.json() as {
      error: { code: string; message: string; request_id: string };
    };
    expect(Object.keys(failureBody)).toEqual(["error"]);
    expect(failureBody.error.code).toBe("internal_error");
    expect(failureBody.error.message).toBe("Interner Fehler.");
    expect(typeof failureBody.error.request_id).toBe("string");

    const text = logs.text();
    for (const marker of [sqlMarker, pathMarker, "media_assets", "select id", "/srv/"]) {
      expect(failure.body).not.toContain(marker);
      expect(text).not.toContain(marker);
    }
    expect(text).toContain("Unbehandelter Fehler");
  });
});

