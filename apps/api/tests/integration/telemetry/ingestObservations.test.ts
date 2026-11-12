import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTelemetryIngestService,
  TelemetryConflictError,
  TelemetryStorageError,
  TelemetryValidationError,
  type TelemetryIngestService,
} from "../../../src/modules/telemetry/index.js";

const BASE_TIME = Date.parse("2026-01-01T12:00:00.000Z");
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../src/db/migrations",
);

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let nowMs = BASE_TIME;
let service: TelemetryIngestService;

const deviceA = randomUUID();
const deviceB = randomUUID();

const clock = (): Date => new Date(nowMs);

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
    throw new Error("CX-009 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

async function readMigration(name: string): Promise<string> {
  return readFile(join(MIGRATIONS_DIR, name), "utf8");
}

async function insertDevice(deviceId: string, fingerprint: string): Promise<void> {
  await pool.query(
    [
      "insert into devices",
      "  (id, label, public_key_spki, public_key_fingerprint, state,",
      "   manufacturer, model, os_version, sdk_int, app_version, app_flavor,",
      "   registration_code_id, registration_request_id, registered_at,",
      "   last_seen_at, last_seq)",
      "values ($1, $2, $3, $4, 'active', $5, $6, $7, $8, $9, $10,",
      "        $11, $12, $13, $13, 0)",
    ].join(" "),
    [
      deviceId,
      "SYN-CX-009-Geraet",
      Buffer.from("SYN-CX-009-Key-" + fingerprint),
      fingerprint,
      "SYN-Hersteller",
      "SYN-Modell",
      "14",
      34,
      "0.1.0",
      "dev",
      registrationCodeId,
      randomUUID(),
      new Date(BASE_TIME),
    ],
  );
}

let registrationCodeId = "";

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = ("gtads_cx009_" + process.pid + "_" + Date.now().toString(36))
    .toLowerCase()
    .slice(0, 63);
  await maintenancePool.query("create database " + quoteIdentifier(databaseName));

  pool = new Pool({ ...base, database: databaseName });
  await pool.query(await readMigration("0001_gt_ads_001.up.sql"));
  await pool.query(await readMigration("0002_gt_ads_004_telemetry.up.sql"));

  registrationCodeId = randomUUID();
  await pool.query(
    [
      "insert into registration_codes",
      "  (id, code_hash, label, created_at, created_by, expires_at)",
      "values ($1, $2, $3, $4, $5, $6)",
    ].join(" "),
    [
      registrationCodeId,
      Buffer.from("SYN-CX-009-registration-code"),
      "SYN-CX-009",
      new Date(BASE_TIME),
      "SYN-Test",
      new Date(BASE_TIME + 24 * 60 * 60 * 1000),
    ],
  );
  await insertDevice(deviceA, "SYN-CX-009-Fingerprint-A");
  await insertDevice(deviceB, "SYN-CX-009-Fingerprint-B");

  service = createTelemetryIngestService({ client: pool, now: clock });
}, 30_000);

beforeEach(async () => {
  nowMs = BASE_TIME;
  if (pool !== undefined) {
    await pool.query("delete from telemetry_observations");
  }
});

afterAll(async () => {
  if (pool !== undefined) {
    await pool.end();
  }
  if (maintenancePool !== undefined) {
    await maintenancePool.query(
      "drop database if exists " + quoteIdentifier(databaseName),
    );
    await maintenancePool.end();
  }
}, 30_000);

function observation(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    event_id: randomUUID(),
    occurred_at: "2026-01-01T12:00:00.000Z",
    vehicle_ready: true,
    paused: false,
    playback: "playing",
    technical_fault: false,
    ...overrides,
  };
}

async function countRows(deviceId?: string): Promise<number> {
  const result =
    deviceId === undefined
      ? await pool.query<{ count: string }>(
          "select count(*)::text as count from telemetry_observations",
        )
      : await pool.query<{ count: string }>(
          "select count(*)::text as count from telemetry_observations where device_id = $1",
          [deviceId],
        );
  return Number(result.rows[0]?.count ?? "0");
}

