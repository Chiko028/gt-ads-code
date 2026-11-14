/**
 * CX-126 / R-104: drei colocated Vitest-Faelle gegen echtes PostgreSQL.
 *
 * Die synchronisierten Fixtures nutzen die vorhandenen CX-035/CX-124-
 * Strukturen (devices, taxis, device_taxi_assignments) sowie den additiven
 * Verwaltungszustand dieses Moduls. Alle IDs, Tablets und Akteure sind
 * synthetisch; es gibt keinen Netzwerkzugriff.
 */
import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { migrateUp } from "../../db/migrate.js";
import {
  TaxiActivationError,
  TaxiActivationService,
  ensureTaxiActivationSchema,
} from "../taxiActivation/service.js";
import {
  TABLET_ACTIVATION_AUDIT_ACTION,
  TabletActivationError,
  TabletActivationService,
  ensureTabletActivationSchema,
  type SetTabletActiveStateInput,
} from "./service.js";

const FIXED_NOW = new Date("2026-01-01T12:00:00.000Z");
const ACTOR = "SYN-CX126-Admin";
const RACE_APP = "cx126-race";

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";

interface TaxiStateRow {
  active: boolean;
  revision: number;
}

interface TabletStateRow {
  active: boolean;
  revision: number;
}

interface AuditSnapshot {
  action: string;
  actor_id: string | null;
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
    throw new Error("CX-126 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

async function insertDevice(
  state: "active" | "revoked" = "active",
): Promise<string> {
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
      Buffer.from("SYN-CX126-Code-" + registrationCodeId),
      "SYN-CX126",
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
      "values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,",
      "        $12::uuid, $13::uuid, $14, $15)",
    ].join("\n"),
    [
      deviceId,
      "SYN-CX126-Tablet",
      Buffer.from("SYN-CX126-Key-" + deviceId),
      "SYN-CX126-FP-" + deviceId,
      state,
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

async function insertTaxi(
  taxiId: string,
  active = false,
  revision = 1,
): Promise<void> {
  await pool.query(
    "insert into taxis (id, display_name, active, revision) values ($1, $2, $3, $4)",
    [taxiId, "SYN " + taxiId, active, revision],
  );
}

async function insertTabletState(
  deviceId: string,
  active: boolean,
  revision: number,
): Promise<void> {
  await pool.query(
    [
      "insert into tablet_admin_states (device_id, active, revision)",
      "values ($1::uuid, $2, $3)",
    ].join("\n"),
    [deviceId, active, revision],
  );
}

async function assign(
  taxiId: string,
  deviceId: string,
  active = true,
): Promise<void> {
  await pool.query(
    [
      "insert into device_taxi_assignments (device_id, taxi_id, active, updated_at)",
      "values ($1::uuid, $2, $3, $4)",
    ].join("\n"),
    [deviceId, taxiId, active, FIXED_NOW],
  );
}

async function taxiRow(taxiId: string): Promise<TaxiStateRow | null> {
  const result = await pool.query<TaxiStateRow>(
    "select active, revision::int as revision from taxis where id = $1",
    [taxiId],
  );
  return result.rows[0] ?? null;
}

async function tabletRow(deviceId: string): Promise<TabletStateRow | null> {
  const result = await pool.query<TabletStateRow>(
    [
      "select active, revision::int as revision",
      "  from tablet_admin_states where device_id = $1::uuid",
    ].join("\n"),
    [deviceId],
  );
  return result.rows[0] ?? null;
}

async function deviceState(deviceId: string): Promise<string> {
  const result = await pool.query<{ state: string }>(
    "select state from devices where id = $1::uuid",
    [deviceId],
  );
  return result.rows[0]!.state;
}

async function assignmentActive(
  taxiId: string,
  deviceId: string,
): Promise<boolean> {
  const result = await pool.query<{ active: boolean }>(
    [
      "select active from device_taxi_assignments",
      " where device_id = $1::uuid and taxi_id = $2",
    ].join("\n"),
    [deviceId, taxiId],
  );
  return result.rows[0]!.active;
}

async function auditRows(): Promise<AuditSnapshot[]> {
  const result = await pool.query<AuditSnapshot>(
    [
      "select action, actor_id, target_type, target_id, details",
      "  from audit_events order by id asc",
    ].join("\n"),
  );
  return result.rows;
}

async function auditCount(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "select count(*)::text as count from audit_events",
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function activeInvalidPairCount(): Promise<number> {
  const result = await pool.query<{ count: number }>(
    [
      "select count(*)::int as count",
      "  from device_taxi_assignments a",
      "  join tablet_admin_states s on s.device_id = a.device_id",
      " where a.active = true and s.active = false",
    ].join("\n"),
  );
  return result.rows[0]!.count;
}

function newTabletService(): TabletActivationService {
  return new TabletActivationService({ pool, now: () => FIXED_NOW });
}

function newTaxiService(): TaxiActivationService {
  return new TaxiActivationService({ pool, now: () => FIXED_NOW });
}

async function waitForLockWaiters(
  observationClient: Client,
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
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
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Die konkurrierenden Transaktionen warten nicht auf die Taxisperre.");
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx126_activation_" +
    process.pid +
    "_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 8)
  )
    .toLowerCase()
    .slice(0, 63);
  await maintenancePool.query("create database " + quoteIdentifier(databaseName));

  pool = new Pool({
    ...base,
    database: databaseName,
    application_name: RACE_APP,
    max: 4,
  });
  await migrateUp(pool);
  await ensureTaxiActivationSchema(pool);
  await ensureTabletActivationSchema(pool);
}, 60_000);

beforeEach(async () => {
  await pool.query("drop trigger if exists cx126_fail_audit on audit_events");
  await pool.query("drop function if exists cx126_fail_audit() cascade");
  await pool.query(
    [
      "truncate table audit_events, device_taxi_assignments,",
      "  tablet_admin_states, taxis, devices, registration_codes",
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

describe("CX-126 Tablet-Verwaltungszustand", () => {
  it("deaktiviert Tablet und zugeordnetes Taxi samt Revisionen und bereinigtem Audit atomar; das zweite Tablet bleibt unveraendert", async () => {
    const taxiId = "SYN-CX126-PAIR";
    await insertTaxi(taxiId, true, 3);
    const first = await insertDevice();
    const second = await insertDevice();
    await insertTabletState(first, true, 4);
    await insertTabletState(second, true, 6);
    await assign(taxiId, first);
    await assign(taxiId, second);
    const service = newTabletService();

    const result = await service.setActiveState({
      deviceId: first,
      expectedRevision: 4,
      active: false,
      actorId: ACTOR,
    });
    expect(result).toEqual({
      deviceId: first,
      active: false,
      revision: 5,
      changed: true,
      taxi: {
        taxiId,
        active: false,
        revision: 4,
        changed: true,
      },
    });
    expect(await tabletRow(first)).toEqual({ active: false, revision: 5 });
    expect(await tabletRow(second)).toEqual({ active: true, revision: 6 });
    expect(await taxiRow(taxiId)).toEqual({ active: false, revision: 4 });
    expect(await assignmentActive(taxiId, first)).toBe(false);
    expect(await assignmentActive(taxiId, second)).toBe(true);

    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual({
      action: TABLET_ACTIVATION_AUDIT_ACTION,
      actor_id: ACTOR,
      target_type: "tablet",
      target_id: first,
      details: {
        previous_active: true,
        active: false,
        revision: 5,
        taxi_id: taxiId,
        taxi_previous_active: true,
        taxi_active: false,
        taxi_revision: 4,
        assignment_active: false,
      },
    });
  });

  it("reaktiviert ein Tablet ohne Taxi-Aktivierung; eine widerrufene Identitaet bleibt widerrufen und ist nicht reaktivierbar", async () => {
    const taxiId = "SYN-CX126-REACT";
    await insertTaxi(taxiId, true, 1);
    const tablet = await insertDevice();
    await insertTabletState(tablet, true, 2);
    await assign(taxiId, tablet);
    const service = newTabletService();

    await service.setActiveState({
      deviceId: tablet,
      expectedRevision: 2,
      active: false,
      actorId: ACTOR,
    });
    expect(await tabletRow(tablet)).toEqual({ active: false, revision: 3 });
    expect(await taxiRow(taxiId)).toEqual({ active: false, revision: 2 });

    const reactivated = await service.setActiveState({
      deviceId: tablet,
      expectedRevision: 3,
      active: true,
      actorId: ACTOR,
    });
    expect(reactivated).toEqual({
      deviceId: tablet,
      active: true,
      revision: 4,
      changed: true,
      taxi: null,
    });
    expect(await tabletRow(tablet)).toEqual({ active: true, revision: 4 });
    expect(await taxiRow(taxiId)).toEqual({ active: false, revision: 2 });
    expect(await assignmentActive(taxiId, tablet)).toBe(false);

    const audits = await auditRows();
    expect(audits).toHaveLength(2);
    expect(audits[1]).toEqual({
      action: TABLET_ACTIVATION_AUDIT_ACTION,
      actor_id: ACTOR,
      target_type: "tablet",
      target_id: tablet,
      details: { previous_active: false, active: true, revision: 4 },
    });

    const revokedTaxi = "SYN-CX126-REVOKED";
    await insertTaxi(revokedTaxi, true, 1);
    const revoked = await insertDevice("revoked");
    await insertTabletState(revoked, false, 5);
    await assign(revokedTaxi, revoked);

    await expect(
      service.setActiveState({
        deviceId: revoked,
        expectedRevision: 5,
        active: true,
        actorId: ACTOR,
      }),
    ).rejects.toMatchObject({
      name: "TabletActivationError",
      code: "revoked_identity",
    });
    expect(await deviceState(revoked)).toBe("revoked");
    expect(await tabletRow(revoked)).toEqual({ active: false, revision: 5 });
    expect(await taxiRow(revokedTaxi)).toEqual({ active: true, revision: 1 });
    expect(await auditRows()).toHaveLength(2);
  });

  it("laesst bei veralteter Revision, Auditfehler und konkurrierender Paarzuordnung keine aktive unzulaessige Paarung zurueck", async () => {
    const staleTaxi = "SYN-CX126-STALE";
    await insertTaxi(staleTaxi, true, 1);
    const staleTablet = await insertDevice();
    await insertTabletState(staleTablet, true, 1);
    await assign(staleTaxi, staleTablet);
    const service = newTabletService();

    const staleInput: SetTabletActiveStateInput = {
      deviceId: staleTablet,
      expectedRevision: 0,
      active: false,
      actorId: ACTOR,
    };
    await expect(service.setActiveState(staleInput)).rejects.toMatchObject({
      name: "TabletActivationError",
      code: "revision_conflict",
    });
    expect(await tabletRow(staleTablet)).toEqual({ active: true, revision: 1 });
    expect(await taxiRow(staleTaxi)).toEqual({ active: true, revision: 1 });
    expect(await assignmentActive(staleTaxi, staleTablet)).toBe(true);
    expect(await auditCount()).toBe(0);

    await pool.query(
      [
        "create function cx126_fail_audit() returns trigger",
        "language plpgsql as $$",
        "begin",
        "  if new.action = 'tablet.activation.changed' then",
        "    raise exception 'CX-126 synthetic audit failure';",
        "  end if;",
        "  return new;",
        "end;",
        "$$",
      ].join("\n"),
    );
    await pool.query(
      [
        "create trigger cx126_fail_audit",
        "before insert on audit_events",
        "for each row execute function cx126_fail_audit()",
      ].join("\n"),
    );
    await expect(
      service.setActiveState({
        deviceId: staleTablet,
        expectedRevision: 1,
        active: false,
        actorId: ACTOR,
      }),
    ).rejects.toThrow("CX-126 synthetic audit failure");
    expect(await tabletRow(staleTablet)).toEqual({ active: true, revision: 1 });
    expect(await taxiRow(staleTaxi)).toEqual({ active: true, revision: 1 });
    expect(await assignmentActive(staleTaxi, staleTablet)).toBe(true);
    expect(await auditCount()).toBe(0);
    await pool.query("drop trigger cx126_fail_audit on audit_events");
    await pool.query("drop function cx126_fail_audit()");

    const raceTaxi = "SYN-CX126-RACE";
    await insertTaxi(raceTaxi, false, 1);
    const first = await insertDevice();
    const second = await insertDevice();
    await insertTabletState(first, true, 1);
    await insertTabletState(second, true, 1);
    await assign(raceTaxi, first);
    await assign(raceTaxi, second);
    const tabletService = newTabletService();
    const taxiService = newTaxiService();
    const base = baseConnection();
    const holder = new Client({
      ...base,
      database: databaseName,
      application_name: "cx126-holder",
    });
    const observer = new Client({
      ...base,
      database: databaseName,
      application_name: "cx126-observer",
    });
    await holder.connect();
    await observer.connect();

    let activationReason: unknown = null;
    try {
      await holder.query("begin");
      await holder.query("select id from taxis where id = $1 for update", [
        raceTaxi,
      ]);

      const deactivate = tabletService.setActiveState({
        deviceId: first,
        expectedRevision: 1,
        active: false,
        actorId: ACTOR,
      });
      const activatePair = taxiService.setActiveState({
        taxiId: raceTaxi,
        expectedRevision: 1,
        active: true,
        actorId: ACTOR,
      });
      await waitForLockWaiters(observer, 2);
      await holder.query("commit");

      const results = await Promise.allSettled([deactivate, activatePair]);
      expect(results[0].status).toBe("fulfilled");
      if (results[0].status === "fulfilled") {
        expect(results[0].value).toMatchObject({
          deviceId: first,
          active: false,
          revision: 2,
          changed: true,
        });
      }
      if (results[1].status === "rejected") {
        activationReason = results[1].reason;
        expect(activationReason).toBeInstanceOf(TaxiActivationError);
        expect(activationReason).toMatchObject({ code: "invalid_pair" });
      }
    } finally {
      await observer.end();
      await holder.end();
    }

    expect(await tabletRow(first)).toEqual({ active: false, revision: 2 });
    expect(await tabletRow(second)).toEqual({ active: true, revision: 1 });
    expect(await assignmentActive(raceTaxi, first)).toBe(false);
    expect(await assignmentActive(raceTaxi, second)).toBe(true);
    const raceTaxiRow = await taxiRow(raceTaxi);
    expect(raceTaxiRow?.active).toBe(false);
    expect([1, 3]).toContain(raceTaxiRow?.revision);
    expect(await activeInvalidPairCount()).toBe(0);
    const tabletAudits = (await auditRows()).filter(
      (row) => row.action === TABLET_ACTIVATION_AUDIT_ACTION,
    );
    expect(tabletAudits).toHaveLength(1);
  });
});
