import { randomUUID } from "node:crypto";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
import { CampaignService } from "../campaigns/campaigns.js";
import { ensureCampaignSchema } from "../campaigns/schema.js";
import { createMediaService } from "../media/service.js";
import { verifySignedManifest } from "../playout/manifest.js";
import { TaxiGroupAssignmentService } from "../taxiAssignments/index.js";
import {
  ManifestRefreshService,
  markTaxiRevisions,
  type ManifestRefreshOptions,
} from "./index.js";

const BASE_TIME = Date.parse("2026-11-13T12:00:00.000Z");
const START = "2026-12-01T08:00:00.000Z";
const END = "2026-12-01T18:00:00.000Z";
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);
const MIGRATIONS = [
  "0001_gt_ads_001.up.sql",
  "0007_cx_030_media.up.sql",
  "0009_campaign_customers.up.sql",
];

let maintenancePool: Pool | null = null;
let pool: Pool | null = null;
let databaseName = "";
let storageRoot = "";
let nowMs = BASE_TIME;

const keyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const trustedKeys = new Map([["cx041-test", keyPair.publicKey]]);

interface StateSnapshot {
  requested: number;
  processed: number;
  currentVersion: string | null;
  currentRevision: number | null;
  lastError: string | null;
}

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
    throw new Error("CX-041 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function requirePool(): Pool {
  if (pool === null) {
    throw new Error("Testdatenbank ist nicht initialisiert.");
  }
  return pool;
}

async function stateMap(): Promise<Map<string, StateSnapshot>> {
  const result = await requirePool().query<{
    taxi_id: string;
    requested_revision: string;
    processed_revision: string;
    current_version: string | null;
    current_revision: string | null;
    last_error: string | null;
  }>(
    [
      "select taxi_id, requested_revision, processed_revision,",
      "       current_version, current_revision, last_error",
      "  from taxi_manifest_state",
      " order by taxi_id asc",
    ].join("\n"),
  );
  const map = new Map<string, StateSnapshot>();
  for (const row of result.rows) {
    map.set(row.taxi_id, {
      requested: Number(row.requested_revision),
      processed: Number(row.processed_revision),
      currentVersion: row.current_version,
      currentRevision:
        row.current_revision === null ? null : Number(row.current_revision),
      lastError: row.last_error,
    });
  }
  return map;
}

async function insertCustomer(id: string): Promise<void> {
  await requirePool().query(
    [
      "insert into customers (id, display_name, revision, created_at, updated_at)",
      "values ($1::uuid, 'SYN-CX041-Kunde', 1, $2, $2)",
    ].join("\n"),
    [id, new Date(BASE_TIME)],
  );
}

async function insertMedia(
  id: string,
  sha256 = "a".repeat(64),
  durationSeconds = 15,
): Promise<void> {
  await requirePool().query(
    [
      "insert into media_objects",
      "  (id, display_name, size_bytes, sha256, container, video_codec,",
      "   width, height, frame_rate_numerator, frame_rate_denominator,",
      "   audio_stream_count, duration_seconds, created_at, status, ready_at)",
      "values ($1::uuid, 'SYN-CX041-Spot.mp4', 1000, $2, 'mp4', 'h264',",
      "        1920, 1080, 30, 1, 0, $3, $4, 'ready', $4)",
    ].join("\n"),
    [id, sha256, durationSeconds, new Date(BASE_TIME)],
  );
}

async function insertDirectCampaign(input: {
  id: string;
  customerId: string;
  mediaId: string;
  taxiIds: readonly string[];
  groupIds?: readonly string[];
}): Promise<void> {
  await requirePool().query(
    [
      "insert into campaigns",
      "  (id, customer_id, media_id, owner_id, rule_type, status, archived,",
      "   start_at, end_at, revision, created_at, updated_at)",
      "values ($1::uuid, $2::uuid, $3::uuid, 'admin', 'fixed_slot', 'active',",
      "        false, $4::timestamptz, $5::timestamptz, 1, $6, $6)",
    ].join("\n"),
    [
      input.id,
      input.customerId,
      input.mediaId,
      START,
      END,
      new Date(BASE_TIME),
    ],
  );
  for (const taxiId of input.taxiIds) {
    await requirePool().query(
      "insert into campaign_targets (campaign_id, kind, target_id) values ($1::uuid, 'taxi', $2)",
      [input.id, taxiId],
    );
  }
  for (const groupId of input.groupIds ?? []) {
    await requirePool().query(
      "insert into campaign_targets (campaign_id, kind, target_id) values ($1::uuid, 'group', $2)",
      [input.id, groupId],
    );
  }
}

