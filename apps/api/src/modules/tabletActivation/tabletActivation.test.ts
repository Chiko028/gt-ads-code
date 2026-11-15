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
import { ensureTaxiActivationSchema } from "../taxiActivation/service.js";
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

/**
 * Abbild des bestehenden Paarzuordnungsdienstes auf der vorhandenen
 * CX-035-Struktur: Eine Paarzuordnung sperrt die beiden Tablet-Zeilen,
 * prueft den administrativen Aktivzustand und ersetzt danach die aktiven
 * Zuordnungen. Die CX-035-HTTP-Route fehlt im Integrationsstand; der Test
 * fuehrt deshalb genau diese Transaktion konkurrierend aus.
 */
class PairAssignmentError extends Error {
  readonly code = "invalid_assignment";

  constructor(message: string) {
    super(message);
    this.name = "PairAssignmentError";
  }
}

interface PairAssignmentController {
  /** Ergebnis der Transaktion; genau einmal auszuwerten. */
  result: Promise<void>;
  /** Loest das Gate aus (vor oder nach dem Schreiben, je nach Modus). */
  release(): void;
  /** Erfuellt sich, sobald die Zuordnungen geschrieben sind. */
  written: Promise<void>;
}

function startPairAssignment(
  taxiId: string,
  deviceIds: readonly [string, string],
  mode: "write-then-wait" | "wait-then-write",
): PairAssignmentController {
  const base = baseConnection();
  const client = new Client({
    ...base,
    database: databaseName,
    application_name: "cx126-pair-assignment",
  });
  let releaseGate: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let markWritten: () => void = () => undefined;
  const written = new Promise<void>((resolve) => {
    markWritten = resolve;
  });

  const result = (async () => {
    await client.connect();
    try {
      await client.query("begin");
      if (mode === "wait-then-write") await gate;

      const devices = await client.query<{ id: string; state: string }>(
        "select id::text as id, state from devices" +
          " where id = any($1::uuid[]) order by id asc for update",
        [deviceIds],
      );
      if (devices.rows.length !== deviceIds.length ||
          devices.rows.some((row) => row.state !== "active")) {
        throw new PairAssignmentError(
          "Eine Paarzuordnung verlangt zwei aktive Tablets.",
        );
      }

      const states = await client.query<{ device_id: string; active: boolean }>(
        "select device_id::text as device_id, active from tablet_admin_states" +
          " where device_id = any($1::uuid[])",
        [deviceIds],
      );
      const inactive = new Set(
        states.rows.filter((row) => !row.active).map((row) => row.device_id),
      );
      if (deviceIds.some((deviceId) => inactive.has(deviceId))) {
        throw new PairAssignmentError(
          "Ein administrativ deaktiviertes Tablet ist nicht paarzuordenbar.",
        );
      }

      await client.query(
        "update device_taxi_assignments set active = false, updated_at = $2" +
          " where device_id = any($1::uuid[]) and active = true",
        [deviceIds, FIXED_NOW],
      );
      await client.query(
        "insert into device_taxi_assignments" +
          " (device_id, taxi_id, active, updated_at)" +
          " values ($1::uuid, $3, true, $4), ($2::uuid, $3, true, $4)" +
          " on conflict (device_id, taxi_id) do update" +
          " set active = true, updated_at = excluded.updated_at",
        [deviceIds[0], deviceIds[1], taxiId, FIXED_NOW],
      );
      markWritten();
      if (mode === "write-then-wait") await gate;
      await client.query("commit");
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // Der urspruengliche Fehler bleibt massgeblich.
      }
      markWritten();
      throw error;
    } finally {
      await client.end();
    }
  })();

  return { result, release: () => releaseGate(), written };
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
  throw new Error("Die konkurrierenden Transaktionen warten nicht auf die erwarteten Sperren.");
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

  it("meldet fuer eine widerrufene Identitaet mit veralteter Revision den Revisionskonflikt", async () => {
    const taxiId = "SYN-CX126-REVOKED-STALE";
    await insertTaxi(taxiId, true, 1);
    const revoked = await insertDevice("revoked");
    await insertTabletState(revoked, false, 5);
    await assign(taxiId, revoked);

    const service = newTabletService();
    await expect(
      service.setActiveState({
        deviceId: revoked,
        expectedRevision: 4,
        active: true,
        actorId: ACTOR,
      }),
    ).rejects.toMatchObject({
      name: "TabletActivationError",
      code: "revision_conflict",
    });
    expect(await deviceState(revoked)).toBe("revoked");
    expect(await tabletRow(revoked)).toEqual({ active: false, revision: 5 });
    expect(await taxiRow(taxiId)).toEqual({ active: true, revision: 1 });
    expect(await assignmentActive(taxiId, revoked)).toBe(true);
    expect(await auditCount()).toBe(0);
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
    const oldTaxi = "SYN-CX126-OLD";
    await insertTaxi(raceTaxi, false, 1);
    await insertTaxi(oldTaxi, false, 1);
    const first = await insertDevice();
    const second = await insertDevice();
    await insertTabletState(first, true, 1);
    await insertTabletState(second, true, 1);
    await assign(oldTaxi, first);
    const base = baseConnection();
    const observer = new Client({
      ...base,
      database: databaseName,
      application_name: "cx126-observer",
    });
    await observer.connect();

    // Reihenfolge 1: Die Paarzuordnung schreibt zuerst und haelt die
    // Tablet-Sperren, bis die Deaktivierung wartet; erst dann committet sie.
    try {
      const pairFirst = startPairAssignment(
        raceTaxi,
        [first, second],
        "write-then-wait",
      );
      await pairFirst.written;
      const deactivateAfterPair = newTabletService()
        .setActiveState({
          deviceId: first,
          expectedRevision: 1,
          active: false,
          actorId: ACTOR,
        })
        .then(
          () => ({ status: "fulfilled" as const }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        );
      await waitForLockWaiters(observer, 1);
      pairFirst.release();
      await expect(pairFirst.result).resolves.toBeUndefined();
      const deactivationOutcome = await deactivateAfterPair;
      expect(deactivationOutcome.status).toBe("rejected");
      if (deactivationOutcome.status === "rejected") {
        expect(deactivationOutcome.error).toMatchObject({
          name: "TabletActivationError",
          code: "invalid_assignment",
        });
      }
    } finally {
      await observer.end();
    }

    expect(await tabletRow(first)).toEqual({ active: true, revision: 1 });
    expect(await assignmentActive(raceTaxi, first)).toBe(true);
    expect(await assignmentActive(raceTaxi, second)).toBe(true);
    expect(await assignmentActive(oldTaxi, first)).toBe(false);
    expect(await activeInvalidPairCount()).toBe(0);

    // Reihenfolge 2: Die Deaktivierung committet zuerst, waehrend die
    // Paarzuordnung bereits geoeffnet ist und auf ihr Gate wartet; danach
    // darf sie das deaktivierte Tablet nicht mehr aktiv paaren.
    const secondRaceTaxi = "SYN-CX126-RACE-2";
    const secondOldTaxi = "SYN-CX126-OLD-2";
    await insertTaxi(secondRaceTaxi, false, 1);
    await insertTaxi(secondOldTaxi, true, 1);
    const third = await insertDevice();
    const fourth = await insertDevice();
    await insertTabletState(third, true, 1);
    await insertTabletState(fourth, true, 1);
    await assign(secondOldTaxi, third);

    const pairSecond = startPairAssignment(
      secondRaceTaxi,
      [third, fourth],
      "wait-then-write",
    );
    const deactivation = await newTabletService().setActiveState({
      deviceId: third,
      expectedRevision: 1,
      active: false,
      actorId: ACTOR,
    });
    expect(deactivation).toMatchObject({
      deviceId: third,
      active: false,
      revision: 2,
      changed: true,
    });
    const pairSecondOutcome = pairSecond.result.then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    pairSecond.release();
    const pairOutcome = await pairSecondOutcome;
    expect(pairOutcome.status).toBe("rejected");
    if (pairOutcome.status === "rejected") {
      expect(pairOutcome.error).toMatchObject({
        name: "PairAssignmentError",
        code: "invalid_assignment",
      });
    }

    expect(await tabletRow(third)).toEqual({ active: false, revision: 2 });
    expect(await assignmentActive(secondOldTaxi, third)).toBe(false);
    expect(await taxiRow(secondOldTaxi)).toEqual({ active: false, revision: 2 });
    const pairRows = await pool.query<{ count: string }>(
      "select count(*)::text as count from device_taxi_assignments" +
        " where taxi_id = $1",
      [secondRaceTaxi],
    );
    expect(Number(pairRows.rows[0]?.count ?? "0")).toBe(0);
    expect(await activeInvalidPairCount()).toBe(0);

    const tabletAudits = (await auditRows()).filter(
      (row) => row.action === TABLET_ACTIVATION_AUDIT_ACTION,
    );
    expect(tabletAudits).toHaveLength(1);
    expect(tabletAudits[0]).toMatchObject({
      target_id: third,
      details: { previous_active: true, active: false, revision: 2 },
    });
  });
});
