/**
 * CX-060 / R-701: echte Episodenpersistenz fuer die schmale
 * Betriebsverdrahtung. Der Test nutzt den echten CX-028-Service gegen eine
 * temporaere PostgreSQL-17-Datenbank und einen austauschbaren Telegram-Port.
 *
 * Bewusste Grenzen: Es werden vier Verhaltensfaelle geprueft; Backup- und
 * Readiness-Kerne werden importiert, nicht nachgebaut.
 */
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
import {
  OPERATIONS_ALARM_PERSISTENCE_ERROR,
  OPERATIONS_BACKUP_EPISODE_KEY,
  OPERATIONS_READINESS_KEY_PREFIX,
  createOperationsAlarmAdapter,
  type OperationsAlarmAdapter,
} from "../../../src/http/operationsAlarmAdapter.js";
import type { ReadinessProbe } from "../../../src/modules/operations/readiness.js";
import {
  createTechnicalAlarmService,
  type AlarmDeliveryMessage,
  type AlarmSendOutcome,
  type AlarmSender,
  type TechnicalAlarmService,
} from "../../../src/modules/technicalAlarms/index.js";

const BASE_TIME = Date.parse("2026-09-01T00:00:00.000Z");
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../src/db/migrations",
);
const MIGRATIONS = [
  "0001_gt_ads_001.up.sql",
  "0002_gt_ads_004_telemetry.up.sql",
  "0003_cx_011_telemetry_rollups.up.sql",
  "0004_cx_012_remote_control.up.sql",
  "0005_cx_013_control_config.up.sql",
  "0006_cx_028_technical_alarms.up.sql",
];

interface EpisodeRow {
  resource_id: string;
  status: string;
  error_code: string;
  resolved_at: Date | null;
}

let maintenancePool: Pool | null = null;
let pool: Pool | null = null;
let databaseName = "";
let nowMs = BASE_TIME;
let readinessFails = false;

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
    throw new Error("CX-060 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

async function readMigration(name: string): Promise<string> {
  return readFile(join(MIGRATIONS_DIR, name), "utf8");
}

async function episodes(): Promise<EpisodeRow[]> {
  const result = await (pool as Pool).query<EpisodeRow>(
    [
      "select resource_id, status, error_code, resolved_at",
      "  from technical_alarm_episodes",
      " order by episode_id",
    ].join("\n"),
  );
  return result.rows;
}

async function outbox(): Promise<Array<{ status: string; last_error_code: string | null }>> {
  const result = await (pool as Pool).query<{
    status: string;
    last_error_code: string | null;
  }>(
    [
      "select status, last_error_code",
      "  from technical_alarm_outbox",
      " order by outbox_id",
    ].join("\n"),
  );
  return result.rows;
}

const readyProbe: ReadinessProbe = {
  async check(): Promise<void> {
    return undefined;
  },
};

const failingProbe: ReadinessProbe = {
  async check(): Promise<void> {
    throw new Error("postgres://user:secret@db.internal:5432/gt_ads");
  },
};

function recordingSender(): AlarmSender & { messages: AlarmDeliveryMessage[] } {
  const messages: AlarmDeliveryMessage[] = [];
  return {
    messages,
    async send(message: AlarmDeliveryMessage): Promise<AlarmSendOutcome> {
      messages.push(message);
      return { kind: "sent" };
    },
  };
}

function failingTelegramSender(): AlarmSender {
  return {
    async send(): Promise<AlarmSendOutcome> {
      throw new Error("telegram://bot SYN-SECRET-TOKEN chat 4242");
    },
  };
}

function makeAdapter(overrides: {
  probe?: ReadinessProbe;
  sender?: AlarmSender | null;
  service?: TechnicalAlarmService;
  component?: string;
} = {}): OperationsAlarmAdapter {
  return createOperationsAlarmAdapter({
    pool: pool as Pool,
    readiness: overrides.probe ?? readyProbe,
    alarmService: overrides.service,
    readinessComponent: overrides.component,
    sender: overrides.sender ?? null,
    now: () => new Date(nowMs),
    reportTimeoutMs: 4000,
  });
}

function completedBackup(input: {
  success: boolean;
  startedAtMs: number;
  sha: string;
  errorCode?: string;
}): Record<string, unknown> {
  return {
    success: input.success,
    startedAt: new Date(input.startedAtMs).toISOString(),
    artifactSha256: input.sha,
    restoreDurationMs: 25,
    verificationPassed: input.success,
    cleanupSucceeded: true,
    ...(input.errorCode === undefined
      ? {}
      : { error: { code: input.errorCode, message: "SYN-ROHFEHLER" } }),
  };
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx060_" +
    process.pid +
    "_" +
    Date.now().toString(36)
  )
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
  readinessFails = false;
});

