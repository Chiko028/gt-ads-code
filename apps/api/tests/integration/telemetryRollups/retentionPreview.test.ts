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
  previewRetention,
  type TelemetryRollupService,
} from "../../../src/modules/telemetryRollups/index.js";
import type { EvaluationPolicy } from "../../../src/modules/telemetryEvaluation/index.js";

const BASE_TIME = Date.parse("2026-03-02T00:30:00.000Z");
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../src/db/migrations",
);
const TIME_ZONE = "Europe/Berlin";
const EVALUATION_TIME = "2026-07-01T12:00:00.000Z";
const DAY_OLD = "2026-03-01";
const DAY_LATE = "2026-03-02";
const DAY_AFTER_LATE = "2026-03-03";
const DAY_INCOMPLETE = "2026-03-04";
const DAY_RECENT = "2026-06-15";

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let nowMs = BASE_TIME;
let ingest: TelemetryIngestService;
let rollups: TelemetryRollupService;
let registrationCodeId = "";

const deviceA = randomUUID();

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
      "SYN-CX-011-Retention-Geraet",
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

const policy: EvaluationPolicy = {
  policyVersion: "cx-011-retention-p1",
  maxObservationAgeSeconds: 3600,
  e36: { pauseResetOnVehicleOff: true, pauseMaxSeconds: null },
  e40: { displayRunOnSeconds: 5 },
};

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

async function ingestAt(
  now: string,
  occurredAt: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  nowMs = Date.parse(now);
  await ingest.ingestObservations(deviceA, [observation(occurredAt, overrides)]);
}

async function rebuild(
  localDate: string,
  evaluationTime: string,
): Promise<void> {
  await rollups.rebuildDay({
    deviceId: deviceA,
    localDate,
    timeZone: TIME_ZONE,
    policy,
    evaluationTime,
  });
}

async function seed(): Promise<void> {
  await ingestAt("2026-03-02T00:30:00.000Z", "2026-03-01T08:00:00.000Z");
  await rebuild(DAY_OLD, "2026-03-02T01:00:00.000Z");

  await ingestAt("2026-03-03T00:30:00.000Z", "2026-03-02T08:00:00.000Z");
  await rebuild(DAY_LATE, "2026-03-03T01:00:00.000Z");

  await ingestAt("2026-03-04T00:30:00.000Z", "2026-03-03T08:00:00.000Z");
  await rebuild(DAY_AFTER_LATE, "2026-03-04T01:00:00.000Z");

  await ingestAt("2026-03-04T12:30:00.000Z", "2026-03-04T08:00:00.000Z");
  await rebuild(DAY_INCOMPLETE, "2026-03-04T12:00:00.000Z");

  await ingestAt("2026-06-16T00:30:00.000Z", "2026-06-15T08:00:00.000Z");
  await rebuild(DAY_RECENT, "2026-06-16T01:00:00.000Z");

  // Verspaetetes Ereignis nach dem Rollup-Snapshot: der Fingerprint passt nicht
  // mehr, obwohl Ereignis- und Empfangszeit vor dem Horizont liegen.
  await ingestAt(
    "2026-03-20T00:30:00.000Z",
    "2026-03-02T12:00:00.000Z",
    { vehicle_ready: false },
  );
}

async function countRaw(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "select count(*)::text as count from telemetry_observations",
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function countRollups(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "select count(*)::text as count from telemetry_daily_rollups",
  );
  return Number(result.rows[0]?.count ?? "0");
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = ("gtads_cx011_ret_" + process.pid + "_" + Date.now().toString(36))
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
      Buffer.from("SYN-CX-011-retention-code"),
      "SYN-CX-011",
      new Date(BASE_TIME),
      "SYN-Test",
      new Date(BASE_TIME + 86_400_000),
    ],
  );
  await insertDevice(deviceA, "SYN-CX-011-Retention-Fingerprint");

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

describe("CX-011 Retention-Vorschau", () => {
  it("liefert ohne explizite Regel keine Kandidaten", async () => {
    await seed();
    const rawBefore = await countRaw();
    const rollupsBefore = await countRollups();

    const preview = await previewRetention({
      client: pool,
      evaluationTime: EVALUATION_TIME,
      timeZone: TIME_ZONE,
    });

    expect(preview.rule).toBeNull();
    expect(preview.horizonStart).toBeNull();
    expect(preview.candidates).toEqual([]);
    expect(preview.withheld).toEqual([]);
    expect(await countRaw()).toBe(rawBefore);
    expect(await countRollups()).toBe(rollupsBefore);
  });

  it("schlaegt mit 90-Tage-Regel nur alte, vollstaendig auswertbare Tage vor und loescht nichts", async () => {
    await seed();
    const rawBefore = await countRaw();
    const rollupsBefore = await countRollups();

    const preview = await previewRetention({
      client: pool,
      evaluationTime: EVALUATION_TIME,
      timeZone: TIME_ZONE,
      rule: { ruleVersion: "e22-draft-90", rawRetentionDays: 90 },
    });

    expect(preview.rule).toEqual({
      ruleVersion: "e22-draft-90",
      rawRetentionDays: 90,
    });
    expect(preview.horizonStart).toBe("2026-04-01T22:00:00.000Z");
    expect(preview.candidates.map((candidate) => candidate.localDate)).toEqual([
      DAY_OLD,
    ]);
    expect(preview.candidates[0]?.dayEnd).toBe("2026-03-01T23:00:00.000Z");
    expect(preview.candidates[0]?.rollups[0]?.revision).toBe(1);

    const withheld = new Map(
      preview.withheld.map((day) => [day.localDate, day.reasons]),
    );
    expect(withheld.get(DAY_LATE)).toContain("raw_fingerprint_mismatch");
    expect(withheld.get(DAY_INCOMPLETE)).toContain("rollup_before_day_end");
    expect(withheld.get(DAY_RECENT)).toContain("inside_retention_horizon");
    expect(withheld.get(DAY_RECENT)).toContain("raw_received_inside_horizon");

    // Die Vorschau ist keine Loeschfreigabe.
    expect(await countRaw()).toBe(rawBefore);
    expect(await countRollups()).toBe(rollupsBefore);
  });

  it("wertet kalenderbasierte Tagesgrenzen in der expliziten Zeitzone aus", async () => {
    await seed();

    const berlin = await previewRetention({
      client: pool,
      evaluationTime: EVALUATION_TIME,
      timeZone: "Europe/Berlin",
      rule: { ruleVersion: "r", rawRetentionDays: 90 },
    });
    const utc = await previewRetention({
      client: pool,
      evaluationTime: EVALUATION_TIME,
      timeZone: "UTC",
      rule: { ruleVersion: "r", rawRetentionDays: 90 },
    });

    expect(berlin.horizonStart).not.toBe(utc.horizonStart);
    expect(berlin.candidates[0]?.dayStart).toBe("2026-02-28T23:00:00.000Z");
  });

  it("weist ungueltige Retention-Regeln ab, ohne Datenbankinhalt zu veraendern", async () => {
    await seed();
    const rawBefore = await countRaw();

    await expect(
      previewRetention({
        client: pool,
        evaluationTime: EVALUATION_TIME,
        timeZone: TIME_ZONE,
        rule: { ruleVersion: "r", rawRetentionDays: 0 },
      }),
    ).rejects.toThrow(/positive Ganzzahl/);
    expect(await countRaw()).toBe(rawBefore);
  });
});
