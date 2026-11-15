/**
 * CX-130 / R-106 Teil 3: Integrationsnachweis der geschuetzten,
 * revisionsgebundenen Inventaraenderung.
 *
 * Die Tests laufen gegen die echte Serverfabrik, eine echte
 * PostgreSQL-Datenbank sowie echte Admin- und Operator-Sitzungscookies mit
 * produktiver Principal-Ermittlung. Es gibt keinen Listener und keine Mocks
 * fuer Authentifizierung, Rechte, Persistenz oder Audit. Alle Kennungen und
 * Texte sind synthetisch.
 */
import {
  generateKeyPairSync,
  randomUUID,
  sign as signWithKey,
  type KeyObject,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { buildSignatureMessage } from "../../src/crypto/deviceSignature.js";
import { hashPassword } from "../../src/crypto/password.js";
import { migrateUp } from "../../src/db/migrate.js";
import { LEGACY_ADMIN_PRINCIPAL_ID } from "../../src/http/principal.js";
import { createServer } from "../../src/http/server.js";
import { ensureTabletActivationSchema } from "../../src/modules/tabletActivation/index.js";
import { ADMIN_SESSION_COOKIE } from "../../src/modules/adminAuth/middleware.js";
import { OPERATOR_SCRYPT_PARAMS } from "../../src/modules/adminAuth/service.js";
import { INVENTORY_AUDIT_ACTION } from "../../src/modules/inventory/service.js";

const BASE_TIME = Date.parse("2026-11-14T12:00:00.000Z");
const ADMIN_PASSWORD = "SYN-CX130-Inventar-Passwort";
const HOST = "127.0.0.1:8080";
const ADMIN_ID = "SYN-CX130-ADMIN";
const OPERATOR_USERNAME = "syn.cx130.operator";
const OPERATOR_PASSWORD = "SYN-CX130-Operator-Passwort";
const JSON_HEADERS = { "content-type": "application/json" };

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/db/migrations",
);

async function applyInventoryUp(): Promise<void> {
  await pool.query(
    await readFile(
      join(MIGRATIONS_DIR, "0014_cx_128_device_inventory.up.sql"),
      "utf8",
    ),
  );
}

async function applyOperatorsUp(): Promise<void> {
  await pool.query(
    await readFile(
      join(MIGRATIONS_DIR, "0015_cx_057_operators.up.sql"),
      "utf8",
    ),
  );
}

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let config: AppConfig;
let operatorActorId = "";
const openApps: FastifyInstance[] = [];

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
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
    throw new Error("CX-130 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx130_inventory_" +
    process.pid +
    "_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 8)
  )
    .toLowerCase()
    .slice(0, 63);
  await maintenancePool.query(
    "create database " + quoteIdentifier(databaseName),
  );

  pool = new Pool({ ...base, database: databaseName });
  await migrateUp(pool);
  await applyInventoryUp();
  await applyOperatorsUp();
  await ensureTabletActivationSchema(pool);

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX130-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };

  // Echte Operator-Sitzungsidentitaet: Konto mit versioniertem scrypt-Hash.
  operatorActorId = randomUUID();
  await pool.query(
    [
      "insert into operators",
      "  (actor_id, username, password_hash, status, created_at, disabled_at)",
      "values ($1::uuid, $2, $3, 'active', $4, null)",
    ].join("\n"),
    [
      operatorActorId,
      OPERATOR_USERNAME,
      await hashPassword(OPERATOR_PASSWORD, {
        params: OPERATOR_SCRYPT_PARAMS,
      }),
      new Date(BASE_TIME - 86_400_000),
    ],
  );
}, 60_000);

beforeEach(async () => {
  await pool.query("drop trigger if exists cx130_fail_audit on audit_events");
  await pool.query("drop function if exists cx130_fail_audit() cascade");
  await pool.query(
    "truncate table device_inventory, audit_events," +
      " tablet_admin_states, devices, registration_codes," +
      " admin_sessions restart identity cascade",
  );
});

afterEach(async () => {
  for (const app of openApps.splice(0)) {
    await app.close();
  }
});

afterAll(async () => {
  await pool.end();
  await maintenancePool.query(
    "drop database if exists " + quoteIdentifier(databaseName),
  );
  await maintenancePool.end();
}, 30_000);

async function buildApp(): Promise<FastifyInstance> {
  const app = createServer({
    config,
    pool,
    now: () => new Date(BASE_TIME),
    logger: { level: "silent" },
  });
  await app.ready();
  openApps.push(app);
  return app;
}

