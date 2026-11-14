import { randomUUID } from "node:crypto";
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
import { migrateUp } from "../../db/migrate.js";
import {
  DeviceInventoryService,
  INVENTORY_AUDIT_ACTION,
  InventoryError,
  type DeviceInventory,
} from "./service.js";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);
const UP_MIGRATION = "0014_cx_128_device_inventory.up.sql";
const DOWN_MIGRATION = "0014_cx_128_device_inventory.down.sql";
const FIXED_NOW = new Date("2026-01-01T12:00:00.000Z");
const ACTOR = "SYN-CX128-Admin";

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";

interface SyntheticDevice {
  id: string;
}

interface InventoryDbRow {
  serial_number: string | null;
  device_type: string | null;
  replacement_note: string | null;
  revision: number;
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
    throw new Error("CX-128 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

async function readMigration(name: string): Promise<string> {
  return readFile(join(MIGRATIONS_DIR, name), "utf8");
}

async function applyInventoryUp(): Promise<void> {
  await pool.query(await readMigration(UP_MIGRATION));
}

async function relationExists(name: string): Promise<boolean> {
  const result = await pool.query<{ present: boolean }>(
    "select to_regclass($1) is not null as present",
    ["public." + name],
  );
  return result.rows[0]?.present === true;
}

async function insertSyntheticDevice(): Promise<SyntheticDevice> {
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
      Buffer.from("SYN-CX128-Code-" + registrationCodeId),
      "SYN-CX128",
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
      "SYN-CX128-Tablet",
      Buffer.from("SYN-CX128-Key-" + deviceId),
      "SYN-CX128-FP-" + deviceId,
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
  return { id: deviceId };
}

async function deviceIdentity(deviceId: string): Promise<unknown> {
  const result = await pool.query<{ device: unknown }>(
    "select to_jsonb(d) as device from devices d where d.id = $1::uuid",
    [deviceId],
  );
  return result.rows[0]?.device ?? null;
}

async function inventoryRow(deviceId: string): Promise<InventoryDbRow | null> {
  const result = await pool.query<InventoryDbRow>(
    [
      "select serial_number, device_type, replacement_note, revision",
      "  from device_inventory",
      " where device_id = $1::uuid",
    ].join("\n"),
    [deviceId],
  );
  return result.rows[0] ?? null;
}

async function inventoryCount(deviceId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "select count(*)::text as count from device_inventory where device_id = $1::uuid",
    [deviceId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function auditCount(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "select count(*)::text as count from audit_events",
  );
  return Number(result.rows[0]?.count ?? "0");
}

function newService(): DeviceInventoryService {
  return new DeviceInventoryService({ pool, now: () => FIXED_NOW });
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx128_inventory_" +
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
  await migrateUp(pool);
  await applyInventoryUp();
}, 60_000);

beforeEach(async () => {
  await pool.query("drop trigger if exists cx128_fail_inventory_audit on audit_events");
  await pool.query("drop function if exists cx128_fail_inventory_audit() cascade");
  if (!(await relationExists("device_inventory"))) {
    await applyInventoryUp();
  }
  await pool.query(
    "truncate table device_inventory, audit_events, devices, registration_codes restart identity cascade",
  );
});

afterAll(async () => {
  await pool.end();
  await maintenancePool.query(
    "drop database if exists " + quoteIdentifier(databaseName),
  );
  await maintenancePool.end();
}, 30_000);

describe("CX-128 Inventarschreibkern", () => {
  it("fuehrt die additive Migration vorwaerts und rueckwaerts aus, ohne Geraeteidentitaet oder Lesbarkeit zu veraendern", async () => {
    const device = await insertSyntheticDevice();
    const before = await deviceIdentity(device.id);
    expect(before).not.toBeNull();
    expect(await inventoryCount(device.id)).toBe(0);

    await pool.query(await readMigration(DOWN_MIGRATION));
    expect(await relationExists("device_inventory")).toBe(false);
    expect(await deviceIdentity(device.id)).toEqual(before);
    const readable = await pool.query<{ id: string }>(
      "select id::text as id from devices where id = $1::uuid",
      [device.id],
    );
    expect(readable.rows).toEqual([{ id: device.id }]);

    await applyInventoryUp();
    expect(await relationExists("device_inventory")).toBe(true);
    expect(await deviceIdentity(device.id)).toEqual(before);
    expect(await inventoryCount(device.id)).toBe(0);
  });

  it("legt Inventar an, aendert mit erwarteter Revision, leert per null und weist unbekannte Geraete ab", async () => {
    const device = await insertSyntheticDevice();
    const service = newService();

    const created = await service.replaceInventory(
      device.id,
      {
        serialNumber: "  SYN-SER-001  ",
        deviceType: "  SYN-Tablet  ",
        replacementNote: "  SYN-Austausch  ",
        expectedRevision: 0,
      },
      ACTOR,
    );
    expect(created).toEqual({
      deviceId: device.id,
      serialNumber: "SYN-SER-001",
      deviceType: "SYN-Tablet",
      replacementNote: "SYN-Austausch",
      revision: 1,
    });
    expect(await inventoryRow(device.id)).toEqual({
      serial_number: "SYN-SER-001",
      device_type: "SYN-Tablet",
      replacement_note: "SYN-Austausch",
      revision: 1,
    });

    const changed = await service.replaceInventory(
      device.id,
      {
        serialNumber: "SYN-SER-002",
        deviceType: null,
        replacementNote: "SYN-Austausch-2",
        expectedRevision: 1,
      },
      ACTOR,
    );
    expect(changed).toEqual({
      deviceId: device.id,
      serialNumber: "SYN-SER-002",
      deviceType: null,
      replacementNote: "SYN-Austausch-2",
      revision: 2,
    });

    const cleared = await service.replaceInventory(
      device.id,
      {
        serialNumber: null,
        deviceType: null,
        replacementNote: "   ",
        expectedRevision: 2,
      },
      ACTOR,
    );
    expect(cleared.serialNumber).toBeNull();
    expect(cleared.deviceType).toBeNull();
    expect(cleared.replacementNote).toBeNull();
    expect(cleared.revision).toBe(3);

    const unknown = randomUUID();
    await expect(
      service.replaceInventory(
        unknown,
        {
          serialNumber: "SYN-SER-UNKNOWN",
          deviceType: null,
          replacementNote: null,
          expectedRevision: 0,
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await inventoryCount(unknown)).toBe(0);

    const audits = await pool.query<{
      target_id: string;
      details: Record<string, unknown>;
    }>(
      [
        "select target_id, details",
        "  from audit_events",
        " where action = $1",
        " order by id asc",
      ].join("\n"),
      [INVENTORY_AUDIT_ACTION],
    );
    expect(audits.rows).toHaveLength(3);
    expect(audits.rows[0]?.target_id).toBe(device.id);
    expect(audits.rows[0]?.details).toEqual({
      revision: 1,
      changed_fields: ["serial_number", "device_type", "replacement_note"],
    });
    expect(audits.rows[2]?.details).toEqual({
      revision: 3,
      changed_fields: ["serial_number", "replacement_note"],
    });
    for (const audit of audits.rows) {
      expect(JSON.stringify(audit.details)).not.toContain("SYN-SER");
      expect(JSON.stringify(audit.details)).not.toContain("SYN-Austausch");
    }
  });

  it("verhindert Grenzwertverletzungen, konkurrierende gleiche Revisionen und partielle Speicherung bei Auditfehler", async () => {
    const service = newService();
    const boundaryDevice = await insertSyntheticDevice();

    const rejectedInputs: Array<{
      serialNumber: string | null;
      deviceType: string | null;
      replacementNote: string | null;
    }> = [
      {
        serialNumber: "😀".repeat(129),
        deviceType: null,
        replacementNote: null,
      },
      {
        serialNumber: null,
        deviceType: "😀".repeat(65),
        replacementNote: null,
      },
      {
        serialNumber: null,
        deviceType: null,
        replacementNote: "😀".repeat(1001),
      },
    ];
    for (const fields of rejectedInputs) {
      await expect(
        service.replaceInventory(
          boundaryDevice.id,
          { ...fields, expectedRevision: 0 },
          ACTOR,
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(await inventoryCount(boundaryDevice.id)).toBe(0);

    const exactDevice = await insertSyntheticDevice();
    const exact = await service.replaceInventory(
      exactDevice.id,
      {
        serialNumber: "😀".repeat(128),
        deviceType: "😀".repeat(64),
        replacementNote: "😀".repeat(1000),
        expectedRevision: 0,
      },
      ACTOR,
    );
    expect(exact.revision).toBe(1);
    expect(Array.from(exact.serialNumber ?? "")).toHaveLength(128);
    expect(Array.from(exact.deviceType ?? "")).toHaveLength(64);
    expect(Array.from(exact.replacementNote ?? "")).toHaveLength(1000);

    const sameRevision = await Promise.allSettled([
      service.replaceInventory(
        exactDevice.id,
        {
          serialNumber: "SYN-RACE-A",
          deviceType: null,
          replacementNote: null,
          expectedRevision: 1,
        },
        ACTOR,
      ),
      service.replaceInventory(
        exactDevice.id,
        {
          serialNumber: "SYN-RACE-B",
          deviceType: null,
          replacementNote: null,
          expectedRevision: 1,
        },
        ACTOR,
      ),
    ]);
    const fulfilled = sameRevision.filter((outcome) => outcome.status === "fulfilled");
    const rejected = sameRevision.filter((outcome) => outcome.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const sameRevisionError = rejected[0];
    expect(sameRevisionError?.status).toBe("rejected");
    if (sameRevisionError?.status === "rejected") {
      expect(sameRevisionError.reason).toBeInstanceOf(InventoryError);
      expect((sameRevisionError.reason as InventoryError).code).toBe(
        "revision_conflict",
      );
    }
    const raced = await inventoryRow(exactDevice.id);
    expect(raced?.revision).toBe(2);
    expect(["SYN-RACE-A", "SYN-RACE-B"]).toContain(raced?.serial_number);

    const firstCreationDevice = await insertSyntheticDevice();
    const firstCreation = await Promise.allSettled([
      service.replaceInventory(
        firstCreationDevice.id,
        {
          serialNumber: "SYN-FIRST-A",
          deviceType: null,
          replacementNote: null,
          expectedRevision: 0,
        },
        ACTOR,
      ),
      service.replaceInventory(
        firstCreationDevice.id,
        {
          serialNumber: "SYN-FIRST-B",
          deviceType: null,
          replacementNote: null,
          expectedRevision: 0,
        },
        ACTOR,
      ),
    ]);
    const firstFulfilled = firstCreation.filter(
      (outcome) => outcome.status === "fulfilled",
    );
    const firstRejected = firstCreation.filter(
      (outcome) => outcome.status === "rejected",
    );
    expect(firstFulfilled).toHaveLength(1);
    expect(firstRejected).toHaveLength(1);
    const firstError = firstRejected[0];
    expect(firstError?.status).toBe("rejected");
    if (firstError?.status === "rejected") {
      expect(firstError.reason).toBeInstanceOf(InventoryError);
      expect((firstError.reason as InventoryError).code).toBe(
        "revision_conflict",
      );
    }
    expect(await inventoryCount(firstCreationDevice.id)).toBe(1);
    expect((await inventoryRow(firstCreationDevice.id))?.revision).toBe(1);

    const auditDevice = await insertSyntheticDevice();
    const created = await service.replaceInventory(
      auditDevice.id,
      {
        serialNumber: "SYN-AUDIT-1",
        deviceType: null,
        replacementNote: null,
        expectedRevision: 0,
      },
      ACTOR,
    );
    expect(created.revision).toBe(1);
    const auditCountBefore = await auditCount();

    await pool.query(
      [
        "create function cx128_fail_inventory_audit() returns trigger",
        "language plpgsql as $cx128$",
        "begin",
        "  if new.action = 'device.inventory.updated' then",
        "    raise exception 'SYN-CX128 Auditfehler';",
        "  end if;",
        "  return new;",
        "end;",
        "$cx128$;",
        "create trigger cx128_fail_inventory_audit",
        "before insert on audit_events",
        "for each row execute function cx128_fail_inventory_audit()",
      ].join("\n"),
    );
    try {
      await expect(
        service.replaceInventory(
          auditDevice.id,
          {
            serialNumber: "SYN-AUDIT-2",
            deviceType: "SYN-Typ",
            replacementNote: null,
            expectedRevision: 1,
          },
          ACTOR,
        ),
      ).rejects.toThrow();
    } finally {
      await pool.query(
        "drop trigger if exists cx128_fail_inventory_audit on audit_events",
      );
      await pool.query(
        "drop function if exists cx128_fail_inventory_audit() cascade",
      );
    }

    expect(await inventoryRow(auditDevice.id)).toEqual({
      serial_number: "SYN-AUDIT-1",
      device_type: null,
      replacement_note: null,
      revision: 1,
    });
    expect(await auditCount()).toBe(auditCountBefore);
  });
});