interface StoredObservation {
  event_id: string;
  occurred_at: Date;
  vehicle_ready: boolean | null;
  paused: boolean | null;
  playback: string;
  technical_fault: boolean | null;
  received_at: Date;
}

async function fetchRow(
  deviceId: string,
  eventId: string,
): Promise<StoredObservation | null> {
  const result = await pool.query<StoredObservation>(
    [
      "select event_id::text as event_id, occurred_at, vehicle_ready, paused,",
      "       playback, technical_fault, received_at",
      "  from telemetry_observations",
      " where device_id = $1 and event_id = $2",
    ].join(" "),
    [deviceId, eventId],
  );
  return result.rows[0] ?? null;
}

describe("CX-009 Migration 0002", () => {
  it("legt Geraete-Fremdschluessel, Unique(device_id,event_id) und den Auswertungsindex an", async () => {
    const constraints = await pool.query<{
      conname: string;
      contype: string;
      referenced: string | null;
    }>(
      [
        "select c.conname,",
        "       c.contype,",
        "       case when c.contype = 'f' then c.confrelid::regclass::text end as referenced",
        "  from pg_constraint c",
        " where c.conrelid = 'telemetry_observations'::regclass",
      ].join(" "),
    );

    const foreignKeys = constraints.rows.filter((row) => row.contype === "f");
    expect(foreignKeys).toHaveLength(1);
    expect(foreignKeys[0]?.referenced).toBe("devices");

    const unique = constraints.rows.find(
      (row) =>
        row.contype === "u" &&
        row.conname === "telemetry_observations_device_event_unique",
    );
    expect(unique).toBeDefined();

    const indexes = await pool.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where schemaname = 'public' and tablename = 'telemetry_observations'",
    );
    const definitions = indexes.rows.map((row) => row.indexdef);
    expect(
      definitions.some((definition) =>
        definition.includes("(device_id, occurred_at, event_id)"),
      ),
    ).toBe(true);
  });
});

