import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
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
import { ensureCampaignSchema } from "../campaigns/schema.js";
import { issueDownloadTicket } from "../playout/download.js";
import { verifySignedManifest } from "../playout/manifest.js";
import {
  FALLBACK_CAMPAIGN_ID,
  ManifestRefreshService,
  markTaxiRevisions,
  type ManifestRefreshOptions,
} from "./index.js";

const BASE_TIME = Date.parse("2026-11-13T12:00:00.000Z");
const START = "2026-11-13T00:00:00.000Z";
const END = "2026-11-15T00:00:00.000Z";
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);
const MIGRATIONS = [
  "0001_gt_ads_001.up.sql",
  "0007_cx_030_media.up.sql",
  "0009_campaign_customers.up.sql",
  "0010_cx_041_manifest_refresh.up.sql",
  "0011_cx_078_media_deletion.up.sql",
];

let pool: Pool | null = null;
let schemaName = "";
let nowMs = BASE_TIME;

const keyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const trustedKeys = new Map([["cx045-test", keyPair.publicKey]]);

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
    throw new Error("CX-045 benoetigt eine PostgreSQL-Testumgebung (PGHOST/PGUSER/PGDATABASE).");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function requirePool(): Pool {
  if (pool === null) {
    throw new Error("Testdatenbank ist nicht initialisiert.");
  }
  return pool;
}

async function insertCustomer(id: string): Promise<void> {
  await requirePool().query(
    [
      "insert into customers (id, display_name, revision, created_at, updated_at)",
      "values ($1::uuid, 'SYN-CX045-Kunde', 1, $2, $2)",
    ].join("\n"),
    [id, new Date(BASE_TIME)],
  );
}

interface MediaFixture {
  id: string;
  sha256?: string;
  durationSeconds?: number;
  width?: number;
  status?: "ready" | "staging";
}

async function insertMedia(fixture: MediaFixture): Promise<void> {
  const status = fixture.status ?? "ready";
  const readyAt = status === "ready" ? new Date(BASE_TIME) : null;
  await requirePool().query(
    [
      "insert into media_objects",
      "  (id, display_name, size_bytes, sha256, container, video_codec,",
      "   width, height, frame_rate_numerator, frame_rate_denominator,",
      "   audio_stream_count, duration_seconds, created_at, status, ready_at)",
      "values ($1::uuid, 'SYN-CX045-Spot.mp4', 1000, $2, 'mp4', 'h264',",
      "        $3, 1080, 30, 1, 0, $4, $5, $6, $7)",
    ].join("\n"),
    [
      fixture.id,
      fixture.sha256 ?? "a".repeat(64),
      fixture.width ?? 1920,
      fixture.durationSeconds ?? 15,
      new Date(BASE_TIME),
      status,
      readyAt,
    ],
  );
}

interface CampaignFixture {
  id: string;
  customerId: string;
  mediaId: string;
  taxiIds: readonly string[];
  status?: "draft" | "active" | "paused" | "finished";
  startAt?: string;
  endAt?: string;
}

async function insertCampaign(fixture: CampaignFixture): Promise<void> {
  await requirePool().query(
    [
      "insert into campaigns",
      "  (id, customer_id, media_id, owner_id, rule_type, status, archived,",
      "   start_at, end_at, revision, created_at, updated_at)",
      "values ($1::uuid, $2::uuid, $3::uuid, 'admin', 'fixed_slot', $4,",
      "        false, $5::timestamptz, $6::timestamptz, 1, $7, $7)",
    ].join("\n"),
    [
      fixture.id,
      fixture.customerId,
      fixture.mediaId,
      fixture.status ?? "active",
      fixture.startAt ?? START,
      fixture.endAt ?? END,
      new Date(BASE_TIME),
    ],
  );
  for (const taxiId of fixture.taxiIds) {
    await requirePool().query(
      "insert into campaign_targets (campaign_id, kind, target_id) values ($1::uuid, 'taxi', $2)",
      [fixture.id, taxiId],
    );
  }
}

function refreshOptions(
  overrides: Partial<ManifestRefreshOptions> = {},
): ManifestRefreshOptions {
  return {
    pool: requirePool(),
    signingKey: keyPair.privateKey,
    keyId: "cx045-test",
    environment: "test",
    trustedKeys,
    now: () => new Date(nowMs),
    ...overrides,
  };
}

