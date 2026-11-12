import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTelemetryIngestService,
  type TelemetryIngestService,
} from "../../../src/modules/telemetry/index.js";
import {
  createTelemetryRollupService,
  RollupPolicyConflictError,
  RollupStorageError,
  type RebuildDayResult,
  type TelemetryRollupService,
} from "../../../src/modules/telemetryRollups/index.js";
import type { EvaluationPolicy } from "../../../src/modules/telemetryEvaluation/index.js";

const BASE_TIME = Date.parse("2026-03-03T00:00:00.000Z");
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../src/db/migrations",
);
const TIME_ZONE = "Europe/Berlin";
const DAY_ONE = "2026-03-01";
const DAY_TWO = "2026-03-02";

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let nowMs = BASE_TIME;
let ingest: TelemetryIngestService;
let rollups: TelemetryRollupService;
let registrationCodeId = "";

const deviceA = randomUUID();
const deviceB = randomUUID();

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
    throw new Error("CX-011 benoetigt with-postgres <befehl>");
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
      "SYN-CX-011-Geraet",
      Buffer.from("SYN-CX-011-Key-" + fingerprint),
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

function policy(
  policyVersion = "cx-011-p1",
  maxObservationAgeSeconds = 3600,
): EvaluationPolicy {
  return {
    policyVersion,
    maxObservationAgeSeconds,
    e36: { pauseResetOnVehicleOff: true, pauseMaxSeconds: null },
    e40: { displayRunOnSeconds: 5 },
  };
}

function observation(
  occurredAt: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    event_id: randomUUID(),
    occurred_at: occurredAt,
    vehicle_ready: true,
    paused: false,
    playback: "playing",
    technical_fault: false,
    ...overrides,
  };
}

interface StoredRollup {
  revision: number;
  evaluation_time: Date;
  input_fingerprint: string;
  classes: Record<string, number>;
  coverage: Record<string, number>;
  policy_version: string;
  time_zone: string;
}

async function fetchRollup(
  deviceId: string,
  localDate: string,
  timeZone: string,
  policyVersion: string,
): Promise<StoredRollup | null> {
  const result = await pool.query<StoredRollup>(
    [
      "select revision, evaluation_time, input_fingerprint, classes, coverage,",
      "       policy_version, time_zone",
      "  from telemetry_daily_rollups",
      " where device_id = $1 and local_date = $2::date",
      "   and time_zone = $3 and policy_version = $4",
    ].join(" "),
    [deviceId, localDate, timeZone, policyVersion],
  );
  return result.rows[0] ?? null;
}

async function countRollups(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "select count(*)::text as count from telemetry_daily_rollups",
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function rawRows(deviceId: string): Promise<unknown[]> {
  const result = await pool.query(
    [
      "select event_id::text, occurred_at, received_at, vehicle_ready, paused,",
      "       playback, technical_fault",
      "  from telemetry_observations",
      " where device_id = $1",
      " order by occurred_at, event_id",
    ].join(" "),
    [deviceId],
  );
  return result.rows;
}

async function rebuild(
  deviceId: string,
  localDate: string,
  evaluationTime: string,
  evaluationPolicy: EvaluationPolicy = policy(),
  timeZone = TIME_ZONE,
): Promise<RebuildDayResult> {
  return rollups.rebuildDay({
    deviceId,
    localDate,
    timeZone,
    policy: evaluationPolicy,
    evaluationTime,
  });
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = ("gtads_cx011_" + process.pid + "_" + Date.now().toString(36))
    .toLowerCase()
    .slice(0, 63);
  await maintenancePool.query("create database " + quoteIdentifier(databaseName));

  pool = new Pool({ ...base, database: databaseName });
  await pool.query(await readMigration("0001_gt_ads_001.up.sql"));
  await pool.query(await readMigration("0002_gt_ads_004_telemetry.up.sql"));
  await pool.query(await readMigration("0003_cx_011_telemetry_rollups.up.sql"));

  registrationCodeId = randomUUID();
  await pool.query(
    [
      "insert into registration_codes",
      "  (id, code_hash, label, created_at, created_by, expires_at)",
      "values ($1, $2, $3, $4, $5, $6)",
    ].join(" "),
    [
      registrationCodeId,
      Buffer.from("SYN-CX-011-registration-code"),
      "SYN-CX-011",
      new Date(BASE_TIME),
      "SYN-Test",
      new Date(BASE_TIME + 86_400_000),
    ],
  );
  await insertDevice(deviceA, "SYN-CX-011-Fingerprint-A");
  await insertDevice(deviceB, "SYN-CX-011-Fingerprint-B");

  ingest = createTelemetryIngestService({ client: pool, now: () => new Date(nowMs) });
  rollups = createTelemetryRollupService({ client: pool });
}, 30_000);