describe("CX-009 idempotenter Telemetrie-Speicherkern", () => {
  it("wiederholte und parallele identische Aufrufe erzeugen genau einen Datensatz", async () => {
    const events = [observation(), observation(), observation()];

    const first = await service.ingestObservations(deviceA, events);
    expect(first.acceptedEventIds).toHaveLength(3);
    expect(first.insertedEventIds).toHaveLength(3);
    expect(first.duplicateEventIds).toHaveLength(0);
    expect(await countRows()).toBe(3);

    const stored = await fetchRow(deviceA, events[0]?.event_id as string);
    expect(stored?.received_at.getTime()).toBe(BASE_TIME);
    expect(stored?.occurred_at.toISOString()).toBe(
      "2026-01-01T12:00:00.000Z",
    );

    nowMs += 1000;
    const second = await service.ingestObservations(deviceA, events);
    expect([...second.acceptedEventIds].sort()).toEqual(
      [...first.acceptedEventIds].sort(),
    );
    expect(second.insertedEventIds).toHaveLength(0);
    expect(second.duplicateEventIds).toHaveLength(3);
    expect(await countRows()).toBe(3);

    nowMs += 1000;
    const parallel = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.ingestObservations(deviceA, events),
      ),
    );
    for (const result of parallel) {
      expect(result.acceptedEventIds).toHaveLength(3);
      expect(result.insertedEventIds).toHaveLength(0);
    }
    expect(await countRows()).toBe(3);
  });

  it("konkurrierende Batches mit ueberlappenden Ereignissen bleiben korrekt", async () => {
    const shared = observation();
    const leftOnly = observation();
    const rightOnly = observation();

    const [left, right] = await Promise.all([
      service.ingestObservations(deviceA, [shared, leftOnly]),
      service.ingestObservations(deviceA, [shared, rightOnly]),
    ]);

    expect(left.acceptedEventIds).toHaveLength(2);
    expect(right.acceptedEventIds).toHaveLength(2);
    expect(await countRows()).toBe(3);
  });

  it("abweichende Wiederverwendung derselben event_id ist Konflikt und rollt den ganzen Batch zurueck", async () => {
    const first = observation();
    const second = observation({ playback: "playing" });
    await service.ingestObservations(deviceA, [first, second]);

    const changed = { ...second, playback: "stopped" };
    const newEvent = observation();

    await expect(
      service.ingestObservations(deviceA, [first, changed, newEvent]),
    ).rejects.toBeInstanceOf(TelemetryConflictError);

    expect(await countRows()).toBe(2);
    expect((await fetchRow(deviceA, second.event_id as string))?.playback).toBe(
      "playing",
    );
    expect(await fetchRow(deviceA, newEvent.event_id as string)).toBeNull();
  });

  it("abweichende Wiederholung innerhalb eines Batches ist Konflikt ohne Teilwrite", async () => {
    const repeated = observation();
    const conflicting = { ...repeated, paused: true };
    const newEvent = observation();

    await expect(
      service.ingestObservations(deviceA, [repeated, conflicting, newEvent]),
    ).rejects.toBeInstanceOf(TelemetryConflictError);

    expect(await countRows()).toBe(0);
    expect(await fetchRow(deviceA, newEvent.event_id as string)).toBeNull();
  });

  it("erzwungener Transaktionsfehler liefert keine Bestaetigung; Wiederholung speichert alles", async () => {
    const failing = observation();
    const beforeFailing = observation();
    const afterFailing = observation();
    const failingId = failing.event_id as string;

    await pool.query(
      [
        "create or replace function cx009_fail_before_insert() returns trigger",
        "language plpgsql as $$",
        "begin",
        "  if new.event_id = '" + failingId + "'::uuid then",
        "    raise exception 'CX-009 synthetischer Transaktionsfehler';",
        "  end if;",
        "  return new;",
        "end",
        "$$",
      ].join(" "),
    );
    await pool.query(
      "create trigger cx009_fail_before_insert_trigger before insert on telemetry_observations for each row execute function cx009_fail_before_insert()",
    );

    try {
      await expect(
        service.ingestObservations(deviceA, [
          beforeFailing,
          failing,
          afterFailing,
        ]),
      ).rejects.toBeInstanceOf(TelemetryStorageError);
      expect(await countRows()).toBe(0);
    } finally {
      await pool.query(
        "drop trigger if exists cx009_fail_before_insert_trigger on telemetry_observations",
      );
      await pool.query("drop function if exists cx009_fail_before_insert()");
    }

    const retry = await service.ingestObservations(deviceA, [
      beforeFailing,
      failing,
      afterFailing,
    ]);
    expect(retry.acceptedEventIds).toHaveLength(3);
    expect(await countRows()).toBe(3);
  });

  it("Commit-Fehler liefert keine Bestaetigung; Wiederholung speichert alles", async () => {
    const failing = observation();
    const other = observation();
    const failingId = failing.event_id as string;

    await pool.query(
      [
        "create or replace function cx009_fail_at_commit() returns trigger",
        "language plpgsql as $$",
        "begin",
        "  if new.event_id = '" + failingId + "'::uuid then",
        "    raise exception 'CX-009 synthetischer Commit-Fehler';",
        "  end if;",
        "  return new;",
        "end",
        "$$",
      ].join(" "),
    );
    await pool.query(
      "create constraint trigger cx009_fail_at_commit_trigger after insert on telemetry_observations deferrable initially deferred for each row execute function cx009_fail_at_commit()",
    );

    try {
      await expect(
        service.ingestObservations(deviceA, [other, failing]),
      ).rejects.toBeInstanceOf(TelemetryStorageError);
      expect(await countRows()).toBe(0);
    } finally {
      await pool.query(
        "drop trigger if exists cx009_fail_at_commit_trigger on telemetry_observations",
      );
      await pool.query("drop function if exists cx009_fail_at_commit()");
    }

    const retry = await service.ingestObservations(deviceA, [other, failing]);
    expect(retry.acceptedEventIds).toHaveLength(2);
    expect(await countRows()).toBe(2);
  });

  it("verspaetete Ereignisse bleiben erhalten; gleiche event_id verschiedener Geraete kollidiert nicht", async () => {
    const oldEvent = observation({ occurred_at: "2019-05-04T03:02:01.123Z" });
    const futureEvent = observation({ occurred_at: "2030-01-01T00:00:00.000Z" });

    await service.ingestObservations(deviceA, [oldEvent, futureEvent]);
    expect(await countRows()).toBe(2);

    const oldStored = await fetchRow(deviceA, oldEvent.event_id as string);
    expect(oldStored?.occurred_at.toISOString()).toBe(
      "2019-05-04T03:02:01.123Z",
    );

    const sharedEventId = randomUUID();
    const eventForA = observation({
      event_id: sharedEventId,
      playback: "playing",
    });
    const eventForB = observation({
      event_id: sharedEventId,
      occurred_at: "2026-01-02T00:00:00.000Z",
      playback: "stopped",
      technical_fault: true,
    });

    await service.ingestObservations(deviceA, [eventForA]);
    await service.ingestObservations(deviceB, [eventForB]);

    expect(await countRows(deviceA)).toBe(3);
    expect(await countRows(deviceB)).toBe(1);
    expect((await fetchRow(deviceA, sharedEventId))?.playback).toBe("playing");
    expect((await fetchRow(deviceB, sharedEventId))?.playback).toBe("stopped");
  });

  it("weist unbekannte Felder, GPS-Felder, ungueltige UTC-Zeitpunkte und mehr als 100 Ereignisse ab", async () => {
    const base = observation();

    const invalidCases: Array<Record<string, unknown>> = [
      { ...base, extra: true },
      { ...base, gps: { mode: "off" } },
      { ...base, gps_mode: "off" },
      { ...base, latitude: 52.5 },
      { ...base, longitude: 13.4 },
      { ...base, location: "SYN-Ort" },
      { ...base, note: "SYN-Freitext" },
      { ...base, received_at: "2026-01-01T12:00:00.000Z" },
      { ...base, occurred_at: "2026-01-01T12:00:00Z" },
      { ...base, occurred_at: "2026-01-01T12:00:00.000+00:00" },
      { ...base, occurred_at: "2026-02-30T12:00:00.000Z" },
      { ...base, occurred_at: "keine-zeit" },
      { ...base, playback: "laeuft" },
      { ...base, vehicle_ready: "true" },
      {
        event_id: base.event_id,
        occurred_at: base.occurred_at,
        vehicle_ready: true,
        paused: false,
        playback: "playing",
      },
    ];

    for (const invalid of invalidCases) {
      await expect(
        service.ingestObservations(deviceA, [invalid]),
      ).rejects.toBeInstanceOf(TelemetryValidationError);
    }

    await expect(
      service.ingestObservations(deviceA, []),
    ).rejects.toBeInstanceOf(TelemetryValidationError);
    await expect(
      service.ingestObservations(deviceA, base),
    ).rejects.toBeInstanceOf(TelemetryValidationError);
    await expect(
      service.ingestObservations(
        deviceA,
        Array.from({ length: 101 }, () => observation()),
      ),
    ).rejects.toBeInstanceOf(TelemetryValidationError);

    await expect(
      service.ingestObservations(deviceA, [{ ...base, latitude: 52.5 }]),
    ).rejects.toMatchObject({ code: "telemetry_invalid" });

    expect(await countRows()).toBe(0);
  });

  it("akzeptiert die Batchgrenzen 1 und 100", async () => {
    const single = await service.ingestObservations(deviceA, [observation()]);
    expect(single.acceptedEventIds).toHaveLength(1);

    const hundred = Array.from({ length: 100 }, () => observation());
    const result = await service.ingestObservations(deviceA, hundred);
    expect(result.acceptedEventIds).toHaveLength(100);
    expect(await countRows()).toBe(101);
  });

  it("validiert die Geraete-ID als UUID aus dem authentifizierten Kontext", async () => {
    await expect(
      service.ingestObservations("keine-uuid", [observation()]),
    ).rejects.toBeInstanceOf(TelemetryValidationError);
    expect(await countRows()).toBe(0);
  });
});
