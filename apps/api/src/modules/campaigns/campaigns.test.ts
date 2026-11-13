import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
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
import { CONFIG_DEFAULTS, type AppConfig } from "../../config.js";
import { hashPassword } from "../../crypto/password.js";
import { installAccessControl } from "../../http/authorization.js";
import { registerErrorHandler } from "../../http/errors.js";
import { ADMIN_SESSION_COOKIE } from "../adminAuth/middleware.js";
import { ADMIN_ACTOR_ID, AdminAuthService } from "../adminAuth/service.js";
import {
  CAMPAIGN_LIST_PATH,
  CAMPAIGN_UPDATED_ACTION,
  type Campaign,
} from "./campaigns.js";
import { CampaignService } from "./campaigns.js";
import { registerCampaignRoutes } from "./campaignRoutes.js";

const BASE_TIME = Date.parse("2026-11-13T12:00:00.000Z");
const ADMIN_PASSWORD = "SYN-CX038-Kampagnen-Passwort";
const HOST = "127.0.0.1:8080";
const ORIGIN = "http://" + HOST;
const START = "2026-12-01T08:00:00.000Z";
const END = "2026-12-01T18:00:00.000Z";
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);

let maintenancePool: Pool;
let pool: Pool;
let databaseName = "";
let config: AppConfig;
const clock = (): Date => new Date(BASE_TIME);
const openApps: FastifyInstance[] = [];

interface CampaignJson {
  id: string;
  customer_id: string;
  media_id: string;
  rule_type: string;
  status: string;
  archived: boolean;
  start_at: string;
  end_at: string;
  taxi_ids: string[];
  group_ids: string[];
  revision: number;
  created_at: string;
  updated_at: string;
}

interface CampaignStateRow {
  status: string;
  archived: boolean;
  revision: number;
  media_id: string;
  start_at: Date;
  end_at: Date;
}

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
    throw new Error("CX-038 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function jsonHeaders(
  sessionToken?: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    host: HOST,
    "content-type": "application/json",
    ...extra,
  };
  if (sessionToken !== undefined) {
    headers.cookie = ADMIN_SESSION_COOKIE + "=" + sessionToken;
  }
  return headers;
}

function adminHeaders(
  sessionToken?: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = { host: HOST, ...extra };
  if (sessionToken !== undefined) {
    headers.cookie = ADMIN_SESSION_COOKIE + "=" + sessionToken;
  }
  return headers;
}

async function buildApp(
  options: { withAccessControl?: boolean } = {},
): Promise<{ app: FastifyInstance; adminAuth: AdminAuthService }> {
  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    bodyLimit: 64 * 1024,
  });
  await app.register(cookie);
  registerErrorHandler(app);
  const adminAuth = new AdminAuthService({ pool, config, now: clock });
  if (options.withAccessControl === true) {
    // Simulierter fremder Betreiber: die Sitzung bleibt Pflicht (Middleware),
    // der Rechtekern liefert eine andere Betreiberidentitaet.
    installAccessControl(app, {
      resolvePrincipal: async () => ({ id: "other-operator", role: "Operator" }),
    });
  }
  const service = new CampaignService({ pool });
  registerCampaignRoutes(app, { service, adminAuth });
  await app.ready();
  openApps.push(app);
  return { app, adminAuth };
}

async function closeApp(app: FastifyInstance): Promise<void> {
  const index = openApps.indexOf(app);
  if (index >= 0) {
    openApps.splice(index, 1);
  }
  await app.close();
}

async function login(adminAuth: AdminAuthService): Promise<string> {
  const result = await adminAuth.login(ADMIN_PASSWORD);
  return result.token;
}

async function insertCustomer(name = "SYN-CX038-Kunde"): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "insert into customers (id, display_name) values ($1::uuid, $2)",
    [id, name],
  );
  return id;
}

