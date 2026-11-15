import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
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
import { hashPassword } from "../../src/crypto/password.js";
import { generateAccessToken, hashToken } from "../../src/crypto/tokens.js";
import { migrateUp } from "../../src/db/migrate.js";
import { hasAction, type AccessAction } from "../../src/http/accessPolicy.js";
import { getRoutePolicyInventory } from "../../src/http/authorization.js";
import { createServer } from "../../src/http/server.js";
import type { MediaUploadDeps } from "../../src/http/mediaUpload.js";
import { ensureTaxiGroupSchema } from "../../src/http/taxiGroupRoutes.js";
import { ADMIN_SESSION_COOKIE } from "../../src/modules/adminAuth/middleware.js";
import { ensureCampaignSchema } from "../../src/modules/campaigns/schema.js";
import { ensureTaxiGroupMembershipSchema } from "../../src/modules/taxiGroupMemberships/service.js";
import { ensureTabletActivationSchema } from "../../src/modules/tabletActivation/service.js";
import { ensureTaxiActivationSchema } from "../../src/modules/taxiActivation/service.js";

const BASE_TIME = Date.parse("2026-01-01T12:00:00.000Z");
const ADMIN_PASSWORD = "SYN-CX056-Matrix-Passwort";
const HOST = "127.0.0.1:8080";
const ORIGIN = "http://" + HOST;
const FOREIGN_ORIGIN = "http://fremde.example";

const TAXI_ID = "SYN-CX056-TAXI";
const GROUP_ID = randomUUID();
const CUSTOMER_ID = randomUUID();
const MEDIA_ID = randomUUID();
const CAMPAIGN_ID = randomUUID();
const DEVICE_A_ID = randomUUID();
const DEVICE_B_ID = randomUUID();
const DEVICE_REVOKE_ID = randomUUID();
const DEVICE_DEVICE_ID = randomUUID();
const TABLET_ID = randomUUID();
const TABLET_TAXI_ID = "SYN-CX056-TABLET-TAXI";

const WRITE_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

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
let loginCounter = 0;
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
    throw new Error("CX-056 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx056_matrix_" +
    process.pid +
    "_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 8)
  )
    .toLowerCase()
    .slice(0, 63);
  await maintenancePool.query("create database " + quoteIdentifier(databaseName));

  pool = new Pool({ ...base, database: databaseName });
  await migrateUp(pool);
  const migrationsDirectory = join(process.cwd(), "src/db/migrations");
  for (const file of (await readdir(migrationsDirectory)).sort()) {
    if (!file.endsWith(".up.sql") || file === "0001_gt_ads_001.up.sql") {
      continue;
    }
    await pool.query(await readFile(join(migrationsDirectory, file), "utf8"));
  }

  // Dieselben additiven Schemata, die die produktiven Dienste beim ersten
  // Zugriff anlegen. Sie werden hier einmal bereitgestellt, damit die
  // Zustandspruefung keine Tabelle uebersieht.
  await ensureCampaignSchema(pool);
  await ensureTaxiGroupSchema(pool);
  await ensureTaxiGroupMembershipSchema(pool);
  await ensureTaxiActivationSchema(pool);
  await ensureTabletActivationSchema(pool);

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX056-Matrix-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };
}, 90_000);

beforeEach(async () => {
  await pool.query(
    [
      "truncate table audit_events, admin_sessions, device_access_tokens,",
      "  device_auth_challenges, registration_codes, devices, customers,",
      "  media_objects, campaigns, campaign_targets, taxi_groups,",
      "  taxi_group_memberships, taxis, device_taxi_assignments,",
      "  tablet_admin_states, device_inventory, control_config_taxi,",
      "  control_config_changes, remote_control_deliveries,",
      "  remote_control_commands, remote_control_taxi_state",
      " restart identity cascade",
    ].join("\n"),
  );
  await seedFixtures();
}, 30_000);

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

