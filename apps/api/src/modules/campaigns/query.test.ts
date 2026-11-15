/**
 * CX-103 / R-204 (Teil 4): PostgreSQL-Integrationstests der lesenden
 * Kampagnenabfrage.
 *
 * Geprueft werden die Einzelabfrage mit deduplizierten Zielen, die stabile
 * begrenzte Pagination samt Betreiberisolation sowie unbekannte IDs, leere
 * Ziele und geaenderte Gruppenmitgliedschaften. Alle Daten sind synthetisch.
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureTaxiGroupSchema } from "../../http/taxiGroupRoutes.js";
import { ensureTaxiGroupMembershipSchema } from "../taxiGroupMemberships/service.js";
import { queryCampaigns, type CampaignQueryView } from "./query.js";
import { ensureCampaignSchema } from "./schema.js";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);
const OWNER = "cx103-owner";
const OTHER_OWNER = "cx103-other-owner";
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
    throw new Error("CX-103 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

async function insertCustomer(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "insert into customers (id, display_name) values ($1::uuid, $2)",
    [id, "SYN-CX103-Kunde"],
  );
  return id;
}

async function insertCampaign(
  ownerId: string,
  options: { archived?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  const customerId = await insertCustomer();
  await pool.query(
    [
      "insert into campaigns",
      "  (id, customer_id, media_id, owner_id, rule_type, status, archived,",
      "   start_at, end_at, revision)",
      "values ($1::uuid, $2::uuid, $3::uuid, $4, 'fixed_slot', 'draft', $5,",
      "        $6::timestamptz, $7::timestamptz, 1)",
    ].join("\n"),
    [
      id,
      customerId,
      randomUUID(),
      ownerId,
      options.archived ?? false,
      START,
      END,
    ],
  );
  return id;
}

async function insertTaxi(ownerId: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "insert into taxis (id, display_name, active, revision, owner_id) values ($1, $2, false, 1, $3)",
    [id, "SYN-CX103-Taxi", ownerId],
  );
  return id;
}

async function insertGroup(ownerId: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "insert into taxi_groups (id, name, owner_id, revision, created_at) values ($1::uuid, $2, $3, 1, now())",
    [id, "SYN-CX103-Gruppe-" + id, ownerId],
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

async function addMembership(groupId: string, taxiId: string): Promise<void> {
  await pool.query(
    "insert into taxi_group_memberships (group_id, taxi_id) values ($1, $2)",
    [groupId, taxiId],
  );
}

async function requireCampaign(
  campaignId: string,
  ownerId = OWNER,
): Promise<CampaignQueryView> {
  const view = await queryCampaigns({ pool, ownerId, campaignId });
  if (view === null) {
    throw new Error("Kampagne fehlt");
  }
  return view;
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx103_query_" +
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
  await ensureCampaignSchema(pool);
  await ensureTaxiGroupSchema(pool);
  await ensureTaxiGroupMembershipSchema(pool);
}, 60_000);

beforeEach(async () => {
  await pool.query(
    "truncate table campaign_targets, campaigns, customers, audit_events, taxi_group_memberships, taxis, taxi_groups restart identity cascade",
  );
});

afterAll(async () => {
  await pool.end();
  await maintenancePool.query(
    "drop database if exists " + quoteIdentifier(databaseName),
  );
  await maintenancePool.end();
}, 30_000);

describe("CX-103 Kampagnenabfrage", () => {
  it("liefert eine Einzelabfrage mit deduplizierten Zielen", async () => {
    const taxiOne = await insertTaxi(OWNER);
    const taxiTwo = await insertTaxi(OWNER);
    const taxiThree = await insertTaxi(OWNER);
    const foreignTaxi = await insertTaxi(OTHER_OWNER);
    const groupOne = await insertGroup(OWNER);
    const groupTwo = await insertGroup(OWNER);
    const foreignGroup = await insertGroup(OTHER_OWNER);
    await addMembership(groupOne, taxiOne);
    await addMembership(groupOne, taxiThree);
    await addMembership(groupTwo, taxiTwo);
    await addMembership(groupTwo, taxiThree);
    await addMembership(foreignGroup, foreignTaxi);

    const campaignId = await insertCampaign(OWNER);
    await addTarget(campaignId, "taxi", taxiOne);
    await addTarget(campaignId, "taxi", taxiTwo);
    await addTarget(campaignId, "taxi", foreignTaxi);
    await addTarget(campaignId, "group", groupOne);
    await addTarget(campaignId, "group", groupTwo);
    await addTarget(campaignId, "group", foreignGroup);

    const view = await requireCampaign(campaignId);
    expect(view.ruleType).toBe("fixed_slot");
    expect(view.status).toBe("draft");
    expect(view.taxiIds).toEqual(sorted([taxiOne, taxiTwo]));
    expect(view.groupIds).toEqual(sorted([groupOne, groupTwo]));
    expect(view.effectiveTaxiIds).toEqual(
      sorted([taxiOne, taxiTwo, taxiThree]),
    );
    expect(view.effectiveTaxiIds).not.toContain(foreignTaxi);
  });

  it("liefert eine stabile begrenzte Pagination und isoliert Betreiber", async () => {
    const owned = [
      await insertCampaign(OWNER),
      await insertCampaign(OWNER),
      await insertCampaign(OWNER),
    ];
    const foreign = [
      await insertCampaign(OTHER_OWNER),
      await insertCampaign(OTHER_OWNER),
    ];

    const first = await queryCampaigns({
      pool,
      ownerId: OWNER,
      filter: { limit: 2 },
    });
    expect(first.items).toHaveLength(2);
    expect(first.nextAfterId).toBe(first.items[1]?.id ?? null);
    const firstIds = first.items.map((item) => item.id);

    const firstAgain = await queryCampaigns({
      pool,
      ownerId: OWNER,
      filter: { limit: 2 },
    });
    expect(firstAgain.items.map((item) => item.id)).toEqual(firstIds);
    expect(firstAgain.nextAfterId).toBe(first.nextAfterId);

    const second = await queryCampaigns({
      pool,
      ownerId: OWNER,
      filter: { limit: 2, afterId: first.nextAfterId },
    });
    expect(second.items).toHaveLength(1);
    expect(second.nextAfterId).toBeNull();

    const collected = firstIds.concat(second.items.map((item) => item.id));
    expect(sorted(collected)).toEqual(sorted(owned));
    for (const id of foreign) {
      expect(collected).not.toContain(id);
    }

    const foreignList = await queryCampaigns({
      pool,
      ownerId: OTHER_OWNER,
      filter: { limit: 10 },
    });
    expect(sorted(foreignList.items.map((item) => item.id))).toEqual(
      sorted(foreign),
    );

    expect(
      await queryCampaigns({ pool, ownerId: OWNER, campaignId: foreign[0] }),
    ).toBeNull();
    expect(
      await queryCampaigns({ pool, ownerId: OWNER, campaignId: owned[0] }),
    ).not.toBeNull();
  });

  it("behandelt unbekannte IDs, leere Ziele und geaenderte Gruppenmitgliedschaften", async () => {
    expect(
      await queryCampaigns({
        pool,
        ownerId: OWNER,
        campaignId: randomUUID(),
      }),
    ).toBeNull();

    const emptyId = await insertCampaign(OWNER);
    const empty = await requireCampaign(emptyId);
    expect(empty.taxiIds).toEqual([]);
    expect(empty.groupIds).toEqual([]);
    expect(empty.effectiveTaxiIds).toEqual([]);

    const taxiOne = await insertTaxi(OWNER);
    const taxiTwo = await insertTaxi(OWNER);
    const group = await insertGroup(OWNER);
    const campaignId = await insertCampaign(OWNER);
    await addTarget(campaignId, "group", group);
    await addTarget(campaignId, "taxi", "SYN-CX103-unbekannt");
    await addTarget(campaignId, "group", "SYN-CX103-unbekannt");

    const before = await requireCampaign(campaignId);
    expect(before.taxiIds).toEqual([]);
    expect(before.groupIds).toEqual([group]);
    expect(before.effectiveTaxiIds).toEqual([]);

    await addMembership(group, taxiOne);
    expect((await requireCampaign(campaignId)).effectiveTaxiIds).toEqual([
      taxiOne,
    ]);

    await addMembership(group, taxiTwo);
    expect((await requireCampaign(campaignId)).effectiveTaxiIds).toEqual(
      sorted([taxiOne, taxiTwo]),
    );

    await pool.query(
      "delete from taxi_group_memberships where group_id = $1 and taxi_id = $2",
      [group, taxiOne],
    );
    expect((await requireCampaign(campaignId)).effectiveTaxiIds).toEqual([
      taxiTwo,
    ]);
  });
});
