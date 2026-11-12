import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { insertAuditEvent } from "../../../src/modules/audit/repository.js";
import {
  ControlConfigChangeConflictError,
  ControlConfigRevisionConflictError,
  ControlConfigValidationError,
  CONTROL_CONFIG_AUDIT_ACTION,
  createControlConfigService,
  type ControlConfigAuditWriter,
  type ControlConfigService,
  type TaxiControlConfigValues,
  type UpdateTaxiConfigInput,
  type UpdateTaxiConfigResult,
} from "../../../src/modules/controlConfig/index.js";
import {
  CLASSIFICATION_KEYS,
  classifyDay,
  type EvaluationPolicy,
  type NormalizedObservation,
} from "../../../src/modules/telemetryEvaluation/index.js";

const BASE_TIME = Date.parse("2026-06-01T10:00:00.000Z");
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../src/db/migrations",
);
const TAXI_A = "SYN-CX-013-TAXI-A";
const TAXI_B = "SYN-CX-013-TAXI-B";
const ADMIN_ID = "SYN-CX-013-ADMIN";

const COMPLETE: TaxiControlConfigValues = {
  gps_mode: "aus",
  pause_max_duration_s: 1234,
  pause_end_on_vehicle_off: true,
  display_run_on_s: 45,
};

const UNRESOLVED: TaxiControlConfigValues = {
  gps_mode: "aus",
  pause_max_duration_s: null,
  pause_end_on_vehicle_off: null,
  display_run_on_s: null,
};

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let service: ControlConfigService;
let registrationCodeId = "";
const deviceId = randomUUID();

interface ConfigSnapshotRow {
  taxi_id: string;
  revision: number;
  gps_mode: string;
  pause_max_duration_s: string | null;
  pause_end_on_vehicle_off: boolean | null;
  display_run_on_s: string | null;
}

interface ChangeSnapshotRow {
  change_id: string;
  taxi_id: string;
  revision: number;
  content_fingerprint: string;
  actor_id: string;
  gps_mode: string;
  pause_max_duration_s: string | null;
  pause_end_on_vehicle_off: boolean | null;
  display_run_on_s: string | null;
}

interface AuditSnapshotRow {
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
}

