import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../../http/errors.js";
import { ensureTaxiGroupSchema } from "../../http/taxiGroupRoutes.js";
import { ensureTaxiGroupMembershipSchema } from "../taxiGroupMemberships/service.js";
import { CampaignService } from "./campaigns.js";
import { transitionCampaign } from "./transition.js";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);
const OWNER = "cx105-operator";
const OTHER_OWNER = "cx105-other-operator";
const ACTOR = "cx105-actor";
const START = "2026-12-01T08:00:00.000Z";
const END = "2026-12-01T18:00:00.000Z";

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";

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
    throw new Error("CX-105 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

async function insertCustomer(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "insert into customers (id, display_name) values ($1::uuid, $2)",
    [id, "SYN-CX105-Kunde"],
  );
  return id;
}

async function insertMedia(
  status: "ready" | "staging" = "ready",
  deleted = false,
): Promise<string> {
  const id = randomUUID();
  if (status === "ready") {
    await pool.query(
      "insert into media_objects (id, display_name, size_bytes, sha256, container, video_codec, width, height, frame_rate_numerator, frame_rate_denominator, audio_stream_count, duration_seconds, created_at, status, ready_at) values ($1::uuid, $2, 1024, $3, 'mp4', 'h264', 1080, 1920, 30, 1, 1, 12.5, now(), 'ready', now())",
      [id, "SYN-CX105-Medium", "a".repeat(64)],
    );
  } else {
    await pool.query(
      "insert into media_objects (id, display_name, created_at, status) values ($1::uuid, $2, now(), 'staging')",
      [id, "SYN-CX105-Staging"],
    );
  }
  if (deleted) {
    await pool.query(
      "update media_objects set deleted_at = now() where id = $1::uuid",
      [id],
    );
  }
  return id;
}

async function insertCampaign(
  status: "draft" | "active" | "paused" | "finished",
  options: {
    mediaId?: string;
    archived?: boolean;
    startAt?: string;
    endAt?: string;
  } = {},
): Promise<string> {
  const id = randomUUID();
  const customerId = await insertCustomer();
  const mediaId = options.mediaId ?? (await insertMedia("ready"));
  await pool.query(
    "insert into campaigns (id, customer_id, media_id, owner_id, rule_type, status, archived, start_at, end_at, revision) values ($1::uuid, $2::uuid, $3::uuid, $4, 'fixed_slot', $5, $6, $7::timestamptz, $8::timestamptz, 1)",
    [
      id,
      customerId,
      mediaId,
      OWNER,
      status,
      options.archived ?? false,
      options.startAt ?? START,
      options.endAt ?? END,
    ],
  );
  return id;
}

async function addTarget(
  campaignId: string,
  kind: "taxi" | "group",
  targetId: string,
): Promise<void> {
  await pool.query(
    "insert into campaign_targets (campaign_id, kind, target_id) values ($1::uuid, $2, $3)",
    [campaignId, kind, targetId],
  );
}

async function insertTaxi(ownerId = OWNER, active = true): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "insert into taxis (id, display_name, active, revision, owner_id) values ($1, $2, $3, 1, $4)",
    [id, "SYN-CX105-Taxi", active, ownerId],
  );
  return id;
}

async function insertGroup(ownerId = OWNER): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "insert into taxi_groups (id, name, owner_id, revision, created_at) values ($1::uuid, $2, $3, 1, now())",
    [id, "SYN-CX105-Gruppe-" + id, ownerId],
  );
  return id;
}

async function addMembership(groupId: string, taxiId: string): Promise<void> {
  await pool.query(
    "insert into taxi_group_memberships (group_id, taxi_id) values ($1, $2)",
    [groupId, taxiId],
  );
}

async function waitForLockWaiters(
  observationClient: Client,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await observationClient.query<{ count: string }>(
      [
        "select count(*)::text as count",
        "  from pg_stat_activity",
        " where datname = current_database()",
        "   and pid <> pg_backend_pid()",
        "   and wait_event_type = 'Lock'",
      ].join("\n"),
      [],
    );
    if (Number(result.rows[0]?.count ?? "0") >= expected) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    "Die Aktivierung wartet nicht auf die Mitgliedschaftssperre.",
  );
}

async function campaignState(id: string): Promise<{
  status: string;
  archived: boolean;
  revision: number;
}> {
  const result = await pool.query<{
    status: string;
    archived: boolean;
    revision: number;
  }>(
    "select status, archived, revision from campaigns where id = $1::uuid",
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Kampagne fehlt");
  }
  return row;
}