async function seedFixtures(): Promise<void> {
  for (const [deviceId, state] of [
    [DEVICE_A_ID, "active"],
    [DEVICE_B_ID, "active"],
    [DEVICE_REVOKE_ID, "active"],
    [DEVICE_DEVICE_ID, "active"],
    [TABLET_ID, "active"],
  ] as const) {
    await insertDevice(deviceId, state);
  }

  await pool.query(
    "insert into taxis (id, display_name, active, revision, owner_id) values ($1, $2, false, 1, $3)",
    [TAXI_ID, "SYN CX-056 Taxi", "SYN-Admin"],
  );
  for (const deviceId of [DEVICE_A_ID, DEVICE_B_ID]) {
    await pool.query(
      [
        "insert into device_taxi_assignments",
        "  (device_id, taxi_id, active, updated_at)",
        "values ($1::uuid, $2, true, $3)",
      ].join("\n"),
      [deviceId, TAXI_ID, new Date(BASE_TIME)],
    );
  }

  await pool.query(
    "insert into taxis (id, display_name, active, revision, owner_id) values ($1, $2, false, 1, $3)",
    [TABLET_TAXI_ID, "SYN CX-056 Tablet-Taxi", "SYN-Admin"],
  );
  await pool.query(
    [
      "insert into device_taxi_assignments",
      "  (device_id, taxi_id, active, updated_at)",
      "values ($1::uuid, $2, true, $3)",
    ].join("\n"),
    [TABLET_ID, TABLET_TAXI_ID, new Date(BASE_TIME)],
  );

  await pool.query(
    [
      "insert into control_config_taxi",
      "  (taxi_id, revision, gps_mode, pause_max_duration_s,",
      "   pause_end_on_vehicle_off, display_run_on_s, updated_at)",
      "values ($1, 0, 'aus', null, null, null, $2)",
    ].join("\n"),
    [TAXI_ID, new Date(BASE_TIME)],
  );

  await pool.query(
    "insert into customers (id, display_name) values ($1::uuid, $2)",
    [CUSTOMER_ID, "SYN CX-056 Kunde"],
  );
  await pool.query(
    [
      "insert into media_objects",
      "  (id, display_name, status, created_at)",
      "values ($1::uuid, $2, 'staging', $3)",
    ].join("\n"),
    [MEDIA_ID, "SYN CX-056 Medium", new Date(BASE_TIME)],
  );
  await pool.query(
    [
      "insert into campaigns",
      "  (id, customer_id, media_id, owner_id, rule_type, status, archived,",
      "   start_at, end_at, revision)",
      "values ($1::uuid, $2::uuid, $3::uuid, $4, 'fixed_slot', 'draft', false,",
      "        $5, $6, 1)",
    ].join("\n"),
    [
      CAMPAIGN_ID,
      CUSTOMER_ID,
      MEDIA_ID,
      "SYN-Operator",
      new Date("2026-02-01T00:00:00.000Z"),
      new Date("2026-03-01T00:00:00.000Z"),
    ],
  );
  await pool.query(
    [
      "insert into taxi_groups (id, name, owner_id, revision, created_at)",
      "values ($1::uuid, $2, $3, 1, $4)",
    ].join("\n"),
    [GROUP_ID, "SYN CX-056 Gruppe", "SYN-Admin", new Date(BASE_TIME)],
  );
}

async function insertDevice(
  deviceId: string,
  state: "active" | "revoked",
): Promise<void> {
  const registrationCodeId = randomUUID();
  await pool.query(
    [
      "insert into registration_codes",
      "  (id, code_hash, label, created_at, created_by, expires_at)",
      "values ($1::uuid, $2, $3, $4, $5, $6)",
    ].join("\n"),
    [
      registrationCodeId,
      Buffer.from("SYN-CX056-Code-" + registrationCodeId),
      "SYN-CX056",
      new Date(BASE_TIME),
      "SYN-Admin",
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
      "SYN-CX056-Tablet",
      Buffer.from("SYN-CX056-Key-" + deviceId),
      "SYN-CX056-FP-" + deviceId,
      state,
      DEVICE_INFO.manufacturer,
      DEVICE_INFO.model,
      DEVICE_INFO.os_version,
      DEVICE_INFO.sdk_int,
      DEVICE_INFO.app_version,
      DEVICE_INFO.app_flavor,
      registrationCodeId,
      randomUUID(),
      new Date(BASE_TIME),
      new Date(BASE_TIME),
    ],
  );
}

async function buildApp(
  role: "Admin" | "Operator" | null,
  mediaUpload?: MediaUploadDeps,
): Promise<FastifyInstance> {
  const app = createServer({
    config,
    pool,
    now: () => new Date(BASE_TIME),
    resolvePrincipal: async (request) => {
      if (role === null) {
        return null;
      }
      const cookies = request.cookies as
        | Record<string, string | undefined>
        | undefined;
      const token = cookies?.[ADMIN_SESSION_COOKIE];
      if (typeof token !== "string" || token.length === 0) {
        return null;
      }
      return { id: "SYN-" + role, role };
    },
    mediaUpload,
  });
  await app.ready();
  openApps.push(app);
  return app;
}