async function insertMedia(status: "ready" | "staging" = "ready"): Promise<string> {
  const id = randomUUID();
  if (status === "ready") {
    await pool.query(
      "insert into media_objects (id, display_name, size_bytes, sha256, container, video_codec, width, height, frame_rate_numerator, frame_rate_denominator, audio_stream_count, duration_seconds, created_at, status, ready_at) values ($1::uuid, $2, 1024, $3, 'mp4', 'h264', 1080, 1920, 30, 1, 1, 12.5, now(), 'ready', now())",
      [id, "SYN-CX038-Medium", "a".repeat(64)],
    );
  } else {
    await pool.query(
      "insert into media_objects (id, display_name, created_at, status) values ($1::uuid, $2, now(), 'staging')",
      [id, "SYN-CX038-Staging"],
    );
  }
  return id;
}

async function postCampaign(
  app: FastifyInstance,
  token: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: CAMPAIGN_LIST_PATH,
    headers: jsonHeaders(token, { origin: ORIGIN }),
    payload,
  });
}

async function patchCampaign(
  app: FastifyInstance,
  token: string,
  id: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: "PATCH",
    url: CAMPAIGN_LIST_PATH + "/" + id,
    headers: jsonHeaders(token, { origin: ORIGIN }),
    payload,
  });
}

async function createCampaign(
  app: FastifyInstance,
  token: string,
  customerId: string,
  mediaId: string,
  extra: Record<string, unknown> = {},
): Promise<CampaignJson> {
  const response = await postCampaign(app, token, {
    customer_id: customerId,
    media_id: mediaId,
    start_at: START,
    end_at: END,
    taxi_ids: ["taxi-1"],
    group_ids: ["group-1"],
    ...extra,
  });
  expect(response.statusCode).toBe(201);
  return response.json() as CampaignJson;
}

async function campaignState(id: string): Promise<{
  row: CampaignStateRow | undefined;
  targets: Array<{ kind: string; target_id: string }>;
}> {
  const row = await pool.query<CampaignStateRow>(
    "select status, archived, revision, media_id::text as media_id, start_at, end_at from campaigns where id = $1::uuid",
    [id],
  );
  const targets = await pool.query<{ kind: string; target_id: string }>(
    "select kind, target_id from campaign_targets where campaign_id = $1::uuid order by kind asc, target_id asc",
    [id],
  );
  return { row: row.rows[0], targets: targets.rows };
}

function expectErrorBody(
  response: { json: () => unknown },
  code: string,
): void {
  const body = response.json() as {
    error?: { code?: string; message?: string; request_id?: string };
  };
  expect(Object.keys(body)).toEqual(["error"]);
  expect(body.error?.code).toBe(code);
  expect(typeof body.error?.message).toBe("string");
  expect(typeof body.error?.request_id).toBe("string");
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx038_campaigns_" +
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
  const migrationFiles = (await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".up.sql"))
    .sort();
  for (const name of migrationFiles) {
    await pool.query(await readFile(join(MIGRATIONS_DIR, name), "utf8"));
  }
  await new CampaignService({ pool }).ensureSchema();

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX038-Kampagnen-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };
}, 60_000);

