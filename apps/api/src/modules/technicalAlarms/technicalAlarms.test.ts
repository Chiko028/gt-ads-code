import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  TECHNICAL_ALARM_OPENED_ACTION,
  TECHNICAL_ALARM_OPENED_AUDIT_FIELDS,
  TECHNICAL_ALARM_RESOLVED_ACTION,
  TECHNICAL_ALARM_RESOLVED_AUDIT_FIELDS,
  createTechnicalAlarmService,
  type TechnicalAlarmEvaluationInput,
  type TechnicalAlarmService,
} from "./index.js";

const BASE_TIME = Date.parse("2026-08-01T00:00:00.000Z");
const MIN_DURATION_SECONDS = 300;
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);
const UP_MIGRATION = "0006_cx_028_technical_alarms.up.sql";
const DOWN_MIGRATION = "0006_cx_028_technical_alarms.down.sql";
const MIGRATIONS = [
  "0001_gt_ads_001.up.sql",
  "0002_gt_ads_004_telemetry.up.sql",
  "0003_cx_011_telemetry_rollups.up.sql",
  "0004_cx_012_remote_control.up.sql",
  "0005_cx_013_control_config.up.sql",
  UP_MIGRATION,
];

interface Counts {
  state: number;
  episodes: number;
  outbox: number;
  audit: number;
  open: number;
}

interface EpisodeSnapshot {
  episode_id: string;
  resource_id: string;
  status: string;
  error_code: string;
  fault_started_at: Date;
  resolved_at: Date | null;
}

interface OutboxSnapshot {
  status: string;
  attempt_count: number;
  next_attempt_at: Date | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  last_error_code: string | null;
}

interface AuditSnapshot {
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
}

let maintenancePool: Pool | null = null;
let pool: Pool | null = null;
let databaseName = "";
let nowMs = BASE_TIME;
let service: TechnicalAlarmService;

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
    throw new Error("CX-028 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

async function readMigration(name: string): Promise<string> {
  return readFile(join(MIGRATIONS_DIR, name), "utf8");
}

function makeService(overrides: {
  auditWriter?: (executor: Parameters<NonNullable<Parameters<typeof createTechnicalAlarmService>[0]["auditWriter"]>>[0], event: Parameters<NonNullable<Parameters<typeof createTechnicalAlarmService>[0]["auditWriter"]>>[1]) => Promise<void>;
} = {}): TechnicalAlarmService {
  return createTechnicalAlarmService({
    pool: pool as Pool,
    minDurationSeconds: MIN_DURATION_SECONDS,
    now: () => new Date(nowMs),
    ...overrides,
  });
}

function input(
  version: number,
  evaluationId: string,
  classification: TechnicalAlarmEvaluationInput["classification"],
  resourceId = "SYN-CX-028-RESOURCE",
): TechnicalAlarmEvaluationInput {
  return {
    resourceId,
    evaluationId,
    evaluationVersion: version,
    classification,
  };
}

async function counts(): Promise<Counts> {
  const result = await (pool as Pool).query<Counts>(
    [
      "select",
      "  (select count(*) from technical_alarm_resource_state)::int as state,",
      "  (select count(*) from technical_alarm_episodes)::int as episodes,",
      "  (select count(*) from technical_alarm_outbox)::int as outbox,",
      "  (select count(*) from audit_events)::int as audit,",
      "  (select count(*) from technical_alarm_episodes where status = 'open')::int as open",
    ].join("\n"),
  );
  return result.rows[0];
}

async function episodes(): Promise<EpisodeSnapshot[]> {
  const result = await (pool as Pool).query<EpisodeSnapshot>(
    [
      "select episode_id::text as episode_id, resource_id, status, error_code,",
      "       fault_started_at, resolved_at",
      "  from technical_alarm_episodes",
      " order by episode_id",
    ].join("\n"),
  );
  return result.rows;
}

async function outbox(): Promise<OutboxSnapshot[]> {
  const result = await (pool as Pool).query<OutboxSnapshot>(
    [
      "select status, attempt_count, next_attempt_at, lease_owner,",
      "       lease_expires_at, last_error_code",
      "  from technical_alarm_outbox",
      " order by outbox_id",
    ].join("\n"),
  );
  return result.rows;
}

async function latestAudit(action: string): Promise<AuditSnapshot> {
  const result = await (pool as Pool).query<AuditSnapshot>(
    [
      "select action, target_type, target_id, details",
      "  from audit_events",
      " where action = $1",
      " order by id desc",
      " limit 1",
    ].join("\n"),
    [action],
  );
  return result.rows[0];
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = ("gtads_cx028_" + process.pid + "_" + Date.now().toString(36))
    .toLowerCase()
    .slice(0, 63);
  await maintenancePool.query("create database " + quoteIdentifier(databaseName));

  pool = new Pool({ ...base, database: databaseName });
  try {
    for (const migration of MIGRATIONS) {
      await pool.query(await readMigration(migration));
    }
  } catch (error) {
    await pool.end();
    pool = null;
    throw error;
  }
}, 30_000);

