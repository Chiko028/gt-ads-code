/**
 * CX-061 / R-702 + R-703: HTTP-Komposition des vorhandenen CX-023-
 * Restore-Nachweises und lesende Betriebsuebersicht.
 *
 * Die Tests verwenden einen echten PostgreSQL-17-Server, echte lokale
 * pg_dump-/pg_restore-Binaries und den unveraenderten CX-023-Kern. Fehlende
 * Voraussetzungen sind Fehler, kein Skip.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { CONFIG_DEFAULTS, type AppConfig } from "../../../src/config.js";
import { migrateUp } from "../../../src/db/migrate.js";
import {
  BACKUP_CHECK_COMPLETED_ACTION,
  BACKUP_CHECK_STARTED_ACTION,
  type BackupCheckAuditPort,
  type BackupCheckSqlChecks,
  type BackupCheckTestConfiguration,
} from "../../../src/http/operationsBackupCheck.js";
import { createServer } from "../../../src/http/server.js";
import { AuditService } from "../../../src/modules/audit/service.js";
import {
  createDump,
  type DumpArtifact,
} from "../../../src/modules/backup/createDump.js";
import { createOperationsMetrics } from "../../../src/modules/operations/metrics.js";
import type { ReadinessProbe } from "../../../src/modules/operations/readiness.js";
import {
  OPERATIONS_BACKUP_EPISODE_KEY,
} from "../../../src/http/operationsAlarmAdapter.js";
import {
  TECHNICAL_ALARM_OPENED_ACTION,
  TECHNICAL_ALARM_RESOLVED_ACTION,
} from "../../../src/modules/technicalAlarms/index.js";
import type { PrincipalResolver } from "../../../src/http/principal.js";

const BASE_TIME = Date.parse("2026-09-01T00:00:00.000Z");
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../src/db/migrations",
);
const ADMIN_ID = "SYN-CX061-Admin";
const OPERATOR_ID = "SYN-CX061-Operator";

interface BaseConnection {
  host: string;
  port: number;
  user: string;
  database: string;
}

let maintenancePool: Pool | null = null;
let restoreMaintenancePool: Pool | null = null;
let pool: Pool | null = null;
let appDatabase = "";
let syntheticDatabase = "";
let sourcePool: Pool | null = null;
let artifact: DumpArtifact;
let connection: BaseConnection;
let restoreBase: BaseConnection;
let scratchDirectory = "";
let restoreDirectory = "";
let restoreDataDirectory = "";
let restoreSocketDirectory = "";
let restorePort = 0;
let pgCtlPath = "";
const openApps: FastifyInstance[] = [];

let verifierCalls = 0;
let gate: Promise<void> | null = null;
let releaseGate: (() => void) | null = null;
let verifierEntered: Promise<void> | null = null;
let notifyVerifierEntered: (() => void) | null = null;

function run(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(command + " " + args.join(" ") + ": " + error.message));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function postgresBindir(): Promise<string> {
  try {
    const result = await run("pg_config", ["--bindir"]);
    const configured = result.stdout.trim();
    if (configured !== "") {
      return configured;
    }
  } catch {
    // Fallback fuer Umgebungen ohne pg_config im PATH.
  }
  return "/usr/lib/postgresql/17/bin";
}

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

function baseConnection(): BaseConnection {
  const host = process.env.PGHOST;
  const user = process.env.PGUSER;
  const database = process.env.PGDATABASE;
  if (host === undefined || user === undefined || database === undefined) {
    throw new Error("CX-061 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function roleFrom(request: FastifyRequest): "Admin" | "Operator" | null {
  const raw = request.headers["x-syn-role"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === "Admin" || value === "Operator") {
    return value;
  }
  return null;
}

const resolvePrincipal: PrincipalResolver = async (request) => {
  const role = roleFrom(request);
  if (role === null) {
    return null;
  }
  return {
    id: role === "Admin" ? ADMIN_ID : OPERATOR_ID,
    role,
  };
};

function headers(role?: "Admin" | "Operator", extra: Record<string, string> = {}) {
  return {
    host: "127.0.0.1:8080",
    ...(role === undefined ? {} : { "x-syn-role": role }),
    ...extra,
  };
}

async function buildApp(options: {
  configuration?: BackupCheckTestConfiguration | null;
  audit?: BackupCheckAuditPort;
  readiness?: ReadinessProbe;
  now?: () => Date;
} = {}): Promise<FastifyInstance> {
  const configuration =
    options.configuration === undefined
      ? makeConfiguration()
      : options.configuration;
  const app = createServer({
    config: appConfig,
    pool: pool as Pool,
    now: options.now ?? (() => new Date()),
    resolvePrincipal,
    operations: {
      readiness:
        options.readiness ??
        {
          async check(): Promise<void> {
            return undefined;
          },
        },
      metrics: createOperationsMetrics(),
    },
    operationsAlarm: { sender: null },
    operationsBackupCheck: {
      configuration,
      ...(options.audit === undefined ? {} : { audit: options.audit }),
    },
  });
  await app.ready();
  openApps.push(app);
  return app;
}

async function appConfigForTest(): Promise<AppConfig> {
  return {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX061-Pepper",
    adminPasswordHash:
      "scrypt$N=16384,r=8,p=1$c3ludGhldGlzY2hlLXNhbHQ$aGFzaC1oYXNoLWhhc2gtaGFzaC1oYXNo",
  };
}

let appConfig: AppConfig;

function makeVerifier(): BackupCheckTestConfiguration["verifyContent"] {
  return async ({ client }): Promise<BackupCheckSqlChecks> => {
    verifierCalls += 1;
    if (notifyVerifierEntered !== null) {
      notifyVerifierEntered();
      notifyVerifierEntered = null;
    }
    if (gate !== null) {
      await gate;
    }

    const orders = await client.query<{
      id: string;
      code: string;
      amount: string;
    }>("select id::text as id, code, amount::text as amount from cx061_orders order by id");
    const content =
      JSON.stringify(orders.rows) ===
      JSON.stringify([
        { id: "1", code: "A-1", amount: "10.50" },
        { id: "2", code: "B-2", amount: "0.00" },
      ]);

    let foreignKeys = false;
    try {
      await client.query(
        "insert into cx061_items (id, order_id, label) values (999, 999, 'orphan')",
      );
    } catch {
      foreignKeys = true;
    }

    const sequence = await client.query<{
      last_value: string;
      is_called: boolean;
    }>("select last_value::text as last_value, is_called from cx061_orders_id_seq");
    const sequences =
      sequence.rows[0]?.last_value === "100" &&
      sequence.rows[0]?.is_called === true;

    return { content, foreignKeys, sequences };
  };
}

function makeConfiguration(
  overrides: Partial<BackupCheckTestConfiguration> = {},
): BackupCheckTestConfiguration {
  return {
    environment: "test",
    connection: { ...connection, database: syntheticDatabase },
    artifact,
    timeoutMs: 60_000,
    verifyContent: makeVerifier(),
    ...overrides,
  };
}

async function countAudit(action: string): Promise<number> {
  const result = await (pool as Pool).query<{ count: string }>(
    "select count(*)::text as count from audit_events where action = $1",
    [action],
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function auditRows(action: string): Promise<Array<{
  id: string;
  target_id: string | null;
  details: Record<string, unknown>;
}>> {
  const result = await (pool as Pool).query<{
    id: string;
    target_id: string | null;
    details: Record<string, unknown>;
  }>(
    "select id::text as id, target_id, details from audit_events where action = $1 order by id",
    [action],
  );
  return result.rows;
}

beforeAll(async () => {
  const dumpVersion = await run("pg_dump", ["--version"]);
  const restoreVersion = await run("pg_restore", ["--version"]);
  expect(dumpVersion.stdout).toMatch(/PostgreSQL\) 17\./);
  expect(restoreVersion.stdout).toMatch(/PostgreSQL\) 17\./);

  // Eigener lokaler PostgreSQL-17-Server nur fuer Dump/Restore. Dadurch
  // kollidieren die temporaeren gtads_restore_-Datenbanken dieses Tests
  // nicht mit parallelen CX-023-Testdateien auf dem gemeinsamen Server.
  const bindir = await postgresBindir();
  const initdbPath = join(bindir, "initdb");
  pgCtlPath = join(bindir, "pg_ctl");
  restoreDirectory = await mkdtemp(join(tmpdir(), "cx061-pg-"));
  restoreDataDirectory = join(restoreDirectory, "data");
  restoreSocketDirectory = join(restoreDirectory, "socket");
  await mkdir(restoreSocketDirectory, { recursive: true });
  restorePort = 55_000 + Math.floor(Math.random() * 1_000);
  await run(initdbPath, [
    "-D",
    restoreDataDirectory,
    "-A",
    "trust",
    "-U",
    "postgres",
    "--no-locale",
  ]);
  await run(pgCtlPath, [
    "-D",
    restoreDataDirectory,
    "-o",
    "-p " + String(restorePort) + " -k " + restoreSocketDirectory + " -c listen_addresses=",
    "-l",
    join(restoreDirectory, "server.log"),
    "start",
  ]);
  restoreBase = {
    host: restoreSocketDirectory,
    port: restorePort,
    user: "postgres",
    database: "postgres",
  };
  restoreMaintenancePool = new Pool(restoreBase);

  const base = baseConnection();
  maintenancePool = new Pool(base);
  appDatabase = ("cx061_app_" + process.pid + "_" + Date.now().toString(36))
    .toLowerCase()
    .slice(0, 63);
  syntheticDatabase = (
    "cx061_src_" + process.pid + "_" + Date.now().toString(36)
  )
    .toLowerCase()
    .slice(0, 63);

  await maintenancePool.query("create database " + quoteIdentifier(appDatabase));
  await restoreMaintenancePool.query(
    "create database " + quoteIdentifier(syntheticDatabase),
  );

  pool = new Pool({ ...base, database: appDatabase });
  await migrateUp(pool);
  for (const file of (await readdir(MIGRATIONS_DIR)).sort()) {
    if (!file.endsWith(".up.sql") || file === "0001_gt_ads_001.up.sql") {
      continue;
    }
    await pool.query(await readFile(join(MIGRATIONS_DIR, file), "utf8"));
  }

  sourcePool = new Pool({ ...restoreBase, database: syntheticDatabase });
  await sourcePool.query(
    [
      "create table cx061_orders (",
      "  id bigserial primary key,",
      "  code text not null unique,",
      "  amount numeric(10,2) not null check (amount >= 0)",
      ")",
    ].join("\n"),
  );
  await sourcePool.query(
    [
      "create table cx061_items (",
      "  id integer primary key,",
      "  order_id bigint not null references cx061_orders(id),",
      "  label text not null",
      ")",
    ].join("\n"),
  );
  await sourcePool.query(
    "insert into cx061_orders (code, amount) values ('A-1', 10.50), ('B-2', 0.00)",
  );
  await sourcePool.query(
    "insert into cx061_items (id, order_id, label) values (1, 1, 'alpha'), (2, 1, 'beta'), (3, 2, 'gamma')",
  );
  await sourcePool.query("select setval('cx061_orders_id_seq', 100, true)");

  connection = { ...restoreBase, database: syntheticDatabase };
  scratchDirectory = await mkdtemp(join(tmpdir(), "cx061-dump-"));
  artifact = await createDump({
    environment: "test",
    connection,
    outputDirectory: scratchDirectory,
    targetName: "cx061.dump",
  });
  appConfig = await appConfigForTest();
}, 180_000);

afterEach(async () => {
  for (const app of openApps.splice(0)) {
    await app.close();
  }
  if (pool !== null) {
    await pool.query(
      "truncate table technical_alarm_outbox, technical_alarm_episodes, technical_alarm_resource_state restart identity cascade",
    );
    await pool.query("delete from audit_events");
  }
  verifierCalls = 0;
  gate = null;
  releaseGate = null;
  verifierEntered = null;
  notifyVerifierEntered = null;
});

afterAll(async () => {
  if (sourcePool !== null) {
    await sourcePool.end();
  }
  if (restoreMaintenancePool !== null) {
    await restoreMaintenancePool.end();
  }
  if (pool !== null) {
    await pool.end();
  }
  if (scratchDirectory !== "") {
    await rm(scratchDirectory, { recursive: true, force: true });
  }
  if (maintenancePool !== null) {
    if (appDatabase !== "") {
      await maintenancePool.query(
        "drop database if exists " + quoteIdentifier(appDatabase),
      );
    }
    await maintenancePool.end();
  }
  if (pgCtlPath !== "" && restoreDataDirectory !== "") {
    try {
      await run(pgCtlPath, ["-D", restoreDataDirectory, "-m", "fast", "stop"]);
    } catch {
      // Der temporaere Server wird anschliessend ohnehin verworfen.
    }
  }
  if (restoreDirectory !== "") {
    await rm(restoreDirectory, { recursive: true, force: true });
  }
}, 60_000);

beforeEach(async () => {
  if (pool !== null) {
    await pool.query(
      "truncate table technical_alarm_outbox, technical_alarm_episodes, technical_alarm_resource_state restart identity cascade",
    );
    await pool.query("delete from audit_events");
  }
  verifierCalls = 0;
  gate = null;
  releaseGate = null;
  verifierEntered = null;
  notifyVerifierEntered = null;
});

describe("CX-061 Admin-Backup-Pruefung und Betriebsuebersicht", () => {
  it("startet als Admin einen echten CX-023-Nachweis und protokolliert Lauf-ID, Archivhash und SQL-Pruefungen", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/operations/backup-check",
      headers: headers("Admin", { "content-type": "application/json" }),
      payload: {},
      remoteAddress: "192.0.2.61",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      run_id: string;
      started_at: string;
      finished_at: string;
      duration_ms: number;
      status: string;
      archive_sha256: string;
      checks: Record<string, boolean>;
      error_code: string | null;
    };
    expect(body.status).toBe("succeeded");
    expect(body.error_code).toBeNull();
    expect(body.archive_sha256).toBe(artifact.sha256);
    expect(body.checks).toEqual({
      restore: true,
      content: true,
      foreign_keys: true,
      sequences: true,
      cleanup: true,
    });
    expect(body.started_at.endsWith("Z")).toBe(true);
    expect(body.finished_at.endsWith("Z")).toBe(true);
    expect(body.duration_ms).toBeGreaterThanOrEqual(0);
    expect(verifierCalls).toBe(1);

    const started = await auditRows(BACKUP_CHECK_STARTED_ACTION);
    const completed = await auditRows(BACKUP_CHECK_COMPLETED_ACTION);
    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(started[0]?.target_id).toBe(body.run_id);
    expect(completed[0]?.target_id).toBe(body.run_id);
    expect(started[0]?.details.run_id).toBe(body.run_id);
    expect(completed[0]?.details.run_id).toBe(body.run_id);
    expect(completed[0]?.details.archive_sha256).toBe(body.archive_sha256);
    expect(completed[0]?.details.status).toBe("succeeded");
    expect(completed[0]?.details.checks).toEqual(body.checks);

    const serializedAudit = JSON.stringify([started, completed]);
    for (const fragment of [
      artifact.artifactPath,
      scratchDirectory,
      connection.host,
      syntheticDatabase,
    ]) {
      expect(serializedAudit).not.toContain(fragment);
    }
  }, 120_000);

  it("weist anonymen Zugriff, Operator-Schreibzugriff und fremden Origin vor jedem Pruefstart ab und lehnt Client-Ziele ab", async () => {
    const unavailableApp = await buildApp({ configuration: null });
    const unavailable = await unavailableApp.inject({
      method: "POST",
      url: "/v1/admin/operations/backup-check",
      headers: headers("Admin", { "content-type": "application/json" }),
      payload: {},
      remoteAddress: "192.0.2.62",
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().error.code).toBe("backup_check_unavailable");
    expect(await countAudit(BACKUP_CHECK_STARTED_ACTION)).toBe(0);

    const app = await buildApp();
    const attempts = [
      await app.inject({
        method: "POST",
        url: "/v1/admin/operations/backup-check",
        headers: headers(undefined, { "content-type": "application/json" }),
        payload: {},
        remoteAddress: "192.0.2.63",
      }),
      await app.inject({
        method: "POST",
        url: "/v1/admin/operations/backup-check",
        headers: headers("Operator", { "content-type": "application/json" }),
        payload: {},
        remoteAddress: "192.0.2.64",
      }),
      await app.inject({
        method: "POST",
        url: "/v1/admin/operations/backup-check",
        headers: headers("Admin", {
          "content-type": "application/json",
          origin: "https://fremder-origin.example",
        }),
        payload: {},
        remoteAddress: "192.0.2.65",
      }),
    ];
    expect(attempts.map((entry) => entry.statusCode)).toEqual([401, 403, 403]);

    for (const payload of [
      { database: "fremde_datenbank" },
      { artifact_path: "/tmp/fremd.dump" },
      { connection: { host: "127.0.0.1" } },
      { targetDatabaseName: "fremd" },
    ]) {
      const rejected = await app.inject({
        method: "POST",
        url: "/v1/admin/operations/backup-check",
        headers: headers("Admin", { "content-type": "application/json" }),
        payload,
        remoteAddress: "192.0.2.66",
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().error.code).toBe("invalid_request");
    }

    const queryRejected = await app.inject({
      method: "POST",
      url: "/v1/admin/operations/backup-check?database=fremd",
      headers: headers("Admin", { "content-type": "application/json" }),
      payload: {},
      remoteAddress: "192.0.2.67",
    });
    expect(queryRejected.statusCode).toBe(400);

    expect(verifierCalls).toBe(0);
    expect(await countAudit(BACKUP_CHECK_STARTED_ACTION)).toBe(0);
    expect(await countAudit(BACKUP_CHECK_COMPLETED_ACTION)).toBe(0);
  }, 120_000);

  it("protokolliert einen gescheiterten Nachweis dauerhaft und meldet ihn an CX-060; Persistenzfehler bleiben unvollstaendig", async () => {
    const tampered: DumpArtifact = {
      ...artifact,
      sha256: "0".repeat(64),
    };
    const app = await buildApp({
      configuration: makeConfiguration({ artifact: tampered }),
    });

    const failed = await app.inject({
      method: "POST",
      url: "/v1/admin/operations/backup-check",
      headers: headers("Admin", { "content-type": "application/json" }),
      payload: {},
      remoteAddress: "192.0.2.68",
    });
    expect(failed.statusCode).toBe(200);
    const failedBody = failed.json() as {
      run_id: string;
      status: string;
      archive_sha256: string;
      checks: Record<string, boolean>;
      error_code: string;
    };
    expect(failedBody.status).toBe("failed");
    expect(failedBody.error_code).toBe("artifact_integrity_failed");
    expect(failedBody.archive_sha256).toBe(tampered.sha256);
    expect(failedBody.checks.restore).toBe(false);
    expect(failedBody.checks.content).toBe(false);
    expect(verifierCalls).toBe(0);

    const completed = await auditRows(BACKUP_CHECK_COMPLETED_ACTION);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.details.run_id).toBe(failedBody.run_id);
    expect(completed[0]?.details.status).toBe("failed");
    expect(completed[0]?.details.error_code).toBe("artifact_integrity_failed");

    const episodes = await (pool as Pool).query<{
      resource_id: string;
      status: string;
      error_code: string;
    }>(
      "select resource_id, status, error_code from technical_alarm_episodes order by episode_id",
    );
    expect(episodes.rows).toHaveLength(1);
    expect(episodes.rows[0]?.resource_id).toBe(OPERATIONS_BACKUP_EPISODE_KEY);
    expect(episodes.rows[0]?.status).toBe("open");
    expect(episodes.rows[0]?.error_code).toBe("artifact_integrity_failed");

    const secret = "SYN-CX061-SECRET-DARF-NICHT-ERSCHEINEN";
    const realAudit = new AuditService({ executor: pool as Pool });
    const failingAudit: BackupCheckAuditPort = {
      async record(input): Promise<void> {
        if (input.action === BACKUP_CHECK_COMPLETED_ACTION) {
          throw new Error(secret);
        }
        await realAudit.record(input);
      },
    };
    const persistenceApp = await buildApp({
      configuration: makeConfiguration(),
      audit: failingAudit,
    });
    const persistence = await persistenceApp.inject({
      method: "POST",
      url: "/v1/admin/operations/backup-check",
      headers: headers("Admin", { "content-type": "application/json" }),
      payload: {},
      remoteAddress: "192.0.2.69",
    });
    expect(persistence.statusCode).toBe(200);
    const persistenceBody = persistence.json() as {
      run_id: string;
      status: string;
      error_code: string;
    };
    expect(persistenceBody.status).toBe("incomplete");
    expect(persistenceBody.error_code).toBe("result_persistence_failed");
    expect(verifierCalls).toBe(1);

    const all = await (pool as Pool).query<{ details: unknown }>(
      "select details from audit_events order by id",
    );
    const serialized = JSON.stringify(all.rows) + persistence.payload;
    for (const fragment of [
      secret,
      artifact.artifactPath,
      scratchDirectory,
      connection.host,
      syntheticDatabase,
    ]) {
      expect(serialized).not.toContain(fragment);
    }
  }, 120_000);

  it("weist einen parallelen zweiten Start mit 409 ab und liefert die Betriebsuebersicht deterministisch", async () => {
    gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    verifierEntered = new Promise<void>((resolve) => {
      notifyVerifierEntered = resolve;
    });

    let readinessCalls = 0;
    const readiness: ReadinessProbe = {
      async check(): Promise<void> {
        readinessCalls += 1;
      },
    };
    const app = await buildApp({
      readiness,
      now: () => new Date(BASE_TIME),
    });

    const first = app.inject({
      method: "POST",
      url: "/v1/admin/operations/backup-check",
      headers: headers("Admin", { "content-type": "application/json" }),
      payload: {},
      remoteAddress: "192.0.2.70",
    });
    await (verifierEntered as Promise<void>);

    const second = await app.inject({
      method: "POST",
      url: "/v1/admin/operations/backup-check",
      headers: headers("Admin", { "content-type": "application/json" }),
      payload: {},
      remoteAddress: "192.0.2.71",
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("backup_check_in_progress");
    expect(await countAudit(BACKUP_CHECK_STARTED_ACTION)).toBe(1);
    expect(verifierCalls).toBe(1);

    (releaseGate as () => void)();
    const firstResponse = await first;
    expect(firstResponse.statusCode).toBe(200);
    const runId = (firstResponse.json() as { run_id: string }).run_id;

    // Hoechstens 20 Alarmereignisse, sortiert nach at desc, id desc.
    for (let index = 0; index < 25; index += 1) {
      const at =
        index < 3
          ? new Date(BASE_TIME + index * 1000).toISOString()
          : new Date(BASE_TIME + 10_000).toISOString();
      const action =
        index % 2 === 0
          ? TECHNICAL_ALARM_OPENED_ACTION
          : TECHNICAL_ALARM_RESOLVED_ACTION;
      await (pool as Pool).query(
        [
          "insert into audit_events",
          "  (at, actor_type, action, target_type, target_id, details)",
          "values ($1, 'system', $2, 'technical_alarm_episode', $3, $4)",
        ].join("\n"),
        [
          at,
          action,
          "syn-episode-" + index,
          {
            episode_id: String(index + 1),
            resource_id: "syn-resource-" + index,
            error_code: "SYN_FAULT",
          },
        ],
      );
    }

    const overview = await app.inject({
      method: "GET",
      url: "/v1/admin/operations",
      headers: headers("Admin"),
      remoteAddress: "192.0.2.72",
    });
    expect(overview.statusCode).toBe(200);
    const body = overview.json() as {
      readiness: { status: string };
      alarms: {
        available: boolean;
        items: Array<{ id: string; at: string; action: string }>;
      };
      last_backup_check: {
        available: boolean;
        reason: string | null;
        proof: { run_id: string; status: string; archive_sha256: string } | null;
      };
    };
    expect(body.readiness.status).toBe("ready");
    expect(readinessCalls).toBe(1);
    expect(body.alarms.available).toBe(true);
    expect(body.alarms.items).toHaveLength(20);
    for (let index = 0; index < body.alarms.items.length - 1; index += 1) {
      const left = body.alarms.items[index] as { id: string; at: string };
      const right = body.alarms.items[index + 1] as { id: string; at: string };
      const leftAt = Date.parse(left.at);
      const rightAt = Date.parse(right.at);
      expect(leftAt).toBeGreaterThanOrEqual(rightAt);
      if (leftAt === rightAt) {
        expect(Number(left.id)).toBeGreaterThan(Number(right.id));
      }
    }
    expect(body.last_backup_check.available).toBe(true);
    expect(body.last_backup_check.proof?.run_id).toBe(runId);
    expect(body.last_backup_check.proof?.status).toBe("succeeded");
    expect(body.last_backup_check.proof?.archive_sha256).toBe(artifact.sha256);
    expect(verifierCalls).toBe(1);
    expect(await countAudit(BACKUP_CHECK_COMPLETED_ACTION)).toBe(1);

    const secondOverview = await app.inject({
      method: "GET",
      url: "/v1/admin/operations",
      headers: headers("Admin"),
      remoteAddress: "192.0.2.73",
    });
    expect(secondOverview.json()).toEqual(overview.json());

    const operatorOverview = await app.inject({
      method: "GET",
      url: "/v1/admin/operations",
      headers: headers("Operator"),
      remoteAddress: "192.0.2.74",
    });
    expect(operatorOverview.statusCode).toBe(403);
    const anonymousOverview = await app.inject({
      method: "GET",
      url: "/v1/admin/operations",
      headers: headers(),
      remoteAddress: "192.0.2.75",
    });
    expect(anonymousOverview.statusCode).toBe(401);

    await (pool as Pool).query(
      "delete from audit_events where action = $1",
      [BACKUP_CHECK_COMPLETED_ACTION],
    );
    const emptyOverview = await app.inject({
      method: "GET",
      url: "/v1/admin/operations",
      headers: headers("Admin"),
      remoteAddress: "192.0.2.76",
    });
    expect(emptyOverview.statusCode).toBe(200);
    const emptyBody = emptyOverview.json() as {
      last_backup_check: { available: boolean; reason: string | null; proof: unknown };
    };
    expect(emptyBody.last_backup_check.available).toBe(false);
    expect(emptyBody.last_backup_check.reason).toBe("no_backup_check");
    expect(emptyBody.last_backup_check.proof).toBeNull();
  }, 120_000);
});