async function loginCookie(
  app: FastifyInstance,
  options: {
    username?: string;
    password?: string;
    remoteAddress?: string;
  } = {},
): Promise<string> {
  const payload: Record<string, string> = {
    password: options.password ?? ADMIN_PASSWORD,
  };
  if (options.username !== undefined) {
    payload.username = options.username;
  }
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/login",
    headers: { host: HOST, ...JSON_HEADERS },
    payload,
    remoteAddress: options.remoteAddress ?? "192.0.2.252",
  });
  expect(response.statusCode).toBe(204);
  const raw = response.headers["set-cookie"];
  const first = Array.isArray(raw)
    ? (raw[0] as string)
    : (raw as string | undefined);
  expect(first, "Set-Cookie fehlt").toBeTruthy();
  return (first as string)
    .split(";")[0]!
    .slice(ADMIN_SESSION_COOKIE.length + 1);
}

function headers(
  cookie: string | null,
  extra: Record<string, string> = {},
): Record<string, string> {
  const result: Record<string, string> = {
    host: HOST,
    ...JSON_HEADERS,
    ...extra,
  };
  if (cookie !== null) {
    result.cookie = ADMIN_SESSION_COOKIE + "=" + cookie;
  }
  return result;
}

async function insertDevice(publicKeySpki?: Buffer): Promise<string> {
  const registrationCodeId = randomUUID();
  const deviceId = randomUUID();
  await pool.query(
    [
      "insert into registration_codes",
      "  (id, code_hash, label, created_at, created_by, expires_at)",
      "values ($1::uuid, $2, $3, $4, $5, $6)",
    ].join("\n"),
    [
      registrationCodeId,
      Buffer.from("SYN-CX130-Code-" + registrationCodeId),
      "SYN-CX130",
      new Date(BASE_TIME),
      ADMIN_ID,
      new Date(BASE_TIME + 3_600_000),
    ],
  );
  await pool.query(
    [
      "insert into devices",
      "  (id, label, public_key_spki, public_key_fingerprint, state,",
      "   manufacturer, model, os_version, sdk_int, app_version, app_flavor,",
      "   registration_code_id, registration_request_id, registered_at, last_seen_at)",
      "values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,",
      "        $12::uuid, $13::uuid, $14, $15)",
    ].join("\n"),
    [
      deviceId,
      "SYN-CX130-Tablet",
      publicKeySpki ?? Buffer.from("SYN-CX130-Key-" + deviceId),
      "SYN-CX130-FP-" + deviceId,
      "active",
      "SYN-Hersteller",
      "SYN-Modell",
      "SYN-Android",
      34,
      "0.0.0-syn",
      "syn",
      registrationCodeId,
      randomUUID(),
      new Date(BASE_TIME),
      new Date(BASE_TIME),
    ],
  );
  return deviceId;
}

async function deviceAccessToken(
  app: FastifyInstance,
  deviceId: string,
  privateKey: KeyObject,
): Promise<string> {
  const requestHeaders = {
    host: HOST,
    ...JSON_HEADERS,
    "x-gt-ads-api-version": "1",
  };
  const challengeResponse = await app.inject({
    method: "POST",
    url: "/v1/device/auth/challenge",
    headers: requestHeaders,
    payload: { device_id: deviceId },
    remoteAddress: "192.0.2.254",
  });
  expect(challengeResponse.statusCode, challengeResponse.body).toBe(200);
  const nonce = challengeResponse.json().nonce as string;
  const signature = signWithKey(
    "sha256",
    Buffer.from(buildSignatureMessage(deviceId, nonce), "utf8"),
    { key: privateKey, dsaEncoding: "der" },
  ).toString("base64");
  const tokenResponse = await app.inject({
    method: "POST",
    url: "/v1/device/auth/token",
    headers: requestHeaders,
    payload: { device_id: deviceId, nonce, signature },
    remoteAddress: "192.0.2.254",
  });
  expect(tokenResponse.statusCode, tokenResponse.body).toBe(200);
  return tokenResponse.json().access_token as string;
}

async function setAdminState(
  deviceId: string,
  active: boolean,
  revision: number,
): Promise<void> {
  await pool.query(
    "insert into tablet_admin_states (device_id, active, revision)" +
      " values ($1::uuid, $2, $3)",
    [deviceId, active, revision],
  );
}

interface InventoryRow {
  device_id: string;
  serial_number: string | null;
  device_type: string | null;
  replacement_note: string | null;
  revision: number;
}

