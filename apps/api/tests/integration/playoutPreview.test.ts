/**
 * CX-044 / R-304: lesende Ausspielungs-Vorschau gegen PostgreSQL 17.
 *
 * Vier echte Vitest-Faelle mit Fastify.inject, der vorhandenen
 * Admin-Sitzung und dem vorhandenen CX-041/042-Lesezugriff. Es gibt keinen
 * Listener und keinen externen Netzwerkzugriff; alle Kennungen sind
 * synthetisch.
 */
import { generateKeyPairSync } from "node:crypto";
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
import { hashPassword } from "../../src/crypto/password.js";
import { migrateUp } from "../../src/db/migrate.js";
import { createServer } from "../../src/http/server.js";
import { ADMIN_SESSION_COOKIE } from "../../src/modules/adminAuth/middleware.js";
import {
  createSignedManifest,
  type SignedManifestEnvelope,
} from "../../src/modules/playout/manifest.js";
import type { LoopPlan } from "../../src/modules/playout/types.js";

const BASE_TIME = Date.parse("2026-11-14T10:00:00.000Z");
const ADMIN_PASSWORD = "SYN-CX044-Vorschau-Passwort";
const HOST = "127.0.0.1:8080";
const TAXI = "SYN-CX044-TAXI";
const EMPTY_TAXI = "SYN-CX044-OHNE-MANIFEST";
const UNKNOWN_TAXI = "SYN-CX044-UNBEKANNT";
const SLOT_COUNT = 12;
const START = "2026-12-01T08:00:00.000Z";
const END = "2026-12-01T18:00:00.000Z";
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/db/migrations",
);

interface CampaignFixture {
  campaignId: string;
  mediaId: string;
  sha256: string;
  sizeBytes: number;
  durationMs: number;
  startAt: string;
  endAt: string;
}

const CAMPAIGNS: readonly CampaignFixture[] = [
  {
    campaignId: "campaign-1",
    mediaId: "media-1",
    sha256: "1".repeat(64),
    sizeBytes: 1000,
    durationMs: 15000,
    startAt: START,
    endAt: END,
  },
  {
    campaignId: "campaign-2",
    mediaId: "media-2",
    sha256: "2".repeat(64),
    sizeBytes: 2000,
    durationMs: 15000,
    startAt: "2026-12-02T06:30:00.000Z",
    endAt: "2026-12-02T20:00:00.000Z",
  },
  {
    campaignId: "campaign-3",
    mediaId: "media-3",
    sha256: "3".repeat(64),
    sizeBytes: 3000,
    durationMs: 15000,
    startAt: "2026-12-03T07:15:00.000Z",
    endAt: "2026-12-03T19:45:00.000Z",
  },
];

let maintenancePool: Pool | null = null;
let pool: Pool | null = null;
let databaseName = "";
let config: AppConfig;
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
    throw new Error("CX-044 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function requirePool(): Pool {
  if (pool === null) {
    throw new Error("Testdatenbank ist nicht initialisiert.");
  }
  return pool;
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = (
    "gtads_cx044_" +
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
  await pool.query(
    await readFile(
      join(MIGRATIONS_DIR, "0010_cx_041_manifest_refresh.up.sql"),
      "utf8",
    ),
  );

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX044-Pepper",
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
  };
}, 60_000);

beforeEach(async () => {
  await requirePool().query(
    [
      "truncate table taxi_manifest_artifacts, taxi_manifest_state,",
      "  admin_sessions",
      "restart identity cascade",
    ].join("\n"),
  );
});

afterEach(async () => {
  for (const app of openApps.splice(0)) {
    await app.close();
  }
});

afterAll(async () => {
  if (pool !== null) {
    await pool.end();
  }
  if (maintenancePool !== null) {
    if (databaseName !== "") {
      await maintenancePool.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
        [databaseName],
      );
      await maintenancePool.query(
        "drop database if exists " + quoteIdentifier(databaseName),
      );
    }
    await maintenancePool.end();
  }
}, 30_000);

async function buildApp(): Promise<FastifyInstance> {
  const app = createServer({
    config,
    pool: requirePool(),
    now: () => new Date(BASE_TIME),
    logger: { level: "silent" },
  });
  await app.ready();
  openApps.push(app);
  return app;
}

