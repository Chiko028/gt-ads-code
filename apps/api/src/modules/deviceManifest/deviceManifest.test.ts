/**
 * CX-042 / R-302: authentifizierter Manifest-Abruf.
 *
 * Vier echte Vitest-Faelle mit Fastify-inject, echter Geraeteauthentifizierung
 * (GT-ADS-001 U4) und PostgreSQL 17. Es gibt keinen Listener und keinen
 * externen Netzwerkzugriff; alle Schluessel und Kennungen sind synthetisch.
 */
import {
  createHash,
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
import { CONFIG_DEFAULTS, type AppConfig } from "../../config.js";
import { buildSignatureMessage } from "../../crypto/deviceSignature.js";
import { generateOpaqueToken, hashToken } from "../../crypto/tokens.js";
import { createServer } from "../../http/server.js";
import { ADMIN_SESSION_COOKIE } from "../adminAuth/middleware.js";
import {
  MANIFEST_SCHEMA_VERSION,
  createSignedManifest,
  verifySignedManifest,
  type SignedManifestEnvelope,
} from "../playout/manifest.js";
import type { LoopPlan } from "../playout/types.js";
import { RegistrationService } from "../registration/service.js";
import { ensureTaxiActivationSchema } from "../taxiActivation/index.js";

const BASE_TIME = Date.parse("2026-11-13T12:00:00.000Z");
const START = "2026-12-01T08:00:00.000Z";
const END = "2026-12-01T18:00:00.000Z";
const SLOT_COUNT = 12;
const MANIFEST_PATH = "/v1/device/manifest";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);
const MIGRATIONS = [
  "0001_gt_ads_001.up.sql",
  "0010_cx_041_manifest_refresh.up.sql",
];

const keyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const trustedKeys = new Map([["cx042-test", keyPair.publicKey]]);

const DEVICE_INFO = {
  manufacturer: "SYN-Hersteller",
  model: "SYN-Modell",
  os_version: "14",
  sdk_int: 34,
  app_version: "0.1.0",
  app_flavor: "test",
};

let maintenancePool: Pool | null = null;
let pool: Pool | null = null;
let databaseName = "";
let config: AppConfig;
let registrationService: RegistrationService;
let nowMs = BASE_TIME;
const openApps: FastifyInstance[] = [];

function clock(): Date {
  return new Date(nowMs);
}

function requirePool(): Pool {
  if (pool === null) {
    throw new Error("Testdatenbank ist nicht initialisiert.");
  }
  return pool;
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
    throw new Error("CX-042 benoetigt with-postgres <befehl>");
  }
  return { host, port: Number(process.env.PGPORT ?? "5432"), user, database };
}

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

beforeAll(async () => {
  const base = baseConnection();
  maintenancePool = new Pool(base);
  databaseName = ("cx042_" + process.pid + "_" + Date.now().toString(36))
    .toLowerCase()
    .slice(0, 63);
  await maintenancePool.query(
    "create database " + quoteIdentifier(databaseName),
  );

  pool = new Pool({ ...base, database: databaseName });
  for (const name of MIGRATIONS) {
    const sql = await readFile(join(MIGRATIONS_DIR, name), "utf8");
    await requirePool().query(sql);
  }
  // Reales CX-035-Schema ueber dessen eigene Persistenz initialisieren; der
  // Test legt keine Ersatz-DDL an.
  await ensureTaxiActivationSchema(requirePool());

  config = {
    ...CONFIG_DEFAULTS,
    env: "test",
    databaseUrl: "",
    registrationCodePepper: "SYN-CX042-Code-Pepper",
    adminPasswordHash:
      "scrypt$N=16384,r=8,p=1$c3ludGhldGlzY2hlLXNhbHQ$aGFzaC1oYXNoLWhhc2gtaGFzaC1oYXNo",
  };
  registrationService = new RegistrationService({
    pool: requirePool(),
    config,
    now: clock,
  });
}, 60_000);

