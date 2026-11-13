import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { AuditEventInput } from "../audit/repository.js";
import { AuditService } from "../audit/service.js";
import {
  MEDIA_CREATED_ACTION,
  createMediaService,
  type MediaAuditWriter,
  type MediaProfileMetadata,
  type MediaService,
  type MediaServiceOptions,
  type MediaSqlPool,
} from "./index.js";

const BASE_TIME = Date.parse("2026-09-01T08:00:00.000Z");
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);
const MIGRATIONS = [
  "0001_gt_ads_001.up.sql",
  "0002_gt_ads_004_telemetry.up.sql",
  "0003_cx_011_telemetry_rollups.up.sql",
  "0004_cx_012_remote_control.up.sql",
  "0005_cx_013_control_config.up.sql",
  "0006_cx_028_technical_alarms.up.sql",
  "0007_cx_030_media.up.sql",
];
const VALID_PROFILE: MediaProfileMetadata = {
  container: "mp4",
  videoCodec: "h264",
  width: 1920,
  height: 1080,
  frameRateNumerator: 30,
  frameRateDenominator: 1,
  audioStreamCount: 0,
  durationSeconds: 15,
};

let maintenancePool: Pool | null = null;
let pool: Pool | null = null;
let databaseName = "";
let storageRoot = "";
let nowMs = BASE_TIME;
const extraPools: Pool[] = [];

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
    throw new Error("CX-030 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

async function ensureDirs(): Promise<void> {
  await mkdir(join(storageRoot, "objects"), { recursive: true, mode: 0o700 });
  await mkdir(join(storageRoot, "staging"), { recursive: true, mode: 0o700 });
}

function makeService(
  overrides: Partial<MediaServiceOptions> = {},
): MediaService {
  const audit = new AuditService({
    executor: pool as Pool,
    now: () => new Date(nowMs),
  });
  const auditWriter: MediaAuditWriter = (executor, event) =>
    audit.recordWith(executor, event, event.at);

  return createMediaService({
    pool: pool as Pool,
    storageRoot,
    now: () => new Date(nowMs),
    auditWriter,
    ...overrides,
  });
}

function metadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    container: VALID_PROFILE.container,
    videoCodec: VALID_PROFILE.videoCodec,
    width: VALID_PROFILE.width,
    height: VALID_PROFILE.height,
    frameRateNumerator: VALID_PROFILE.frameRateNumerator,
    frameRateDenominator: VALID_PROFILE.frameRateDenominator,
    audioStreamCount: VALID_PROFILE.audioStreamCount,
    durationSeconds: VALID_PROFILE.durationSeconds,
    sizeBytes: 1,
    ...overrides,
  };
}

function patternBytes(size: number): Buffer {
  const buffer = Buffer.allocUnsafe(size);
  for (let index = 0; index < size; index += 1) {
    buffer[index] = (index * 31 + 7) & 0xff;
  }
  return buffer;
}

async function* streamOf(
  bytes: Uint8Array,
  chunkSize = 64 * 1024,
): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    yield bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
  }
}

function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function mediaCount(status?: "staging" | "ready"): Promise<number> {
  const result =
    status === undefined
      ? await (pool as Pool).query<{ count: string }>(
          "select count(*)::text as count from media_objects",
        )
      : await (pool as Pool).query<{ count: string }>(
          "select count(*)::text as count from media_objects where status = $1",
          [status],
        );
  return Number(result.rows[0]?.count ?? "0");
}

async function rowStatus(id: string): Promise<string | null> {
  const result = await (pool as Pool).query<{ status: string }>(
    "select status from media_objects where id = $1::uuid",
    [id],
  );
  return result.rows[0]?.status ?? null;
}

