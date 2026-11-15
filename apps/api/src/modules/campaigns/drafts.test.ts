import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
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
import { ApiError } from "../../http/errors.js";
import {
  CAMPAIGN_AUDIT_TARGET_TYPE,
  CAMPAIGN_CREATED_ACTION,
} from "./campaigns.js";
import {
  CAMPAIGN_DRAFT_AUDIT_FIELDS,
  CAMPAIGN_DRAFT_STATUS,
  saveCampaignDraft,
} from "./drafts.js";

const BASE_TIME = Date.parse("2026-11-15T10:00:00.000Z");
const START = "2026-12-01T08:00:00.000Z";
const END = "2026-12-01T18:00:00.000Z";
const OWNER = "operator-owner";
const ACTOR = "operator-actor";
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";

interface DraftRow {
  id: string;
  customer_id: string;
  media_id: string;
  owner_id: string;
  rule_type: string;
  status: string;
  archived: boolean;
  start_at: Date;
  end_at: Date;
  revision: number;
  created_at: Date;
  updated_at: Date;
}

interface AuditRow {
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
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
    throw new Error("CX-101 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

async function insertCustomer(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "insert into customers (id, display_name) values ($1::uuid, $2)",
    [id, "SYN-CX101-Kunde"],
  );
  return id;
}

async function insertMedia(
  status: "ready" | "staging",
  deleted = false,
): Promise<string> {
  const id = randomUUID();
  if (status === "ready") {
    await pool.query(
      "insert into media_objects (id, display_name, size_bytes, sha256, container, video_codec, width, height, frame_rate_numerator, frame_rate_denominator, audio_stream_count, duration_seconds, created_at, status, ready_at, deleted_at) values ($1::uuid, $2, 1024, $3, 'mp4', 'h264', 1080, 1920, 30, 1, 1, 12.5, now(), 'ready', now(), $4)",
      [id, "SYN-CX101-Medium", "a".repeat(64), deleted ? new Date() : null],
    );
  } else {
    await pool.query(
      "insert into media_objects (id, display_name, created_at, status, deleted_at) values ($1::uuid, $2, now(), 'staging', $3)",
      [id, "SYN-CX101-Staging", deleted ? new Date() : null],
    );
  }
  return id;
}

async function draftRow(id: string): Promise<DraftRow | undefined> {
  const result = await pool.query<DraftRow>(
    [
      "select id::text as id, customer_id::text as customer_id,",
      "       media_id::text as media_id, owner_id, rule_type, status,",
      "       archived, start_at, end_at, revision, created_at, updated_at",
      "  from campaigns",
      " where id = $1::uuid",
    ].join("\n"),
    [id],
  );
  return result.rows[0];
}

async function auditRows(targetId: string): Promise<AuditRow[]> {
  const result = await pool.query<AuditRow>(
    [
      "select actor_type, actor_id, action, target_type, target_id, details",
      "  from audit_events",
      " where target_id = $1",
      " order by id asc",
    ].join("\n"),
    [targetId],
  );
  return result.rows;
}

async function stateCounts(): Promise<{ campaigns: number; audits: number }> {
  const result = await pool.query<{ campaigns: number; audits: number }>(
    [
      "select (select count(*)::int from campaigns) as campaigns,",
      "       (select count(*)::int from audit_events) as audits",
    ].join("\n"),
  );
  return result.rows[0] ?? { campaigns: 0, audits: 0 };
}

function baseOptions(
  customerId: string,
  mediaId: string,
): {
  pool: Pool;
  ownerId: string;
  actorId: string;
  customerId: string;
  mediaId: string;
  startAt: string;
  endAt: string;
} {
  return {
    pool,
    ownerId: OWNER,
    actorId: ACTOR,
    customerId,
    mediaId,
    startAt: START,
    endAt: END,
  };
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx101_drafts_" +
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
  const migrationFiles = (await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".up.sql"))
    .sort();
  for (const name of migrationFiles) {
    await pool.query(await readFile(join(MIGRATIONS_DIR, name), "utf8"));
  }
}, 60_000);

beforeEach(async () => {
  await pool.query(
    "truncate table campaigns, media_objects, audit_events, customers restart identity cascade",
  );
});

afterAll(async () => {
  await pool.end();
  await maintenancePool.query(
    "drop database if exists " + quoteIdentifier(databaseName),
  );
  await maintenancePool.end();
}, 30_000);