async function inventoryRow(
  deviceId: string,
): Promise<InventoryRow | null> {
  const result = await pool.query<InventoryRow>(
    [
      "select device_id::text as device_id, serial_number, device_type,",
      "       replacement_note, revision::int as revision",
      "  from device_inventory where device_id = $1::uuid",
    ].join("\n"),
    [deviceId],
  );
  return result.rows[0] ?? null;
}

interface DeviceIdentity {
  label: string;
  state: string;
  public_key_fingerprint: string;
  model: string;
}

async function deviceIdentity(
  deviceId: string,
): Promise<DeviceIdentity | null> {
  const result = await pool.query<DeviceIdentity>(
    [
      "select label, state, public_key_fingerprint, model",
      "  from devices where id = $1::uuid",
    ].join("\n"),
    [deviceId],
  );
  return result.rows[0] ?? null;
}

async function adminState(
  deviceId: string,
): Promise<{ active: boolean; revision: number } | null> {
  const result = await pool.query<{ active: boolean; revision: number }>(
    [
      "select active, revision::int as revision",
      "  from tablet_admin_states where device_id = $1::uuid",
    ].join("\n"),
    [deviceId],
  );
  return result.rows[0] ?? null;
}

async function inventoryAudits(): Promise<
  Array<{
    actor_id: string | null;
    target_id: string | null;
    details: Record<string, unknown>;
  }>
> {
  const result = await pool.query<{
    actor_id: string | null;
    target_id: string | null;
    details: Record<string, unknown>;
  }>(
    [
      "select actor_id, target_id, details",
      "  from audit_events where action = $1",
      " order by id asc",
    ].join("\n"),
    [INVENTORY_AUDIT_ACTION],
  );
  return result.rows;
}

function inventoryUrl(deviceId: string): string {
  return "/v1/admin/inventory/" + encodeURIComponent(deviceId);
}

async function patchInventory(
  app: FastifyInstance,
  requestHeaders: Record<string, string>,
  deviceId: string,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; json: () => any }> {
  return app.inject({
    method: "PATCH",
    url: inventoryUrl(deviceId),
    headers: requestHeaders,
    payload,
  });
}