async function auditCount(): Promise<number> {
  const result = await (pool as Pool).query<{ count: string }>(
    "select count(*)::text as count from audit_events where action = $1",
    [MEDIA_CREATED_ACTION],
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function insertStagingBase(
  id: string,
  displayName: string,
  createdAt: Date,
): Promise<void> {
  await (pool as Pool).query(
    [
      "insert into media_objects (id, display_name, created_at, status)",
      "values ($1::uuid, $2, $3, 'staging')",
    ].join("\n"),
    [id, displayName, createdAt],
  );
}

async function insertStagingFull(
  id: string,
  displayName: string,
  bytes: Uint8Array,
  createdAt: Date,
): Promise<string> {
  const sha256 = sha256Of(bytes);
  await (pool as Pool).query(
    [
      "insert into media_objects",
      "  (id, display_name, size_bytes, sha256, container, video_codec,",
      "   width, height, frame_rate_numerator, frame_rate_denominator,",
      "   audio_stream_count, duration_seconds, created_at, status)",
      "values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,",
      "        $13, 'staging')",
    ].join("\n"),
    [
      id,
      displayName,
      bytes.byteLength,
      sha256,
      VALID_PROFILE.container,
      VALID_PROFILE.videoCodec,
      VALID_PROFILE.width,
      VALID_PROFILE.height,
      VALID_PROFILE.frameRateNumerator,
      VALID_PROFILE.frameRateDenominator,
      VALID_PROFILE.audioStreamCount,
      VALID_PROFILE.durationSeconds,
      createdAt,
    ],
  );
  return sha256;
}

async function writeStagingTemp(id: string, bytes: Uint8Array): Promise<void> {
  await writeFile(join(storageRoot, "staging", id + ".part"), bytes, {
    mode: 0o600,
  });
}

async function writeFinal(id: string, bytes: Uint8Array): Promise<void> {
  await writeFile(join(storageRoot, "objects", id), bytes, { mode: 0o600 });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "cx030_media_" + process.pid + "_" + Date.now().toString(36)
  )
    .toLowerCase()
    .slice(0, 63);

  await maintenancePool.query(
    "create database " + quoteIdentifier(databaseName),
  );
  pool = new Pool({ ...base, database: databaseName });

  for (const name of MIGRATIONS) {
    const sql = await readFile(join(MIGRATIONS_DIR, name), "utf8");
    await (pool as Pool).query(sql);
  }

  storageRoot = await mkdtemp(join(tmpdir(), "cx030-media-"));
}, 60_000);

beforeEach(async () => {
  nowMs = BASE_TIME;
  await (pool as Pool).query(
    "truncate table audit_events, media_objects restart identity cascade",
  );
  await rm(storageRoot, { recursive: true, force: true });
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  await ensureDirs();
});

afterAll(async () => {
  for (const extra of extraPools.splice(0)) {
    await extra.end();
  }
  if (pool !== null) {
    await pool.end();
  }
  if (maintenancePool !== null) {
    if (databaseName !== "") {
      await maintenancePool.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
        [databaseName],
      );
      await maintenancePool.query(
        "drop database if exists " + quoteIdentifier(databaseName),
      );
    }
    await maintenancePool.end();
  }
  await rm(storageRoot, { recursive: true, force: true });
}, 30_000);