function sessionCookieOf(response: {
  headers: Record<string, unknown>;
}): string {
  const raw = response.headers["set-cookie"];
  const first = Array.isArray(raw)
    ? (raw[0] as string)
    : (raw as string | undefined);
  expect(first, "Set-Cookie fehlt").toBeTruthy();
  return ((first as string).split(";")[0] as string).slice(
    ADMIN_SESSION_COOKIE.length + 1,
  );
}

/** Echte Anmeldung ueber die vorhandene Admin-Sitzung. */
async function loginCookie(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/login",
    headers: { host: HOST, "content-type": "application/json" },
    payload: { password: ADMIN_PASSWORD },
    remoteAddress: "192.0.2.44",
  });
  expect(response.statusCode).toBe(204);
  return sessionCookieOf(response);
}

function requestPreview(
  app: FastifyInstance,
  taxiId: string,
  cookie?: string,
) {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) {
    headers.cookie = ADMIN_SESSION_COOKIE + "=" + cookie;
  }
  return app.inject({
    method: "GET",
    url:
      "/v1/admin/taxis/" +
      encodeURIComponent(taxiId) +
      "/playout-preview",
    headers,
    remoteAddress: "192.0.2.45",
  });
}

function errorCode(response: { json: () => unknown }): string {
  return (
    response.json() as {
      error: { code: string };
    }
  ).error.code;
}

function buildPlan(taxiId: string): LoopPlan {
  return {
    taxiId,
    slotCount: SLOT_COUNT,
    loopDurationMs: SLOT_COUNT * 15000,
    spots: Array.from({ length: SLOT_COUNT }, (_unused, index) => {
      const campaign = CAMPAIGNS[index % CAMPAIGNS.length];
      if (campaign === undefined) {
        throw new Error("Fixture fehlt.");
      }
      return {
        position: index + 1,
        campaignId: campaign.campaignId,
        mediaId: campaign.mediaId,
        sha256: campaign.sha256,
        sizeBytes: campaign.sizeBytes,
        durationMs: campaign.durationMs,
        startAt: campaign.startAt,
        endAt: campaign.endAt,
      };
    }),
  };
}

const SIGNING_KEY = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
}).privateKey;

function buildEnvelope(taxiId: string): SignedManifestEnvelope {
  return createSignedManifest({
    plan: buildPlan(taxiId),
    environment: "test",
    keyId: "cx044-test",
    signingKey: SIGNING_KEY,
  });
}

/** Veroeffentlicht ein Artefakt exakt so, wie CX-041 es hinterlaesst. */
async function publish(
  taxiId: string,
  envelope: SignedManifestEnvelope,
  revision: number,
): Promise<void> {
  await requirePool().query(
    [
      "insert into taxi_manifest_artifacts",
      "  (taxi_id, version, key_id, environment, payload_base64,",
      "   signature_base64, source_revision, created_at)",
      "values ($1, $2, $3, 'test', $4, $5, $6, $7)",
    ].join("\n"),
    [
      taxiId,
      envelope.version,
      envelope.keyId,
      envelope.payloadBase64,
      envelope.signatureBase64,
      revision,
      new Date(BASE_TIME),
    ],
  );
  await requirePool().query(
    [
      "insert into taxi_manifest_state",
      "  (taxi_id, requested_revision, processed_revision,",
      "   current_version, current_revision, last_error, updated_at)",
      "values ($1, $2, $2, $3, $2, null, $4)",
    ].join("\n"),
    [taxiId, revision, envelope.version, new Date(BASE_TIME)],
  );
}

interface ExpectedEntry {
  media_id: string;
  duration_ms: number;
  start_at: string;
  end_at: string;
}

function expectedEntries(): ExpectedEntry[] {
  return Array.from({ length: SLOT_COUNT }, (_unused, index) => {
    const campaign = CAMPAIGNS[index % CAMPAIGNS.length];
    if (campaign === undefined) {
      throw new Error("Fixture fehlt.");
    }
    return {
      media_id: campaign.mediaId,
      duration_ms: campaign.durationMs,
      start_at: campaign.startAt,
      end_at: campaign.endAt,
    };
  });
}

interface Snapshot {
  artifacts: unknown[];
  state: unknown[];
}