interface Snapshot {
  configs: ConfigSnapshotRow[];
  changes: ChangeSnapshotRow[];
  audit: AuditSnapshotRow[];
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
    throw new Error("CX-013 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

async function readMigration(name: string): Promise<string> {
  return readFile(join(MIGRATIONS_DIR, name), "utf8");
}

function newService(
  overrides: { auditWriter?: ControlConfigAuditWriter } = {},
): ControlConfigService {
  return createControlConfigService({
    pool,
    now: () => new Date(BASE_TIME),
    ...overrides,
  });
}

function update(
  targetService: ControlConfigService,
  overrides: Partial<UpdateTaxiConfigInput> = {},
): Promise<UpdateTaxiConfigResult> {
  return targetService.updateTaxiConfig({
    actor: { id: ADMIN_ID, type: "admin" },
    taxi_id: TAXI_A,
    change_id: randomUUID(),
    expected_revision: 0,
    config: COMPLETE,
    ...overrides,
  });
}

function read(targetService: ControlConfigService, taxiId = TAXI_A) {
  return targetService.readTaxiConfig({
    actor: { id: ADMIN_ID, type: "admin" },
    taxi_id: taxiId,
  });
}

async function snapshot(): Promise<Snapshot> {
  const configs = await pool.query<ConfigSnapshotRow>(
    [
      "select taxi_id, revision::int as revision, gps_mode,",
      "       pause_max_duration_s::text as pause_max_duration_s,",
      "       pause_end_on_vehicle_off,",
      "       display_run_on_s::text as display_run_on_s",
      "  from control_config_taxi",
      " order by taxi_id",
    ].join("\n"),
  );
  const changes = await pool.query<ChangeSnapshotRow>(
    [
      "select change_id::text as change_id, taxi_id, revision::int as revision,",
      "       content_fingerprint, actor_id, gps_mode,",
      "       pause_max_duration_s::text as pause_max_duration_s,",
      "       pause_end_on_vehicle_off,",
      "       display_run_on_s::text as display_run_on_s",
      "  from control_config_changes",
      " order by taxi_id, revision",
    ].join("\n"),
  );
  const audit = await pool.query<AuditSnapshotRow>(
    [
      "select actor_type, actor_id, action, target_type, target_id, details",
      "  from audit_events",
      " order by id",
    ].join("\n"),
  );
  return { configs: configs.rows, changes: changes.rows, audit: audit.rows };
}

async function counts(): Promise<{
  configs: number;
  changes: number;
  audit: number;
}> {
  const result = await pool.query<{
    configs: number;
    changes: number;
    audit: number;
  }>(
    [
      "select",
      "  (select count(*) from control_config_taxi)::int as configs,",
      "  (select count(*) from control_config_changes)::int as changes,",
      "  (select count(*) from audit_events)::int as audit",
    ].join("\n"),
  );
  return result.rows[0];
}

function seedClassificationObservations(): NormalizedObservation[] {
  return [
    {
      eventId: "00000000-0000-4000-8000-000000000001",
      occurredAt: "2026-06-01T00:00:00.000Z",
      vehicleReady: true,
      paused: false,
      playback: "playing",
      technicalFault: false,
    },
    {
      eventId: "00000000-0000-4000-8000-000000000002",
      occurredAt: "2026-06-01T01:00:00.000Z",
      vehicleReady: false,
      paused: null,
      playback: "stopped",
      technicalFault: false,
    },
    {
      eventId: "00000000-0000-4000-8000-000000000003",
      occurredAt: "2026-06-01T02:00:00.000Z",
      vehicleReady: true,
      paused: true,
      playback: "playing",
      technicalFault: false,
    },
  ];
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = ("gtads_cx013_" + process.pid + "_" + Date.now().toString(36))
    .toLowerCase()
    .slice(0, 63);
  await maintenancePool.query("create database " + quoteIdentifier(databaseName));

  pool = new Pool({ ...base, database: databaseName });
  for (const migration of [
    "0001_gt_ads_001.up.sql",
    "0002_gt_ads_004_telemetry.up.sql",
    "0003_cx_011_telemetry_rollups.up.sql",
    "0004_cx_012_remote_control.up.sql",
    "0005_cx_013_control_config.up.sql",
  ]) {
    await pool.query(await readMigration(migration));
  }

  registrationCodeId = randomUUID();
  await pool.query(
    [
      "insert into registration_codes",
      "  (id, code_hash, label, created_at, created_by, expires_at)",
      "values ($1, $2, $3, $4, $5, $6)",
    ].join(" "),
    [
      registrationCodeId,
      Buffer.from("SYN-CX-013-registration-code"),
      "SYN-CX-013",
      new Date(BASE_TIME),
      "SYN-Test",
      new Date(BASE_TIME + 86_400_000),
    ],
  );
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
      "SYN-CX-013-Tablet",
      Buffer.from("SYN-CX-013-Key"),
      "SYN-CX-013-Fingerprint",
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
}, 30_000);

beforeEach(async () => {
  await pool.query(
    "truncate table control_config_changes, control_config_taxi restart identity",
  );
  await pool.query("delete from audit_events");
  await pool.query("delete from telemetry_observations");
  await pool.query("update devices set state = 'active'");
  service = newService();
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

describe("CX-013 versionierte Pausenkonfiguration", () => {
  it("liefert ohne gespeicherte Konfiguration Revision 0, GPS aus und drei unentschiedene Parameter", async () => {
    await expect(read(service)).resolves.toEqual({
      taxi_id: TAXI_A,
      revision: 0,
      gps_mode: "aus",
      pause_max_duration_s: null,
      pause_end_on_vehicle_off: null,
      display_run_on_s: null,
      policy_complete: false,
    });

    // Kein stillschweigender 60-Minuten- oder 120-Sekunden-Default und keine
    // Mutation allein durch das Lesen.
    expect(await snapshot()).toEqual({ configs: [], changes: [], audit: [] });
  });

  it("speichert ausdrueckliche Pausenregeln und Nachlauf und liest sie nach neuer Instanz unveraendert", async () => {
    const changeId = randomUUID();
    const applied = await update(service, {
      change_id: changeId,
      config: COMPLETE,
    });

    expect(applied).toEqual({
      taxi_id: TAXI_A,
      revision: 1,
      gps_mode: "aus",
      pause_max_duration_s: 1234,
      pause_end_on_vehicle_off: true,
      display_run_on_s: 45,
      policy_complete: true,
      change_id: changeId,
      idempotent: false,
    });

    const restarted = newService();
    await expect(read(restarted)).resolves.toEqual({
      taxi_id: TAXI_A,
      revision: 1,
      gps_mode: "aus",
      pause_max_duration_s: 1234,
      pause_end_on_vehicle_off: true,
      display_run_on_s: 45,
      policy_complete: true,
    });

    const stored = await pool.query<ConfigSnapshotRow>(
      [
        "select taxi_id, revision::int as revision, gps_mode,",
        "       pause_max_duration_s::text as pause_max_duration_s,",
        "       pause_end_on_vehicle_off,",
        "       display_run_on_s::text as display_run_on_s",
        "  from control_config_taxi where taxi_id = $1",
      ].join("\n"),
      [TAXI_A],
    );
    expect(stored.rows[0]).toMatchObject({
      pause_max_duration_s: "1234",
      pause_end_on_vehicle_off: true,
      display_run_on_s: "45",
    });

    const audit = await snapshot();
    expect(audit.changes).toHaveLength(1);
    expect(audit.audit).toHaveLength(1);
    expect(audit.audit[0]).toMatchObject({
      actor_type: "admin",
      actor_id: ADMIN_ID,
      action: CONTROL_CONFIG_AUDIT_ACTION,
      target_type: "taxi",
      target_id: TAXI_A,
      details: {
        change_id: changeId,
        revision: 1,
        expected_revision: 0,
        previous: {
          gps_mode: "aus",
          pause_max_duration_s: null,
          pause_end_on_vehicle_off: null,
          display_run_on_s: null,
        },
        next: {
          gps_mode: "aus",
          pause_max_duration_s: 1234,
          pause_end_on_vehicle_off: true,
          display_run_on_s: 45,
        },
      },
    });
    expect(JSON.stringify(audit.audit[0].details)).not.toMatch(
      /latitude|longitude|accuracy|position|device_id/i,
    );
  });

  it("meldet policy_complete erst, wenn alle drei offenen Parameter explizit gesetzt sind", async () => {
    const unresolved = await update(service, { config: UNRESOLVED });
    expect(unresolved.policy_complete).toBe(false);

    const partial = await update(service, {
      expected_revision: unresolved.revision,
      config: {
        gps_mode: "aus",
        pause_max_duration_s: 900,
        pause_end_on_vehicle_off: null,
        display_run_on_s: null,
      },
    });
    expect(partial.policy_complete).toBe(false);
    await expect(read(service)).resolves.toMatchObject({
      revision: 2,
      pause_max_duration_s: 900,
      pause_end_on_vehicle_off: null,
      display_run_on_s: null,
      policy_complete: false,
    });

    const complete = await update(service, {
      expected_revision: partial.revision,
      config: {
        gps_mode: "aus",
        pause_max_duration_s: 900,
        pause_end_on_vehicle_off: false,
        display_run_on_s: 0,
      },
    });
    expect(complete.policy_complete).toBe(true);
    await expect(read(service)).resolves.toMatchObject({
      revision: 3,
      pause_max_duration_s: 900,
      pause_end_on_vehicle_off: false,
      display_run_on_s: 0,
      policy_complete: true,
    });
  });

  it("lehnt negative, nicht ganzzahlige, unsichere und unbekannte Werte ohne Mutation ab", async () => {
    const baseline = await update(service, { config: COMPLETE });
    const before = await snapshot();

    const invalidConfigs: Array<[string, unknown]> = [
      ["negative Pausenmaximaldauer", { ...COMPLETE, pause_max_duration_s: -1 }],
      ["Pausenmaximaldauer null", { ...COMPLETE, pause_max_duration_s: 0 }],
      ["nicht ganzzahlige Pausenmaximaldauer", { ...COMPLETE, pause_max_duration_s: 1.5 }],
      ["Pausenmaximaldauer NaN", { ...COMPLETE, pause_max_duration_s: Number.NaN }],
      ["Pausenmaximaldauer Infinity", { ...COMPLETE, pause_max_duration_s: Number.POSITIVE_INFINITY }],
      [
        "Pausenmaximaldauer unsicher",
        { ...COMPLETE, pause_max_duration_s: Number.MAX_SAFE_INTEGER + 1 },
      ],
      ["negativer Display-Nachlauf", { ...COMPLETE, display_run_on_s: -1 }],
      ["nicht ganzzahliger Display-Nachlauf", { ...COMPLETE, display_run_on_s: 2.5 }],
      ["Display-Nachlauf NaN", { ...COMPLETE, display_run_on_s: Number.NaN }],
      ["Display-Nachlauf Infinity", { ...COMPLETE, display_run_on_s: Number.POSITIVE_INFINITY }],
      [
        "Display-Nachlauf unsicher",
        { ...COMPLETE, display_run_on_s: Number.MAX_SAFE_INTEGER + 1 },
      ],
      [
        "Pause-ende-bei-Fahrzeug-aus kein Boolean",
        { ...COMPLETE, pause_end_on_vehicle_off: "true" },
      ],
      ["unbekanntes Feld", { ...COMPLETE, approval_reference: "SYN-CX-013" }],
    ];

    for (const [_label, config] of invalidConfigs) {
      await expect(
        update(service, {
          expected_revision: baseline.revision,
          config: config as TaxiControlConfigValues,
        }),
      ).rejects.toBeInstanceOf(ControlConfigValidationError);
    }

    await expect(
      update(service, {
        expected_revision: baseline.revision,
        config: COMPLETE,
        gps_approval: { granted: true },
      } as unknown as UpdateTaxiConfigInput),
    ).rejects.toBeInstanceOf(ControlConfigValidationError);

    await expect(
      update(service, {
        expected_revision: baseline.revision,
        config: { ...COMPLETE, latitude: 48.2082 } as unknown as TaxiControlConfigValues,
      }),
    ).rejects.toBeInstanceOf(ControlConfigValidationError);

    await expect(
      update(service, { expected_revision: baseline.revision, change_id: "   " }),
    ).rejects.toBeInstanceOf(ControlConfigValidationError);

    expect(await snapshot()).toEqual(before);
  });

  it("sperrt GPS hart auf aus; fehlende oder vom Client behauptete Freigaben umgehen die Sperre nicht", async () => {
    const baseline = await update(service, { config: COMPLETE });
    const before = await snapshot();

    for (const gpsMode of ["an", "lokal_gebiet", "uebermittlung", "AUS"]) {
      await expect(
        update(service, {
          expected_revision: baseline.revision,
          config: {
            ...COMPLETE,
            gps_mode: gpsMode,
          } as unknown as TaxiControlConfigValues,
        }),
      ).rejects.toBeInstanceOf(ControlConfigValidationError);
    }

    await expect(
      update(service, {
        expected_revision: baseline.revision,
        config: COMPLETE,
        gps_approval: { granted: true, reference: "SYN-CX-013" },
      } as unknown as UpdateTaxiConfigInput),
    ).rejects.toBeInstanceOf(ControlConfigValidationError);

    await expect(
      update(service, {
        expected_revision: baseline.revision,
        config: { ...COMPLETE, legal_release: true } as unknown as TaxiControlConfigValues,
      }),
    ).rejects.toBeInstanceOf(ControlConfigValidationError);

    expect(await snapshot()).toEqual(before);

    // Auch die Datenbank selbst haelt die Sperre ein.
    await expect(
      pool.query(
        "update control_config_taxi set gps_mode = 'uebermittlung' where taxi_id = $1",
        [TAXI_A],
      ),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it("bleibt bei gleicher change_id und gleichem Inhalt idempotent, auch nach weiteren Aenderungen", async () => {
    const changeId = randomUUID();
    const first = await update(service, {
      change_id: changeId,
      config: COMPLETE,
    });
    const afterFirst = await snapshot();

    const replay = await update(service, {
      change_id: changeId,
      expected_revision: 99,
      config: COMPLETE,
    });
    expect(replay).toMatchObject({
      change_id: changeId,
      revision: first.revision,
      idempotent: true,
      pause_max_duration_s: 1234,
      policy_complete: true,
    });
    expect(await snapshot()).toEqual(afterFirst);

    await expect(
      update(service, {
        change_id: changeId,
        expected_revision: 1,
        config: { ...COMPLETE, pause_max_duration_s: 777 },
      }),
    ).rejects.toBeInstanceOf(ControlConfigChangeConflictError);
    expect(await snapshot()).toEqual(afterFirst);

    const second = await update(service, {
      expected_revision: first.revision,
      config: {
        gps_mode: "aus",
        pause_max_duration_s: 777,
        pause_end_on_vehicle_off: false,
        display_run_on_s: 10,
      },
    });
    expect(second.revision).toBe(2);
    const afterSecond = await snapshot();

    const replayAfterSecond = await update(service, {
      change_id: changeId,
      expected_revision: 2,
      config: COMPLETE,
    });
    expect(replayAfterSecond.revision).toBe(1);
    expect(replayAfterSecond.idempotent).toBe(true);
    expect(await snapshot()).toEqual(afterSecond);
    expect(await counts()).toEqual({ configs: 1, changes: 2, audit: 2 });
  });

  it("laesst bei konkurrierenden expected_revision-Werten genau ein Update gewinnen", async () => {
    const secondService = newService();
    const settled = await Promise.allSettled([
      update(service, {
        change_id: randomUUID(),
        expected_revision: 0,
        config: COMPLETE,
      }),
      update(secondService, {
        change_id: randomUUID(),
        expected_revision: 0,
        config: {
          gps_mode: "aus",
          pause_max_duration_s: 2222,
          pause_end_on_vehicle_off: false,
          display_run_on_s: 15,
        },
      }),
    ]);

    const fulfilled = settled.filter(
      (entry): entry is PromiseFulfilledResult<UpdateTaxiConfigResult> =>
        entry.status === "fulfilled",
    );
    const rejected = settled.filter(
      (entry): entry is PromiseRejectedResult => entry.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(
      ControlConfigRevisionConflictError,
    );
    expect(await counts()).toEqual({ configs: 1, changes: 1, audit: 1 });

    await expect(read(service)).resolves.toMatchObject({
      revision: 1,
      pause_max_duration_s: fulfilled[0].value.pause_max_duration_s,
      pause_end_on_vehicle_off:
        fulfilled[0].value.pause_end_on_vehicle_off,
      display_run_on_s: fulfilled[0].value.display_run_on_s,
    });
  });

  it("bleibt bei paralleler Wiederholung derselben change_id genau einmal wirksam", async () => {
    const secondService = newService();
    const changeId = randomUUID();

    const settled = await Promise.allSettled([
      update(service, {
        change_id: changeId,
        expected_revision: 0,
        config: COMPLETE,
      }),
      update(secondService, {
        change_id: changeId,
        expected_revision: 0,
        config: COMPLETE,
      }),
    ]);

    expect(settled.every((entry) => entry.status === "fulfilled")).toBe(true);
    const results = settled.map(
      (entry) => (entry as PromiseFulfilledResult<UpdateTaxiConfigResult>).value,
    );
    expect(results.filter((result) => result.idempotent)).toHaveLength(1);
    expect(results.map((result) => result.revision)).toEqual([1, 1]);
    expect(await counts()).toEqual({ configs: 1, changes: 1, audit: 1 });
  });

  it("verhindert die Konfigurationsaenderung vollstaendig, wenn das Audit nicht geschrieben werden kann", async () => {
    const failingService = newService({
      auditWriter: async (executor, event) => {
        await insertAuditEvent(executor, event);
        throw new Error("SYN-CX-013 Audit-Schreibfehler");
      },
    });
    const changeId = randomUUID();

    await expect(
      update(failingService, {
        change_id: changeId,
        expected_revision: 0,
        config: COMPLETE,
      }),
    ).rejects.toThrow("SYN-CX-013 Audit-Schreibfehler");

    expect(await snapshot()).toEqual({ configs: [], changes: [], audit: [] });

    const retry = await update(service, {
      change_id: changeId,
      expected_revision: 0,
      config: COMPLETE,
    });
    expect(retry.revision).toBe(1);
    expect(await counts()).toEqual({ configs: 1, changes: 1, audit: 1 });
  });

  it("laesst bestehende Geraete-, Telemetriedaten und die Klassifikation unveraendert", async () => {
    await pool.query(
      [
        "insert into telemetry_observations",
        "  (device_id, event_id, occurred_at, vehicle_ready, paused,",
        "   playback, technical_fault, received_at)",
        "values ($1, $2, $3, true, false, 'playing', false, $4)",
      ].join(" "),
      [
        deviceId,
        randomUUID(),
        new Date("2026-06-01T00:30:00.000Z"),
        new Date("2026-06-01T00:31:00.000Z"),
      ],
    );

    const observations = seedClassificationObservations();
    const policy: EvaluationPolicy = {
      policyVersion: "cx-013-invariant-v1",
      maxObservationAgeSeconds: 3600,
      e36: { pauseResetOnVehicleOff: false, pauseMaxSeconds: null },
      e40: { displayRunOnSeconds: 120 },
    };
    const classificationInput = {
      tabletId: "tablet-cx-013",
      localDate: "2026-06-01",
      timeZone: "UTC",
      evaluatedAt: "2026-06-02T00:00:00.000Z",
      observations,
      policy,
    };

    const devicesBefore = await pool.query(
      "select id::text as id, state, last_seen_at, last_seq from devices order by id",
    );
    const telemetryBefore = await pool.query(
      [
        "select id::text as id, device_id::text as device_id,",
        "       event_id::text as event_id, occurred_at, vehicle_ready,",
        "       paused, playback, technical_fault, received_at",
        "  from telemetry_observations order by id",
      ].join("\n"),
    );
    const classificationBefore = classifyDay(classificationInput);
    const keysBefore = [...CLASSIFICATION_KEYS];

    await update(service, { config: COMPLETE });
    await update(service, {
      taxi_id: TAXI_B,
      expected_revision: 0,
      config: UNRESOLVED,
    });

    const devicesAfter = await pool.query(
      "select id::text as id, state, last_seen_at, last_seq from devices order by id",
    );
    const telemetryAfter = await pool.query(
      [
        "select id::text as id, device_id::text as device_id,",
        "       event_id::text as event_id, occurred_at, vehicle_ready,",
        "       paused, playback, technical_fault, received_at",
        "  from telemetry_observations order by id",
      ].join("\n"),
    );
    const classificationAfter = classifyDay(classificationInput);

    expect(devicesAfter.rows).toEqual(devicesBefore.rows);
    expect(telemetryAfter.rows).toEqual(telemetryBefore.rows);
    expect(classificationAfter).toEqual(classificationBefore);
    expect([...CLASSIFICATION_KEYS]).toEqual(keysBefore);
    expect(keysBefore).toEqual([
      "healthy",
      "vehicle_off_expected",
      "paused_conscious",
      "technical_fault",
      "unknown",
    ]);
  });
});