async function insertMembership(groupId: string, taxiId: string): Promise<void> {
  await requirePool().query(
    "insert into taxi_group_memberships (group_id, taxi_id) values ($1, $2)",
    [groupId, taxiId],
  );
}

function refreshOptions(
  overrides: Partial<ManifestRefreshOptions> = {},
): ManifestRefreshOptions {
  return {
    pool: requirePool(),
    signingKey: keyPair.privateKey,
    keyId: "cx041-test",
    environment: "test",
    trustedKeys,
    now: () => new Date(nowMs),
    ...overrides,
  };
}

function campaignService(): CampaignService {
  return new CampaignService({
    pool: requirePool(),
    now: () => new Date(nowMs),
  });
}

async function* streamOf(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

const uploadMetadata = {
  container: "mp4",
  videoCodec: "h264",
  width: 1920,
  height: 1080,
  frameRateNumerator: 30,
  frameRateDenominator: 1,
  audioStreamCount: 0,
  durationSeconds: 15,
  sizeBytes: 4,
};

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = ("cx041_" + process.pid + "_" + Date.now().toString(36))
    .toLowerCase()
    .slice(0, 63);
  await maintenancePool.query(
    "create database " + quoteIdentifier(databaseName),
  );
  pool = new Pool({ ...base, database: databaseName });

  for (const name of MIGRATIONS) {
    const sql = await readFile(join(MIGRATIONS_DIR, name), "utf8");
    await requirePool().query(sql);
  }
  await ensureCampaignSchema(requirePool());
  const migration = await readFile(
    join(MIGRATIONS_DIR, "0010_cx_041_manifest_refresh.up.sql"),
    "utf8",
  );
  await requirePool().query(migration);

  storageRoot = await mkdtemp(join(tmpdir(), "cx041-media-"));
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
  await rm(storageRoot, { recursive: true, force: true });
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
});