async function transitionAudits(id: string): Promise<
  Array<{ actor_id: string | null; details: Record<string, unknown> }>
> {
  const result = await pool.query<{
    actor_id: string | null;
    details: Record<string, unknown>;
  }>(
    "select actor_id, details from audit_events where action = 'campaign.transitioned' and target_id = $1 order by id asc",
    [id],
  );
  return result.rows;
}

function runTransition(
  campaignId: string,
  expectedRevision: number,
  action: "activate" | "pause" | "finish" | "archive",
) {
  return transitionCampaign({
    pool,
    ownerId: OWNER,
    actorId: ACTOR,
    campaignId,
    expectedRevision,
    action,
  });
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx105_transition_" +
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
  await new CampaignService({ pool }).ensureSchema();
  await ensureTaxiGroupSchema(pool);
  await ensureTaxiGroupMembershipSchema(pool);
}, 60_000);

beforeEach(async () => {
  await pool.query(
    "truncate table campaign_targets, campaigns, media_objects, audit_events, taxi_group_memberships, taxis, taxi_groups, taxi_manifest_state, customers restart identity cascade",
  );
});

afterAll(async () => {
  await pool.end();
  await maintenancePool.query(
    "drop database if exists " + quoteIdentifier(databaseName),
  );
  await maintenancePool.end();
}, 30_000);