beforeEach(async () => {
  nowMs = BASE_TIME;
  if (pool !== undefined) {
    await pool.query("delete from telemetry_daily_rollups");
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

describe("CX-011 Migration 0003", () => {
  it("legt ausschliesslich die Rollup-Tabelle mit Schluessel und Indizes an", async () => {
    const constraints = await pool.query<{ conname: string; contype: string }>(
      [
        "select conname, contype",
        "  from pg_constraint",
        " where conrelid = 'telemetry_daily_rollups'::regclass",
      ].join(" "),
    );
    expect(
      constraints.rows.some(
        (row) =>
          row.contype === "u" &&
          row.conname === "telemetry_daily_rollups_key_unique",
      ),
    ).toBe(true);
    expect(
      constraints.rows.some(
        (row) =>
          row.contype === "f" &&
          row.conname === "telemetry_daily_rollups_device_id_fkey",
      ),
    ).toBe(true);

    const indexes = await pool.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where schemaname = 'public' and tablename = 'telemetry_daily_rollups'",
    );
    const definitions = indexes.rows.map((row) => row.indexdef);
    expect(
      definitions.some((definition) =>
        definition.includes("(time_zone, local_date, algorithm_version)"),
      ),
    ).toBe(true);
    expect(
      definitions.some((definition) => definition.includes("(policy_version)")),
    ).toBe(true);
  });
});

describe("CX-011 rebuildDay", () => {
  it("wiederholt identische Auswertungen ohne neue Zeile und ohne neue Revision", async () => {
    const events = [
      observation("2026-03-01T08:00:00.000Z"),
      observation("2026-03-01T09:30:00.000Z", { playback: "stopped" }),
    ];
    await ingest.ingestObservations(deviceA, events);
    const rawBefore = await rawRows(deviceA);

    const first = await rebuild(deviceA, DAY_ONE, "2026-03-02T12:00:00.000Z");
    const second = await rebuild(deviceA, DAY_ONE, "2026-03-02T12:00:00.000Z");

    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("unchanged");
    expect(second.rollup).toEqual(first.rollup);
    expect(first.rollup.revision).toBe(1);
    expect(await countRollups()).toBe(1);
    expect(await rawRows(deviceA)).toEqual(rawBefore);
  });

  it("aendert nach einem verspaeteten Ereignis genau die betroffene Tagesauswertung", async () => {
    await ingest.ingestObservations(deviceA, [
      observation("2026-03-01T08:00:00.000Z"),
      observation("2026-03-02T10:00:00.000Z"),
    ]);
    const dayOneFirst = await rebuild(
      deviceA,
      DAY_ONE,
      "2026-03-02T12:00:00.000Z",
    );
    const dayTwoFirst = await rebuild(
      deviceA,
      DAY_TWO,
      "2026-03-03T12:00:00.000Z",
    );
    const dayTwoBefore = await fetchRollup(
      deviceA,
      DAY_TWO,
      TIME_ZONE,
      "cx-011-p1",
    );

    nowMs = Date.parse("2026-03-05T00:00:00.000Z");
    await ingest.ingestObservations(deviceA, [
      observation("2026-03-01T20:00:00.000Z", { paused: true }),
    ]);

    const dayOneAfter = await rebuild(
      deviceA,
      DAY_ONE,
      "2026-03-02T13:00:00.000Z",
    );
    const dayTwoAfter = await fetchRollup(
      deviceA,
      DAY_TWO,
      TIME_ZONE,
      "cx-011-p1",
    );

    expect(dayOneAfter.outcome).toBe("replaced");
    expect(dayOneAfter.rollup.revision).toBe(dayOneFirst.rollup.revision + 1);
    expect(dayOneAfter.rollup.inputFingerprint).not.toBe(
      dayOneFirst.rollup.inputFingerprint,
    );
    expect(dayTwoAfter).toEqual(dayTwoBefore);
    expect(dayTwoFirst.rollup.revision).toBe(1);
    expect(await countRollups()).toBe(2);
  });

  it("serialisiert parallele Laeufe desselben Schluessels", async () => {
    await ingest.ingestObservations(deviceA, [
      observation("2026-03-01T08:00:00.000Z"),
    ]);

    await pool.query(
      [
        "create or replace function cx011_slow_rollup_insert() returns trigger",
        "language plpgsql as $$",
        "begin",
        "  perform pg_sleep(0.1);",
        "  return new;",
        "end",
        "$$",
      ].join(" "),
    );
    await pool.query(
      "create trigger cx011_slow_rollup_insert_trigger before insert on telemetry_daily_rollups for each row execute function cx011_slow_rollup_insert()",
    );

    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          rebuild(deviceA, DAY_ONE, "2026-03-02T12:00:00.000Z"),
        ),
      );
      const outcomes = results.map((result) => result.outcome).sort();
      expect(outcomes).toEqual([
        "created",
        "unchanged",
        "unchanged",
        "unchanged",
        "unchanged",
      ]);
      expect(new Set(results.map((result) => result.rollup.revision))).toEqual(
        new Set([1]),
      );
      expect(await countRollups()).toBe(1);
    } finally {
      await pool.query(
        "drop trigger if exists cx011_slow_rollup_insert_trigger on telemetry_daily_rollups",
      );
      await pool.query("drop function if exists cx011_slow_rollup_insert()");
    }
  });

  it("laesst ein gueltiges Rollup bei einem fehlgeschlagenen Lauf unveraendert", async () => {
    await ingest.ingestObservations(deviceA, [
      observation("2026-03-01T08:00:00.000Z"),
    ]);
    const first = await rebuild(deviceA, DAY_ONE, "2026-03-02T12:00:00.000Z");
    const storedBefore = await fetchRollup(
      deviceA,
      DAY_ONE,
      TIME_ZONE,
      "cx-011-p1",
    );

    nowMs = Date.parse("2026-03-04T00:00:00.000Z");
    await ingest.ingestObservations(deviceA, [
      observation("2026-03-01T09:00:00.000Z", { technical_fault: true }),
    ]);

    await pool.query(
      [
        "create or replace function cx011_fail_rollup_update() returns trigger",
        "language plpgsql as $$",
        "begin",
        "  raise exception 'CX-011 synthetischer Rollup-Fehler';",
        "end",
        "$$",
      ].join(" "),
    );
    await pool.query(
      "create trigger cx011_fail_rollup_update_trigger before update on telemetry_daily_rollups for each row execute function cx011_fail_rollup_update()",
    );

    try {
      await expect(
        rebuild(deviceA, DAY_ONE, "2026-03-02T12:00:00.000Z"),
      ).rejects.toBeInstanceOf(RollupStorageError);
      expect(await fetchRollup(deviceA, DAY_ONE, TIME_ZONE, "cx-011-p1")).toEqual(
        storedBefore,
      );
    } finally {
      await pool.query(
        "drop trigger if exists cx011_fail_rollup_update_trigger on telemetry_daily_rollups",
      );
      await pool.query("drop function if exists cx011_fail_rollup_update()");
    }

    const retry = await rebuild(deviceA, DAY_ONE, "2026-03-02T12:00:00.000Z");
    expect(retry.outcome).toBe("replaced");
    expect(retry.rollup.revision).toBe(first.rollup.revision + 1);
  });

  it("trennt Zeitzonen und Policy-Versionen als eigene Auswertungsschluessel", async () => {
    await ingest.ingestObservations(deviceA, [
      observation("2026-03-01T08:00:00.000Z"),
    ]);

    const berlin = await rebuild(
      deviceA,
      DAY_ONE,
      "2026-03-02T12:00:00.000Z",
      policy("cx-011-p1"),
      "Europe/Berlin",
    );
    const utc = await rebuild(
      deviceA,
      DAY_ONE,
      "2026-03-02T12:00:00.000Z",
      policy("cx-011-p1"),
      "UTC",
    );
    const otherPolicy = await rebuild(
      deviceA,
      DAY_ONE,
      "2026-03-02T12:00:00.000Z",
      policy("cx-011-p2"),
      "Europe/Berlin",
    );

    expect(new Set([berlin.rollup.id, utc.rollup.id, otherPolicy.rollup.id]).size).toBe(3);
    expect(await countRollups()).toBe(3);
    expect(berlin.rollup.inputFingerprint).not.toBe(utc.rollup.inputFingerprint);
    expect(berlin.rollup.inputFingerprint).not.toBe(
      otherPolicy.rollup.inputFingerprint,
    );
  });

  it("weist unterschiedlichen Policy-Inhalt unter derselben Version ab", async () => {
    await ingest.ingestObservations(deviceA, [
      observation("2026-03-01T08:00:00.000Z"),
    ]);
    const first = await rebuild(deviceA, DAY_ONE, "2026-03-02T12:00:00.000Z");
    const storedBefore = await fetchRollup(
      deviceA,
      DAY_ONE,
      TIME_ZONE,
      "cx-011-p1",
    );

    await expect(
      rebuild(
        deviceA,
        DAY_ONE,
        "2026-03-02T12:00:00.000Z",
        policy("cx-011-p1", 7200),
      ),
    ).rejects.toBeInstanceOf(RollupPolicyConflictError);

    expect(await fetchRollup(deviceA, DAY_ONE, TIME_ZONE, "cx-011-p1")).toEqual(
      storedBefore,
    );
    expect(first.rollup.revision).toBe(1);
  });

  it("laesst keinen aelteren parallelen Lauf ein neueres Ergebnis ueberschreiben", async () => {
    await ingest.ingestObservations(deviceA, [
      observation("2026-03-01T08:00:00.000Z"),
    ]);

    await Promise.all([
      rebuild(deviceA, DAY_ONE, "2026-03-02T10:00:00.000Z"),
      rebuild(deviceA, DAY_ONE, "2026-03-02T12:00:00.000Z"),
    ]);

    const stored = await fetchRollup(deviceA, DAY_ONE, TIME_ZONE, "cx-011-p1");
    expect(stored?.evaluation_time.toISOString()).toBe(
      "2026-03-02T12:00:00.000Z",
    );
    expect(await countRollups()).toBe(1);
  });

  it("beruecksichtigt ein nach dem Snapshot eingetroffenes Ereignis beim naechsten Wiederholungslauf", async () => {
    await ingest.ingestObservations(deviceA, [
      observation("2026-03-01T08:00:00.000Z"),
    ]);
    const first = await rebuild(deviceA, DAY_ONE, "2026-03-02T12:00:00.000Z");
    const storedBefore = await fetchRollup(deviceA, DAY_ONE, TIME_ZONE, "cx-011-p1");

    nowMs = Date.parse("2026-03-06T00:00:00.000Z");
    await ingest.ingestObservations(deviceA, [
      observation("2026-03-01T10:00:00.000Z", { vehicle_ready: false }),
    ]);

    // Kein automatischer Hintergrundlauf: die gespeicherte Zeile bleibt zunaechst.
    expect(await fetchRollup(deviceA, DAY_ONE, TIME_ZONE, "cx-011-p1")).toEqual(
      storedBefore,
    );
    expect(storedBefore?.revision).toBe(1);

    const rerun = await rebuild(deviceA, DAY_ONE, "2026-03-02T12:00:00.000Z");
    expect(rerun.outcome).toBe("replaced");
    expect(rerun.rollup.revision).toBe(2);
    expect(rerun.rollup.inputFingerprint).not.toBe(
      first.rollup.inputFingerprint,
    );
    expect((await rawRows(deviceA)).length).toBe(2);
  });
});
