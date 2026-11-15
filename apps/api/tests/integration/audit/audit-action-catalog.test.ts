import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { getRoutePolicyInventory } from "../../../src/http/authorization.js";
import type { MediaUploadDeps } from "../../../src/http/mediaUpload.js";
import { ensureTaxiGroupSchema } from "../../../src/http/taxiGroupRoutes.js";
import {
  AUDIT_WRITE_ROUTE_ACTIONS,
  AUDIT_WRITE_ROUTE_EXEMPTIONS,
  auditActionForWriteRoute,
} from "../../../src/modules/audit/repository.js";
import { ensureCampaignSchema } from "../../../src/modules/campaigns/schema.js";
import {
  createMedia,
  type MediaProfileMetadata,
} from "../../../src/modules/media/index.js";
import { ensureTabletActivationSchema } from "../../../src/modules/tabletActivation/service.js";
import { ensureTaxiActivationSchema } from "../../../src/modules/taxiActivation/service.js";
import { ensureTaxiGroupMembershipSchema } from "../../../src/modules/taxiGroupMemberships/service.js";
import {
  ADMIN_ACTOR_ID,
  adminHeaders,
  BASE_TIME,
  createAuditTestContext,
  type AuditTestContext,
} from "./support.js";

const WRITE_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

const OPERATOR_PASSWORD = "SYN-CX058-Operator-Passwort";
const REMOTE_ADDRESS = "192.0.2.231";

const TAXI_ID = "SYN-CX058-TAXI";
const TABLET_TAXI_ID = "SYN-CX058-TABLET-TAXI";
const GROUP_ID = randomUUID();
const CUSTOMER_ID = randomUUID();
const MEDIA_ID = randomUUID();
const ACTIVE_DEVICE_A_ID = randomUUID();
const ACTIVE_DEVICE_B_ID = randomUUID();
const TABLET_ID = randomUUID();
const REVOKE_DEVICE_ID = randomUUID();
const INVENTORY_DEVICE_ID = ACTIVE_DEVICE_A_ID;

const MEDIA_PROFILE: MediaProfileMetadata = {
  container: "mp4",
  videoCodec: "h264",
  width: 1920,
  height: 1080,
  frameRateNumerator: 30,
  frameRateDenominator: 1,
  audioStreamCount: 0,
  durationSeconds: 10,
};

const TRUNCATE_SQL = [
  "truncate table audit_events, admin_sessions, operators,",
  "  device_access_tokens, device_auth_challenges, registration_codes,",
  "  devices, customers, media_objects, campaigns, campaign_targets,",
  "  taxi_groups, taxi_group_memberships, taxis, device_taxi_assignments,",
  "  tablet_admin_states, device_inventory, control_config_taxi,",
  "  control_config_changes, remote_control_deliveries,",
  "  remote_control_commands, remote_control_taxi_state",
  " restart identity cascade",
].join("\n");

interface HumanWriteRoute {
  readonly method: string;
  readonly url: string;
  readonly key: string;
}