async function snapshot(taxiId: string): Promise<Snapshot> {
  const artifacts = await requirePool().query(
    [
      "select taxi_id, version, key_id, environment, payload_base64,",
      "       signature_base64, source_revision, created_at",
      "  from taxi_manifest_artifacts",
      " where taxi_id = $1",
      " order by version asc",
    ].join("\n"),
    [taxiId],
  );
  const state = await requirePool().query(
    [
      "select taxi_id, requested_revision::text as requested_revision,",
      "       processed_revision::text as processed_revision,",
      "       current_version, current_revision::text as current_revision,",
      "       last_error, updated_at",
      "  from taxi_manifest_state",
      " where taxi_id = $1",
    ].join("\n"),
    [taxiId],
  );
  return { artifacts: artifacts.rows, state: state.rows };
}

describe("CX-044 / R-304 lesende Ausspielungs-Vorschau", () => {
  it("liefert authentifiziert exakt die veroeffentlichte Version, Reihenfolge, Medien und Laufzeitfenster; anonym ergibt 401", async () => {
    const app = await buildApp();
    const envelope = buildEnvelope(TAXI);
    await publish(TAXI, envelope, 1);
    const cookie = await loginCookie(app);

    const response = await requestPreview(app, TAXI, cookie);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(
      String(response.headers["content-type"]).startsWith("application/json"),
    ).toBe(true);

    const body = response.json() as {
      taxi_id: string;
      manifest_version: string | null;
      entries: ExpectedEntry[];
    };
    expect(body).toEqual({
      taxi_id: TAXI,
      manifest_version: envelope.version,
      entries: expectedEntries(),
    });

    // Die Antwort entspricht exakt der gespeicherten veroeffentlichten
    // Nutzlast; es wird nichts neu berechnet.
    const stored = JSON.parse(
      Buffer.from(envelope.payloadBase64, "base64").toString("utf8"),
    ) as {
      entries: Array<{
        mediaId: string;
        durationMs: number;
        startAt: string;
        endAt: string;
      }>;
    };
    expect(body.entries).toEqual(
      stored.entries.map((entry) => ({
        media_id: entry.mediaId,
        duration_ms: entry.durationMs,
        start_at: entry.startAt,
        end_at: entry.endAt,
      })),
    );
    expect(body.entries.map((entry) => entry.media_id)).toEqual(
      expectedEntries().map((entry) => entry.media_id),
    );

    // Keine Download-Freigaben, Tokens, Signaturen oder Speicherpfade.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("payload");
    expect(serialized).not.toContain("signature");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("storage");

    const anonymous = await requestPreview(app, TAXI);
    expect(anonymous.statusCode).toBe(401);
    expect(errorCode(anonymous)).toBe("unauthorized");
  });

  it("liefert fuer ein bekanntes Taxi ohne veroeffentlichtes Manifest einen expliziten Leerzustand", async () => {
    const app = await buildApp();
    await requirePool().query(
      "insert into taxi_manifest_state (taxi_id, updated_at) values ($1, $2)",
      [EMPTY_TAXI, new Date(BASE_TIME)],
    );
    const cookie = await loginCookie(app);

    const response = await requestPreview(app, EMPTY_TAXI, cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      taxi_id: EMPTY_TAXI,
      manifest_version: null,
      entries: [],
    });
  });

  it("veraendert bei wiederholtem Lesen weder Manifest-Versionen noch gespeicherte Artefakte", async () => {
    const app = await buildApp();
    const envelope = buildEnvelope(TAXI);
    await publish(TAXI, envelope, 1);
    const cookie = await loginCookie(app);

    const before = await snapshot(TAXI);
    expect(before.artifacts).toHaveLength(1);

    for (let index = 0; index < 3; index += 1) {
      const response = await requestPreview(app, TAXI, cookie);
      expect(response.statusCode).toBe(200);
      expect(
        (response.json() as { manifest_version: string }).manifest_version,
      ).toBe(envelope.version);
    }

    const after = await snapshot(TAXI);
    expect(after).toEqual(before);
    expect(after.artifacts).toHaveLength(1);
    expect(
      (after.state[0] as { current_version: string }).current_version,
    ).toBe(envelope.version);
  });

  it("ergibt fuer ein unbekanntes Taxi 404", async () => {
    const app = await buildApp();
    const cookie = await loginCookie(app);

    const response = await requestPreview(app, UNKNOWN_TAXI, cookie);
    expect(response.statusCode).toBe(404);
    expect(errorCode(response)).toBe("not_found");
  });
});

