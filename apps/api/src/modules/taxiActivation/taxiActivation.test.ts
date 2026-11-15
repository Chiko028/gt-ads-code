/**
 * CX-124 / R-104: vier colocated Vitest-Faelle gegen echtes PostgreSQL.
 *
 * Die vorausgesetzten CX-Strukturen (taxis, device_taxi_assignments) legt
 * ausschliesslich das Testfixture in der isolierten Testdatenbank an; der
 * Dienst selbst erzeugt keine Tabellen. Alle Geraete, Taxis und Akteure sind
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
  TAXI_ACTIVATION_AUDIT_ACTION,
  TaxiActivationError,
  TaxiActivationService,
  type SetTaxiActiveStateInput,
} from "./service.js";

const FIXED_NOW = new Date("2026-01-01T12:00:00.000Z");
const ACTOR = "SYN-CX124-Admin";
const RACE_APP = "cx124-race";

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";

interface TaxiStateRow {
  active: boolean;
  revision: number;
}

interface AssignmentSnapshot {
  device_id: string;
  taxi_id: string;
  active: boolean;
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
    throw new Error("CX-124 benoetigt with-postgres <befehl>");
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
      Buffer.from("SYN-CX124-Code-" + registrationCodeId),
      "SYN-CX124",
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
      "SYN-CX124-Tablet",
      Buffer.from("SYN-CX124-Key-" + deviceId),
      "SYN-CX124-FP-" + deviceId,
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
    [
      "insert into taxis (id, display_name, active, revision)",
      "values ($1, $2, $3, $4)",
    ].join("\n"),
    [taxiId, "SYN " + taxiId, active, revision],
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

async function assignmentRows(taxiId: string): Promise<AssignmentSnapshot[]> {
  const result = await pool.query<AssignmentSnapshot>(
    [
      "select device_id::text as device_id, taxi_id, active",
      "  from device_taxi_assignments",
      " where taxi_id = $1",
      " order by device_id asc, taxi_id asc",
    ].join("\n"),
    [taxiId],
  );
  return result.rows;
}

async function auditRows(): Promise<AuditSnapshot[]> {
  const result = await pool.query<AuditSnapshot>(
    [
      "select action, actor_id, target_type, target_id, details",
      "  from audit_events",
      " order by id asc",
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

function newService(): TaxiActivationService {
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
    "gtads_cx124_activation_" +
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
  // Testfixture: Die isolierte Testdatenbank erhaelt die im Integrationsstand
  // vorausgesetzten CX-Strukturen. Der Dienst legt sie nicht selbst an.
  await pool.query(
    [
      "create table taxis (",
      "  id text primary key, display_name text not null default '',",
      "  active boolean not null default false,",
      "  revision bigint not null default 1 check (revision >= 1)",
      ");",
      "create table device_taxi_assignments (",
      "  device_id uuid not null references devices(id) on delete cascade,",
      "  taxi_id text not null, active boolean not null default true,",
      "  updated_at timestamptz not null default now(),",
      "  primary key (device_id, taxi_id)",
      ");",
    ].join("\n"),
  );
}, 60_000);

beforeEach(async () => {
  await pool.query("drop trigger if exists cx124_fail_audit on audit_events");
  await pool.query("drop function if exists cx124_fail_audit() cascade");
  await pool.query(
    "truncate table audit_events, device_taxi_assignments, taxis, devices, registration_codes restart identity cascade",
  );
});

afterAll(async () => {
  await pool.end();
  await maintenancePool.query(
    "drop database if exists " + quoteIdentifier(databaseName),
  );
  await maintenancePool.end();
}, 30_000);

describe("CX-124 Taxi-Aktivzustand", () => {
  it("aktiviert mit gueltigem Paar, speichert Revision und Audit gemeinsam und deaktiviert ohne Aenderung der Zuordnung", async () => {
    const taxiId = "SYN-CX124-ACTIVE";
    await insertTaxi(taxiId);
    const first = await insertDevice();
    const second = await insertDevice();
    await assign(taxiId, first);
    await assign(taxiId, second);
    const assignmentsBefore = await assignmentRows(taxiId);
    const service = newService();

    const activated = await service.setActiveState({
      taxiId,
      expectedRevision: 1,
      active: true,
      actorId: ACTOR,
    });
    expect(activated).toEqual({
      taxiId,
      active: true,
      revision: 2,
      changed: true,
    });
    expect(await taxiRow(taxiId)).toEqual({ active: true, revision: 2 });
    const firstAudits = await auditRows();
    expect(firstAudits).toHaveLength(1);
    expect(firstAudits[0]).toMatchObject({
      action: TAXI_ACTIVATION_AUDIT_ACTION,
      actor_id: ACTOR,
      target_type: "taxi",
      target_id: taxiId,
      details: { previous_active: false, active: true, revision: 2 },
    });

    const deactivated = await service.setActiveState({
      taxiId,
      expectedRevision: 2,
      active: false,
      actorId: ACTOR,
    });
    expect(deactivated).toEqual({
      taxiId,
      active: false,
      revision: 3,
      changed: true,
    });
    expect(await assignmentRows(taxiId)).toEqual(assignmentsBefore);
    expect(await auditRows()).toHaveLength(2);
  });

  const INVALID_CASES = [
    { id: "missing", name: "fehlendem Paar", code: "invalid_pair" },
    { id: "single", name: "nur einem Tablet", code: "invalid_pair" },
    { id: "three", name: "drei Tablets", code: "invalid_pair" },
    { id: "inactive", name: "deaktiviertem Tablet", code: "invalid_pair" },
    { id: "revoked", name: "widerrufenem Tablet", code: "invalid_pair" },
    { id: "foreign", name: "fremd zugeordnetem Tablet", code: "invalid_pair" },
    { id: "stale", name: "veralteter Revision", code: "revision_conflict" },
  ] as const;

  it.each(INVALID_CASES)(
    "verhindert die Aktivierung bei $name vollstaendig",
    async ({ id, code }) => {
      const taxiId = "SYN-CX124-" + id.toUpperCase();
      await insertTaxi(taxiId);
      const first = await insertDevice();
      let expectedRevision = 1;

      if (id === "single") {
        await assign(taxiId, first);
      } else if (id === "three") {
        const second = await insertDevice();
        const third = await insertDevice();
        await assign(taxiId, first);
        await assign(taxiId, second);
        await assign(taxiId, third);
      } else if (id === "inactive") {
        const second = await insertDevice();
        await assign(taxiId, first);
        await assign(taxiId, second, false);
      } else if (id === "revoked") {
        const second = await insertDevice("revoked");
        await assign(taxiId, first);
        await assign(taxiId, second);
      } else if (id === "foreign") {
        const second = await insertDevice();
        await insertTaxi("SYN-CX124-OTHER");
        await assign(taxiId, first);
        await assign(taxiId, second);
        await assign("SYN-CX124-OTHER", second);
      } else if (id === "stale") {
        const second = await insertDevice();
        await assign(taxiId, first);
        await assign(taxiId, second);
        expectedRevision = 0;
      }

      const input: SetTaxiActiveStateInput = {
        taxiId,
        expectedRevision,
        active: true,
        actorId: ACTOR,
      };
      await expect(newService().setActiveState(input)).rejects.toMatchObject({
        name: "TaxiActivationError",
        code,
      });

      expect(await taxiRow(taxiId)).toEqual({ active: false, revision: 1 });
      expect(await auditCount()).toBe(0);
    },
  );

  it("erzeugt bei zwei konkurrierenden Aenderungen hoechstens eine Aenderung und einen Audit-Eintrag", async () => {
    const taxiId = "SYN-CX124-RACE";
    await insertTaxi(taxiId);
    const first = await insertDevice();
    const second = await insertDevice();
    await assign(taxiId, first);
    await assign(taxiId, second);
    const service = newService();
    const base = baseConnection();
    const holder = new Client({
      ...base,
      database: databaseName,
      application_name: "cx124-holder",
    });
    const observer = new Client({
      ...base,
      database: databaseName,
      application_name: "cx124-observer",
    });
    await holder.connect();
    await observer.connect();

    try {
      await holder.query("begin");
      await holder.query("select id from taxis where id = $1 for update", [
        taxiId,
      ]);

      const input: SetTaxiActiveStateInput = {
        taxiId,
        expectedRevision: 1,
        active: true,
        actorId: ACTOR,
      };
      const first = service.setActiveState(input);
      await waitForLockWaiters(observer, 1);
      const pending = [first, service.setActiveState(input)];
      let waiterError: unknown = null;
      try {
        await waitForLockWaiters(observer, 2);
      } catch (error) {
        waiterError = error;
      }
      await holder.query("commit");

      const results = await Promise.allSettled(pending);
      if (waiterError !== null) {
        throw waiterError;
      }
      const fulfilled = results.filter(
        (result) => result.status === "fulfilled",
      );
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        TaxiActivationError,
      );
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: "revision_conflict",
      });
      expect(
        (fulfilled[0] as PromiseFulfilledResult<unknown>).value,
      ).toMatchObject({ active: true, revision: 2, changed: true });
    } finally {
      await observer.end();
      await holder.end();
    }

    expect(await taxiRow(taxiId)).toEqual({ active: true, revision: 2 });
    expect(await auditCount()).toBe(1);
  });

  it("rollt bei einem Audit-Schreibfehler zurueck und laesst identischen Sollzustand ohne Audit", async () => {
    const taxiId = "SYN-CX124-AUDIT";
    await insertTaxi(taxiId);
    const first = await insertDevice();
    const second = await insertDevice();
    await assign(taxiId, first);
    await assign(taxiId, second);
    const service = newService();

    await pool.query(
      [
        "create function cx124_fail_audit() returns trigger",
        "language plpgsql as $$",
        "begin",
        "  if new.action = 'taxi.activation.changed' then",
        "    raise exception 'CX-124 synthetic audit failure';",
        "  end if;",
        "  return new;",
        "end;",
        "$$",
      ].join("\n"),
    );
    await pool.query(
      [
        "create trigger cx124_fail_audit",
        "before insert on audit_events",
        "for each row execute function cx124_fail_audit()",
      ].join("\n"),
    );

    await expect(
      service.setActiveState({
        taxiId,
        expectedRevision: 1,
        active: true,
        actorId: ACTOR,
      }),
    ).rejects.toThrow("CX-124 synthetic audit failure");
    expect(await taxiRow(taxiId)).toEqual({ active: false, revision: 1 });
    expect(await auditCount()).toBe(0);

    await pool.query("drop trigger cx124_fail_audit on audit_events");
    await pool.query("drop function cx124_fail_audit()");

    const noop = await service.setActiveState({
      taxiId,
      expectedRevision: 1,
      active: false,
      actorId: ACTOR,
    });
    expect(noop).toEqual({
      taxiId,
      active: false,
      revision: 1,
      changed: false,
    });
    expect(await taxiRow(taxiId)).toEqual({ active: false, revision: 1 });
    expect(await auditCount()).toBe(0);
  });

  it("behandelt identischen aktiven Sollzustand als No-op, auch wenn das Paar ungueltig ist", async () => {
    const taxiId = "SYN-CX124-NOOP-ACTIVE";
    await insertTaxi(taxiId, true, 1);
    const activeDevice = await insertDevice();
    const revokedDevice = await insertDevice("revoked");
    await assign(taxiId, activeDevice);
    await assign(taxiId, revokedDevice);
    const assignmentsBefore = await assignmentRows(taxiId);

    const result = await newService().setActiveState({
      taxiId,
      expectedRevision: 1,
      active: true,
      actorId: ACTOR,
    });

    expect(result).toEqual({
      taxiId,
      active: true,
      revision: 1,
      changed: false,
    });
    expect(await taxiRow(taxiId)).toEqual({ active: true, revision: 1 });
    expect(await assignmentRows(taxiId)).toEqual(assignmentsBefore);
    expect(await auditCount()).toBe(0);
  });

  it("behandelt einen bereits aktiven Sollzustand auch ohne Zuordnungen als No-op", async () => {
    const taxiId = "SYN-CX124-NOOP-EMPTY";
    await insertTaxi(taxiId, true, 1);

    const result = await newService().setActiveState({
      taxiId,
      expectedRevision: 1,
      active: true,
      actorId: ACTOR,
    });

    expect(result).toEqual({
      taxiId,
      active: true,
      revision: 1,
      changed: false,
    });
    expect(await taxiRow(taxiId)).toEqual({ active: true, revision: 1 });
    expect(await assignmentRows(taxiId)).toEqual([]);
    expect(await auditCount()).toBe(0);
  });

  it("meldet bei veralteter Revision auch fuer einen unveraenderten Sollzustand einen Revisionskonflikt", async () => {
    const taxiId = "SYN-CX124-NOOP-STALE";
    await insertTaxi(taxiId, true, 2);

    await expect(
      newService().setActiveState({
        taxiId,
        expectedRevision: 1,
        active: true,
        actorId: ACTOR,
      }),
    ).rejects.toMatchObject({
      name: "TaxiActivationError",
      code: "revision_conflict",
    });
    expect(await taxiRow(taxiId)).toEqual({ active: true, revision: 2 });
    expect(await auditCount()).toBe(0);
  });

  it("meldet fehlende CX-Felder als blockiert und legt keine Ersatztabellen an", async () => {
    const emptyPool = new Pool({
      ...baseConnection(),
      database: databaseName,
      options: "-c search_path=cx124_empty",
      max: 2,
    });
    try {
      await emptyPool.query("create schema cx124_empty");
      const service = new TaxiActivationService({
        pool: emptyPool,
        now: () => FIXED_NOW,
      });

      const attempt = service.setActiveState({
        taxiId: "SYN-CX124-EMPTY",
        expectedRevision: 0,
        active: true,
        actorId: ACTOR,
      });
      await expect(attempt).rejects.toMatchObject({
        name: "TaxiActivationError",
        code: "missing_schema",
      });
      await expect(attempt).rejects.toThrow("blockiert");

      const created = await emptyPool.query<{ present: boolean }>(
        "select to_regclass('cx124_empty.taxis') is not null as present",
      );
      expect(created.rows[0]?.present).toBe(false);
    } finally {
      await emptyPool.end();
    }
  });
});