afterAll(async () => {
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

describe("CX-041 / R-301 Manifest-Neuberechnung", () => {
  it("markiert Kampagnen-, Medien- und Zuordnungsaenderungen als exakte Vereinigungsmenge vorher/nachher und erzeugt bei ueberlappenden Gruppen keine doppelte Markierung", async () => {
    const customerId = randomUUID();
    const mediaId = randomUUID();
    await insertCustomer(customerId);
    await insertMedia(mediaId);
    await insertMembership("group-1", "taxi-B");
    await insertMembership("group-2", "taxi-D");
    await insertMembership("group-3", "taxi-E");
    await insertMembership("group-4", "taxi-E");

    const service = campaignService();
    const campaign = await service.createCampaign({
      customerId,
      mediaId,
      startAt: START,
      endAt: END,
      status: "active",
      taxiIds: ["taxi-A"],
      groupIds: ["group-1"],
      ownerId: "admin",
    });

    let states = await stateMap();
    expect([...states.keys()]).toEqual(["taxi-A", "taxi-B"]);
    expect(states.get("taxi-A")?.requested).toBe(1);
    expect(states.get("taxi-B")?.requested).toBe(1);

    await service.updateCampaign(
      campaign.id,
      {
        taxiIds: ["taxi-C"],
        groupIds: ["group-2"],
        revision: 1,
      },
      "admin",
    );

    states = await stateMap();
    expect([...states.keys()]).toEqual([
      "taxi-A",
      "taxi-B",
      "taxi-C",
      "taxi-D",
    ]);
    expect(states.get("taxi-A")?.requested).toBe(2);
    expect(states.get("taxi-B")?.requested).toBe(2);
    expect(states.get("taxi-C")?.requested).toBe(1);
    expect(states.get("taxi-D")?.requested).toBe(1);

    await service.updateCampaign(
      campaign.id,
      {
        taxiIds: ["taxi-C"],
        groupIds: ["group-3", "group-4"],
        revision: 2,
      },
      "admin",
    );

    states = await stateMap();
    expect([...states.keys()]).toEqual([
      "taxi-A",
      "taxi-B",
      "taxi-C",
      "taxi-D",
      "taxi-E",
    ]);
    // taxi-E ist in beiden ueberlappenden Gruppen, wird aber nur einmal gezaehlt.
    expect(states.get("taxi-E")?.requested).toBe(1);

    const assignmentService = new TaxiGroupAssignmentService({
      pool: requirePool(),
      now: () => new Date(nowMs),
    });
    const firstChange = await assignmentService.replaceGroupMembers(
      "group-3",
      ["taxi-F"],
    );
    expect(firstChange.affected).toEqual(["taxi-E", "taxi-F"]);

    states = await stateMap();
    expect(states.get("taxi-E")?.requested).toBe(2);
    expect(states.get("taxi-F")?.requested).toBe(1);

    const secondChange = await assignmentService.replaceGroupMembers(
      "group-3",
      ["taxi-F", "taxi-G"],
    );
    expect(secondChange.affected).toEqual(["taxi-F", "taxi-G"]);

    states = await stateMap();
    // Das entfernte Mitglied taxi-E wird nicht erneut markiert.
    expect(states.get("taxi-E")?.requested).toBe(2);
    expect(states.get("taxi-F")?.requested).toBe(2);
    expect(states.get("taxi-G")?.requested).toBe(1);

    // Medienaenderung ueber den bestehenden CX-030-Mutationsdienst.
    const uploadId = randomUUID();
    await insertDirectCampaign({
      id: randomUUID(),
      customerId,
      mediaId: uploadId,
      taxiIds: ["taxi-media"],
    });
    const mediaService = createMediaService({
      pool: requirePool(),
      storageRoot,
      now: () => new Date(nowMs),
      idFactory: () => uploadId,
    });
    await mediaService.createMedia({
      displayName: "SYN-CX041-Spot.mp4",
      content: streamOf(new Uint8Array([1, 2, 3, 4])),
      metadata: uploadMetadata,
      actorType: "admin",
      actorId: "admin",
    });

    states = await stateMap();
    expect(states.get("taxi-media")?.requested).toBe(1);
  });

  it("erzeugt in einem realen Lauf je betroffenem Taxi eine nachpruefbar signierte neue Version, laesst alte Artefakte unveraendert und bleibt ohne Aenderung wirkungslos", async () => {
    const customerId = randomUUID();
    const mediaId = randomUUID();
    await insertCustomer(customerId);
    await insertMedia(mediaId);

    const campaign = await campaignService().createCampaign({
      customerId,
      mediaId,
      startAt: START,
      endAt: END,
      status: "active",
      taxiIds: ["taxi-1", "taxi-2"],
      groupIds: [],
      ownerId: "admin",
    });
    expect(campaign.revision).toBe(1);

    const service = new ManifestRefreshService(refreshOptions());
    const first = await service.drainPending({ limit: 10 });
    expect(first.published).toBe(2);
    expect(first.failed).toBe(0);

    const stateOne = await service.getRefreshState("taxi-1");
    const stateTwo = await service.getRefreshState("taxi-2");
    expect(stateOne?.processedRevision).toBe(1);
    expect(stateOne?.currentRevision).toBe(1);
    expect(stateTwo?.processedRevision).toBe(1);

    const artifactOne = await service.getCurrentArtifact("taxi-1");
    const artifactTwo = await service.getCurrentArtifact("taxi-2");
    expect(artifactOne).not.toBeNull();
    expect(artifactTwo).not.toBeNull();
    expect(artifactOne?.version).not.toBe(artifactTwo?.version);

    const verified = verifySignedManifest(artifactOne?.envelope as unknown, {
      taxiId: "taxi-1",
      environment: "test",
      trustedKeys,
    });
    expect(verified.version).toBe(artifactOne?.version);

    const storedBefore = await requirePool().query<{
      version: string;
      signature_base64: string;
      created_at: Date;
    }>(
      "select version, signature_base64, created_at from taxi_manifest_artifacts where taxi_id = 'taxi-1'",
    );
    expect(storedBefore.rows).toHaveLength(1);

    // Gleicher Quellstand, erneut angefordert: keine zweite Veroeffentlichung.
    nowMs += 1000;
    await markTaxiRevisions(
      requirePool(),
      ["taxi-1"],
      new Date(nowMs),
    );
    const repeat = await service.drainPending({ limit: 10 });
    expect(repeat.published).toBe(1);
    expect(repeat.failed).toBe(0);

    const storedAfter = await requirePool().query<{
      version: string;
      signature_base64: string;
      created_at: Date;
    }>(
      "select version, signature_base64, created_at from taxi_manifest_artifacts where taxi_id = 'taxi-1'",
    );
    expect(storedAfter.rows).toHaveLength(1);
    expect(storedAfter.rows[0]).toEqual(storedBefore.rows[0]);

    const artifacts = await service.listArtifacts("taxi-1");
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.version).toBe(artifactOne?.version);

    const idle = await service.drainPending({ limit: 10 });
    expect(idle.scanned).toBe(0);
    expect(idle.published).toBe(0);
    const stateAfter = await service.getRefreshState("taxi-1");
    expect(stateAfter?.processedRevision).toBe(2);
    expect(stateAfter?.currentRevision).toBe(2);
  });


  it("verliert bei konkurrierenden Laeufen und einer Aenderung waehrend der Erzeugung keine Markierung, veroeffentlicht keinen aelteren Stand und verarbeitet offene Arbeit nach Neustart", async () => {
    const customerId = randomUUID();
    const mediaA = randomUUID();
    const mediaB = randomUUID();
    await insertCustomer(customerId);
    await insertMedia(mediaA, "a".repeat(64));
    await insertMedia(mediaB, "b".repeat(64));

    const campaign = await campaignService().createCampaign({
      customerId,
      mediaId: mediaA,
      startAt: START,
      endAt: END,
      status: "active",
      taxiIds: ["taxi-conc"],
      groupIds: [],
      ownerId: "admin",
    });

    await requirePool().query(
      "create or replace function cx041_slow_artifact() returns trigger language plpgsql as $$ begin perform pg_sleep(1); return new; end $$",
    );
    await requirePool().query(
      "create trigger cx041_slow_artifact before insert on taxi_manifest_artifacts for each row execute function cx041_slow_artifact()",
    );

    const service = new ManifestRefreshService(refreshOptions());
    const drain = service.drainPending({ limit: 10 });
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Diese Mutation blockiert am Zustandsdatensatz, bis der Lauf committet.
    const update = campaignService().updateCampaign(
      campaign.id,
      {
        mediaId: mediaB,
        taxiIds: ["taxi-conc", "taxi-conc2"],
        revision: 1,
      },
      "admin",
    );

    const firstDrain = await drain;
    await update;
    await requirePool().query(
      "drop trigger cx041_slow_artifact on taxi_manifest_artifacts",
    );
    await requirePool().query("drop function cx041_slow_artifact()");

    expect(firstDrain.failed).toBe(0);
    let state = await stateMap();
    expect(state.get("taxi-conc")?.processed).toBe(1);
    expect(state.get("taxi-conc")?.requested).toBe(2);
    expect(state.get("taxi-conc2")?.processed).toBe(0);
    expect(state.get("taxi-conc2")?.requested).toBe(1);
    const firstVersion = state.get("taxi-conc")?.currentVersion;

    const secondDrain = await service.drainPending({ limit: 10 });
    expect(secondDrain.published).toBe(2);
    state = await stateMap();
    expect(state.get("taxi-conc")?.processed).toBe(2);
    expect(state.get("taxi-conc")?.currentVersion).not.toBe(firstVersion);

    // Neustart: neue Instanz verarbeitet ausschliesslich persistente offene Arbeit.
    await markTaxiRevisions(
      requirePool(),
      ["taxi-conc"],
      new Date(nowMs + 2000),
    );
    const restarted = new ManifestRefreshService(refreshOptions());
    const [left, right] = await Promise.all([
      service.drainPending({ limit: 10 }),
      restarted.drainPending({ limit: 10 }),
    ]);
    expect(left.failed + right.failed).toBe(0);
    expect(left.published + right.published).toBe(1);

    state = await stateMap();
    expect(state.get("taxi-conc")?.requested).toBe(3);
    expect(state.get("taxi-conc")?.processed).toBe(3);
    expect(state.get("taxi-conc")?.currentRevision).toBe(3);

    const artifacts = await service.listArtifacts("taxi-conc");
    const versions = artifacts.map((artifact) => artifact.version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("rollt Markierungen mit der Fachmutation zurueck, haelt Planungs- und Signierfehler offen ohne Teilartefakt und fuehrt die additive Migration vorwaerts und rueckwaerts aus", async () => {
    const customerId = randomUUID();
    const mediaId = randomUUID();
    await insertCustomer(customerId);
    await insertMedia(mediaId);

    const campaign = await campaignService().createCampaign({
      customerId,
      mediaId,
      startAt: START,
      endAt: END,
      status: "active",
      taxiIds: ["taxi-A"],
      groupIds: [],
      ownerId: "admin",
    });

    await requirePool().query(
      "create or replace function cx041_audit_fail() returns trigger language plpgsql as $$ begin if new.action = 'campaign.updated' then raise exception 'cx041 audit failure'; end if; return new; end $$",
    );
    await requirePool().query(
      "create trigger cx041_audit_fail before insert on audit_events for each row execute function cx041_audit_fail()",
    );

    await expect(
      campaignService().updateCampaign(
        campaign.id,
        { taxiIds: ["taxi-A", "taxi-B"], revision: 1 },
        "admin",
      ),
    ).rejects.toBeDefined();

    const targets = await requirePool().query<{ target_id: string }>(
      "select target_id from campaign_targets where campaign_id = $1::uuid order by target_id",
      [campaign.id],
    );
    expect(targets.rows.map((row) => row.target_id)).toEqual(["taxi-A"]);
    let state = await stateMap();
    expect(state.has("taxi-B")).toBe(false);
    expect(state.get("taxi-A")?.requested).toBe(1);

    await requirePool().query(
      "drop trigger cx041_audit_fail on audit_events",
    );
    await requirePool().query("drop function cx041_audit_fail()");

    // Leere Belegung: der vorhandene Planer lehnt sie ab; der Fehler bleibt offen.
    const service = new ManifestRefreshService(refreshOptions());
    await markTaxiRevisions(
      requirePool(),
      ["taxi-empty"],
      new Date(nowMs + 1000),
    );
    const emptyRun = await service.drainPending({ limit: 10 });
    expect(emptyRun.failed).toBe(1);
    state = await stateMap();
    expect(state.get("taxi-empty")?.processed).toBe(0);
    expect(state.get("taxi-empty")?.lastError).not.toBeNull();
    expect(await service.listArtifacts("taxi-empty")).toHaveLength(0);
    await requirePool().query(
      "delete from taxi_manifest_state where taxi_id = 'taxi-empty'",
    );

    // Signierfehler: nichts wird veroeffentlicht, Arbeit bleibt offen.
    const signCampaign = await campaignService().createCampaign({
      customerId,
      mediaId,
      startAt: START,
      endAt: END,
      status: "active",
      taxiIds: ["taxi-sign"],
      groupIds: [],
      ownerId: "admin",
    });
    expect(signCampaign.revision).toBe(1);
    const failing = new ManifestRefreshService(
      refreshOptions({
        signer: () => {
          throw new Error("synthetic signing failure");
        },
      }),
    );
    const signRun = await failing.drainPending({ limit: 10 });
    expect(signRun.failed).toBe(1);
    state = await stateMap();
    expect(state.get("taxi-sign")?.processed).toBe(0);
    expect(state.get("taxi-sign")?.lastError).toContain(
      "synthetic signing failure",
    );
    expect(await failing.listArtifacts("taxi-sign")).toHaveLength(0);

    const recovered = await service.drainPending({ limit: 10 });
    expect(recovered.published).toBe(1);
    state = await stateMap();
    expect(state.get("taxi-sign")?.processed).toBe(1);
    expect(state.get("taxi-sign")?.lastError).toBeNull();

    // Additive Migration im isolierten Testschema vorwaerts und rueckwaerts.
    const schema = ("cx041_mig_" + process.pid).toLowerCase();
    const client = await requirePool().connect();
    try {
      await client.query("create schema " + quoteIdentifier(schema));
      await client.query("set search_path to " + quoteIdentifier(schema));
      const up = await readFile(
        join(MIGRATIONS_DIR, "0010_cx_041_manifest_refresh.up.sql"),
        "utf8",
      );
      const down = await readFile(
        join(MIGRATIONS_DIR, "0010_cx_041_manifest_refresh.down.sql"),
        "utf8",
      );

      await client.query(up);
      let tables = await client.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema = $1 order by table_name",
        [schema],
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "taxi_group_memberships",
        "taxi_manifest_artifacts",
        "taxi_manifest_state",
      ]);

      await client.query(down);
      tables = await client.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema = $1",
        [schema],
      );
      expect(tables.rows).toHaveLength(0);

      await client.query(up);
      tables = await client.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema = $1",
        [schema],
      );
      expect(tables.rows).toHaveLength(3);
    } finally {
      await client.query("set search_path to public").catch(() => undefined);
      await client
        .query("drop schema if exists " + quoteIdentifier(schema) + " cascade")
        .catch(() => undefined);
      client.release();
    }
  });
});