describe("CX-101 Kampagnenentwurf", () => {
  it("wendet die Migration 0012 im isolierten Schema Up/Down/Up an", async () => {
    const schema = (
      "cx101_migration_" +
      process.pid +
      "_" +
      Math.random().toString(36).slice(2, 8)
    ).toLowerCase();
    const client = await pool.connect();
    try {
      await client.query("create schema " + quoteIdentifier(schema));
      await client.query("set search_path to " + quoteIdentifier(schema));
      // Voraussetzung der Migration: Kundenstamm aus 0009.
      await client.query(
        await readFile(
          join(MIGRATIONS_DIR, "0009_campaign_customers.up.sql"),
          "utf8",
        ),
      );
      const up = await readFile(
        join(MIGRATIONS_DIR, "0012_cx_101_campaign_drafts.up.sql"),
        "utf8",
      );
      const down = await readFile(
        join(MIGRATIONS_DIR, "0012_cx_101_campaign_drafts.down.sql"),
        "utf8",
      );

      await client.query(up);
      const first = await client.query<{ exists: boolean }>(
        "select to_regclass($1)::text is not null as exists",
        [schema + ".campaigns"],
      );
      expect(first.rows[0]?.exists).toBe(true);
      const columns = await client.query<{ column_name: string }>(
        [
          "select column_name",
          "  from information_schema.columns",
          " where table_schema = $1 and table_name = 'campaigns'",
          " order by ordinal_position",
        ].join("\n"),
        [schema],
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual([
        "id",
        "customer_id",
        "media_id",
        "owner_id",
        "rule_type",
        "status",
        "archived",
        "start_at",
        "end_at",
        "revision",
        "created_at",
        "updated_at",
      ]);
      const indexes = await client.query<{ indexname: string }>(
        [
          "select indexname",
          "  from pg_indexes",
          " where schemaname = $1 and tablename = 'campaigns'",
          " order by indexname",
        ].join("\n"),
        [schema],
      );
      expect(indexes.rows.map((row) => row.indexname)).toContain(
        "campaigns_owner_idx",
      );

      await client.query(down);
      const dropped = await client.query<{ exists: boolean }>(
        "select to_regclass($1)::text is not null as exists",
        [schema + ".campaigns"],
      );
      expect(dropped.rows[0]?.exists).toBe(false);

      // Zweites Up muss auf demselben Schema wieder ein vollstaendiges
      // Ergebnis liefern (idempotenter Rueckweg).
      await client.query(up);
      const again = await client.query<{ exists: boolean }>(
        "select to_regclass($1)::text is not null as exists",
        [schema + ".campaigns"],
      );
      expect(again.rows[0]?.exists).toBe(true);
    } finally {
      await client.query("set search_path to public");
      await client.query("drop schema if exists " + quoteIdentifier(schema) + " cascade");
      client.release();
    }
  }, 30_000);

  it("speichert einen Entwurf mit vertrauenswuerdigem Betreiber und bereinigtem Audit", async () => {
    const customerId = await insertCustomer();
    const mediaId = await insertMedia("ready");
    const id = randomUUID();
    const at = new Date(BASE_TIME);

    const draft = await saveCampaignDraft({
      ...baseOptions(customerId, mediaId),
      idFactory: () => id,
      now: () => at,
    });

    expect(draft).toEqual({
      id,
      customerId,
      mediaId,
      ownerId: OWNER,
      ruleType: "fixed_slot",
      status: CAMPAIGN_DRAFT_STATUS,
      archived: false,
      startAt: START,
      endAt: END,
      revision: 1,
      createdAt: at,
      updatedAt: at,
    });

    const row = await draftRow(id);
    expect(row).toEqual({
      id,
      customer_id: customerId,
      media_id: mediaId,
      owner_id: OWNER,
      rule_type: "fixed_slot",
      status: "draft",
      archived: false,
      start_at: new Date(START),
      end_at: new Date(END),
      revision: 1,
      created_at: at,
      updated_at: at,
    });

    const audits = await auditRows(id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_type: "admin",
      actor_id: ACTOR,
      action: CAMPAIGN_CREATED_ACTION,
      target_type: CAMPAIGN_AUDIT_TARGET_TYPE,
      target_id: id,
    });
    expect(audits[0]?.details).toEqual({
      fields: [...CAMPAIGN_DRAFT_AUDIT_FIELDS],
    });
    // Bereinigt: keine Referenzwerte, keine Laufzeitwerte im Audit.
    const serialized = JSON.stringify(audits[0]?.details);
    expect(serialized).not.toContain(customerId);
    expect(serialized).not.toContain(mediaId);
    expect(serialized).not.toContain(START);
  });

  it("rollt Entwurf und Audit bei Referenz- und Auditfehlern vollstaendig zurueck", async () => {
    const customerId = await insertCustomer();
    const mediaId = await insertMedia("ready");

    // Unbekannter Kunde.
    await expect(
      saveCampaignDraft(baseOptions(randomUUID(), mediaId)),
    ).rejects.toBeInstanceOf(ApiError);
    expect(await stateCounts()).toEqual({ campaigns: 0, audits: 0 });

    // Nicht freigegebenes Medium.
    const stagingId = await insertMedia("staging");
    await expect(
      saveCampaignDraft(baseOptions(customerId, stagingId)),
    ).rejects.toBeInstanceOf(ApiError);
    expect(await stateCounts()).toEqual({ campaigns: 0, audits: 0 });

    // Geloeschtes Medium.
    const deletedId = await insertMedia("ready", true);
    await expect(
      saveCampaignDraft(baseOptions(customerId, deletedId)),
    ).rejects.toBeInstanceOf(ApiError);
    expect(await stateCounts()).toEqual({ campaigns: 0, audits: 0 });

    // Auditfehler nach erfolgreichem Einfuegen muss auch den Entwurf rollen.
    await pool.query(
      [
        "create or replace function cx101_fail_audit() returns trigger",
        "language plpgsql as $$",
        "begin",
        "  raise exception 'CX-101 audit failure';",
        "end;",
        "$$",
      ].join("\n"),
    );
    await pool.query(
      [
        "create trigger cx101_fail_audit",
        "before insert on audit_events",
        "for each row when (new.action = 'campaign.created')",
        "execute function cx101_fail_audit()",
      ].join("\n"),
    );
    try {
      await expect(
        saveCampaignDraft(baseOptions(customerId, mediaId)),
      ).rejects.toThrow(/CX-101 audit failure/);
      expect(await stateCounts()).toEqual({ campaigns: 0, audits: 0 });
    } finally {
      await pool.query("drop trigger if exists cx101_fail_audit on audit_events");
      await pool.query("drop function if exists cx101_fail_audit()");
    }
  });
});