beforeEach(async () => {
  await pool.query(
    "truncate table campaign_targets, campaigns, media_objects, audit_events, admin_sessions, customers restart identity cascade",
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

describe("CX-038 Kampagnen-Routen", () => {
  it("legt eine fixed_slot-Kampagne mit Kunde, Medium, Laufzeit und deduplizierten Taxi-/Gruppenzielen an, liest sie nach neuer Instanz und aendert sie ohne Verlust", async () => {
    const customerId = await insertCustomer();
    const mediaId = await insertMedia("ready");
    const first = await buildApp();
    const token = await login(first.adminAuth);

    const createdResponse = await postCampaign(first.app, token, {
      customer_id: customerId,
      media_id: mediaId,
      rule_type: "fixed_slot",
      status: "active",
      start_at: START,
      end_at: END,
      taxi_ids: ["taxi-a", "taxi-a", "taxi-b"],
      group_ids: ["group-1", "group-1"],
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json() as CampaignJson;
    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(created.customer_id).toBe(customerId);
    expect(created.media_id).toBe(mediaId);
    expect(created.rule_type).toBe("fixed_slot");
    expect(created.status).toBe("active");
    expect(created.archived).toBe(false);
    expect(created.start_at).toBe(START);
    expect(created.end_at).toBe(END);
    expect(created.taxi_ids).toEqual(["taxi-a", "taxi-b"]);
    expect(created.group_ids).toEqual(["group-1"]);
    expect(created.revision).toBe(1);

    // Tablets sind kein Attribut der Buchung: zwei Tablets desselben Taxis
    // erzeugen genau eine Taxi-Zeile, keine zweite Buchung.
    const rows = await pool.query<{ kind: string; target_id: string; count: number }>(
      "select kind, target_id, count(*)::int as count from campaign_targets where campaign_id = $1::uuid group by kind, target_id order by kind asc, target_id asc",
      [created.id],
    );
    expect(rows.rows).toEqual([
      { kind: "group", target_id: "group-1", count: 1 },
      { kind: "taxi", target_id: "taxi-a", count: 1 },
      { kind: "taxi", target_id: "taxi-b", count: 1 },
    ]);

    await closeApp(first.app);
    const second = await buildApp();
    const byId = await second.app.inject({
      method: "GET",
      url: CAMPAIGN_LIST_PATH + "/" + created.id,
      headers: adminHeaders(token),
    });
    expect(byId.statusCode).toBe(200);
    expect(byId.json()).toEqual(created);

    const list = await second.app.inject({
      method: "GET",
      url: CAMPAIGN_LIST_PATH,
      headers: adminHeaders(token),
    });
    expect(list.statusCode).toBe(200);
    const listBody = list.json() as { items: CampaignJson[] };
    expect(listBody.items.map((item) => item.id)).toEqual([created.id]);

    const patchedResponse = await patchCampaign(second.app, token, created.id, {
      start_at: "2026-12-02T08:00:00.000Z",
      end_at: "2026-12-02T20:00:00.000Z",
      taxi_ids: ["taxi-b", "taxi-b", "taxi-c"],
      revision: created.revision,
    });
    expect(patchedResponse.statusCode).toBe(200);
    const patched = patchedResponse.json() as CampaignJson;
    expect(patched.customer_id).toBe(customerId);
    expect(patched.media_id).toBe(mediaId);
    expect(patched.rule_type).toBe("fixed_slot");
    expect(patched.status).toBe("active");
    expect(patched.start_at).toBe("2026-12-02T08:00:00.000Z");
    expect(patched.end_at).toBe("2026-12-02T20:00:00.000Z");
    expect(patched.taxi_ids).toEqual(["taxi-b", "taxi-c"]);
    expect(patched.group_ids).toEqual(["group-1"]);
    expect(patched.revision).toBe(2);

    const reloaded = await second.app.inject({
      method: "GET",
      url: CAMPAIGN_LIST_PATH + "/" + created.id,
      headers: adminHeaders(token),
    });
    expect(reloaded.statusCode).toBe(200);
    expect(reloaded.json()).toEqual(patched);
  });

  interface CaseContext {
    app: FastifyInstance;
    token: string;
    customerId: string;
    mediaId: string;
    prepare(initial: "draft" | "active" | "paused" | "finished"): Promise<CampaignJson>;
  }

  const CASES: ReadonlyArray<{
    name: string;
    run: (ctx: CaseContext) => Promise<void>;
  }> = [
    {
      name: "Entwurf darf Aktiv werden",
      run: async (ctx) => {
        const campaign = await ctx.prepare("draft");
        const response = await patchCampaign(ctx.app, ctx.token, campaign.id, {
          status: "active",
          revision: campaign.revision,
        });
        expect(response.statusCode).toBe(200);
        const body = response.json() as CampaignJson;
        expect(body.status).toBe("active");
        expect(body.revision).toBe(2);
      },
    },
    {
      name: "Entwurf darf Beendet werden",
      run: async (ctx) => {
        const campaign = await ctx.prepare("draft");
        const response = await patchCampaign(ctx.app, ctx.token, campaign.id, {
          status: "finished",
          revision: campaign.revision,
        });
        expect(response.statusCode).toBe(200);
        expect((response.json() as CampaignJson).status).toBe("finished");
      },
    },
    {
      name: "Aktiv darf Pausiert werden",
      run: async (ctx) => {
        const campaign = await ctx.prepare("active");
        const response = await patchCampaign(ctx.app, ctx.token, campaign.id, {
          status: "paused",
          revision: campaign.revision,
        });
        expect(response.statusCode).toBe(200);
        expect((response.json() as CampaignJson).status).toBe("paused");
      },
    },
    {
      name: "Pausiert darf Aktiv werden",
      run: async (ctx) => {
        const campaign = await ctx.prepare("paused");
        const response = await patchCampaign(ctx.app, ctx.token, campaign.id, {
          status: "active",
          revision: campaign.revision,
        });
        expect(response.statusCode).toBe(200);
        expect((response.json() as CampaignJson).status).toBe("active");
      },
    },
    {
      name: "Pausiert darf Beendet werden",
      run: async (ctx) => {
        const campaign = await ctx.prepare("paused");
        const response = await patchCampaign(ctx.app, ctx.token, campaign.id, {
          status: "finished",
          revision: campaign.revision,
        });
        expect(response.statusCode).toBe(200);
        expect((response.json() as CampaignJson).status).toBe("finished");
      },
    },
    {
      name: "Beendet ist terminal gegenueber Aktiv",
      run: async (ctx) => {
        const campaign = await ctx.prepare("finished");
        const response = await patchCampaign(ctx.app, ctx.token, campaign.id, {
          status: "active",
          revision: campaign.revision,
        });
        expect(response.statusCode).toBe(400);
        expectErrorBody(response, "invalid_request");
        const state = await campaignState(campaign.id);
        expect(state.row?.status).toBe("finished");
        expect(state.row?.revision).toBe(campaign.revision);
      },
    },
    {
      name: "Beendet ist terminal gegenueber Pausiert",
      run: async (ctx) => {
        const campaign = await ctx.prepare("finished");
        const response = await patchCampaign(ctx.app, ctx.token, campaign.id, {
          status: "paused",
          revision: campaign.revision,
        });
        expect(response.statusCode).toBe(400);
        expectErrorBody(response, "invalid_request");
        expect((await campaignState(campaign.id)).row?.status).toBe("finished");
      },
    },
    {
      name: "Aktive Kampagne darf nicht archiviert werden",
      run: async (ctx) => {
        const campaign = await ctx.prepare("active");
        const response = await patchCampaign(ctx.app, ctx.token, campaign.id, {
          archived: true,
          revision: campaign.revision,
        });
        expect(response.statusCode).toBe(400);
        expectErrorBody(response, "invalid_request");
        const state = await campaignState(campaign.id);
        expect(state.row?.archived).toBe(false);
        expect(state.row?.revision).toBe(campaign.revision);
      },
    },
    {
      name: "Entwurf darf archiviert werden und ist danach schreibgeschuetzt",
      run: async (ctx) => {
        const campaign = await ctx.prepare("draft");
        const archived = await patchCampaign(ctx.app, ctx.token, campaign.id, {
          archived: true,
          revision: campaign.revision,
        });
        expect(archived.statusCode).toBe(200);
        const archivedBody = archived.json() as CampaignJson;
        expect(archivedBody.archived).toBe(true);
        expect(archivedBody.status).toBe("draft");

        const blocked = await patchCampaign(ctx.app, ctx.token, campaign.id, {
          start_at: "2026-12-03T08:00:00.000Z",
          end_at: "2026-12-03T09:00:00.000Z",
          revision: archivedBody.revision,
        });
        expect(blocked.statusCode).toBe(400);
        expectErrorBody(blocked, "invalid_request");
        const state = await campaignState(campaign.id);
        expect(state.row?.archived).toBe(true);
        expect(state.row?.revision).toBe(archivedBody.revision);
        expect(state.row?.start_at.toISOString()).toBe(START);
      },
    },
    {
      name: "Beendet darf archiviert werden",
      run: async (ctx) => {
        const campaign = await ctx.prepare("finished");
        const response = await patchCampaign(ctx.app, ctx.token, campaign.id, {
          archived: true,
          revision: campaign.revision,
        });
        expect(response.statusCode).toBe(200);
        const body = response.json() as CampaignJson;
        expect(body.archived).toBe(true);
        expect(body.status).toBe("finished");
      },
    },
    {
      name: "abgelehnte Laufzeit laesst den Datensatz unveraendert",
      run: async (ctx) => {
        const campaign = await ctx.prepare("draft");
        const response = await patchCampaign(ctx.app, ctx.token, campaign.id, {
          start_at: END,
          end_at: START,
          revision: campaign.revision,
        });
        expect(response.statusCode).toBe(400);
        expectErrorBody(response, "invalid_request");
        const state = await campaignState(campaign.id);
        expect(state.row?.revision).toBe(campaign.revision);
        expect(state.row?.start_at.toISOString()).toBe(START);
        expect(state.row?.end_at.toISOString()).toBe(END);
      },
    },
    {
      name: "unbekanntes Medium wird ohne Teiländerung abgelehnt",
      run: async (ctx) => {
        const campaign = await ctx.prepare("draft");
        const response = await patchCampaign(ctx.app, ctx.token, campaign.id, {
          media_id: randomUUID(),
          revision: campaign.revision,
        });
        expect(response.statusCode).toBe(400);
        expectErrorBody(response, "invalid_request");
        const state = await campaignState(campaign.id);
        expect(state.row?.media_id).toBe(campaign.media_id);
        expect(state.row?.revision).toBe(campaign.revision);
      },
    },
    {
      name: "Aktivierung ohne Ziel wird abgelehnt",
      run: async (ctx) => {
        const response = await postCampaign(ctx.app, ctx.token, {
          customer_id: ctx.customerId,
          media_id: ctx.mediaId,
          start_at: START,
          end_at: END,
          taxi_ids: [],
          group_ids: [],
        });
        expect(response.statusCode).toBe(201);
        const campaign = response.json() as CampaignJson;
        const activation = await patchCampaign(ctx.app, ctx.token, campaign.id, {
          status: "active",
          revision: campaign.revision,
        });
        expect(activation.statusCode).toBe(400);
        expectErrorBody(activation, "invalid_request");
        expect((await campaignState(campaign.id)).row?.status).toBe("draft");
      },
    },
    {
      name: "unzulaessiges Feld wird ohne Teiländerung abgelehnt",
      run: async (ctx) => {
        const campaign = await ctx.prepare("draft");
        const response = await patchCampaign(ctx.app, ctx.token, campaign.id, {
          preis: 12,
          revision: campaign.revision,
        });
        expect(response.statusCode).toBe(400);
        expectErrorBody(response, "invalid_request");
        const state = await campaignState(campaign.id);
        expect(state.row?.revision).toBe(campaign.revision);
        expect(state.targets).toEqual([
          { kind: "group", target_id: "group-1" },
          { kind: "taxi", target_id: "taxi-1" },
        ]);
      },
    },
    {
      name: "unbekannter Status wird abgelehnt",
      run: async (ctx) => {
        const campaign = await ctx.prepare("draft");
        const response = await patchCampaign(ctx.app, ctx.token, campaign.id, {
          status: "archived",
          revision: campaign.revision,
        });
        expect(response.statusCode).toBe(400);
        expectErrorBody(response, "invalid_request");
        expect((await campaignState(campaign.id)).row?.revision).toBe(
          campaign.revision,
        );
      },
    },
    {
      name: "Anlegen mit unbekanntem Kunden wird abgelehnt",
      run: async (ctx) => {
        const response = await postCampaign(ctx.app, ctx.token, {
          customer_id: randomUUID(),
          media_id: ctx.mediaId,
          start_at: START,
          end_at: END,
          taxi_ids: ["taxi-1"],
        });
        expect(response.statusCode).toBe(400);
        expectErrorBody(response, "invalid_request");
        const count = await pool.query<{ count: number }>(
          "select count(*)::int as count from campaigns",
        );
        expect(count.rows[0]?.count).toBe(0);
      },
    },
    {
      name: "Anlegen mit unbekanntem Medium wird abgelehnt",
      run: async (ctx) => {
        const response = await postCampaign(ctx.app, ctx.token, {
          customer_id: ctx.customerId,
          media_id: randomUUID(),
          start_at: START,
          end_at: END,
          taxi_ids: ["taxi-1"],
        });
        expect(response.statusCode).toBe(400);
        expectErrorBody(response, "invalid_request");
        const count = await pool.query<{ count: number }>(
          "select count(*)::int as count from campaigns",
        );
        expect(count.rows[0]?.count).toBe(0);
      },
    },
    {
      name: "Aktivierung mit ungeprueftem Medium wird abgelehnt",
      run: async (ctx) => {
        const stagingId = await insertMedia("staging");
        const response = await postCampaign(ctx.app, ctx.token, {
          customer_id: ctx.customerId,
          media_id: stagingId,
          status: "active",
          start_at: START,
          end_at: END,
          taxi_ids: ["taxi-1"],
        });
        expect(response.statusCode).toBe(400);
        expectErrorBody(response, "invalid_request");
        const count = await pool.query<{ count: number }>(
          "select count(*)::int as count from campaigns",
        );
        expect(count.rows[0]?.count).toBe(0);
      },
    },
    {
      name: "Anlegen mit ungueltiger Laufzeit wird abgelehnt",
      run: async (ctx) => {
        const response = await postCampaign(ctx.app, ctx.token, {
          customer_id: ctx.customerId,
          media_id: ctx.mediaId,
          start_at: "2026-02-30T08:00:00.000Z",
          end_at: END,
          taxi_ids: ["taxi-1"],
        });
        expect(response.statusCode).toBe(400);
        expectErrorBody(response, "invalid_request");
      },
    },
    {
      name: "Anlegen mit unbekanntem Feld wird abgelehnt",
      run: async (ctx) => {
        const response = await postCampaign(ctx.app, ctx.token, {
          customer_id: ctx.customerId,
          media_id: ctx.mediaId,
          start_at: START,
          end_at: END,
          taxi_ids: ["taxi-1"],
          farbe: "rot",
        });
        expect(response.statusCode).toBe(400);
        expectErrorBody(response, "invalid_request");
      },
    },
    {
      name: "Anlegen mit falschem Regeltyp wird abgelehnt",
      run: async (ctx) => {
        const response = await postCampaign(ctx.app, ctx.token, {
          customer_id: ctx.customerId,
          media_id: ctx.mediaId,
          rule_type: "rotation",
          start_at: START,
          end_at: END,
          taxi_ids: ["taxi-1"],
        });
        expect(response.statusCode).toBe(400);
        expectErrorBody(response, "invalid_request");
      },
    },
  ];

  it.each(CASES)("$name", async (testCase) => {
    const { app, adminAuth } = await buildApp();
    const token = await login(adminAuth);
    const customerId = await insertCustomer();
    const mediaId = await insertMedia("ready");

    async function prepare(
      initial: "draft" | "active" | "paused" | "finished",
    ): Promise<CampaignJson> {
      let campaign = await createCampaign(app, token, customerId, mediaId);
      const path: Array<"active" | "paused" | "finished"> =
        initial === "draft"
          ? []
          : initial === "active"
            ? ["active"]
            : initial === "paused"
              ? ["active", "paused"]
              : ["active", "finished"];
      for (const status of path) {
        const response = await patchCampaign(app, token, campaign.id, {
          status,
          revision: campaign.revision,
        });
        expect(response.statusCode).toBe(200);
        campaign = response.json() as CampaignJson;
      }
      expect(campaign.status).toBe(initial);
      return campaign;
    }

    await testCase.run({ app, token, customerId, mediaId, prepare });
  });

  it("weist fehlende Anmeldung an allen neuen Routen ab, trennt Betreiberbereiche und liefert Fehler im CX-033-Format", async () => {
    const { app, adminAuth } = await buildApp({ withAccessControl: true });
    const token = await login(adminAuth);
    const customerId = await insertCustomer();
    const mediaId = await insertMedia("ready");

    const own = await createCampaign(app, token, customerId, mediaId);
    const foreignId = randomUUID();
    await pool.query(
      "insert into campaigns (id, customer_id, media_id, owner_id, rule_type, status, archived, start_at, end_at, revision, created_at, updated_at) values ($1::uuid, $2::uuid, $3::uuid, $4, 'fixed_slot', 'draft', false, $5::timestamptz, $6::timestamptz, 1, now(), now())",
      [foreignId, customerId, mediaId, ADMIN_ACTOR_ID, START, END],
    );

    const routes: Array<{
      method: "GET" | "POST" | "PATCH";
      url: string;
      payload?: Record<string, unknown>;
    }> = [
      { method: "GET", url: CAMPAIGN_LIST_PATH },
      { method: "GET", url: CAMPAIGN_LIST_PATH + "/" + own.id },
      {
        method: "POST",
        url: CAMPAIGN_LIST_PATH,
        payload: {
          customer_id: customerId,
          media_id: mediaId,
          start_at: START,
          end_at: END,
          taxi_ids: ["taxi-1"],
        },
      },
      {
        method: "PATCH",
        url: CAMPAIGN_LIST_PATH + "/" + own.id,
        payload: { status: "active", revision: 1 },
      },
    ];
    for (const route of routes) {
      const response = await app.inject({
        method: route.method,
        url: route.url,
        headers:
          route.method === "GET" ? adminHeaders() : jsonHeaders(undefined, { origin: ORIGIN }),
        ...(route.payload === undefined ? {} : { payload: route.payload }),
      });
      expect(response.statusCode).toBe(401);
      expectErrorBody(response, "unauthorized");
    }

    const foreignDetail = await app.inject({
      method: "GET",
      url: CAMPAIGN_LIST_PATH + "/" + foreignId,
      headers: adminHeaders(token),
    });
    expect(foreignDetail.statusCode).toBe(404);
    expectErrorBody(foreignDetail, "not_found");

    const foreignPatch = await app.inject({
      method: "PATCH",
      url: CAMPAIGN_LIST_PATH + "/" + foreignId,
      headers: jsonHeaders(token, { origin: ORIGIN }),
      payload: { status: "active", revision: 1 },
    });
    expect(foreignPatch.statusCode).toBe(404);
    expectErrorBody(foreignPatch, "not_found");

    const list = await app.inject({
      method: "GET",
      url: CAMPAIGN_LIST_PATH,
      headers: adminHeaders(token),
    });
    expect(list.statusCode).toBe(200);
    const ids = (list.json() as { items: CampaignJson[] }).items.map(
      (item) => item.id,
    );
    expect(ids).toEqual([own.id]);
    expect(ids).not.toContain(foreignId);

    const invalidId = await app.inject({
      method: "GET",
      url: CAMPAIGN_LIST_PATH + "/keine-uuid",
      headers: adminHeaders(token),
    });
    expect(invalidId.statusCode).toBe(400);
    expectErrorBody(invalidId, "invalid_request");

    const unknownId = await app.inject({
      method: "GET",
      url: CAMPAIGN_LIST_PATH + "/" + randomUUID(),
      headers: adminHeaders(token),
    });
    expect(unknownId.statusCode).toBe(404);
    expectErrorBody(unknownId, "not_found");
  });

  it("rollt bei provoziertem Auditfehler alles zurueck, schreibt genau einen bereinigten Audit-Eintrag und verhindert veraltete konkurrierende Aenderungen", async () => {
    const { app, adminAuth } = await buildApp();
    const token = await login(adminAuth);
    await pool.query("delete from audit_events");
    const customerId = await insertCustomer();
    const mediaId = await insertMedia("ready");

    const campaign = await createCampaign(app, token, customerId, mediaId, {
      taxi_ids: ["taxi-rollback"],
      group_ids: ["group-rollback"],
    });

    try {
      await pool.query(
        "create or replace function cx038_fail_campaign_audit() returns trigger language plpgsql as $$ begin if new.action like 'campaign.%' then raise exception 'SYN-CX038-AUDIT-GEHEIM'; end if; return new; end $$",
      );
      await pool.query(
        "create trigger cx038_fail_campaign_audit before insert on audit_events for each row execute function cx038_fail_campaign_audit()",
      );

      const failed = await patchCampaign(app, token, campaign.id, {
        status: "active",
        revision: campaign.revision,
      });
      expect(failed.statusCode).toBe(500);
      expectErrorBody(failed, "internal_error");
      expect(failed.body).not.toContain("SYN-CX038-AUDIT-GEHEIM");
      const failedState = await campaignState(campaign.id);
      expect(failedState.row?.status).toBe("draft");
      expect(failedState.row?.revision).toBe(1);
      expect(failedState.targets).toEqual([
        { kind: "group", target_id: "group-rollback" },
        { kind: "taxi", target_id: "taxi-rollback" },
      ]);
      const failedAudit = await pool.query<{ count: number }>(
        "select count(*)::int as count from audit_events where action = $1",
        [CAMPAIGN_UPDATED_ACTION],
      );
      expect(failedAudit.rows[0]?.count).toBe(0);
    } finally {
      await pool.query(
        "drop trigger if exists cx038_fail_campaign_audit on audit_events",
      );
      await pool.query("drop function if exists cx038_fail_campaign_audit()");
    }

    const success = await patchCampaign(app, token, campaign.id, {
      status: "active",
      taxi_ids: ["taxi-2", "taxi-2"],
      group_ids: ["group-2"],
      revision: 1,
    });
    expect(success.statusCode).toBe(200);
    const successBody = success.json() as CampaignJson;
    expect(successBody.revision).toBe(2);

    const audit = await pool.query<{
      actor_type: string;
      actor_id: string | null;
      target_type: string | null;
      target_id: string | null;
      details: { fields?: string[] };
    }>(
      "select actor_type, actor_id, target_type, target_id, details from audit_events where action = $1 and target_id = $2",
      [CAMPAIGN_UPDATED_ACTION, campaign.id],
    );
    expect(audit.rows).toHaveLength(1);
    const event = audit.rows[0];
    expect(event?.actor_type).toBe("admin");
    expect(event?.actor_id).toBe(ADMIN_ACTOR_ID);
    expect(event?.target_type).toBe("campaign");
    expect(event?.target_id).toBe(campaign.id);
    expect(Object.keys(event?.details ?? {})).toEqual(["fields"]);
    expect(event?.details.fields).toEqual(["group_ids", "status", "taxi_ids"]);
    const detailsText = JSON.stringify(event?.details);
    for (const marker of [
      "taxi-2",
      "group-2",
      customerId,
      mediaId,
      "payload",
      "request",
    ]) {
      expect(detailsText).not.toContain(marker);
    }

    const concurrent = await createCampaign(app, token, customerId, mediaId, {
      taxi_ids: ["taxi-concurrent"],
      group_ids: ["group-concurrent"],
    });
    const [firstResponse, secondResponse] = await Promise.all([
      patchCampaign(app, token, concurrent.id, {
        status: "active",
        revision: concurrent.revision,
      }),
      patchCampaign(app, token, concurrent.id, {
        taxi_ids: ["taxi-neu"],
        revision: concurrent.revision,
      }),
    ]);
    const statuses = [firstResponse.statusCode, secondResponse.statusCode].sort();
    expect(statuses).toEqual([200, 400]);
    const winner =
      firstResponse.statusCode === 200 ? firstResponse : secondResponse;
    const loser =
      firstResponse.statusCode === 200 ? secondResponse : firstResponse;
    expectErrorBody(loser, "invalid_request");

    const finalState = await campaignState(concurrent.id);
    expect(finalState.row?.revision).toBe(2);
    const winningBody = winner.json() as CampaignJson;
    expect(finalState.row?.status).toBe(winningBody.status);
    expect(finalState.targets.map((row) => row.target_id)).toEqual(
      [...winningBody.taxi_ids, ...winningBody.group_ids].sort(),
    );
    const concurrentAudit = await pool.query<{ count: number }>(
      "select count(*)::int as count from audit_events where action = $1 and target_id = $2",
      [CAMPAIGN_UPDATED_ACTION, concurrent.id],
    );
    expect(concurrentAudit.rows[0]?.count).toBe(1);
    void ({} as Campaign);
  });
});