describe("CX-060 Betriebsverdrahtung mit echter Episodenpersistenz", () => {
  it("eroeffnet fuer einen Readiness-Fehler genau eine Episode und schliesst sie nach erfolgreicher Pruefung", async () => {
    const sender = recordingSender();
    const adapter = makeAdapter({
      probe: {
        async check(): Promise<void> {
          if (readinessFails) {
            throw new Error("readiness_probe_failed");
          }
        },
      },
      sender,
    });

    readinessFails = true;
    const first = await adapter.checkReadiness();
    expect(first.ready).toBe(false);
    expect(first.alarm.outcome).toBe("opened");
    expect(first.alarm.delivery.status).toBe("sent");
    expect(sender.messages).toHaveLength(1);
    expect(sender.messages[0]?.errorCode).toBe("readiness_check_failed");

    const afterFirst = await episodes();
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]?.resource_id.startsWith(OPERATIONS_READINESS_KEY_PREFIX)).toBe(true);
    expect(afterFirst[0]?.status).toBe("open");

    readinessFails = true;
    const second = await adapter.checkReadiness();
    expect(second.ready).toBe(false);
    expect(second.alarm.outcome).toBe("existing_open");
    expect(second.alarm.delivery.status).toBe("not_required");
    expect(sender.messages).toHaveLength(1);
    expect(await episodes()).toHaveLength(1);
    expect(await outbox()).toHaveLength(1);

    readinessFails = false;
    const third = await adapter.checkReadiness();
    expect(third.ready).toBe(true);
    expect(third.alarm.outcome).toBe("resolved");

    const afterResolve = await episodes();
    expect(afterResolve).toHaveLength(1);
    expect(afterResolve[0]?.status).toBe("resolved");
    expect(afterResolve[0]?.resolved_at).not.toBeNull();
  });

  it("eroeffnet fuer einen gescheiterten Backup-Nachweis eine getrennte Episode ohne Doppelalarm und loest sie spaeter auf", async () => {
    const sender = recordingSender();
    const adapter = makeAdapter({ sender });

    const failedRun = completedBackup({
      success: false,
      startedAtMs: nowMs - 5000,
      sha: "a".repeat(64),
      errorCode: "verification_failed",
    });

    const first = await adapter.processBackupResult(failedRun);
    expect(first.processed).toBe(true);
    expect(first.ok).toBe(false);
    expect(first.alarm?.outcome).toBe("opened");
    expect(first.alarm?.delivery.status).toBe("sent");
    expect(sender.messages).toHaveLength(1);

    const afterFirst = await episodes();
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]?.resource_id).toBe(OPERATIONS_BACKUP_EPISODE_KEY);
    expect(afterFirst[0]?.resource_id).not.toBe(
      OPERATIONS_READINESS_KEY_PREFIX + "postgres",
    );
    expect(afterFirst[0]?.error_code).toBe("verification_failed");

    const repeated = await adapter.processBackupResult(failedRun);
    expect(repeated.processed).toBe(true);
    expect(repeated.ok).toBe(false);
    expect(repeated.alarm?.outcome).toBe("stale");
    expect(repeated.alarm?.delivery.status).toBe("not_required");
    expect(sender.messages).toHaveLength(1);
    expect(await episodes()).toHaveLength(1);
    expect(await outbox()).toHaveLength(1);

    const successfulRun = completedBackup({
      success: true,
      startedAtMs: nowMs + 60_000,
      sha: "b".repeat(64),
    });
    const resolved = await adapter.processBackupResult(successfulRun);
    expect(resolved.ok).toBe(true);
    expect(resolved.alarm?.outcome).toBe("resolved");

    const afterResolve = await episodes();
    expect(afterResolve).toHaveLength(1);
    expect(afterResolve[0]?.status).toBe("resolved");
  });

  it("loest fuer Pause, Fahrzeug-aus und fehlende Tablet-Verbindung keinen technischen Alarm aus", async () => {
    const sender = recordingSender();
    const adapter = makeAdapter({ sender });

    const nonTechnicalStates: unknown[] = [
      { classification: "paused_conscious" },
      { classification: "vehicle_off_expected" },
      { classification: "unknown", tabletConnected: false },
      { paused: true, vehicle: "off", tabletConnected: false },
    ];

    for (const state of nonTechnicalStates) {
      const result = await adapter.processBackupResult(state);
      expect(result.processed).toBe(false);
      expect(result.ok).toBe(false);
      expect(result.alarm).toBeNull();
    }

    expect(sender.messages).toHaveLength(0);
    expect(await episodes()).toHaveLength(0);
    expect(await outbox()).toHaveLength(0);
  });

  it("laesst ein fehlschlagender Telegram-Adapter die Ergebnisse unveraendert und weist Persistenzfehler geheimnisfrei aus", async () => {
    const adapter = makeAdapter({
      probe: failingProbe,
      sender: failingTelegramSender(),
    });

    const readiness = await adapter.checkReadiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.alarm.outcome).toBe("opened");
    expect(readiness.alarm.delivery.status).toBe("pending");
    expect(readiness.alarm.delivery.errorCode).toBe("transport_error");
    expect(JSON.stringify(readiness)).not.toContain("SYN-SECRET-TOKEN");

    const failedBackup = completedBackup({
      success: false,
      startedAtMs: nowMs - 5000,
      sha: "c".repeat(64),
      errorCode: "verification_failed",
    });
    const backup = await adapter.processBackupResult(failedBackup);
    expect(backup.processed).toBe(true);
    expect(backup.ok).toBe(false);
    expect(backup.alarm?.outcome).toBe("opened");
    expect(backup.alarm?.delivery.status).toBe("pending");
    expect(JSON.stringify(backup)).not.toContain("SYN-SECRET-TOKEN");

    const afterFailures = await episodes();
    expect(afterFailures).toHaveLength(2);
    expect(await outbox()).toHaveLength(2);

    const persistenceFailure = createTechnicalAlarmService({
      pool: pool as Pool,
      minDurationSeconds: 1,
      now: () => new Date(nowMs),
      auditWriter: async (): Promise<void> => {
        throw new Error("postgres://user:secret@db.internal:5432/gt_ads");
      },
    });
    const failingAdapter = makeAdapter({
      probe: failingProbe,
      service: persistenceFailure,
      sender: recordingSender(),
      // Eigener stabiler Schluessel: die bestehende Readiness-Episode darf
      // den Persistenzfehler nicht als existing_open verdecken.
      component: "postgres-persistence",
    });

    const persisted = await failingAdapter.checkReadiness();
    expect(persisted.ready).toBe(false);
    expect(persisted.alarm.outcome).toBe("not_persisted");
    expect(persisted.alarm.delivery).toEqual({
      status: "failed",
      errorCode: OPERATIONS_ALARM_PERSISTENCE_ERROR,
    });
    const serialized = JSON.stringify(persisted);
    for (const fragment of ["secret", "postgres", "db.internal", "5432"]) {
      expect(serialized).not.toContain(fragment);
    }
    // Die fehlgeschlagene Persistenz hinterlaesst keine dritte Episode.
    expect(await episodes()).toHaveLength(2);
  });
});