describe("CX-105 Kampagnenlebenszyklus", () => {
  it("erlaubt genau die parametrisierte Uebergangsmatrix und behandelt gleiche Zustaende als No-op", async () => {
    const matrix: Array<{
      from: "draft" | "active" | "paused" | "finished";
      action: "activate" | "pause" | "finish";
      outcome: "changed" | "noop" | "invalid";
      to: string;
    }> = [
      { from: "draft", action: "activate", outcome: "changed", to: "active" },
      { from: "draft", action: "pause", outcome: "invalid", to: "draft" },
      { from: "draft", action: "finish", outcome: "changed", to: "finished" },
      { from: "active", action: "activate", outcome: "noop", to: "active" },
      { from: "active", action: "pause", outcome: "changed", to: "paused" },
      { from: "active", action: "finish", outcome: "changed", to: "finished" },
      { from: "paused", action: "activate", outcome: "changed", to: "active" },
      { from: "paused", action: "pause", outcome: "noop", to: "paused" },
      { from: "paused", action: "finish", outcome: "changed", to: "finished" },
      { from: "finished", action: "activate", outcome: "invalid", to: "finished" },
      { from: "finished", action: "pause", outcome: "invalid", to: "finished" },
      { from: "finished", action: "finish", outcome: "noop", to: "finished" },
    ];

    for (const entry of matrix) {
      const id = await insertCampaign(entry.from);
      const taxiId = await insertTaxi();
      await addTarget(id, "taxi", taxiId);
      if (entry.outcome === "invalid") {
        await expect(runTransition(id, 1, entry.action)).rejects.toBeInstanceOf(
          ApiError,
        );
        expect(await campaignState(id)).toEqual({
          status: entry.from,
          archived: false,
          revision: 1,
        });
        expect(await transitionAudits(id)).toHaveLength(0);
        continue;
      }
      const result = await runTransition(id, 1, entry.action);
      expect(result.status).toBe(entry.to);
      expect(result.revision).toBe(entry.outcome === "changed" ? 2 : 1);
      expect(result.changed).toBe(entry.outcome === "changed");
      expect(await campaignState(id)).toEqual({
        status: entry.to,
        archived: false,
        revision: entry.outcome === "changed" ? 2 : 1,
      });
      const audits = await transitionAudits(id);
      if (entry.outcome === "changed") {
        expect(audits).toHaveLength(1);
        expect(audits[0]?.actor_id).toBe(ACTOR);
        expect(audits[0]?.details).toEqual({
          action: entry.action,
          from_status: entry.from,
          to_status: entry.to,
          archived: false,
        });
      } else {
        expect(audits).toHaveLength(0);
      }
    }
  });

  it("verlangt beim Aktivieren Laufzeit, verfuegbares Medium und effektives Taxiziel und archiviert nur Entwurf/Beendet", async () => {
    // Ungueltige gespeicherte Laufzeit (simulierte Altdaten).
    await pool.query("alter table campaigns drop constraint campaigns_runtime_order");
    try {
      const badRuntime = await insertCampaign("draft", {
        startAt: END,
        endAt: START,
      });
      const runtimeTaxi = await insertTaxi();
      await addTarget(badRuntime, "taxi", runtimeTaxi);
      await expect(runTransition(badRuntime, 1, "activate")).rejects.toBeInstanceOf(
        ApiError,
      );
      expect(await campaignState(badRuntime)).toEqual({
        status: "draft",
        archived: false,
        revision: 1,
      });
      await pool.query("delete from campaigns where id = $1::uuid", [badRuntime]);
    } finally {
      await pool.query(
        "alter table campaigns add constraint campaigns_runtime_order check (end_at > start_at)",
      );
    }

    const deletedMedia = await insertMedia("ready", true);
    const deletedCampaign = await insertCampaign("draft", {
      mediaId: deletedMedia,
    });
    const deletedTaxi = await insertTaxi();
    await addTarget(deletedCampaign, "taxi", deletedTaxi);
    await expect(
      runTransition(deletedCampaign, 1, "activate"),
    ).rejects.toBeInstanceOf(ApiError);
    expect((await campaignState(deletedCampaign)).status).toBe("draft");

    const stagingMedia = await insertMedia("staging");
    const stagingCampaign = await insertCampaign("draft", {
      mediaId: stagingMedia,
    });
    const stagingTaxi = await insertTaxi();
    await addTarget(stagingCampaign, "taxi", stagingTaxi);
    await expect(
      runTransition(stagingCampaign, 1, "activate"),
    ).rejects.toBeInstanceOf(ApiError);

    const emptyGroup = await insertCampaign("draft");
    const emptyGroupId = await insertGroup();
    await addTarget(emptyGroup, "group", emptyGroupId);
    await expect(runTransition(emptyGroup, 1, "activate")).rejects.toBeInstanceOf(
      ApiError,
    );
    const emptyGroupTaxi = await insertTaxi();
    await addMembership(emptyGroupId, emptyGroupTaxi);
    const activated = await runTransition(emptyGroup, 1, "activate");
    expect(activated.status).toBe("active");
    expect(activated.changed).toBe(true);
    expect(await transitionAudits(emptyGroup)).toHaveLength(1);

    const paused = await insertCampaign("paused");
    await expect(runTransition(paused, 1, "archive")).rejects.toBeInstanceOf(
      ApiError,
    );
    const active = await insertCampaign("active");
    await expect(runTransition(active, 1, "archive")).rejects.toBeInstanceOf(
      ApiError,
    );

    const toArchive = await insertCampaign("draft");
    const archiveTaxi = await insertTaxi();
    await addTarget(toArchive, "taxi", archiveTaxi);
    expect((await runTransition(toArchive, 1, "finish")).status).toBe("finished");
    const archived = await runTransition(toArchive, 2, "archive");
    expect(archived).toMatchObject({
      status: "finished",
      archived: true,
      revision: 3,
      changed: true,
    });
    await expect(
      runTransition(toArchive, 3, "activate"),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(runTransition(toArchive, 3, "finish")).rejects.toBeInstanceOf(
      ApiError,
    );
    const repeated = await runTransition(toArchive, 3, "archive");
    expect(repeated).toMatchObject({
      status: "finished",
      archived: true,
      revision: 3,
      changed: false,
    });
    expect(await transitionAudits(toArchive)).toHaveLength(2);
  });

  it("verlangt fuer direkte und gruppenbezogene Ziele ein existierendes, betreibereigenes Taxi", async () => {
    const unknown = await insertCampaign("draft");
    await addTarget(unknown, "taxi", "SYN-CX105-unbekannt");
    await expect(runTransition(unknown, 1, "activate")).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(await campaignState(unknown)).toEqual({
      status: "draft",
      archived: false,
      revision: 1,
    });
    expect(await transitionAudits(unknown)).toHaveLength(0);

    const inactiveTaxi = await insertTaxi(OWNER, false);
    const inactiveDirect = await insertCampaign("draft");
    await addTarget(inactiveDirect, "taxi", inactiveTaxi);
    await expect(
      runTransition(inactiveDirect, 1, "activate"),
    ).rejects.toBeInstanceOf(ApiError);
    expect((await campaignState(inactiveDirect)).status).toBe("draft");

    const foreignTaxi = await insertTaxi(OTHER_OWNER);
    const foreignDirect = await insertCampaign("draft");
    await addTarget(foreignDirect, "taxi", foreignTaxi);
    await expect(
      runTransition(foreignDirect, 1, "activate"),
    ).rejects.toBeInstanceOf(ApiError);
    expect((await campaignState(foreignDirect)).status).toBe("draft");

    const foreignGroup = await insertGroup(OTHER_OWNER);
    await addMembership(foreignGroup, await insertTaxi(OWNER));
    const foreignGroupCampaign = await insertCampaign("draft");
    await addTarget(foreignGroupCampaign, "group", foreignGroup);
    await expect(
      runTransition(foreignGroupCampaign, 1, "activate"),
    ).rejects.toBeInstanceOf(ApiError);
    expect((await campaignState(foreignGroupCampaign)).status).toBe("draft");

    const group = await insertGroup();
    const groupCampaign = await insertCampaign("draft");
    await addTarget(groupCampaign, "group", group);
    await addMembership(group, "SYN-CX105-unbekannt");
    await addMembership(group, await insertTaxi(OTHER_OWNER));
    await addMembership(group, await insertTaxi(OWNER, false));
    await expect(
      runTransition(groupCampaign, 1, "activate"),
    ).rejects.toBeInstanceOf(ApiError);
    expect((await campaignState(groupCampaign)).status).toBe("draft");
    expect(await transitionAudits(groupCampaign)).toHaveLength(0);
  });

  it("serialisiert konkurrierende Aktionen, laesst gleiche Zustaende ohne Doppelwirkung und rollt Auditfehler vollstaendig zurueck", async () => {
    const id = await insertCampaign("draft");
    const taxiId = await insertTaxi();
    await addTarget(id, "taxi", taxiId);

    const results = await Promise.allSettled([
      runTransition(id, 1, "activate"),
      runTransition(id, 1, "activate"),
    ]);
    const fulfilled = results.filter(
      (entry) => entry.status === "fulfilled",
    );
    const rejected = results.filter((entry) => entry.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ApiError);
    expect(await campaignState(id)).toEqual({
      status: "active",
      archived: false,
      revision: 2,
    });
    expect(await transitionAudits(id)).toHaveLength(1);

    const noop = await runTransition(id, 2, "activate");
    expect(noop).toMatchObject({
      status: "active",
      revision: 2,
      changed: false,
    });
    expect(await transitionAudits(id)).toHaveLength(1);

    await expect(runTransition(id, 1, "activate")).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(await campaignState(id)).toEqual({
      status: "active",
      archived: false,
      revision: 2,
    });

    try {
      await pool.query(
        "create or replace function cx105_fail_transition_audit() returns trigger language plpgsql as $$ begin raise exception 'SYN-CX105-AUDIT-GEHEIM'; return new; end $$",
      );
      await pool.query(
        "create trigger cx105_fail_transition_audit before insert on audit_events for each row execute function cx105_fail_transition_audit()",
      );
      await expect(runTransition(id, 2, "pause")).rejects.toThrow();
      expect(await campaignState(id)).toEqual({
        status: "active",
        archived: false,
        revision: 2,
      });
      expect(await transitionAudits(id)).toHaveLength(1);
    } finally {
      await pool.query(
        "drop trigger if exists cx105_fail_transition_audit on audit_events",
      );
      await pool.query(
        "drop function if exists cx105_fail_transition_audit()",
      );
    }

    const paused = await runTransition(id, 2, "pause");
    expect(paused).toMatchObject({
      status: "paused",
      revision: 3,
      changed: true,
    });
    expect(await transitionAudits(id)).toHaveLength(2);
    const pausedNoop = await runTransition(id, 3, "pause");
    expect(pausedNoop.changed).toBe(false);
    expect(await transitionAudits(id)).toHaveLength(2);
  });

  it("verhindert die Aktivierung, wenn das letzte effektive Gruppenziel konkurrierend entfernt wird", async () => {
    const groupId = await insertGroup();
    const taxiId = await insertTaxi();
    await addMembership(groupId, taxiId);
    const campaignId = await insertCampaign("draft");
    await addTarget(campaignId, "group", groupId);

    const base = baseConnection();
    const remover = new Client({
      ...base,
      database: databaseName,
      application_name: "cx105-remover",
    });
    const observer = new Client({
      ...base,
      database: databaseName,
      application_name: "cx105-observer",
    });
    await remover.connect();
    await observer.connect();

    try {
      await remover.query("begin");
      await remover.query(
        "delete from taxi_group_memberships where group_id = $1 and taxi_id = $2",
        [groupId, taxiId],
      );

      const activation = runTransition(campaignId, 1, "activate");
      await waitForLockWaiters(observer, 1);
      await remover.query("commit");
      await expect(activation).rejects.toBeInstanceOf(ApiError);
    } finally {
      await observer.end();
      await remover.end();
    }

    expect(await campaignState(campaignId)).toEqual({
      status: "draft",
      archived: false,
      revision: 1,
    });
    expect(await transitionAudits(campaignId)).toHaveLength(0);
  });
});
