import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { insertAuditEvent } from "../../../src/modules/audit/repository.js";
import {
  createRemoteControlService,
  RemoteControlAckRejectedError,
  RemoteControlCommandConflictError,
  RemoteControlDeviceRejectedError,
  RemoteControlRevisionConflictError,
  RemoteControlService,
  RemoteControlTaxiTargetError,
  REMOTE_CONTROL_AUDIT_ACTION,
  type SetDesiredPauseInput,
  type SetDesiredPauseResult,
} from "../../../src/modules/remoteControl/index.js";
import { SyntheticTaxiDirectory } from "./syntheticDirectory.js";

const BASE_TIME = Date.parse("2026-05-05T10:00:00.000Z");
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../src/db/migrations",
);
const TAXI_A = "SYN-CX-012-TAXI-A";
const TAXI_B = "SYN-CX-012-TAXI-B";
const ADMIN_ID = "SYN-CX-012-ADMIN";

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let directory: SyntheticTaxiDirectory;
let service: RemoteControlService;

const deviceA1 = randomUUID();
const deviceA2 = randomUUID();
const deviceB1 = randomUUID();

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
    throw new Error("CX-012 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

async function readMigration(name: string): Promise<string> {
  return readFile(join(MIGRATIONS_DIR, name), "utf8");
}

async function insertDevice(
  deviceId: string,
  fingerprint: string,
): Promise<void> {
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
      "SYN-CX-012-Tablet",
      Buffer.from("SYN-CX-012-Key-" + fingerprint),
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

function setPause(
  targetService: RemoteControlService,
  overrides: Partial<SetDesiredPauseInput> = {},
): Promise<SetDesiredPauseResult> {
  return targetService.setDesiredPause({
    actor: { id: ADMIN_ID, type: "admin" },
    taxiId: TAXI_A,
    commandId: randomUUID(),
    expectedRevision: 0,
    desiredPaused: true,
    ...overrides,
  });
}

interface Counts {
  commands: number;
  deliveries: number;
  pending: number;
  audit: number;
  state: number;
}

async function counts(): Promise<Counts> {
  const result = await pool.query<Counts>(
    [
      "select",
      "  (select count(*) from remote_control_commands)::int as commands,",
      "  (select count(*) from remote_control_deliveries)::int as deliveries,",
      "  (select count(*) from remote_control_deliveries where status = 'pending')::int as pending,",
      "  (select count(*) from audit_events)::int as audit,",
      "  (select count(*) from remote_control_taxi_state)::int as state",
    ].join("\n"),
  );
  return result.rows[0];
}

interface DeliverySnapshot {
  id: string;
  command_id: string;
  taxi_id: string;
  device_id: string;
  revision: number;
  status: string;
  acknowledged_at: Date | null;
  superseded_at: Date | null;
}

async function deliveryRows(): Promise<DeliverySnapshot[]> {
  const result = await pool.query<DeliverySnapshot>(
    [
      "select id::text as id, command_id::text as command_id, taxi_id,",
      "       device_id::text as device_id, revision::int as revision,",
      "       status, acknowledged_at, superseded_at",
      "  from remote_control_deliveries",
      " order by revision, device_id",
    ].join("\n"),
  );
  return result.rows;
}

interface CommandSnapshot {
  command_id: string;
  taxi_id: string;
  revision: number;
  desired_paused: boolean;
  origin: string;
  actor_id: string;
}

async function commandRows(): Promise<CommandSnapshot[]> {
  const result = await pool.query<CommandSnapshot>(
    [
      "select command_id::text as command_id, taxi_id, revision::int as revision,",
      "       desired_paused, origin, actor_id",
      "  from remote_control_commands",
      " order by revision",
    ].join("\n"),
  );
  return result.rows;
}

interface AuditSnapshot {
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
}

async function auditRows(): Promise<AuditSnapshot[]> {
  const result = await pool.query<AuditSnapshot>(
    [
      "select actor_type, actor_id, action, target_type, target_id, details",
      "  from audit_events",
      " order by id",
    ].join("\n"),
  );
  return result.rows;
}

async function snapshot(): Promise<{
  commands: CommandSnapshot[];
  deliveries: DeliverySnapshot[];
  state: Array<{ taxi_id: string; revision: number; desired_paused: boolean }>;
  audit: AuditSnapshot[];
}> {
  const state = await pool.query<{
    taxi_id: string;
    revision: number;
    desired_paused: boolean;
  }>(
    [
      "select taxi_id, revision::int as revision, desired_paused",
      "  from remote_control_taxi_state",
      " order by taxi_id",
    ].join("\n"),
  );
  return {
    commands: await commandRows(),
    deliveries: await deliveryRows(),
    state: state.rows,
    audit: await auditRows(),
  };
}

function rowForDevice(
  rows: DeliverySnapshot[],
  deviceId: string,
  revision: number,
): DeliverySnapshot {
  const row = rows.find(
    (candidate) =>
      candidate.device_id === deviceId && candidate.revision === revision,
  );
  if (row === undefined) {
    throw new Error("Zustellung fehlt im Test");
  }
  return row;
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = ("gtads_cx012_" + process.pid + "_" + Date.now().toString(36))
    .toLowerCase()
    .slice(0, 63);
  await maintenancePool.query("create database " + quoteIdentifier(databaseName));

  pool = new Pool({ ...base, database: databaseName });
  await pool.query(await readMigration("0001_gt_ads_001.up.sql"));
  await pool.query(await readMigration("0004_cx_012_remote_control.up.sql"));

  registrationCodeId = randomUUID();
  await pool.query(
    [
      "insert into registration_codes",
      "  (id, code_hash, label, created_at, created_by, expires_at)",
      "values ($1, $2, $3, $4, $5, $6)",
    ].join(" "),
    [
      registrationCodeId,
      Buffer.from("SYN-CX-012-registration-code"),
      "SYN-CX-012",
      new Date(BASE_TIME),
      "SYN-Test",
      new Date(BASE_TIME + 86_400_000),
    ],
  );
  await insertDevice(deviceA1, "SYN-CX-012-Fingerprint-A1");
  await insertDevice(deviceA2, "SYN-CX-012-Fingerprint-A2");
  await insertDevice(deviceB1, "SYN-CX-012-Fingerprint-B1");
}, 30_000);

beforeEach(async () => {
  await pool.query(
    "truncate table remote_control_deliveries, remote_control_commands, remote_control_taxi_state restart identity",
  );
  await pool.query("delete from audit_events");
  await pool.query("update devices set state = 'active'");
  directory = new SyntheticTaxiDirectory();
  directory.assign(deviceA1, TAXI_A);
  directory.assign(deviceA2, TAXI_A);
  directory.assign(deviceB1, TAXI_B);
  service = createRemoteControlService({
    pool,
    directory,
    now: () => new Date(BASE_TIME),
  });
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

describe("CX-012 Pausenauftragskern", () => {
  it("erzeugt fuer zwei Tablets einen Auftrag, zwei Zustellungen und genau einen Audit-Eintrag", async () => {
    const result = await setPause(service);

    expect(result).toMatchObject({
      taxiId: TAXI_A,
      revision: 1,
      desiredPaused: true,
      origin: "admin",
      idempotent: false,
    });
    expect(result.targetDeviceIds).toEqual([deviceA1, deviceA2].sort());

    expect(await counts()).toEqual({
      commands: 1,
      deliveries: 2,
      pending: 2,
      audit: 1,
      state: 1,
    });

    const deliveries = await deliveryRows();
    expect(deliveries.map((row) => row.device_id)).toEqual(
      [deviceA1, deviceA2].sort(),
    );
    expect(deliveries.every((row) => row.revision === 1)).toBe(true);
    expect(deliveries.every((row) => row.status === "pending")).toBe(true);
    expect(deliveries.every((row) => row.acknowledged_at === null)).toBe(true);

    const commands = await commandRows();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      command_id: result.commandId,
      taxi_id: TAXI_A,
      revision: 1,
      desired_paused: true,
      origin: "admin",
      actor_id: ADMIN_ID,
    });

    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_type: "admin",
      actor_id: ADMIN_ID,
      action: REMOTE_CONTROL_AUDIT_ACTION,
      target_type: "taxi",
      target_id: TAXI_A,
      details: {
        command_id: result.commandId,
        revision: 1,
        expected_revision: 0,
        desired_paused: true,
        origin: "admin",
        target_device_ids: [deviceA1, deviceA2].sort(),
      },
    });
  });

  it("liefert bei identischer command_id und identischem Inhalt dieselbe Revision", async () => {
    const commandId = randomUUID();
    const first = await setPause(service, { commandId });
    const before = await snapshot();

    const replay = await setPause(service, {
      commandId,
      expectedRevision: 99,
    });

    expect(replay).toMatchObject({
      commandId,
      revision: first.revision,
      desiredPaused: true,
      idempotent: true,
    });
    expect(replay.targetDeviceIds).toEqual(first.targetDeviceIds);
    expect(await snapshot()).toEqual(before);
  });

  it("weist abweichenden Inhalt mit gleicher command_id ohne Mutation ab", async () => {
    const commandId = randomUUID();
    await setPause(service, { commandId });
    const before = await snapshot();

    await expect(
      setPause(service, {
        commandId,
        desiredPaused: false,
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(RemoteControlCommandConflictError);

    expect(await snapshot()).toEqual(before);
  });

  it("erlaubt bei gleicher erwarteter Revision genau einen parallelen Commit", async () => {
    const secondService = createRemoteControlService({
      pool,
      directory,
      now: () => new Date(BASE_TIME),
    });
    const settled = await Promise.allSettled([
      setPause(service, { commandId: randomUUID(), desiredPaused: true }),
      setPause(secondService, {
        commandId: randomUUID(),
        desiredPaused: false,
      }),
    ]);

    const fulfilled = settled.filter(
      (entry): entry is PromiseFulfilledResult<SetDesiredPauseResult> =>
        entry.status === "fulfilled",
    );
    const rejected = settled.filter(
      (entry): entry is PromiseRejectedResult => entry.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(
      RemoteControlRevisionConflictError,
    );
    expect(await counts()).toEqual({
      commands: 1,
      deliveries: 2,
      pending: 2,
      audit: 1,
      state: 1,
    });

    const state = await pool.query<{
      revision: number;
      desired_paused: boolean;
    }>(
      "select revision::int as revision, desired_paused from remote_control_taxi_state where taxi_id = $1",
      [TAXI_A],
    );
    expect(state.rows[0].revision).toBe(1);
    expect(state.rows[0].desired_paused).toBe(fulfilled[0].value.desiredPaused);
  });

  it("rollt bei Audit-Schreibfehler Auftrag und beide Zustellungen vollstaendig zurueck", async () => {
    const failingService = createRemoteControlService({
      pool,
      directory,
      now: () => new Date(BASE_TIME),
      auditWriter: async (executor, event) => {
        await insertAuditEvent(executor, event);
        throw new Error("SYN-CX-012 Audit-Schreibfehler");
      },
    });

    await expect(setPause(failingService)).rejects.toThrow(
      "SYN-CX-012 Audit-Schreibfehler",
    );
    expect(await counts()).toEqual({
      commands: 0,
      deliveries: 0,
      pending: 0,
      audit: 0,
      state: 0,
    });

    const retry = await setPause(service);
    expect(retry.revision).toBe(1);
    expect((await counts()).commands).toBe(1);
  });

  it("bestaetigt nur das angefragte Tablet und weist fremde oder widerrufene Geraete ab", async () => {
    const command = await setPause(service);

    const firstOffer = await service.getPendingForDevice(deviceA1);
    const repeatedOffer = await service.getPendingForDevice(deviceA1);
    expect(firstOffer).toMatchObject({
      commandId: command.commandId,
      taxiId: TAXI_A,
      revision: 1,
      desiredPaused: true,
    });
    expect(repeatedOffer).toEqual(firstOffer);

    const acknowledged = await service.acknowledgeApplied({
      deviceId: deviceA1,
      taxiId: TAXI_A,
      revision: 1,
    });
    expect(acknowledged).toMatchObject({
      deviceId: deviceA1,
      taxiId: TAXI_A,
      commandId: command.commandId,
      revision: 1,
      status: "applied",
      duplicate: false,
    });

    expect(await service.getPendingForDevice(deviceA1)).toBeNull();
    expect(await service.getPendingForDevice(deviceA2)).toMatchObject({
      commandId: command.commandId,
      revision: 1,
    });

    const beforeDuplicate = await deliveryRows();
    const duplicate = await service.acknowledgeApplied({
      deviceId: deviceA1,
      taxiId: TAXI_A,
      revision: 1,
    });
    expect(duplicate.duplicate).toBe(true);
    expect(await deliveryRows()).toEqual(beforeDuplicate);

    await expect(
      service.acknowledgeApplied({
        deviceId: deviceA1,
        taxiId: TAXI_B,
        revision: 1,
      }),
    ).rejects.toBeInstanceOf(RemoteControlDeviceRejectedError);

    await pool.query("update devices set state = 'revoked' where id = $1", [
      deviceA2,
    ]);
    await expect(
      service.acknowledgeApplied({
        deviceId: deviceA2,
        taxiId: TAXI_A,
        revision: 1,
      }),
    ).rejects.toMatchObject({ reason: "revoked" });

    directory.revoke(deviceA2);
    await pool.query("update devices set state = 'active' where id = $1", [
      deviceA2,
    ]);
    await expect(
      service.acknowledgeApplied({
        deviceId: deviceA2,
        taxiId: TAXI_A,
        revision: 1,
      }),
    ).rejects.toMatchObject({ reason: "inactive" });
  });

  it("erhaelt Auftrag und Bestaetigungen nach neuer Service-Instanz und bietet ueberholte Revisionen nicht erneut an", async () => {
    const paused = await setPause(service);
    await service.acknowledgeApplied({
      deviceId: deviceA1,
      taxiId: TAXI_A,
      revision: 1,
    });
    const resumed = await setPause(service, {
      expectedRevision: paused.revision,
      desiredPaused: false,
    });

    const restarted = createRemoteControlService({
      pool,
      directory,
      now: () => new Date(BASE_TIME + 60_000),
    });

    expect(await restarted.getPendingForDevice(deviceA1)).toMatchObject({
      commandId: resumed.commandId,
      revision: 2,
      desiredPaused: false,
    });
    expect(await restarted.getPendingForDevice(deviceA2)).toMatchObject({
      commandId: resumed.commandId,
      revision: 2,
      desiredPaused: false,
    });

    const deliveries = await deliveryRows();
    expect(rowForDevice(deliveries, deviceA1, 1).status).toBe("applied");
    expect(rowForDevice(deliveries, deviceA2, 1).status).toBe("superseded");
    expect(rowForDevice(deliveries, deviceA2, 1).superseded_at).not.toBeNull();
    expect(rowForDevice(deliveries, deviceA1, 2).status).toBe("pending");
    expect(rowForDevice(deliveries, deviceA2, 2).status).toBe("pending");

    await expect(
      restarted.acknowledgeApplied({
        deviceId: deviceA2,
        taxiId: TAXI_A,
        revision: 1,
      }),
    ).rejects.toBeInstanceOf(RemoteControlAckRejectedError);

    expect(await counts()).toEqual({
      commands: 2,
      deliveries: 4,
      pending: 2,
      audit: 2,
      state: 1,
    });

    await restarted.acknowledgeApplied({
      deviceId: deviceA1,
      taxiId: TAXI_A,
      revision: 2,
    });
    const lastInstance = createRemoteControlService({ pool, directory });
    expect(await lastInstance.getPendingForDevice(deviceA1)).toBeNull();
    expect(await lastInstance.getPendingForDevice(deviceA2)).toMatchObject({
      revision: 2,
      desiredPaused: false,
    });
  });

  it("lehnt Taxis ohne genau zwei aktive Tablets ohne Teilmutation ab", async () => {
    directory.clear();
    directory.assign(deviceA1, TAXI_A);
    const before = await snapshot();

    await expect(setPause(service)).rejects.toBeInstanceOf(
      RemoteControlTaxiTargetError,
    );
    expect(await snapshot()).toEqual(before);

    directory.assign(deviceA2, TAXI_A);
    await pool.query("update devices set state = 'revoked' where id = $1", [
      deviceA2,
    ]);
    await expect(setPause(service)).rejects.toBeInstanceOf(
      RemoteControlTaxiTargetError,
    );
    expect(await snapshot()).toEqual(before);

    await pool.query("update devices set state = 'active' where id = $1", [
      deviceA2,
    ]);
    const accepted = await setPause(service);
    expect(accepted.revision).toBe(1);
    expect(accepted.targetDeviceIds).toEqual([deviceA1, deviceA2].sort());
  });
});