beforeEach(async () => {
  nowMs = BASE_TIME;
  await requirePool().query(
    [
      "truncate table device_taxi_assignments, taxi_manifest_artifacts,",
      "  taxi_manifest_state, device_access_tokens, device_auth_challenges,",
      "  devices, registration_codes, admin_sessions",
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
  const app = createServer({ config, pool: requirePool(), now: clock });
  await app.ready();
  openApps.push(app);
  return app;
}

interface TestDevice {
  deviceId: string;
  privateKey: KeyObject;
}

async function registerDevice(app: FastifyInstance): Promise<TestDevice> {
  const created = await registrationService.createRegistrationCode({
    label: "SYN-CX042-Tablet",
  });
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = pair.publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");

  const response = await app.inject({
    method: "POST",
    url: "/v1/device/register",
    headers: {
      "content-type": "application/json",
      "x-gt-ads-api-version": "1",
    },
    payload: {
      registration_code: created.code,
      client_request_id: randomUUID(),
      public_key: spki,
      app_env: "test",
      device_info: { ...DEVICE_INFO },
    },
    remoteAddress: "192.0.2.80",
  });
  expect(response.statusCode).toBe(201);
  return {
    deviceId: response.json().device_id as string,
    privateKey: pair.privateKey,
  };
}

/**
 * Fuehrt die echte Challenge-Response-Anmeldung aus und liefert das
 * kurzlebige Bearer-Token. Es gibt keinen Testschalter im Authpfad.
 */
async function accessToken(
  app: FastifyInstance,
  device: TestDevice,
): Promise<string> {
  const challenge = await app.inject({
    method: "POST",
    url: "/v1/device/auth/challenge",
    headers: {
      "content-type": "application/json",
      "x-gt-ads-api-version": "1",
    },
    payload: { device_id: device.deviceId },
    remoteAddress: "192.0.2.81",
  });
  expect(challenge.statusCode).toBe(200);
  const nonce = challenge.json().nonce as string;
  nowMs += 1000;
  const signature = signWithKey(
    "sha256",
    Buffer.from(buildSignatureMessage(device.deviceId, nonce), "utf8"),
    { key: device.privateKey, dsaEncoding: "der" },
  ).toString("base64");

  const token = await app.inject({
    method: "POST",
    url: "/v1/device/auth/token",
    headers: {
      "content-type": "application/json",
      "x-gt-ads-api-version": "1",
    },
    payload: { device_id: device.deviceId, nonce, signature },
    remoteAddress: "192.0.2.81",
  });
  expect(token.statusCode).toBe(200);
  return token.json().access_token as string;
}

async function assign(
  deviceId: string,
  taxiId: string,
  active = true,
): Promise<void> {
  await requirePool().query(
    [
      "insert into device_taxi_assignments (device_id, taxi_id, active)",
      "values ($1, $2, $3)",
    ].join("\n"),
    [deviceId, taxiId, active],
  );
}

function buildPlan(taxiId: string, seed: string): LoopPlan {
  const sha256 = (seed + "0".repeat(64)).slice(0, 64);
  return {
    taxiId,
    slotCount: SLOT_COUNT,
    loopDurationMs: SLOT_COUNT * 15_000,
    spots: Array.from({ length: SLOT_COUNT }, (_unused, index) => ({
      position: index + 1,
      campaignId: "campaign-syn-1",
      mediaId: "media-syn-1",
      sha256,
      sizeBytes: 1000,
      durationMs: 15_000,
      startAt: START,
      endAt: END,
    })),
  };
}

function buildEnvelope(taxiId: string, seed: string): SignedManifestEnvelope {
  return createSignedManifest({
    plan: buildPlan(taxiId, seed),
    environment: "test",
    keyId: "cx042-test",
    signingKey: keyPair.privateKey,
  });
}

/** Veroeffentlicht ein Artefakt genau so, wie CX-041 es hinterlaesst. */
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
      new Date(nowMs),
    ],
  );
  await requirePool().query(
    [
      "insert into taxi_manifest_state",
      "  (taxi_id, requested_revision, processed_revision,",
      "   current_version, current_revision, last_error, updated_at)",
      "values ($1, $2, $2, $3, $2, null, $4)",
      "on conflict (taxi_id) do update",
      "   set requested_revision = excluded.requested_revision,",
      "       processed_revision = excluded.processed_revision,",
      "       current_version = excluded.current_version,",
      "       current_revision = excluded.current_revision,",
      "       last_error = null,",
      "       updated_at = excluded.updated_at",
    ].join("\n"),
    [taxiId, revision, envelope.version, new Date(nowMs)],
  );
}

interface ManifestOptions {
  token?: string;
  ifNoneMatch?: string;
  cookie?: string;
  url?: string;
}