function sessionCookieOf(response: {
  headers: Record<string, unknown>;
}): string {
  const raw = response.headers["set-cookie"];
  const first = Array.isArray(raw) ? (raw[0] as string) : (raw as string | undefined);
  expect(first, "Set-Cookie fehlt").toBeTruthy();
  const pair = (first as string).split(";")[0] as string;
  expect(pair.startsWith(ADMIN_SESSION_COOKIE + "=")).toBe(true);
  return pair.slice(ADMIN_SESSION_COOKIE.length + 1);
}

async function loginCookie(app: FastifyInstance): Promise<string> {
  loginCounter += 1;
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/login",
    headers: { host: HOST, "content-type": "application/json" },
    payload: { password: ADMIN_PASSWORD },
    remoteAddress: "192.0.2." + (10 + loginCounter),
  });
  expect(response.statusCode).toBe(204);
  return sessionCookieOf(response);
}

function headers(cookie?: string, extra: Record<string, string> = {}): Record<string, string> {
  const result: Record<string, string> = { host: HOST, ...extra };
  if (cookie !== undefined) {
    result.cookie = ADMIN_SESSION_COOKIE + "=" + cookie;
  }
  return result;
}

function jsonHeaders(cookie?: string, extra: Record<string, string> = {}): Record<string, string> {
  return headers(cookie, { "content-type": "application/json", ...extra });
}

/** Alle Tabellen, die Fachzustand tragen. Sicherheitsartefakte sind bewusst ausgenommen. */
const SECURITY_TABLES: ReadonlySet<string> = new Set([
  "audit_events",
  "admin_sessions",
  "device_access_tokens",
  "device_auth_challenges",
]);

async function snapshotDomainState(): Promise<Record<string, string>> {
  const tables = await pool.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public' order by tablename",
  );
  const snapshot: Record<string, string> = {};
  for (const row of tables.rows) {
    if (SECURITY_TABLES.has(row.tablename)) {
      continue;
    }
    const table = quoteIdentifier(row.tablename);
    const digest = await pool.query<{ digest: string }>(
      [
        "select count(*)::text || ':' ||",
        "  coalesce(md5(string_agg(t::text, '|' order by t::text)), '') as digest",
        "from " + table + " t",
      ].join("\n"),
    );
    snapshot[row.tablename] = digest.rows[0]?.digest ?? "";
  }
  return snapshot;
}

interface WriteRoute {
  readonly method: string;
  readonly url: string;
  readonly action: AccessAction;
}

function humanWriteRoutes(app: FastifyInstance): WriteRoute[] {
  return getRoutePolicyInventory(app)
    .filter((record) => WRITE_METHODS.has(record.method))
    .filter(
      (record): record is typeof record & { policy: { category: "human"; action: AccessAction } } =>
        record.policy?.category === "human",
    )
    .map((record) => ({
      method: record.method,
      url: record.url,
      action: (record.policy as { category: "human"; action: AccessAction }).action,
    }));
}

function concreteUrl(template: string): string {
  return template
    .replace(":taxi_id", TAXI_ID)
    .replace(":taxiId", TAXI_ID)
    .replace(":tabletId", TABLET_ID)
    .replace(":operatorId", randomUUID())
    .replace(":id", randomUUID());
}

interface PayloadFixture {
  payload?: unknown;
  contentType?: string;
}

/**
 * Gueltige Fachpayloads je registriertem Routentemplate. Fehlt ein Eintrag,
 * schlaegt die Matrix fehl: eine neue Schreibroute darf nicht stillschweigend
 * ohne Fall in die Matrix rutschen.
 */