async function mark(taxiId: string): Promise<void> {
  await markTaxiRevisions(requirePool(), [taxiId], new Date(nowMs));
}

function verifyArtifact(
  artifact: { envelope: unknown } | null,
  taxiId: string,
) {
  expect(artifact).not.toBeNull();
  return verifySignedManifest(artifact?.envelope, {
    taxiId,
    environment: "test",
    trustedKeys,
  });
}

async function artifactRows(taxiId: string): Promise<
  Array<{ version: string; signature_base64: string; created_at: Date }>
> {
  const result = await requirePool().query<{
    version: string;
    signature_base64: string;
    created_at: Date;
  }>(
    [
      "select version, signature_base64, created_at",
      "  from taxi_manifest_artifacts",
      " where taxi_id = $1",
      " order by created_at asc, version asc",
    ].join("\n"),
    [taxiId],
  );
  return result.rows;
}

beforeAll(async () => {
  const base = baseConnection();
  schemaName = ("cx045_" + process.pid + "_" + Date.now().toString(36))
    .toLowerCase()
    .slice(0, 63);
  // Eigene Schema-Isolation in der vom Runner bereitgestellten Datenbank:
  // kein CREATE DATABASE und kein Beenden fremder Backends noetig.
  pool = new Pool({
    ...base,
    options: "-c search_path=" + schemaName + ",public",
  });
  await requirePool().query(
    "create schema " + quoteIdentifier(schemaName),
  );

  for (const name of MIGRATIONS) {
    const sql = await readFile(join(MIGRATIONS_DIR, name), "utf8");
    await requirePool().query(sql);
  }
  await ensureCampaignSchema(requirePool());
}, 60_000);

beforeEach(async () => {
  nowMs = BASE_TIME;
  await requirePool().query(
    [
      "truncate table audit_events, campaign_targets, campaigns,",
      "  media_objects, customers, taxi_group_memberships,",
      "  taxi_manifest_state, taxi_manifest_artifacts",
      "restart identity cascade",
    ].join("\n"),
  );
});

afterAll(async () => {
  if (pool !== null) {
    if (schemaName !== "") {
      await pool
        .query(
          "drop schema if exists " + quoteIdentifier(schemaName) + " cascade",
        )
        .catch(() => undefined);
    }
    await pool.end();
  }
}, 30_000);