afterAll(async () => {
  try {
    if (pool !== null) {
      await pool.end();
    }
  } finally {
    try {
      if (maintenancePool !== null && databaseName !== "") {
        await maintenancePool.query(
          "drop database if exists " + quoteIdentifier(databaseName),
        );
      }
    } finally {
      if (maintenancePool !== null) {
        await maintenancePool.end();
      }
    }
  }
});

beforeEach(async () => {
  await (pool as Pool).query(
    [
      "truncate table technical_alarm_outbox,",
      "  technical_alarm_episodes, technical_alarm_resource_state",
      "  restart identity",
    ].join(" "),
  );
  await (pool as Pool).query("delete from audit_events");
  nowMs = BASE_TIME;
  service = makeService();
});

describe("CX-028 dauerhafte Alarmepisoden", () => {
  it("erzeugt fuer nichttechnische Ergebnisse keine Episode und alarmiert genau an der Mindestdauer", async () => {
    const resourceId = "SYN-CX-028-R1";
    let version = 1;

    for (const outcome of [
      "healthy",
      "paused_conscious",
      "vehicle_off_expected",
      "unknown",
    ] as const) {
      nowMs = BASE_TIME + version * 1000;
      const result = await service.evaluate(
        input(version, "nontechnical-" + version, { outcome }, resourceId),
      );
      expect(result.outcome).toBe("no_change");
      version += 1;
    }

    // Fehlender Heartbeat ist CX-010 "unknown", kein technischer Fehler.
    nowMs = BASE_TIME + 10_000;
    const missingHeartbeat = await service.evaluate(
      input(version, "missing-heartbeat", { outcome: "unknown" }, resourceId),
    );
    expect(missingHeartbeat.outcome).toBe("no_change");
    expect(await counts()).toMatchObject({
      state: 1,
      episodes: 0,
      outbox: 0,
      audit: 0,
      open: 0,
    });
    version += 1;

    nowMs = BASE_TIME + 299_999;
    const beforeThreshold = await service.evaluate(
      input(
        version,
        "technical-before-threshold",
        {
          outcome: "technical_fault",
          errorCode: "player_error",
          faultStartedAt: new Date(BASE_TIME),
        },
        resourceId,
      ),
    );
    expect(beforeThreshold.outcome).toBe("no_change");
    expect(await counts()).toMatchObject({
      episodes: 0,
      outbox: 0,
      audit: 0,
    });
    version += 1;

    nowMs = BASE_TIME + 300_000;
    const atThreshold = await service.evaluate(
      input(
        version,
        "technical-at-threshold",
        {
          outcome: "technical_fault",
          errorCode: "player_error",
          faultStartedAt: new Date(BASE_TIME),
        },
        resourceId,
      ),
    );
    expect(atThreshold.outcome).toBe("opened");
    expect(atThreshold.episode).not.toBeNull();
    expect(atThreshold.deliveryOrder).not.toBeNull();
    expect(await counts()).toMatchObject({
      state: 1,
      episodes: 1,
      outbox: 1,
      audit: 1,
      open: 1,
    });

    const storedOutbox = await outbox();
    expect(storedOutbox).toHaveLength(1);
    expect(storedOutbox[0]).toMatchObject({
      status: "pending",
      attempt_count: 0,
      lease_owner: null,
      lease_expires_at: null,
      last_error_code: null,
    });
    expect(storedOutbox[0].next_attempt_at).not.toBeNull();
  });

  it("erzeugt bei parallelen, wiederholten und aelteren Auswertungen nur eine Episode", async () => {
    const resourceId = "SYN-CX-028-R2";
    nowMs = BASE_TIME + 300_000;
    const concurrentInput = input(
      1,
      "parallel-evaluation",
      {
        outcome: "technical_fault",
        errorCode: "storage_full",
        faultStartedAt: new Date(BASE_TIME),
      },
      resourceId,
    );

    const [first, second] = await Promise.all([
      service.evaluate(concurrentInput),
      makeService().evaluate(concurrentInput),
    ]);
    expect([first.outcome, second.outcome].sort()).toEqual(["opened", "stale"]);

    // Eine neue Serviceinstanz mit derselben Datenbank sieht nur den
    // dauerhaften Zustand; eine Wiederholung bleibt wirkungslos.
    const replay = await makeService().evaluate(concurrentInput);
    expect(replay.outcome).toBe("stale");

    // Eine aeltere Version (auch mit gesundem Ergebnis) veraendert nichts.
    const older = await service.evaluate(
      input(1, "older-healthy", { outcome: "healthy" }, resourceId),
    );
    expect(older.outcome).toBe("stale");

    expect(await counts()).toMatchObject({
      state: 1,
      episodes: 1,
      outbox: 1,
      audit: 1,
      open: 1,
    });
  });

  it("schliesst bei Erholung ohne weitere Alarmnachricht und eroeffnet spaeter eine neue Episode", async () => {
    const resourceId = "SYN-CX-028-R3";
    nowMs = BASE_TIME + 300_000;
    const opened = await service.evaluate(
      input(
        1,
        "first-fault",
        {
          outcome: "technical_fault",
          errorCode: "overheat",
          faultStartedAt: new Date(BASE_TIME),
        },
        resourceId,
      ),
    );
    expect(opened.outcome).toBe("opened");
    const firstEpisodeId = opened.episode?.episodeId;
    expect(firstEpisodeId).toBeDefined();

    nowMs = BASE_TIME + 400_000;
    const resolved = await service.evaluate(
      input(2, "recovery", { outcome: "healthy" }, resourceId),
    );
    expect(resolved.outcome).toBe("resolved");
    expect(await counts()).toMatchObject({
      episodes: 1,
      outbox: 1,
      audit: 2,
      open: 0,
    });

    const firstStored = await episodes();
    expect(firstStored[0].status).toBe("resolved");
    expect(firstStored[0].resolved_at).not.toBeNull();

    nowMs = BASE_TIME + 800_000;
    const secondFault = await service.evaluate(
      input(
        3,
        "second-fault",
        {
          outcome: "technical_fault",
          errorCode: "overheat",
          faultStartedAt: new Date(BASE_TIME + 500_000),
        },
        resourceId,
      ),
    );
    expect(secondFault.outcome).toBe("opened");
    expect(secondFault.episode?.episodeId).not.toBe(firstEpisodeId);
    expect(await counts()).toMatchObject({
      episodes: 2,
      outbox: 2,
      audit: 3,
      open: 1,
    });
  });

  it("rollt bei Auditfehler zurueck, migriert vorwaerts/rueckwaerts und speichert nur freigegebene Ereignisfelder", async () => {
    const resourceId = "SYN-CX-028-R4";
    nowMs = BASE_TIME + 300_000;
    const failingService = makeService({
      auditWriter: async () => {
        throw new Error("SYN-CX-028 Auditfehler");
      },
    });
    await expect(
      failingService.evaluate(
        input(
          1,
          "audit-failure",
          {
            outcome: "technical_fault",
            errorCode: "sync_error",
            faultStartedAt: new Date(BASE_TIME),
          },
          resourceId,
        ),
      ),
    ).rejects.toThrow(/SYN-CX-028 Auditfehler/);
    expect(await counts()).toMatchObject({
      state: 0,
      episodes: 0,
      outbox: 0,
      audit: 0,
      open: 0,
    });

    const opened = await service.evaluate(
      input(
        1,
        "audit-success",
        {
          outcome: "technical_fault",
          errorCode: "sync_error",
          faultStartedAt: new Date(BASE_TIME),
        },
        resourceId,
      ),
    );
    expect(opened.outcome).toBe("opened");
    const openedAudit = await latestAudit(TECHNICAL_ALARM_OPENED_ACTION);
    expect(openedAudit.target_type).toBe("technical_alarm_episode");
    expect(openedAudit.target_id).toBe(String(opened.episode?.episodeId));
    expect(Object.keys(openedAudit.details).sort()).toEqual(
      [...TECHNICAL_ALARM_OPENED_AUDIT_FIELDS].sort(),
    );
    expect(openedAudit.details).not.toHaveProperty("classification");
    expect(openedAudit.details).not.toHaveProperty("observations");
    expect(openedAudit.details).not.toHaveProperty("payload");

    nowMs = BASE_TIME + 400_000;
    const resolved = await service.evaluate(
      input(2, "audit-recovery", { outcome: "healthy" }, resourceId),
    );
    expect(resolved.outcome).toBe("resolved");
    const resolvedAudit = await latestAudit(TECHNICAL_ALARM_RESOLVED_ACTION);
    expect(Object.keys(resolvedAudit.details).sort()).toEqual(
      [...TECHNICAL_ALARM_RESOLVED_AUDIT_FIELDS].sort(),
    );

    const schema = "cx028_migration_" + process.pid + "_" + randomUUID().slice(0, 8);
    const upSql = await readMigration(UP_MIGRATION);
    const downSql = await readMigration(DOWN_MIGRATION);
    const migrationClient = await (pool as Pool).connect();
    try {
      await migrationClient.query("create schema " + quoteIdentifier(schema));
      await migrationClient.query("set search_path to " + quoteIdentifier(schema));
      await migrationClient.query(upSql);

      for (const table of [
        "technical_alarm_resource_state",
        "technical_alarm_episodes",
        "technical_alarm_outbox",
      ]) {
        const found = await migrationClient.query<{ name: string | null }>(
          "select to_regclass($1)::text as name",
          [schema + "." + table],
        );
        expect(found.rows[0].name).not.toBeNull();
      }

      await migrationClient.query(downSql);
      for (const table of [
        "technical_alarm_resource_state",
        "technical_alarm_episodes",
        "technical_alarm_outbox",
      ]) {
        const found = await migrationClient.query<{ name: string | null }>(
          "select to_regclass($1)::text as name",
          [schema + "." + table],
        );
        expect(found.rows[0].name).toBeNull();
      }

      await migrationClient.query(upSql);
      const again = await migrationClient.query<{ name: string | null }>(
        "select to_regclass($1)::text as name",
        [schema + ".technical_alarm_resource_state"],
      );
      expect(again.rows[0].name).not.toBeNull();
    } finally {
      try {
        await migrationClient.query("set search_path to public");
        await migrationClient.query(
          "drop schema if exists " + quoteIdentifier(schema) + " cascade",
        );
      } finally {
        migrationClient.release();
      }
    }
  });
});