const PAYLOADS: Readonly<Record<string, PayloadFixture>> = Object.freeze({
  "POST /v1/admin/logout": { payload: {} },
  "POST /v1/admin/operators": {
    payload: {
      username: "SYN-CX056-Operator",
      password: "SYN-CX056-Operator-Passwort",
    },
  },
  "POST /v1/admin/operators/:operatorId/disable": {},
  "POST /v1/admin/registration-codes": { payload: { label: "SYN-CX056-Matrix" } },
  "DELETE /v1/admin/registration-codes/:id": {},
  "POST /v1/admin/devices/:id/revoke": {},
  "POST /v1/admin/customers": { payload: { display_name: "SYN-CX056-Matrix" } },
  "POST /v1/admin/campaigns": {
    payload: {
      customer_id: CUSTOMER_ID,
      media_id: MEDIA_ID,
      start_at: "2026-02-01T00:00:00.000Z",
      end_at: "2026-03-01T00:00:00.000Z",
    },
  },
  "PATCH /v1/admin/campaigns/:id": { payload: { archived: true } },
  "PATCH /v1/admin/taxis/:taxiId/config": {
    payload: {
      expected_revision: 0,
      gps_mode: "aus",
      pause_max_duration_s: 300,
      pause_end_on_vehicle_off: false,
      display_run_on_s: 30,
    },
  },
  "POST /v1/admin/taxi-groups": { payload: { name: "SYN-CX056-Matrix" } },
  "PATCH /v1/admin/taxi-groups/:id": {
    payload: { name: "SYN-CX056-Matrix-Neu", revision: 1 },
  },
  "PUT /v1/admin/taxis/:id/groups": { payload: { group_ids: [], revision: 0 } },
  "POST /v1/admin/taxis/:taxiId/activation": { payload: { active: true, revision: 1 } },
  "PATCH /v1/admin/tablets/:tabletId/activation": {
    payload: { active: false, expectedRevision: 0 },
  },
  "POST /v1/admin/taxis/:taxi_id/pause": {
    payload: { command_id: randomUUID(), expected_revision: 0 },
  },
  "POST /v1/admin/taxis/:taxi_id/resume": {
    payload: { command_id: randomUUID(), expected_revision: 0 },
  },
  "PATCH /v1/admin/inventory/:tabletId": {
    payload: {
      serial_number: null,
      device_type: null,
      replacement_note: null,
      revision: 0,
    },
  },
  "POST /v1/admin/media": {
    payload: Buffer.from("SYN-CX056-MEDIENPROBE"),
    contentType: "application/octet-stream",
  },
});

function injectWrite(
  app: FastifyInstance,
  route: WriteRoute,
  options: { cookie?: string; extraHeaders?: Record<string, string> },
) {
  const fixture = PAYLOADS[route.method + " " + route.url];
  expect(fixture, "kein Payload-Fixture fuer " + route.method + " " + route.url).toBeDefined();
  const requestHeaders =
    fixture?.contentType !== undefined
      ? headers(options.cookie, {
          "content-type": fixture.contentType,
          ...options.extraHeaders,
        })
      : jsonHeaders(options.cookie, options.extraHeaders);
  return app.inject({
    method: route.method as "POST" | "PUT" | "PATCH" | "DELETE",
    url: concreteUrl(route.url),
    headers: requestHeaders,
    payload: fixture?.payload as Record<string, unknown> | Buffer | undefined,
    remoteAddress: "192.0.2.240",
  });
}

describe("CX-056 Matrix der Verwaltungs-Schreibrouten", () => {
  it("leitet jede POST/PUT/PATCH/DELETE-Route aus der tatsaechlichen Registrierung ab und verweigert ohne Sitzung 401 sowie unzulaessigen Operatorrollen 403 ohne Fachmutation", async () => {
    const discoveryApp = await buildApp("Admin");
    const routes = humanWriteRoutes(discoveryApp);
    const keys = routes.map((route) => route.method + " " + route.url);

    // Die nach CX-015 ergaenzten Schreibrouten muessen vollstaendig erfasst sein.
    expect(keys).toEqual(
      expect.arrayContaining([
        "POST /v1/admin/media",
        "POST /v1/admin/campaigns",
        "PATCH /v1/admin/campaigns/:id",
        "POST /v1/admin/taxis/:taxi_id/pause",
        "POST /v1/admin/taxis/:taxi_id/resume",
        "POST /v1/admin/taxis/:taxiId/activation",
        "PATCH /v1/admin/tablets/:tabletId/activation",
        "PATCH /v1/admin/inventory/:tabletId",
        "PATCH /v1/admin/taxis/:taxiId/config",
        "PATCH /v1/admin/taxi-groups/:id",
        "PUT /v1/admin/taxis/:id/groups",
      ]),
    );
    expect(routes.length).toBeGreaterThanOrEqual(17);

    const noSessionApp = await buildApp(null);
    const operatorApp = await buildApp("Operator");
    const operatorCookie = await loginCookie(operatorApp);

    for (const route of routes) {
      const label = route.method + " " + route.url;

      const beforeAnonymous = await snapshotDomainState();
      const anonymous = await injectWrite(noSessionApp, route, {});
      expect(anonymous.statusCode, "ohne Sitzung muss 401 gelten: " + label).toBe(401);
      expect(anonymous.json().error.code).toBe("unauthorized");
      expect(await snapshotDomainState(), "401 darf nicht mutieren: " + label).toEqual(
        beforeAnonymous,
      );

      if (!hasAction("Operator", route.action)) {
        const beforeOperator = await snapshotDomainState();
        const denied = await injectWrite(operatorApp, route, { cookie: operatorCookie });
        expect(
          denied.statusCode,
          "Operator darf nicht schreiben: " + label,
        ).toBe(403);
        expect(denied.json().error.code).toBe("forbidden");
        expect(
          await snapshotDomainState(),
          "403 darf nicht mutieren: " + label,
        ).toEqual(beforeOperator);
      }
    }
  });
});