describe("CX-045 / R-305 GT-Ads-Fallback im Manifest", () => {
  it("erzeugt ohne ausspielbare Kampagne ein signiertes Manifest mit dem konfigurierten Platzhaltermedium; Hash und Downloadreferenz verweisen auf das gespeicherte Medium", async () => {
    const fallbackId = randomUUID();
    const sha256 = "c".repeat(64);
    await insertMedia({ id: fallbackId, sha256, durationSeconds: 15 });
    await mark("taxi-fallback");

    const service = new ManifestRefreshService(
      refreshOptions({ fallbackMediaId: fallbackId }),
    );
    const run = await service.drainPending({ limit: 10 });
    expect(run.failed).toBe(0);
    expect(run.published).toBe(1);

    const artifact = await service.getCurrentArtifact("taxi-fallback");
    const verified = verifyArtifact(artifact, "taxi-fallback");

    expect(verified.plan.taxiId).toBe("taxi-fallback");
    expect(verified.plan.slotCount).toBe(12);
    expect(verified.plan.spots).toHaveLength(12);
    for (const spot of verified.plan.spots) {
      expect(spot.mediaId).toBe(fallbackId);
      expect(spot.sha256).toBe(sha256);
      expect(spot.sizeBytes).toBe(1000);
      expect(spot.durationMs).toBe(15_000);
      expect(spot.campaignId).toBe(FALLBACK_CAMPAIGN_ID);
    }

    const ticket = issueDownloadTicket({
      deviceId: "device-cx045",
      deviceTaxiBinding: {
        deviceId: "device-cx045",
        taxiId: "taxi-fallback",
        authorized: true,
      },
      manifest: verified,
      mediaId: fallbackId,
      secret: "s".repeat(32),
      clock: () => new Date(nowMs),
    });
    expect(ticket.payload.mediaId).toBe(fallbackId);
    expect(ticket.payload.sha256).toBe(sha256);
    expect(ticket.payload.manifestVersion).toBe(verified.version);
  });

  it("laesst den bestehenden Schleifenplan einer aktiven, gueltigen, zugeordneten Kampagne unveraendert", async () => {
    const customerId = randomUUID();
    const mediaId = randomUUID();
    const fallbackId = randomUUID();
    const campaignId = randomUUID();
    await insertCustomer(customerId);
    await insertMedia({ id: mediaId, sha256: "d".repeat(64), durationSeconds: 15 });
    await insertMedia({ id: fallbackId, sha256: "e".repeat(64), durationSeconds: 15 });
    await insertCampaign({
      id: campaignId,
      customerId,
      mediaId,
      taxiIds: ["taxi-a", "taxi-b"],
    });
    await mark("taxi-a");
    await mark("taxi-b");

    const withFallback = new ManifestRefreshService(
      refreshOptions({ fallbackMediaId: fallbackId }),
    );
    const campaignOnly = new ManifestRefreshService(refreshOptions());

    const first = await withFallback.drainPending({ limit: 1 });
    const second = await campaignOnly.drainPending({ limit: 1 });
    expect(first.failed + second.failed).toBe(0);
    expect(first.published + second.published).toBe(2);

    const verifiedA = verifyArtifact(
      await withFallback.getCurrentArtifact("taxi-a"),
      "taxi-a",
    );
    const verifiedB = verifyArtifact(
      await campaignOnly.getCurrentArtifact("taxi-b"),
      "taxi-b",
    );

    expect(verifiedA.plan.spots).toEqual(verifiedB.plan.spots);
    for (const spot of verifiedA.plan.spots) {
      expect(spot.campaignId).toBe(campaignId);
      expect(spot.mediaId).toBe(mediaId);
      expect(spot.sha256).toBe("d".repeat(64));
    }
  });

  it("pausierte, beendete und noch nicht gestartete Kampagnen verhindern den Fallback nicht", async () => {
    const customerId = randomUUID();
    const mediaId = randomUUID();
    const fallbackId = randomUUID();
    await insertCustomer(customerId);
    await insertMedia({ id: mediaId, sha256: "f".repeat(64), durationSeconds: 15 });
    await insertMedia({ id: fallbackId, sha256: "1".repeat(64), durationSeconds: 15 });
    for (const status of ["paused", "finished", "draft"] as const) {
      await insertCampaign({
        id: randomUUID(),
        customerId,
        mediaId,
        taxiIds: ["taxi-status"],
        status,
        startAt: START,
        endAt: END,
      });
    }

    // Auch aktive Kampagnen ausserhalb ihres Laufzeitfensters sind zum
    // Auswertungszeitpunkt nicht ausspielbar.
    await insertCampaign({
      id: randomUUID(),
      customerId,
      mediaId,
      taxiIds: ["taxi-status"],
      status: "active",
      startAt: "2026-12-01T00:00:00.000Z",
      endAt: "2026-12-02T00:00:00.000Z",
    });
    await insertCampaign({
      id: randomUUID(),
      customerId,
      mediaId,
      taxiIds: ["taxi-status"],
      status: "active",
      startAt: "2026-11-01T00:00:00.000Z",
      endAt: "2026-11-12T00:00:00.000Z",
    });
    await mark("taxi-status");

    const service = new ManifestRefreshService(
      refreshOptions({ fallbackMediaId: fallbackId }),
    );
    const run = await service.drainPending({ limit: 10 });
    expect(run.failed).toBe(0);
    expect(run.published).toBe(1);

    const verified = verifyArtifact(
      await service.getCurrentArtifact("taxi-status"),
      "taxi-status",
    );
    expect(verified.plan.spots).toHaveLength(12);
    for (const spot of verified.plan.spots) {
      expect(spot.mediaId).toBe(fallbackId);
      expect(spot.campaignId).toBe(FALLBACK_CAMPAIGN_ID);
    }
  });

  it("erzeugt beim Wechsel Kampagne zu Fallback und zurueck passende neue Versionen und dupliziert bei identischer Wiederholung nichts", async () => {
    const customerId = randomUUID();
    const mediaA = randomUUID();
    const mediaB = randomUUID();
    const fallbackId = randomUUID();
    const campaignA = randomUUID();
    const campaignB = randomUUID();
    await insertCustomer(customerId);
    await insertMedia({ id: mediaA, sha256: "2".repeat(64), durationSeconds: 15 });
    await insertMedia({ id: mediaB, sha256: "3".repeat(64), durationSeconds: 15 });
    await insertMedia({ id: fallbackId, sha256: "4".repeat(64), durationSeconds: 15 });
    await insertCampaign({
      id: campaignA,
      customerId,
      mediaId: mediaA,
      taxiIds: ["taxi-switch"],
    });

    const service = new ManifestRefreshService(
      refreshOptions({ fallbackMediaId: fallbackId }),
    );

    await mark("taxi-switch");
    expect((await service.drainPending({ limit: 10 })).published).toBe(1);
    const first = verifyArtifact(
      await service.getCurrentArtifact("taxi-switch"),
      "taxi-switch",
    );
    expect(first.plan.spots.every((spot) => spot.campaignId === campaignA)).toBe(true);

    await requirePool().query(
      "update campaigns set status = 'finished', updated_at = $2 where id = $1::uuid",
      [campaignA, new Date(nowMs + 1000)],
    );
    await mark("taxi-switch");
    expect((await service.drainPending({ limit: 10 })).published).toBe(1);
    const second = verifyArtifact(
      await service.getCurrentArtifact("taxi-switch"),
      "taxi-switch",
    );
    expect(second.version).not.toBe(first.version);
    expect(
      second.plan.spots.every(
        (spot) => spot.campaignId === FALLBACK_CAMPAIGN_ID && spot.mediaId === fallbackId,
      ),
    ).toBe(true);

    await insertCampaign({
      id: campaignB,
      customerId,
      mediaId: mediaB,
      taxiIds: ["taxi-switch"],
    });
    await mark("taxi-switch");
    expect((await service.drainPending({ limit: 10 })).published).toBe(1);
    const third = verifyArtifact(
      await service.getCurrentArtifact("taxi-switch"),
      "taxi-switch",
    );
    expect(third.version).not.toBe(second.version);
    expect(third.plan.spots.every((spot) => spot.campaignId === campaignB)).toBe(true);

    const rowsBefore = await artifactRows("taxi-switch");
    expect(rowsBefore).toHaveLength(3);

    // Gleicher Quellstand, späterer Auswertungszeitpunkt: keine neue Version,
    // kein veraendertes altes Artefakt.
    nowMs += 60_000;
    await mark("taxi-switch");
    const repeat = await service.drainPending({ limit: 10 });
    expect(repeat.failed).toBe(0);
    expect(repeat.published).toBe(1);
    const rowsAfter = await artifactRows("taxi-switch");
    expect(rowsAfter).toHaveLength(3);
    expect(rowsAfter).toEqual(rowsBefore);
    const current = await service.getCurrentArtifact("taxi-switch");
    expect(current?.version).toBe(third.version);
  });

  it("verhindert bei fehlender oder ungueltiger Platzhalterkonfiguration eine neue Veroeffentlichung mit nachvollziehbarem Fehler und laesst bestehende Artefakte unveraendert", async () => {
    const fallbackId = randomUUID();
    const invalidProfileId = randomUUID();
    await insertMedia({ id: fallbackId, sha256: "5".repeat(64), durationSeconds: 15 });
    await insertMedia({
      id: invalidProfileId,
      sha256: "6".repeat(64),
      durationSeconds: 15,
      width: 1280,
    });

    const service = new ManifestRefreshService(
      refreshOptions({ fallbackMediaId: fallbackId }),
    );
    await mark("taxi-errors");
    expect((await service.drainPending({ limit: 10 })).published).toBe(1);
    const baseline = verifyArtifact(
      await service.getCurrentArtifact("taxi-errors"),
      "taxi-errors",
    );
    const before = await artifactRows("taxi-errors");
    expect(before).toHaveLength(1);

    for (const [fallbackMediaId, expected] of [
      [undefined, "fallback_config_missing"],
      ["keine-uuid", "fallback_config_invalid"],
      [randomUUID(), "fallback_media_not_found"],
      [invalidProfileId, "fallback_media_invalid"],
    ] as const) {
      const failing = new ManifestRefreshService(
        refreshOptions({ fallbackMediaId }),
      );
      await mark("taxi-errors");
      const run = await failing.drainPending({ limit: 10 });
      expect(run.failed, expected).toBe(1);
      expect(run.published).toBe(0);
      const state = await failing.getRefreshState("taxi-errors");
      expect(state?.lastError).toContain(expected);
      expect(state?.currentVersion).toBe(baseline.version);
    }

    const after = await artifactRows("taxi-errors");
    expect(after).toEqual(before);
    expect((await service.getCurrentArtifact("taxi-errors"))?.version).toBe(
      baseline.version,
    );
  });
});
