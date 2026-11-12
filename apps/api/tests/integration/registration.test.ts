import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
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
import { CONFIG_DEFAULTS, type AppConfig } from "../../src/config.js";
import {
  generateRegistrationCode,
  hashRegistrationCode,
} from "../../src/crypto/registrationCode.js";
import { migrateUp } from "../../src/db/migrate.js";
import { isSensitiveFieldName } from "../../src/http/logging.js";
import { createServer, type ApiServerOptions } from "../../src/http/server.js";
import { AUDIT_ACTIONS } from "../../src/modules/audit/repository.js";
import { DevicesService } from "../../src/modules/devices/service.js";
import { RegistrationService } from "../../src/modules/registration/service.js";

const BASE_TIME = Date.parse("2026-01-01T12:00:00.000Z");
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const DEVICE_INFO = {
  manufacturer: "SYN-Hersteller",
  model: "SYN-Modell",
  os_version: "14",
  sdk_int: 34,
  app_version: "0.1.0",
  app_flavor: "dev",
};

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let config: AppConfig;
let service: RegistrationService;
let nowMs = BASE_TIME;
const clock = (): Date => new Date(nowMs);
const openApps: FastifyInstance[] = [];

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
    throw new Error("GT-ADS-001 U3 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_u3_" + process.pid + "_" + Date.now().toString(36)
  )
    .toLowerCase()
    .slice(0, 63);
  await maintenancePool.query("create database " + quoteIdentifier(databaseName));

  pool = new Pool({ ...base, database: databaseName });
  await migrateUp(pool);

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-U3-Code-Pepper",
    adminPasswordHash:
      "scrypt$N=16384,r=8,p=1$c3ludGhldGlzY2hlLXNhbHQ$aGFzaC1oYXNoLWhhc2gtaGFzaC1oYXNo",
  };
  service = new RegistrationService({ pool, config, now: clock });
}, 30_000);

afterEach(async () => {
  for (const app of openApps.splice(0)) {
    await app.close();
  }
});

beforeEach(() => {
  nowMs = BASE_TIME;
});

afterAll(async () => {
  await pool.end();
  await maintenancePool.query(
    "drop database if exists " + quoteIdentifier(databaseName),
  );
  await maintenancePool.end();
}, 30_000);

async function buildApp(
  overrides: Partial<ApiServerOptions> = {},
): Promise<FastifyInstance> {
  const app = createServer({ config, pool, now: clock, ...overrides });
  await app.ready();
  openApps.push(app);
  return app;
}

interface DeviceKey {
  spki: string;
}

