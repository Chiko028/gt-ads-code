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
  classifyDay,
  type EvaluationPolicy,
} from "../../../src/modules/telemetryEvaluation/index.js";
import { RollupStorageError } from "../../../src/modules/telemetryRollups/index.js";
import {
  createTelemetryDayEvaluationService,
  DayEvaluationConfigError,
  DayNotCompletedError,
  type DayEvaluationConfiguration,
  type DayEvaluationResult,
  type TelemetryDayEvaluationService,
} from "../../../src/modules/telemetryDayEvaluation/index.js";

const BASE_TIME = Date.parse("2026-03-03T00:00:00.000Z");
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../src/db/migrations",
);
const TIME_ZONE = "Europe/Berlin";
const DAY_ONE = "2026-03-01";

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let nowMs = BASE_TIME;
let clockMs = BASE_TIME;
let ingest: TelemetryIngestService;
let evaluation: TelemetryDayEvaluationService;
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
    throw new Error("CX-047 benoetigt with-postgres <befehl>");
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
      "SYN-CX-047-Geraet",
      Buffer.from("SYN-CX-047-Key-" + fingerprint),
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

function policyA(): EvaluationPolicy {
  return {
    policyVersion: "cx-047-p1",
    maxObservationAgeSeconds: 3600,
    e36: { pauseResetOnVehicleOff: true, pauseMaxSeconds: 600 },
    e40: { displayRunOnSeconds: 5 },
  };
}

function policyB(): EvaluationPolicy {
  return {
    policyVersion: "cx-047-p2",
    maxObservationAgeSeconds: 900,
    e36: { pauseResetOnVehicleOff: false, pauseMaxSeconds: 120 },
    e40: { displayRunOnSeconds: 0 },
  };
}

function configA(): DayEvaluationConfiguration {
  return { timeZone: TIME_ZONE, policy: policyA() };
}

function configB(): DayEvaluationConfiguration {
  return { timeZone: TIME_ZONE, policy: policyB() };
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
  day_start: Date;
  day_end: Date;
  day_length_ms: string;
  policy_version: string;
  policy_canonical: Record<string, unknown>;
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
      "       day_start, day_end, day_length_ms::text as day_length_ms,",
      "       policy_version, policy_canonical, time_zone",
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

async function countRollupsFor(deviceId: string, localDate: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    [
      "select count(*)::text as count from telemetry_daily_rollups",
      " where device_id = $1 and local_date = $2::date",
    ].join(" "),
    [deviceId, localDate],
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function waitForBlockedAdvisoryLock(
  watcher: Pool,
  classId: number,
  objId: number,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const result = await watcher.query<{ count: string }>(
      [
        "select count(*)::text as count",
        "  from pg_locks",
        " where locktype = 'advisory'",
        "   and classid = $1::oid",
        "   and objid = $2::oid",
        "   and objsubid = 2",
        "   and not granted",
      ].join(" "),
      [classId, objId],
    );
    if (Number(result.rows[0]?.count ?? "0") > 0) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("CX-047 Wartelock wurde nicht erreicht.");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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

function evaluate(
  deviceId: string,
  localDate: string,
  configuration: DayEvaluationConfiguration,
): Promise<DayEvaluationResult> {
  return evaluation.evaluateDay({ deviceId, localDate, configuration });
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = ("gtads_cx047_" + process.pid + "_" + Date.now().toString(36))
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
      Buffer.from("SYN-CX-047-registration-code"),
      "SYN-CX-047",
      new Date(BASE_TIME),
      "SYN-Test",
      new Date(BASE_TIME + 86_400_000),
    ],
  );
  await insertDevice(deviceA, "SYN-CX-047-Fingerprint-A");
  await insertDevice(deviceB, "SYN-CX-047-Fingerprint-B");

  ingest = createTelemetryIngestService({ client: pool, now: () => new Date(nowMs) });
  evaluation = createTelemetryDayEvaluationService({
    client: pool,
    now: () => new Date(clockMs),
  });
}, 30_000);

