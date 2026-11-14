/**
 * CX-118 / R-104: drei colocated Vitest-Faelle gegen echtes PostgreSQL 17.
 *
 * Geprueft werden die vollstaendige Ersetzung mit Deduplizierung, die leere
 * Auswahl, die Nichtoffenlegung unbekannter/fremder Gruppen, der veraltete
 * Taxi-Aenderungsstand, konkurrierende Ersetzungen mit derselben Revision und
 * der vollstaendige Rollback bei einem Auditfehler. Alle Daten sind synthetisch.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { ensureTaxiGroupSchema } from "../../http/taxiGroupRoutes.js";
import { ensureTaxiActivationSchema } from "../taxiActivation/service.js";
import {
  TAXI_GROUP_MEMBERSHIPS_REPLACED_ACTION,
  TaxiGroupMembershipService,
  ensureTaxiGroupMembershipSchema,
} from "./service.js";

const FIXED_NOW = new Date("2026-11-14T12:00:00.000Z");
const OWNER = "SYN-CX118-OWNER";
const OTHER_OWNER = "SYN-CX118-OTHER-OWNER";
const ACTOR = "SYN-CX118-ACTOR";
const migrationsDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";

interface AuditRow {
  action: string;
  actor_id: string | null;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
}

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
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
    throw new Error("CX-118 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

async function insertGroup(ownerId: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    [
      "insert into taxi_groups (id, name, owner_id, revision, created_at)",
      "values ($1::uuid, $2, $3, 1, $4)",
    ].join("\n"),
    [id, "SYN-CX118-" + id.slice(0, 8), ownerId, FIXED_NOW],
  );
  return id;
}

async function insertTaxi(
  taxiId: string,
  ownerId: string,
  revision = 1,
): Promise<void> {
  await pool.query(
    [
      "insert into taxis (id, display_name, active, revision, owner_id)",
      "values ($1, $2, false, $3, $4)",
    ].join("\n"),
    [taxiId, "SYN " + taxiId, revision, ownerId],
  );
}

async function insertDevice(): Promise<string> {
  const registrationCodeId = randomUUID();
  const deviceId = randomUUID();
  await pool.query(
    [
      "insert into registration_codes",
      "  (id, code_hash, label, created_at, created_by, expires_at)",
      "values ($1::uuid, $2, $3, $4, $5, $6)",
    ].join("\n"),
    [
      registrationCodeId,
      Buffer.from("SYN-CX118-Code-" + registrationCodeId),
      "SYN-CX118",
      FIXED_NOW,
      ACTOR,
      new Date(FIXED_NOW.getTime() + 3_600_000),
    ],
  );
  await pool.query(
    [
      "insert into devices",
      "  (id, label, public_key_spki, public_key_fingerprint, state,",
      "   manufacturer, model, os_version, sdk_int, app_version, app_flavor,",
      "   registration_code_id, registration_request_id, registered_at, last_seen_at)",
      "values ($1::uuid, $2, $3, $4, 'active', $5, $6, $7, $8, $9, $10,",
      "        $11::uuid, $12::uuid, $13, $14)",
    ].join("\n"),
    [
      deviceId,
      "SYN-CX118-Tablet",
      Buffer.from("SYN-CX118-Key-" + deviceId),
      "SYN-CX118-FP-" + deviceId,
      "SYN-Hersteller",
      "SYN-Modell",
      "SYN-Android",
      34,
      "0.0.0-syn",
      "syn",
      registrationCodeId,
      randomUUID(),
      FIXED_NOW,
      FIXED_NOW,
    ],
  );
  return deviceId;
}

async function assignDevice(taxiId: string, deviceId: string): Promise<void> {
  await pool.query(
    [
      "insert into device_taxi_assignments (device_id, taxi_id, active, updated_at)",
      "values ($1::uuid, $2, true, $3)",
    ].join("\n"),
    [deviceId, taxiId, FIXED_NOW],
  );
}

async function insertMembership(groupId: string, taxiId: string): Promise<void> {
  await pool.query(
    "insert into taxi_group_memberships (group_id, taxi_id) values ($1, $2)",
    [groupId, taxiId],
  );
}

async function membershipIds(taxiId: string): Promise<string[]> {
  const result = await pool.query<{ group_id: string }>(
    [
      "select group_id",
      "  from taxi_group_memberships",
      " where taxi_id = $1",
      " order by group_id asc",
    ].join("\n"),
    [taxiId],
  );
  return result.rows.map((row) => row.group_id);
}

async function taxiRow(taxiId: string): Promise<{
  revision: number;
  owner_id: string;
} | null> {
  const result = await pool.query<{ revision: number; owner_id: string }>(
    "select revision::int as revision, owner_id from taxis where id = $1",
    [taxiId],
  );
  return result.rows[0] ?? null;
}

async function assignmentCount(taxiId: string, deviceId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    [
      "select count(*)::text as count",
      "  from device_taxi_assignments",
      " where taxi_id = $1 and device_id = $2::uuid",
    ].join("\n"),
    [taxiId, deviceId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function auditFor(taxiId: string): Promise<AuditRow[]> {
  const result = await pool.query<AuditRow>(
    [
      "select action, actor_id, target_type, target_id, details",
      "  from audit_events",
      " where target_id = $1",
      " order by id asc",
    ].join("\n"),
    [taxiId],
  );
  return result.rows;
}

function newService(): TaxiGroupMembershipService {
  return new TaxiGroupMembershipService({ pool, now: () => FIXED_NOW });
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx118_memberships_" +
    process.pid +
    "_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 8)
  )
    .toLowerCase()
    .slice(0, 63);
  await maintenancePool.query("create database " + quoteIdentifier(databaseName));

  pool = new Pool({ ...base, database: databaseName, max: 4 });
  await migrateUp(pool);
  await ensureTaxiActivationSchema(pool);
  await ensureTaxiGroupSchema(pool);
  const membershipMigration = await readFile(
    join(migrationsDirectory, "0010_cx_041_manifest_refresh.up.sql"),
    "utf8",
  );
  await pool.query(membershipMigration);
  await ensureTaxiGroupMembershipSchema(pool);
}, 60_000);

beforeEach(async () => {
  await pool.query("drop trigger if exists cx118_fail_audit on audit_events");
  await pool.query("drop function if exists cx118_fail_audit() cascade");
  await pool.query(
    [
      "truncate table audit_events, taxi_group_memberships,",
      "  taxi_manifest_state, taxi_manifest_artifacts, taxi_groups,",
      "  device_taxi_assignments, taxis, devices, registration_codes",
      "restart identity cascade",
    ].join("\n"),
  );
});

afterAll(async () => {
  await pool.end();
  await maintenancePool.query(
    "drop database if exists " + quoteIdentifier(databaseName),
  );
  await maintenancePool.end();
}, 30_000);

describe("CX-118 Gruppenzuordnung eines Taxis", () => {
  it("ersetzt deduplizierte Gruppen vollstaendig und entfernt mit leerer Auswahl alle Mitgliedschaften", async () => {
    const taxiId = "SYN-CX118-TAXI";
    const first = await insertGroup(OWNER);
    const second = await insertGroup(OWNER);
    const third = await insertGroup(OWNER);
    await insertTaxi(taxiId, OWNER);
    await insertMembership(first, taxiId);
    await insertMembership(second, taxiId);
    const deviceId = await insertDevice();
    await assignDevice(taxiId, deviceId);
    const service = newService();

    const replaced = await service.replaceTaxiGroupMemberships({
      ownerId: OWNER,
      actorId: ACTOR,
      taxiId,
      expectedRevision: 1,
      groupIds: [third, first, third, first],
    });
    expect(replaced).toEqual({
      taxiId,
      previousGroupIds: sorted([first, second]),
      groupIds: sorted([first, third]),
      revision: 2,
      changed: true,
    });
    expect(await membershipIds(taxiId)).toEqual(sorted([first, third]));
    expect(await taxiRow(taxiId)).toEqual({ revision: 2, owner_id: OWNER });

    const firstAudits = await auditFor(taxiId);
    expect(firstAudits).toHaveLength(1);
    expect(firstAudits[0]).toMatchObject({
      action: TAXI_GROUP_MEMBERSHIPS_REPLACED_ACTION,
      actor_id: ACTOR,
      target_type: "taxi",
      target_id: taxiId,
      details: {
        added: [third],
        removed: [second],
        revision: 2,
      },
    });

    const unchanged = await service.replaceTaxiGroupMemberships({
      ownerId: OWNER,
      actorId: ACTOR,
      taxiId,
      expectedRevision: 2,
      groupIds: [first, third],
    });
    expect(unchanged).toEqual({
      taxiId,
      previousGroupIds: sorted([first, third]),
      groupIds: sorted([first, third]),
      revision: 2,
      changed: false,
    });
    expect(await auditFor(taxiId)).toHaveLength(1);

    const emptied = await service.replaceTaxiGroupMemberships({
      ownerId: OWNER,
      actorId: ACTOR,
      taxiId,
      expectedRevision: 2,
      groupIds: [],
    });
    expect(emptied).toEqual({
      taxiId,
      previousGroupIds: sorted([first, third]),
      groupIds: [],
      revision: 3,
      changed: true,
    });
    expect(await membershipIds(taxiId)).toEqual([]);
    expect(await taxiRow(taxiId)).toEqual({ revision: 3, owner_id: OWNER });
    expect(await assignmentCount(taxiId, deviceId)).toBe(1);

    const audits = await auditFor(taxiId);
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({
      details: {
        added: [],
        removed: sorted([first, third]),
        revision: 3,
      },
    });
  });

  it("laesst bei unbekannter oder fremder Gruppe und veraltetem Stand alles unveraendert", async () => {
    const taxiId = "SYN-CX118-GUARD";
    const ownGroup = await insertGroup(OWNER);
    const foreignGroup = await insertGroup(OTHER_OWNER);
    const unknownGroup = randomUUID();
    await insertTaxi(taxiId, OWNER);
    await insertMembership(ownGroup, taxiId);
    const service = newService();

    const cases = [
      { name: "unbekannte Gruppe", groupIds: [ownGroup, unknownGroup], expectedRevision: 1, code: "not_found" },
      { name: "fremde Gruppe", groupIds: [ownGroup, foreignGroup], expectedRevision: 1, code: "not_found" },
      { name: "veralteter Stand", groupIds: [ownGroup], expectedRevision: 0, code: "revision_conflict" },
    ] as const;

    for (const current of cases) {
      await expect(
        service.replaceTaxiGroupMemberships({
          ownerId: OWNER,
          actorId: ACTOR,
          taxiId,
          expectedRevision: current.expectedRevision,
          groupIds: current.groupIds,
        }),
      ).rejects.toMatchObject({
        name: "TaxiGroupMembershipError",
        code: current.code,
      });
      expect(await membershipIds(taxiId), current.name).toEqual([ownGroup]);
      expect(await taxiRow(taxiId), current.name).toEqual({
        revision: 1,
        owner_id: OWNER,
      });
      expect(await auditFor(taxiId), current.name).toHaveLength(0);
    }
  });

  it("erzeugt bei konkurrierenden Ersetzungen genau einen Erfolg und rollt Auditfehler vollstaendig zurueck", async () => {
    const taxiId = "SYN-CX118-RACE";
    const first = await insertGroup(OWNER);
    const second = await insertGroup(OWNER);
    await insertTaxi(taxiId, OWNER);
    await insertMembership(first, taxiId);
    const service = newService();

    const results = await Promise.allSettled([
      service.replaceTaxiGroupMemberships({
        ownerId: OWNER,
        actorId: ACTOR,
        taxiId,
        expectedRevision: 1,
        groupIds: [second],
      }),
      service.replaceTaxiGroupMemberships({
        ownerId: OWNER,
        actorId: ACTOR,
        taxiId,
        expectedRevision: 1,
        groupIds: [first, second],
      }),
    ]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.replaceTaxiGroupMemberships>>> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({
      name: "TaxiGroupMembershipError",
      code: "revision_conflict",
    });
    const winner = fulfilled[0].value;
    expect(await membershipIds(taxiId)).toEqual(winner.groupIds);
    expect(await taxiRow(taxiId)).toEqual({ revision: 2, owner_id: OWNER });
    const raceAudits = await auditFor(taxiId);
    expect(raceAudits).toHaveLength(1);
    expect(raceAudits[0]).toMatchObject({
      action: TAXI_GROUP_MEMBERSHIPS_REPLACED_ACTION,
      details: {
        added: winner.groupIds.filter((id) => !winner.previousGroupIds.includes(id)),
        removed: winner.previousGroupIds.filter((id) => !winner.groupIds.includes(id)),
        revision: 2,
      },
    });

    const auditTaxi = "SYN-CX118-AUDIT";
    await insertTaxi(auditTaxi, OWNER);
    await insertMembership(first, auditTaxi);
    await pool.query(
      [
        "create function cx118_fail_audit() returns trigger",
        "language plpgsql as $$",
        "begin",
        "  if new.action = 'taxi.group_memberships_replaced' then",
        "    raise exception 'CX-118 synthetic audit failure';",
        "  end if;",
        "  return new;",
        "end;",
        "$$",
      ].join("\n"),
    );
    await pool.query(
      [
        "create trigger cx118_fail_audit",
        "before insert on audit_events",
        "for each row execute function cx118_fail_audit()",
      ].join("\n"),
    );
    try {
      await expect(
        service.replaceTaxiGroupMemberships({
          ownerId: OWNER,
          actorId: ACTOR,
          taxiId: auditTaxi,
          expectedRevision: 1,
          groupIds: [second],
        }),
      ).rejects.toThrow("CX-118 synthetic audit failure");
    } finally {
      await pool.query("drop trigger if exists cx118_fail_audit on audit_events");
      await pool.query("drop function if exists cx118_fail_audit() cascade");
    }

    expect(await membershipIds(auditTaxi)).toEqual([first]);
    expect(await taxiRow(auditTaxi)).toEqual({ revision: 1, owner_id: OWNER });
    expect(await auditFor(auditTaxi)).toHaveLength(0);
  });
});