function makeDeviceKey(curve = "prime256v1"): DeviceKey {
  const pair = generateKeyPairSync("ec", { namedCurve: curve });
  return {
    spki: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

function registrationBody(
  code: string,
  publicKey: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    registration_code: code,
    client_request_id: randomUUID(),
    public_key: publicKey,
    app_env: "test",
    device_info: { ...DEVICE_INFO },
    ...overrides,
  };
}

function register(
  app: FastifyInstance,
  payload: unknown,
  remoteAddress: string,
) {
  return app.inject({
    method: "POST",
    url: "/v1/device/register",
    headers: {
      "content-type": "application/json",
      "x-gt-ads-api-version": "1",
    },
    payload: payload as Record<string, unknown>,
    remoteAddress,
  });
}

function errorBody(response: { json: () => any }): {
  code: string;
  message: string;
  request_id: string;
} {
  return response.json().error;
}

function normalizedErrorBody(response: { json: () => any }): string {
  const body = response.json();
  return JSON.stringify({
    error: { ...body.error, request_id: "REQ" },
  });
}

async function countDevicesForCode(codeId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "select count(*)::text as count from devices where registration_code_id = $1",
    [codeId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function waitForLockWait(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await maintenancePool.query<{ count: string }>(
      [
        "select count(*)::text as count",
        "  from pg_stat_activity",
        " where datname = $1",
        "   and wait_event_type = 'Lock'",
      ].join("\n"),
      [databaseName],
    );
    if (Number(result.rows[0]?.count ?? "0") > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Registrierung wartet nicht auf die Codesperre");
}

describe("U3 Registrierung (I-03 bis I-12)", () => {
  it("I-03 speichert den Code nur als HMAC-Hash", async () => {
    const created = await service.createRegistrationCode({ label: "SYN-Label" });

    const result = await pool.query<{ code_hash: Buffer; label: string | null }>(
      "select code_hash, label from registration_codes where id = $1",
      [created.id],
    );
    const row = result.rows[0];
    expect(row).toBeDefined();
    expect(
      (row?.code_hash as Buffer).equals(
        hashRegistrationCode(created.code, config.registrationCodePepper),
      ),
    ).toBe(true);

    const all = await pool.query(
      "select * from registration_codes where id = $1",
      [created.id],
    );
    const serialized = JSON.stringify(all.rows[0], (_key, value) =>
      value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value,
    );
    expect(serialized).not.toContain(created.code);
    expect(serialized.toLowerCase()).not.toContain(created.code.toLowerCase());
  });

  it("I-04 registriert ein Geraet, verbraucht den Code und schreibt Audit", async () => {
    const app = await buildApp();
    const created = await service.createRegistrationCode({ label: "SYN-Testhandy" });
    const key = makeDeviceKey();

    const response = await register(
      app,
      registrationBody(created.code, key.spki),
      "192.0.2.10",
    );

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.device_id).toMatch(UUID_PATTERN);
    expect(body.server_env).toBe("test");
    expect(body.config).toEqual({ heartbeat_interval_s: 900, api_version: 1 });
    expect(new Date(body.server_time).toISOString()).toBe(body.server_time);

    const device = await pool.query<{
      state: string;
      label: string | null;
      last_seen_at: Date;
    }>(
      "select state, label, last_seen_at from devices where id = $1",
      [body.device_id],
    );
    expect(device.rows[0]?.state).toBe("active");
    expect(device.rows[0]?.label).toBe("SYN-Testhandy");
    expect(new Date(device.rows[0]?.last_seen_at as Date).getTime()).toBe(nowMs);

    const code = await pool.query<{ used_at: Date | null; used_by_device_id: string | null }>(
      "select used_at, used_by_device_id::text as used_by_device_id from registration_codes where id = $1",
      [created.id],
    );
    expect(code.rows[0]?.used_at).not.toBeNull();
    expect(code.rows[0]?.used_by_device_id).toBe(body.device_id);

    const codeAudit = await pool.query<{ action: string }>(
      "select action from audit_events where target_id = $1 order by id",
      [created.id],
    );
    expect(codeAudit.rows.map((row) => row.action)).toEqual([
      AUDIT_ACTIONS.registrationCodeCreated,
      AUDIT_ACTIONS.registrationCodeUsed,
    ]);

    const deviceAudit = await pool.query<{ action: string }>(
      "select action from audit_events where target_id = $1 order by id",
      [body.device_id],
    );
    expect(deviceAudit.rows.map((row) => row.action)).toEqual([
      AUDIT_ACTIONS.deviceRegistered,
    ]);
  });

  it("I-05 lehnt eine zweite Registrierung mit demselben Code ab", async () => {
    const app = await buildApp();
    const created = await service.createRegistrationCode();

    const first = await register(
      app,
      registrationBody(created.code, makeDeviceKey().spki),
      "192.0.2.11",
    );
    expect(first.statusCode).toBe(201);

    const second = await register(
      app,
      registrationBody(created.code, makeDeviceKey().spki),
      "192.0.2.12",
    );
    expect(second.statusCode).toBe(400);
    expect(errorBody(second).code).toBe("invalid_registration_code");
    expect(await countDevicesForCode(created.id)).toBe(1);
  });

  it("I-06 Race: genau eine von zehn parallelen Registrierungen gewinnt", async () => {
    const app = await buildApp();
    const created = await service.createRegistrationCode();
    const keys = Array.from({ length: 10 }, () => makeDeviceKey());

    // Je Quelle nur ein Versuch, damit hier ausschliesslich das Rennen um
    // den Code geprueft wird und nicht die Quellengrenze greift.
    const responses = await Promise.all(
      keys.map((key, index) =>
        register(
          app,
          registrationBody(created.code, key.spki),
          "192.0.2." + (100 + index),
        ),
      ),
    );

    const statuses = responses.map((response) => response.statusCode);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 400)).toHaveLength(9);
    for (const response of responses) {
      if (response.statusCode === 400) {
        expect(errorBody(response).code).toBe("invalid_registration_code");
      }
    }
    expect(await countDevicesForCode(created.id)).toBe(1);
  });

  it("I-06a Rate-Limit parallel je Quelle: nur fuenf gleichzeitige Versuche passieren", async () => {
    const app = await buildApp();
    const source = "203.0.113.70";

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        register(
          app,
          registrationBody(generateRegistrationCode(12), makeDeviceKey().spki),
          source,
        ),
      ),
    );

    const statuses = responses.map((response) => response.statusCode);
    expect(statuses.filter((status) => status === 400)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(5);
    for (const response of responses) {
      if (response.statusCode === 400) {
        expect(errorBody(response).code).toBe("invalid_registration_code");
      } else {
        expect(errorBody(response).code).toBe("rate_limited");
      }
    }
  });

  it("I-06b Rate-Limit parallel global: nur dreissig gleichzeitige Versuche passieren", async () => {
    const app = await buildApp();

    const responses = await Promise.all(
      Array.from({ length: 40 }, (_unused, index) =>
        register(
          app,
          registrationBody(generateRegistrationCode(12), makeDeviceKey().spki),
          "198.18.0." + (index + 1),
        ),
      ),
    );

    const statuses = responses.map((response) => response.statusCode);
    expect(statuses.filter((status) => status === 400)).toHaveLength(30);
    expect(statuses.filter((status) => status === 429)).toHaveLength(10);
    for (const response of responses) {
      if (response.statusCode === 400) {
        expect(errorBody(response).code).toBe("invalid_registration_code");
      } else {
        expect(errorBody(response).code).toBe("rate_limited");
      }
    }
  });

  it("I-06c erfolgreiche Registrierungen verbrauchen kein Fehlversuchskontingent", async () => {
    const app = await buildApp();
    const source = "203.0.113.71";

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const created = await service.createRegistrationCode();
      const response = await register(
        app,
        registrationBody(created.code, makeDeviceKey().spki),
        source,
      );
      expect(response.statusCode).toBe(201);
    }

    const failure = await register(
      app,
      registrationBody(generateRegistrationCode(12), makeDeviceKey().spki),
      source,
    );
    expect(failure.statusCode).toBe(400);
    expect(errorBody(failure).code).toBe("invalid_registration_code");
  });


  it("I-07 Idempotenz: gleiche Anfrage liefert dasselbe Geraet", async () => {
    const app = await buildApp();
    const created = await service.createRegistrationCode();
    const key = makeDeviceKey();
    const payload = registrationBody(created.code, key.spki);

    const first = await register(app, payload, "192.0.2.13");
    const second = await register(app, payload, "192.0.2.13");
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().device_id).toBe(first.json().device_id);
    expect(await countDevicesForCode(created.id)).toBe(1);

    const registered = await pool.query<{ count: string }>(
      "select count(*)::text as count from audit_events where target_id = $1 and action = $2",
      [first.json().device_id, AUDIT_ACTIONS.deviceRegistered],
    );
    expect(Number(registered.rows[0]?.count)).toBe(1);
  });

  it("I-07b idempotente Wiederholung nach Sperre ergibt device_revoked", async () => {
    const app = await buildApp();
    const created = await service.createRegistrationCode();
    const key = makeDeviceKey();
    const payload = registrationBody(created.code, key.spki);

    const first = await register(app, payload, "192.0.2.90");
    expect(first.statusCode).toBe(201);

    const devices = new DevicesService({ pool, config, now: clock });
    await devices.revokeDevice(first.json().device_id);

    const repeat = await register(app, payload, "192.0.2.91");
    expect(repeat.statusCode).toBe(403);
    expect(errorBody(repeat).code).toBe("device_revoked");
    expect(await countDevicesForCode(created.id)).toBe(1);
  });


  it("I-08 abgelaufen/widerrufen/unbekannt/benutzt sind bytegleich (ausser request_id)", async () => {
    const app = await buildApp();

    const unknown = await register(
      app,
      registrationBody(generateRegistrationCode(12), makeDeviceKey().spki),
      "192.0.2.31",
    );

    const usedCode = await service.createRegistrationCode();
    const usedFirst = await register(
      app,
      registrationBody(usedCode.code, makeDeviceKey().spki),
      "192.0.2.32",
    );
    expect(usedFirst.statusCode).toBe(201);
    const usedSecond = await register(
      app,
      registrationBody(usedCode.code, makeDeviceKey().spki),
      "192.0.2.33",
    );

    const expiredCode = await service.createRegistrationCode();
    nowMs += (config.registrationCodeTtlSeconds + 1) * 1000;
    const expired = await register(
      app,
      registrationBody(expiredCode.code, makeDeviceKey().spki),
      "192.0.2.34",
    );

    const revokedCode = await service.createRegistrationCode();
    await service.revokeRegistrationCode(revokedCode.id);
    const revoked = await register(
      app,
      registrationBody(revokedCode.code, makeDeviceKey().spki),
      "192.0.2.35",
    );

    const responses = [unknown, usedSecond, expired, revoked];
    for (const response of responses) {
      expect(response.statusCode).toBe(400);
      expect(errorBody(response).code).toBe("invalid_registration_code");
    }
    expect(new Set(responses.map(normalizedErrorBody)).size).toBe(1);
  });

  it("I-13 wartende Registrierung prueft Ablauf mit frischer Serverzeit", async () => {
    const app = await buildApp();
    const created = await service.createRegistrationCode();
    const payload = registrationBody(created.code, makeDeviceKey().spki);

    const blocker = await pool.connect();
    let committed = false;
    try {
      await blocker.query("begin");
      await blocker.query(
        "select id from registration_codes where id = $1 for update",
        [created.id],
      );

      const pending = register(app, payload, "192.0.2.80");
      await waitForLockWait();

      // Der Code laeuft ab, waehrend die Registrierung auf die Zeilensperre
      // wartet; die Ablaufpruefung muss die neue Serverzeit verwenden.
      nowMs += (config.registrationCodeTtlSeconds + 1) * 1000;

      await blocker.query("commit");
      committed = true;

      const response = await pending;
      expect(response.statusCode).toBe(400);
      expect(errorBody(response).code).toBe("invalid_registration_code");
    } finally {
      if (!committed) {
        try {
          await blocker.query("rollback");
        } catch {
          // Die Sperre wird ohnehin mit der Verbindung freigegeben.
        }
      }
      blocker.release();
    }

    const code = await pool.query<{ used_at: Date | null }>(
      "select used_at from registration_codes where id = $1",
      [created.id],
    );
    expect(code.rows[0]?.used_at).toBeNull();
    expect(await countDevicesForCode(created.id)).toBe(0);
  });


  it("I-09 app_env ungleich Server-Umgebung verbraucht keinen Code", async () => {
    const app = await buildApp();
    const created = await service.createRegistrationCode();

    const response = await register(
      app,
      registrationBody(created.code, makeDeviceKey().spki, { app_env: "dev" }),
      "192.0.2.40",
    );

    expect(response.statusCode).toBe(409);
    expect(errorBody(response).code).toBe("environment_mismatch");

    const code = await pool.query<{ used_at: Date | null }>(
      "select used_at from registration_codes where id = $1",
      [created.id],
    );
    expect(code.rows[0]?.used_at).toBeNull();
    expect(await countDevicesForCode(created.id)).toBe(0);
  });

  it("I-10 derselbe oeffentliche Schluessel zweimal ergibt key_already_registered", async () => {
    const app = await buildApp();
    const key = makeDeviceKey();
    const firstCode = await service.createRegistrationCode();
    const secondCode = await service.createRegistrationCode();

    const first = await register(
      app,
      registrationBody(firstCode.code, key.spki),
      "192.0.2.41",
    );
    expect(first.statusCode).toBe(201);

    const second = await register(
      app,
      registrationBody(secondCode.code, key.spki),
      "192.0.2.42",
    );
    expect(second.statusCode).toBe(409);
    expect(errorBody(second).code).toBe("key_already_registered");

    const devices = await pool.query<{ count: string }>(
      "select count(*)::text as count from devices where public_key_fingerprint is not null",
    );
    expect(Number(devices.rows[0]?.count)).toBeGreaterThanOrEqual(1);
  });

  it("I-11 ungueltige oeffentliche Schluessel und Formatfehler ergeben invalid_request", async () => {
    const app = await buildApp();
    const created = await service.createRegistrationCode();

    const ed25519 = generateKeyPairSync("ed25519");
    const edSpki = ed25519.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64");
    const p384 = makeDeviceKey("secp384r1");

    const invalidKeys = ["kein-base64-!!!", edSpki, p384.spki];
    let index = 0;
    for (const publicKey of invalidKeys) {
      index += 1;
      const response = await register(
        app,
        registrationBody(created.code, publicKey),
        "192.0.2.5" + index,
      );
      expect(response.statusCode).toBe(400);
      expect(errorBody(response).code).toBe("invalid_request");
    }

    const unknownField = await register(
      app,
      { ...registrationBody(created.code, makeDeviceKey().spki), extra: true },
      "192.0.2.59",
    );
    expect(unknownField.statusCode).toBe(400);
    expect(errorBody(unknownField).code).toBe("invalid_request");

    const missingVersion = await app.inject({
      method: "POST",
      url: "/v1/device/register",
      headers: { "content-type": "application/json" },
      payload: registrationBody(created.code, makeDeviceKey().spki),
      remoteAddress: "192.0.2.60",
    });
    expect(missingVersion.statusCode).toBe(400);
    expect(errorBody(missingVersion).code).toBe("invalid_request");
  });

  it("I-12 Rate-Limit je Quelle: sechster Versuch ist auch mit gueltigem Code 429", async () => {
    const app = await buildApp();
    const source = "203.0.113.7";
    const key = makeDeviceKey();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await register(
        app,
        registrationBody(generateRegistrationCode(12), key.spki),
        source,
      );
      expect(response.statusCode).toBe(400);
    }

    const validCode = await service.createRegistrationCode();
    const blocked = await register(
      app,
      registrationBody(validCode.code, makeDeviceKey().spki),
      source,
    );

    expect(blocked.statusCode).toBe(429);
    expect(errorBody(blocked).code).toBe("rate_limited");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("I-12 Rate-Limit global: 31. Fehlversuch von neuer Quelle ist 429", async () => {
    const app = await buildApp();
    const key = makeDeviceKey();

    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const response = await register(
        app,
        registrationBody(generateRegistrationCode(12), key.spki),
        "198.51.100." + attempt,
      );
      expect(response.statusCode).toBe(400);
    }

    const validCode = await service.createRegistrationCode();
    const blocked = await register(
      app,
      registrationBody(validCode.code, makeDeviceKey().spki),
      "198.51.100.200",
    );
    expect(blocked.statusCode).toBe(429);
    expect(errorBody(blocked).code).toBe("rate_limited");
  });
});