describe("CX-030 / R-201 Medienspeicher", () => {
  it("speichert ein synthetisches Medium mit identischen Bytes, CX-005-Hash und CX-003-Profil und findet es nach Service-Neustart wieder; die Liste ist sortiert, begrenzt und ohne staging-Inhalte", async () => {
    const service = makeService();
    const bytesA = patternBytes(4096);
    const a = await service.createMedia({
      displayName: "SYN-Spot-A.mp4",
      content: streamOf(bytesA, 700),
      metadata: metadata(),
      actorType: "admin",
      actorId: "SYN-ADMIN",
    });

    expect(a.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(a.sizeBytes).toBe(4096);
    expect(a.sha256).toBe(sha256Of(bytesA));
    expect(a.profile).toEqual(VALID_PROFILE);
    expect(Buffer.from(await a.read()).equals(bytesA)).toBe(true);

    nowMs += 1000;
    const bytesB = patternBytes(2048);
    const b = await service.createMedia({
      displayName: "SYN-Spot-B.mp4",
      content: streamOf(bytesB, 1000),
      metadata: metadata(),
    });

    nowMs += 1000;
    const bytesC = patternBytes(1024);
    const c = await service.createMedia({
      displayName: "SYN-Spot-C.mp4",
      content: streamOf(bytesC),
      metadata: metadata(),
    });

    const stagingId = randomUUID();
    await insertStagingBase(stagingId, "SYN-Staging.mp4", new Date(nowMs + 9999));

    const firstPage = await service.listReadyMedia({ limit: 2 });
    expect(firstPage.items.map((item) => item.displayName)).toEqual([
      "SYN-Spot-A.mp4",
      "SYN-Spot-B.mp4",
    ]);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await service.listReadyMedia({
      limit: 2,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.items.map((item) => item.displayName)).toEqual([
      "SYN-Spot-C.mp4",
    ]);
    expect(secondPage.nextCursor).toBeNull();

    const all = await service.listReadyMedia({ limit: 100 });
    expect(all.items).toHaveLength(3);
    for (const item of all.items) {
      expect(Object.keys(item).sort()).toEqual([
        "createdAt",
        "displayName",
        "id",
        "profile",
        "sha256",
        "sizeBytes",
        "status",
      ]);
      const serialized = JSON.stringify(item);
      expect(serialized).not.toContain(storageRoot);
      expect(serialized).not.toContain("staging");
      expect(serialized).not.toContain("SYN-Staging");
      expect(item).not.toHaveProperty("read");
      expect(item).not.toHaveProperty("content");
    }

    await expect(service.listReadyMedia({ limit: 101 })).rejects.toMatchObject({
      code: "invalid_limit",
    });
    await expect(service.listReadyMedia({ limit: 0 })).rejects.toMatchObject({
      code: "invalid_limit",
    });

    const restartedPool = new Pool({
      ...baseConnection(),
      database: databaseName,
    });
    extraPools.push(restartedPool);
    const restarted = makeService({ pool: restartedPool });

    const found = await restarted.getReadyMedia(a.id);
    expect(found).not.toBeNull();
    expect(found?.sizeBytes).toBe(4096);
    expect(found?.sha256).toBe(a.sha256);
    expect(found?.profile).toEqual(VALID_PROFILE);
    expect(Buffer.from(await (found as NonNullable<typeof found>).read()).equals(bytesA)).toBe(true);
    expect(await restarted.getReadyMedia(b.id)).not.toBeNull();
    expect(await restarted.getReadyMedia(c.id)).not.toBeNull();
    expect(await restarted.getReadyMedia(stagingId)).toBeNull();
  }, 30_000);

  it("akzeptiert genau 20.000.000 Byte, lehnt ein Byte mehr, ungueltige Profile und manipulierte Namen ohne sichtbares Medium ab", async () => {
    const service = makeService();
    const exact = patternBytes(20_000_000);
    const accepted = await service.createMedia({
      displayName: "SYN-Grenze.mp4",
      content: streamOf(exact, 256 * 1024),
      metadata: metadata(),
    });
    expect(accepted.sizeBytes).toBe(20_000_000);
    expect(accepted.sha256).toBe(sha256Of(exact));
    expect(await mediaCount("ready")).toBe(1);

    const over = patternBytes(20_000_001);
    await expect(
      service.createMedia({
        displayName: "SYN-ZuGross.mp4",
        content: streamOf(over, 256 * 1024),
        metadata: metadata(),
      }),
    ).rejects.toMatchObject({ code: "invalid_media_profile" });
    expect(await mediaCount("ready")).toBe(1);
    expect(await mediaCount("staging")).toBe(0);

    await expect(
      service.createMedia({
        displayName: "SYN-FalschesProfil.mp4",
        content: streamOf(patternBytes(1024)),
        metadata: metadata({ width: 1280, height: 720 }),
      }),
    ).rejects.toMatchObject({ code: "invalid_media_profile" });
    expect(await mediaCount("ready")).toBe(1);
    expect(await mediaCount("staging")).toBe(0);

    const manipulatedNames = [
      "../escape.mp4",
      "/etc/passwd",
      "..\\..\\escape.mp4",
      "SYN\u0000.mp4",
      "",
      "x".repeat(256),
    ];
    for (const displayName of manipulatedNames) {
      await expect(
        service.createMedia({
          displayName,
          content: streamOf(patternBytes(32)),
          metadata: metadata(),
        }),
      ).rejects.toMatchObject({ code: "invalid_display_name" });
    }

    await expect(service.getReadyMedia("../../etc/passwd")).rejects.toMatchObject({
      code: "invalid_media_id",
    });
    await expect(service.getReadyMedia("../objects/escape")).rejects.toMatchObject({
      code: "invalid_media_id",
    });

    expect(await mediaCount("ready")).toBe(1);
    expect(await mediaCount("staging")).toBe(0);
    expect(await pathExists(join(dirname(storageRoot), "escape.mp4"))).toBe(false);
    expect((await readdir(storageRoot)).sort()).toEqual(["objects", "staging"]);
  }, 60_000);

  it("verhindert ready bei Audit-, Datenbank- und Dateifehlern; der Wiederanlauf stellt gueltige staging-Eintraege fertig", async () => {
    const failId = randomUUID();
    let failAudit = true;
    const failingWriter: MediaAuditWriter = async (executor, event: AuditEventInput) => {
      if (failAudit && event.targetId === failId) {
        throw new Error("synthetischer Auditfehler");
      }
      const audit = new AuditService({
        executor: pool as Pool,
        now: () => new Date(nowMs),
      });
      await audit.recordWith(executor, event, event.at);
    };

    const auditFailService = makeService({
      idFactory: () => failId,
      auditWriter: failingWriter,
    });
    const auditBytes = patternBytes(1500);
    await expect(
      auditFailService.createMedia({
        displayName: "SYN-Auditfehler.mp4",
        content: streamOf(auditBytes),
        metadata: metadata(),
      }),
    ).rejects.toThrow("synthetischer Auditfehler");

    expect(await rowStatus(failId)).toBe("staging");
    expect(await auditFailService.getReadyMedia(failId)).toBeNull();
    expect(await auditCount()).toBe(0);

    failAudit = false;
    const recoveredAudit = await makeService().recoverStaging();
    expect(recoveredAudit).toEqual({ completed: 1, cleaned: 0, failed: 0 });
    expect(await rowStatus(failId)).toBe("ready");
    const repaired = await auditFailService.getReadyMedia(failId);
    expect(repaired).not.toBeNull();
    expect(Buffer.from(await (repaired as NonNullable<typeof repaired>).read()).equals(auditBytes)).toBe(true);
    expect(await auditCount()).toBe(1);

    const dbFailId = randomUUID();
    const brokenPool = {
      query: (text: string, values?: unknown[]) =>
        (pool as Pool).query(text, values as unknown[] | undefined),
      connect: async () => {
        throw new Error("synthetischer Datenbankfehler");
      },
    } as unknown as MediaSqlPool;
    const dbFailService = makeService({
      pool: brokenPool,
      idFactory: () => dbFailId,
    });
    const dbBytes = patternBytes(1200);
    await expect(
      dbFailService.createMedia({
        displayName: "SYN-Datenbankfehler.mp4",
        content: streamOf(dbBytes),
        metadata: metadata(),
      }),
    ).rejects.toThrow("synthetischer Datenbankfehler");

    expect(await rowStatus(dbFailId)).toBe("staging");
    expect(await dbFailService.getReadyMedia(dbFailId)).toBeNull();
    expect(await auditCount()).toBe(1);

    const recoveredDb = await makeService().recoverStaging();
    expect(recoveredDb).toEqual({ completed: 1, cleaned: 0, failed: 0 });
    expect(await rowStatus(dbFailId)).toBe("ready");
    expect(await auditCount()).toBe(2);

    const collisionId = randomUUID();
    const foreignBytes = patternBytes(777);
    await writeFinal(collisionId, foreignBytes);
    const collisionService = makeService({ idFactory: () => collisionId });
    await expect(
      collisionService.createMedia({
        displayName: "SYN-Kollision.mp4",
        content: streamOf(patternBytes(500)),
        metadata: metadata(),
      }),
    ).rejects.toMatchObject({ code: "object_exists" });

    expect(await rowStatus(collisionId)).toBeNull();
    expect(
      (await readFile(join(storageRoot, "objects", collisionId))).equals(
        foreignBytes,
      ),
    ).toBe(true);
    expect(await auditCount()).toBe(2);

    async function* brokenStream(): AsyncGenerator<Uint8Array> {
      yield patternBytes(10);
      throw new Error("synthetischer Lesefehler");
    }

    const streamService = makeService();
    await expect(
      streamService.createMedia({
        displayName: "SYN-Lesefehler.mp4",
        content: brokenStream(),
        metadata: metadata(),
      }),
    ).rejects.toThrow("synthetischer Lesefehler");
    expect(await mediaCount("staging")).toBe(0);
    expect(await mediaCount("ready")).toBe(2);
  }, 60_000);

  it("Wiederanlauf vervollstaendigt oder bereinigt ausschliesslich eigene staging-Dateien, laesst fremde Dateien unberuehrt und ist idempotent", async () => {
    const service = makeService();

    const aId = randomUUID();
    const aBytes = patternBytes(1500);
    await insertStagingFull(aId, "SYN-Wiederanlauf-A.mp4", aBytes, new Date(nowMs));
    await writeStagingTemp(aId, aBytes);

    nowMs += 1000;
    const bId = randomUUID();
    const bBytes = patternBytes(900);
    await insertStagingFull(bId, "SYN-Wiederanlauf-B.mp4", bBytes, new Date(nowMs));
    await writeFinal(bId, bBytes);

    nowMs += 1000;
    const cId = randomUUID();
    const cBytes = patternBytes(300);
    await insertStagingFull(cId, "SYN-Wiederanlauf-C.mp4", cBytes, new Date(nowMs));

    nowMs += 1000;
    const dId = randomUUID();
    const dBytes = patternBytes(800);
    await insertStagingFull(dId, "SYN-Wiederanlauf-D.mp4", dBytes, new Date(nowMs));
    await writeStagingTemp(dId, dBytes);
    const foreignFinal = Buffer.from(dBytes);
    foreignFinal[0] = foreignFinal[0] ^ 0xff;
    await writeFinal(dId, foreignFinal);

    const foreignObjectId = randomUUID();
    const foreignObjectBytes = Buffer.from("SYN-FREMDES-OBJEKT", "utf8");
    await writeFinal(foreignObjectId, foreignObjectBytes);
    const foreignTempBytes = Buffer.from("SYN-FREMDE-TEMP", "utf8");
    await writeFile(join(storageRoot, "staging", "unrelated.part"), foreignTempBytes, {
      mode: 0o600,
    });

    const result = await service.recoverStaging();
    expect(result).toEqual({ completed: 2, cleaned: 2, failed: 0 });

    const readyA = await service.getReadyMedia(aId);
    expect(readyA).not.toBeNull();
    expect(Buffer.from(await (readyA as NonNullable<typeof readyA>).read()).equals(aBytes)).toBe(true);
    expect(await pathExists(join(storageRoot, "staging", aId + ".part"))).toBe(false);

    const readyB = await service.getReadyMedia(bId);
    expect(readyB).not.toBeNull();
    expect(Buffer.from(await (readyB as NonNullable<typeof readyB>).read()).equals(bBytes)).toBe(true);

    expect(await rowStatus(cId)).toBeNull();
    expect(await rowStatus(dId)).toBeNull();
    expect(await pathExists(join(storageRoot, "staging", dId + ".part"))).toBe(false);
    expect(
      (await readFile(join(storageRoot, "objects", dId))).equals(foreignFinal),
    ).toBe(true);

    expect(
      (await readFile(join(storageRoot, "objects", foreignObjectId))).equals(
        foreignObjectBytes,
      ),
    ).toBe(true);
    expect(
      (await readFile(join(storageRoot, "staging", "unrelated.part"))).equals(
        foreignTempBytes,
      ),
    ).toBe(true);

    expect(await mediaCount("ready")).toBe(2);
    expect(await auditCount()).toBe(2);

    const again = await service.recoverStaging();
    expect(again).toEqual({ completed: 0, cleaned: 0, failed: 0 });
    expect(await mediaCount("ready")).toBe(2);
    expect(await auditCount()).toBe(2);
  }, 30_000);
});