const mediaStubCalls: unknown[] = [];

function mediaStub(): MediaUploadDeps {
  return {
    createMedia: async (_options, input) => {
      mediaStubCalls.push(input);
      return {
        id: randomUUID(),
        displayName: input.displayName.length > 0 ? input.displayName : "SYN-CX056-Medium",
        sizeBytes: 19,
        sha256: "a".repeat(64),
        createdAt: new Date(BASE_TIME),
        status: "ready",
        profile: {
          container: "mp4",
          videoCodec: "h264",
          width: 1920,
          height: 1080,
          frameRateNumerator: 25,
          frameRateDenominator: 1,
          audioStreamCount: 1,
          durationSeconds: 10,
        },
        read: async () => Buffer.from("SYN-CX056-MEDIENPROBE"),
      };
    },
    serviceOptions: { pool, storageRoot: "/tmp/cx056-unbenutzt" },
  };
}

interface PositiveCase {
  readonly name: string;
  readonly role: "Admin" | "Operator";
  readonly run: (app: FastifyInstance, cookie: string) => Promise<void>;
}

const POSITIVE_CASES: readonly PositiveCase[] = [
  {
    name: "Operator laedt Medien hoch (media.write)",
    role: "Operator",
    run: async (app, cookie) => {
      mediaStubCalls.length = 0;
      const response = await app.inject({
        method: "POST",
        url: "/v1/admin/media?name=SYN-CX056-Medienprobe",
        headers: headers(cookie, { "content-type": "application/octet-stream" }),
        payload: Buffer.from("SYN-CX056-MEDIENPROBE"),
        remoteAddress: "192.0.2.241",
      });
      expect(response.statusCode).toBe(201);
      expect(mediaStubCalls).toHaveLength(1);
    },
  },
  {
    name: "Operator legt Kunden und Kampagne an und aendert die Kampagne (campaigns.write)",
    role: "Operator",
    run: async (app, cookie) => {
      const customer = await app.inject({
        method: "POST",
        url: "/v1/admin/customers",
        headers: jsonHeaders(cookie),
        payload: { display_name: "SYN-CX056-Operator-Kunde" },
        remoteAddress: "192.0.2.242",
      });
      expect(customer.statusCode).toBe(201);

      const created = await app.inject({
        method: "POST",
        url: "/v1/admin/campaigns",
        headers: jsonHeaders(cookie),
        payload: {
          customer_id: customer.json().id,
          media_id: MEDIA_ID,
          start_at: "2026-02-01T00:00:00.000Z",
          end_at: "2026-03-01T00:00:00.000Z",
        },
        remoteAddress: "192.0.2.242",
      });
      expect(created.statusCode).toBe(201);

      const updated = await app.inject({
        method: "PATCH",
        url: "/v1/admin/campaigns/" + created.json().id,
        headers: jsonHeaders(cookie),
        payload: { archived: true },
        remoteAddress: "192.0.2.242",
      });
      expect(updated.statusCode).toBe(200);
    },
  },
  {
    name: "Operator pausiert und setzt fort (taxi.pause)",
    role: "Operator",
    run: async (app, cookie) => {
      const paused = await app.inject({
        method: "POST",
        url: "/v1/admin/taxis/" + TAXI_ID + "/pause",
        headers: jsonHeaders(cookie),
        payload: { command_id: randomUUID(), expected_revision: 0 },
        remoteAddress: "192.0.2.243",
      });
      expect(paused.statusCode).toBe(202);
      expect(paused.json().desired_paused).toBe(true);
      const resumed = await app.inject({
        method: "POST",
        url: "/v1/admin/taxis/" + TAXI_ID + "/resume",
        headers: jsonHeaders(cookie),
        payload: { command_id: randomUUID(), expected_revision: 1 },
        remoteAddress: "192.0.2.243",
      });
      expect(resumed.statusCode).toBe(202);
      expect(resumed.json().desired_paused).toBe(false);
    },
  },
  {
    name: "Admin verwaltet Registrierungscodes",
    role: "Admin",
    run: async (app, cookie) => {
      const created = await app.inject({
        method: "POST",
        url: "/v1/admin/registration-codes",
        headers: jsonHeaders(cookie),
        payload: { label: "SYN-CX056-Admin" },
        remoteAddress: "192.0.2.244",
      });
      expect(created.statusCode).toBe(201);
      const deleted = await app.inject({
        method: "DELETE",
        url: "/v1/admin/registration-codes/" + created.json().id,
        headers: jsonHeaders(cookie),
        remoteAddress: "192.0.2.244",
      });
      expect(deleted.statusCode).toBe(204);
    },
  },
  {
    name: "Admin widerruft ein Geraet (devices.revoke)",
    role: "Admin",
    run: async (app, cookie) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/admin/devices/" + DEVICE_REVOKE_ID + "/revoke",
        headers: jsonHeaders(cookie),
        payload: {},
        remoteAddress: "192.0.2.245",
      });
      expect(response.statusCode).toBe(204);
      const state = await pool.query("select state from devices where id = $1::uuid", [
        DEVICE_REVOKE_ID,
      ]);
      expect(state.rows[0]?.state).toBe("revoked");
    },
  },
  {
    name: "Admin aendert die Taxikonfiguration (config.write)",
    role: "Admin",
    run: async (app, cookie) => {
      const response = await app.inject({
        method: "PATCH",
        url: "/v1/admin/taxis/" + TAXI_ID + "/config",
        headers: jsonHeaders(cookie),
        payload: {
          expected_revision: 0,
          gps_mode: "aus",
          pause_max_duration_s: 300,
          pause_end_on_vehicle_off: false,
          display_run_on_s: 30,
        },
        remoteAddress: "192.0.2.246",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().revision).toBe(1);
    },
  },
  {
    name: "Admin aktiviert Taxi und deaktiviert Tablet (taxi-/Geraeteverwaltung)",
    role: "Admin",
    run: async (app, cookie) => {
      const taxi = await app.inject({
        method: "POST",
        url: "/v1/admin/taxis/" + TAXI_ID + "/activation",
        headers: jsonHeaders(cookie),
        payload: { active: true, revision: 1 },
        remoteAddress: "192.0.2.247",
      });
      expect(taxi.statusCode).toBe(200);
      expect(taxi.json()).toEqual({ active: true, revision: 2 });

      const tablet = await app.inject({
        method: "PATCH",
        url: "/v1/admin/tablets/" + TABLET_ID + "/activation",
        headers: jsonHeaders(cookie),
        payload: { active: false, expectedRevision: 0 },
        remoteAddress: "192.0.2.247",
      });
      expect(tablet.statusCode).toBe(200);
      expect(tablet.json().active).toBe(false);
    },
  },
  {
    name: "Admin aendert das Geraeteinventar (devices.inventory)",
    role: "Admin",
    run: async (app, cookie) => {
      const response = await app.inject({
        method: "PATCH",
        url: "/v1/admin/inventory/" + DEVICE_A_ID,
        headers: jsonHeaders(cookie),
        payload: {
          serial_number: "SYN-SERIE-CX056",
          device_type: "SYN-Tablet",
          replacement_note: null,
          revision: 0,
        },
        remoteAddress: "192.0.2.248",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().revision).toBe(1);
    },
  },
  {
    name: "Admin legt eine Taxigruppe an und benennt sie um (groups.write)",
    role: "Admin",
    run: async (app, cookie) => {
      const created = await app.inject({
        method: "POST",
        url: "/v1/admin/taxi-groups",
        headers: jsonHeaders(cookie),
        payload: { name: "SYN-CX056-Neue-Gruppe" },
        remoteAddress: "192.0.2.249",
      });
      expect(created.statusCode).toBe(201);
      const renamed = await app.inject({
        method: "PATCH",
        url: "/v1/admin/taxi-groups/" + created.json().id,
        headers: jsonHeaders(cookie),
        payload: { name: "SYN-CX056-Neue-Gruppe-2", revision: 1 },
        remoteAddress: "192.0.2.249",
      });
      expect(renamed.statusCode).toBe(200);
    },
  },
  {
    name: "Admin ordnet die Gruppen eines Taxis zu (groups.write)",
    role: "Admin",
    run: async (app, cookie) => {
      const response = await app.inject({
        method: "PUT",
        url: "/v1/admin/taxis/" + TAXI_ID + "/groups",
        headers: jsonHeaders(cookie),
        payload: { group_ids: [GROUP_ID], revision: 1 },
        remoteAddress: "192.0.2.250",
      });
      expect(response.statusCode).toBe(200);
    },
  },
];

describe("CX-056 Positivfaelle je Rolle", () => {
  it.each(POSITIVE_CASES)("$name", async (testCase) => {
    const app = await buildApp(testCase.role, mediaStub());
    const cookie = await loginCookie(app);
    await testCase.run(app, cookie);
  });
});

describe("CX-056 Geraete- und oeffentliche Nachweisklassen", () => {
  it("verweigert Geraete-Schreibrouten ohne Bearer und mit Admin-Cookie als Ersatz; widerrufene Geraete bleiben gesperrt", async () => {
    const app = await buildApp("Admin");
    const cookie = await loginCookie(app);
    const token = generateAccessToken();
    await pool.query(
      [
        "insert into device_access_tokens",
        "  (id, device_id, token_hash, created_at, expires_at)",
        "values ($1::uuid, $2::uuid, $3, $4, $5)",
      ].join("\n"),
      [
        randomUUID(),
        DEVICE_DEVICE_ID,
        hashToken(token),
        new Date(BASE_TIME),
        new Date(BASE_TIME + 3_600_000),
      ],
    );

    const deviceRoutes = [
      { method: "POST", url: "/v1/device/heartbeat" },
      { method: "POST", url: "/v1/device/events" },
      { method: "POST", url: "/v1/device/commands/ack" },
    ] as const;

    const heartbeatBody = {
      seq: 1,
      device_time: "2026-01-01T12:00:00.000Z",
      app_version: "0.1.0",
      os_version: "14",
    };
    const eventsBody = {
      events: [
        {
          event_id: randomUUID(),
          occurred_at: "2026-01-01T12:00:00.000Z",
          vehicle_ready: true,
          paused: false,
          playback: "playing",
          technical_fault: false,
        },
      ],
    };
    const ackBody = { command_id: randomUUID(), revision: 1 };

    for (const route of deviceRoutes) {
      const payload =
        route.url === "/v1/device/heartbeat"
          ? heartbeatBody
          : route.url === "/v1/device/events"
            ? eventsBody
            : ackBody;

      const before = await snapshotDomainState();
      const anonymous = await app.inject({
        method: route.method,
        url: route.url,
        headers: {
          host: HOST,
          "content-type": "application/json",
          "x-gt-ads-api-version": "1",
        },
        payload,
        remoteAddress: "192.0.2.251",
      });
      expect(anonymous.statusCode, "ohne Geraetenachweis: " + route.url).toBe(401);
      expect(await snapshotDomainState()).toEqual(before);

      const adminCookie = await app.inject({
        method: route.method,
        url: route.url,
        headers: {
          host: HOST,
          "content-type": "application/json",
          "x-gt-ads-api-version": "1",
          cookie: ADMIN_SESSION_COOKIE + "=" + cookie,
        },
        payload,
        remoteAddress: "192.0.2.251",
      });
      expect(
        adminCookie.statusCode,
        "Admin-Cookie ersetzt keinen Geraetenachweis: " + route.url,
      ).toBe(401);
      expect(await snapshotDomainState()).toEqual(before);
    }

    // Widerrufene Geraeteidentitaet: vorhandenes Token bleibt ungueltig.
    await pool.query("update devices set state = 'revoked' where id = $1::uuid", [
      DEVICE_DEVICE_ID,
    ]);
    for (const route of deviceRoutes) {
      const payload =
        route.url === "/v1/device/heartbeat"
          ? heartbeatBody
          : route.url === "/v1/device/events"
            ? eventsBody
            : ackBody;
      const response = await app.inject({
        method: route.method,
        url: route.url,
        headers: {
          host: HOST,
          "content-type": "application/json",
          "x-gt-ads-api-version": "1",
          authorization: "Bearer " + token,
        },
        payload,
        remoteAddress: "192.0.2.252",
      });
      expect(response.statusCode, "widerrufenes Geraet: " + route.url).toBe(403);
      expect(response.json().error.code).toBe("device_revoked");
    }
  });

  it("haelt die expliziten Nachweise der oeffentlichen Auth- und Enrollment-Routen aufrecht", async () => {
    const app = await buildApp("Admin");
    const cookie = await loginCookie(app);

    const registrationBody = {
      registration_code: "SYN-CX056-FALSCH",
      client_request_id: randomUUID(),
      public_key:
        "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAESYN-CX056-OEFFENTLICHER-SCHLUESSEL",
      app_env: "test",
      device_info: { ...DEVICE_INFO },
    };

    const before = await snapshotDomainState();
    const rejected = await app.inject({
      method: "POST",
      url: "/v1/device/register",
      headers: {
        host: HOST,
        "content-type": "application/json",
        "x-gt-ads-api-version": "1",
        cookie: ADMIN_SESSION_COOKIE + "=" + cookie,
      },
      payload: registrationBody,
      remoteAddress: "192.0.2.253",
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe("invalid_registration_code");
    expect(await snapshotDomainState()).toEqual(before);

    const challenge = await app.inject({
      method: "POST",
      url: "/v1/device/auth/challenge",
      headers: {
        host: HOST,
        "content-type": "application/json",
        "x-gt-ads-api-version": "1",
        cookie: ADMIN_SESSION_COOKIE + "=" + cookie,
      },
      payload: { device_id: randomUUID() },
      remoteAddress: "192.0.2.254",
    });
    expect(challenge.statusCode).toBe(401);
    expect(challenge.json().error.code).toBe("unauthorized");

    const token = await app.inject({
      method: "POST",
      url: "/v1/device/auth/token",
      headers: {
        host: HOST,
        "content-type": "application/json",
        "x-gt-ads-api-version": "1",
        cookie: ADMIN_SESSION_COOKIE + "=" + cookie,
      },
      payload: {
        device_id: DEVICE_DEVICE_ID,
        nonce: "SYN-CX056-Ungueltige-Nonce",
        signature: "SYN-CX056-Ungueltige-Signatur",
      },
      remoteAddress: "192.0.2.255",
    });
    expect(token.statusCode).toBe(401);
    expect(token.json().error.code).toBe("challenge_invalid");
  });
});

describe("CX-056 Startpruefung und Schreibsperre", () => {
  it("verhindert den Start bei einer synthetisch hinzugefuegten unklassifizierten Schreibroute", async () => {
    const broken = createServer({
      config,
      pool,
      now: () => new Date(BASE_TIME),
      resolvePrincipal: async () => null,
    });
    broken.post("/v1/admin/cx056-unclassified-write", async () => ({ ok: true }));
    broken.register(async (scope) => {
      scope.delete("/v1/admin/cx056-unclassified-delete", async () => ({ ok: true }));
    });

    await expect(broken.ready()).rejects.toThrow(/unklassifiziert/i);
    try {
      await broken.close();
    } catch {
      // Ein absichtlich verweigerter Start hinterlaesst nichts.
    }
  });

  it("laesst gefaelschte Rollenfelder und fremden Origin die Verwaltungs-Schreibsperre nicht umgehen", async () => {
    const operatorApp = await buildApp("Operator");
    const operatorCookie = await loginCookie(operatorApp);

    const before = await snapshotDomainState();
    const forged = await operatorApp.inject({
      method: "PATCH",
      url: "/v1/admin/taxis/" + TAXI_ID + "/config?role=Admin",
      headers: jsonHeaders(operatorCookie, {
        origin: ORIGIN,
        "x-gt-ads-role": "Admin",
        "x-role": "Admin",
        "x-forwarded-role": "Admin",
      }),
      payload: {
        expected_revision: 0,
        gps_mode: "aus",
        pause_max_duration_s: 300,
        pause_end_on_vehicle_off: false,
        display_run_on_s: 30,
        role: "Admin",
      },
      remoteAddress: "192.0.2.256",
    });
    expect(forged.statusCode).toBe(403);
    expect(forged.json().error.code).toBe("forbidden");
    expect(await snapshotDomainState()).toEqual(before);

    const adminApp = await buildApp("Admin");
    const adminCookie = await loginCookie(adminApp);
    const beforeForeign = await snapshotDomainState();
    const foreign = await adminApp.inject({
      method: "PATCH",
      url: "/v1/admin/taxis/" + TAXI_ID + "/config",
      headers: jsonHeaders(adminCookie, { origin: FOREIGN_ORIGIN }),
      payload: {
        expected_revision: 0,
        gps_mode: "aus",
        pause_max_duration_s: 300,
        pause_end_on_vehicle_off: false,
        display_run_on_s: 30,
      },
      remoteAddress: "192.0.2.257",
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error.code).toBe("forbidden");
    expect(await snapshotDomainState()).toEqual(beforeForeign);
  });
});