function humanWriteRoutes(app: FastifyInstance): HumanWriteRoute[] {
  return getRoutePolicyInventory(app)
    .filter(
      (record) =>
        WRITE_METHODS.has(record.method) &&
        record.policy?.category === "human",
    )
    .map((record) => ({
      method: record.method,
      url: record.url,
      key: record.method + " " + record.url,
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

interface AuditRow {
  action: string;
  actor_type: string;
  actor_id: string | null;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
}

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

interface MutationResult {
  readonly response: InjectResponse;
  readonly targetId: string;
}

interface RouteMutation {
  readonly expectedAction: string;
  readonly expectedStatus: number;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly targetType: string;
  readonly persistsRequestId: boolean;
  readonly run: (app: FastifyInstance, cookie: string) => Promise<MutationResult>;
}

let context: AuditTestContext;
let app: FastifyInstance;
let storageRoot = "";

function mediaUploadDeps(): MediaUploadDeps {
  return {
    createMedia: (options, input) =>
      createMedia(options, { ...input, metadata: MEDIA_PROFILE }),
    serviceOptions: {
      pool: context.pool,
      storageRoot,
      now: () => new Date(BASE_TIME),
    },
  };
}

function jsonHeaders(
  cookie?: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return adminHeaders(cookie, { "content-type": "application/json", ...extra });
}

function injectJson(
  app: FastifyInstance,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  cookie: string,
  payload?: Record<string, unknown>,
): Promise<InjectResponse> {
  return app.inject({
    method,
    url,
    headers: jsonHeaders(cookie),
    payload,
    remoteAddress: REMOTE_ADDRESS,
  });
}

function requestIdOf(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["x-request-id"];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("X-Request-Id fehlt");
  }
  return raw;
}

async function createOperator(
  targetApp: FastifyInstance,
  cookie: string,
  username: string,
): Promise<InjectResponse> {
  return targetApp.inject({
    method: "POST",
    url: "/v1/admin/operators",
    headers: jsonHeaders(cookie),
    payload: { username, password: OPERATOR_PASSWORD },
    remoteAddress: REMOTE_ADDRESS,
  });
}

async function createRegistrationCode(
  targetApp: FastifyInstance,
  cookie: string,
): Promise<InjectResponse> {
  return injectJson(targetApp, "POST", "/v1/admin/registration-codes", cookie, {
    label: "SYN-CX058-Mutation",
  });
}

async function createCampaign(
  targetApp: FastifyInstance,
  cookie: string,
): Promise<InjectResponse> {
  return injectJson(targetApp, "POST", "/v1/admin/campaigns", cookie, {
    customer_id: CUSTOMER_ID,
    media_id: MEDIA_ID,
    start_at: "2026-06-01T00:00:00.000Z",
    end_at: "2026-07-01T00:00:00.000Z",
  });
}

async function createTaxiGroup(
  targetApp: FastifyInstance,
  cookie: string,
  name: string,
): Promise<InjectResponse> {
  return injectJson(targetApp, "POST", "/v1/admin/taxi-groups", cookie, {
    name,
  });
}

async function auditRowsFor(
  action: string,
  targetId: string,
): Promise<AuditRow[]> {
  const result = await context.pool.query<AuditRow>(
    [
      "select action, actor_type, actor_id, target_type, target_id, details",
      "  from audit_events",
      " where action = $1 and target_id = $2",
      " order by id asc",
    ].join("\n"),
    [action, targetId],
  );
  return result.rows;
}

async function seedDomain(): Promise<void> {
  const codeId = randomUUID();
  await context.pool.query(
    [
      "insert into registration_codes",
      "  (id, code_hash, label, created_at, created_by, expires_at)",
      "values ($1::uuid, $2, $3, $4, $5, $6)",
    ].join("\n"),
    [
      codeId,
      Buffer.from("SYN-CX058-Code-" + codeId),
      "SYN-CX058",
      new Date(BASE_TIME),
      "admin",
      new Date(BASE_TIME + 3_600_000),
    ],
  );

  const devices: ReadonlyArray<readonly [string, string]> = [
    [ACTIVE_DEVICE_A_ID, "SYN-CX058-Tablet-A"],
    [ACTIVE_DEVICE_B_ID, "SYN-CX058-Tablet-B"],
    [TABLET_ID, "SYN-CX058-Tablet-Verwaltung"],
    [REVOKE_DEVICE_ID, "SYN-CX058-Tablet-Sperre"],
  ];
  for (const [deviceId, label] of devices) {
    await context.pool.query(
      [
        "insert into devices",
        "  (id, label, public_key_spki, public_key_fingerprint, state,",
        "   manufacturer, model, os_version, sdk_int, app_version, app_flavor,",
        "   registration_code_id, registration_request_id, registered_at, last_seen_at)",
        "values ($1::uuid, $2, $3, $4, 'active', $5, $6, $7, $8, $9, $10,",
        "        $11::uuid, $12::uuid, $13, $14)",
      ].join("\n"),
      [
        deviceId,
        label,
        Buffer.from("SYN-CX058-Key-" + deviceId),
        "SYN-CX058-FP-" + deviceId,
        "SYN-Hersteller",
        "SYN-Modell",
        "14",
        34,
        "0.1.0",
        "dev",
        codeId,
        randomUUID(),
        new Date(BASE_TIME),
        new Date(BASE_TIME),
      ],
    );
  }

  for (const [taxiId, displayName] of [
    [TAXI_ID, "SYN CX-058 Taxi"],
    [TABLET_TAXI_ID, "SYN CX-058 Tablet-Taxi"],
  ] as const) {
    await context.pool.query(
      [
        "insert into taxis",
        "  (id, display_name, active, revision, owner_id)",
        "values ($1, $2, false, 1, $3)",
      ].join("\n"),
      [taxiId, displayName, ADMIN_ACTOR_ID],
    );
  }

  for (const deviceId of [ACTIVE_DEVICE_A_ID, ACTIVE_DEVICE_B_ID]) {
    await context.pool.query(
      [
        "insert into device_taxi_assignments",
        "  (device_id, taxi_id, active, updated_at)",
        "values ($1::uuid, $2, true, $3)",
      ].join("\n"),
      [deviceId, TAXI_ID, new Date(BASE_TIME)],
    );
  }
  await context.pool.query(
    [
      "insert into device_taxi_assignments",
      "  (device_id, taxi_id, active, updated_at)",
      "values ($1::uuid, $2, true, $3)",
    ].join("\n"),
    [TABLET_ID, TABLET_TAXI_ID, new Date(BASE_TIME)],
  );

  await context.pool.query(
    [
      "insert into control_config_taxi",
      "  (taxi_id, revision, gps_mode, pause_max_duration_s,",
      "   pause_end_on_vehicle_off, display_run_on_s, updated_at)",
      "values ($1, 0, 'aus', null, null, null, $2)",
    ].join("\n"),
    [TAXI_ID, new Date(BASE_TIME)],
  );

  await context.pool.query(
    "insert into customers (id, display_name) values ($1::uuid, $2)",
    [CUSTOMER_ID, "SYN CX-058 Kunde"],
  );
  await context.pool.query(
    [
      "insert into media_objects",
      "  (id, display_name, status, created_at)",
      "values ($1::uuid, $2, 'staging', $3)",
    ].join("\n"),
    [MEDIA_ID, "SYN CX-058 Medium", new Date(BASE_TIME)],
  );
  await context.pool.query(
    [
      "insert into taxi_groups",
      "  (id, name, owner_id, revision, created_at)",
      "values ($1::uuid, $2, $3, 1, $4)",
    ].join("\n"),
    [GROUP_ID, "SYN CX-058 Gruppe", ADMIN_ACTOR_ID, new Date(BASE_TIME)],
  );
}

const ROUTE_MUTATIONS: Readonly<Record<string, RouteMutation>> = {
  "POST /v1/admin/operators": {
    expectedAction: "operator.created",
    expectedStatus: 201,
    actorType: "admin",
    actorId: ADMIN_ACTOR_ID,
    targetType: "operator",
    persistsRequestId: true,
    run: async (targetApp, cookie) => {
      const response = await createOperator(
        targetApp,
        cookie,
        "syn-cx058-created",
      );
      expect(response.statusCode).toBe(201);
      const body = response.json() as { operator_id: string };
      return { response, targetId: body.operator_id };
    },
  },
  "POST /v1/admin/operators/:operatorId/disable": {
    expectedAction: "operator.disabled",
    expectedStatus: 204,
    actorType: "admin",
    actorId: ADMIN_ACTOR_ID,
    targetType: "operator",
    persistsRequestId: true,
    run: async (targetApp, cookie) => {
      const created = await createOperator(
        targetApp,
        cookie,
        "syn-cx058-disabled",
      );
      expect(created.statusCode).toBe(201);
      const operatorId = (created.json() as { operator_id: string }).operator_id;
      const response = await injectJson(
        targetApp,
        "POST",
        "/v1/admin/operators/" + operatorId + "/disable",
        cookie,
        {},
      );
      expect(response.statusCode).toBe(204);
      return { response, targetId: operatorId };
    },
  },
  "POST /v1/admin/registration-codes": {
    expectedAction: "registration_code.created",
    expectedStatus: 201,
    actorType: "admin",
    actorId: "admin",
    targetType: "registration_code",
    persistsRequestId: false,
    run: async (targetApp, cookie) => {
      const response = await createRegistrationCode(targetApp, cookie);
      expect(response.statusCode).toBe(201);
      const body = response.json() as { id: string };
      return { response, targetId: body.id };
    },
  },
  "DELETE /v1/admin/registration-codes/:id": {
    expectedAction: "registration_code.revoked",
    expectedStatus: 204,
    actorType: "admin",
    actorId: "admin",
    targetType: "registration_code",
    persistsRequestId: false,
    run: async (targetApp, cookie) => {
      const created = await createRegistrationCode(targetApp, cookie);
      expect(created.statusCode).toBe(201);
      const id = (created.json() as { id: string }).id;
      const response = await injectJson(
        targetApp,
        "DELETE",
        "/v1/admin/registration-codes/" + id,
        cookie,
      );
      expect(response.statusCode).toBe(204);
      return { response, targetId: id };
    },
  },
  "POST /v1/admin/devices/:id/revoke": {
    expectedAction: "device.revoked",
    expectedStatus: 204,
    actorType: "admin",
    actorId: "admin",
    targetType: "device",
    persistsRequestId: false,
    run: async (targetApp, cookie) => {
      const response = await injectJson(
        targetApp,
        "POST",
        "/v1/admin/devices/" + REVOKE_DEVICE_ID + "/revoke",
        cookie,
        {},
      );
      expect(response.statusCode).toBe(204);
      return { response, targetId: REVOKE_DEVICE_ID };
    },
  },
  "POST /v1/admin/customers": {
    expectedAction: "customer.created",
    expectedStatus: 201,
    actorType: "admin",
    actorId: "admin",
    targetType: "customer",
    persistsRequestId: false,
    run: async (targetApp, cookie) => {
      const response = await injectJson(
        targetApp,
        "POST",
        "/v1/admin/customers",
        cookie,
        { display_name: "SYN-CX058-Mutation-Kunde" },
      );
      expect(response.statusCode).toBe(201);
      const body = response.json() as { id: string };
      return { response, targetId: body.id };
    },
  },
  "POST /v1/admin/campaigns": {
    expectedAction: "campaign.created",
    expectedStatus: 201,
    actorType: "admin",
    actorId: "admin",
    targetType: "campaign",
    persistsRequestId: false,
    run: async (targetApp, cookie) => {
      const response = await createCampaign(targetApp, cookie);
      expect(response.statusCode).toBe(201);
      const body = response.json() as { id: string };
      return { response, targetId: body.id };
    },
  },
  "PATCH /v1/admin/campaigns/:id": {
    expectedAction: "campaign.updated",
    expectedStatus: 200,
    actorType: "admin",
    actorId: "admin",
    targetType: "campaign",
    persistsRequestId: false,
    run: async (targetApp, cookie) => {
      const created = await createCampaign(targetApp, cookie);
      expect(created.statusCode).toBe(201);
      const id = (created.json() as { id: string }).id;
      const response = await injectJson(
        targetApp,
        "PATCH",
        "/v1/admin/campaigns/" + id,
        cookie,
        { archived: true },
      );
      expect(response.statusCode).toBe(200);
      return { response, targetId: id };
    },
  },
  "PATCH /v1/admin/taxis/:taxiId/config": {
    expectedAction: "control_config.taxi.update",
    expectedStatus: 200,
    actorType: "admin",
    actorId: ADMIN_ACTOR_ID,
    targetType: "taxi",
    persistsRequestId: false,
    run: async (targetApp, cookie) => {
      const response = await injectJson(
        targetApp,
        "PATCH",
        "/v1/admin/taxis/" + TAXI_ID + "/config",
        cookie,
        {
          expected_revision: 0,
          gps_mode: "aus",
          pause_max_duration_s: 300,
          pause_end_on_vehicle_off: false,
          display_run_on_s: 30,
        },
      );
      expect(response.statusCode).toBe(200);
      return { response, targetId: TAXI_ID };
    },
  },
  "POST /v1/admin/taxi-groups": {
    expectedAction: "taxi_group.created",
    expectedStatus: 201,
    actorType: "admin",
    actorId: ADMIN_ACTOR_ID,
    targetType: "taxi_group",
    persistsRequestId: false,
    run: async (targetApp, cookie) => {
      const response = await createTaxiGroup(
        targetApp,
        cookie,
        "SYN-CX058-Gruppe-" + randomUUID(),
      );
      expect(response.statusCode).toBe(201);
      const body = response.json() as { id: string };
      return { response, targetId: body.id };
    },
  },
  "PATCH /v1/admin/taxi-groups/:id": {
    expectedAction: "taxi_group.renamed",
    expectedStatus: 200,
    actorType: "admin",
    actorId: ADMIN_ACTOR_ID,
    targetType: "taxi_group",
    persistsRequestId: false,
    run: async (targetApp, cookie) => {
      const created = await createTaxiGroup(
        targetApp,
        cookie,
        "SYN-CX058-Umbenennung-" + randomUUID(),
      );
      expect(created.statusCode).toBe(201);
      const id = (created.json() as { id: string }).id;
      const response = await injectJson(
        targetApp,
        "PATCH",
        "/v1/admin/taxi-groups/" + id,
        cookie,
        { name: "SYN-CX058-Umbenannt-" + randomUUID(), revision: 1 },
      );
      expect(response.statusCode).toBe(200);
      return { response, targetId: id };
    },
  },
  "PUT /v1/admin/taxis/:id/groups": {
    expectedAction: "taxi.group_memberships_replaced",
    expectedStatus: 200,
    actorType: "admin",
    actorId: ADMIN_ACTOR_ID,
    targetType: "taxi",
    persistsRequestId: false,
    run: async (targetApp, cookie) => {
      const response = await injectJson(
        targetApp,
        "PUT",
        "/v1/admin/taxis/" + TAXI_ID + "/groups",
        cookie,
        { group_ids: [GROUP_ID], revision: 1 },
      );
      expect(response.statusCode).toBe(200);
      return { response, targetId: TAXI_ID };
    },
  },
  "POST /v1/admin/taxis/:taxiId/activation": {
    expectedAction: "taxi.activation.changed",
    expectedStatus: 200,
    actorType: "admin",
    actorId: ADMIN_ACTOR_ID,
    targetType: "taxi",
    persistsRequestId: false,
    run: async (targetApp, cookie) => {
      const response = await injectJson(
        targetApp,
        "POST",
        "/v1/admin/taxis/" + TAXI_ID + "/activation",
        cookie,
        { active: true, revision: 1 },
      );
      expect(response.statusCode).toBe(200);
      return { response, targetId: TAXI_ID };
    },
  },
  "PATCH /v1/admin/tablets/:tabletId/activation": {
    expectedAction: "tablet.activation.changed",
    expectedStatus: 200,
    actorType: "admin",
    actorId: ADMIN_ACTOR_ID,
    targetType: "tablet",
    persistsRequestId: false,
    run: async (targetApp, cookie) => {
      const response = await injectJson(
        targetApp,
        "PATCH",
        "/v1/admin/tablets/" + TABLET_ID + "/activation",
        cookie,
        { active: false, expectedRevision: 0 },
      );
      expect(response.statusCode).toBe(200);
      return { response, targetId: TABLET_ID };
    },
  },
  "POST /v1/admin/taxis/:taxi_id/pause": {
    expectedAction: "remote_control.pause.set",
    expectedStatus: 202,
    actorType: "admin",
    actorId: ADMIN_ACTOR_ID,
    targetType: "taxi",
    persistsRequestId: true,
    run: async (targetApp, cookie) => {
      const response = await injectJson(
        targetApp,
        "POST",
        "/v1/admin/taxis/" + TAXI_ID + "/pause",
        cookie,
        { command_id: randomUUID(), expected_revision: 0 },
      );
      expect(response.statusCode).toBe(202);
      return { response, targetId: TAXI_ID };
    },
  },
  "POST /v1/admin/taxis/:taxi_id/resume": {
    expectedAction: "remote_control.pause.set",
    expectedStatus: 202,
    actorType: "admin",
    actorId: ADMIN_ACTOR_ID,
    targetType: "taxi",
    persistsRequestId: true,
    run: async (targetApp, cookie) => {
      const response = await injectJson(
        targetApp,
        "POST",
        "/v1/admin/taxis/" + TAXI_ID + "/resume",
        cookie,
        { command_id: randomUUID(), expected_revision: 0 },
      );
      expect(response.statusCode).toBe(202);
      return { response, targetId: TAXI_ID };
    },
  },
  "PATCH /v1/admin/inventory/:tabletId": {
    expectedAction: "device.inventory.updated",
    expectedStatus: 200,
    actorType: "admin",
    actorId: ADMIN_ACTOR_ID,
    targetType: "device",
    persistsRequestId: false,
    run: async (targetApp, cookie) => {
      const response = await injectJson(
        targetApp,
        "PATCH",
        "/v1/admin/inventory/" + INVENTORY_DEVICE_ID,
        cookie,
        {
          serial_number: "SYN-CX058-SERIE",
          device_type: "SYN-CX058-Tablet",
          replacement_note: null,
          revision: 0,
        },
      );
      expect(response.statusCode).toBe(200);
      return { response, targetId: INVENTORY_DEVICE_ID };
    },
  },
  "POST /v1/admin/media": {
    expectedAction: "media.created",
    expectedStatus: 201,
    actorType: "admin",
    actorId: ADMIN_ACTOR_ID,
    targetType: "media",
    persistsRequestId: false,
    run: async (targetApp, cookie) => {
      const response = await targetApp.inject({
        method: "POST",
        url: "/v1/admin/media?name=" + encodeURIComponent("SYN-CX058-Medienprobe"),
        headers: adminHeaders(cookie, {
          "content-type": "application/octet-stream",
        }),
        payload: Buffer.from("SYN-CX058-MEDIENPROBE"),
        remoteAddress: REMOTE_ADDRESS,
      });
      expect(response.statusCode, response.body).toBe(201);
      const body = response.json() as { id: string };
      return { response, targetId: body.id };
    },
  },
};

type CatalogCase =
  | { readonly name: string; readonly kind: "route"; readonly routeKey: string }
  | { readonly name: string; readonly kind: "coverage" };

const CATALOG_KEYS = Object.keys(AUDIT_WRITE_ROUTE_ACTIONS);

const CASES: readonly CatalogCase[] = [
  ...CATALOG_KEYS.map((routeKey) => ({
    name: "Katalogzuordnung und persistierter Erfolg: " + routeKey,
    kind: "route" as const,
    routeKey,
  })),
  {
    name: "Inventar: jede menschliche Schreibrouten-Vorlage ist zugeordnet",
    kind: "coverage" as const,
  },
];

beforeAll(async () => {
  context = await createAuditTestContext();
  await ensureTaxiActivationSchema(context.pool);
  await ensureCampaignSchema(context.pool);
  await ensureTaxiGroupSchema(context.pool);
  await ensureTaxiGroupMembershipSchema(context.pool);
  await ensureTabletActivationSchema(context.pool);
  storageRoot = await mkdtemp(join(tmpdir(), "cx058-media-"));
  app = await context.buildApp("Admin", { mediaUpload: mediaUploadDeps() });
}, 120_000);

beforeEach(async () => {
  await context.pool.query(TRUNCATE_SQL);
  await seedDomain();
}, 30_000);

afterAll(async () => {
  await context.close();
  if (storageRoot !== "") {
    await rm(storageRoot, { recursive: true, force: true });
  }
}, 30_000);

async function assertPersistedAudit(
  mutation: RouteMutation,
  result: MutationResult,
): Promise<void> {
  const rows = await auditRowsFor(mutation.expectedAction, result.targetId);
  expect(
    rows,
    "genau ein Aenderungserfolg fuer " +
      mutation.expectedAction +
      " / " +
      result.targetId,
  ).toHaveLength(1);
  const row = rows[0] as AuditRow;
  expect(row.action).toBe(mutation.expectedAction);
  expect(row.actor_type).toBe(mutation.actorType);
  expect(row.actor_id).toBe(mutation.actorId);
  expect(row.target_type).toBe(mutation.targetType);
  expect(row.target_id).toBe(result.targetId);

  const requestId = requestIdOf(result.response);
  expect(requestId.length).toBeGreaterThan(0);
  const persistedRequestId = row.details.request_id;
  if (mutation.persistsRequestId) {
    expect(persistedRequestId).toBe(requestId);
  } else if (persistedRequestId !== undefined) {
    // Wo ein vorhandener Kern die Request-ID bereits mitschreibt, muss sie
    // zum tatsaechlichen HTTP-Aufruf passen.
    expect(persistedRequestId).toBe(requestId);
  }
}

describe("CX-058 Audit-Abdeckung der Verwaltungs-Schreibrouten", () => {
  it.each(CASES)(
    "$name",
    async (testCase) => {
      if (testCase.kind === "coverage") {
        const actualKeys = humanWriteRoutes(app)
          .map((route) => route.key)
          .filter((key) => !AUDIT_WRITE_ROUTE_EXEMPTIONS.has(key))
          .sort();
        expect(actualKeys).toEqual(CATALOG_KEYS.slice().sort());
        expect(Object.keys(ROUTE_MUTATIONS).sort()).toEqual(
          CATALOG_KEYS.slice().sort(),
        );
        return;
      }

      const routeKey = testCase.routeKey;
      const expectedAction = AUDIT_WRITE_ROUTE_ACTIONS[routeKey];
      const mutation = ROUTE_MUTATIONS[routeKey];
      expect(expectedAction, "Katalogeintrag fuer " + routeKey).toBeDefined();
      expect(mutation, "echte Mutation fuer " + routeKey).toBeDefined();
      if (expectedAction === undefined || mutation === undefined) {
        throw new Error("Unvollstaendiger Audit-Fall: " + routeKey);
      }

      // Unabhaengige Erwartung: Der Katalog darf nicht gegen sich selbst
      // geprueft werden, sondern muss zum tatsaechlich persistierten
      // Aktionsnamen passen (siehe mutation.expectedAction).
      expect(mutation.expectedAction).toBe(expectedAction);

      const registered = humanWriteRoutes(app);
      const match = registered.find((route) => route.key === routeKey);
      expect(
        match,
        "Route ist nicht als menschliche Schreibroute registriert: " + routeKey,
      ).toBeDefined();
      if (match === undefined) {
        throw new Error(
          "Route ist nicht als menschliche Schreibroute registriert: " +
            routeKey,
        );
      }
      const [method, ...urlParts] = routeKey.split(" ");
      expect(match.method).toBe(method);
      expect(match.url).toBe(urlParts.join(" "));
      expect(
        auditActionForWriteRoute(match.method, match.url),
        "Audit-Aktion fuer " + routeKey,
      ).toBe(expectedAction);

      const cookie = await context.loginCookie(app);
      const result = await mutation.run(app, cookie);
      expect(result.response.statusCode).toBe(mutation.expectedStatus);
      await assertPersistedAudit(mutation, result);
    },
    20_000,
  );
});