describe("U3 Audit und Logs (I-22 Teil, I-24)", () => {
  it("I-22 Audit enthaelt Code erzeugt/benutzt/widerrufen und Geraet registriert ohne Geheimnisse", async () => {
    const app = await buildApp();
    const codeA = await service.createRegistrationCode({ label: "SYN-A" });
    const key = makeDeviceKey();
    const registered = await register(
      app,
      registrationBody(codeA.code, key.spki),
      "192.0.2.70",
    );
    expect(registered.statusCode).toBe(201);
    const deviceId = registered.json().device_id as string;

    const codeB = await service.createRegistrationCode({ label: "SYN-B" });
    await service.revokeRegistrationCode(codeB.id);

    const audit = await pool.query<{
      action: string;
      target_id: string;
      details: Record<string, unknown>;
    }>(
      [
        "select action, target_id::text as target_id, details",
        "  from audit_events",
        " where target_id = any($1::text[])",
        " order by id",
      ].join("\n"),
      [[codeA.id, codeB.id, deviceId]],
    );

    const actions = audit.rows.map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        AUDIT_ACTIONS.registrationCodeCreated,
        AUDIT_ACTIONS.registrationCodeUsed,
        AUDIT_ACTIONS.registrationCodeRevoked,
        AUDIT_ACTIONS.deviceRegistered,
      ]),
    );

    const serialized = JSON.stringify(audit.rows);
    expect(serialized).not.toContain(codeA.code);
    expect(serialized).not.toContain(codeB.code);
    expect(serialized).not.toContain(key.spki);
    expect(serialized).not.toContain("SYN-Signatur");
    expect(serialized).not.toContain("SYN-Nonce");
    expect(serialized).not.toContain("SYN-Passwort");

    for (const row of audit.rows) {
      for (const field of Object.keys(row.details)) {
        expect(isSensitiveFieldName(field), field).toBe(false);
      }
    }
  });

  it("I-24 Server-Logs eines Gesamtlaufs enthalten keine Codes, Schluessel oder Signaturen", async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const app = await buildApp({ logger: { level: "info", stream } });

    const created = await service.createRegistrationCode({ label: "SYN-Log" });
    const key = makeDeviceKey();
    const success = await register(
      app,
      registrationBody(created.code, key.spki),
      "192.0.2.71",
    );
    expect(success.statusCode).toBe(201);

    const failure = await register(
      app,
      registrationBody(generateRegistrationCode(12), makeDeviceKey().spki),
      "192.0.2.72",
    );
    expect(failure.statusCode).toBe(400);

    const health = await app.inject({
      method: "GET",
      url: "/health?registration_code=" + created.code,
      remoteAddress: "192.0.2.73",
    });
    expect(health.statusCode).toBe(200);

    const logText = chunks.join("");
    expect(logText).toContain("/v1/device/register");
    expect(logText).toContain("request completed");
    expect(logText).toContain("REDACTED");
    expect(logText).not.toContain(created.code);
    expect(logText).not.toContain(key.spki);
    expect(logText).not.toContain("registration_code=" + created.code);
  });
});