describe("CX-130 geschuetzte Inventaraenderung", () => {
  it("speichert als Admin-Sitzung, bindet den Auditakteur an die Sitzung und verweigert eine Operator-Sitzung ohne Mutation", async () => {
    const deviceId = await insertDevice();
    await setAdminState(deviceId, false, 5);
    const identityBefore = await deviceIdentity(deviceId);
    const app = await buildApp();
    const adminCookie = await loginCookie(app);

    // Produktive Principal-Ermittlung: Der Akteur stammt aus der Sitzung,
    // nicht aus Requestheadern.
    const saved = await patchInventory(
      app,
      headers(adminCookie),
      deviceId,
      {
        serial_number: "  SYN-SERIE-1  ",
        device_type: "SYN-Geraetetyp",
        replacement_note: "SYN-Austauschvermerk",
        revision: 0,
      },
    );
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      id: deviceId,
      serial_number: "SYN-SERIE-1",
      device_type: "SYN-Geraetetyp",
      replacement_note: "SYN-Austauschvermerk",
      revision: 1,
    });
    expect(await inventoryRow(deviceId)).toEqual({
      device_id: deviceId,
      serial_number: "SYN-SERIE-1",
      device_type: "SYN-Geraetetyp",
      replacement_note: "SYN-Austauschvermerk",
      revision: 1,
    });
    expect(await deviceIdentity(deviceId)).toEqual(identityBefore);
    expect(await adminState(deviceId)).toEqual({ active: false, revision: 5 });

    const firstAudits = await inventoryAudits();
    expect(firstAudits).toHaveLength(1);
    expect(firstAudits[0]).toMatchObject({
      actor_id: LEGACY_ADMIN_PRINCIPAL_ID,
      target_id: deviceId,
      details: {
        revision: 1,
        changed_fields: [
          "serial_number",
          "device_type",
          "replacement_note",
        ],
      },
    });

    // Requestseitige Rollen- und Identitaetsangaben ersetzen weder die
    // Sitzung noch den daraus abgeleiteten Auditakteur.
    const spoofed = await patchInventory(
      app,
      headers(adminCookie, {
        "x-test-role": "Operator",
        "x-actor-id": operatorActorId,
        "x-principal-id": operatorActorId,
      }),
      deviceId,
      {
        serial_number: "SYN-SERIE-2",
        device_type: "SYN-Geraetetyp",
        replacement_note: null,
        revision: 1,
      },
    );
    expect(spoofed.statusCode).toBe(200);
    expect(spoofed.json().revision).toBe(2);

    const auditsAfterSpoof = await inventoryAudits();
    expect(auditsAfterSpoof).toHaveLength(2);
    expect(auditsAfterSpoof[1]).toMatchObject({
      actor_id: LEGACY_ADMIN_PRINCIPAL_ID,
      target_id: deviceId,
      details: { revision: 2 },
    });
    expect(auditsAfterSpoof[1]?.actor_id).not.toBe(operatorActorId);

    // CX-056: Inventaraenderungen bleiben Admin vorbehalten. Die echte
    // Operator-Sitzung wird als Operator erkannt, der Rechtekern verweigert
    // die Aktion vor dem Handler; Inventar und Audit bleiben unveraendert.
    const operatorCookie = await loginCookie(app, {
      username: OPERATOR_USERNAME,
      password: OPERATOR_PASSWORD,
      remoteAddress: "192.0.2.253",
    });
    const cleared = await patchInventory(
      app,
      headers(operatorCookie),
      deviceId,
      {
        serial_number: null,
        device_type: "SYN-Geraetetyp",
        replacement_note: null,
        revision: 2,
      },
    );
    expect(cleared.statusCode).toBe(403);
    expect(cleared.json().error.code).toBe("forbidden");
    expect(await inventoryRow(deviceId)).toEqual({
      device_id: deviceId,
      serial_number: "SYN-SERIE-2",
      device_type: "SYN-Geraetetyp",
      replacement_note: null,
      revision: 2,
    });
    expect(await deviceIdentity(deviceId)).toEqual(identityBefore);
    expect(await adminState(deviceId)).toEqual({ active: false, revision: 5 });

    const allAudits = await inventoryAudits();
    expect(allAudits).toHaveLength(2);
    expect(allAudits[1]).toMatchObject({
      actor_id: LEGACY_ADMIN_PRINCIPAL_ID,
      target_id: deviceId,
      details: { revision: 2 },
    });
  });

  it("verweigert fehlende Sitzung, gueltigen Geraetenachweis und Operator-Sitzung sowie fremde Felder und ueberlange Texte ohne Schreibwirkung", async () => {
    const keyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const publicKeySpki = keyPair.publicKey.export({
      format: "der",
      type: "spki",
    });
    const deviceId = await insertDevice(publicKeySpki);
    const identityBefore = await deviceIdentity(deviceId);
    const app = await buildApp();
    const adminCookie = await loginCookie(app);
    const operatorCookie = await loginCookie(app, {
      username: OPERATOR_USERNAME,
      password: OPERATOR_PASSWORD,
      remoteAddress: "192.0.2.255",
    });
    const accessToken = await deviceAccessToken(
      app,
      deviceId,
      keyPair.privateKey,
    );

    // Ohne Sitzung helfen weder Rollen- noch Identitaetsangaben im Request.
    const withoutSession = await patchInventory(
      app,
      headers(null, {
        "x-test-role": "Admin",
        "x-actor-id": operatorActorId,
        "x-principal-id": operatorActorId,
      }),
      deviceId,
      {
        serial_number: "SYN-DENY",
        device_type: "SYN-DENY",
        replacement_note: "SYN-DENY",
        revision: 0,
      },
    );
    expect(withoutSession.statusCode).toBe(401);
    expect(withoutSession.json().error.code).toBe("unauthorized");

    // Ein gueltiger Geraetenachweis fuer genau dieses Geraet ist keine
    // menschliche Sitzung und erhaelt keinen Zugriff.
    const asDevice = await patchInventory(
      app,
      headers(null, { authorization: "Bearer " + accessToken }),
      deviceId,
      {
        serial_number: "SYN-DENY",
        device_type: "SYN-DENY",
        replacement_note: "SYN-DENY",
        revision: 0,
      },
    );
    expect(asDevice.statusCode).toBe(401);
    expect(asDevice.json().error.code).toBe("unauthorized");

    // Eine echte Operator-Sitzung ist authentifiziert, besitzt aber kein
    // devices.inventory.
    const asOperator = await patchInventory(
      app,
      headers(operatorCookie),
      deviceId,
      {
        serial_number: "SYN-DENY",
        device_type: "SYN-DENY",
        replacement_note: "SYN-DENY",
        revision: 0,
      },
    );
    expect(asOperator.statusCode).toBe(403);
    expect(asOperator.json().error.code).toBe("forbidden");

    const foreignFields = await patchInventory(
      app,
      headers(adminCookie),
      deviceId,
      {
        serial_number: "SYN-FREMD",
        device_type: "SYN-FREMD",
        replacement_note: "SYN-FREMD",
        revision: 0,
        admin_active: true,
        active: false,
        device_id: randomUUID(),
        label: "SYN-FREMD",
        state: "revoked",
      },
    );
    expect(foreignFields.statusCode).toBe(400);
    expect(foreignFields.json().error.code).toBe("invalid_request");

    const missingField = await patchInventory(
      app,
      headers(adminCookie),
      deviceId,
      { serial_number: null, device_type: null, revision: 0 },
    );
    expect(missingField.statusCode).toBe(400);
    expect(missingField.json().error.code).toBe("invalid_request");

    const overlong = [
      { serial_number: "S".repeat(129), device_type: null, replacement_note: null },
      { serial_number: null, device_type: "T".repeat(65), replacement_note: null },
      { serial_number: null, device_type: null, replacement_note: "N".repeat(1001) },
    ];
    for (const fields of overlong) {
      const response = await patchInventory(
        app,
        headers(adminCookie),
        deviceId,
        { ...fields, revision: 0 },
      );
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("invalid_request");
    }

    const invalidId = await app.inject({
      method: "PATCH",
      url: inventoryUrl("nicht-uuid"),
      headers: headers(adminCookie),
      payload: {
        serial_number: null,
        device_type: null,
        replacement_note: null,
        revision: 0,
      },
    });
    expect(invalidId.statusCode).toBe(400);
    expect(invalidId.json().error.code).toBe("invalid_request");

    expect(await inventoryRow(deviceId)).toBeNull();
    expect(await deviceIdentity(deviceId)).toEqual(identityBefore);
    expect(await inventoryAudits()).toHaveLength(0);
  });

  it("liefert bei gleicher Revision genau einen Erfolg und einen 409, 404 bei unbekanntem Geraet und 500 ohne Inventaraenderung bei Auditfehler", async () => {
    const deviceId = await insertDevice();
    const app = await buildApp();
    const adminCookie = await loginCookie(app);
    const authHeaders = headers(adminCookie);

    const created = await patchInventory(app, authHeaders, deviceId, {
      serial_number: "SYN-START",
      device_type: "SYN-Typ",
      replacement_note: null,
      revision: 0,
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().revision).toBe(1);

    const [first, second] = await Promise.all([
      patchInventory(app, authHeaders, deviceId, {
        serial_number: "SYN-KONKURRENT-A",
        device_type: "SYN-Typ",
        replacement_note: null,
        revision: 1,
      }),
      patchInventory(app, authHeaders, deviceId, {
        serial_number: "SYN-KONKURRENT-B",
        device_type: "SYN-Typ",
        replacement_note: null,
        revision: 1,
      }),
    ]);

    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    const success = first.statusCode === 200 ? first : second;
    const conflict = first.statusCode === 409 ? first : second;
    expect(success.json().revision).toBe(2);
    expect(conflict.json().error.code).toBe("invalid_request");
    expect(conflict.json().error.message).toBe("Die Anfrage ist ungueltig.");

    const current = await inventoryRow(deviceId);
    expect(current?.revision).toBe(2);
    expect(current?.serial_number).toBe(success.json().serial_number);
    expect(await inventoryAudits()).toHaveLength(2);

    const unknown = await patchInventory(
      app,
      authHeaders,
      randomUUID(),
      {
        serial_number: null,
        device_type: null,
        replacement_note: null,
        revision: 0,
      },
    );
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("not_found");

    await pool.query(
      [
        "create or replace function cx130_fail_audit() returns trigger",
        "language plpgsql as $$ begin",
        "  raise exception 'SYN-CX130 Auditfehler';",
        "end $$",
      ].join("\n"),
    );
    await pool.query(
      "create trigger cx130_fail_audit before insert on audit_events" +
        " for each row execute function cx130_fail_audit()",
    );

    try {
      const failed = await patchInventory(app, authHeaders, deviceId, {
        serial_number: "SYN-AUDITFEHLER",
        device_type: "SYN-Typ",
        replacement_note: "SYN-AUDITFEHLER",
        revision: 2,
      });
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toMatchObject({
        error: { code: "internal_error", message: "Interner Fehler." },
      });
      expect(typeof failed.json().error.request_id).toBe("string");
      const serialized = JSON.stringify(failed.json());
      expect(serialized).not.toContain("SYN-");
      expect(serialized).not.toContain("audit_events");
    } finally {
      await pool.query("drop trigger if exists cx130_fail_audit on audit_events");
      await pool.query("drop function if exists cx130_fail_audit() cascade");
    }

    expect(await inventoryRow(deviceId)).toEqual(current);
    expect(await inventoryAudits()).toHaveLength(2);
  }, 30_000);
});