function requestManifest(app: FastifyInstance, options: ManifestOptions = {}) {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) {
    headers.authorization = "Bearer " + options.token;
  }
  if (options.ifNoneMatch !== undefined) {
    headers["if-none-match"] = options.ifNoneMatch;
  }
  if (options.cookie !== undefined) {
    headers.cookie = options.cookie;
  }
  return app.inject({
    method: "GET",
    url: options.url ?? MANIFEST_PATH,
    headers,
    remoteAddress: "192.0.2.90",
  });
}

function errorBody(response: { json: () => unknown }): {
  code: string;
  message: string;
  request_id: string;
} {
  return (response.json() as { error: { code: string; message: string; request_id: string } })
    .error;
}

describe("CX-042 / R-302 authentifizierter Manifest-Abruf", () => {
  it("liefert beiden Tablets desselben Taxis identische gespeicherte Bytes, dieselbe Version und denselben starken ETag; die Signatur bleibt gueltig und fremde Taxi-IDs werden ignoriert", async () => {
    const app = await buildApp();
    const first = await registerDevice(app);
    const second = await registerDevice(app);
    const other = await registerDevice(app);
    await assign(first.deviceId, "taxi-A");
    await assign(second.deviceId, "taxi-A");
    await assign(other.deviceId, "taxi-B");

    const envelopeA = buildEnvelope("taxi-A", "a");
    const envelopeB = buildEnvelope("taxi-B", "b");
    await publish("taxi-A", envelopeA, 1);
    await publish("taxi-B", envelopeB, 1);

    const tokenFirst = await accessToken(app, first);
    const tokenSecond = await accessToken(app, second);

    const responseFirst = await requestManifest(app, { token: tokenFirst });
    const responseSecond = await requestManifest(app, { token: tokenSecond });

    expect(responseFirst.statusCode).toBe(200);
    expect(responseSecond.statusCode).toBe(200);

    // Massgeblich sind die von CX-041 veroeffentlichten Werte, nicht die
    // Uebereinstimmung zweier Antworten: die Antwortbytes muessen exakt der
    // gespeicherten Bytefolge entsprechen, der ETag deren SHA-256 sein.
    const stored = (
      await requirePool().query<{
        version: string;
        key_id: string;
        environment: string;
        payload_base64: string;
        signature_base64: string;
      }>(
        [
          "select version, key_id, environment, payload_base64,",
          "       signature_base64",
          "  from taxi_manifest_artifacts",
          " where taxi_id = $1 and version = $2",
        ].join("\n"),
        ["taxi-A", envelopeA.version],
      )
    ).rows[0];
    expect(stored).toBeDefined();
    expect(stored.version).toBe(envelopeA.version);
    expect(stored.key_id).toBe(envelopeA.keyId);
    expect(stored.payload_base64).toBe(envelopeA.payloadBase64);
    expect(stored.signature_base64).toBe(envelopeA.signatureBase64);
    const publishedBytes = Buffer.from(
      JSON.stringify({
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        keyId: stored.key_id,
        version: stored.version,
        payloadBase64: stored.payload_base64,
        signatureBase64: stored.signature_base64,
      }),
      "utf8",
    );
    const publishedEtag =
      '"' + createHash("sha256").update(publishedBytes).digest("hex") + '"';

    expect(responseFirst.rawPayload.equals(publishedBytes)).toBe(true);
    expect(responseSecond.rawPayload.equals(publishedBytes)).toBe(true);
    expect(responseFirst.rawPayload.equals(responseSecond.rawPayload)).toBe(
      true,
    );
    expect(responseFirst.headers.etag).toBe(publishedEtag);
    expect(responseSecond.headers.etag).toBe(publishedEtag);
    expect(
      String(responseFirst.headers["content-type"]).startsWith(
        "application/json",
      ),
    ).toBe(true);
    expect(responseFirst.headers["cache-control"]).toBe("private, no-cache");
    expect(String(responseFirst.headers.etag)).toMatch(/^"[0-9a-f]{64}"$/);

    const body = JSON.parse(responseFirst.body) as SignedManifestEnvelope;
    expect(body.version).toBe(envelopeA.version);
    const verified = verifySignedManifest(body, {
      taxiId: "taxi-A",
      environment: "test",
      trustedKeys,
    });
    expect(verified.version).toBe(envelopeA.version);

    // Fremde Taxi- und Geraete-IDs in der Anfrage haben keinen Einfluss.
    const injected = await requestManifest(app, {
      token: tokenFirst,
      url:
        MANIFEST_PATH +
        "?taxi_id=taxi-B&device_id=" +
        encodeURIComponent(other.deviceId),
    });
    expect(injected.statusCode).toBe(200);
    expect(injected.rawPayload.equals(responseFirst.rawPayload)).toBe(true);
    expect((JSON.parse(injected.body) as SignedManifestEnvelope).version).toBe(
      envelopeA.version,
    );
  });

  it("beantwortet If-None-Match mit 304 ohne Body samt ETag und Cache-Control, versteht Listen, schwache Marker und Stern und liefert nach neuer Veroeffentlichung neue Bytes mit neuem ETag", async () => {
    const app = await buildApp();
    const device = await registerDevice(app);
    await assign(device.deviceId, "taxi-A");

    const first = buildEnvelope("taxi-A", "a");
    await publish("taxi-A", first, 1);
    const token = await accessToken(app, device);

    const initial = await requestManifest(app, { token });
    expect(initial.statusCode).toBe(200);
    const etag = String(initial.headers.etag);

    const exact = await requestManifest(app, {
      token,
      ifNoneMatch: etag,
    });
    expect(exact.statusCode).toBe(304);
    expect(exact.body).toBe("");
    expect(exact.headers.etag).toBe(etag);
    expect(exact.headers["cache-control"]).toBe("private, no-cache");

    const weak = await requestManifest(app, {
      token,
      ifNoneMatch: "W/" + etag,
    });
    expect(weak.statusCode).toBe(304);
    expect(weak.body).toBe("");

    const list = await requestManifest(app, {
      token,
      ifNoneMatch: '"unrelated", W/' + etag + ', "also-unrelated"',
    });
    expect(list.statusCode).toBe(304);
    expect(list.body).toBe("");

    const star = await requestManifest(app, {
      token,
      ifNoneMatch: "*",
    });
    expect(star.statusCode).toBe(304);
    expect(star.body).toBe("");

    // Neue, vollstaendig veroeffentlichte Version.
    nowMs += 1000;
    const second = buildEnvelope("taxi-A", "b");
    await publish("taxi-A", second, 2);
    expect(second.version).not.toBe(first.version);

    const refreshed = await requestManifest(app, {
      token,
      ifNoneMatch: etag,
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.rawPayload.equals(initial.rawPayload)).toBe(false);
    expect(refreshed.headers.etag).not.toBe(etag);
    const refreshedBody = JSON.parse(refreshed.body) as SignedManifestEnvelope;
    expect(refreshedBody.version).toBe(second.version);
    verifySignedManifest(refreshedBody, {
      taxiId: "taxi-A",
      environment: "test",
      trustedKeys,
    });

    const refreshed304 = await requestManifest(app, {
      token,
      ifNoneMatch: String(refreshed.headers.etag),
    });
    expect(refreshed304.statusCode).toBe(304);
    expect(refreshed304.body).toBe("");
  });

  it("weist fehlende, ungueltige und widerrufene Geraeteidentitaet sowie fehlende oder inaktive Zuordnungen auch mit passendem ETag vor dem Cachevergleich ab; eine Adminsitzung ist keine Geraeteauth", async () => {
    const app = await buildApp();
    const active = await registerDevice(app);
    const revoked = await registerDevice(app);
    const unassigned = await registerDevice(app);
    const inactive = await registerDevice(app);
    await assign(active.deviceId, "taxi-A");
    await assign(revoked.deviceId, "taxi-A");
    await assign(inactive.deviceId, "taxi-A", false);

    const envelope = buildEnvelope("taxi-A", "a");
    await publish("taxi-A", envelope, 1);

    const tokenActive = await accessToken(app, active);
    const tokenRevoked = await accessToken(app, revoked);
    const tokenUnassigned = await accessToken(app, unassigned);
    const tokenInactive = await accessToken(app, inactive);

    const baseline = await requestManifest(app, { token: tokenActive });
    expect(baseline.statusCode).toBe(200);
    const etag = String(baseline.headers.etag);

    const anonymous = await requestManifest(app, { ifNoneMatch: etag });
    expect(anonymous.statusCode).toBe(401);
    expect(errorBody(anonymous).code).toBe("unauthorized");

    const malformed = await requestManifest(app, {
      token: "not-a-valid-token",
      ifNoneMatch: etag,
    });
    expect(malformed.statusCode).toBe(401);
    expect(errorBody(malformed).code).toBe("unauthorized");

    await requirePool().query(
      "update devices set state = 'revoked', revoked_at = $2, revoked_by = 'SYN-CX042-Admin' where id = $1",
      [revoked.deviceId, new Date(nowMs)],
    );
    const revokedResponse = await requestManifest(app, {
      token: tokenRevoked,
      ifNoneMatch: etag,
    });
    expect(revokedResponse.statusCode).toBe(403);
    expect(errorBody(revokedResponse).code).toBe("device_revoked");

    const missingAssignment = await requestManifest(app, {
      token: tokenUnassigned,
      ifNoneMatch: etag,
    });
    expect(missingAssignment.statusCode).toBe(403);
    expect(errorBody(missingAssignment).code).toBe("forbidden");

    const inactiveAssignment = await requestManifest(app, {
      token: tokenInactive,
      ifNoneMatch: etag,
    });
    expect(inactiveAssignment.statusCode).toBe(403);
    expect(errorBody(inactiveAssignment).code).toBe("forbidden");

    // Eine gueltige Adminsitzung wird nicht als Geraeteidentitaet akzeptiert.
    const adminToken = generateOpaqueToken();
    await requirePool().query(
      [
        "insert into admin_sessions (id, token_hash, created_at, expires_at)",
        "values ($1, $2, $3, $4)",
      ].join("\n"),
      [
        randomUUID(),
        hashToken(adminToken),
        new Date(nowMs),
        new Date(nowMs + 3_600_000),
      ],
    );
    const adminSession = await requestManifest(app, {
      cookie: ADMIN_SESSION_COOKIE + "=" + adminToken,
      ifNoneMatch: etag,
    });
    expect(adminSession.statusCode).toBe(401);
    expect(errorBody(adminSession).code).toBe("unauthorized");
  });

  it("meldet ein fehlendes Manifest bereinigt als 404 manifest_not_ready und liefert bei offenem Neuerzeugungsstand weiterhin nur das letzte vollstaendig veroeffentlichte Artefakt", async () => {
    const app = await buildApp();
    const missingDevice = await registerDevice(app);
    await assign(missingDevice.deviceId, "taxi-without-manifest");
    const missingToken = await accessToken(app, missingDevice);

    const missing = await requestManifest(app, {
      token: missingToken,
      ifNoneMatch: "*",
    });
    expect(missing.statusCode).toBe(404);
    const missingError = errorBody(missing);
    expect(missingError.code).toBe("manifest_not_ready");
    expect(missingError.message).toBe(
      "Das Manifest ist noch nicht verfuegbar.",
    );
    expect(typeof missingError.request_id).toBe("string");
    expect(missing.headers.etag).toBeUndefined();
    expect(missing.body).not.toContain("payloadBase64");

    const device = await registerDevice(app);
    await assign(device.deviceId, "taxi-open");
    const published = buildEnvelope("taxi-open", "c");
    await publish("taxi-open", published, 1);
    const token = await accessToken(app, device);

    const before = await requestManifest(app, { token });
    expect(before.statusCode).toBe(200);
    expect((JSON.parse(before.body) as SignedManifestEnvelope).version).toBe(
      published.version,
    );

    // Offener Neuerzeugungsstand: angeforderte Revision 2, noch keine neue
    // Veroeffentlichung. current_version bleibt unveraendert.
    await requirePool().query(
      [
        "update taxi_manifest_state",
        "   set requested_revision = processed_revision + 1,",
        "       last_error = null,",
        "       updated_at = $2",
        " where taxi_id = $1",
      ].join("\n"),
      ["taxi-open", new Date(nowMs + 5000)],
    );

    const during = await requestManifest(app, { token });
    expect(during.statusCode).toBe(200);
    expect(during.rawPayload.equals(before.rawPayload)).toBe(true);
    expect(during.headers.etag).toBe(before.headers.etag);
    expect((JSON.parse(during.body) as SignedManifestEnvelope).version).toBe(
      published.version,
    );

    const unchanged = await requestManifest(app, {
      token,
      ifNoneMatch: String(before.headers.etag),
    });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.body).toBe("");
  });
});