beforeEach(async () => {
  nowMs = BASE_TIME;
  clockMs = BASE_TIME;
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

describe("CX-047 evaluateDay", () => {
  it("liest einen abgeschlossenen synthetischen Geraetetag, klassifiziert ihn und speichert genau ein Rollup", async () => {
    const version = await pool.query<{ version: string }>(
      "select current_setting('server_version_num') as version",
    );
    expect(Number(version.rows[0]?.version)).toBeGreaterThanOrEqual(170000);

    nowMs = Date.parse("2026-03-03T00:00:00.000Z");
    await ingest.ingestObservations(deviceA, [
      observation("2026-03-01T08:00:00.000Z"),
      observation("2026-03-01T09:30:00.000Z", { playback: "stopped" }),
    ]);

    clockMs = Date.parse("2026-03-02T12:00:00.000Z");
    const result = await evaluate(deviceA, DAY_ONE, configA());

    expect(result.deviceId).toBe(deviceA);
    expect(result.localDate).toBe(DAY_ONE);
    expect(result.timeZone).toBe(TIME_ZONE);
    expect(result.policyVersion).toBe("cx-047-p1");
    expect(result.status).toBe("created");
    expect(result.revision).toBe(1);
    expect(result.evaluationTime).toBe("2026-03-02T12:00:00.000Z");
    expect(result.rollup.dayStart).toBe("2026-02-28T23:00:00.000Z");
    expect(result.rollup.dayEnd).toBe("2026-03-01T23:00:00.000Z");
    expect(result.rollup.dayLengthMs).toBe(86_400_000);

    const expected = classifyDay({
      tabletId: deviceA,
      localDate: DAY_ONE,
      timeZone: TIME_ZONE,
      evaluatedAt: "2026-03-02T12:00:00.000Z",
      observations: [
        {
          eventId: randomUUID(),
          occurredAt: "2026-03-01T08:00:00.000Z",
          vehicleReady: true,
          paused: false,
          playback: "playing",
          technicalFault: false,
        },
        {
          eventId: randomUUID(),
          occurredAt: "2026-03-01T09:30:00.000Z",
          vehicleReady: true,
          paused: false,
          playback: "stopped",
          technicalFault: false,
        },
      ],
      policy: policyA(),
    });
    expect(result.rollup.classes).toEqual(expected.classes);
    expect(
      Object.values(result.rollup.classes).reduce((sum, value) => sum + value, 0),
    ).toBe(result.rollup.dayLengthMs);

    expect(await countRollups()).toBe(1);
    const stored = await fetchRollup(deviceA, DAY_ONE, TIME_ZONE, "cx-047-p1");
    expect(stored).not.toBeNull();
    expect(stored?.revision).toBe(1);
    expect(stored?.classes).toEqual(result.rollup.classes);
    expect(stored?.day_start.toISOString()).toBe("2026-02-28T23:00:00.000Z");
    expect(stored?.day_end.toISOString()).toBe("2026-03-01T23:00:00.000Z");
  });

  it("erzeugt bei Wiederholung und zwei parallelen Ausloesungen desselben Tages keine doppelten Aggregate", async () => {
    nowMs = Date.parse("2026-03-03T00:00:00.000Z");
    await ingest.ingestObservations(deviceA, [
      observation("2026-03-01T08:00:00.000Z"),
    ]);
    clockMs = Date.parse("2026-03-02T12:00:00.000Z");

    const first = await evaluate(deviceA, DAY_ONE, configA());
    const second = await evaluate(deviceA, DAY_ONE, configA());

    expect(first.status).toBe("created");
    expect(second.status).toBe("unchanged");
    expect(second.rollup.id).toBe(first.rollup.id);
    expect(second.revision).toBe(1);
    expect(await countRollupsFor(deviceA, DAY_ONE)).toBe(1);

    await ingest.ingestObservations(deviceB, [
      observation("2026-03-01T08:00:00.000Z"),
    ]);

    await pool.query(
      [
        "create or replace function cx047_slow_rollup_insert() returns trigger",
        "language plpgsql as $$",
        "begin",
        "  perform pg_sleep(0.1);",
        "  return new;",
        "end",
        "$$",
      ].join(" "),
    );
    await pool.query(
      "create trigger cx047_slow_rollup_insert_trigger before insert on telemetry_daily_rollups for each row execute function cx047_slow_rollup_insert()",
    );

    try {
      const parallel = await Promise.all([
        evaluate(deviceB, DAY_ONE, configA()),
        evaluate(deviceB, DAY_ONE, configA()),
      ]);
      const outcomes = parallel.map((entry) => entry.status).sort();
      expect(outcomes).toEqual(["created", "unchanged"]);
      expect(new Set(parallel.map((entry) => entry.rollup.id)).size).toBe(1);
      expect(new Set(parallel.map((entry) => entry.revision))).toEqual(
        new Set([1]),
      );
      expect(await countRollupsFor(deviceB, DAY_ONE)).toBe(1);
      expect(await countRollups()).toBe(2);
    } finally {
      await pool.query(
        "drop trigger if exists cx047_slow_rollup_insert_trigger on telemetry_daily_rollups",
      );
      await pool.query("drop function if exists cx047_slow_rollup_insert()");
    }
  });

  it("schuetzt bei konkurrierenden Auswertungen mit verspaetetem Ereignis den neuesten Datenstand", async () => {
    const olderEvaluationTime = Date.parse("2026-03-02T12:00:00.000Z");
    const newerEvaluationTime = Date.parse("2026-03-05T00:00:00.000Z");
    const gateClassId = 47047;
    const gateObjId = 1;

    nowMs = newerEvaluationTime;
    await ingest.ingestObservations(deviceB, [
      observation("2026-03-01T08:00:00.000Z"),
    ]);

    const olderEvaluation = createTelemetryDayEvaluationService({
      client: pool,
      now: () => new Date(olderEvaluationTime),
    });
    const newerEvaluation = createTelemetryDayEvaluationService({
      client: pool,
      now: () => new Date(newerEvaluationTime),
    });

    const gateClient = await pool.connect();
    let olderRun: Promise<DayEvaluationResult> | undefined;
    let newerRun: Promise<DayEvaluationResult> | undefined;

    try {
      // Die Sitzungssperre haelt den ersten Rollup-Insert an, bis der
      // verspaetete Datenstand geschrieben und die zweite Auswertung gestartet ist.
      await gateClient.query("select pg_advisory_lock(47047, 1)");
      await pool.query(
        [
          "create or replace function cx047_gate_rollup_insert() returns trigger",
          "language plpgsql as $$",
          "begin",
          "  perform pg_advisory_xact_lock(47047, 1);",
          "  return new;",
          "end",
          "$$",
        ].join(" "),
      );
      await pool.query(
        "create trigger cx047_gate_rollup_insert_trigger before insert on telemetry_daily_rollups for each row execute function cx047_gate_rollup_insert()",
      );

      olderRun = olderEvaluation.evaluateDay({
        deviceId: deviceB,
        localDate: DAY_ONE,
        configuration: configA(),
      });
      await waitForBlockedAdvisoryLock(pool, gateClassId, gateObjId);

      // Dieses Ereignis ist im bereits laufenden ersten Lauf nicht sichtbar.
      await ingest.ingestObservations(deviceB, [
        observation("2026-03-01T20:00:00.000Z", { paused: true }),
      ]);

      newerRun = newerEvaluation.evaluateDay({
        deviceId: deviceB,
        localDate: DAY_ONE,
        configuration: configA(),
      });

      await gateClient.query("select pg_advisory_unlock(47047, 1)");

      const older = await olderRun;
      const newer = await newerRun;

      expect(older.status).toBe("created");
      expect(older.revision).toBe(1);
      expect(newer.status).toBe("replaced");
      expect(newer.revision).toBe(older.revision + 1);

      const stored = await fetchRollup(deviceB, DAY_ONE, TIME_ZONE, "cx-047-p1");
      expect(stored).not.toBeNull();
      expect(stored?.revision).toBe(newer.revision);
      expect(stored?.revision).toBeGreaterThanOrEqual(older.revision);
      expect(stored?.classes).toEqual(newer.rollup.classes);
      expect(stored?.classes).not.toEqual(older.rollup.classes);

      const expected = classifyDay({
        tabletId: deviceB,
        localDate: DAY_ONE,
        timeZone: TIME_ZONE,
        evaluatedAt: new Date(newerEvaluationTime).toISOString(),
        observations: [
          {
            eventId: randomUUID(),
            occurredAt: "2026-03-01T08:00:00.000Z",
            vehicleReady: true,
            paused: false,
            playback: "playing",
            technicalFault: false,
          },
          {
            eventId: randomUUID(),
            occurredAt: "2026-03-01T20:00:00.000Z",
            vehicleReady: true,
            paused: true,
            playback: "playing",
            technicalFault: false,
          },
        ],
        policy: policyA(),
      });
      expect(stored?.classes).toEqual(expected.classes);
      expect(stored?.classes.paused_conscious).toBe(10 * 60 * 1000);
      expect(await countRollupsFor(deviceB, DAY_ONE)).toBe(1);

      // Auch ein danach gestarteter Lauf mit aelterem Auswertungszeitpunkt
      // darf das neuere Ergebnis weder ersetzen noch die Revision senken.
      const stale = await olderEvaluation.evaluateDay({
        deviceId: deviceB,
        localDate: DAY_ONE,
        configuration: configA(),
      });
      expect(stale.status).toBe("stale");
      expect(stale.revision).toBe(newer.revision);
      expect(await fetchRollup(deviceB, DAY_ONE, TIME_ZONE, "cx-047-p1")).toEqual(
        stored,
      );
    } finally {
      try {
        await gateClient.query("select pg_advisory_unlock(47047, 1)");
      } catch {
        // Die Verbindung wird ohnehin freigegeben.
      }
      gateClient.release();
      if (olderRun !== undefined) {
        await olderRun.catch(() => undefined);
      }
      if (newerRun !== undefined) {
        await newerRun.catch(() => undefined);
      }
      await pool.query(
        "drop trigger if exists cx047_gate_rollup_insert_trigger on telemetry_daily_rollups",
      );
      await pool.query("drop function if exists cx047_gate_rollup_insert()");
    }
  });

  it("korrigiert nach einem verspaeteten Ereignis ueber CX-011, laesst das Ergebnis bei einem Persistenzfehler unveraendert und loescht keine Rohdaten", async () => {
    nowMs = Date.parse("2026-03-03T00:00:00.000Z");
    await ingest.ingestObservations(deviceA, [
      observation("2026-03-01T08:00:00.000Z"),
    ]);
    clockMs = Date.parse("2026-03-02T12:00:00.000Z");

    const first = await evaluate(deviceA, DAY_ONE, configA());
    expect(first.status).toBe("created");
    const storedBefore = await fetchRollup(deviceA, DAY_ONE, TIME_ZONE, "cx-047-p1");
    const rawBefore = await rawRows(deviceA);
    expect(rawBefore.length).toBe(1);

    nowMs = Date.parse("2026-03-05T00:00:00.000Z");
    clockMs = Date.parse("2026-03-05T00:00:00.000Z");
    await ingest.ingestObservations(deviceA, [
      observation("2026-03-01T20:00:00.000Z", { paused: true }),
    ]);
    const rawAfterIngest = await rawRows(deviceA);
    expect(rawAfterIngest.length).toBe(rawBefore.length + 1);

    await pool.query(
      [
        "create or replace function cx047_fail_rollup_update() returns trigger",
        "language plpgsql as $$",
        "begin",
        "  raise exception 'CX-047 synthetischer Rollup-Fehler';",
        "end",
        "$$",
      ].join(" "),
    );
    await pool.query(
      "create trigger cx047_fail_rollup_update_trigger before update on telemetry_daily_rollups for each row execute function cx047_fail_rollup_update()",
    );

    try {
      await expect(evaluate(deviceA, DAY_ONE, configA())).rejects.toBeInstanceOf(
        RollupStorageError,
      );
      expect(await fetchRollup(deviceA, DAY_ONE, TIME_ZONE, "cx-047-p1")).toEqual(
        storedBefore,
      );
      expect(await countRollupsFor(deviceA, DAY_ONE)).toBe(1);
      expect(await rawRows(deviceA)).toEqual(rawAfterIngest);
    } finally {
      await pool.query(
        "drop trigger if exists cx047_fail_rollup_update_trigger on telemetry_daily_rollups",
      );
      await pool.query("drop function if exists cx047_fail_rollup_update()");
    }

    const retry = await evaluate(deviceA, DAY_ONE, configA());
    expect(retry.status).toBe("replaced");
    expect(retry.revision).toBe(first.revision + 1);
    expect(retry.rollup.inputFingerprint).not.toBe(first.rollup.inputFingerprint);
    expect(retry.rollup.classes).not.toEqual(first.rollup.classes);
    expect(await countRollupsFor(deviceA, DAY_ONE)).toBe(1);
    expect(await rawRows(deviceA)).toEqual(rawAfterIngest);
  });

  it("prueft Tagesgrenzen inklusive Sommerzeit, zwei explizite E36/E40-Konfigurationen und fehlende Pflichtkonfiguration", async () => {
    const boundaryCases = [
      {
        localDate: "2026-03-01",
        dayStart: "2026-02-28T23:00:00.000Z",
        dayEnd: "2026-03-01T23:00:00.000Z",
        dayLengthMs: 86_400_000,
      },
      {
        localDate: "2026-03-29",
        dayStart: "2026-03-28T23:00:00.000Z",
        dayEnd: "2026-03-29T22:00:00.000Z",
        dayLengthMs: 23 * 3_600_000,
      },
      {
        localDate: "2026-10-25",
        dayStart: "2026-10-24T22:00:00.000Z",
        dayEnd: "2026-10-25T23:00:00.000Z",
        dayLengthMs: 25 * 3_600_000,
      },
    ];

    for (const boundary of boundaryCases) {
      nowMs = Date.parse(boundary.dayEnd) + 2 * 3_600_000;
      clockMs = Date.parse(boundary.dayEnd) + 3_600_000;
      await ingest.ingestObservations(deviceA, [
        observation(boundary.dayStart),
      ]);

      const result = await evaluate(deviceA, boundary.localDate, configA());
      expect(result.status, boundary.localDate).toBe("created");
      expect(result.rollup.dayStart, boundary.localDate).toBe(boundary.dayStart);
      expect(result.rollup.dayEnd, boundary.localDate).toBe(boundary.dayEnd);
      expect(result.rollup.dayLengthMs, boundary.localDate).toBe(
        boundary.dayLengthMs,
      );
      expect(
        Object.values(result.rollup.classes).reduce(
          (sum, value) => sum + value,
          0,
        ),
        boundary.localDate,
      ).toBe(boundary.dayLengthMs);

      const stored = await fetchRollup(
        deviceA,
        boundary.localDate,
        TIME_ZONE,
        "cx-047-p1",
      );
      expect(stored?.day_start.toISOString(), boundary.localDate).toBe(
        boundary.dayStart,
      );
      expect(stored?.day_end.toISOString(), boundary.localDate).toBe(
        boundary.dayEnd,
      );
    }
    expect(await countRollupsFor(deviceA, "2026-03-01")).toBe(1);

    // Zwei explizite E36/E40-Konfigurationen erreichen CX-011 unveraendert.
    const configDay = "2026-03-02";
    nowMs = Date.parse("2026-03-04T00:00:00.000Z");
    clockMs = Date.parse("2026-03-03T12:00:00.000Z");
    await ingest.ingestObservations(deviceB, [
      observation("2026-03-02T08:00:00.000Z", {
        vehicle_ready: false,
        paused: true,
      }),
    ]);

    const withA = await evaluate(deviceB, configDay, configA());
    const withB = await evaluate(deviceB, configDay, configB());
    expect(withA.status).toBe("created");
    expect(withB.status).toBe("created");
    expect(withA.policyVersion).toBe("cx-047-p1");
    expect(withB.policyVersion).toBe("cx-047-p2");
    expect(withA.rollup.inputFingerprint).not.toBe(withB.rollup.inputFingerprint);
    expect(await countRollupsFor(deviceB, configDay)).toBe(2);

    const storedA = await fetchRollup(deviceB, configDay, TIME_ZONE, "cx-047-p1");
    const storedB = await fetchRollup(deviceB, configDay, TIME_ZONE, "cx-047-p2");
    expect(storedA?.policy_canonical).toEqual(policyA());
    expect(storedB?.policy_canonical).toEqual(policyB());

    // Fehlende Pflichtkonfiguration erzeugt einen Konfigurationsfehler und kein Rollup.
    const missingConfigDay = "2026-03-04";
    clockMs = Date.parse("2026-03-05T12:00:00.000Z");
    const brokenConfig = {
      timeZone: TIME_ZONE,
      policy: {
        policyVersion: "cx-047-missing",
        maxObservationAgeSeconds: 3600,
        e36: { pauseResetOnVehicleOff: true, pauseMaxSeconds: null },
      },
    } as unknown as DayEvaluationConfiguration;
    await expect(
      evaluate(deviceA, missingConfigDay, brokenConfig),
    ).rejects.toBeInstanceOf(DayEvaluationConfigError);
    expect(await countRollupsFor(deviceA, missingConfigDay)).toBe(0);

    // Ein noch nicht abgeschlossener Tag wird ebenfalls nicht geschrieben.
    const openDay = "2026-03-05";
    clockMs = Date.parse("2026-03-05T12:00:00.000Z");
    await expect(evaluate(deviceA, openDay, configA())).rejects.toBeInstanceOf(
      DayNotCompletedError,
    );
    expect(await countRollupsFor(deviceA, openDay)).toBe(0);
  });

  it("uebernimmt einen noch gueltigen Zustand von vor Tagesbeginn an einer Sommerzeitgrenze", async () => {
    const localDate = "2026-03-29";
    nowMs = Date.parse("2026-03-30T00:00:00.000Z");
    clockMs = Date.parse("2026-03-30T12:00:00.000Z");

    await ingest.ingestObservations(deviceA, [
      observation("2026-03-28T22:59:00.000Z", {
        vehicle_ready: false,
        paused: false,
      }),
      observation("2026-03-29T01:30:00.000Z"),
    ]);

    const result = await evaluate(deviceA, localDate, configA());
    expect(result.status).toBe("created");
    expect(result.rollup.dayStart).toBe("2026-03-28T23:00:00.000Z");
    expect(result.rollup.dayEnd).toBe("2026-03-29T22:00:00.000Z");
    expect(result.rollup.dayLengthMs).toBe(23 * 3_600_000);

    // Der Zustand von 22:59 UTC gilt ab Tagesbeginn 23:00 UTC noch bis
    // 23:59 UTC; danach ist der Tag bis zur naechsten Beobachtung unbekannt.
    expect(result.rollup.classes.vehicle_off_expected).toBe(59 * 60 * 1000);
    expect(result.rollup.classes.healthy).toBe(3_600_000);
    expect(result.rollup.classes.paused_conscious).toBe(0);
    expect(result.rollup.classes.technical_fault).toBe(0);
    expect(
      Object.values(result.rollup.classes).reduce(
        (sum, value) => sum + value,
        0,
      ),
    ).toBe(result.rollup.dayLengthMs);

    const expected = classifyDay({
      tabletId: deviceA,
      localDate,
      timeZone: TIME_ZONE,
      evaluatedAt: new Date(clockMs).toISOString(),
      observations: [
        {
          eventId: randomUUID(),
          occurredAt: "2026-03-28T22:59:00.000Z",
          vehicleReady: false,
          paused: false,
          playback: "playing",
          technicalFault: false,
        },
        {
          eventId: randomUUID(),
          occurredAt: "2026-03-29T01:30:00.000Z",
          vehicleReady: true,
          paused: false,
          playback: "playing",
          technicalFault: false,
        },
      ],
      policy: policyA(),
    });
    expect(result.rollup.classes).toEqual(expected.classes);

    const stored = await fetchRollup(deviceA, localDate, TIME_ZONE, "cx-047-p1");
    expect(stored?.classes).toEqual(result.rollup.classes);
    expect(stored?.day_start.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(stored?.day_end.toISOString()).toBe("2026-03-29T22:00:00.000Z");
  });

});
